import { describe, expect, it } from "vitest";
import { cleanTree, countNodes, flatten, renderSnapshot, renderElement } from "../src/core/tree.js";
import { element, snapshot } from "./helpers.js";

describe("cleanTree", () => {
  it("splices out unnamed layout containers but keeps what they contain", () => {
    const raw = [
      element({
        role: "other",
        rect: [0, 0, 1000, 1000],
        children: [
          {
            role: "group",
            rect: [0, 100, 1000, 200],
            children: [{ role: "button", label: "Sign in", rect: [120, 150, 760, 60] }],
          },
        ],
      }),
    ];

    const cleaned = cleanTree(raw);
    const labels = flatten(cleaned).map((node) => node.label);
    expect(labels).toContain("Sign in");
    // Three nested wrappers collapse to the one node that can actually be tapped.
    expect(countNodes(cleaned)).toBe(1);
  });

  it("splices out an unnamed wrapper even when it branches", () => {
    const raw = [
      element({
        role: "other",
        rect: [0, 0, 1000, 1000],
        children: [
          { role: "text", label: "First", rect: [0, 0, 500, 100] },
          { role: "text", label: "Second", rect: [0, 100, 500, 100] },
        ],
      }),
    ];
    const cleaned = cleanTree(raw);
    expect(flatten(cleaned).map((node) => node.label)).toEqual(["First", "Second"]);
  });

  it("keeps a container that has a name, so grouping the user can see survives", () => {
    const raw = [
      element({
        role: "other",
        label: "Recent orders",
        rect: [0, 0, 1000, 400],
        children: [
          { role: "cell", label: "Order 1", rect: [0, 0, 1000, 100] },
          { role: "cell", label: "Order 2", rect: [0, 100, 1000, 100] },
        ],
      }),
    ];
    expect(flatten(cleanTree(raw)).map((node) => node.label)).toEqual(["Recent orders", "Order 1", "Order 2"]);
  });

  it("keeps a scroll container, because an agent needs its box to aim a swipe", () => {
    const raw = [
      element({
        role: "scroll",
        rect: [0, 100, 1000, 700],
        children: [{ role: "text", label: "Row", rect: [0, 100, 1000, 60] }],
      }),
    ];
    expect(flatten(cleanTree(raw)).map((node) => node.role)).toContain("scroll");
  });

  it("drops zero-size and off-screen elements without losing their children", () => {
    const raw = [
      element({ role: "text", label: "Invisible", rect: [0, 0, 0, 0] }),
      element({ role: "text", label: "Above the screen", rect: [0, -200, 500, 100] }),
      element({
        role: "other",
        rect: [0, 0, 0, 0],
        children: [{ role: "button", label: "Still reachable", rect: [100, 100, 200, 50] }],
      }),
      element({ role: "text", label: "Visible", rect: [0, 0, 500, 100] }),
    ];

    const labels = flatten(cleanTree(raw)).map((node) => node.label);
    expect(labels).toContain("Visible");
    expect(labels).toContain("Still reachable");
    expect(labels).not.toContain("Invisible");
    expect(labels).not.toContain("Above the screen");
  });

  it("keeps an interactive element even when it has no name", () => {
    const raw = [element({ role: "button", identifier: "fab", rect: [800, 800, 120, 120] })];
    expect(countNodes(cleanTree(raw))).toBe(1);
  });

  it("collapses a wrapper that duplicates its only child", () => {
    const raw = [
      element({
        role: "other",
        label: "Sign in",
        rect: [120, 150, 760, 60],
        children: [{ role: "button", label: "Sign in", rect: [120, 150, 760, 60] }],
      }),
    ];
    const cleaned = cleanTree(raw);
    expect(countNodes(cleaned)).toBe(1);
    expect(cleaned[0]!.role).toBe("button");
  });

  it("removes identical siblings stacked on the same box", () => {
    const raw = [
      element({ role: "text", label: "Total", rect: [0, 0, 200, 40] }),
      element({ role: "text", label: "Total", rect: [0, 0, 200, 40] }),
    ];
    expect(countNodes(cleanTree(raw))).toBe(1);
  });

  it("leaves the tree alone with --full", () => {
    const raw = [
      element({
        role: "other",
        rect: [0, 0, 1000, 1000],
        children: [{ role: "other", rect: [0, 0, 1000, 1000], children: [{ role: "text", label: "Hi", rect: [0, 0, 10, 10] }] }],
      }),
    ];
    expect(countNodes(cleanTree(raw, { full: true }))).toBe(3);
  });

  it("respects maxNodes by dropping the least informative leaves, not the tail", () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      element({
        role: index === 49 ? "button" : "text",
        label: index === 49 ? "Submit" : `filler ${index}`,
        rect: [0, index * 20, 100, 18],
      }),
    );

    const cleaned = cleanTree(many, { maxNodes: 10 });
    expect(countNodes(cleaned)).toBeLessThanOrEqual(10);
    // The button near the bottom is the most useful node — it must survive.
    expect(flatten(cleaned).some((node) => node.label === "Submit")).toBe(true);
  });

  it("renumbers ids so they address the cleaned tree, not the raw one", () => {
    const raw = [
      // An unnamed wrapper that will be spliced out, then a named one that survives.
      element({
        role: "other",
        rect: [0, 0, 1000, 1000],
        children: [
          {
            role: "other",
            label: "Toolbar",
            rect: [0, 0, 1000, 120],
            children: [
              { role: "button", label: "A", rect: [0, 0, 100, 50] },
              { role: "button", label: "B", rect: [0, 60, 100, 50] },
            ],
          },
        ],
      }),
    ];
    const ids = flatten(cleanTree(raw)).map((node) => node.id);
    expect(ids).toEqual(["0", "0.0", "0.1"]);
  });
});

describe("rendering", () => {
  it("puts the tap point and box on every line", () => {
    const line = renderElement(element({ role: "button", label: "Sign in", rect: [120, 780, 760, 52] }));
    expect(line).toContain("button");
    expect(line).toContain('"Sign in"');
    expect(line).toContain("@500,806");
    expect(line).toContain("760x52");
  });

  it("explains an empty tree instead of printing nothing", () => {
    const rendered = renderSnapshot(snapshot([]));
    expect(rendered).toContain("no elements");
    expect(rendered).toContain("target by description");
  });

  it("states the coordinate contract in the header", () => {
    const rendered = renderSnapshot(snapshot([{ role: "button", label: "Go", rect: [0, 0, 100, 50] }]));
    expect(rendered).toContain("relative 0-1000");
  });

  it("is dramatically smaller than the raw tree it came from", () => {
    // A realistic slice of an iOS view hierarchy: one button under four wrappers.
    const raw = [
      element({
        role: "app",
        rect: [0, 0, 1000, 1000],
        children: [
          {
            role: "window",
            rect: [0, 0, 1000, 1000],
            children: [
              {
                role: "other",
                rect: [0, 0, 1000, 1000],
                children: [
                  {
                    role: "other",
                    rect: [0, 700, 1000, 200],
                    children: [{ role: "button", label: "Continue", rect: [120, 780, 760, 52] }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ];

    expect(countNodes(raw)).toBe(5);
    expect(countNodes(cleanTree(raw))).toBe(1);
  });
});
