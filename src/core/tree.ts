/**
 * Accessibility-tree cleaning and rendering.
 *
 * A raw XCUITest or UiAutomator dump is mostly scaffolding: nested layout
 * containers with no name, no value and nothing to tap. An agent reads the
 * screen on *every* step of a test, so read cost dominates the whole run —
 * shrinking the tree to the elements that can actually be acted on is the
 * single biggest lever on how much a test costs to execute.
 *
 * The cleaner keeps a node when it carries information (a name, a value, an
 * identifier) or when it is interactive, and otherwise splices its children
 * into its parent. Structure that matters — a list containing rows containing
 * buttons — survives; structure that is pure layout does not.
 */

import { areaOf } from "./coords.js";
import type { Rect, ScreenSnapshot, UiElement } from "./types.js";

/** Roles a user can act on. Interactive nodes are never pruned. */
export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "field",
  "secure-field",
  "search-field",
  "switch",
  "checkbox",
  "radio",
  "slider",
  "stepper",
  "picker",
  "cell",
  "tab",
  "menu-item",
  "key",
  "segment",
]);

/** Roles that scroll — an agent needs their box to aim a swipe. */
export const CONTAINER_ROLES = new Set(["scroll", "table", "collection", "webview", "map", "canvas"]);

export interface CleanOptions {
  /** Keep everything; only normalize. Backs `nat screen --full`. */
  full?: boolean;
  /** Drop nodes smaller than this fraction of the 0–1000 space. */
  minSize?: number;
  /** Cap the emitted node count so a pathological screen cannot blow up context. */
  maxNodes?: number;
}

export function cleanTree(elements: UiElement[], options: CleanOptions = {}): UiElement[] {
  if (options.full) return elements;
  const cleaned = pruneList(elements, options);
  const capped = options.maxNodes ? capNodes(cleaned, options.maxNodes) : cleaned;
  return reindex(capped);
}

function pruneList(nodes: UiElement[], options: CleanOptions): UiElement[] {
  const out: UiElement[] = [];
  for (const node of nodes) {
    const children = pruneList(node.children, options);
    if (!isOnScreen(node.rect) || isTooSmall(node.rect, options.minSize)) {
      // The node itself is not addressable, but a mis-reported container must
      // not take a usable subtree down with it.
      out.push(...children);
      continue;
    }
    if (isInformative(node)) {
      out.push(collapseSingleChild({ ...node, children }));
    } else {
      // An unnamed wrapper is spliced out even when it branches: its children
      // each carry their own box and id, so nothing addressable is lost, and a
      // real screen is mostly these.
      out.push(...children);
    }
  }
  return dedupe(out);
}

/**
 * A wrapper that adds nothing over its only child (same name, same box) is
 * noise — `Other > Button "Sign in"` should read as one line, not two.
 */
function collapseSingleChild(node: UiElement): UiElement {
  if (node.children.length !== 1) return node;
  const child = node.children[0]!;
  if (!rectsEqual(node.rect, child.rect, 1)) return node;

  const sameName = (node.label ?? "") === (child.label ?? "");
  // Two different names on the same box are two facts, not one.
  if (!sameName && node.label && child.label) return node;

  // Same box, compatible names: keep whichever node says more. An interactive
  // role beats a generic one, and a named node beats an unnamed one.
  const parentSpecific = isInteractive(node) || Boolean(node.label ?? node.value);
  const childSpecific = isInteractive(child) || Boolean(child.label ?? child.value);

  if (isInteractive(child) && !isInteractive(node)) return { ...child, id: node.id };
  if (!parentSpecific) return { ...child, id: node.id };
  if (!childSpecific) return { ...node, children: child.children };
  return node;
}

/** Identical siblings stacked on the same box add nothing but tokens. */
function dedupe(nodes: UiElement[]): UiElement[] {
  const out: UiElement[] = [];
  for (const node of nodes) {
    const twin = out.find(
      (candidate) =>
        candidate.role === node.role &&
        (candidate.label ?? "") === (node.label ?? "") &&
        (candidate.value ?? "") === (node.value ?? "") &&
        rectsEqual(candidate.rect, node.rect, 0.5),
    );
    if (twin) {
      if (node.children.length > twin.children.length) twin.children = node.children;
      continue;
    }
    out.push(node);
  }
  return out;
}

export function isInformative(node: UiElement): boolean {
  if (isInteractive(node)) return true;
  if (CONTAINER_ROLES.has(node.role)) return true;
  if (node.role === "alert" || node.role === "sheet" || node.role === "keyboard") return true;
  return Boolean(
    (node.label && node.label.trim()) ||
      (node.value && node.value.trim()) ||
      (node.placeholder && node.placeholder.trim()),
  );
}

export function isInteractive(node: UiElement): boolean {
  return INTERACTIVE_ROLES.has(node.role);
}

function isOnScreen(rect: Rect): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.x + rect.width <= 0 || rect.y + rect.height <= 0) return false;
  return rect.x < 1000 && rect.y < 1000;
}

function isTooSmall(rect: Rect, minSize = 0): boolean {
  if (minSize <= 0) return false;
  return rect.width < minSize && rect.height < minSize;
}

function rectsEqual(a: Rect, b: Rect, tolerance: number): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

/**
 * Hard ceiling on emitted nodes. Rather than truncating the tail — which would
 * silently hide the bottom of the screen — the least informative leaves are
 * dropped first, so what survives is spread over the whole viewport.
 */
function capNodes(nodes: UiElement[], max: number): UiElement[] {
  if (countNodes(nodes) <= max) return nodes;
  const scored: Array<{ node: UiElement; score: number }> = [];
  walk(nodes, (node) => {
    scored.push({ node, score: informationScore(node) });
  });
  scored.sort((a, b) => a.score - b.score);
  const doomed = new Set<UiElement>();
  let remaining = scored.length - max;
  for (const entry of scored) {
    if (remaining <= 0) break;
    if (entry.node.children.length > 0) continue; // never orphan a subtree
    doomed.add(entry.node);
    remaining -= 1;
  }
  const filter = (list: UiElement[]): UiElement[] =>
    list
      .filter((node) => !doomed.has(node))
      .map((node) => ({ ...node, children: filter(node.children) }));
  return filter(nodes);
}

function informationScore(node: UiElement): number {
  let score = 0;
  if (isInteractive(node)) score += 100;
  if (CONTAINER_ROLES.has(node.role)) score += 40;
  if (node.identifier) score += 20;
  if (node.label) score += 10 + Math.min(10, node.label.length / 4);
  if (node.value) score += 8;
  score += Math.min(20, areaOf(node.rect) / 5000);
  return score;
}

export function reindex(nodes: UiElement[], prefix = ""): UiElement[] {
  return nodes.map((node, index) => {
    const id = prefix ? `${prefix}.${index}` : String(index);
    return { ...node, id, children: reindex(node.children, id) };
  });
}

export function walk(nodes: UiElement[], visit: (node: UiElement, depth: number) => void, depth = 0): void {
  for (const node of nodes) {
    visit(node, depth);
    walk(node.children, visit, depth + 1);
  }
}

export function flatten(nodes: UiElement[]): UiElement[] {
  const out: UiElement[] = [];
  walk(nodes, (node) => out.push(node));
  return out;
}

export function countNodes(nodes: UiElement[]): number {
  let count = 0;
  walk(nodes, () => {
    count += 1;
  });
  return count;
}

export function findById(nodes: UiElement[], id: string): UiElement | undefined {
  return flatten(nodes).find((node) => node.id === id);
}

/**
 * Render the snapshot the way an agent reads it.
 *
 * One element per line, indented by depth. Every line is self-sufficient: role,
 * name, the value if any, and the exact tap target — so a model can pick a
 * target and act without a second lookup.
 */
export function renderSnapshot(snapshot: ScreenSnapshot): string {
  const header =
    `${snapshot.platform} · ${snapshot.deviceId}` +
    (snapshot.app ? ` · ${snapshot.app}` : "") +
    ` · ${snapshot.screen.width}x${snapshot.screen.height}pt` +
    ` · ${snapshot.stats.keptNodes}/${snapshot.stats.rawNodes} elements`;

  const lines: string[] = [header, "coordinates are relative 0-1000 (x,y = tap point)"];
  if (snapshot.elements.length === 0) {
    lines.push("(no elements — the screen exposes no usable tree; use `nat screenshot` and target by description)");
    return lines.join("\n");
  }
  walk(snapshot.elements, (node, depth) => {
    lines.push(`${"  ".repeat(depth)}${renderElement(node)}`);
  });
  return lines.join("\n");
}

export function renderElement(node: UiElement): string {
  const parts = [`[${node.id}]`, node.role];
  if (node.label) parts.push(JSON.stringify(truncate(node.label, 120)));
  if (node.value && node.value !== node.label) parts.push(`=${JSON.stringify(truncate(node.value, 80))}`);
  if (node.placeholder && node.placeholder !== node.label) {
    parts.push(`placeholder=${JSON.stringify(truncate(node.placeholder, 60))}`);
  }
  if (node.identifier && node.identifier !== node.label) parts.push(`#${truncate(node.identifier, 60)}`);
  parts.push(`@${node.center.x},${node.center.y}`);
  parts.push(`${round(node.rect.width)}x${round(node.rect.height)}`);
  if (!node.enabled) parts.push("disabled");
  if (node.focused) parts.push("focused");
  if (node.selected) parts.push("selected");
  return parts.join(" ");
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function round(value: number): number {
  return Math.round(value);
}
