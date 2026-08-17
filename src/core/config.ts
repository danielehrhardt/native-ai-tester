/**
 * Layered configuration.
 *
 * Precedence, lowest to highest:
 *   built-in defaults → ~/.native-ai-tester/config.json → <project>/.nat/config.json → NAT_* env
 *
 * The project file is the one meant to be committed: it pins the Apple team id
 * and default bundle id so a teammate's first `nat` run needs no setup.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { paths, projectConfigFile } from "./paths.js";

export interface IosConfig {
  /** Apple Developer team id used to sign WebDriverAgent for real devices. */
  teamId?: string;
  /** Bundle id WDA is signed with; override when the default is taken. */
  wdaBundleId?: string;
  /** Host port the WDA HTTP server is reached on. */
  wdaPort?: number;
  /** Pinned appium/WebDriverAgent release tag. */
  wdaVersion?: string;
  /** Skip the automatic `xcodebuild test` when WDA is already installed. */
  reuseWda?: boolean;
}

export interface AndroidConfig {
  adbPath?: string;
}

export type GroundingProvider = "auto" | "tree" | "anthropic" | "openai" | "openai-compatible" | "off";

export interface GroundingConfig {
  /**
   * `auto` (default) resolves descriptions from the accessibility tree and only
   * falls back to a vision model when the tree has nothing to match — which is
   * exactly the games/canvas/WebView case.
   */
  provider?: GroundingProvider;
  model?: string;
  /** Base URL for `openai-compatible` (Ollama, vLLM, LM Studio, …). */
  baseUrl?: string;
  /** Env var holding the API key. Defaults per provider. */
  apiKeyEnv?: string;
}

export interface UpdateConfig {
  /** Check npm for a newer version at most once a day. */
  autoCheck?: boolean;
  channel?: "latest" | "next";
}

export interface NatConfig {
  defaultDevice?: string;
  /** Bundle id / package name of the app under test. */
  app?: string;
  ios?: IosConfig;
  android?: AndroidConfig;
  grounding?: GroundingConfig;
  update?: UpdateConfig;
}

const DEFAULTS: NatConfig = {
  ios: {
    wdaPort: 8100,
    wdaBundleId: "com.facebook.WebDriverAgentRunner",
    wdaVersion: "v16.2.1",
    reuseWda: true,
  },
  android: {},
  grounding: { provider: "auto" },
  update: { autoCheck: true, channel: "latest" },
};

let cached: NatConfig | undefined;

export async function loadConfig(cwd: string = process.cwd()): Promise<NatConfig> {
  if (cached) return cached;
  const user = await readJson(paths.configFile());
  const project = await readJson(projectConfigFile(cwd));
  cached = applyEnv(merge(merge(DEFAULTS, user), project));
  return cached;
}

/** Test hook: forget the memoized config. */
export function resetConfigCache(): void {
  cached = undefined;
}

export async function saveUserConfig(patch: NatConfig): Promise<NatConfig> {
  const file = paths.configFile();
  const current = await readJson(file);
  const next = merge(current, patch);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  cached = undefined;
  return next;
}

export async function saveProjectConfig(patch: NatConfig, cwd: string = process.cwd()): Promise<NatConfig> {
  const file = projectConfigFile(cwd);
  const current = await readJson(file);
  const next = merge(current, patch);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  cached = undefined;
  return next;
}

async function readJson(file: string): Promise<NatConfig> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as NatConfig;
  } catch {
    return {};
  }
}

function merge(base: NatConfig, patch: NatConfig): NatConfig {
  return {
    ...base,
    ...stripUndefined(patch),
    ios: { ...base.ios, ...stripUndefined(patch.ios ?? {}) },
    android: { ...base.android, ...stripUndefined(patch.android ?? {}) },
    grounding: { ...base.grounding, ...stripUndefined(patch.grounding ?? {}) },
    update: { ...base.update, ...stripUndefined(patch.update ?? {}) },
  };
}

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

function applyEnv(config: NatConfig): NatConfig {
  const env = process.env;
  const next = structuredClone(config);
  if (env.NAT_DEVICE) next.defaultDevice = env.NAT_DEVICE;
  if (env.NAT_APP) next.app = env.NAT_APP;
  if (env.NAT_IOS_TEAM_ID) next.ios = { ...next.ios, teamId: env.NAT_IOS_TEAM_ID };
  if (env.NAT_WDA_PORT) next.ios = { ...next.ios, wdaPort: Number(env.NAT_WDA_PORT) };
  if (env.NAT_WDA_BUNDLE_ID) next.ios = { ...next.ios, wdaBundleId: env.NAT_WDA_BUNDLE_ID };
  if (env.NAT_ADB) next.android = { ...next.android, adbPath: env.NAT_ADB };
  if (env.NAT_GROUNDING) {
    next.grounding = { ...next.grounding, provider: env.NAT_GROUNDING as GroundingProvider };
  }
  if (env.NAT_GROUNDING_MODEL) next.grounding = { ...next.grounding, model: env.NAT_GROUNDING_MODEL };
  if (env.NAT_GROUNDING_BASE_URL) next.grounding = { ...next.grounding, baseUrl: env.NAT_GROUNDING_BASE_URL };
  if (env.NAT_NO_UPDATE_CHECK) next.update = { ...next.update, autoCheck: false };
  return next;
}

export { DEFAULTS as defaultConfig };
