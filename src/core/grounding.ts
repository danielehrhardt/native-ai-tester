/**
 * Grounding: turning "the blue login button at the bottom" into a coordinate.
 *
 * Two resolvers, tried in order:
 *
 *  1. **Tree grounding** — match the description against the accessibility
 *     tree. Free, instant, deterministic, and correct for the great majority of
 *     native and cross-platform screens.
 *
 *  2. **Vision grounding** — hand a screenshot and the description to a
 *     multimodal model. This is what makes games, canvases, WebViews and ad
 *     overlays testable at all, since they expose no usable tree.
 *
 * The order matters for cost as much as accuracy: an agent runs grounding on
 * most steps, and a tree match costs nothing while a vision call costs a model
 * request. We only pay when the free path genuinely cannot answer.
 */

import { NatError } from "./errors.js";
import { areaOf } from "./coords.js";
import { flatten, isInteractive } from "./tree.js";
import type { Point, ScreenSnapshot, UiElement } from "./types.js";
import { loadConfig } from "./config.js";
import { groundWithVision, isVisionConfigured, describeVisionSetup } from "../llm/vision.js";
import { debug } from "./output.js";

export type GroundingMethod = "tree" | "vision" | "coordinates";

export interface GroundingResult {
  point: Point;
  method: GroundingMethod;
  element?: UiElement;
  /** 0–1. Tree matches report match strength; vision reports model confidence. */
  confidence: number;
  /** Runner-up matches, so an agent can retry with `--index` instead of guessing. */
  alternatives?: Array<{ label: string; point: Point; score: number }>;
  reason?: string;
}

export interface GroundOptions {
  /** Pick the Nth match (1-based) instead of the best one. */
  index?: number;
  /** Only consider elements whose role matches. */
  role?: string;
  /** Never call a model, even when the tree cannot answer. */
  treeOnly?: boolean;
  /** A screenshot for the vision resolver; captured lazily when omitted. */
  screenshot?: () => Promise<Buffer>;
}

const MIN_SCORE = 34;
const AMBIGUITY_MARGIN = 8;

export async function ground(
  snapshot: ScreenSnapshot,
  description: string,
  options: GroundOptions = {},
): Promise<GroundingResult> {
  const query = description.trim();
  if (!query) {
    throw new NatError("INVALID_ARGUMENT", "The description is empty");
  }

  const matches = rankElements(snapshot, query, options.role);

  if (options.index !== undefined) {
    const picked = matches[options.index - 1];
    if (!picked) {
      throw new NatError(
        "ELEMENT_NOT_FOUND",
        `Only ${matches.length} elements match "${query}", so --index ${options.index} is out of range`,
      );
    }
    return treeResult(picked, matches);
  }

  const best = matches[0];
  const runnerUp = matches[1];

  if (best && best.score >= MIN_SCORE) {
    if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN && !samePlace(best.element, runnerUp.element)) {
      throw new NatError("AMBIGUOUS_TARGET", `"${query}" matches ${countClose(matches, best.score)} elements equally well`, {
        hint:
          "Describe it more precisely, or pick one with --index:\n" +
          matches
            .slice(0, 5)
            .map((match, i) => `  --index ${i + 1}  ${describe(match.element)}`)
            .join("\n"),
        details: { candidates: matches.slice(0, 5).map((m) => describe(m.element)) },
      });
    }
    debug(`grounding: tree matched "${query}" → ${describe(best.element)} (score ${best.score.toFixed(1)})`);
    return treeResult(best, matches);
  }

  if (options.treeOnly) {
    throw notFound(query, matches, snapshot, "tree-only grounding was requested");
  }

  const config = await loadConfig();
  if (!isVisionConfigured(config)) {
    throw notFound(query, matches, snapshot, describeVisionSetup(config));
  }

  if (!options.screenshot) {
    throw new NatError("GROUNDING_UNAVAILABLE", "Vision grounding needs a screenshot but none was provided");
  }

  debug(`grounding: tree could not resolve "${query}", asking the vision model`);
  const image = await options.screenshot();
  const vision = await groundWithVision(config, image, query);
  if (!vision.found || !vision.point) {
    throw new NatError("ELEMENT_NOT_FOUND", `Could not find "${query}" on screen`, {
      hint:
        (vision.reason ? `The model looked and reported: ${vision.reason}\n` : "") +
        "Take a screenshot with `nat screenshot` to see the current state.",
    });
  }
  return {
    point: vision.point,
    method: "vision",
    confidence: vision.confidence ?? 0.6,
    ...(vision.reason ? { reason: vision.reason } : {}),
  };
}

function treeResult(match: ScoredElement, all: ScoredElement[]): GroundingResult {
  return {
    point: match.element.center,
    method: "tree",
    element: match.element,
    confidence: Math.min(1, match.score / 100),
    alternatives: all
      .slice(1, 4)
      .map((other) => ({ label: describe(other.element), point: other.element.center, score: round(other.score) })),
  };
}

function notFound(
  query: string,
  matches: ScoredElement[],
  snapshot: ScreenSnapshot,
  why: string,
): NatError {
  const near = matches.slice(0, 5).filter((match) => match.score > 8);
  return new NatError("ELEMENT_NOT_FOUND", `Nothing on screen matches "${query}"`, {
    hint:
      `${why}\n` +
      (near.length
        ? `Closest elements:\n${near.map((m) => `  ${describe(m.element)}`).join("\n")}`
        : snapshot.elements.length === 0
          ? "The screen exposes no accessibility tree at all (a game or canvas). Configure vision grounding — see `nat doctor`."
          : "Run `nat screen` to see what is actually there."),
    details: { candidates: near.map((m) => describe(m.element)) },
  });
}

// ----------------------------------------------------------------- scoring

interface ScoredElement {
  element: UiElement;
  score: number;
}

export function rankElements(snapshot: ScreenSnapshot, query: string, roleFilter?: string): ScoredElement[] {
  const hints = parseHints(query);
  const candidates = flatten(snapshot.elements).filter(
    (element) => !roleFilter || element.role === roleFilter,
  );

  return candidates
    .map((element) => ({ element, score: scoreElement(element, hints) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || areaOf(a.element.rect) - areaOf(b.element.rect));
}

interface QueryHints {
  raw: string;
  normalized: string;
  tokens: string[];
  role?: string;
  vertical?: "top" | "bottom" | "middle";
  horizontal?: "left" | "right" | "center";
}

/** Words that describe *what kind* of control the user means. */
const ROLE_WORDS: Array<[RegExp, string]> = [
  [/\bbuttons?\b|\bcta\b/, "button"],
  [/\bfields?\b|\binputs?\b|\btext ?box\b/, "field"],
  [/\bpassword\b/, "secure-field"],
  [/\bsearch (bar|field|box)\b/, "search-field"],
  [/\bswitch(es)?\b|\btoggles?\b/, "switch"],
  [/\bcheck ?box(es)?\b/, "checkbox"],
  [/\bsliders?\b/, "slider"],
  [/\blinks?\b/, "link"],
  [/\btabs?\b/, "tab"],
  [/\brows?\b|\bcells?\b|\blist items?\b/, "cell"],
  [/\bimages?\b|\bicons?\b|\bphotos?\b/, "image"],
];

/**
 * Words that are about *where* it is, not what it says.
 *
 * Kept deliberately narrow. Prepositions like "in" and "on" look positional but
 * appear inside real labels — dropping them would stop "the Sign in button"
 * from matching a button labelled "Sign in", which is the single most common
 * thing anyone types.
 */
const POSITION_WORDS = new Set([
  "top", "bottom", "left", "right", "center", "centre", "middle",
  "upper", "lower", "corner", "header", "footer",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "for", "with", "that", "this", "is", "it",
  "please", "tap", "click", "press", "select", "choose", "my", "your", "at", "of",
]);

/** Role nouns carry the role hint, so they must not also count as label text. */
const ROLE_NOUNS = new Set([
  "button", "buttons", "cta", "field", "fields", "input", "inputs", "textbox",
  "switch", "switches", "toggle", "toggles", "checkbox", "checkboxes", "slider",
  "sliders", "link", "links", "tab", "tabs", "row", "rows", "cell", "cells",
  "item", "items", "icon", "icons", "image", "images", "photo", "photos",
]);

function parseHints(query: string): QueryHints {
  const normalized = normalize(query);
  const role = ROLE_WORDS.find(([pattern]) => pattern.test(normalized))?.[1];

  const vertical = /\b(bottom|lower|footer)\b/.test(normalized)
    ? "bottom"
    : /\b(top|upper|header)\b/.test(normalized)
      ? "top"
      : /\b(middle|centre|center)\b/.test(normalized)
        ? "middle"
        : undefined;

  const horizontal = /\bleft\b/.test(normalized)
    ? "left"
    : /\bright\b/.test(normalized)
      ? "right"
      : undefined;

  const tokens = normalized
    .split(/\s+/)
    .filter(Boolean)
    .filter(
      (token) =>
        !STOP_WORDS.has(token) && !POSITION_WORDS.has(token) && !ROLE_NOUNS.has(token) && token.length > 1,
    );

  return { raw: query, normalized, tokens, role, vertical, horizontal };
}

function scoreElement(element: UiElement, hints: QueryHints): number {
  const haystacks = [element.label, element.value, element.placeholder, element.identifier]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map(normalize);

  if (haystacks.length === 0 && !hints.role) return 0;

  let textScore = 0;
  const meaningful = hints.tokens.join(" ");

  for (const haystack of haystacks) {
    if (!haystack) continue;
    if (haystack === hints.normalized || (meaningful && haystack === meaningful)) {
      textScore = Math.max(textScore, 100);
      continue;
    }
    if (meaningful && (haystack.startsWith(meaningful) || meaningful.startsWith(haystack))) {
      textScore = Math.max(textScore, 74);
      continue;
    }
    if (meaningful && haystack.includes(meaningful)) {
      textScore = Math.max(textScore, 62);
      continue;
    }
    textScore = Math.max(textScore, tokenOverlap(haystack, hints.tokens) * 58);
  }

  // A description made only of role and position words ("the button at the
  // bottom") carries no text to match, so role and geometry have to carry it.
  if (hints.tokens.length === 0) textScore = Math.max(textScore, hints.role ? 40 : 0);
  if (textScore === 0) return 0;

  let score = textScore;

  if (hints.role) {
    score += element.role === hints.role ? 16 : compatibleRole(element.role, hints.role) ? 6 : -14;
  }
  if (isInteractive(element)) score += 9;
  if (!element.enabled) score -= 26;

  score += positionBonus(element, hints);

  // A whole-screen container that happens to contain the words is almost never
  // the intended target.
  const area = areaOf(element.rect);
  if (area > 600_000) score -= 14;
  else if (area > 250_000) score -= 6;
  if (element.rect.width < 8 || element.rect.height < 8) score -= 6;

  return score;
}

function positionBonus(element: UiElement, hints: QueryHints): number {
  let bonus = 0;
  const { center } = element;
  if (hints.vertical === "top") bonus += center.y < 340 ? 13 : -9;
  if (hints.vertical === "bottom") bonus += center.y > 660 ? 13 : -9;
  if (hints.vertical === "middle") bonus += center.y >= 300 && center.y <= 700 ? 10 : -6;
  if (hints.horizontal === "left") bonus += center.x < 400 ? 11 : -8;
  if (hints.horizontal === "right") bonus += center.x > 600 ? 11 : -8;
  return bonus;
}

function compatibleRole(role: string, wanted: string): boolean {
  const families: string[][] = [
    ["field", "secure-field", "search-field"],
    ["button", "cell", "link", "tab", "menu-item"],
    ["switch", "checkbox", "radio"],
    ["image", "button"],
  ];
  return families.some((family) => family.includes(role) && family.includes(wanted));
}

function tokenOverlap(haystack: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const words = haystack.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  let matched = 0;
  for (const token of tokens) {
    const hit = words.some(
      (word) => word === token || word.startsWith(token) || token.startsWith(word) || (token.length > 4 && word.includes(token)),
    );
    if (hit) matched += 1;
  }
  const coverage = matched / tokens.length;
  // Prefer a short label that is entirely the query over a paragraph containing it.
  const density = matched / Math.max(words.length, tokens.length);
  return coverage * 0.75 + density * 0.25;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Two candidates resolving to the same spot are not a real ambiguity. */
function samePlace(a: UiElement, b: UiElement): boolean {
  return Math.abs(a.center.x - b.center.x) < 15 && Math.abs(a.center.y - b.center.y) < 15;
}

function countClose(matches: ScoredElement[], best: number): number {
  return matches.filter((match) => best - match.score < AMBIGUITY_MARGIN).length;
}

export function describe(element: UiElement): string {
  const name = element.label ?? element.value ?? element.identifier ?? "(unnamed)";
  return `${element.role} ${JSON.stringify(name)} @${element.center.x},${element.center.y}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
