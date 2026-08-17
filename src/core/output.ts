/**
 * Output formatting.
 *
 * Two audiences, one code path: a human reading a terminal and an agent parsing
 * stdout. `--json` switches every command to a single machine-readable object
 * on stdout; diagnostics always go to stderr so `nat screenshot - > shot.png`
 * and `nat screen --json | jq` both stay clean.
 */

import { isNatError } from "./errors.js";

export type OutputMode = "text" | "json";

let mode: OutputMode = "text";
let quiet = false;
let verbose = false;

export function configureOutput(options: { json?: boolean; quiet?: boolean; verbose?: boolean }): void {
  if (options.json) mode = "json";
  if (options.quiet !== undefined) quiet = options.quiet;
  if (options.verbose !== undefined) verbose = options.verbose;
}

export function outputMode(): OutputMode {
  return mode;
}

export function isJson(): boolean {
  return mode === "json";
}

const useColor = (): boolean =>
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

export const color = {
  dim: (s: string) => (useColor() ? `\u001b[2m${s}\u001b[22m` : s),
  bold: (s: string) => (useColor() ? `\u001b[1m${s}\u001b[22m` : s),
  red: (s: string) => (useColor() ? `\u001b[31m${s}\u001b[39m` : s),
  green: (s: string) => (useColor() ? `\u001b[32m${s}\u001b[39m` : s),
  yellow: (s: string) => (useColor() ? `\u001b[33m${s}\u001b[39m` : s),
  cyan: (s: string) => (useColor() ? `\u001b[36m${s}\u001b[39m` : s),
};

/**
 * Emit the result of a command.
 *
 * `data` is what `--json` prints; `text` renders the human view. Commands pass
 * both so neither audience gets a degraded version of the other's output.
 */
export function emit(data: unknown, text?: string | (() => string)): void {
  if (mode === "json") {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (quiet) return;
  const rendered = typeof text === "function" ? text() : text;
  if (rendered !== undefined && rendered !== "") {
    process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
  }
}

/** Status line for humans; suppressed in JSON mode and under --quiet. */
export function info(message: string): void {
  if (mode === "json" || quiet) return;
  process.stderr.write(`${message}\n`);
}

export function warn(message: string): void {
  if (quiet) return;
  process.stderr.write(`${color.yellow("warning")} ${message}\n`);
}

export function debug(message: string): void {
  if (!verbose) return;
  process.stderr.write(`${color.dim(`debug  ${message}`)}\n`);
}

export function isVerbose(): boolean {
  return verbose;
}

/** Terminal failure renderer, shared by the CLI and the MCP bridge. */
export function renderError(error: unknown): { json: Record<string, unknown>; text: string } {
  if (isNatError(error)) {
    const lines = [`${color.red("error")} ${error.message}`];
    if (error.hint) lines.push(`${color.dim("hint ")} ${error.hint}`);
    return { json: { ok: false, error: error.toJSON() }, text: lines.join("\n") };
  }
  const message = error instanceof Error ? error.message : String(error);
  const text = [`${color.red("error")} ${message}`];
  if (verbose && error instanceof Error && error.stack) {
    text.push(color.dim(error.stack));
  } else {
    text.push(color.dim("hint  re-run with --verbose for a stack trace"));
  }
  return { json: { ok: false, error: { code: "INTERNAL", message } }, text: text.join("\n") };
}

/** Fixed-width table used by `devices`, `apps` and `cases list`. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [color.dim(line(headers)), ...rows.map(line)].join("\n");
}
