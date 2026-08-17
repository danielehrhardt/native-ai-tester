/**
 * `nat screen` and `nat screenshot` — the "inspect" half of the loop.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { emit, info, isJson, color } from "../core/output.js";
import { readScreen } from "../core/screen.js";
import { renderSnapshot } from "../core/tree.js";
import { assignMarks, drawMarks, markedElements } from "../core/annotate.js";
import { attachDriverEnsuringAgent } from "../drivers/index.js";
import { parseNumber } from "./shared.js";

export function registerScreenCommands(program: Command): void {
  program
    .command("screen")
    .description("read the current UI as a cleaned element tree with tap coordinates")
    .option("--full", "return the raw platform tree, unfiltered")
    .option("--max-nodes <count>", "cap the number of elements returned (default 400)")
    .option("--no-marks", "omit the #n numbers that pair with `nat screenshot --marks`")
    .action(async (options: { full?: boolean; maxNodes?: string; marks?: boolean }) => {
      const { driver } = await attachDriverEnsuringAgent();
      const snapshot = await readScreen(driver, {
        full: options.full === true,
        marks: options.marks !== false,
        ...(options.maxNodes ? { maxNodes: parseNumber(options.maxNodes, "--max-nodes")! } : {}),
      });
      emit(snapshot, () => renderSnapshot(snapshot));
    });

  program
    .command("screenshot")
    .description("save a PNG screenshot (use `-` to write to stdout)")
    .argument("[path]", "where to write the file", "./screenshot.png")
    .option(
      "-m, --marks",
      "draw a numbered box on every tap target — the numbers match `nat screen` and `--mark`",
    )
    .option("--marks-all", "mark every named element, not just plausible tap targets")
    .option("--max-marks <count>", "cap how many elements get numbered (default 60)")
    .action(async (path: string, options: { marks?: boolean; marksAll?: boolean; maxMarks?: string }) => {
      const { driver } = await attachDriverEnsuringAgent();
      const wantsMarks = options.marks === true || options.marksAll === true;

      let image = await driver.screenshot();
      let marks: Array<{ mark: number; role: string; label?: string; x: number; y: number }> = [];

      if (wantsMarks) {
        const snapshot = await readScreen(driver, {
          withApp: false,
          ...(options.maxMarks ? { maxMarks: parseNumber(options.maxMarks, "--max-marks")! } : {}),
        });
        const elements = options.marksAll
          ? assignMarks(snapshot.elements, { all: true, max: parseNumber(options.maxMarks, "--max-marks") ?? 60 })
          : snapshot.elements;
        image = drawMarks(image, elements);
        marks = markedElements(elements).map((node) => ({
          mark: node.mark!,
          role: node.role,
          ...(node.label ? { label: node.label } : {}),
          x: node.center.x,
          y: node.center.y,
        }));
      }

      if (path === "-") {
        process.stdout.write(image);
        return;
      }

      const target = resolve(process.cwd(), path);
      await writeFile(target, image);

      if (isJson()) {
        emit({ path: target, bytes: image.length, ...(wantsMarks ? { marks } : {}) });
        return;
      }
      info(
        `${color.green("Saved")} ${target} (${formatBytes(image.length)}` +
          (wantsMarks ? `, ${marks.length} marks` : "") +
          ")",
      );
      process.stdout.write(`${target}\n`);
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
