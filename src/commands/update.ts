/**
 * `nat update` — check for and install a newer release.
 */

import { Command } from "commander";
import { emit, color } from "../core/output.js";
import { checkForUpdate, performUpdate } from "../core/update.js";
import { version } from "../core/version.js";

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("update to the latest release")
    .option("--check", "only report whether an update exists")
    .option("--channel <channel>", "latest or next", "latest")
    .action(async (options: { check?: boolean; channel: string }) => {
      const channel = options.channel === "next" ? "next" : "latest";

      if (options.check) {
        const outcome = await checkForUpdate(channel);
        emit(outcome, () => {
          if (outcome.latest) {
            return outcome.latest === outcome.current
              ? `Up to date (${outcome.current}).`
              : `${outcome.current} → ${outcome.latest} available. Run \`nat update\`.`;
          }
          return outcome.unavailable === "not-published"
            ? `No published release to compare against — running ${outcome.current}.`
            : "Could not reach the npm registry.";
        });
        return;
      }

      const outcome = await performUpdate(channel);
      emit(outcome, () =>
        outcome.updated
          ? `${color.green("Updated")} ${outcome.current} → ${outcome.latest}.`
          : `Already on the latest version (${outcome.current}).`,
      );
    });

  program
    .command("version")
    .description("print the installed version")
    .action(() => {
      emit({ version: version() }, version());
    });
}
