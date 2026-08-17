/**
 * `nat action …` — the "act" half of the loop.
 *
 * Every gesture is one command, one process, one result line. That shape is
 * deliberate: an agent takes a single step, reads the screen, and decides the
 * next one, rather than trying to script a whole flow blind.
 */

import { Command } from "commander";
import { emit, color } from "../core/output.js";
import { NatError } from "../core/errors.js";
import { toDevicePoint } from "../core/coords.js";
import { attachDriverEnsuringAgent } from "../drivers/index.js";
import type { AlertAction, Driver } from "../core/types.js";
import {
  describeTarget,
  directionToSwipe,
  parseDirection,
  parseNumber,
  resolveTarget,
  type TargetOptions,
} from "./shared.js";

interface CommonTargetFlags {
  x?: string;
  y?: string;
  mark?: string;
  description?: string;
  index?: string;
  role?: string;
  treeOnly?: boolean;
}

function targetOptions(flags: CommonTargetFlags): TargetOptions {
  return {
    ...(flags.x !== undefined ? { x: parseNumber(flags.x, "--x")! } : {}),
    ...(flags.y !== undefined ? { y: parseNumber(flags.y, "--y")! } : {}),
    ...(flags.mark !== undefined ? { mark: parseNumber(flags.mark, "--mark")! } : {}),
    ...(flags.description ? { description: flags.description } : {}),
    ...(flags.index !== undefined ? { index: parseNumber(flags.index, "--index")! } : {}),
    ...(flags.role ? { role: flags.role } : {}),
    ...(flags.treeOnly ? { treeOnly: true } : {}),
  };
}

/** Attach the target flags shared by tap/input/swipe/drag. */
function withTargetFlags(command: Command): Command {
  return command
    .option("--x <n>", "horizontal position, 0–1000 (from `nat screen`)")
    .option("--y <n>", "vertical position, 0–1000")
    .option("-m, --mark <n>", "the number drawn on `nat screenshot --marks`")
    .option("-d, --description <text>", "target by plain-language description instead")
    .option("--index <n>", "pick the Nth match when a description is ambiguous (1-based)")
    .option("--role <role>", "only consider elements of this role (button, field, cell, …)")
    .option("--tree-only", "never call a vision model, even if one is configured");
}

export function registerActionCommands(program: Command): void {
  const action = program.command("action").description("drive the device — one gesture per command");

  // ------------------------------------------------------------------ tap
  withTargetFlags(action.command("tap").description("tap, double-tap, or long-press an element"))
    .option("--double", "double tap")
    .option("--duration <seconds>", "hold this long — turns the tap into a long press")
    .action(async (flags: CommonTargetFlags & { double?: boolean; duration?: string }) => {
      const { driver } = await attachDriverEnsuringAgent();
      const target = await resolveTarget(driver, targetOptions(flags));
      const duration = parseNumber(flags.duration, "--duration");

      await driver.tap(target.point, {
        ...(duration ? { duration } : {}),
        ...(flags.double ? { double: true } : {}),
      });

      const verb = duration ? `long-pressed ${duration}s` : flags.double ? "double-tapped" : "tapped";
      emit(
        {
          ok: true,
          action: "tap",
          point: target.relative,
          ...(duration ? { duration } : {}),
          ...(flags.double ? { double: true } : {}),
          ...(target.grounding
            ? { grounding: { method: target.grounding.method, confidence: target.grounding.confidence } }
            : {}),
        },
        `${color.green(verb)} ${describeTarget(target)}`,
      );
    });

  // ---------------------------------------------------------------- swipe
  withTargetFlags(action.command("swipe").description("swipe between two points, or in a direction"))
    .option("--x1 <n>", "start x, 0–1000")
    .option("--y1 <n>", "start y, 0–1000")
    .option("--x2 <n>", "end x, 0–1000")
    .option("--y2 <n>", "end y, 0–1000")
    .option("--direction <dir>", "up, down, left or right — swipes across the middle of the screen")
    .option("--distance <fraction>", "how far a directional swipe travels, 0–0.9 (default 0.6)")
    .option("--duration <seconds>", "gesture duration (default 0.35)")
    .action(async (flags: SwipeFlags) => {
      const { driver } = await attachDriverEnsuringAgent();
      await performSwipeOrDrag(driver, flags, "swipe");
    });

  // ----------------------------------------------------------------- drag
  withTargetFlags(action.command("drag").description("press, hold, and drag — for drop targets and reordering"))
    .option("--x1 <n>", "start x, 0–1000")
    .option("--y1 <n>", "start y, 0–1000")
    .option("--x2 <n>", "end x, 0–1000")
    .option("--y2 <n>", "end y, 0–1000")
    .option("--direction <dir>", "up, down, left or right")
    .option("--distance <fraction>", "how far a directional drag travels, 0–0.9 (default 0.6)")
    .option("--duration <seconds>", "gesture duration (default 1)")
    .action(async (flags: SwipeFlags) => {
      const { driver } = await attachDriverEnsuringAgent();
      await performSwipeOrDrag(driver, flags, "drag");
    });

  // ---------------------------------------------------------------- input
  withTargetFlags(action.command("input").description("tap a field and type into it"))
    .requiredOption("--text <text>", "the text to type")
    .option("--clear", "clear the field before typing")
    .option("--submit", "press enter afterwards")
    .option("--no-tap", "type into the already-focused field without tapping first")
    .action(async (flags: CommonTargetFlags & { text: string; clear?: boolean; submit?: boolean; tap?: boolean }) => {
      const { driver } = await attachDriverEnsuringAgent();
      const shouldTap = flags.tap !== false;

      let where = "the focused field";
      let clearLength: number | undefined;
      if (shouldTap) {
        const target = await resolveTarget(driver, targetOptions(flags));
        await driver.tap(target.point);
        where = describeTarget(target);
        // We know exactly what we tapped, so we know exactly how much to clear.
        clearLength = (target.element ?? target.grounding?.element)?.value?.length;
      }

      await driver.typeText(flags.text, {
        ...(flags.clear ? { clear: true } : {}),
        ...(clearLength !== undefined ? { clearLength } : {}),
        ...(flags.submit ? { submit: true } : {}),
      });

      emit(
        { ok: true, action: "input", text: flags.text, target: where },
        `${color.green("typed")} ${JSON.stringify(flags.text)} into ${where}`,
      );
    });

  // ------------------------------------------------------------------ key
  action
    .command("key")
    .description("press a hardware or keyboard key")
    .argument("<key>", "home, back, enter, tab, escape, volumeup, … (Android also accepts KEYCODE_*)")
    .action(async (key: string) => {
      const { driver } = await attachDriverEnsuringAgent();
      await driver.pressKey(key);
      emit({ ok: true, action: "key", key }, `${color.green("pressed")} ${key}`);
    });

  // ---------------------------------------------------------- app control
  action
    .command("activate-app")
    .description("bring an app to the foreground, launching it if needed")
    .requiredOption("--bundle-id <id>", "iOS bundle id or Android package name")
    .action(async (flags: { bundleId: string }) => {
      const { driver } = await attachDriverEnsuringAgent();
      await driver.activateApp(flags.bundleId);
      emit({ ok: true, action: "activate-app", app: flags.bundleId }, `${color.green("activated")} ${flags.bundleId}`);
    });

  action
    .command("terminate-app")
    .description("force-quit an app")
    .requiredOption("--bundle-id <id>", "iOS bundle id or Android package name")
    .action(async (flags: { bundleId: string }) => {
      const { driver } = await attachDriverEnsuringAgent();
      await driver.terminateApp(flags.bundleId);
      emit({ ok: true, action: "terminate-app", app: flags.bundleId }, `${color.green("terminated")} ${flags.bundleId}`);
    });

  action
    .command("restart-app")
    .description("terminate and relaunch an app — the reliable way back to a known state")
    .requiredOption("--bundle-id <id>", "iOS bundle id or Android package name")
    .action(async (flags: { bundleId: string }) => {
      const { driver } = await attachDriverEnsuringAgent();
      await driver.terminateApp(flags.bundleId);
      await driver.activateApp(flags.bundleId);
      emit({ ok: true, action: "restart-app", app: flags.bundleId }, `${color.green("restarted")} ${flags.bundleId}`);
    });

  action
    .command("background-app")
    .description("send the foreground app to the background")
    .action(async () => {
      const { driver } = await attachDriverEnsuringAgent();
      await driver.backgroundApp();
      emit({ ok: true, action: "background-app" }, `${color.green("backgrounded")} the foreground app`);
    });

  action
    .command("open-url")
    .description("open a URL or deep link")
    .requiredOption("--url <url>", "the URL to open")
    .action(async (flags: { url: string }) => {
      const { driver } = await attachDriverEnsuringAgent();
      await driver.openUrl(flags.url);
      emit({ ok: true, action: "open-url", url: flags.url }, `${color.green("opened")} ${flags.url}`);
    });

  // ---------------------------------------------------------------- alert
  action
    .command("alert")
    .description("accept or dismiss a system alert (permissions, sign-in prompts, …)")
    .requiredOption("--action <action>", "accept or dismiss")
    .action(async (flags: { action: string }) => {
      const { driver } = await attachDriverEnsuringAgent();
      const choice = flags.action.toLowerCase();
      if (choice !== "accept" && choice !== "dismiss") {
        throw new NatError("INVALID_ARGUMENT", `--action must be accept or dismiss (got \`${flags.action}\`)`);
      }
      const text = await driver.alertText().catch(() => undefined);
      await driver.handleAlert(choice as AlertAction);
      emit(
        { ok: true, action: "alert", choice, alertText: text ?? null },
        `${color.green(choice === "accept" ? "accepted" : "dismissed")} the alert${text ? `: ${JSON.stringify(truncate(text))}` : ""}`,
      );
    });
}

interface SwipeFlags extends CommonTargetFlags {
  x1?: string;
  y1?: string;
  x2?: string;
  y2?: string;
  direction?: string;
  distance?: string;
  duration?: string;
}

async function performSwipeOrDrag(driver: Driver, flags: SwipeFlags, kind: "swipe" | "drag"): Promise<void> {
  const screen = await driver.screenSize();
  const duration = parseNumber(flags.duration, "--duration");
  const direction = parseDirection(flags.direction);

  const explicit =
    flags.x1 !== undefined || flags.y1 !== undefined || flags.x2 !== undefined || flags.y2 !== undefined;

  let from;
  let to;
  let label: string;

  if (explicit) {
    if (flags.x1 === undefined || flags.y1 === undefined || flags.x2 === undefined || flags.y2 === undefined) {
      throw new NatError("INVALID_ARGUMENT", "--x1, --y1, --x2 and --y2 must all be given together");
    }
    from = { x: parseNumber(flags.x1, "--x1")!, y: parseNumber(flags.y1, "--y1")! };
    to = { x: parseNumber(flags.x2, "--x2")!, y: parseNumber(flags.y2, "--y2")! };
    label = `${from.x},${from.y} → ${to.x},${to.y}`;
  } else if (direction) {
    const distance = parseNumber(flags.distance, "--distance") ?? 0.6;
    ({ from, to } = directionToSwipe(direction, distance));
    label = `${direction} (${from.x},${from.y} → ${to.x},${to.y})`;
  } else if (flags.description || flags.mark !== undefined) {
    // A described or marked swipe centres the gesture on that element — which
    // is what "swipe the photo carousel left" means.
    const target = await resolveTarget(driver, targetOptions(flags));
    const inferred = direction ?? inferDirectionFrom(flags.description ?? "");
    const box = (target.element ?? target.grounding?.element)?.rect;
    const span = box ? Math.max(120, Math.min(box.width, box.height) * 0.8) : 300;
    ({ from, to } = swipeAround(target.relative, inferred, span));
    label = `${describeTarget(target)} ${inferred}`;
  } else {
    throw new NatError("INVALID_ARGUMENT", `No ${kind} given`, {
      hint:
        "Choose one:\n" +
        "  --x1 500 --y1 800 --x2 500 --y2 200    explicit points\n" +
        "  --direction up                          across the middle of the screen\n" +
        `  -d "photo carousel, swipe left"         centred on a described element`,
    });
  }

  const fromPoint = toDevicePoint(from, screen);
  const toPoint = toDevicePoint(to, screen);
  const options = duration ? { duration } : {};

  if (kind === "swipe") await driver.swipe(fromPoint, toPoint, options);
  else await driver.drag(fromPoint, toPoint, options);

  emit(
    { ok: true, action: kind, from, to, ...(duration ? { duration } : {}) },
    `${color.green(kind === "swipe" ? "swiped" : "dragged")} ${label}`,
  );
}

/** "swipe left", "scroll down" — read the direction out of the phrase itself. */
function inferDirectionFrom(description: string): "up" | "down" | "left" | "right" {
  const text = description.toLowerCase();
  if (/\b(left)\b/.test(text)) return "left";
  if (/\b(right)\b/.test(text)) return "right";
  if (/\b(down|downwards?)\b/.test(text)) return "down";
  return "up";
}

function swipeAround(
  center: { x: number; y: number },
  direction: "up" | "down" | "left" | "right",
  span: number,
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const half = span / 2;
  const clamp = (value: number) => Math.min(995, Math.max(5, Math.round(value * 10) / 10));
  switch (direction) {
    case "up":
      return { from: { x: center.x, y: clamp(center.y + half) }, to: { x: center.x, y: clamp(center.y - half) } };
    case "down":
      return { from: { x: center.x, y: clamp(center.y - half) }, to: { x: center.x, y: clamp(center.y + half) } };
    case "left":
      return { from: { x: clamp(center.x + half), y: center.y }, to: { x: clamp(center.x - half), y: center.y } };
    case "right":
      return { from: { x: clamp(center.x - half), y: center.y }, to: { x: clamp(center.x + half), y: center.y } };
  }
}

function truncate(value: string, max = 120): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
