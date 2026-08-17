/**
 * Device discovery and driver construction.
 *
 * `connect` does the expensive, stateful work once (boot the simulator, build
 * and start WebDriverAgent, open the usbmux tunnel) and records what it
 * produced. `attach` is the hot path every other command takes: read the
 * session, rebuild a driver object, make one HTTP call.
 */

import { NatError } from "../core/errors.js";
import { loadConfig, type NatConfig } from "../core/config.js";
import { debug, info } from "../core/output.js";
import {
  clearSession,
  patchSession,
  readSession,
  requireSession,
  sessionFromDevice,
  writeSession,
  type SessionRecord,
} from "../core/session.js";
import type { Device, Driver, Platform } from "../core/types.js";
import { IosDriver, type IosDriverState } from "./ios/ios-driver.js";
import * as simctl from "./ios/simctl.js";
import * as devicectl from "./ios/devicectl.js";
import * as wda from "./ios/wda-manager.js";
import { AndroidDriver } from "./android/android-driver.js";
import * as adb from "./android/adb.js";

export interface ListOptions {
  platform?: Platform;
  /** Include simulators/emulators alongside physical hardware. */
  includeVirtual?: boolean;
}

export async function listDevices(options: ListOptions = {}): Promise<Device[]> {
  const config = await loadConfig();
  if (config.android?.adbPath) adb.setAdbPath(config.android.adbPath);

  const wantIos = !options.platform || options.platform === "ios";
  const wantAndroid = !options.platform || options.platform === "android";
  const includeVirtual = options.includeVirtual !== false;

  const [iosDevices, iosSimulators, androidDevices] = await Promise.all([
    wantIos && process.platform === "darwin" ? devicectl.listDevices().catch(() => []) : Promise.resolve([]),
    wantIos && includeVirtual && process.platform === "darwin"
      ? simctl.listSimulators().catch(() => [])
      : Promise.resolve([]),
    wantAndroid ? adb.listDevices().catch(() => []) : Promise.resolve([]),
  ]);

  const android = includeVirtual ? androidDevices : androidDevices.filter((d) => d.kind !== "emulator");

  return [...iosDevices, ...iosSimulators, ...android].sort(rankDevices);
}

/** Physical, ready hardware first — that is what a developer most often means. */
function rankDevices(a: Device, b: Device): number {
  const score = (device: Device) =>
    (device.ready ? 0 : 100) + (device.kind === "device" ? 0 : 10) + (device.state === "booted" ? -1 : 0);
  const diff = score(a) - score(b);
  return diff !== 0 ? diff : a.name.localeCompare(b.name);
}

/**
 * Resolve a user-supplied identifier: exact id, unique id prefix, or device
 * name. Ambiguity is an error rather than a guess — silently driving the wrong
 * phone is worse than asking.
 */
export async function resolveDevice(query: string | undefined, options: ListOptions = {}): Promise<Device> {
  const devices = await listDevices(options);
  if (devices.length === 0) {
    throw new NatError("NO_DEVICE", "No iOS or Android devices found", {
      hint:
        "Connect a phone by cable and unlock it, or start a simulator/emulator.\n" +
        "`nat doctor` checks the toolchain end to end.",
    });
  }

  if (!query) {
    const config = await loadConfig();
    if (config.defaultDevice) return resolveDevice(config.defaultDevice, options);
    const ready = devices.filter((device) => device.ready);
    if (ready.length === 1) return ready[0]!;
    throw new NatError("DEVICE_NOT_FOUND", "More than one device is available — say which one", {
      hint: `Run \`nat devices\` and pass an id:\n${devices.map((d) => `  ${d.id}  ${d.name}`).join("\n")}`,
    });
  }

  const exact = devices.filter((device) => device.id === query);
  if (exact.length === 1) return exact[0]!;

  const lowered = query.toLowerCase();
  const matches = devices.filter(
    (device) =>
      device.id.toLowerCase().startsWith(lowered) ||
      device.name.toLowerCase() === lowered ||
      device.name.toLowerCase().includes(lowered),
  );

  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new NatError("DEVICE_NOT_FOUND", `No device matches \`${query}\``, {
      hint: `Available:\n${devices.map((d) => `  ${d.id}  ${d.name}`).join("\n")}`,
    });
  }
  throw new NatError("AMBIGUOUS_TARGET", `\`${query}\` matches ${matches.length} devices`, {
    hint: `Be more specific:\n${matches.map((d) => `  ${d.id}  ${d.name}`).join("\n")}`,
  });
}

export interface ConnectResult {
  device: Device;
  driver: Driver;
  session: SessionRecord;
  /** Set when a fresh WebDriverAgent build had to run. */
  startedAgent?: boolean;
}

export async function connectDevice(query: string | undefined): Promise<ConnectResult> {
  const config = await loadConfig();
  const device = await resolveDevice(query);

  if (!device.ready && device.platform === "ios" && device.kind === "device") {
    throw new NatError("DEVICE_NOT_READY", `${device.name} is not ready: ${device.note ?? "unavailable"}`, {
      hint: "Plug the phone in, unlock it, and make sure it is trusted in Finder.",
    });
  }

  const session = sessionFromDevice(device);

  if (device.platform === "android") {
    const driver = new AndroidDriver(device);
    await driver.connect();
    await writeSession(session);
    return { device, driver, session };
  }

  const state = await startIosAgent(device, config);
  session.driver = state as unknown as Record<string, unknown>;
  const driver = new IosDriver(device, state);
  await driver.connect();
  await writeSession(session);
  return { device, driver, session, startedAgent: true };
}

async function startIosAgent(device: Device, config: NatConfig): Promise<IosDriverState> {
  if (process.platform !== "darwin") {
    throw new NatError("UNSUPPORTED", "iOS testing requires macOS with Xcode", {
      hint: "Android testing works on Linux and Windows — pass `--platform android`.",
    });
  }

  if (device.kind === "simulator") {
    await simctl.boot(device.id);
    await simctl.openSimulatorApp();
  }

  let coreDeviceId: string | undefined;
  if (device.kind === "device") {
    const found = await devicectl.findDevice(device.id);
    coreDeviceId = found?.handle.coreDeviceId;
  }

  const handle = await wda.start({
    udid: device.id,
    kind: device.kind === "simulator" ? "simulator" : "device",
    port: config.ios?.wdaPort ?? 8100,
    teamId: config.ios?.teamId,
    bundleId: config.ios?.wdaBundleId,
    wdaVersion: config.ios?.wdaVersion ?? "v16.2.1",
  });

  if (handle.reused) debug("ios: reusing the running WebDriverAgent");
  else info(`WebDriverAgent ready at ${handle.url}`);

  return {
    wdaUrl: handle.url,
    ...(handle.pid ? { wdaPid: handle.pid } : {}),
    ...(handle.tunnelPid ? { tunnelPid: handle.tunnelPid } : {}),
    ...(coreDeviceId ? { coreDeviceId } : {}),
  };
}

/** Rebuild a driver for the already-connected device. The hot path. */
export async function attachDriver(): Promise<{ driver: Driver; session: SessionRecord }> {
  const session = await requireSession();
  const config = await loadConfig();
  if (config.android?.adbPath) adb.setAdbPath(config.android.adbPath);

  const device: Device = {
    id: session.deviceId,
    name: session.name,
    platform: session.platform,
    kind: session.kind,
    state: session.platform === "ios" && session.kind === "simulator" ? "booted" : "connected",
    osVersion: session.osVersion,
    model: session.model,
    ready: true,
  };

  if (session.platform === "android") {
    return { driver: new AndroidDriver(device), session };
  }

  const state = session.driver as unknown as IosDriverState | undefined;
  if (!state?.wdaUrl) {
    throw new NatError("NOT_CONNECTED", "The iOS session is missing its WebDriverAgent address", {
      hint: `Reconnect: \`nat devices connect ${session.deviceId}\``,
    });
  }
  return { driver: new IosDriver(device, state), session };
}

/**
 * Attach, and if the agent has died since `connect`, restart it once.
 *
 * WebDriverAgent is killed by device reboots, Xcode running its own tests, and
 * long idle periods. Re-establishing it automatically is the difference between
 * an agent's test run continuing and it stopping to ask a human for help.
 */
export async function attachDriverEnsuringAgent(): Promise<{ driver: Driver; session: SessionRecord }> {
  const attached = await attachDriver();
  if (await attached.driver.isAlive()) return attached;
  if (attached.session.platform !== "ios") {
    throw new NatError("DEVICE_NOT_READY", `${attached.session.name} is no longer reachable`, {
      hint: "Check the cable and `adb devices`, then reconnect.",
    });
  }

  info("WebDriverAgent is not responding — restarting it …");
  const config = await loadConfig();
  const device: Device = {
    id: attached.session.deviceId,
    name: attached.session.name,
    platform: "ios",
    kind: attached.session.kind,
    state: "connected",
    osVersion: attached.session.osVersion,
    model: attached.session.model,
    ready: true,
  };
  const state = await startIosAgent(device, config);
  await patchSession({ driver: state as unknown as Record<string, unknown> });
  const driver = new IosDriver(device, state);
  await driver.connect();
  return { driver, session: (await readSession())! };
}

export async function disconnect(): Promise<SessionRecord | undefined> {
  const session = await readSession();
  if (!session) return undefined;

  if (session.platform === "ios") {
    const state = session.driver as unknown as IosDriverState | undefined;
    wda.stop({ pid: state?.wdaPid, tunnelPid: state?.tunnelPid });
  }
  await clearSession();
  return session;
}

export { wda, simctl, devicectl, adb };
