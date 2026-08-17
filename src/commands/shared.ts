/**
 * Helpers shared by the action commands.
 *
 * The central idea: every gesture names its target in one of two ways —
 * coordinates read out of `nat screen`, or a plain-language description. The
 * first is free and exact; the second costs a resolution step. Both end up as
 * the same device point here, so the drivers never learn about either.
 */

import { NatError } from "../core/errors.js";
import { toDevicePoint } from "../core/coords.js";
import { ground, type GroundingResult } from "../core/grounding.js";
import { readScreen } from "../core/screen.js";
import { debug } from "../core/output.js";
import { markedElements } from "../core/annotate.js";
import type { DevicePoint, Driver, Point, ScreenSize, SwipeDirection, UiElement } from "../core/types.js";

export interface TargetOptions {
  x?: number;
  y?: number;
  /** The number drawn on a marked screenshot. */
  mark?: number;
  description?: string;
  index?: number;
  role?: string;
  treeOnly?: boolean;
}

export interface ResolvedTarget {
  point: DevicePoint;
  relative: Point;
  screen: ScreenSize;
  grounding?: GroundingResult;
  /** Set when the target came from `--mark`. */
  element?: UiElement;
}

export async function resolveTarget(driver: Driver, options: TargetOptions): Promise<ResolvedTarget> {
  const screen = await driver.screenSize();

  if (options.x !== undefined || options.y !== undefined) {
    if (options.x === undefined || options.y === undefined) {
      throw new NatError("INVALID_ARGUMENT", "--x and --y must be given together");
    }
    if (options.description) {
      throw new NatError("INVALID_ARGUMENT", "Pass either coordinates or a description, not both", {
        hint: "Coordinates are exact and free; a description costs a resolution step.",
      });
    }
    const relative: Point = { x: options.x, y: options.y };
    return { point: toDevicePoint(relative, screen), relative, screen };
  }

  if (options.mark !== undefined) {
    return await resolveMark(driver, options.mark, screen);
  }

  if (!options.description) {
    throw new NatError("INVALID_ARGUMENT", "No target given", {
      hint:
        "Point at an element one of three ways:\n" +
        "  --x 500 --y 320                       coordinates from `nat screen`\n" +
        "  --mark 12                             the number drawn on `nat screenshot --marks`\n" +
        '  -d "Blue login button at the bottom"   a plain-language description',
    });
  }

  const snapshot = await readScreen(driver, { withApp: false });
  const result = await ground(snapshot, options.description, {
    ...(options.index !== undefined ? { index: options.index } : {}),
    ...(options.role ? { role: options.role } : {}),
    ...(options.treeOnly ? { treeOnly: true } : {}),
    screenshot: () => driver.screenshot(),
  });

  debug(`target: "${options.description}" → ${result.point.x},${result.point.y} via ${result.method}`);
  return {
    point: toDevicePoint(result.point, screen),
    relative: result.point,
    screen,
    grounding: result,
  };
}

/**
 * Resolve a number from a marked screenshot back to a point.
 *
 * The screen is re-read rather than cached, because between taking the picture
 * and acting on it the UI may have moved. Re-reading costs one round trip and
 * removes a whole class of "it tapped the wrong row" failures.
 */
async function resolveMark(driver: Driver, mark: number, screen: ScreenSize): Promise<ResolvedTarget> {
  const snapshot = await readScreen(driver, { withApp: false });
  const match = markedElements(snapshot.elements).find((node) => node.mark === mark);

  if (!match) {
    const available = markedElements(snapshot.elements);
    throw new NatError("ELEMENT_NOT_FOUND", `No element is marked ${mark} on the current screen`, {
      hint:
        available.length === 0
          ? "Nothing on this screen is markable. Target it by coordinates from `nat screen`, or by description."
          : `Marks run 1–${available.length} right now. The screen may have changed since the screenshot — take a fresh one with \`nat screenshot --marks\`.`,
    });
  }

  debug(`target: mark ${mark} → ${match.role} ${JSON.stringify(match.label ?? "")} @${match.center.x},${match.center.y}`);
  return {
    point: toDevicePoint(match.center, screen),
    relative: match.center,
    screen,
    element: match,
  };
}

/**
 * Turn a direction into a swipe across the middle of the screen.
 *
 * Note the inversion: swiping *up* means dragging the finger upward, which
 * scrolls the content down. The names follow the finger, matching how a person
 * would describe the gesture.
 */
export function directionToSwipe(direction: SwipeDirection, distance = 0.6): { from: Point; to: Point } {
  const span = Math.min(0.9, Math.max(0.1, distance)) * 1000;
  const center = 500;
  const half = span / 2;

  switch (direction) {
    case "up":
      return { from: { x: center, y: center + half }, to: { x: center, y: center - half } };
    case "down":
      return { from: { x: center, y: center - half }, to: { x: center, y: center + half } };
    case "left":
      return { from: { x: center + half, y: center }, to: { x: center - half, y: center } };
    case "right":
      return { from: { x: center - half, y: center }, to: { x: center + half, y: center } };
  }
}

export function parseNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new NatError("INVALID_ARGUMENT", `${flag} must be a number, got \`${value}\``);
  }
  return parsed;
}

export function parseDirection(value: string | undefined): SwipeDirection | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "up" || normalized === "down" || normalized === "left" || normalized === "right") {
    return normalized;
  }
  throw new NatError("INVALID_ARGUMENT", `--direction must be up, down, left or right (got \`${value}\`)`);
}

/** Describe what an action did, for the human-readable one-liner. */
export function describeTarget(target: ResolvedTarget): string {
  const at = `@${target.relative.x},${target.relative.y}`;
  if (target.element) {
    const name = target.element.label ?? target.element.value ?? target.element.identifier;
    return name ? `${at} — ${target.element.role} ${JSON.stringify(name)}` : at;
  }
  if (!target.grounding) return at;
  const element = target.grounding.element;
  const name = element?.label ?? element?.value ?? element?.identifier;
  const via = target.grounding.method === "vision" ? " (vision)" : "";
  return name ? `${at} — ${element?.role} ${JSON.stringify(name)}${via}` : `${at}${via}`;
}
