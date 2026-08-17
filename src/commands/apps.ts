/**
 * `nat apps`, `nat install`, `nat uninstall` — getting a build onto the device.
 */

import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { Command } from "commander";
import { emit, info, table, color } from "../core/output.js";
import { NatError } from "../core/errors.js";
import { attachDriver, attachDriverEnsuringAgent } from "../drivers/index.js";

export function registerAppCommands(program: Command): void {
  program
    .command("apps")
    .description("list the apps installed on the connected device")
    .option("--filter <text>", "only show apps whose id or name contains this")
    .action(async (options: { filter?: string }) => {
      const { driver } = await attachDriver();
      const apps = await driver.listApps();
      const filtered = options.filter
        ? apps.filter((app) =>
            `${app.bundleId} ${app.name ?? ""}`.toLowerCase().includes(options.filter!.toLowerCase()),
          )
        : apps;

      emit({ apps: filtered }, () => {
        if (filtered.length === 0) return "No apps found.";
        return table(
          ["BUNDLE ID", "NAME", "VERSION"],
          filtered.map((app) => [app.bundleId, app.name ?? "", app.version ?? ""]),
        );
      });
    });

  program
    .command("install")
    .description("install a build (.app, .ipa, or .apk) on the connected device")
    .argument("<path>", "path to the build")
    .action(async (path: string) => {
      const target = resolve(process.cwd(), path);
      const stats = await stat(target).catch(() => undefined);
      if (!stats) {
        throw new NatError("INVALID_ARGUMENT", `No such file: ${target}`);
      }

      const { driver } = await attachDriverEnsuringAgent();
      info(`Installing ${target} …`);
      await driver.installApp(target);
      emit({ ok: true, installed: target }, `${color.green("Installed")} ${target}`);
    });

  program
    .command("uninstall")
    .description("remove an app from the connected device")
    .argument("<bundle-id>", "iOS bundle id or Android package name")
    .action(async (bundleId: string) => {
      const { driver } = await attachDriver();
      await driver.uninstallApp(bundleId);
      emit({ ok: true, uninstalled: bundleId }, `${color.green("Uninstalled")} ${bundleId}`);
    });
}
