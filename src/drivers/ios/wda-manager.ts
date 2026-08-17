/**
 * WebDriverAgent lifecycle: fetch it, build it, keep it running, reach it.
 *
 * Design note — why a detached process:
 * every `nat` invocation is a short-lived one-shot command, but WDA takes tens
 * of seconds to build and boot. So `nat devices connect` starts the agent
 * *detached*, records its pid and URL in the session file, and every later
 * command is a plain HTTP call that returns in milliseconds. That is what makes
 * the inspect → act → verify loop cheap enough for an agent to run it on every
 * single step.
 */

import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { run, which } from "../../core/exec.js";
import { NatError } from "../../core/errors.js";
import { ensureDir, paths } from "../../core/paths.js";
import { debug, info } from "../../core/output.js";
import { WdaClient } from "./wda-client.js";

export interface WdaTarget {
  udid: string;
  kind: "device" | "simulator";
  /** Host port the CLI will talk to. */
  port: number;
  teamId?: string;
  bundleId?: string;
  wdaVersion: string;
}

export interface WdaHandle {
  url: string;
  /** pid of the xcodebuild process, when we started it. */
  pid?: number;
  /** pid of the usbmux port-forwarder, when one was needed. */
  tunnelPid?: number;
  logFile: string;
  reused: boolean;
}

const SERVER_URL_PATTERN = /ServerURLHere->(https?:\/\/[^<\s]+)<-ServerURLHere/;
const BUILD_TIMEOUT_MS = 15 * 60_000;

// ---------------------------------------------------------------- source

export async function ensureSource(version: string): Promise<string> {
  const root = await ensureDir(paths.wdaRoot());
  const source = paths.wdaSource();
  const marker = join(root, ".version");

  const installed = await readFile(marker, "utf8").catch(() => "");
  if (installed.trim() === version && (await exists(join(source, "WebDriverAgent.xcodeproj")))) {
    return source;
  }

  info(`Fetching WebDriverAgent ${version} …`);
  const tarball = join(root, `wda-${version}.tar.gz`);
  const url = `https://github.com/appium/WebDriverAgent/archive/refs/tags/${version}.tar.gz`;

  await writeFile(tarball, await download(url, version));

  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", source, "--strip-components", "1"], { timeout: 300_000 });
  await rm(tarball, { force: true });
  await writeFile(marker, version, "utf8");
  debug(`wda: source ready at ${source}`);
  return source;
}

/**
 * Fetch the release tarball.
 *
 * GitHub's archive endpoint rate-limits anonymous clients hard, and answers
 * 429 rather than queueing — so identify ourselves and back off instead of
 * reporting "the tag does not exist" for what is really a transient limit.
 */
async function download(url: string, version: string): Promise<Buffer> {
  const attempts = 4;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": `native-ai-tester (+https://github.com/native-ai-tester/native-ai-tester)`,
        accept: "application/octet-stream",
      },
    }).catch(() => undefined);

    if (response?.ok) return Buffer.from(await response.arrayBuffer());
    lastStatus = response?.status ?? 0;

    const retryable = lastStatus === 0 || lastStatus === 429 || lastStatus >= 500;
    if (!retryable || attempt === attempts) break;

    const waitMs = Number(response?.headers.get("retry-after")) * 1000 || 2 ** attempt * 1000;
    debug(`wda: download got HTTP ${lastStatus}, retrying in ${waitMs}ms`);
    await delay(waitMs);
  }

  throw new NatError(
    "MISSING_DEPENDENCY",
    `Could not download WebDriverAgent ${version} (HTTP ${lastStatus || "no response"})`,
    {
      hint:
        lastStatus === 404
          ? `That tag does not exist. Pick another with \`nat config set ios.wdaVersion <tag>\` — see https://github.com/appium/WebDriverAgent/tags`
          : `GitHub is rate-limiting or unreachable. Try again shortly, or download it yourself:\n` +
            `  curl -fsSL -o wda.tar.gz ${url}\n` +
            `  mkdir -p ${paths.wdaSource()} && tar -xzf wda.tar.gz -C ${paths.wdaSource()} --strip-components 1\n` +
            `  printf '%s' ${version} > ${join(paths.wdaRoot(), ".version")}`,
    },
  );
}

export async function isSourceReady(version: string): Promise<boolean> {
  const installed = await readFile(join(paths.wdaRoot(), ".version"), "utf8").catch(() => "");
  return installed.trim() === version && (await exists(join(paths.wdaSource(), "WebDriverAgent.xcodeproj")));
}

// ---------------------------------------------------------------- start/stop

export async function start(target: WdaTarget): Promise<WdaHandle> {
  const localUrl = `http://127.0.0.1:${target.port}`;

  // Reuse a live agent rather than rebuilding — this is the common case once a
  // developer has connected once in a session.
  if (await new WdaClient(localUrl).isUp(1_500)) {
    debug("wda: reusing agent already listening locally");
    return { url: localUrl, logFile: logFileFor(target.udid), reused: true };
  }

  const source = await ensureSource(target.wdaVersion);
  await ensureDir(paths.logs());
  const logFile = logFileFor(target.udid);
  await rm(logFile, { force: true });

  const args = buildArgs(target, source);
  debug(`wda: xcodebuild ${args.join(" ")}`);
  info(
    target.kind === "simulator"
      ? "Starting WebDriverAgent on the simulator (first run builds it, ~1–3 min) …"
      : "Building and installing WebDriverAgent on the device (first run takes a few minutes) …",
  );

  const stream = createWriteStream(logFile, { flags: "a" });
  await new Promise((resolve) => stream.once("open", resolve));

  const child = spawn("xcodebuild", args, {
    cwd: source,
    env: { ...process.env, USE_PORT: String(target.port) },
    stdio: ["ignore", stream, stream],
    detached: true,
  });
  child.unref();

  const advertised = await waitForServerUrl(logFile, BUILD_TIMEOUT_MS, child.pid);
  debug(`wda: agent advertised ${advertised}`);

  const reachable = await resolveReachableUrl(target, advertised, localUrl);
  return { url: reachable.url, pid: child.pid, tunnelPid: reachable.tunnelPid, logFile, reused: false };
}

function buildArgs(target: WdaTarget, source: string): string[] {
  const args = [
    "-project",
    join(source, "WebDriverAgent.xcodeproj"),
    "-scheme",
    "WebDriverAgentRunner",
    "-derivedDataPath",
    paths.wdaDerivedData(),
    "-destination",
    target.kind === "simulator"
      ? `platform=iOS Simulator,id=${target.udid}`
      : `platform=iOS,id=${target.udid}`,
  ];

  if (target.kind === "simulator") {
    args.push("CODE_SIGNING_ALLOWED=NO");
  } else {
    if (!target.teamId) {
      throw new NatError("MISSING_DEPENDENCY", "An Apple Developer team id is required to run on a real device", {
        hint:
          "Run `nat setup ios` to pick one automatically, or set it explicitly:\n" +
          "  nat config set ios.teamId <TEAMID>",
      });
    }
    args.push("-allowProvisioningUpdates", "CODE_SIGN_STYLE=Automatic", `DEVELOPMENT_TEAM=${target.teamId}`);
    if (target.bundleId && target.bundleId !== "com.facebook.WebDriverAgentRunner") {
      args.push(`PRODUCT_BUNDLE_IDENTIFIER=${target.bundleId}`);
    }
  }

  args.push("test");
  return args;
}

/**
 * Work out where the agent can actually be reached.
 *
 * A simulator shares the Mac's network stack, so it is simply on localhost. A
 * real device is not: WDA listens on the *phone's* port 8100, which has to be
 * bridged over USB by a usbmux forwarder. Modern WDA advertises the device's
 * own loopback address, so that URL is only useful when it happens to be a real
 * LAN address — which older builds do report.
 */
async function resolveReachableUrl(
  target: WdaTarget,
  advertised: string,
  localUrl: string,
): Promise<{ url: string; tunnelPid?: number }> {
  if (target.kind === "simulator") {
    if (await waitForAgent(localUrl, 20_000)) return { url: localUrl };
    if (await waitForAgent(advertised, 10_000)) return { url: advertised };
    throw agentUnreachable(localUrl, target, undefined);
  }

  const forwarder = await startTunnel(target.udid, target.port);
  if (forwarder) return { url: localUrl, tunnelPid: forwarder.pid };

  // Only worth trying when the phone advertised a routable address rather than
  // its own loopback.
  if (!isLoopback(advertised) && (await waitForAgent(advertised, 15_000))) {
    info(`WebDriverAgent reachable over the network at ${advertised}`);
    return { url: advertised };
  }

  throw agentUnreachable(localUrl, target, await tunnelDiagnosis());
}

function isLoopback(url: string): boolean {
  return /\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url);
}

function agentUnreachable(url: string, target: WdaTarget, diagnosis: string | undefined): NatError {
  if (target.kind !== "device") {
    return new NatError("AGENT_UNAVAILABLE", `WebDriverAgent started but is not reachable at ${url}`, {
      hint: `Check the build log for the failure: ${logFileFor(target.udid)}`,
    });
  }
  return new NatError(
    "MISSING_DEPENDENCY",
    "WebDriverAgent is running on the device, but nothing is bridging its port to this Mac",
    {
      hint:
        (diagnosis ? `${diagnosis}\n\n` : "") +
        "Install a usbmux port forwarder:\n" +
        "  brew install libimobiledevice     # provides `iproxy` — the lightest option\n" +
        "  brew install go-ios               # provides `ios forward`\n" +
        "  pipx install pymobiledevice3      # pure Python, no brew\n" +
        "\n" +
        "Then reconnect. The agent itself is already installed on the phone, so this is quick.\n" +
        `Build log: ${logFileFor(target.udid)}`,
    },
  );
}

interface Tunnel {
  pid: number;
  tool: string;
}

const FORWARDERS = (port: number, udid: string): Array<{ bin: string; args: string[] }> => [
  // libimobiledevice ≥ 1.3 takes LOCAL:DEVICE pairs.
  { bin: "iproxy", args: [`${port}:${port}`, "-u", udid] },
  { bin: "ios", args: ["forward", String(port), String(port), `--udid=${udid}`] },
  { bin: "pymobiledevice3", args: ["usbmux", "forward", String(port), String(port), "--udid", udid] },
];

/**
 * Bridge the device's agent port to localhost.
 *
 * Each candidate is spawned and then *proved* by asking the agent for its
 * status through the new tunnel. Being on PATH is not evidence a tool works —
 * a Homebrew Python upgrade leaves `pymobiledevice3` on PATH as a script whose
 * interpreter no longer exists, and it fails at spawn time.
 */
export async function startTunnel(udid: string, port: number): Promise<Tunnel | undefined> {
  const localUrl = `http://127.0.0.1:${port}`;

  for (const candidate of FORWARDERS(port, udid)) {
    const resolved = await which(candidate.bin);
    if (!resolved) continue;

    debug(`wda: forwarding port ${port} with ${candidate.bin}`);
    const child = spawn(resolved, candidate.args, { stdio: "ignore", detached: true });

    // A detached child that cannot start emits `error`; without a listener that
    // is an uncaught exception and takes the whole CLI down with it.
    let spawnFailed = false;
    child.on("error", (error) => {
      spawnFailed = true;
      debug(`wda: ${candidate.bin} could not start: ${error.message}`);
    });
    child.unref();

    if (await waitForAgent(localUrl, 20_000)) {
      return { pid: child.pid!, tool: candidate.bin };
    }

    debug(`wda: ${candidate.bin} did not bridge the port${spawnFailed ? " (it failed to start)" : ""}`);
    if (child.pid) killPid(child.pid);
  }
  return undefined;
}

/** Explain *why* the forwarders on this machine did not work. */
async function tunnelDiagnosis(): Promise<string | undefined> {
  const notes: string[] = [];
  for (const candidate of FORWARDERS(0, "")) {
    const resolved = await which(candidate.bin);
    if (!resolved) continue;
    const probe = await run(resolved, ["--help"], { allowFailure: true, timeout: 10_000 }).catch(
      (error: unknown) => ({ code: -1, stderr: error instanceof Error ? error.message : String(error) }),
    );
    if (probe.code === -1 || /ENOENT|bad interpreter|No such file/i.test(probe.stderr ?? "")) {
      notes.push(`\`${candidate.bin}\` is on PATH at ${resolved} but is broken — reinstall or remove it.`);
    }
  }
  return notes.length > 0 ? notes.join("\n") : undefined;
}

async function waitForServerUrl(logFile: string, timeoutMs: number, pid?: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = 0;
  while (Date.now() < deadline) {
    const log = await readFile(logFile, "utf8").catch(() => "");
    const match = SERVER_URL_PATTERN.exec(log);
    if (match?.[1]) return match[1].replace(/\/$/, "");

    const failure = detectBuildFailure(log);
    if (failure) throw failure;

    if (pid && !isRunning(pid) && log.length === lastSize) {
      throw new NatError("AGENT_UNAVAILABLE", "xcodebuild exited before WebDriverAgent started", {
        hint: `Inspect the build log: ${logFile}`,
        details: { tail: tail(log, 25) },
      });
    }
    lastSize = log.length;
    await delay(1_000);
  }
  throw new NatError("TIMEOUT", `WebDriverAgent did not start within ${Math.round(timeoutMs / 1000)}s`, {
    hint: `Inspect the build log: ${logFile}`,
  });
}

function detectBuildFailure(log: string): NatError | undefined {
  if (/Testing failed:|xcodebuild: error:|\*\* TEST FAILED \*\*/.test(log)) {
    if (/requires a provisioning profile|No profiles for|Signing for .* requires a development team/.test(log)) {
      return new NatError("MISSING_DEPENDENCY", "WebDriverAgent could not be signed for this device", {
        hint:
          "Set your Apple Developer team id and try again:\n" +
          "  nat setup ios            # detects it from your provisioning profiles\n" +
          "  nat config set ios.teamId <TEAMID>\n" +
          "If the bundle id is already taken, pick your own: `nat config set ios.wdaBundleId com.yourteam.WebDriverAgentRunner`.",
        details: { tail: tail(log, 20) },
      });
    }
    if (/Unable to verify app|application-identifier|not trusted|Untrusted Developer/i.test(log)) {
      return new NatError("DEVICE_NOT_READY", "The WebDriverAgent app is not trusted on the device", {
        hint: "On the phone: Settings → General → VPN & Device Management → trust your developer certificate, then reconnect.",
        details: { tail: tail(log, 20) },
      });
    }
    return new NatError("AGENT_UNAVAILABLE", "The WebDriverAgent build failed", {
      details: { tail: tail(log, 25) },
    });
  }
  return undefined;
}

async function waitForAgent(url: string, timeoutMs: number): Promise<boolean> {
  const client = new WdaClient(url);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.isUp(2_000)) return true;
    await delay(500);
  }
  return false;
}

export function stop(handle: { pid?: number; tunnelPid?: number }): void {
  if (handle.tunnelPid) killPid(handle.tunnelPid);
  if (handle.pid) killPid(handle.pid);
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone — nothing to clean up.
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- signing

/**
 * Read the Team IDs out of the user's installed provisioning profiles.
 *
 * `security find-identity` lists certificates, but the ten-character string in
 * a certificate's common name is not reliably the Team ID. The profiles carry
 * `TeamIdentifier` verbatim, so that is what we read.
 */
export async function detectTeamIds(): Promise<Array<{ teamId: string; teamName?: string }>> {
  const dirs = [
    join(process.env.HOME ?? "", "Library/Developer/Xcode/UserData/Provisioning Profiles"),
    join(process.env.HOME ?? "", "Library/MobileDevice/Provisioning Profiles"),
  ];

  const found = new Map<string, string | undefined>();
  for (const dir of dirs) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith(".mobileprovision") && !entry.endsWith(".provisionprofile")) continue;
      const decoded = await run("security", ["cms", "-D", "-i", join(dir, entry)], {
        allowFailure: true,
        timeout: 15_000,
      });
      if (decoded.code !== 0) continue;
      const teamId = /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(decoded.stdout)?.[1];
      const teamName = /<key>TeamName<\/key>\s*<string>([^<]+)<\/string>/.exec(decoded.stdout)?.[1];
      if (teamId && !found.has(teamId)) found.set(teamId, teamName);
    }
  }
  return [...found.entries()].map(([teamId, teamName]) => ({ teamId, teamName }));
}

// ---------------------------------------------------------------- helpers

function logFileFor(udid: string): string {
  return join(paths.logs(), `wda-${udid}.log`);
}

export function wdaLogPath(udid: string): string {
  return logFileFor(udid);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function tail(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}
