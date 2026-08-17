/**
 * `adb` wrapper.
 *
 * Android needs no companion agent: adb already exposes screencap, uiautomator
 * and the input injector. That makes the Android path dependency-free — if the
 * user has the platform tools, they can test.
 */

import { run, which } from "../../core/exec.js";
import { NatError } from "../../core/errors.js";
import type { AppInfo, Device } from "../../core/types.js";

let adbPathOverride: string | undefined;

export function setAdbPath(path: string | undefined): void {
  adbPathOverride = path;
}

export async function adbBinary(): Promise<string> {
  if (adbPathOverride) return adbPathOverride;
  const onPath = await which("adb");
  if (onPath) return onPath;

  // The SDK is frequently installed without platform-tools on PATH.
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (home) return `${home}/platform-tools/adb`;

  throw new NatError("MISSING_DEPENDENCY", "`adb` was not found", {
    hint:
      "Install the Android platform tools and make sure adb is on PATH:\n" +
      "  brew install --cask android-platform-tools\n" +
      "…or point at it directly: `nat config set android.adbPath /path/to/adb`",
  });
}

export async function adb(args: string[], options: { binary?: boolean; timeout?: number; allowFailure?: boolean } = {}) {
  const binary = await adbBinary();
  return await run(binary, args, {
    timeout: options.timeout ?? 60_000,
    binary: options.binary,
    allowFailure: options.allowFailure,
  });
}

export async function adbDevice(
  serial: string,
  args: string[],
  options: { binary?: boolean; timeout?: number; allowFailure?: boolean } = {},
) {
  return await adb(["-s", serial, ...args], options);
}

export async function shell(serial: string, command: string, timeout = 60_000): Promise<string> {
  const result = await adbDevice(serial, ["shell", command], { timeout });
  return result.stdout;
}

export async function listDevices(): Promise<Device[]> {
  const binary = await which(adbPathOverride ?? "adb").catch(() => undefined);
  if (!adbPathOverride && !binary && !process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
    return [];
  }

  const result = await adb(["devices", "-l"], { allowFailure: true, timeout: 30_000 });
  if (result.code !== 0) return [];

  const devices: Device[] = [];
  for (const line of result.stdout.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;

    const properties = Object.fromEntries(
      rest.map((chunk) => chunk.split(":")).filter((pair): pair is [string, string] => pair.length === 2),
    );
    const emulator = serial.startsWith("emulator-");
    const online = state === "device";

    let osVersion: string | undefined;
    let model = properties["model"]?.replace(/_/g, " ");
    if (online) {
      osVersion = (await getProp(serial, "ro.build.version.release")) || undefined;
      model = (await getProp(serial, "ro.product.model")) || model;
    }

    devices.push({
      id: serial,
      name: model || serial,
      platform: "android",
      kind: emulator ? "emulator" : "device",
      state: online ? "connected" : state === "unauthorized" ? "unauthorized" : "offline",
      osVersion,
      model,
      ready: online,
      ...(online
        ? {}
        : {
            note:
              state === "unauthorized"
                ? "unauthorized — unlock the device and accept the USB debugging prompt"
                : `adb reports state \`${state}\``,
          }),
    });
  }
  return devices;
}

export async function getProp(serial: string, key: string): Promise<string> {
  const result = await adbDevice(serial, ["shell", "getprop", key], {
    allowFailure: true,
    timeout: 15_000,
  });
  return result.stdout.trim();
}

export async function screenSize(serial: string): Promise<{ width: number; height: number; scale?: number }> {
  const raw = await shell(serial, "wm size", 15_000);
  // An override size (set by `wm size WxH`) is what is actually rendered.
  const override = /Override size:\s*(\d+)x(\d+)/.exec(raw);
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(raw);
  const match = override ?? physical;
  if (!match) {
    throw new NatError("DRIVER_FAILED", `Could not read the screen size from \`wm size\`: ${raw.trim()}`);
  }

  let scale: number | undefined;
  const densityRaw = await shell(serial, "wm density", 15_000).catch(() => "");
  const density = /(?:Override|Physical) density:\s*(\d+)/.exec(densityRaw);
  if (density?.[1]) scale = Number(density[1]) / 160;

  return { width: Number(match[1]), height: Number(match[2]), ...(scale ? { scale } : {}) };
}

export async function screenshot(serial: string): Promise<Buffer> {
  const result = await adbDevice(serial, ["exec-out", "screencap", "-p"], {
    binary: true,
    timeout: 60_000,
  });
  if (result.stdoutBuffer.length === 0) {
    throw new NatError("DRIVER_FAILED", "screencap returned no data", {
      hint: "Unlock the device and try again — screencap fails on a locked screen.",
    });
  }
  return result.stdoutBuffer;
}

/**
 * Dump the UiAutomator hierarchy.
 *
 * The dump is written on-device and read back in the same shell invocation:
 * `uiautomator dump /dev/tty` is one round trip fewer but is unreliable on
 * several OEM builds, and a testing tool cannot afford a screen read that
 * sometimes returns truncated XML.
 */
export async function uiHierarchy(serial: string): Promise<string> {
  const remote = "/sdcard/nat-window-dump.xml";
  const result = await adbDevice(
    serial,
    ["exec-out", `uiautomator dump ${remote} >/dev/null 2>&1; cat ${remote}`],
    { timeout: 60_000, allowFailure: true },
  );
  const xml = result.stdoutBuffer.toString("utf8");
  const start = xml.indexOf("<hierarchy");
  if (start === -1) {
    throw new NatError("DRIVER_FAILED", "UiAutomator returned no hierarchy", {
      hint:
        "This usually means the screen is off or secure (FLAG_SECURE). Unlock the device, " +
        "or fall back to `nat screenshot` and target elements by description.",
      details: { output: xml.slice(0, 500) },
    });
  }
  const end = xml.lastIndexOf("</hierarchy>");
  return end === -1 ? xml.slice(start) : xml.slice(start, end + "</hierarchy>".length);
}

export async function tap(serial: string, x: number, y: number): Promise<void> {
  await shell(serial, `input tap ${x} ${y}`, 30_000);
}

export async function longPress(serial: string, x: number, y: number, durationMs: number): Promise<void> {
  await shell(serial, `input swipe ${x} ${y} ${x} ${y} ${durationMs}`, 60_000);
}

export async function swipe(
  serial: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
): Promise<void> {
  await shell(serial, `input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, 60_000);
}

export async function dragAndDrop(
  serial: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
): Promise<void> {
  // `draganddrop` performs the long-press-then-move gesture drop targets need.
  // It landed in API 30; older devices get a slow swipe, which is the closest
  // gesture the injector can express.
  const api = Number(await getProp(serial, "ro.build.version.sdk"));
  if (Number.isFinite(api) && api >= 30) {
    await shell(serial, `input draganddrop ${x1} ${y1} ${x2} ${y2} ${durationMs}`, 60_000);
    return;
  }
  await swipe(serial, x1, y1, x2, y2, Math.max(durationMs, 1_000));
}

export async function typeText(serial: string, text: string): Promise<void> {
  // `input text` runs through the shell, so the argument is escaped for the
  // shell *and* for the injector's own %s space encoding.
  const chunks = text.match(/.{1,200}/gs) ?? [];
  for (const chunk of chunks) {
    await shell(serial, `input text ${escapeForInput(chunk)}`, 60_000);
  }
}

export function escapeForInput(text: string): string {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/(["'`$&|;<>()*?~^#\[\]{}!])/g, "\\$1")
    .replace(/ /g, "%s");
  return escaped;
}

export async function keyEvent(serial: string, keycode: string): Promise<void> {
  await shell(serial, `input keyevent ${keycode}`, 30_000);
}

export async function currentPackage(serial: string): Promise<string | undefined> {
  const dump = await shell(serial, "dumpsys window", 30_000).catch(() => "");
  const focus =
    /mCurrentFocus=Window\{[^}]*\s+(\S+)\/(\S+?)\}/.exec(dump) ??
    /mFocusedApp=.*?\s(\S+)\/(\S+?)[\s}]/.exec(dump);
  if (focus?.[1]) return focus[1];

  const resumed = /topResumedActivity=.*?\s(\S+)\/(\S+?)[\s}]/.exec(
    await shell(serial, "dumpsys activity activities", 30_000).catch(() => ""),
  );
  return resumed?.[1];
}

export async function launchPackage(serial: string, pkg: string): Promise<void> {
  const result = await adbDevice(
    serial,
    ["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"],
    { allowFailure: true, timeout: 60_000 },
  );
  if (result.code !== 0 || /No activities found|Error/i.test(result.stdout + result.stderr)) {
    throw new NatError("APP_NOT_FOUND", `Could not launch \`${pkg}\``, {
      hint: "Check the package is installed with `nat apps`, and that it declares a LAUNCHER activity.",
      details: { output: (result.stdout + result.stderr).slice(0, 500) },
    });
  }
}

export async function forceStop(serial: string, pkg: string): Promise<void> {
  await shell(serial, `am force-stop ${pkg}`, 30_000);
}

export async function openUrl(serial: string, url: string): Promise<void> {
  const result = await adbDevice(
    serial,
    ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url],
    { allowFailure: true, timeout: 60_000 },
  );
  if (/Error:/i.test(result.stdout + result.stderr)) {
    throw new NatError("DRIVER_FAILED", `Could not open \`${url}\``, {
      details: { output: (result.stdout + result.stderr).slice(0, 500) },
    });
  }
}

export async function installApk(serial: string, path: string): Promise<void> {
  const result = await adbDevice(serial, ["install", "-r", "-g", path], {
    allowFailure: true,
    timeout: 600_000,
  });
  const output = result.stdout + result.stderr;
  if (result.code !== 0 || /Failure|Error/i.test(output)) {
    throw new NatError("DRIVER_FAILED", `Install failed: ${output.trim().split("\n").slice(-3).join(" | ")}`);
  }
}

export async function uninstallPackage(serial: string, pkg: string): Promise<void> {
  await adbDevice(serial, ["uninstall", pkg], { timeout: 120_000 });
}

export async function listPackages(serial: string, includeSystem = false): Promise<AppInfo[]> {
  const raw = await shell(serial, `pm list packages${includeSystem ? "" : " -3"}`, 60_000);
  return raw
    .split("\n")
    .map((line) => line.trim().replace(/^package:/, ""))
    .filter(Boolean)
    .sort()
    .map((bundleId) => ({ bundleId }));
}
