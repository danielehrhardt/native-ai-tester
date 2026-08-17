import { describe, expect, it } from "vitest";
import { clampRelative, centerOf, toDevicePoint, toRelativePoint, toRelativeRect } from "../src/core/coords.js";
import { NatError } from "../src/core/errors.js";
import { SCREEN } from "./helpers.js";

describe("relative ↔ device coordinates", () => {
  it("maps the corners of the space onto the corners of the screen", () => {
    expect(toDevicePoint({ x: 0, y: 0 }, SCREEN)).toEqual({ x: 0, y: 0 });
    expect(toDevicePoint({ x: 1000, y: 1000 }, SCREEN)).toEqual({ x: 393, y: 852 });
  });

  it("maps the centre to the centre", () => {
    expect(toDevicePoint({ x: 500, y: 500 }, SCREEN)).toEqual({ x: 197, y: 426 });
  });

  it("round-trips within a pixel", () => {
    const original = { x: 500, y: 320 };
    const back = toRelativePoint(toDevicePoint(original, SCREEN), SCREEN);
    expect(Math.abs(back.x - original.x)).toBeLessThan(2);
    expect(Math.abs(back.y - original.y)).toBeLessThan(2);
  });

  it("is resolution-independent — the same relative point lands proportionally on any device", () => {
    const tablet = { width: 1024, height: 1366 };
    const phone = { width: 393, height: 852 };
    const point = { x: 250, y: 750 };

    const onTablet = toDevicePoint(point, tablet);
    const onPhone = toDevicePoint(point, phone);

    expect(onTablet.x / tablet.width).toBeCloseTo(onPhone.x / phone.width, 2);
    expect(onTablet.y / tablet.height).toBeCloseTo(onPhone.y / phone.height, 2);
  });

  it("converts a native rect into the relative space", () => {
    const rect = toRelativeRect({ x: 0, y: 426, width: 393, height: 213 }, SCREEN);
    expect(rect.x).toBe(0);
    expect(rect.width).toBe(1000);
    expect(rect.y).toBeCloseTo(500, 0);
    expect(rect.height).toBeCloseTo(250, 0);
  });

  it("puts the centre of a rect in its middle", () => {
    expect(centerOf({ x: 100, y: 200, width: 400, height: 100 })).toEqual({ x: 300, y: 250 });
  });
});

describe("clampRelative", () => {
  it("accepts the full 0–1000 range", () => {
    expect(clampRelative(0, "x")).toBe(0);
    expect(clampRelative(1000, "y")).toBe(1000);
  });

  it("rejects a pixel coordinate that strayed in, rather than tapping the wrong place", () => {
    // 1290 is a plausible pixel width — catching it here beats a silent mis-tap.
    expect(() => clampRelative(1290, "x")).toThrow(NatError);
    expect(() => clampRelative(-1, "y")).toThrow(/between 0 and 1000/);
  });

  it("rejects non-numbers", () => {
    expect(() => clampRelative(Number.NaN, "x")).toThrow(/must be a number/);
  });
});
