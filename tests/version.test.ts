import { describe, expect, it } from "vitest";
import { isNewer, version } from "../src/core/version.js";

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
