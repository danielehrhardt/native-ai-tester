import { describe, expect, it } from "vitest";
import { isNewer, meetsMinimumNode, minimumNode, version } from "../src/core/version.js";

describe("isNewer", () => {
  it("compares each component numerically, not as text", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  });

  it("treats equal versions as not newer", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
  });

  it("does not offer a prerelease as an upgrade over the matching release", () => {
    expect(isNewer("1.2.3-beta.1", "1.2.3")).toBe(false);
    expect(isNewer("1.2.3", "1.2.3-beta.1")).toBe(true);
  });

  it("handles missing components", () => {
    expect(isNewer("2", "1.9.9")).toBe(true);
    expect(isNewer("1.2", "1.2.0")).toBe(false);
  });
});

describe("version", () => {
  it("reads the installed version from the package manifest", () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("the supported Node floor", () => {
  it("comes from package.json, so engines and the checks cannot drift apart", () => {
    const [major, minor] = minimumNode();
    expect(major).toBeGreaterThanOrEqual(20);
    expect(Number.isInteger(minor)).toBe(true);
  });

  it("accepts the version actually running these tests", () => {
    expect(meetsMinimumNode()).toBe(true);
  });

  it("compares minor and patch, not just the major", () => {
    const [major, minor, patch] = minimumNode();
    expect(meetsMinimumNode(`${major}.${minor}.${patch}`)).toBe(true);
    expect(meetsMinimumNode(`${major}.${minor - 1}.99`)).toBe(false);
    expect(meetsMinimumNode(`${major - 1}.99.99`)).toBe(false);
    expect(meetsMinimumNode(`${major + 1}.0.0`)).toBe(true);
  });
});
