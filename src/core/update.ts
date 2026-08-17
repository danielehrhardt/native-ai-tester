/**
 * Staying current.
 *
 * The check never blocks a command. A background process refreshes a small
 * cache file at most once a day; the *next* invocation reads that cache and
 * prints a one-line notice. So the cost of knowing about an update is zero
 * milliseconds on the command you actually ran.
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run, which } from "../core/exec.js";
import { NatError } from "./errors.js";
import { paths } from "./paths.js";
import { color, debug } from "./output.js";
import { isNewer, version } from "./version.js";

const PACKAGE = "native-ai-tester";
const REGISTRY = process.env.NAT_REGISTRY || "https://registry.npmjs.org";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateState {
  lastCheck: string;
  latest?: string;
  /** Set once the user has been told about this version, so we say it once. */
  notified?: string;
}

export type LatestVersion =
  | { version: string }
  /** The registry answered, but has no such package or no such dist-tag. */
  | { unavailable: "not-published" }
  /** The registry could not be reached at all. */
  | { unavailable: "unreachable" };

export async function fetchLatestVersion(channel: "latest" | "next" = "latest"): Promise<LatestVersion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${REGISTRY}/${PACKAGE}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: controller.signal,
    });
    // A 404 means the registry is fine and the package simply is not there —
    // the state of every fork and every unpublished checkout. Reporting that as
    // "could not reach the registry" sends people to debug their network.
    if (response.status === 404) return { unavailable: "not-published" };
    if (!response.ok) return { unavailable: "unreachable" };

    const body = (await response.json()) as { "dist-tags"?: Record<string, string> };
    const version = body["dist-tags"]?.[channel];
    return version ? { version } : { unavailable: "not-published" };
  } catch {
    return { unavailable: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export async function readState(): Promise<UpdateState | undefined> {
  try {
    return JSON.parse(await readFile(paths.updateFile(), "utf8")) as UpdateState;
  } catch {
    return undefined;
  }
}

export async function writeState(state: UpdateState): Promise<void> {
  const file = paths.updateFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Print a notice if a newer version is already known, then kick off a refresh
 * in the background if the cache is stale. Never awaits the network.
 */
export async function maybeNotifyUpdate(options: { enabled: boolean; channel: "latest" | "next" }): Promise<void> {
  if (!options.enabled) return;

  const current = version();
  const state = await readState();

  if (state?.latest && isNewer(state.latest, current) && state.notified !== state.latest) {
    process.stderr.write(
      `${color.yellow("update")} ${PACKAGE} ${current} → ${state.latest}. Run ${color.bold("nat update")}.\n`,
    );
    await writeState({ ...state, notified: state.latest }).catch(() => undefined);
  }

  const age = state?.lastCheck ? Date.now() - Date.parse(state.lastCheck) : Number.POSITIVE_INFINITY;
  if (age < CHECK_INTERVAL_MS) return;

  spawnBackgroundCheck(options.channel);
}

function spawnBackgroundCheck(channel: string): void {
  try {
    const entry = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
    const child = spawn(process.execPath, [entry, "update", "--check", "--quiet", "--channel", channel], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, NAT_NO_UPDATE_CHECK: "1" },
    });
    child.unref();
    debug("update: background check started");
  } catch {
    // A failed check must never affect the command the user actually ran.
  }
}

export interface UpdateOutcome {
  current: string;
  latest?: string;
  updated: boolean;
  method?: string;
  /** Why `latest` is absent, when it is. */
  unavailable?: "not-published" | "unreachable";
}

/** Refresh the cache without installing anything. */
export async function checkForUpdate(channel: "latest" | "next"): Promise<UpdateOutcome> {
  const current = version();
  const result = await fetchLatestVersion(channel);
  const previous = await readState();
  const latest = "version" in result ? result.version : undefined;

  await writeState({
    lastCheck: new Date().toISOString(),
    ...(latest ? { latest } : {}),
    ...(previous?.notified ? { notified: previous.notified } : {}),
  }).catch(() => undefined);

  return {
    current,
    ...(latest ? { latest } : {}),
    ...("unavailable" in result ? { unavailable: result.unavailable } : {}),
    updated: false,
  };
}

/**
 * Install the latest release using whatever installed this copy.
 *
 * A curl-installed copy and an `npm i -g` copy both end up as a global npm
 * package, so one code path covers the one-line installer and manual installs
 * alike. Anything else (a git checkout, a pnpm store) is reported rather than
 * guessed at — silently running the wrong package manager is worse than saying
 * what to run.
 */
export async function performUpdate(channel: "latest" | "next"): Promise<UpdateOutcome> {
  const current = version();
  const result = await fetchLatestVersion(channel);

  if (!("version" in result)) {
    throw result.unavailable === "not-published"
      ? new NatError("UNSUPPORTED", `\`${PACKAGE}\` has no \`${channel}\` release on ${REGISTRY}`, {
          hint: "Nothing to update to. If you are running from a source checkout, use `git pull && npm install && npm run build`.",
        })
      : new NatError("TIMEOUT", "Could not reach the npm registry", {
          hint: `Check your connection, or install manually: npm install -g ${PACKAGE}@${channel}`,
        });
  }
  const latest = result.version;
  if (!isNewer(latest, current)) {
    await writeState({ lastCheck: new Date().toISOString(), latest }).catch(() => undefined);
    return { current, latest, updated: false };
  }

  const method = await detectInstallMethod();
  if (method !== "npm-global") {
    throw new NatError("UNSUPPORTED", `This copy was not installed with npm (${method})`, {
      hint:
        method === "local-checkout"
          ? "You are running from a source checkout — `git pull && npm install && npm run build`."
          : `Update it the way you installed it, or run: npm install -g ${PACKAGE}@${channel}`,
    });
  }

  const npm = (await which("npm")) ?? "npm";
  await run(npm, ["install", "-g", `${PACKAGE}@${channel}`], { timeout: 300_000 });
  await writeState({ lastCheck: new Date().toISOString(), latest, notified: latest }).catch(() => undefined);
  return { current, latest, updated: true, method };
}

async function detectInstallMethod(): Promise<"npm-global" | "local-checkout" | "unknown"> {
  if (process.env.NAT_INSTALL_METHOD) return process.env.NAT_INSTALL_METHOD as "npm-global";
  const here = fileURLToPath(import.meta.url);
  if (here.includes(`node_modules/${PACKAGE}/`)) return "npm-global";
  if (here.includes("/dist/") || here.includes("/src/")) return "local-checkout";
  return "unknown";
}

export { PACKAGE };
