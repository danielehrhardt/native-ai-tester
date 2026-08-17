/**
 * `nat config` — read and write the layered configuration.
 *
 * Writes land in `~/.native-ai-tester/config.json` by default and in the
 * project's `.nat/config.json` with `--project`. The project file is the one
 * worth committing: it pins the Apple team id and the app under test so a
 * teammate's first run needs no setup.
 */

import { Command } from "commander";
import { emit, color } from "../core/output.js";
import { NatError } from "../core/errors.js";
import { loadConfig, saveProjectConfig, saveUserConfig, type NatConfig } from "../core/config.js";
import { paths, projectConfigFile } from "../core/paths.js";

/** Every settable key, with the coercion it needs. */
const KEYS: Record<string, "string" | "number" | "boolean"> = {
  defaultDevice: "string",
  app: "string",
  "ios.teamId": "string",
  "ios.wdaBundleId": "string",
  "ios.wdaPort": "number",
  "ios.wdaVersion": "string",
  "ios.reuseWda": "boolean",
  "android.adbPath": "string",
  "grounding.provider": "string",
  "grounding.model": "string",
  "grounding.baseUrl": "string",
  "grounding.apiKeyEnv": "string",
  "update.autoCheck": "boolean",
  "update.channel": "string",
};

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("read and write configuration");

  config
    .command("list", { isDefault: true })
    .description("show the effective configuration and where it comes from")
    .action(async () => {
      const effective = await loadConfig();
      emit(
        { config: effective, files: { user: paths.configFile(), project: projectConfigFile() } },
        () =>
          [
            renderConfig(effective),
            "",
            color.dim(`user file    ${paths.configFile()}`),
            color.dim(`project file ${projectConfigFile()}`),
          ].join("\n"),
      );
    });

  config
    .command("get")
    .description("read one value")
    .argument("<key>", `one of: ${Object.keys(KEYS).join(", ")}`)
    .action(async (key: string) => {
      assertKnownKey(key);
      const effective = await loadConfig();
      const value = readPath(effective, key);
      emit({ key, value: value ?? null }, value === undefined ? "" : String(value));
    });

  config
    .command("set")
    .description("write one value")
    .argument("<key>", `one of: ${Object.keys(KEYS).join(", ")}`)
    .argument("<value>", "the value to store")
    .option("--project", "write to <project>/.nat/config.json instead of the user config")
    .action(async (key: string, rawValue: string, options: { project?: boolean }) => {
      assertKnownKey(key);
      const patch = buildPatch(key, coerce(key, rawValue));
      const saved = options.project ? await saveProjectConfig(patch) : await saveUserConfig(patch);
      const file = options.project ? projectConfigFile() : paths.configFile();
      emit({ ok: true, key, value: readPath(saved, key), file }, `${color.green("set")} ${key} in ${file}`);
    });

  config
    .command("path")
    .description("print the config file locations")
    .action(() => {
      emit(
        { user: paths.configFile(), project: projectConfigFile(), home: paths.root() },
        [`user    ${paths.configFile()}`, `project ${projectConfigFile()}`, `home    ${paths.root()}`].join("\n"),
      );
    });
}

function assertKnownKey(key: string): void {
  if (!(key in KEYS)) {
    throw new NatError("INVALID_ARGUMENT", `Unknown config key \`${key}\``, {
      hint: `Known keys:\n${Object.keys(KEYS).map((k) => `  ${k}`).join("\n")}`,
    });
  }
}

function coerce(key: string, raw: string): string | number | boolean {
  switch (KEYS[key]) {
    case "number": {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        throw new NatError("INVALID_ARGUMENT", `${key} must be a number, got \`${raw}\``);
      }
      return parsed;
    }
    case "boolean": {
      if (["true", "1", "yes", "on"].includes(raw.toLowerCase())) return true;
      if (["false", "0", "no", "off"].includes(raw.toLowerCase())) return false;
      throw new NatError("INVALID_ARGUMENT", `${key} must be true or false, got \`${raw}\``);
    }
    default:
      return raw;
  }
}

function buildPatch(key: string, value: unknown): NatConfig {
  const [head, tail] = key.split(".");
  if (!tail) return { [head!]: value } as NatConfig;
  return { [head!]: { [tail]: value } } as NatConfig;
}

function readPath(config: NatConfig, key: string): unknown {
  const [head, tail] = key.split(".");
  const top = (config as Record<string, unknown>)[head!];
  if (!tail) return top;
  return top && typeof top === "object" ? (top as Record<string, unknown>)[tail] : undefined;
}

function renderConfig(config: NatConfig): string {
  const lines: string[] = [];
  for (const key of Object.keys(KEYS)) {
    const value = readPath(config, key);
    if (value === undefined) continue;
    lines.push(`${key.padEnd(22)} ${String(value)}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(nothing configured — defaults are in use)";
}
