import { describe, expect, it, beforeEach } from "vitest";
import { ground, rankElements } from "../src/core/grounding.js";
import { resetConfigCache } from "../src/core/config.js";
import { NatError } from "../src/core/errors.js";
import { snapshot } from "./helpers.js";

const LOGIN_SCREEN = snapshot([
  { role: "text", label: "Welcome back", rect: [100, 120, 800, 60] },
  { role: "field", placeholder: "Email", identifier: "email-field", rect: [120, 380, 760, 44] },
  { role: "secure-field", placeholder: "Password", rect: [120, 450, 760, 44] },
  { role: "button", label: "Sign in", rect: [120, 780, 760, 52] },
  { role: "button", label: "Sign up", rect: [120, 860, 760, 52] },
  { role: "link", label: "Forgot password?", rect: [300, 930, 400, 30] },
]);

beforeEach(() => {
  // Grounding consults config to decide whether a vision model is available.
  resetConfigCache();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.NAT_GROUNDING = "tree";
});

describe("tree grounding", () => {
  it("resolves an exact label", async () => {
    const result = await ground(LOGIN_SCREEN, "Sign in");
    expect(result.method).toBe("tree");
    expect(result.element?.label).toBe("Sign in");
    expect(result.point).toEqual({ x: 500, y: 806 });
  });

  it("ignores filler words and role words around the name", async () => {
    const result = await ground(LOGIN_SCREEN, "the Sign in button");
    expect(result.element?.label).toBe("Sign in");
  });

  it("uses a positional hint to break a near-tie", async () => {
    const twoSaves = snapshot([
      { role: "button", label: "Save", rect: [100, 80, 200, 44] },
      { role: "button", label: "Save", rect: [100, 900, 200, 44] },
    ]);
    const bottom = await ground(twoSaves, "the Save button at the bottom");
    expect(bottom.point.y).toBeGreaterThan(800);

    const top = await ground(twoSaves, "Save button at the top");
    expect(top.point.y).toBeLessThan(200);
  });

  it("prefers the field when the description says field", async () => {
    const result = await ground(LOGIN_SCREEN, "email field");
    expect(result.element?.role).toBe("field");
  });

  it("matches a placeholder as well as a label", async () => {
    const result = await ground(LOGIN_SCREEN, "Password");
    expect(result.element?.role).toBe("secure-field");
  });

  it("refuses to guess between two equally good matches", async () => {
    const ambiguous = snapshot([
      { role: "button", label: "Delete", rect: [100, 300, 200, 44] },
      { role: "button", label: "Delete", rect: [600, 300, 200, 44] },
    ]);
    await expect(ground(ambiguous, "Delete")).rejects.toThrow(NatError);
    await expect(ground(ambiguous, "Delete")).rejects.toThrow(/matches 2 elements/);
  });

  it("lets --index resolve an ambiguity", async () => {
    const ambiguous = snapshot([
      { role: "button", label: "Delete", rect: [100, 300, 200, 44] },
      { role: "button", label: "Delete", rect: [600, 300, 200, 44] },
    ]);
    const first = await ground(ambiguous, "Delete", { index: 1 });
    const second = await ground(ambiguous, "Delete", { index: 2 });
    expect(first.point.x).not.toBe(second.point.x);
  });

  it("does not treat two names for the same spot as ambiguous", async () => {
    const stacked = snapshot([
      { role: "button", label: "Continue", rect: [120, 780, 760, 52] },
      { role: "text", label: "Continue", rect: [120, 780, 760, 52], identifier: "cta-label" },
    ]);
    const result = await ground(stacked, "Continue");
    expect(result.point).toEqual({ x: 500, y: 806 });
  });

  it("reports what is nearby when nothing matches", async () => {
    await expect(ground(LOGIN_SCREEN, "Checkout")).rejects.toThrow(/Nothing on screen matches/);
  });

  it("says how to enable vision when the tree cannot answer", async () => {
    process.env.NAT_GROUNDING = "auto";
    resetConfigCache();
    const error = await ground(snapshot([]), "the red spaceship").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NatError);
    expect((error as NatError).code).toBe("ELEMENT_NOT_FOUND");
    expect((error as NatError).hint).toMatch(/ANTHROPIC_API_KEY|vision/i);
  });

  it("never returns a disabled control over an enabled one with the same name", async () => {
    const mixed = snapshot([
      { role: "button", label: "Next", rect: [100, 300, 200, 44], enabled: false },
      { role: "button", label: "Next", rect: [100, 600, 200, 44] },
    ]);
    const result = await ground(mixed, "Next");
    expect(result.element?.enabled).toBe(true);
  });
});

describe("rankElements", () => {
  it("scores an exact match above a substring match", () => {
    const ranked = rankElements(LOGIN_SCREEN, "Sign in");
    expect(ranked[0]!.element.label).toBe("Sign in");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it("returns nothing for text that appears nowhere", () => {
    expect(rankElements(LOGIN_SCREEN, "quantum flux capacitor")).toHaveLength(0);
  });

  it("honours a role filter", () => {
    const ranked = rankElements(LOGIN_SCREEN, "Sign", "link");
    expect(ranked.every((entry) => entry.element.role === "link")).toBe(true);
  });
});
