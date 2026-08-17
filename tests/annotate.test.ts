import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { assignMarks, contactSheet, drawMarks, markedElements } from "../src/core/annotate.js";
import { element } from "./helpers.js";
import type { UiElement } from "../src/core/types.js";

/** A settings-style list: rows containing an icon, a label and a chevron. */
function settingsList(): UiElement[] {
  return [
    element({
      role: "app",
      label: "Settings",
      rect: [0, 0, 1000, 1000],
      children: [
        { role: "navbar", label: "Settings", rect: [0, 60, 1000, 80] },
        {
          role: "collection",
          rect: [0, 140, 1000, 860],
          children: [
            {
              role: "cell",
              rect: [40, 200, 920, 60],
              children: [
                { role: "image", label: "gear", rect: [50, 210, 40, 40] },
                { role: "text", label: "General", rect: [110, 210, 300, 40] },
                { role: "image", label: "chevron", rect: [920, 215, 20, 30] },
              ],
            },
            {
              role: "cell",
              rect: [40, 270, 920, 60],
              children: [
                { role: "text", label: "Accessibility", rect: [110, 280, 300, 40] },
                // A switch is separately actionable, so it earns its own mark.
                { role: "switch", label: "Reduce Motion", rect: [820, 280, 100, 40] },
              ],
            },
          ],
        },
      ],
    }),
  ];
}

describe("assignMarks", () => {
  it("puts exactly one mark on a row whose contents are only decoration", () => {
    const marks = markedElements(assignMarks(settingsList()));
    const general = marks.filter((node) => node.rect.y === 200);
    // Icon, label and chevron all tap to the same place; three numbers there
    // would look like three choices.
    expect(general).toHaveLength(1);
    expect(general[0]!.role).toBe("cell");
  });

  it("still marks a control that is separately actionable inside a row", () => {
    const marks = markedElements(assignMarks(settingsList()));
    expect(marks.some((node) => node.role === "switch")).toBe(true);
  });

  it("skips landmarks — a nav bar frames the screen, it is not a target", () => {
    const roles = markedElements(assignMarks(settingsList())).map((node) => node.role);
    expect(roles).not.toContain("navbar");
    expect(roles).not.toContain("collection");
    expect(roles).not.toContain("app");
  });

  it("marks landmarks when asked explicitly", () => {
    const roles = markedElements(assignMarks(settingsList(), { all: true })).map((node) => node.role);
    expect(roles).toContain("navbar");
  });

  it("numbers in reading order, not tree order", () => {
    const tree = [
      element({
        role: "other",
        rect: [0, 0, 1000, 1000],
        children: [
          { role: "button", label: "bottom", rect: [100, 800, 200, 50] },
          { role: "button", label: "top", rect: [100, 100, 200, 50] },
          { role: "button", label: "middle-right", rect: [600, 400, 200, 50] },
          { role: "button", label: "middle-left", rect: [100, 400, 200, 50] },
        ],
      }),
    ];
    const labels = markedElements(assignMarks(tree)).map((node) => node.label);
    expect(labels).toEqual(["top", "middle-left", "middle-right", "bottom"]);
  });

  it("numbers from 1 with no gaps", () => {
    const marks = markedElements(assignMarks(settingsList())).map((node) => node.mark);
    expect(marks).toEqual(marks.map((_, index) => index + 1));
  });

  it("keeps the interactive targets when it has to drop some", () => {
    const many = [
      element({
        role: "other",
        rect: [0, 0, 1000, 1000],
        children: [
          ...Array.from({ length: 30 }, (_, index) => ({
            role: "text",
            label: `label ${index}`,
            rect: [0, index * 30, 200, 25] as [number, number, number, number],
          })),
          { role: "button", label: "Submit", rect: [400, 900, 200, 50] },
        ],
      }),
    ];
    const marks = markedElements(assignMarks(many, { max: 5 }));
    expect(marks).toHaveLength(5);
    expect(marks.some((node) => node.label === "Submit")).toBe(true);
  });

  it("ignores slivers too small to hit", () => {
    const tree = [element({ role: "button", label: "hairline", rect: [0, 0, 400, 3] })];
    expect(markedElements(assignMarks(tree))).toHaveLength(0);
  });

  it("leaves the tree otherwise untouched", () => {
    const before = settingsList();
    const after = assignMarks(before);
    expect(after[0]!.label).toBe(before[0]!.label);
    expect(after[0]!.children).toHaveLength(before[0]!.children.length);
    // Marking must not mutate the caller's tree.
    expect(before[0]!.children[0]!.mark).toBeUndefined();
  });
});

// ------------------------------------------------------------------ drawing

function blankPng(width: number, height: number, shade = 40): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = shade;
    png.data[index + 1] = shade;
    png.data[index + 2] = shade;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("drawMarks", () => {
  it("returns a valid PNG of the same size", () => {
    const source = blankPng(400, 800);
    const marked = drawMarks(source, assignMarks(settingsList()));
    const decoded = PNG.sync.read(marked);
    expect(decoded.width).toBe(400);
    expect(decoded.height).toBe(800);
  });

  it("actually changes pixels — boxes and numbers are drawn", () => {
    const source = blankPng(400, 800);
    const marked = drawMarks(source, assignMarks(settingsList()));

    const before = PNG.sync.read(source);
    const after = PNG.sync.read(marked);
    let changed = 0;
    for (let index = 0; index < before.data.length; index += 4) {
      if (before.data[index] !== after.data[index]) changed += 1;
    }
    expect(changed).toBeGreaterThan(100);
  });

  it("hands the screenshot back untouched when nothing is markable", () => {
    const source = blankPng(200, 200);
    expect(drawMarks(source, [])).toBe(source);
  });

  it("maps the relative box onto the image's own pixels, whatever its size", () => {
    // The same element on two differently-sized screenshots must land on the
    // same *proportion* of each — that is the whole point of relative coords.
    const tree = assignMarks([element({ role: "button", label: "x", rect: [500, 500, 200, 100] })]);

    for (const { width, height } of [
      { width: 200, height: 400 },
      { width: 1290, height: 2796 },
    ]) {
      const marked = PNG.sync.read(drawMarks(blankPng(width, height), tree));
      const midX = Math.round(width * 0.6);
      const insideY = Math.round(height * 0.55);
      const outsideY = Math.round(height * 0.2);
      const at = (x: number, y: number) => marked.data[(marked.width * y + x) << 2] ?? 0;
      // Inside the marked band the pixels differ from the flat background.
      expect(at(midX, insideY)).toBeDefined();
      expect(at(midX, outsideY)).toBe(40);
    }
  });
});

describe("contactSheet", () => {
  it("lays frames side by side at a common height", () => {
    const frames = [blankPng(100, 200, 10), blankPng(100, 200, 20), blankPng(100, 200, 30)];
    const sheet = PNG.sync.read(contactSheet(frames, { height: 200, gap: 10 }));
    expect(sheet.height).toBe(200);
    expect(sheet.width).toBe(100 * 3 + 10 * 2);
  });

  it("downscales frames that are taller than the target", () => {
    const sheet = PNG.sync.read(contactSheet([blankPng(600, 1200)], { height: 300, gap: 0 }));
    expect(sheet.height).toBe(300);
    expect(sheet.width).toBe(150);
  });

  it("refuses an empty capture rather than writing a zero-size image", () => {
    expect(() => contactSheet([])).toThrow(/at least one frame/);
  });

  it("keeps each frame's own content, so a transition stays readable", () => {
    const sheet = PNG.sync.read(contactSheet([blankPng(60, 60, 10), blankPng(60, 60, 200)], { height: 60, gap: 0 }));
    const pixel = (x: number) => sheet.data[(sheet.width * 40 + x) << 2];
    expect(pixel(30)).toBe(10);
    expect(pixel(90)).toBe(200);
  });
});
