import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteCase, getCase, listCases, parseCaseJson, saveCase, slugify, updateCase } from "../src/core/cases.js";
import { NatError } from "../src/core/errors.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nat-cases-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const LOGIN = {
  title: "Login with valid credentials",
  tags: ["smoke"],
  app: "com.example.app",
  flows: [
    { instructions: "tap Sign in, enter credentials, submit", result: "the home tab is selected" },
    { instructions: "open the profile tab", result: "the profile shows the user's name" },
  ],
};

describe("saving and reading cases", () => {
  it("derives a stable file-safe id from the title", async () => {
    const saved = await saveCase(LOGIN, dir);
    expect(saved.id).toBe("login-with-valid-credentials");
    expect(saved.flows).toHaveLength(2);
  });

  it("round-trips through disk", async () => {
    await saveCase(LOGIN, dir);
    const loaded = await getCase("login-with-valid-credentials", dir);
    expect(loaded.title).toBe(LOGIN.title);
    expect(loaded.flows[1]!.result).toBe("the profile shows the user's name");
  });

  it("finds a case by its title as well as its id", async () => {
    await saveCase(LOGIN, dir);
    const loaded = await getCase("Login with valid credentials", dir);
    expect(loaded.id).toBe("login-with-valid-credentials");
  });

  it("keeps createdAt across an update and moves updatedAt", async () => {
    const first = await saveCase(LOGIN, dir);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await updateCase(first.id, { tags: ["smoke", "regression"] }, dir);

    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
    expect(second.tags).toEqual(["smoke", "regression"]);
    // An update must not silently drop the flows it was not asked about.
    expect(second.flows).toHaveLength(2);
  });

  it("lists what is on disk", async () => {
    await saveCase(LOGIN, dir);
    await saveCase({ title: "Checkout", flows: [{ instructions: "buy something" }] }, dir);
    const all = await listCases(dir);
    expect(all.map((entry) => entry.id).sort()).toEqual(["checkout", "login-with-valid-credentials"]);
  });

  it("deletes", async () => {
    await saveCase(LOGIN, dir);
    await deleteCase("login-with-valid-credentials", dir);
    expect(await listCases(dir)).toHaveLength(0);
  });

  it("returns an empty list for a directory that does not exist yet", async () => {
    expect(await listCases(join(dir, "nope"))).toEqual([]);
  });
});

describe("validation", () => {
  it("insists on a title", async () => {
    await expect(saveCase({ flows: [{ instructions: "x" }] }, dir)).rejects.toThrow(/needs a `title`/);
  });

  it("insists on at least one flow with instructions", async () => {
    await expect(saveCase({ title: "Empty", flows: [] }, dir)).rejects.toThrow(/at least one flow/);
    await expect(saveCase({ title: "Blank", flows: [{ instructions: "   " }] }, dir)).rejects.toThrow(
      /at least one flow/,
    );
  });

  it("explains bad JSON with an example rather than a parser error", () => {
    expect(() => parseCaseJson("{not json")).toThrow(NatError);
    expect(() => parseCaseJson("{not json")).toThrow(/valid JSON/);
    expect(() => parseCaseJson("[1,2]")).toThrow(/JSON object/);
  });

  it("names the available cases when one is not found", async () => {
    await saveCase(LOGIN, dir);
    const error = await getCase("checkout", dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NatError);
    expect((error as NatError).message).toContain("checkout");
    expect((error as NatError).hint).toContain("login-with-valid-credentials");
  });
});

describe("slugify", () => {
  it("strips punctuation and collapses separators", () => {
    expect(slugify("Login — with 'valid' credentials!")).toBe("login-with-valid-credentials");
  });

  it("refuses a title with nothing usable in it", () => {
    expect(() => slugify("!!!")).toThrow(NatError);
  });
});
