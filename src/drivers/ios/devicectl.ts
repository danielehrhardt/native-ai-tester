/**
 * `xcrun devicectl` — real iOS device discovery and app management.
 *
 * devicectl ships with Xcode 15+, so it needs no third-party tooling to pair,
 * enumerate, install and launch. It has no notion of the UI, which is again
 * WebDriverAgent's job.
 */

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../../core/exec.js";
import { NatError } from "../../core/errors.js";
import type { AppInfo, Device } from "../../core/types.js";

interface DevicectlDevice {
  identifier: string;
  connectionProperties?: {
    tunnelState?: string;
    transportType?: string;
    pairingState?: string;
  };
  deviceProperties?: {
    name?: string;
    osVersionNumber?: string;
    developerModeStatus?: string;
    bootState?: string;
  };
  hardwareProperties?: {
    udid?: string;
    marketingName?: string;
    platform?: string;
    deviceType?: string;
    reality?: string;
  };
}

/** `identifier` is CoreDevice's id; `udid` is what xcodebuild destinations want. */
export interface IosDeviceHandle {
  udid: string;
  coreDeviceId: string;
}

export async function listDevices(): Promise<Device[]> {
  const raw = await listRaw();
  return raw
    .filter((entry) => (entry.hardwareProperties?.platform ?? "iOS") === "iOS")
    .filter((entry) => entry.hardwareProperties?.reality !== "simulator")
    .map(toDevice);
}

export async function findDevice(id: string): Promise<{ device: Device; handle: IosDeviceHandle } | undefined> {
  const raw = await listRaw();
  const match = raw.find(
    (entry) =>
      entry.identifier === id ||
      entry.hardwareProperties?.udid === id ||
      entry.deviceProperties?.name === id,
  );
  if (!match) return undefined;
  const udid = match.hardwareProperties?.udid ?? match.identifier;
  return {
    device: toDevice(match),
    handle: { udid, coreDeviceId: match.identifier },
  };
}

async function listRaw(): Promise<DevicectlDevice[]> {
  const file = tempJsonPath("devices");
  try {
    await run("xcrun", ["devicectl", "list", "devices", "--json-output", file, "--quiet"], {
      timeout: 60_000,
      allowFailure: true,
    });
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      result?: { devices?: DevicectlDevice[] };
    };
    return parsed.result?.devices ?? [];
  } catch {
    return [];
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

function toDevice(entry: DevicectlDevice): Device {
  const connected = entry.connectionProperties?.tunnelState === "connected";
  const developerMode = entry.deviceProperties?.developerModeStatus;
  const paired = entry.connectionProperties?.pairingState === "paired";

  let note: string | undefined;
  let ready = connected;
  if (!connected) {
    note = paired
      ? "not connected — plug it in (or enable Connect via Network in Xcode) and unlock it"
      : "not paired — connect by cable and tap Trust on the device";
  } else if (developerMode && developerMode !== "enabled") {
    ready = false;
    note = "Developer Mode is off — enable Settings → Privacy & Security → Developer Mode";
  }

  return {
    id: entry.hardwareProperties?.udid ?? entry.identifier,
    name: (entry.deviceProperties?.name ?? "iOS device").trim(),
    platform: "ios",
    kind: "device",
    state: connected ? "connected" : "unavailable",
    osVersion: entry.deviceProperties?.osVersionNumber,
    model: entry.hardwareProperties?.marketingName,
    ready,
    ...(note ? { note } : {}),
  };
}

export async function installApp(deviceId: string, path: string): Promise<void> {
  const result = await run(
    "xcrun",
    ["devicectl", "device", "install", "app", "--device", deviceId, path],
    { timeout: 600_000, allowFailure: true },
  );
  if (result.code !== 0) {
    throw new NatError("DRIVER_FAILED", `Install failed: ${lastLines(result.stderr || result.stdout)}`, {
      hint: "Make sure the .app or .ipa is signed for this device's provisioning profile.",
    });
  }
}

export async function uninstallApp(deviceId: string, bundleId: string): Promise<void> {
  await run("xcrun", ["devicectl", "device", "uninstall", "app", "--device", deviceId, bundleId], {
    timeout: 120_000,
  });
}

export async function launchApp(deviceId: string, bundleId: string): Promise<void> {
  await run(
    "xcrun",
    [
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      deviceId,
      "--terminate-existing",
      bundleId,
    ],
    { timeout: 180_000 },
  );
}

export async function listApps(deviceId: string): Promise<AppInfo[]> {
  const file = tempJsonPath("apps");
  try {
    const result = await run(
      "xcrun",
      [
        "devicectl",
        "device",
        "info",
        "apps",
        "--device",
        deviceId,
        "--json-output",
        file,
        "--quiet",
      ],
      { timeout: 120_000, allowFailure: true },
    );
    if (result.code !== 0) return [];
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      result?: { apps?: Array<Record<string, unknown>> };
    };
    return (parsed.result?.apps ?? [])
      .filter((app) => app["appClip"] !== true)
      .filter((app) => (app["bundleIdentifier"] as string | undefined)?.length)
      .map((app) => ({
        bundleId: app["bundleIdentifier"] as string,
        name: (app["name"] as string) || undefined,
        version: (app["version"] as string) || undefined,
      }))
      .sort((a, b) => a.bundleId.localeCompare(b.bundleId));
  } catch {
    return [];
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

function tempJsonPath(kind: string): string {
  return join(tmpdir(), `nat-devicectl-${kind}-${process.pid}-${Date.now()}.json`);
}

function lastLines(text: string, count = 4): string {
  return text.trim().split("\n").slice(-count).join(" | ");
}
