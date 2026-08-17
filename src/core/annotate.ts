/**
 * Marked screenshots.
 *
 * A raw screenshot tells a model what the screen looks like; it does not tell
 * it what can be tapped or where. The element tree answers that, but nothing
 * connects the two — the model has to hold "button 'Sign in' at 500,806" in its
 * head while looking at pixels and hope they refer to the same thing.
 *
 * Marking closes that gap: every tap target gets a numbered box drawn on the
 * image, and the same number appears beside it in `nat screen`. The model can
 * then look at the picture, pick a number, and act on it — no coordinate
 * arithmetic, no guessing which of three grey rectangles is the button.
 *
 * (This is the "set of marks" technique from the vision-agent literature. It
 * matters most exactly where this tool is aimed: games, canvases and custom
 * controls, where names are absent and geometry is all there is.)
 */

import { PNG } from "pngjs";
import { areaOf } from "./coords.js";
import { flatten, isInteractive } from "./tree.js";
import type { Rect, UiElement } from "./types.js";

/** Elements bigger than this share of the screen are containers, not targets. */
const MAX_TARGET_AREA = 400_000; // 40% of the 1000×1000 relative space
const MIN_TARGET_SIDE = 12;

/** Structure that frames the screen rather than something a finger aims at. */
const LANDMARK_ROLES = new Set([
  "app",
  "window",
  "navbar",
  "tabbar",
  "toolbar",
  "scroll",
  "collection",
  "table",
  "group",
  "other",
  "keyboard",
]);

export interface MarkOptions {
  /** Cap the number of marks so the image stays readable. */
  max?: number;
  /** Mark every named element, not just plausible tap targets. */
  all?: boolean;
}

/**
 * Number the elements worth pointing at, in reading order.
 *
 * Reading order (top to bottom, then left to right) rather than tree order:
 * the numbers are read off a picture, so they should climb the way eyes move,
 * not the way the view hierarchy happens to nest.
 */
export function assignMarks(elements: UiElement[], options: MarkOptions = {}): UiElement[] {
  const candidates = selectTargets(elements, options.all === true);

  const ordered = [...candidates].sort((a, b) => {
    const rowA = Math.round(a.center.y / 20);
    const rowB = Math.round(b.center.y / 20);
    return rowA !== rowB ? rowA - rowB : a.center.x - b.center.x;
  });

  const kept = options.max && ordered.length > options.max ? prioritize(ordered, options.max) : ordered;
  const marks = new Map<UiElement, number>();
  kept.forEach((node, index) => marks.set(node, index + 1));

  const apply = (nodes: UiElement[]): UiElement[] =>
    nodes.map((node) => {
      const mark = marks.get(node);
      return {
        ...node,
        ...(mark !== undefined ? { mark } : {}),
        children: apply(node.children),
      };
    });

  return apply(elements);
}

/**
 * Pick one target per thing a finger would actually hit.
 *
 * The naive rule — "mark everything with a name" — puts three numbers on a
 * settings row: the icon, the label, and the row itself. All three tap to the
 * same place, so the extra two are noise on the image and, worse, invite the
 * model to think they are different choices.
 *
 * So marking is *exclusive*: once a row is marked, its contents are not, unless
 * a child is separately actionable (the switch inside the row) and occupies its
 * own box.
 */
function selectTargets(elements: UiElement[], all: boolean): UiElement[] {
  const out: UiElement[] = [];

  const visit = (nodes: UiElement[], marked: UiElement | undefined): void => {
    for (const node of nodes) {
      let ancestor = marked;
      if (isEligible(node, all) && !isCoveredBy(node, marked, all)) {
        out.push(node);
        ancestor = node;
      }
      visit(node.children, ancestor);
    }
  };

  visit(elements, undefined);
  return out;
}

function isEligible(node: UiElement, all: boolean): boolean {
  if (node.rect.width < MIN_TARGET_SIDE || node.rect.height < MIN_TARGET_SIDE) return false;
  // Landmarks: they frame the screen, they are not what a finger aims at.
  if (LANDMARK_ROLES.has(node.role)) return all;
  if (isInteractive(node)) return true;

  const named = Boolean((node.label ?? node.identifier ?? "").trim());
  if (!named) return false;
  return all || areaOf(node.rect) < MAX_TARGET_AREA;
}

/**
 * True when marking this node would just repeat a mark the user can already
 * aim at: it is decoration inside something tappable, or it sits on the same
 * box as its marked ancestor.
 *
 * `all` asks for a complete inventory rather than a tidy set of targets, so it
 * keeps only the same-box rule — otherwise the outermost container would
 * swallow every element on the screen and defeat the flag.
 */
function isCoveredBy(node: UiElement, ancestor: UiElement | undefined, all: boolean): boolean {
  if (!ancestor) return false;
  if (sameBox(node.rect, ancestor.rect)) return true;
  return all ? false : !isInteractive(node);
}

function sameBox(a: Rect, b: Rect): boolean {
  const tolerance = 8; // relative units — a few pixels on any real device
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

/** When there are too many targets, keep the ones most likely to be acted on. */
function prioritize(ordered: UiElement[], max: number): UiElement[] {
  const score = (node: UiElement) => (isInteractive(node) ? 100 : 0) + (node.label ? 10 : 0);
  const keep = new Set(
    [...ordered]
      .sort((a, b) => score(b) - score(a))
      .slice(0, max),
  );
  return ordered.filter((node) => keep.has(node));
}

export function markedElements(elements: UiElement[]): UiElement[] {
  return flatten(elements)
    .filter((node) => node.mark !== undefined)
    .sort((a, b) => (a.mark ?? 0) - (b.mark ?? 0));
}

// ------------------------------------------------------------------ drawing

/**
 * Draw the marks onto the screenshot.
 *
 * The relative coordinate space does the heavy lifting here: element boxes are
 * already 0–1000 on both axes, so they map onto the image's own pixel
 * dimensions with no knowledge of the device's scale factor or orientation.
 */
export function drawMarks(screenshot: Buffer, elements: UiElement[]): Buffer {
  const image = PNG.sync.read(screenshot);
  const targets = markedElements(elements);
  if (targets.length === 0) return screenshot;

  const scale = Math.max(1, Math.round(Math.min(image.width, image.height) / 320));

  for (const node of targets) {
    const box = toPixels(node.rect, image.width, image.height);
    const color = isInteractive(node) ? ACCENT : SECONDARY;
    strokeRect(image, box, color, Math.max(2, Math.round(scale * 0.75)));
    drawLabel(image, box, String(node.mark), color, scale);
  }

  return PNG.sync.write(image);
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Rgb = [number, number, number];

/** Interactive targets and merely-named landmarks get different colours. */
const ACCENT: Rgb = [255, 45, 85];
const SECONDARY: Rgb = [0, 160, 255];

function toPixels(rect: Rect, width: number, height: number): Box {
  const left = clamp(Math.round((rect.x / 1000) * width), 0, width - 1);
  const top = clamp(Math.round((rect.y / 1000) * height), 0, height - 1);
  const right = clamp(Math.round(((rect.x + rect.width) / 1000) * width), left + 1, width);
  const bottom = clamp(Math.round(((rect.y + rect.height) / 1000) * height), top + 1, height);
  return { left, top, right, bottom };
}

/**
 * Outline the box in colour, wrapped in a dark line on each side.
 *
 * A single-colour box vanishes against a similarly-coloured UI. Sandwiching it
 * between dark edges keeps it visible on both a white settings list and a dark
 * game, which is the whole point of drawing it.
 */
function strokeRect(image: PNG, box: Box, color: Rgb, weight: number): void {
  for (let offset = -1; offset < weight + 1; offset += 1) {
    const shade: Rgb = offset === -1 || offset === weight ? [0, 0, 0] : color;
    const alpha = offset === -1 || offset === weight ? 0.55 : 1;
    outline(image, box, offset, shade, alpha);
  }
}

function outline(image: PNG, box: Box, inset: number, color: Rgb, alpha: number): void {
  const left = box.left + inset;
  const top = box.top + inset;
  const right = box.right - 1 - inset;
  const bottom = box.bottom - 1 - inset;
  if (right <= left || bottom <= top) return;

  for (let x = left; x <= right; x += 1) {
    blend(image, x, top, color, alpha);
    blend(image, x, bottom, color, alpha);
  }
  for (let y = top; y <= bottom; y += 1) {
    blend(image, left, y, color, alpha);
    blend(image, right, y, color, alpha);
  }
}

/**
 * Draw the number in a filled chip pinned to the box's top-left corner, nudged
 * inside when the box is against an edge so no label is ever clipped away.
 */
function drawLabel(image: PNG, box: Box, text: string, color: Rgb, scale: number): void {
  const padding = Math.max(2, Math.round(scale * 0.9));
  const glyphWidth = GLYPH_WIDTH * scale;
  const glyphHeight = GLYPH_HEIGHT * scale;
  const gap = scale;

  const chipWidth = text.length * glyphWidth + (text.length - 1) * gap + padding * 2;
  const chipHeight = glyphHeight + padding * 2;

  let left = box.left;
  let top = box.top - chipHeight;
  if (top < 0) top = box.top; // no room above — sit inside the box instead
  if (left + chipWidth > image.width) left = Math.max(0, image.width - chipWidth);

  fillRect(image, left, top, chipWidth, chipHeight, color, 0.92);

  let cursor = left + padding;
  for (const character of text) {
    drawGlyph(image, character, cursor, top + padding, scale);
    cursor += glyphWidth + gap;
  }
}

function fillRect(image: PNG, x: number, y: number, width: number, height: number, color: Rgb, alpha: number): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      blend(image, column, row, color, alpha);
    }
  }
}

function drawGlyph(image: PNG, character: string, x: number, y: number, scale: number): void {
  const rows = FONT[character];
  if (!rows) return;
  for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
    const bits = rows[row] ?? 0;
    for (let column = 0; column < GLYPH_WIDTH; column += 1) {
      if ((bits & (1 << (GLYPH_WIDTH - 1 - column))) === 0) continue;
      fillRect(image, x + column * scale, y + row * scale, scale, scale, [255, 255, 255], 1);
    }
  }
}

function blend(image: PNG, x: number, y: number, color: Rgb, alpha: number): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const index = (image.width * y + x) << 2;
  for (let channel = 0; channel < 3; channel += 1) {
    const existing = image.data[index + channel] ?? 0;
    image.data[index + channel] = Math.round(existing * (1 - alpha) + color[channel]! * alpha);
  }
  image.data[index + 3] = 255;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// --------------------------------------------------------------------- font

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

/**
 * A 5×7 bitmap for the digits, so labels need no font file and no text-shaping
 * dependency. Each row is five bits, most significant bit leftmost.
 */
const FONT: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
};

/** Exported for the tests that check the glyphs are all present and sane. */
export const DIGIT_FONT = FONT;

// ------------------------------------------------------------- contact sheet

/**
 * Lay several frames side by side on one numbered image.
 *
 * A model can only look at what it is given, and it is given still images — so
 * "what happened during that transition" has to become a single picture. Frames
 * are downscaled to a common height and numbered in order, which is enough to
 * read an animation, spot a flicker, or follow a game across a second or two.
 */
export function contactSheet(frames: Buffer[], options: { height?: number; gap?: number } = {}): Buffer {
  if (frames.length === 0) {
    throw new Error("contactSheet needs at least one frame");
  }

  const decoded = frames.map((frame) => PNG.sync.read(frame));
  const targetHeight = options.height ?? 640;
  const gap = options.gap ?? 12;

  const scaled = decoded.map((frame) => {
    const factor = Math.min(1, targetHeight / frame.height);
    return resize(frame, Math.max(1, Math.round(frame.width * factor)), Math.max(1, Math.round(frame.height * factor)));
  });

  const height = Math.max(...scaled.map((frame) => frame.height));
  const width = scaled.reduce((total, frame) => total + frame.width, 0) + gap * (scaled.length - 1);

  const sheet = new PNG({ width, height });
  fillRect(sheet, 0, 0, width, height, [18, 20, 24], 1);

  const scale = Math.max(2, Math.round(height / 160));
  let x = 0;
  scaled.forEach((frame, index) => {
    blit(sheet, frame, x, 0);
    stampNumber(sheet, String(index + 1), x + gap / 2, gap / 2, scale);
    x += frame.width + gap;
  });

  return PNG.sync.write(sheet);
}

/** Nearest-neighbour downscale — no filtering, but exact and dependency-free. */
function resize(source: PNG, width: number, height: number): PNG {
  if (width === source.width && height === source.height) return source;
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor((y * source.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x * source.width) / width));
      const from = (source.width * sourceY + sourceX) << 2;
      const to = (width * y + x) << 2;
      out.data[to] = source.data[from] ?? 0;
      out.data[to + 1] = source.data[from + 1] ?? 0;
      out.data[to + 2] = source.data[from + 2] ?? 0;
      out.data[to + 3] = 255;
    }
  }
  return out;
}

function blit(target: PNG, source: PNG, x: number, y: number): void {
  for (let row = 0; row < source.height; row += 1) {
    for (let column = 0; column < source.width; column += 1) {
      const from = (source.width * row + column) << 2;
      const to = (target.width * (y + row) + (x + column)) << 2;
      if (to < 0 || to + 3 >= target.data.length) continue;
      target.data[to] = source.data[from] ?? 0;
      target.data[to + 1] = source.data[from + 1] ?? 0;
      target.data[to + 2] = source.data[from + 2] ?? 0;
      target.data[to + 3] = 255;
    }
  }
}

/** A frame number in a chip, using the same digits as the marks. */
function stampNumber(image: PNG, text: string, x: number, y: number, scale: number): void {
  const padding = Math.max(2, Math.round(scale * 0.8));
  const glyphWidth = GLYPH_WIDTH * scale;
  const chipWidth = text.length * glyphWidth + (text.length - 1) * scale + padding * 2;
  const chipHeight = GLYPH_HEIGHT * scale + padding * 2;

  fillRect(image, Math.round(x), Math.round(y), chipWidth, chipHeight, [255, 45, 85], 0.92);
  let cursor = Math.round(x) + padding;
  for (const character of text) {
    drawGlyph(image, character, cursor, Math.round(y) + padding, scale);
    cursor += glyphWidth + scale;
  }
}
