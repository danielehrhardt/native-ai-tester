/**
 * Test cases.
 *
 * A case is a title, some tags, and one or more flows written in plain English.
 * They live in the repository under `.nat/cases/` as JSON — reviewed in pull
 * requests, versioned with the code they test, and readable without this tool
 * installed. There is no server and no account: a test case is a file.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NatError } from "./errors.js";
import { projectCasesDir } from "./paths.js";

export interface TestFlow {
  /** What to do, step by step, in plain language. */
  instructions: string;
  /** What should be true afterwards. Optional but strongly recommended. */
  result?: string;
}

export interface TestCase {
  id: string;
  title: string;
  tags: string[];
  /** Bundle id / package name this case runs against. */
  app?: string;
  flows: TestFlow[];
  createdAt: string;
  updatedAt: string;
}

export type TestCaseInput = Partial<Omit<TestCase, "createdAt" | "updatedAt">> & { title?: string };

export async function listCases(dir = projectCasesDir()): Promise<TestCase[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const cases: TestCase[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const loaded = await readCaseFile(join(dir, entry));
    if (loaded) cases.push(loaded);
  }
  return cases;
}

export async function getCase(id: string, dir = projectCasesDir()): Promise<TestCase> {
  const direct = await readCaseFile(join(dir, `${slugify(id)}.json`));
  if (direct) return direct;

  // Fall back to a title match so `nat run "Login"` works without knowing the slug.
  const all = await listCases(dir);
  const match = all.find(
    (entry) => entry.id === id || entry.title.toLowerCase() === id.toLowerCase(),
  );
  if (match) return match;

  throw new NatError("INVALID_ARGUMENT", `No test case matches \`${id}\``, {
    hint:
      all.length > 0
        ? `Available:\n${all.map((entry) => `  ${entry.id}  ${entry.title}`).join("\n")}`
        : "Create one with `nat cases create '{\"title\": \"Login\", \"flows\": [...]}'`.",
  });
}

export async function saveCase(input: TestCaseInput, dir = projectCasesDir()): Promise<TestCase> {
  const title = input.title?.trim();
  if (!title) {
    throw new NatError("INVALID_ARGUMENT", "A test case needs a `title`");
  }
  const flows = normalizeFlows(input.flows);
  if (flows.length === 0) {
    throw new NatError("INVALID_ARGUMENT", "A test case needs at least one flow", {
      hint: 'Example: {"title": "Login", "flows": [{"instructions": "tap Sign in, enter credentials", "result": "home screen shows"}]}',
    });
  }

  const id = slugify(input.id ?? title);
  const now = new Date().toISOString();
  const existing = await readCaseFile(join(dir, `${id}.json`));

  const record: TestCase = {
    id,
    title,
    tags: input.tags ?? existing?.tags ?? [],
    ...(input.app ?? existing?.app ? { app: input.app ?? existing?.app } : {}),
    flows,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export async function updateCase(id: string, patch: TestCaseInput, dir = projectCasesDir()): Promise<TestCase> {
  const existing = await getCase(id, dir);
  return await saveCase(
    {
      ...existing,
      ...patch,
      id: existing.id,
      flows: patch.flows ? normalizeFlows(patch.flows) : existing.flows,
    },
    dir,
  );
}

export async function deleteCase(id: string, dir = projectCasesDir()): Promise<TestCase> {
  const existing = await getCase(id, dir);
  await rm(join(dir, `${existing.id}.json`), { force: true });
  return existing;
}

export function parseCaseJson(raw: string): TestCaseInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new NatError("INVALID_ARGUMENT", "The test case must be valid JSON", {
      hint: 'Example: \'{"title": "Login", "tags": ["smoke"], "flows": [{"instructions": "tap Sign in", "result": "home screen shows"}]}\'',
      cause,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NatError("INVALID_ARGUMENT", "The test case must be a JSON object");
  }
  return parsed as TestCaseInput;
}

async function readCaseFile(path: string): Promise<TestCase | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as TestCase;
    return parsed.title ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFlows(flows: TestFlow[] | undefined): TestFlow[] {
  if (!Array.isArray(flows)) return [];
  return flows
    .map((flow) => ({
      instructions: String(flow?.instructions ?? "").trim(),
      ...(flow?.result ? { result: String(flow.result).trim() } : {}),
    }))
    .filter((flow) => flow.instructions.length > 0);
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) {
    throw new NatError("INVALID_ARGUMENT", `Cannot derive a file name from \`${value}\``);
  }
  return slug;
}
