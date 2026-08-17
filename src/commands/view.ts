/**
 * `nat watch` and `nat record` — seeing the device over time.
 *
 * A single screenshot answers "what does it look like now". Two other questions
 * come up constantly and it cannot answer either:
 *
 *   • *A human* wants to watch what the agent is doing, live, while it works.
 *     That is `nat watch`: a local page that streams frames into a browser.
 *
 *   • *A model* wants to see something that only exists across time — a
 *     transition, an animation, a game, a flicker that one still frame misses.
 *     That is `nat record --filmstrip`: several frames downscaled onto one
 *     numbered contact sheet, which a model can look at in a single image.
 *
 * Video proper (`nat record`) uses the platform's own recorder where one
 * exists. On a real iPhone none does, so frames are captured and encoded
 * instead — slower and lower framerate, and the command says so rather than
 * pretending otherwise.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { emit, info, color, isJson } from "../core/output.js";
import { NatError } from "../core/errors.js";
import { run, which } from "../core/exec.js";
import { readScreen } from "../core/screen.js";
import { drawMarks, contactSheet } from "../core/annotate.js";
import { attachDriverEnsuringAgent } from "../drivers/index.js";
import type { Driver } from "../core/types.js";
import { parseNumber } from "./shared.js";

export function registerViewCommands(program: Command): void {
  registerWatch(program);
  registerRecord(program);
}

// ------------------------------------------------------------------- watch

function registerWatch(program: Command): void {
  program
    .command("watch")
    .description("stream the device screen to a browser so you can watch a run live")
    .option("--port <port>", "port to serve on (default 7331)")
    .option("--fps <fps>", "frames per second to aim for (default 4)")
    .option("--marks", "draw the numbered tap targets on every frame")
    .option("--no-open", "do not open a browser")
    .action(async (options: { port?: string; fps?: string; marks?: boolean; open?: boolean }) => {
      const { driver } = await attachDriverEnsuringAgent();
      const port = parseNumber(options.port, "--port") ?? 7331;
      const fps = Math.min(15, Math.max(0.2, parseNumber(options.fps, "--fps") ?? 4));

      const page = watchPage({ fps, marks: options.marks === true });
      const server = createServer((request, response) => {
        void handleWatchRequest(request, response, driver, options.marks === true, page);
      });

      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, "127.0.0.1", () => resolveListen());
      });

      const url = `http://127.0.0.1:${port}`;
      if (options.open !== false) {
        await run("open", [url], { allowFailure: true, timeout: 10_000 }).catch(() => undefined);
      }

      info(
        [
          `${color.green("Watching")} ${driver.device.name} at ${color.bold(url)}`,
          color.dim(`  target ${fps} fps · ${options.marks ? "marks on" : "marks off"} · Ctrl-C to stop`),
        ].join("\n"),
      );

      // The server is the process from here; it ends on Ctrl-C.
      await new Promise<void>((stop) => {
        const shutdown = () => {
          server.close(() => stop());
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    });
}

async function handleWatchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  driver: Driver,
  marks: boolean,
  page: string,
): Promise<void> {
  const path = (request.url ?? "/").split("?")[0];

  try {
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }

    if (path === "/frame.png") {
      const wantsMarks = marks || (request.url ?? "").includes("marks=1");
      const image = wantsMarks ? await markedFrame(driver) : await driver.screenshot();
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
        "content-length": image.length,
      });
      response.end(image);
      return;
    }

    if (path === "/state") {
      const app = await driver.currentApp().catch(() => undefined);
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(
        JSON.stringify({
          device: driver.device.name,
          platform: driver.platform,
          app: app ?? null,
        }),
      );
      return;
    }

    response.writeHead(404).end("not found");
  } catch (error) {
    // A frame that fails must not kill the page — the device may simply be
    // mid-transition, or the agent may be restarting.
    const message = error instanceof Error ? error.message : String(error);
    response.writeHead(503, { "content-type": "text/plain" }).end(message);
  }
}

async function markedFrame(driver: Driver): Promise<Buffer> {
  const [image, snapshot] = await Promise.all([
    driver.screenshot(),
    readScreen(driver, { withApp: false }),
  ]);
  return drawMarks(image, snapshot.elements);
}

function watchPage(options: { fps: number; marks: boolean }): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>native-ai-tester — live</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; gap: 14px;
    background: #0b0d10; color: #e6e8eb;
    font: 13px/1.5 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif;
    padding: 20px; box-sizing: border-box;
  }
  header { display: flex; gap: 14px; align-items: center; }
  #app { font-variant-numeric: tabular-nums; color: #9aa4af; }
  #screen {
    max-height: 82vh; max-width: 92vw; border-radius: 14px;
    box-shadow: 0 0 0 1px #232a33, 0 24px 60px -20px #000;
    background: #14181d; display: block;
  }
  label { display: flex; gap: 6px; align-items: center; color: #9aa4af; user-select: none; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #2ecc71; }
  .dot.stale { background: #e67e22; }
</style>
<header>
  <span class="dot" id="dot"></span>
  <strong id="device">connecting…</strong>
  <span id="app"></span>
  <label><input type="checkbox" id="marks" ${options.marks ? "checked" : ""}> marks</label>
</header>
<img id="screen" alt="device screen">
<script>
  const screen = document.getElementById('screen');
  const dot = document.getElementById('dot');
  const marks = document.getElementById('marks');
  let current = null;

  async function frame() {
    try {
      const response = await fetch('/frame.png?marks=' + (marks.checked ? 1 : 0) + '&t=' + Date.now());
      if (!response.ok) throw new Error(String(response.status));
      const url = URL.createObjectURL(await response.blob());
      // Swap only once decoded, so the view never flashes an empty frame.
      const next = new Image();
      next.onload = () => {
        screen.src = url;
        if (current) URL.revokeObjectURL(current);
        current = url;
        dot.classList.remove('stale');
      };
      next.src = url;
    } catch {
      dot.classList.add('stale');
    }
  }

  async function state() {
    try {
      const info = await (await fetch('/state')).json();
      document.getElementById('device').textContent = info.device;
      document.getElementById('app').textContent = info.app ?? '';
    } catch {}
  }

  // Pace by completion rather than on a timer: a device that answers slowly
  // shows fewer frames instead of building a queue of stale requests. The
  // requested frame rate becomes a floor on the gap between them.
  const minGap = ${Math.round(1000 / options.fps)};
  (async function loop() {
    for (;;) {
      const started = Date.now();
      await frame();
      const remaining = minGap - (Date.now() - started);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    }
  })();
  state();
  setInterval(state, 2000);
</script>
`;
}

// ------------------------------------------------------------------ record

function registerRecord(program: Command): void {
  program
    .command("record")
    .description("record the screen to a video, or to a numbered filmstrip a model can read")
    .argument("[path]", "output file (.mp4 for video, .png for a filmstrip)", "./recording.mp4")
    .option("--seconds <n>", "how long to record (default 10)")
    .option("--filmstrip", "capture frames onto one contact sheet instead of a video")
    .option("--frames <n>", "filmstrip: how many frames (default 6)")
    .option("--marks", "filmstrip: draw the numbered tap targets on each frame")
    .action(async (path: string, options: RecordFlags) => {
      const { driver } = await attachDriverEnsuringAgent();
      const target = resolve(process.cwd(), path);
      await mkdir(dirname(target), { recursive: true }).catch(() => undefined);

      const wantsFilmstrip = options.filmstrip === true || extname(target).toLowerCase() === ".png";
      if (wantsFilmstrip) {
        await recordFilmstrip(driver, target, options);
        return;
      }
      await recordVideo(driver, target, options);
    });
}

interface RecordFlags {
  seconds?: string;
  filmstrip?: boolean;
  frames?: string;
  marks?: boolean;
}

async function recordFilmstrip(driver: Driver, target: string, options: RecordFlags): Promise<void> {
  const frames = Math.min(24, Math.max(2, parseNumber(options.frames, "--frames") ?? 6));
  const seconds = Math.max(0, parseNumber(options.seconds, "--seconds") ?? 3);
  const gap = frames > 1 ? (seconds * 1000) / (frames - 1) : 0;

  info(`Capturing ${frames} frames over ${seconds}s …`);
  const captured: Buffer[] = [];
  for (let index = 0; index < frames; index += 1) {
    captured.push(options.marks ? await markedFrame(driver) : await driver.screenshot());
    if (index < frames - 1 && gap > 0) await delay(gap);
  }

  const sheet = contactSheet(captured);
  await writeFile(target, sheet);

  emit(
    { ok: true, path: target, frames, seconds, bytes: sheet.length },
    `${color.green("Saved")} ${target} — ${frames} frames over ${seconds}s`,
  );
}

/**
 * Record video using whatever the platform provides.
 *
 * Simulators and Android both have a real recorder built in. A physical iPhone
 * has none that is reachable without a GUI capture session, so its frames come
 * from the agent one screenshot at a time — a few frames a second, encoded
 * afterwards. Same command, honestly different result.
 */
async function recordVideo(driver: Driver, target: string, options: RecordFlags): Promise<void> {
  const seconds = Math.max(1, parseNumber(options.seconds, "--seconds") ?? 10);

  if (driver.platform === "ios" && driver.device.kind === "simulator") {
    await recordWith({
      command: "xcrun",
      args: ["simctl", "io", driver.device.id, "recordVideo", "--codec=h264", "--force", target],
      seconds,
      target,
      tool: "simctl",
      // simctl announces itself on stderr once the capture session is live;
      // starting the clock before that silently loses the first second or two.
      readyMarker: /Recording started/i,
    });
    return;
  }

  if (driver.platform === "android") {
    const remote = "/sdcard/nat-recording.mp4";
    const adbPath = (await which("adb")) ?? "adb";
    await recordWith({
      command: adbPath,
      args: ["-s", driver.device.id, "shell", "screenrecord", "--time-limit", String(seconds), remote],
      seconds,
      target,
      tool: "screenrecord",
      // screenrecord enforces --time-limit itself, so let it finish cleanly
      // rather than interrupting it mid-write.
      selfTerminating: true,
      after: async () => {
        await run(adbPath, ["-s", driver.device.id, "pull", remote, target], { timeout: 300_000 });
        await run(adbPath, ["-s", driver.device.id, "shell", "rm", remote], { allowFailure: true });
      },
    });
    return;
  }

  await recordDeviceFrames(driver, target, seconds);
}

interface RecordWithOptions {
  command: string;
  args: string[];
  seconds: number;
  target: string;
  tool: string;
  /** Wait for this on the recorder's output before starting the clock. */
  readyMarker?: RegExp;
  /** True when the recorder stops on its own and must not be interrupted. */
  selfTerminating?: boolean;
  after?: () => Promise<void>;
}

async function recordWith(options: RecordWithOptions): Promise<void> {
  const { command, args, seconds, target, tool } = options;
  info(`Recording ${seconds}s with ${tool} …`);

  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

  let ready = !options.readyMarker;
  const readySignal = new Promise<void>((markReady) => {
    if (ready) {
      markReady();
      return;
    }
    const watch = (chunk: Buffer) => {
      if (!ready && options.readyMarker!.test(chunk.toString("utf8"))) {
        ready = true;
        markReady();
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
  });

  const finished = new Promise<void>((done) => {
    child.once("close", () => done());
    child.once("error", () => done());
  });

  // Don't wait forever for a marker that may never come.
  await Promise.race([readySignal, delay(5_000)]);

  if (options.selfTerminating) {
    await Promise.race([finished, delay((seconds + 20) * 1000)]);
  } else {
    await delay(seconds * 1000);
    child.kill("SIGINT"); // simctl finalises the file on SIGINT
    await Promise.race([finished, delay(20_000)]);
  }

  if (options.after) await options.after();

  emit({ ok: true, path: target, seconds, source: tool }, () => {
    const lines = [`${color.green("Saved")} ${target} (${seconds}s of capture)`];
    if (tool === "simctl") {
      // Worth saying: a 10s recording of a still screen is a very short file,
      // and that looks like a bug if you don't know why.
      lines.push(color.dim("  simctl writes variable-framerate video — a still screen produces a very short file"));
    }
    return lines.join("\n");
  });
}

/**
 * A real iPhone: capture frames through the agent and encode them.
 *
 * WebDriverAgent screenshots arrive at roughly one or two a second over USB, so
 * this is a timelapse rather than video. It is still the difference between
 * "the transition glitched" being reproducible and being a bug report nobody
 * can act on.
 */
async function recordDeviceFrames(driver: Driver, target: string, seconds: number): Promise<void> {
  const ffmpeg = await which("ffmpeg");
  if (!ffmpeg) {
    throw new NatError("MISSING_DEPENDENCY", "Recording a real iOS device needs ffmpeg to encode the frames", {
      hint:
        "Install it with `brew install ffmpeg`, or capture a filmstrip instead, which needs nothing:\n" +
        "  nat record --filmstrip ./frames.png --frames 8 --seconds 4",
    });
  }

  info(
    `Recording ${seconds}s of ${driver.device.name} …\n` +
      color.dim("  a physical iPhone has no screen-recording API, so this is a few frames a second"),
  );

  const started = Date.now();
  const frames: Buffer[] = [];
  while (Date.now() - started < seconds * 1000) {
    frames.push(await driver.screenshot());
  }

  if (frames.length < 2) {
    throw new NatError("TIMEOUT", "Could not capture enough frames to encode", {
      hint: "Try a longer `--seconds`, or use `nat record --filmstrip`.",
    });
  }

  const fps = frames.length / seconds;
  const sheetDir = `${target}.frames`;
  await mkdir(sheetDir, { recursive: true });
  await Promise.all(
    frames.map((frame, index) => writeFile(`${sheetDir}/${String(index).padStart(5, "0")}.png`, frame)),
  );

  await run(
    ffmpeg,
    ["-y", "-framerate", fps.toFixed(3), "-i", `${sheetDir}/%05d.png`, "-pix_fmt", "yuv420p", target],
    { timeout: 300_000 },
  );
  await run("rm", ["-rf", sheetDir], { allowFailure: true });

  emit(
    { ok: true, path: target, seconds, frames: frames.length, fps: Number(fps.toFixed(2)), source: "screenshots" },
    `${color.green("Saved")} ${target} — ${frames.length} frames, ${fps.toFixed(1)} fps`,
  );
}

export { isJson };
