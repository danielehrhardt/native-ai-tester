import { describe, expect, it } from "vitest";
import { directionToSwipe, parseDirection, parseNumber } from "../src/commands/shared.js";
import { NatError } from "../src/core/errors.js";
import { EXIT_CODES, exitCodeFor } from "../src/core/errors.js";

describe("directionToSwipe", () => {
  it("follows the finger, not the content — swiping up drags upward", () => {
    const up = directionToSwipe("up");
    expect(up.from.y).toBeGreaterThan(up.to.y);

    const down = directionToSwipe("down");
    expect(down.from.y).toBeLessThan(down.to.y);
  });

  it("moves horizontally for left and right, keeping y fixed", () => {
    const left = directionToSwipe("left");
    expect(left.from.x).toBeGreaterThan(left.to.x);
    expect(left.from.y).toBe(left.to.y);
  });

  it("stays inside the coordinate space at maximum distance", () => {
    for (const direction of ["up", "down", "left", "right"] as const) {
      const { from, to } = directionToSwipe(direction, 5);
      for (const point of [from, to]) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(1000);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1000);
      }
    }
  });

  it("scales with the requested distance", () => {
    const short = directionToSwipe("up", 0.2);
    const long = directionToSwipe("up", 0.8);
    expect(long.from.y - long.to.y).toBeGreaterThan(short.from.y - short.to.y);
  });
});

describe("argument parsing", () => {
  it("passes undefined through so optional flags stay optional", () => {
    expect(parseNumber(undefined, "--x")).toBeUndefined();
    expect(parseDirection(undefined)).toBeUndefined();
  });

  it("rejects a non-numeric flag value by name", () => {
    expect(() => parseNumber("abc", "--duration")).toThrow(/--duration must be a number/);
  });

  it("accepts the four directions and rejects anything else", () => {
    expect(parseDirection("UP")).toBe("up");
    expect(() => parseDirection("sideways")).toThrow(/up, down, left or right/);
  });
});

describe("exit codes", () => {
  it("are stable per error code, so scripts can branch on them", () => {
    expect(exitCodeFor(new NatError("NOT_CONNECTED", "x"))).toBe(EXIT_CODES.NOT_CONNECTED);
    expect(exitCodeFor(new NatError("ELEMENT_NOT_FOUND", "x"))).toBe(6);
    expect(exitCodeFor(new NatError("INVALID_ARGUMENT", "x"))).toBe(2);
  });

  it("fall back to 1 for anything unexpected", () => {
    expect(exitCodeFor(new Error("boom"))).toBe(1);
  });

  it("serialize the code, message and hint for --json", () => {
    const error = new NatError("NO_DEVICE", "nothing attached", { hint: "plug something in" });
    expect(error.toJSON()).toEqual({ code: "NO_DEVICE", message: "nothing attached", hint: "plug something in" });
  });
});
