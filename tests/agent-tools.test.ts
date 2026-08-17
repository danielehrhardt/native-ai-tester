import { describe, expect, it } from "vitest";
import { createDeviceTools, type AgentContext } from "../src/agent/tools.js";
import type { Driver } from "../src/core/types.js";

/**
 * `nat run` cannot be exercised end to end without a model, but the tool
 * surface it hands that model can — and a malformed schema there is a failure
 * that only shows up mid-run, after a device is already connected.
 */
function context(overrides: Partial<Driver> = {}): AgentContext {
  const driver = {
    platform: "ios",
    device: { id: "test", name: "iPhone", platform: "ios", kind: "simulator", state: "booted", ready: true },
    screenSize: async () => ({ width: 393, height: 852 }),
    screenshot: async () => Buffer.from("png"),
    rawSource: async () => ({}),
    normalizeSource: () => [],
    tap: async () => undefined,
    swipe: async () => undefined,
    drag: async () => undefined,
    typeText: async () => undefined,
    pressKey: async () => undefined,
    activateApp: async () => undefined,
    terminateApp: async () => undefined,
    backgroundApp: async () => undefined,
    openUrl: async () => undefined,
    currentApp: async () => undefined,
    installApp: async () => undefined,
    uninstallApp: async () => undefined,
    listApps: async () => [],
    handleAlert: async () => undefined,
    alertText: async () => undefined,
    connect: async () => undefined,
    dispose: async () => undefined,
    isAlive: async () => true,
    ...overrides,
  } as unknown as Driver;

  return { driver, steps: [], finish: new AbortController() };
}

/** The wire shape `betaTool` produces, which is what the model actually sees. */
interface WireTool {
  name: string;
  description: string;
  input_schema: { type: string; additionalProperties?: boolean; required?: string[] };
  run: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
}

describe("the tool surface handed to the model", () => {
  const tools = createDeviceTools(context()) as unknown as WireTool[];
  const names = tools.map((tool) => tool.name);

  it("covers the whole loop: read, act, verify, and record a verdict", () => {
    expect(names).toEqual([
      "read_screen",
      "take_screenshot",
      "tap",
      "swipe",
      "drag",
      "type_text",
      "press_key",
      "app_control",
      "open_url",
      "handle_alert",
      "wait",
      "finish_flow",
    ]);
  });

  it("describes every tool — the description is how the model decides to call it", () => {
    for (const tool of tools) {
      expect(tool.description.length, `${tool.name} needs a description`).toBeGreaterThan(40);
    }
  });

  it("closes every schema, so a hallucinated argument fails loudly", () => {
    for (const tool of tools) {
      expect(tool.input_schema.type, tool.name).toBe("object");
      expect(tool.input_schema.additionalProperties, `${tool.name} must reject unknown arguments`).toBe(false);
    }
  });
});

describe("step recording", () => {
  it("logs a failed action and hands the reason back instead of ending the run", async () => {
    const ctx = context({
      tap: async () => {
        throw new Error("element is covered by an overlay");
      },
    });
    const tap = (createDeviceTools(ctx) as unknown as WireTool[]).find((tool) => tool.name === "tap")!;

    const result = await tap.run({ x: 500, y: 500 });

    // An agent that gets a thrown error cannot adapt; one that gets a sentence can.
    expect(String(result)).toContain("FAILED");
    expect(String(result)).toContain("overlay");
    expect(ctx.steps).toHaveLength(1);
    expect(ctx.steps[0]!.ok).toBe(false);
    expect(ctx.steps[0]!.tool).toBe("tap");
  });

  it("records the verdict and stops the loop when the model finishes a flow", async () => {
    const ctx = context();
    const finish = (createDeviceTools(ctx) as unknown as WireTool[]).find((tool) => tool.name === "finish_flow")!;

    await finish.run({ passed: false, reason: "the home tab never appeared" });

    expect(ctx.verdict).toEqual({ passed: false, reason: "the home tab never appeared" });
    // The abort is what ends the runner deterministically, rather than hoping
    // the model stops calling tools of its own accord.
    expect(ctx.finish.signal.aborted).toBe(true);
  });

  it("numbers steps in the order they happened", async () => {
    const ctx = context();
    const tools = createDeviceTools(ctx) as unknown as WireTool[];
    const wait = tools.find((tool) => tool.name === "wait")!;
    const key = tools.find((tool) => tool.name === "press_key")!;

    await wait.run({ seconds: 0 });
    await key.run({ key: "home" });

    expect(ctx.steps.map((step) => [step.index, step.tool])).toEqual([
      [1, "wait"],
      [2, "press_key"],
    ]);
  });
});
