/**
 * `nat devices` — discovery and the connect/disconnect lifecycle.
 */

import { Command } from "commander";
import { emit, info, table, color } from "../core/output.js";
import { readSession } from "../core/session.js";
import {
  attachDriver,
  connectDevice,
  disconnect,
  listDevices,
  simctl,
} from "../drivers/index.js";
import type { Device, Platform } from "../core/types.js";
import { NatError } from "../core/errors.js";

export function registerDeviceCommands(program: Command): void {
  const devices = program
    .command("devices")
    .description("list, connect to, and inspect iOS and Android devices")
    .argument("[platform]", "restrict to `ios` or `android`")
    .option("--physical", "hide simulators and emulators")
    .action(async (platform: string | undefined, options: { physical?: boolean }) => {
      await listCommand(platform, options);
    });

  devices
    .command("connect")
    .description("connect to a device — boots simulators and starts the iOS agent")
    .argument("[device-id]", "device id, id prefix, or name (defaults to the only ready device)")
    .action(async (deviceId: string | undefined) => {
      await connectCommand(deviceId);
    });

  devices
    .command("disconnect")
    .description("release the connected device and stop its agent")
    .action(async () => {
      await disconnectCommand();
    });

  devices
    .command("current")
    .description("show the connected device and whether it is still responding")
    .action(async () => {
      await currentCommand();
    });
}

async function listCommand(
  platformArg: string | undefined,
  options: { physical?: boolean },
): Promise<void> {
  const platform = normalizePlatform(platformArg);
  const found = await listDevices({
    ...(platform ? { platform } : {}),
    includeVirtual: !options.physical,
  });
  const session = await readSession();

  emit(
    { devices: found, connected: session?.deviceId ?? null },
    () => {
      if (found.length === 0) {
        return [
          "No devices found.",
          "",
          "  • iOS device — plug it in, unlock it, and tap Trust",
          "  • iOS simulator — open Xcode → Window → Devices and Simulators",
          "  • Android — enable USB debugging, then check `adb devices`",
          "",
          "`nat doctor` checks the toolchain end to end.",
        ].join("\n");
      }
      const rows = found.map((device) => [
        session?.deviceId === device.id ? color.green("▸") : " ",
        device.id,
        device.platform,
        device.kind,
        device.osVersion ?? "",
        device.name,
        statusOf(device),
      ]);
      return table(["", "ID", "OS", "KIND", "VERSION", "NAME", "STATUS"], rows);
    },
  );
}

function statusOf(device: Device): string {
  if (device.note) return device.note;
  return device.state;
}

async function connectCommand(deviceId: string | undefined): Promise<void> {
  const result = await connectDevice(deviceId);
  const { device } = result;

  emit(
    {
      connected: true,
      device,
      agent: result.session.driver ?? null,
    },
    () =>
      [
        `${color.green("Connected")} ${device.name} (${device.id})`,
        `  ${device.platform} ${device.osVersion ?? ""} · ${device.kind}`,
        "",
        "Next:",
        "  nat screen                                    read the current UI",
        "  nat action activate-app --bundle-id <id>      bring your app to the front",
      ].join("\n"),
  );
}

async function disconnectCommand(): Promise<void> {
  const session = await disconnect();
  if (!session) {
    emit({ disconnected: false }, "No device was connected.");
    return;
  }
  emit({ disconnected: true, device: session.deviceId }, `Disconnected ${session.name} (${session.deviceId}).`);
}

async function currentCommand(): Promise<void> {
  const session = await readSession();
  if (!session) {
    throw new NatError("NOT_CONNECTED", "No device is connected", {
      hint: "Run `nat devices` to list what is attached, then `nat devices connect <device-id>`.",
    });
  }

  const { driver } = await attachDriver();
  const alive = await driver.isAlive();
  const app = alive ? await driver.currentApp().catch(() => undefined) : undefined;

  emit(
    { ...session, alive, app: app ?? null },
    () =>
      [
        `${session.name} (${session.deviceId})`,
        `  platform   ${session.platform} ${session.osVersion ?? ""}`,
        `  kind       ${session.kind}`,
        `  connected  ${session.connectedAt}`,
        `  responding ${alive ? color.green("yes") : color.red("no — reconnect with `nat devices connect`")}`,
        ...(app ? [`  foreground ${app}`] : []),
      ].join("\n"),
  );
}

function normalizePlatform(value: string | undefined): Platform | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "ios" || normalized === "iphone" || normalized === "ipad") return "ios";
  if (normalized === "android") return "android";
  throw new NatError("INVALID_ARGUMENT", `Unknown platform \`${value}\` — expected \`ios\` or \`android\``);
}

export { simctl, info };
