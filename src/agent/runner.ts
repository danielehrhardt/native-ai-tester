/**
 * The test-running agent.
 *
 * `nat run` executes a plain-English test case autonomously: for each flow the
 * model reads the screen, acts, verifies, and records a verdict with the
 * evidence it saw. Every action it takes is one the CLI exposes, so a failure
 * can be replayed by hand from the step log.
 *
 * This is the one place the tool *needs* a model of its own. Everything else —
 * the device CLI, the element tree, tree grounding — runs with no account and
 * no API key, so a coding agent can drive the whole loop itself for free.
 */

import Anthropic from "@anthropic-ai/sdk";
import { NatError } from "../core/errors.js";
import { loadConfig, type NatConfig } from "../core/config.js";
import { debug } from "../core/output.js";
import type { TestCase } from "../core/cases.js";
import type { Driver } from "../core/types.js";
import { createDeviceTools, type AgentContext, type AgentStep, type FlowVerdict } from "./tools.js";

export interface FlowResult {
  index: number;
  instructions: string;
  expected?: string;
  passed: boolean;
  reason: string;
  steps: AgentStep[];
  durationMs: number;
}

export interface RunReport {
  case: { id: string; title: string; tags: string[] };
  device: { id: string; platform: string; name: string };
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: boolean;
  flows: FlowResult[];
}

export interface RunOptions {
  /** Hard ceiling on model turns per flow. */
  maxIterationsPerFlow?: number;
  /** Bundle id to bring to the foreground before the first flow. */
  app?: string;
  onStep?: (step: AgentStep, flowIndex: number) => void;
  onFlowStart?: (flow: { index: number; instructions: string; expected?: string }) => void;
  onFlowEnd?: (result: FlowResult) => void;
}

const SYSTEM_PROMPT = `You are a mobile QA engineer testing a real app on a real device.

You work in a tight loop: read the screen, take exactly one action, read the screen again to confirm it did what you expected, then decide the next action. Never fire several actions and hope.

Reading the screen
- \`read_screen\` returns the accessibility tree with a tap point for every element, in a resolution-independent 0-1000 coordinate space. Use it constantly; it is cheap.
- \`take_screenshot\` costs several times more. Reach for it only when the tree is empty or does not describe what you need to judge — a game, a canvas, a chart, a visual defect.

Acting
- Prefer coordinates straight from \`read_screen\`; they are exact and free.
- Use a \`description\` only when the tree has nothing usable to aim at.
- Real apps interrupt: permission dialogs, sign-in sheets, rating prompts, cookie banners, ads. Handle whatever stands between you and the test, then carry on.
- If the screen does not change after an action, do not repeat it blindly. Read the screen, work out why, and try a different route.

Judging
- Test what the flow asks, not what you assume the app should do.
- When you have verified the expected result — or established that it cannot happen — call \`finish_flow\` exactly once with the evidence you actually saw on screen. Name the elements. "The home screen shows" is not evidence; "the tab bar shows Home selected and the header reads 'Welcome, Alice'" is.
- A flow that cannot proceed is a fail with the reason, not an excuse to keep flailing.`;

export async function runTestCase(
  driver: Driver,
  testCase: TestCase,
  options: RunOptions = {},
): Promise<RunReport> {
  const config = await loadConfig();
  const { client, model } = createClient(config);

  const startedAt = new Date();
  const app = options.app ?? testCase.app ?? config.app;
  if (app) {
    debug(`run: activating ${app}`);
    await driver.activateApp(app).catch((error) => {
      throw new NatError("APP_NOT_FOUND", `Could not bring \`${app}\` to the foreground`, {
        hint: "Check the bundle id with `nat apps`, and that the build is installed.",
        cause: error,
      });
    });
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const flows: FlowResult[] = [];

  for (const [index, flow] of testCase.flows.entries()) {
    options.onFlowStart?.({ index: index + 1, instructions: flow.instructions, ...(flow.result ? { expected: flow.result } : {}) });

    const flowStarted = Date.now();
    const context: AgentContext = {
      driver,
      steps: [],
      finish: new AbortController(),
      onStep: (step) => options.onStep?.(step, index + 1),
    };

    messages.push({ role: "user", content: flowPrompt(testCase, flow, index, app) });

    const runner = client.beta.messages.toolRunner(
      {
        model,
        max_tokens: 8_000,
        system: SYSTEM_PROMPT,
        messages,
        tools: createDeviceTools(context),
        max_iterations: options.maxIterationsPerFlow ?? 40,
      },
      { signal: context.finish.signal },
    );

    let verdict: FlowVerdict;
    try {
      await runner;
      verdict = context.verdict ?? {
        passed: false,
        reason: "The agent stopped without recording a verdict — it may have run out of turns.",
      };
    } catch (error) {
      if (!context.finish.signal.aborted) throw wrapAgentError(error);
      // The abort is our own: `finish_flow` ended the loop on purpose.
      verdict = context.verdict ?? { passed: false, reason: "The run was interrupted." };
    }

    // Carry the conversation forward so later flows know what already happened.
    messages.splice(0, messages.length, ...(runner.params.messages as Anthropic.Beta.BetaMessageParam[]));

    const result: FlowResult = {
      index: index + 1,
      instructions: flow.instructions,
      ...(flow.result ? { expected: flow.result } : {}),
      passed: verdict.passed,
      reason: verdict.reason,
      steps: context.steps,
      durationMs: Date.now() - flowStarted,
    };
    flows.push(result);
    options.onFlowEnd?.(result);

    // A broken flow poisons everything after it — stop rather than report noise.
    if (!verdict.passed) break;
  }

  const finishedAt = new Date();
  return {
    case: { id: testCase.id, title: testCase.title, tags: testCase.tags },
    device: { id: driver.device.id, platform: driver.platform, name: driver.device.name },
    model,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    passed: flows.length === testCase.flows.length && flows.every((flow) => flow.passed),
    flows,
  };
}

function flowPrompt(
  testCase: TestCase,
  flow: { instructions: string; result?: string },
  index: number,
  app: string | undefined,
): string {
  const lines = [
    index === 0 ? `Test case: ${testCase.title}` : `Next flow in "${testCase.title}"`,
    ...(app && index === 0 ? [`App under test: ${app} (already in the foreground)`] : []),
    "",
    `Flow ${index + 1} of ${testCase.flows.length}`,
    `Do: ${flow.instructions}`,
  ];
  if (flow.result) lines.push(`Expected result: ${flow.result}`);
  else lines.push("No expected result was specified — judge whether the flow completed as described.");
  lines.push("", "Start by reading the screen. Call finish_flow when you have a verdict.");
  return lines.join("\n");
}

function createClient(config: NatConfig): { client: Anthropic; model: string } {
  const provider = config.grounding?.provider ?? "auto";
  const keyEnv = config.grounding?.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const apiKey = process.env[keyEnv];

  if (!apiKey) {
    throw new NatError("GROUNDING_UNAVAILABLE", "`nat run` needs a model to drive the device", {
      hint: [
        "Set an API key and try again:",
        `  export ${keyEnv}=…`,
        "",
        "Or skip `nat run` entirely: point your own coding agent at the CLI and let it run the loop —",
        "`nat screen`, `nat action tap …`, `nat screen` — which needs no key at all.",
      ].join("\n"),
    });
  }
  if (provider === "openai" || provider === "openai-compatible") {
    throw new NatError("UNSUPPORTED", `\`nat run\` does not support the \`${provider}\` provider yet`, {
      hint: "Vision grounding works with any provider; the autonomous runner currently needs Anthropic. Drive the CLI from your own agent for other models.",
    });
  }

  return {
    client: new Anthropic({ apiKey, maxRetries: 2 }),
    model: config.grounding?.model ?? "claude-opus-5",
  };
}

function wrapAgentError(error: unknown): unknown {
  if (error instanceof Anthropic.AuthenticationError) {
    return new NatError("GROUNDING_UNAVAILABLE", "The model rejected the API key", {
      hint: "Check ANTHROPIC_API_KEY.",
      cause: error,
    });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new NatError("TIMEOUT", "The model is rate limited", {
      hint: "Wait a moment and re-run, or lower `--max-steps`.",
      cause: error,
    });
  }
  return error;
}
