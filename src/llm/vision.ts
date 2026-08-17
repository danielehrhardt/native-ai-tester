/**
 * Vision grounding — turning a description into a coordinate from pixels alone.
 *
 * This is the escape hatch for screens with no usable accessibility tree: Unity
 * and Unreal games, canvases, WebViews, ad overlays, video players. The tree
 * resolver in `core/grounding.ts` handles everything else, and this path is
 * only reached when it cannot answer — see the header there for why that order
 * matters.
 *
 * Bring your own model. There is no ai-tester account, no proxy and no hosted
 * inference: point the tool at Anthropic, at any OpenAI-compatible endpoint
 * (Ollama, vLLM, LM Studio), or at nothing at all — in which case grounding is
 * simply tree-only and the CLI says so.
 */

import Anthropic from "@anthropic-ai/sdk";
import { NatError } from "../core/errors.js";
import { debug } from "../core/output.js";
import type { GroundingConfig, NatConfig } from "../core/config.js";
import type { Point } from "../core/types.js";

export interface VisionResult {
  found: boolean;
  point?: Point;
  confidence?: number;
  reason?: string;
}

/** Model defaults. Overridable with `nat config set grounding.model <id>`. */
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-4o",
  "openai-compatible": "qwen2.5-vl",
};

const API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

type ResolvedProvider = "anthropic" | "openai" | "openai-compatible";

interface ResolvedVision {
  provider: ResolvedProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export function resolveVision(config: NatConfig): ResolvedVision | undefined {
  const grounding: GroundingConfig = config.grounding ?? {};
  const requested = grounding.provider ?? "auto";
  if (requested === "off" || requested === "tree") return undefined;

  const candidates: ResolvedProvider[] =
    requested === "auto" ? ["anthropic", "openai", "openai-compatible"] : [requested];

  for (const provider of candidates) {
    const keyEnv = grounding.apiKeyEnv ?? API_KEY_ENV[provider]!;
    const apiKey = process.env[keyEnv];
    const baseUrl = grounding.baseUrl ?? (provider === "openai-compatible" ? process.env.NAT_GROUNDING_BASE_URL : undefined);

    // A local OpenAI-compatible server (Ollama, LM Studio) needs no key, so a
    // base URL alone is enough to consider that provider configured.
    if (!apiKey && !(provider === "openai-compatible" && baseUrl)) continue;

    return {
      provider,
      model: grounding.model ?? DEFAULT_MODELS[provider]!,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  return undefined;
}

export function isVisionConfigured(config: NatConfig): boolean {
  return resolveVision(config) !== undefined;
}

/** The hint shown when the tree cannot resolve a description and no model is set up. */
export function describeVisionSetup(config: NatConfig): string {
  const provider = config.grounding?.provider ?? "auto";
  if (provider === "tree" || provider === "off") {
    return "Vision grounding is disabled (`grounding.provider` is set to `" + provider + "`).";
  }
  return [
    "The accessibility tree has no element matching that description, and no vision model is configured.",
    "Either target the element by coordinates from `nat screen`, or enable vision grounding:",
    "  export ANTHROPIC_API_KEY=…            # or OPENAI_API_KEY",
    "  nat config set grounding.provider anthropic",
    "Local models work too: `nat config set grounding.provider openai-compatible` with `grounding.baseUrl`.",
  ].join("\n");
}

export async function groundWithVision(
  config: NatConfig,
  image: Buffer,
  description: string,
): Promise<VisionResult> {
  const resolved = resolveVision(config);
  if (!resolved) {
    throw new NatError("GROUNDING_UNAVAILABLE", "No vision model is configured", {
      hint: describeVisionSetup(config),
    });
  }

  debug(`vision: grounding "${description}" with ${resolved.provider}/${resolved.model}`);
  const started = Date.now();
  const result =
    resolved.provider === "anthropic"
      ? await groundWithAnthropic(resolved, image, description)
      : await groundWithOpenAiCompatible(resolved, image, description);
  debug(`vision: answered in ${Date.now() - started}ms — ${JSON.stringify(result)}`);
  return result;
}

// ---------------------------------------------------------------- prompting

/**
 * The model returns coordinates in the same relative 0–1000 space the rest of
 * the tool speaks, so nothing downstream has to know the device's resolution.
 */
const SYSTEM_PROMPT = [
  "You locate UI elements in mobile app screenshots for an automated test runner.",
  "The screenshot is one device screen. Report positions in a resolution-independent",
  "coordinate space: x and y both run 0–1000, with (0,0) at the top-left corner and",
  "(1000,1000) at the bottom-right, regardless of the image's pixel dimensions.",
  "Return the point a finger should tap — the visual centre of the element.",
  "If the described element is not visible, say so instead of guessing.",
].join(" ");

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean", description: "Whether the described element is visible." },
    x: { type: "number", description: "Horizontal tap position, 0–1000. 0 when not found." },
    y: { type: "number", description: "Vertical tap position, 0–1000. 0 when not found." },
    confidence: { type: "number", description: "How certain you are, 0–1." },
    reason: {
      type: "string",
      description: "One short sentence: what you matched, or why nothing matched.",
    },
  },
  required: ["found", "x", "y", "confidence", "reason"],
  additionalProperties: false,
} as const;

function userPrompt(description: string): string {
  return `Find this element: "${description}"\n\nReturn its tap point in the 0–1000 coordinate space.`;
}

// ---------------------------------------------------------------- Anthropic

async function groundWithAnthropic(
  resolved: ResolvedVision,
  image: Buffer,
  description: string,
): Promise<VisionResult> {
  const client = new Anthropic({
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    ...(resolved.baseUrl ? { baseURL: resolved.baseUrl } : {}),
    maxRetries: 2,
  });

  const response = await client.messages.create({
    model: resolved.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    // `low` effort is right here: this is perception, not reasoning, and an
    // agent runs grounding on many steps of a test.
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: RESULT_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: image.toString("base64") },
          },
          { type: "text", text: userPrompt(description) },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new NatError("GROUNDING_UNAVAILABLE", "The vision model declined the screenshot", {
      hint: "Target the element by coordinates from `nat screen` instead.",
      details: { stopDetails: response.stop_details },
    });
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return parseVisionJson(text);
}

// -------------------------------------------------- OpenAI-compatible chat

async function groundWithOpenAiCompatible(
  resolved: ResolvedVision,
  image: Buffer,
  description: string,
): Promise<VisionResult> {
  const baseUrl = (resolved.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(resolved.apiKey ? { authorization: `Bearer ${resolved.apiKey}` } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${SYSTEM_PROMPT} Reply with JSON: {"found":bool,"x":number,"y":number,"confidence":number,"reason":string}.` },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
              },
              { type: "text", text: userPrompt(description) },
            ],
          },
        ],
      }),
    });
  } catch (cause) {
    throw new NatError("GROUNDING_UNAVAILABLE", `Could not reach the vision model at ${baseUrl}`, {
      hint: "Check `grounding.baseUrl` and that the server is running.",
      cause,
    });
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text();
  if (!response.ok) {
    throw new NatError("GROUNDING_UNAVAILABLE", `Vision model returned HTTP ${response.status}`, {
      details: { body: body.slice(0, 500) },
    });
  }

  const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> };
  return parseVisionJson(parsed.choices?.[0]?.message?.content ?? "");
}

// ---------------------------------------------------------------- parsing

export function parseVisionJson(text: string): VisionResult {
  const json = extractJson(text);
  if (!json) {
    return { found: false, reason: "The model did not return usable JSON" };
  }
  if (json["found"] !== true) {
    return {
      found: false,
      ...(typeof json["reason"] === "string" ? { reason: json["reason"] } : {}),
    };
  }

  const x = Number(json["x"]);
  const y = Number(json["y"]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { found: false, reason: "The model reported a match but no usable coordinates" };
  }

  return {
    found: true,
    point: { x: clamp(x), y: clamp(y) },
    confidence: Number.isFinite(Number(json["confidence"])) ? Number(json["confidence"]) : 0.6,
    ...(typeof json["reason"] === "string" ? { reason: json["reason"] } : {}),
  };
}

/** Models occasionally wrap JSON in prose or a code fence; take the object. */
function extractJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const braced = /\{[\s\S]*\}/.exec(trimmed);
  if (braced?.[0]) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function clamp(value: number): number {
  return Math.min(1000, Math.max(0, Math.round(value * 10) / 10));
}
