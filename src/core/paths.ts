/**
 * Where state lives on disk.
 *
 * Everything the tool creates outside the user's project sits under a single
 * root so `rm -rf ~/.native-ai-tester` is a complete uninstall of runtime state.
 * `NAT_HOME` overrides it, which is what the test-suite uses to stay hermetic.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export function homeRoot(): string {
  return process.env.NAT_HOME || join(homedir(), ".native-ai-tester");
}

export const paths = {
  root: homeRoot,
  /** Currently connected device, update check timestamps, etc. */
  state: () => join(homeRoot(), "state"),
  sessionFile: () => join(homeRoot(), "state", "session.json"),
  updateFile: () => join(homeRoot(), "state", "update-check.json"),
  configFile: () => join(homeRoot(), "config.json"),
  /** WebDriverAgent checkout + derived data. */
  wdaRoot: () => join(homeRoot(), "wda"),
  wdaSource: () => join(homeRoot(), "wda", "WebDriverAgent"),
  wdaDerivedData: () => join(homeRoot(), "wda", "DerivedData"),
  logs: () => join(homeRoot(), "logs"),
  cacheRoot: () => join(homeRoot(), "cache"),
  /** Screenshots/artifacts written by `nat run`. */
  runsRoot: () => join(homeRoot(), "runs"),
};

export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

/** Test cases live *in the repo* so they are reviewed and versioned like code. */
export function projectCasesDir(cwd: string = process.cwd()): string {
  return process.env.NAT_CASES_DIR || join(cwd, ".nat", "cases");
}

export function projectConfigFile(cwd: string = process.cwd()): string {
  return join(cwd, ".nat", "config.json");
}
