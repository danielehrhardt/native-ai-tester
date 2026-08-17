/**
 * The device tools handed to the model during `nat run`.
 *
 * These are deliberately the *same* capabilities the CLI exposes — the agent
 * has no privileged path. Anything `nat run` can do, a developer (or a coding
 * agent driving the CLI directly) can do by hand, which is what makes a failing
 * run reproducible step by step.
 */

import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { setTimeout as delay } from "node:timers/promises";
import { readScreen } from "../core/screen.js";
import { renderSnapshot } from "../core/tree.js";
import { toDevicePoint } from "../core/coords.js";
import { isNatError } from "../core/errors.js";
import type { AlertAction, Driver, Point } from "../core/types.js";
import { resolveTarget, directionToSwipe } from "../commands/shared.js";

export interface AgentStep {
  index: number;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  ok: boolean;
  at: string;
}

export interface FlowVerdict {
  passed: boolean;
  reason: string;
}

/** Shared mutable state threaded through the tool implementations. */
export interface AgentContext {
  driver: Driver;
  steps: AgentStep[];
  verdict?: FlowVerdict;
  /** Aborted as soon as the model records a verdict, ending the loop. */
  finish: AbortController;
  onStep?: (step: AgentStep) => void;
}

/** Target flags shared by the gesture tools. */
const TARGET_PROPERTIES = {
  x: { type: "number", description: "Horizontal tap position in the 0-1000 space." },
  y: { type: "number", description: "Vertical tap position in the 0-1000 space." },
  description: {
    type: "string",
    description:
      "Plain-language description of the element, used when the tree gives you nothing to aim at (games, canvases, WebViews).",
  },
} as const;

export function createDeviceTools(context: AgentContext) {
  return [
    betaTool({
      name: "read_screen",
      description:
        "Read the current screen as a cleaned element tree with tap coordinates. Do this before every action and again afterwards to verify the result. Far cheaper than a screenshot — prefer it.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () =>
        record(context, "read_screen", {}, async () => {
          const snapshot = await readScreen(context.driver);
          return renderSnapshot(snapshot);
        }),
    }),

    betaTool({
      name: "take_screenshot",
      description:
        "Capture the screen as an image. Use this only when the element tree is empty or does not describe what you need to see — a game, a canvas, a chart, a rendering bug.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const image = await context.driver.screenshot();
        push(context, "take_screenshot", {}, `captured ${image.length} bytes`, true);
        return [
          {
            type: "image" as const,
            source: { type: "base64" as const, media_type: "image/png" as const, data: image.toString("base64") },
          },
        ];
      },
    }),

    betaTool({
      name: "tap",
      description:
        "Tap, double-tap or long-press. Give either x and y from read_screen, or a description of the element.",
      inputSchema: {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          double: { type: "boolean", description: "Double tap instead of a single tap." },
          duration: { type: "number", description: "Hold this many seconds, turning the tap into a long press." },
        },
        additionalProperties: false,
      },
      run: async (input) =>
        record(context, "tap", input as Record<string, unknown>, async () => {
          const target = await resolveTarget(context.driver, toTargetOptions(input));
          await context.driver.tap(target.point, {
            ...(input.double ? { double: true } : {}),
            ...(input.duration ? { duration: input.duration } : {}),
          });
          return `tapped ${target.relative.x},${target.relative.y}`;
        }),
    }),

    betaTool({
      name: "swipe",
      description:
        "Swipe or scroll. Give a direction to swipe across the middle of the screen, explicit from/to points, or a description to swipe on a particular element.",
      inputSchema: {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Direction the finger travels." },
          x2: { type: "number", description: "End x, when giving explicit points." },
          y2: { type: "number", description: "End y, when giving explicit points." },
          duration: { type: "number", description: "Gesture duration in seconds." },
        },
        additionalProperties: false,
      },
      run: async (input) =>
        record(context, "swipe", input as Record<string, unknown>, async () => {
          const { from, to } = await swipePoints(context.driver, input);
          const screen = await context.driver.screenSize();
          await context.driver.swipe(toDevicePoint(from, screen), toDevicePoint(to, screen), {
            ...(input.duration ? { duration: input.duration } : {}),
          });
          return `swiped ${from.x},${from.y} to ${to.x},${to.y}`;
        }),
    }),

    betaTool({
      name: "drag",
      description: "Press, hold and drag — for reordering lists and dropping an item onto a target.",
      inputSchema: {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          x2: { type: "number", description: "End x." },
          y2: { type: "number", description: "End y." },
          duration: { type: "number", description: "Gesture duration in seconds." },
        },
        additionalProperties: false,
      },
      run: async (input) =>
        record(context, "drag", input as Record<string, unknown>, async () => {
          const { from, to } = await swipePoints(context.driver, input);
          const screen = await context.driver.screenSize();
          await context.driver.drag(toDevicePoint(from, screen), toDevicePoint(to, screen), {
            ...(input.duration ? { duration: input.duration } : {}),
          });
          return `dragged ${from.x},${from.y} to ${to.x},${to.y}`;
        }),
    }),

    betaTool({
      name: "type_text",
      description: "Tap a field and type into it. Omit the target to type into whatever already has focus.",
      inputSchema: {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          text: { type: "string", description: "The text to type." },
          clear: { type: "boolean", description: "Clear the field first." },
          submit: { type: "boolean", description: "Press enter afterwards." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      run: async (input) =>
        record(context, "type_text", input as Record<string, unknown>, async () => {
          const hasTarget = input.x !== undefined || input.description !== undefined;
          let clearLength: number | undefined;
          if (hasTarget) {
            const target = await resolveTarget(context.driver, toTargetOptions(input));
            await context.driver.tap(target.point);
            clearLength = target.grounding?.element?.value?.length;
          }
          await context.driver.typeText(input.text, {
            ...(input.clear ? { clear: true } : {}),
            ...(clearLength !== undefined ? { clearLength } : {}),
            ...(input.submit ? { submit: true } : {}),
          });
          return `typed ${JSON.stringify(input.text)}`;
        }),
    }),

    betaTool({
      name: "press_key",
      description: "Press a hardware or keyboard key: home, back, enter, tab, escape, volumeup, volumedown.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", description: "The key name." } },
        required: ["key"],
        additionalProperties: false,
      },
      run: async (input) =>
        record(context, "press_key", input as Record<string, unknown>, async () => {
          await context.driver.pressKey(input.key);
          return `pressed ${input.key}`;
        }),
    }),

    betaTool({
      name: "app_control",
      description:
        "Foreground, quit or restart an app. `restart` is the reliable way back to a known starting state.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["activate", "terminate", "restart", "background"] },
          bundle_id: { type: "string", description: "iOS bundle id or Android package name. Not needed for `background`." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      run: async (input) =>
        record(context, "app_control", input as Record<string, unknown>, async () => {
          const bundleId = input.bundle_id;
          switch (input.action) {
            case "background":
              await context.driver.backgroundApp();
              return "sent the app to the background";
            case "activate":
              await context.driver.activateApp(requireBundleId(bundleId));
              return `activated ${bundleId}`;
            case "terminate":
              await context.driver.terminateApp(requireBundleId(bundleId));
              return `terminated ${bundleId}`;
            case "restart":
              await context.driver.terminateApp(requireBundleId(bundleId));
              await context.driver.activateApp(requireBundleId(bundleId));
              return `restarted ${bundleId}`;
          }
        }),
    }),

    betaTool({
      name: "open_url",
      description:
        "Open a URL or deep link. Use this to jump straight to a screen that would otherwise take several taps to reach, or to test that a deep link resolves to the right place.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
      run: async (input) =>
        record(context, "open_url", input as Record<string, unknown>, async () => {
          await context.driver.openUrl(input.url);
          return `opened ${input.url}`;
        }),
    }),

    betaTool({
      name: "handle_alert",
      description: "Accept or dismiss a system alert — permission prompts, sign-in sheets, rating requests.",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string", enum: ["accept", "dismiss"] } },
        required: ["action"],
        additionalProperties: false,
      },
      run: async (input) =>
        record(context, "handle_alert", input as Record<string, unknown>, async () => {
          const text = await context.driver.alertText().catch(() => undefined);
          await context.driver.handleAlert(input.action as AlertAction);
          return `${input.action}ed the alert${text ? `: ${text.slice(0, 120)}` : ""}`;
        }),
    }),

    betaTool({
      name: "wait",
      description:
        "Pause for a moment while the app settles — a network call, an animation, a splash screen. Prefer re-reading the screen over long waits.",
      inputSchema: {
        type: "object",
        properties: { seconds: { type: "number", description: "How long to wait, at most 30." } },
        required: ["seconds"],
        additionalProperties: false,
      },
      run: async (input) =>
        record(context, "wait", input as Record<string, unknown>, async () => {
          const seconds = Math.min(30, Math.max(0, input.seconds));
          await delay(seconds * 1000);
          return `waited ${seconds}s`;
        }),
    }),

    betaTool({
      name: "finish_flow",
      description:
        "Record the verdict for this flow and stop. Call it exactly once, when you have verified the expected result — or when you are certain the flow cannot pass.",
      inputSchema: {
        type: "object",
        properties: {
          passed: { type: "boolean", description: "Did the expected result actually happen?" },
          reason: {
            type: "string",
            description:
              "One or two sentences of evidence: what you saw on screen that proves the verdict. Name the elements you observed.",
          },
        },
        required: ["passed", "reason"],
        additionalProperties: false,
      },
      run: async (input) => {
        context.verdict = { passed: input.passed, reason: input.reason };
        push(context, "finish_flow", input as Record<string, unknown>, input.reason, input.passed);
        // End the loop deterministically rather than hoping the model stops.
        context.finish.abort();
        return input.passed ? "Recorded: passed." : "Recorded: failed.";
      },
    }),
  ];
}

function requireBundleId(bundleId: string | undefined): string {
  if (!bundleId) throw new Error("bundle_id is required for this action");
  return bundleId;
}

function toTargetOptions(input: { x?: number; y?: number; description?: string }) {
  return {
    ...(input.x !== undefined ? { x: input.x } : {}),
    ...(input.y !== undefined ? { y: input.y } : {}),
    ...(input.description ? { description: input.description } : {}),
  };
}

async function swipePoints(
  driver: Driver,
  input: { x?: number; y?: number; x2?: number; y2?: number; direction?: string; description?: string },
): Promise<{ from: Point; to: Point }> {
  if (input.x !== undefined && input.y !== undefined && input.x2 !== undefined && input.y2 !== undefined) {
    return { from: { x: input.x, y: input.y }, to: { x: input.x2, y: input.y2 } };
  }

  const direction = (input.direction ?? "up") as "up" | "down" | "left" | "right";
  if (input.description) {
    const target = await resolveTarget(driver, { description: input.description });
    const box = target.grounding?.element?.rect;
    const span = box ? Math.max(120, Math.min(box.width, box.height) * 0.8) : 400;
    return around(target.relative, direction, span);
  }
  return directionToSwipe(direction);
}

function around(center: Point, direction: "up" | "down" | "left" | "right", span: number): { from: Point; to: Point } {
  const half = span / 2;
  const clamp = (value: number) => Math.min(995, Math.max(5, Math.round(value * 10) / 10));
  switch (direction) {
    case "up":
      return { from: { x: center.x, y: clamp(center.y + half) }, to: { x: center.x, y: clamp(center.y - half) } };
    case "down":
      return { from: { x: center.x, y: clamp(center.y - half) }, to: { x: center.x, y: clamp(center.y + half) } };
    case "left":
      return { from: { x: clamp(center.x + half), y: center.y }, to: { x: clamp(center.x - half), y: center.y } };
    case "right":
      return { from: { x: clamp(center.x - half), y: center.y }, to: { x: clamp(center.x + half), y: center.y } };
  }
}

/**
 * Run a tool body, log it, and hand failures back to the model as text.
 *
 * A thrown error would end the run; a described failure lets the agent adapt —
 * which is the whole point of an agent driving the device rather than a script.
 */
async function record(
  context: AgentContext,
  tool: string,
  input: Record<string, unknown>,
  body: () => Promise<string>,
): Promise<string> {
  try {
    const summary = await body();
    push(context, tool, input, summary, true);
    return summary;
  } catch (error) {
    const message = isNatError(error)
      ? `${error.message}${error.hint ? `\nhint: ${error.hint}` : ""}`
      : error instanceof Error
        ? error.message
        : String(error);
    push(context, tool, input, message, false);
    return `FAILED: ${message}`;
  }
}

function push(
  context: AgentContext,
  tool: string,
  input: Record<string, unknown>,
  summary: string,
  ok: boolean,
): void {
  const step: AgentStep = {
    index: context.steps.length + 1,
    tool,
    input,
    summary,
    ok,
    at: new Date().toISOString(),
  };
  context.steps.push(step);
  context.onStep?.(step);
}
