import { describe, expect, it, beforeEach } from "vitest";
import { describeVisionSetup, isVisionConfigured, parseVisionJson, resolveVision } from "../src/llm/vision.js";

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.NAT_GROUNDING_BASE_URL;
});

describe("parseVisionJson", () => {
  it("reads a clean response", () => {
    const result = parseVisionJson('{"found": true, "x": 500, "y": 812, "confidence": 0.9, "reason": "blue button"}');
    expect(result.found).toBe(true);
    expect(result.point).toEqual({ x: 500, y: 812 });
    expect(result.confidence).toBe(0.9);
  });

  it("recovers JSON from a fenced code block", () => {
    const result = parseVisionJson('Here you go:\n```json\n{"found": true, "x": 10, "y": 20, "confidence": 0.5, "reason": "x"}\n```');
    expect(result.point).toEqual({ x: 10, y: 20 });
  });

  it("recovers JSON wrapped in prose", () => {
    const result = parseVisionJson('I looked. {"found": false, "x": 0, "y": 0, "confidence": 0, "reason": "not visible"} Hope that helps.');
    expect(result.found).toBe(false);
    expect(result.reason).toBe("not visible");
  });

  it("clamps coordinates into the 0–1000 space", () => {
    const result = parseVisionJson('{"found": true, "x": 1400, "y": -30, "confidence": 1, "reason": "x"}');
    expect(result.point).toEqual({ x: 1000, y: 0 });
  });

  it("treats a match with unusable coordinates as not found", () => {
    const result = parseVisionJson('{"found": true, "x": "left-ish", "y": null, "confidence": 1, "reason": "x"}');
    expect(result.found).toBe(false);
  });

  it("does not crash on a non-JSON answer", () => {
    const result = parseVisionJson("I could not find it, sorry.");
    expect(result.found).toBe(false);
    expect(result.reason).toMatch(/usable JSON/);
  });
});

describe("provider resolution", () => {
  it("is unconfigured when nothing is set — grounding stays tree-only", () => {
    expect(resolveVision({})).toBeUndefined();
    expect(isVisionConfigured({})).toBe(false);
  });

  it("picks Anthropic when its key is present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const resolved = resolveVision({ grounding: { provider: "auto" } });
    expect(resolved?.provider).toBe("anthropic");
    expect(resolved?.model).toBe("claude-opus-5");
  });

  it("falls through to OpenAI when only that key is present", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(resolveVision({ grounding: { provider: "auto" } })?.provider).toBe("openai");
  });

  it("accepts a local server with a base URL and no key at all", () => {
    const resolved = resolveVision({
      grounding: { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llava" },
    });
    expect(resolved?.provider).toBe("openai-compatible");
    expect(resolved?.model).toBe("llava");
  });

  it("honours an explicit model override", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(resolveVision({ grounding: { provider: "anthropic", model: "claude-sonnet-5" } })?.model).toBe(
      "claude-sonnet-5",
    );
  });

  it("stays off when the user turned it off, even with a key present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(resolveVision({ grounding: { provider: "off" } })).toBeUndefined();
    expect(resolveVision({ grounding: { provider: "tree" } })).toBeUndefined();
  });
});

describe("describeVisionSetup", () => {
  it("says how to turn it on", () => {
    expect(describeVisionSetup({})).toContain("ANTHROPIC_API_KEY");
  });

  it("says it is switched off when it is", () => {
    expect(describeVisionSetup({ grounding: { provider: "tree" } })).toMatch(/disabled/);
  });
});
