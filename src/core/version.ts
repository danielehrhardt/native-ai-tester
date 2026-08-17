/**
 * Facts about this installation, read from the package manifest at runtime.
 *
 * Reading rather than baking in at build time means a globally-installed copy
 * always reports what is actually on disk — which is what the update check
 * compares against, and what `nat doctor` reports.
 *
 * The manifest is also the single source of the supported Node version: the
 * `engines` field, the installer's precondition check and doctor's report all
 * have to agree, and three hand-maintained copies of a number never do.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Manifest {
  name?: string;
  version?: string;
  engines?: { node?: string };
}

let cached: Manifest | undefined;

function manifest(): Manifest {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/core/version.js → dist/core → dist → <package root>
  for (const candidate of [join(here, "..", "..", "package.json"), join(here, "..", "package.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Manifest;
      if (parsed.name === "native-ai-tester") {
        cached = parsed;
        return cached;
      }
    } catch {
      // Try the next candidate.
    }
  }
  cached = {};
  return cached;
}

export function version(): string {
  return manifest().version ?? "0.0.0-dev";
}

/** The lowest Node this package claims to run on, as [major, minor, patch]. */
export function minimumNode(): [number, number, number] {
  const declared = /(\d+)\.(\d+)\.(\d+)/.exec(manifest().engines?.node ?? "");
  if (!declared) return [20, 19, 0];
  return [Number(declared[1]), Number(declared[2]), Number(declared[3])];
}

export function meetsMinimumNode(actual = process.versions.node): boolean {
  const [major, minor, patch] = minimumNode();
  const parts = actual.split(".").map((value) => Number.parseInt(value, 10) || 0);
  const [haveMajor = 0, haveMinor = 0, havePatch = 0] = parts;
  if (haveMajor !== major) return haveMajor > major;
  if (haveMinor !== minor) return haveMinor > minor;
  return havePatch >= patch;
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
