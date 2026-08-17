/**
 * `nat cases …` — manage the plain-English test cases stored in the repo.
 */

import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { emit, table, color } from "../core/output.js";
import { projectCasesDir } from "../core/paths.js";
import {
  deleteCase,
  getCase,
  listCases,
  parseCaseJson,
  saveCase,
  updateCase,
  type TestCase,
} from "../core/cases.js";

export function registerCaseCommands(program: Command): void {
  const cases = program.command("cases").description("create and manage test cases (stored in .nat/cases/)");

  cases
    .command("list", { isDefault: true })
    .description("list the test cases in this project")
    .option("--tag <tag>", "only cases carrying this tag")
    .action(async (options: { tag?: string }) => {
      const all = await listCases();
      const filtered = options.tag ? all.filter((entry) => entry.tags.includes(options.tag!)) : all;

      emit({ cases: filtered, dir: projectCasesDir() }, () => {
        if (filtered.length === 0) {
          return [
            "No test cases yet.",
            "",
            "Create one:",
            `  nat cases create '{"title": "Login", "tags": ["smoke"], "flows": [{"instructions": "tap Sign in, enter credentials", "result": "the home screen shows"}]}'`,
          ].join("\n");
        }
        return table(
          ["ID", "TITLE", "TAGS", "FLOWS"],
          filtered.map((entry) => [entry.id, entry.title, entry.tags.join(","), String(entry.flows.length)]),
        );
      });
    });

  cases
    .command("get")
    .description("show one case as JSON")
    .argument("<id>", "case id or title")
    .action(async (id: string) => {
      const found = await getCase(id);
      emit(found, () => renderCase(found));
    });

  cases
    .command("create")
    .description("create a case from JSON")
    .argument("[json]", 'e.g. \'{"title": "Login", "flows": [{"instructions": "…"}]}\'')
    .option("--file <path>", "read the JSON from a file instead ( `-` for stdin )")
    .action(async (json: string | undefined, options: { file?: string }) => {
      const raw = await readInput(json, options.file);
      const created = await saveCase(parseCaseJson(raw));
      emit(created, `${color.green("Created")} ${created.id} — ${created.title}`);
    });

  cases
    .command("update")
    .description("edit fields of an existing case")
    .argument("<id>", "case id or title")
    .argument("[json]", 'e.g. \'{"tags": ["smoke", "regression"]}\'')
    .option("--file <path>", "read the JSON from a file instead ( `-` for stdin )")
    .action(async (id: string, json: string | undefined, options: { file?: string }) => {
      const raw = await readInput(json, options.file);
      const updated = await updateCase(id, parseCaseJson(raw));
      emit(updated, `${color.green("Updated")} ${updated.id} — ${updated.title}`);
    });

  cases
    .command("delete")
    .description("remove a case")
    .argument("<id>", "case id or title")
    .action(async (id: string) => {
      const removed = await deleteCase(id);
      emit({ ok: true, deleted: removed.id }, `${color.green("Deleted")} ${removed.id}`);
    });
}

async function readInput(inline: string | undefined, file: string | undefined): Promise<string> {
  if (inline) return inline;
  if (file === "-") return await readStdin();
  if (file) return await readFile(file, "utf8");
  return await readStdin();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function renderCase(entry: TestCase): string {
  const lines = [
    `${color.bold(entry.title)}  ${color.dim(`(${entry.id})`)}`,
    entry.tags.length > 0 ? `tags: ${entry.tags.join(", ")}` : "",
    entry.app ? `app:  ${entry.app}` : "",
    "",
  ].filter(Boolean);

  entry.flows.forEach((flow, index) => {
    lines.push(`${index + 1}. ${flow.instructions}`);
    if (flow.result) lines.push(color.dim(`   expect: ${flow.result}`));
  });
  return lines.join("\n");
}
