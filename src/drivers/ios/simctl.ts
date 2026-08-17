/**
 * `xcrun simctl` — iOS Simulator lifecycle and app management.
 *
 * simctl owns everything about a simulator *except* the UI: it can boot,
 * install, launch and screenshot, but it cannot tap. Gestures and the element
 * tree come from WebDriverAgent, which is why the simulator driver combines
 * the two rather than picking one.
 */

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../../core/exec.js";
import { NatError } from "../../core/errors.js";
import type { AppInfo, Device } from "../../core/types.js";

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
  availabilityError?: string;
  deviceTypeIdentifier?: string;
}

export async function listSimulators(): Promise<Device[]> {
  const result = await run("xcrun", ["simctl", "list", "devices", "--json"], { timeout: 30_000 });
  const parsed = JSON.parse(result.stdout) as { devices: Record<string, SimctlDevice[]> };
  const devices: Device[] = [];

  for (const [runtime, entries] of Object.entries(parsed.devices ?? {})) {
    const osVersion = runtimeVersion(runtime);
    // Non-iOS runtimes (watchOS, tvOS) are out of scope for mobile app testing.
    if (!/iOS|iPadOS/i.test(runtime)) continue;
    for (const entry of entries) {
      if (entry.isAvailable === false) continue;
      const booted = entry.state === "Booted";
      devices.push({
        id: entry.udid,
        name: entry.name,
        platform: "ios",
        kind: "simulator",
        state: booted ? "booted" : "shutdown",
        osVersion,
        model: entry.name,
        ready: true,
        ...(booted ? {} : { note: "shutdown — `nat devices connect` will boot it" }),
      });
    }
  }
  return devices;
}

export async function findSimulator(udid: string): Promise<Device | undefined> {
  const all = await listSimulators();
  return all.find((device) => device.id === udid);
}

export async function boot(udid: string): Promise<void> {
  const result = await run("xcrun", ["simctl", "boot", udid], {
    allowFailure: true,
    timeout: 180_000,
  });
  // simctl reports an already-booted device as a failure; that is our success case.
  if (result.code !== 0 && !/current state: Booted|Unable to boot device in current state: Booted/i.test(result.stderr)) {
    throw new NatError("DEVICE_NOT_READY", `Could not boot simulator ${udid}: ${result.stderr.trim()}`, {
      hint: "Open Xcode → Window → Devices and Simulators and check the simulator is not mid-erase.",
    });
  }
  await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { allowFailure: true, timeout: 180_000 });
}

export async function shutdown(udid: string): Promise<void> {
  await run("xcrun", ["simctl", "shutdown", udid], { allowFailure: true, timeout: 60_000 });
}

/** Bring the Simulator.app window forward so the user can watch the run. */
export async function openSimulatorApp(): Promise<void> {
  await run("open", ["-a", "Simulator"], { allowFailure: true, timeout: 20_000 });
}

export async function screenshot(udid: string): Promise<Buffer> {
  const file = join(tmpdir(), `nat-shot-${process.pid}-${Date.now()}.png`);
  try {
    await run("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", file], { timeout: 30_000 });
    return await readFile(file);
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

export async function installApp(udid: string, path: string): Promise<void> {
  await run("xcrun", ["simctl", "install", udid, path], { timeout: 300_000 });
}

export async function uninstallApp(udid: string, bundleId: string): Promise<void> {
  await run("xcrun", ["simctl", "uninstall", udid, bundleId], { timeout: 120_000 });
}

export async function launchApp(udid: string, bundleId: string): Promise<void> {
  await run("xcrun", ["simctl", "launch", udid, bundleId], { timeout: 120_000 });
}

export async function terminateApp(udid: string, bundleId: string): Promise<void> {
  await run("xcrun", ["simctl", "terminate", udid, bundleId], {
    allowFailure: true,
    timeout: 60_000,
  });
}

export async function openUrl(udid: string, url: string): Promise<void> {
  await run("xcrun", ["simctl", "openurl", udid, url], { timeout: 60_000 });
}

/**
 * `simctl listapps` emits an OpenStep property list, so we hand it to `plutil`
 * rather than writing a plist parser.
 */
export async function listApps(udid: string): Promise<AppInfo[]> {
  const listed = await run("xcrun", ["simctl", "listapps", udid], {
    timeout: 60_000,
    allowFailure: true,
  });
  if (listed.code !== 0 || !listed.stdout.trim()) return [];

  const converted = await run("plutil", ["-convert", "json", "-r", "-o", "-", "--", "-"], {
    input: listed.stdout,
    allowFailure: true,
    timeout: 30_000,
  });
  if (converted.code !== 0) return [];

  try {
    const parsed = JSON.parse(converted.stdout) as Record<string, Record<string, unknown>>;
    return Object.entries(parsed)
      .filter(([, value]) => value["ApplicationType"] !== "System")
      .map(([bundleId, value]) => ({
        bundleId,
        name: (value["CFBundleDisplayName"] as string) || (value["CFBundleName"] as string) || undefined,
        version: (value["CFBundleShortVersionString"] as string) || undefined,
      }))
      .sort((a, b) => a.bundleId.localeCompare(b.bundleId));
  } catch {
    return [];
  }
}

function runtimeVersion(runtime: string): string | undefined {
  const match = /iOS[-.](\d+)[-.](\d+)/i.exec(runtime);
  if (match) return `${match[1]}.${match[2]}`;
  const loose = /(\d+)[-.](\d+)$/.exec(runtime);
  return loose ? `${loose[1]}.${loose[2]}` : undefined;
}
