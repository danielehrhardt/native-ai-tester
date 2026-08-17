/**
 * `nat skill install` — teach a coding agent the commands.
 *
 * The skill is what turns "there is a CLI on your PATH" into "your agent knows
 * to read the screen before it taps, and to prefer the tree over a screenshot".
 * It ships in the package so it stays in step with the CLI it documents.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { emit, color } from "../core/output.js";
import { NatError } from "../core/errors.js";

const SKILL_NAME = "mobile-testing";
const AGENTS_START = "<!-- native-ai-tester:start -->";
const AGENTS_END = "<!-- native-ai-tester:end -->";

export function registerSkillCommands(program: Command): void {
  const skill = program.command("skill").description("install the agent skill that documents these commands");

  skill
    .command("install", { isDefault: true })
    .description("install the mobile-testing skill for Claude Code and compatible agents")
    .option("--global", "install for every project (~/.claude/skills) instead of this one")
    .option("--agents-md", "also add a pointer to AGENTS.md, for agents that read it (Codex, Cursor)")
    .action(async (options: { global?: boolean; agentsMd?: boolean }) => {
      const source = await locateSkill();
      const root = options.global ? join(homedir(), ".claude") : join(process.cwd(), ".claude");
      const target = join(root, "skills", SKILL_NAME);

      await mkdir(target, { recursive: true });
      await copyFile(source, join(target, "SKILL.md"));

      const written = [join(target, "SKILL.md")];
      if (options.agentsMd) written.push(await updateAgentsMd(process.cwd()));

      emit(
        { ok: true, installed: written, scope: options.global ? "global" : "project" },
        () =>
          [
            `${color.green("Installed")} the ${SKILL_NAME} skill:`,
            ...written.map((path) => `  ${path}`),
            "",
            "Restart your agent session so it picks the skill up.",
          ].join("\n"),
      );
    });

  skill
    .command("path")
    .description("print the path to the bundled skill file")
    .action(async () => {
      const source = await locateSkill();
      emit({ path: source }, source);
    });
}

/** The skill ships next to `dist/`, so walk up from this module to find it. */
async function locateSkill(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "skills", SKILL_NAME, "SKILL.md"),
    resolve(here, "..", "..", "..", "skills", SKILL_NAME, "SKILL.md"),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new NatError("MISSING_DEPENDENCY", "The bundled skill file is missing from this installation", {
    hint: "Reinstall with `npm install -g native-ai-tester`.",
  });
}

/**
 * Add (or refresh) a short block in AGENTS.md between markers, so re-running
 * this never duplicates it and never clobbers what else is in the file.
 */
async function updateAgentsMd(cwd: string): Promise<string> {
  const path = join(cwd, "AGENTS.md");
  const block = [
    AGENTS_START,
    "## Mobile testing",
    "",
    "This project can be tested on a real iOS or Android device with the `nat` CLI.",
    "",
    "```bash",
    "nat devices                       # list phones, simulators, emulators",
    "nat devices connect <device-id>   # connect once",
    "nat screen                        # read the UI as an element tree",
    "nat action tap --x 500 --y 320    # act on coordinates from `nat screen`",
    'nat action tap -d "Login button"  # …or by description, when the tree has nothing',
    "nat screen                        # verify the result",
    "```",
    "",
    "Work in an inspect → act → verify loop: one action at a time, re-reading the screen",
    "after each. Coordinates are relative (0–1000 on both axes) and resolution-independent.",
    "Full reference: `.claude/skills/mobile-testing/SKILL.md`, or `nat --help`.",
    AGENTS_END,
  ].join("\n");

  const existing = await readFile(path, "utf8").catch(() => "");
  let next: string;

  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start !== -1 && end !== -1) {
    next = existing.slice(0, start) + block + existing.slice(end + AGENTS_END.length);
  } else if (existing.trim()) {
    next = `${existing.trimEnd()}\n\n${block}\n`;
  } else {
    next = `# Agent guide\n\n${block}\n`;
  }

  await writeFile(path, next, "utf8");
  return path;
}
