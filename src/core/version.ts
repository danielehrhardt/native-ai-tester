/**
 * The installed version, read from the package manifest at runtime.
 *
 * Reading it rather than baking it in at build time means a globally-installed
 * copy always reports what is actually on disk, which is what the update check
 * compares against.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function version(): string {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/core/version.js → dist/core → dist → <package root>
  for (const candidate of [join(here, "..", "..", "package.json"), join(here, "..", "package.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "native-ai-tester" && parsed.version) {
        cached = parsed.version;
        return cached;
      }
    } catch {
      // Try the next candidate.
    }
  }
  cached = "0.0.0-dev";
  return cached;
}

/** Semver comparison limited to what the update check needs. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    const [core = "", pre] = value.split("-", 2);
    const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
    return { parts, pre };
  };
  const a = parse(candidate);
  const b = parse(current);

  for (let index = 0; index < 3; index += 1) {
    const left = a.parts[index] ?? 0;
    const right = b.parts[index] ?? 0;
    if (left !== right) return left > right;
  }
  // Same numbers: a release beats a prerelease, and a prerelease never beats a release.
  if (!a.pre && b.pre) return true;
  return false;
}
