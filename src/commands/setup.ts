/**
 * `nat setup ios` — one-time preparation so the first `devices connect` is fast.
 *
 * Two things are slow the first time: downloading WebDriverAgent, and finding
 * out mid-run that no Apple team id is configured. Both are handled here so the
 * failure happens at setup time, with a clear message, instead of halfway
 * through someone's first test.
 */

import { Command } from "commander";
import { emit, info, color } from "../core/output.js";
import { NatError } from "../core/errors.js";
import { loadConfig, saveUserConfig } from "../core/config.js";
import { detectTeamIds, ensureSource } from "../drivers/ios/wda-manager.js";
import { paths } from "../core/paths.js";

export function registerSetupCommands(program: Command): void {
  const setup = program.command("setup").description("one-time platform preparation");

  setup
    .command("ios")
    .description("download WebDriverAgent and select an Apple Developer team")
    .option("--team-id <id>", "use this team id instead of detecting one")
    .option("--skip-download", "only resolve the team id")
    .action(async (options: { teamId?: string; skipDownload?: boolean }) => {
      if (process.platform !== "darwin") {
        throw new NatError("UNSUPPORTED", "iOS setup requires macOS with Xcode", {
          hint: "Android testing needs no setup beyond `adb` — run `nat doctor --platform android`.",
        });
      }

      const config = await loadConfig();
      const teamId = await resolveTeamId(options.teamId, config.ios?.teamId);

      if (teamId && teamId !== config.ios?.teamId) {
        await saveUserConfig({ ios: { teamId } });
        info(`${color.green("Selected")} Apple team ${teamId}`);
      }

      let source: string | undefined;
      if (!options.skipDownload) {
        source = await ensureSource(config.ios?.wdaVersion ?? "v16.2.1");
      }

      emit(
        {
          ok: true,
          teamId: teamId ?? null,
          wdaSource: source ?? null,
          wdaVersion: config.ios?.wdaVersion,
        },
        () =>
          [
            `${color.green("iOS setup complete.")}`,
            teamId ? `  Apple team      ${teamId}` : `  Apple team      ${color.yellow("not set — simulators only")}`,
            source ? `  WebDriverAgent  ${source}` : "",
            "",
            "Connect a device and go:",
            "  nat devices",
            "  nat devices connect <device-id>",
          ]
            .filter(Boolean)
            .join("\n"),
      );
    });

  setup
    .command("android")
    .description("check the Android toolchain (nothing to install on the device)")
    .action(async () => {
      emit(
        { ok: true },
        [
          "Android needs no per-device setup — adb does everything.",
          "",
          "Make sure the platform tools are installed and the device is authorised:",
          "  brew install --cask android-platform-tools",
          "  adb devices",
          "",
          "Then: `nat devices android` and `nat devices connect <serial>`.",
        ].join("\n"),
      );
    });
}

async function resolveTeamId(explicit: string | undefined, existing: string | undefined): Promise<string | undefined> {
  if (explicit) return explicit;

  const teams = await detectTeamIds();
  if (teams.length === 1) return teams[0]!.teamId;

  if (teams.length > 1) {
    if (existing && teams.some((team) => team.teamId === existing)) return existing;
    throw new NatError("INVALID_ARGUMENT", `Found ${teams.length} Apple Developer teams — pick one`, {
      hint:
        `Re-run with the one you want:\n` +
        teams.map((team) => `  nat setup ios --team-id ${team.teamId}    # ${team.teamName ?? "unnamed team"}`).join("\n"),
    });
  }

  if (existing) return existing;

  info(
    color.yellow("No provisioning profiles found") +
      " — simulators will work, real devices will not.\n" +
      `  Sign in to Xcode with an Apple Developer account, build any app to a device once, then re-run this.\n` +
      `  Profiles are read from ~/Library/Developer/Xcode/UserData/Provisioning Profiles`,
  );
  return undefined;
}

export { paths };
