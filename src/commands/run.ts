/**
 * `nat run` — execute a test case autonomously and report per-step pass/fail.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { emit, info, color, isJson } from "../core/output.js";
import { NatError } from "../core/errors.js";
import { getCase, listCases, type TestCase } from "../core/cases.js";
import { attachDriverEnsuringAgent } from "../drivers/index.js";
import { runTestCase, type RunReport } from "../agent/runner.js";
import { parseNumber } from "./shared.js";

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("run a test case on the connected device and report per-step pass/fail")
    .argument("[case]", "case id or title (omit with --tag or --all)")
    .option("--all", "run every case in the project")
    .option("--tag <tag>", "run every case carrying this tag")
    .option("-i, --instructions <text>", "run an ad-hoc flow instead of a stored case")
    .option("--expect <text>", "expected result for the ad-hoc flow")
    .option("--app <bundle-id>", "bring this app to the foreground first")
    .option("--max-steps <n>", "cap the model turns per flow (default 40)")
    .option("--report <path>", "also write the JSON report to this file")
    .action(async (caseId: string | undefined, options: RunFlags) => {
      const cases = await selectCases(caseId, options);
      const { driver } = await attachDriverEnsuringAgent();

      const reports: RunReport[] = [];
      for (const testCase of cases) {
        if (!isJson()) info(`\n${color.bold(testCase.title)} ${color.dim(`(${testCase.id})`)}`);

        const report = await runTestCase(driver, testCase, {
          ...(options.app ? { app: options.app } : {}),
          ...(options.maxSteps ? { maxIterationsPerFlow: parseNumber(options.maxSteps, "--max-steps")! } : {}),
          onFlowStart: (flow) => {
            if (isJson()) return;
            info(`  ${color.dim(`flow ${flow.index}`)} ${flow.instructions}`);
          },
          onStep: (step) => {
            if (isJson()) return;
            const mark = step.ok ? color.dim("·") : color.red("✗");
            info(`    ${mark} ${step.tool.padEnd(15)} ${truncate(step.summary)}`);
          },
          onFlowEnd: (result) => {
            if (isJson()) return;
            const verdict = result.passed ? color.green("PASS") : color.red("FAIL");
            info(`    ${verdict} ${result.reason}`);
          },
        });
        reports.push(report);
      }

      const allPassed = reports.every((report) => report.passed);
      if (options.report) await writeReport(options.report, reports);

      emit(
        reports.length === 1 ? reports[0]! : { runs: reports, passed: allPassed },
        () => renderSummary(reports),
      );

      if (!allPassed) process.exitCode = 1;
    });
}

interface RunFlags {
  all?: boolean;
  tag?: string;
  instructions?: string;
  expect?: string;
  app?: string;
  maxSteps?: string;
  report?: string;
}

async function selectCases(caseId: string | undefined, options: RunFlags): Promise<TestCase[]> {
  if (options.instructions) {
    const now = new Date().toISOString();
    return [
      {
        id: "ad-hoc",
        title: options.instructions.slice(0, 60),
        tags: [],
        ...(options.app ? { app: options.app } : {}),
        flows: [{ instructions: options.instructions, ...(options.expect ? { result: options.expect } : {}) }],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  if (caseId) return [await getCase(caseId)];

  if (options.all || options.tag) {
    const all = await listCases();
    const selected = options.tag ? all.filter((entry) => entry.tags.includes(options.tag!)) : all;
    if (selected.length === 0) {
      throw new NatError("INVALID_ARGUMENT", options.tag ? `No cases tagged \`${options.tag}\`` : "No test cases found", {
        hint: "List them with `nat cases`.",
      });
    }
    return selected;
  }

  throw new NatError("INVALID_ARGUMENT", "Nothing to run", {
    hint:
      "Choose one:\n" +
      "  nat run login                       a stored case\n" +
      "  nat run --tag smoke                 every case with a tag\n" +
      "  nat run --all                       everything\n" +
      '  nat run -i "sign in as a@b.com" --expect "the home screen shows"',
  });
}

async function writeReport(path: string, reports: RunReport[]): Promise<void> {
  const payload = reports.length === 1 ? reports[0]! : { runs: reports };
  await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined);
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  info(`${color.dim("report")} ${path}`);
}

function renderSummary(reports: RunReport[]): string {
  const lines: string[] = [""];
  for (const report of reports) {
    const passedFlows = report.flows.filter((flow) => flow.passed).length;
    const mark = report.passed ? color.green("PASS") : color.red("FAIL");
    lines.push(
      `${mark} ${report.case.title} — ${passedFlows}/${report.flows.length} flows in ${formatDuration(report.durationMs)}`,
    );
    for (const flow of report.flows.filter((entry) => !entry.passed)) {
      lines.push(color.dim(`     flow ${flow.index}: ${flow.reason}`));
    }
  }
  const failures = reports.filter((report) => !report.passed).length;
  lines.push("");
  lines.push(
    failures === 0
      ? color.green(`${reports.length} case${reports.length === 1 ? "" : "s"} passed.`)
      : color.red(`${failures} of ${reports.length} case${reports.length === 1 ? "" : "s"} failed.`),
  );
  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function truncate(value: string, max = 90): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
