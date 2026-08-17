/**
 * Reading the screen — the "inspect" half of the inspect → act → verify loop.
 */

import { cleanTree, countNodes } from "./tree.js";
import { assignMarks } from "./annotate.js";
import type { Driver, ScreenSnapshot, UiElement } from "./types.js";

export interface ReadScreenOptions {
  /** Skip cleaning and return the raw platform tree. */
  full?: boolean;
  /** Upper bound on emitted elements. */
  maxNodes?: number;
  /** Skip the foreground-app lookup when the caller does not need it. */
  withApp?: boolean;
  /**
   * Number the tap targets. On by default: the numbers cost a couple of tokens
   * per line and are what let a model look at a marked screenshot, pick a
   * number, and act on it.
   */
  marks?: boolean;
  /** Cap on how many elements get numbered, so a marked image stays readable. */
  maxMarks?: number;
}

export async function readScreen(driver: Driver, options: ReadScreenOptions = {}): Promise<ScreenSnapshot> {
  const screen = await driver.screenSize();
  const raw = await driver.rawSource();
  const normalized = driver.normalizeSource(raw, screen);
  const rawNodes = countNodes(normalized);

  const cleaned = cleanTree(normalized, {
    full: options.full,
    maxNodes: options.maxNodes ?? 400,
  });

  const elements =
    options.marks === false ? cleaned : assignMarks(cleaned, { max: options.maxMarks ?? 60 });

  const app = options.withApp === false ? undefined : await driver.currentApp().catch(() => undefined);

  return {
    platform: driver.platform,
    deviceId: driver.device.id,
    ...(app ? { app } : {}),
    screen,
    elements,
    stats: { rawNodes, keptNodes: countNodes(elements) },
  };
}

/** Flatten to the elements a test can realistically act on. */
export function actionableElements(elements: UiElement[]): UiElement[] {
  const out: UiElement[] = [];
  const visit = (nodes: UiElement[]) => {
    for (const node of nodes) {
      if (node.enabled && (node.label || node.value || node.identifier)) out.push(node);
      visit(node.children);
    }
  };
  visit(elements);
  return out;
}
