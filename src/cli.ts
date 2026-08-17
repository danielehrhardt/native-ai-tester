#!/usr/bin/env node
/**
 * native-ai-tester — automated mobile testing for apps and games.
 *
 * The CLI is deliberately a set of one-shot commands rather than a session or a
 * REPL: `nat screen`, `nat action tap …`, `nat screen`. That shape is what lets
 * a coding agent drive a real device with nothing but shell access, and what
 * makes every step of a failing test reproducible by hand.
 */

import { Command } from "commander";
import { configureOutput, renderError, isJson } from "./core/output.js";
import { exitCodeFor } from "./core/errors.js";
import { loadConfig } from "./core/config.js";
import { maybeNotifyUpdate } from "./core/update.js";
import { version } from "./core/version.js";
import { registerDeviceCommands } from "./commands/devices.js";
import { registerScreenCommands } from "./commands/screen.js";
import { registerViewCommands } from "./commands/view.js";
import { registerActionCommands } from "./commands/action.js";
import { registerAppCommands } from "./commands/apps.js";
import { registerCaseCommands } from "./commands/cases.js";
import { registerRunCommand } from "./commands/run.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerSetupCommands } from "./commands/setup.js";
import { registerMcpCommands } from "./commands/mcp.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerUpdateCommand } from "./commands/update.js";

const EXAMPLES = `
Examples:
  $ nat devices                                  list phones, simulators and emulators
  $ nat devices connect 00008140-0009…           connect once; later commands reuse it
  $ nat action activate-app --bundle-id com.example.app

  $ nat screen                                   read the UI (cheap — do this every step)
  $ nat action tap --x 500 --y 320               act on coordinates from \`nat screen\`
  $ nat action tap -d "Blue login button"        …or by description, for games and canvases
  $ nat screen                                   verify the result

  $ nat screenshot --marks ./shot.png            see it, with every tap target numbered
  $ nat action tap --mark 3                      …then act on a number you can see
  $ nat record --filmstrip ./frames.png          six frames on one sheet, to read a transition
  $ nat watch                                    stream the device to a browser, live

  $ nat cases create '{"title":"Login","flows":[{"instructions":"sign in","result":"home shows"}]}'
  $ nat run login --report ./report.json         run it autonomously

Every command takes --json. Diagnostics go to stderr, so \`nat screen --json | jq\` is clean.
Start with \`nat doctor\` if anything is missing.
`;

async function main(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("nat")
    .description("Automated mobile testing for apps and games — real iOS & Android devices, no locators, no SDK.")
    .version(version(), "-V, --version", "print the installed version")
    .option("--json", "emit machine-readable JSON on stdout")
    .option("-q, --quiet", "suppress non-essential output")
    .option("-v, --verbose", "print a trace of what the tool is doing")
    .addHelpText("after", EXAMPLES)
    .showHelpAfterError("(run `nat --help` for usage)");

  // Global flags are read before any subcommand runs, so `--json` applies to
  // whatever that subcommand emits.
  program.hook("preAction", (_thisCommand, actionCommand) => {
    const options = actionCommand.optsWithGlobals<{ json?: boolean; quiet?: boolean; verbose?: boolean }>();
    configureOutput({
      json: options.json === true,
      quiet: options.quiet === true,
      verbose: options.verbose === true,
    });
  });

  registerDeviceCommands(program);
  registerScreenCommands(program);
  registerViewCommands(program);
  registerActionCommands(program);
  registerAppCommands(program);
  registerCaseCommands(program);
  registerRunCommand(program);
  registerDoctorCommand(program);
  registerSetupCommands(program);
  registerConfigCommands(program);
  registerMcpCommands(program);
  registerSkillCommands(program);
  registerUpdateCommand(program);

  // `nat screen --json` and `nat --json screen` should both work. Commander
  // only recognises an option on the command it is written after, so the global
  // flags are copied onto every subcommand once they are all registered.
  applyGlobalFlags(program);

  await notifyUpdateUnlessNoisy(argv);
  await program.parseAsync(argv);
}

function applyGlobalFlags(command: Command): void {
  for (const sub of command.commands) {
    sub
      .option("--json", "emit machine-readable JSON on stdout")
      .option("-q, --quiet", "suppress non-essential output")
      .option("-v, --verbose", "print a trace of what the tool is doing");
    applyGlobalFlags(sub);
  }
}

/**
 * The update notice writes to stderr, which would corrupt a protocol stream —
 * so it is skipped for `nat mcp serve` and for the background check itself.
 */
async function notifyUpdateUnlessNoisy(argv: string[]): Promise<void> {
  const command = argv[2];
  if (command === "mcp" || command === "update" || command === "watch" || process.env.NAT_NO_UPDATE_CHECK) return;
  try {
    const config = await loadConfig();
    await maybeNotifyUpdate({
      enabled: config.update?.autoCheck !== false,
      channel: config.update?.channel === "next" ? "next" : "latest",
    });
  } catch {
    // Never let the update path break the command the user asked for.
  }
}

main(process.argv).catch((error: unknown) => {
  const rendered = renderError(error);
  if (isJson()) process.stdout.write(`${JSON.stringify(rendered.json, null, 2)}\n`);
  else process.stderr.write(`${rendered.text}\n`);
  process.exit(exitCodeFor(error));
});
