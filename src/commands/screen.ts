/**
 * `nat screen` and `nat screenshot` — the "inspect" half of the loop.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { emit, info, isJson, color } from "../core/output.js";
import { readScreen } from "../core/screen.js";
import { renderSnapshot } from "../core/tree.js";
import { attachDriverEnsuringAgent } from "../drivers/index.js";
import { parseNumber } from "./shared.js";

export function registerScreenCommands(program: Command): void {
  program
    .command("screen")
    .description("read the current UI as a cleaned element tree with tap coordinates")
    .option("--full", "return the raw platform tree, unfiltered")
    .option("--max-nodes <count>", "cap the number of elements returned (default 400)")
    .action(async (options: { full?: boolean; maxNodes?: string }) => {
      const { driver } = await attachDriverEnsuringAgent();
      const snapshot = await readScreen(driver, {
        full: options.full === true,
        ...(options.maxNodes ? { maxNodes: parseNumber(options.maxNodes, "--max-nodes")! } : {}),
      });
      emit(snapshot, () => renderSnapshot(snapshot));
    });

  program
    .command("screenshot")
    .description("save a PNG screenshot (use `-` to write to stdout)")
    .argument("[path]", "where to write the file", "./screenshot.png")
    .action(async (path: string) => {
      const { driver } = await attachDriverEnsuringAgent();
      const image = await driver.screenshot();

      if (path === "-") {
        process.stdout.write(image);
        return;
      }

      const target = resolve(process.cwd(), path);
      await writeFile(target, image);

      if (isJson()) {
        emit({ path: target, bytes: image.length });
        return;
      }
      info(`${color.green("Saved")} ${target} (${formatBytes(image.length)})`);
      process.stdout.write(`${target}\n`);
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
