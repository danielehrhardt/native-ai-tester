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
import type { DevicePoint, Driver, Point, ScreenSize, SwipeDirection } from "../core/types.js";

export interface TargetOptions {
  x?: number;
  y?: number;
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

  if (!options.description) {
    throw new NatError("INVALID_ARGUMENT", "No target given", {
      hint:
        "Point at an element one of two ways:\n" +
        "  --x 500 --y 320                       coordinates from `nat screen`\n" +
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
  if (!target.grounding) return at;
  const element = target.grounding.element;
  const name = element?.label ?? element?.value ?? element?.identifier;
  const via = target.grounding.method === "vision" ? " (vision)" : "";
  return name ? `${at} — ${element?.role} ${JSON.stringify(name)}${via}` : `${at}${via}`;
}
