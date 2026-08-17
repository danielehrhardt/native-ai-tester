/**
 * Conversion between the public relative 0–1000 space and native device points.
 *
 * Kept in one place so the rounding rules are identical on every code path —
 * a half-pixel disagreement between "where the tree said the button is" and
 * "where the tap landed" is exactly the class of flake this tool exists to
 * avoid.
 */

import { RELATIVE_SPACE, type DevicePoint, type Point, type Rect, type ScreenSize } from "./types.js";
import { NatError } from "./errors.js";

export function toDevicePoint(point: Point, screen: ScreenSize): DevicePoint {
  return {
    x: Math.round((clampRelative(point.x, "x") / RELATIVE_SPACE) * screen.width),
    y: Math.round((clampRelative(point.y, "y") / RELATIVE_SPACE) * screen.height),
  };
}

export function toRelativePoint(point: DevicePoint, screen: ScreenSize): Point {
  return {
    x: round1((point.x / screen.width) * RELATIVE_SPACE),
    y: round1((point.y / screen.height) * RELATIVE_SPACE),
  };
}

export function toRelativeRect(
  rect: { x: number; y: number; width: number; height: number },
  screen: ScreenSize,
): Rect {
  return {
    x: round1((rect.x / screen.width) * RELATIVE_SPACE),
    y: round1((rect.y / screen.height) * RELATIVE_SPACE),
    width: round1((rect.width / screen.width) * RELATIVE_SPACE),
    height: round1((rect.height / screen.height) * RELATIVE_SPACE),
  };
}

export function centerOf(rect: Rect): Point {
  return {
    x: round1(rect.x + rect.width / 2),
    y: round1(rect.y + rect.height / 2),
  };
}

/**
 * Accepts a coordinate the user typed. Values are relative (0–1000); we reject
 * anything outside so a stray pixel coordinate (`--x 640`) on a small screen
 * fails loudly at the edge instead of tapping the wrong thing silently.
 */
export function clampRelative(value: number, axis: "x" | "y"): number {
  if (!Number.isFinite(value)) {
    throw new NatError("INVALID_ARGUMENT", `--${axis} must be a number`);
  }
  if (value < 0 || value > RELATIVE_SPACE) {
    throw new NatError(
      "INVALID_ARGUMENT",
      `--${axis} must be between 0 and ${RELATIVE_SPACE} (relative coordinates), got ${value}`,
      {
        hint: "Coordinates are resolution-independent: 0 is the left/top edge, 1000 the right/bottom edge. `nat screen` already reports them in this space.",
      },
    );
  }
  return value;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Area of a rect in the relative space; used to rank grounding candidates. */
export function areaOf(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function rectContains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}
