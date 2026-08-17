/**
 * The connected-device session.
 *
 * `nat devices connect <id>` writes a small record to disk; every later command
 * in any terminal picks it up. That is what makes the inspect → act → verify
 * loop a sequence of one-shot commands instead of a long-lived REPL an agent
 * would have to babysit.
 */

import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "./paths.js";
import { NatError } from "./errors.js";
import type { Device, Platform } from "./types.js";

export interface SessionRecord {
  deviceId: string;
  platform: Platform;
  name: string;
  kind: Device["kind"];
  osVersion?: string;
  model?: string;
  connectedAt: string;
  /** Driver-specific scratch data (WDA port + session id, adb transport, …). */
  driver?: Record<string, unknown>;
}

export async function readSession(): Promise<SessionRecord | undefined> {
  try {
    const raw = await readFile(paths.sessionFile(), "utf8");
    const parsed = JSON.parse(raw) as SessionRecord;
    return parsed.deviceId ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function requireSession(): Promise<SessionRecord> {
  const session = await readSession();
  if (!session) {
    throw new NatError("NOT_CONNECTED", "No device is connected", {
      hint: "Run `nat devices` to list what is attached, then `nat devices connect <device-id>`.",
    });
  }
  return session;
}

export async function writeSession(record: SessionRecord): Promise<void> {
  const file = paths.sessionFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function patchSession(patch: Partial<SessionRecord>): Promise<SessionRecord | undefined> {
  const current = await readSession();
  if (!current) return undefined;
  const next: SessionRecord = { ...current, ...patch, driver: { ...current.driver, ...patch.driver } };
  await writeSession(next);
  return next;
}

export async function clearSession(): Promise<void> {
  await rm(paths.sessionFile(), { force: true });
}

export function sessionFromDevice(device: Device): SessionRecord {
  return {
    deviceId: device.id,
    platform: device.platform,
    name: device.name,
    kind: device.kind,
    osVersion: device.osVersion,
    model: device.model,
    connectedAt: new Date().toISOString(),
  };
}
