import { describe, expect, it } from "vitest";
import { IosDriver } from "../src/drivers/ios/ios-driver.js";
import type { Device } from "../src/core/types.js";

const DEVICE: Device = {
  id: "test",
  name: "iPhone",
  platform: "ios",
  kind: "device",
  state: "connected",
  ready: true,
};

/** Swap in a recording stand-in for the HTTP client. */
function spyDriver(): { driver: IosDriver; typed: string[]; buttons: string[] } {
  const driver = new IosDriver(DEVICE, { wdaUrl: "http://127.0.0.1:1" });
  const typed: string[] = [];
  const buttons: string[] = [];
  (driver as unknown as { wda: unknown }).wda = {
    typeText: async (text: string) => void typed.push(text),
    pressButton: async (name: string) => void buttons.push(name),
  };
  return { driver, typed, buttons };
}

describe("pressKey on iOS", () => {
  it("rejects an unknown key before touching the device", async () => {
    const { driver } = spyDriver();
    await expect(driver.pressKey("wiggle")).rejects.toThrow(/Unknown key/);
  });

  it("explains that iOS has no back button instead of listing every key", async () => {
    const { driver } = spyDriver();
    const error = await driver.pressKey("back").catch((caught: unknown) => caught);
    expect((error as { hint?: string }).hint).toMatch(/no hardware back button/i);
  });

  it("normalizes the spelling of hardware buttons", async () => {
    // `volume-up` must reach WDA as `volumeup`; a mismatch would silently send
    // it down the keyboard path and type nothing at all.
    const { driver, buttons } = spyDriver();
    await driver.pressKey("volume-up");
    await driver.pressKey("Volume_Down");
    await driver.pressKey("home");
    expect(buttons).toEqual(["volumeup", "volumedown", "home"]);
  });

  it("types a real character for every keyboard key — never an empty string", async () => {
    const { driver, typed } = spyDriver();
    for (const key of ["enter", "return", "tab", "space", "escape", "backspace", "delete"]) {
      await driver.pressKey(key);
    }
    // An empty string here is the bug this test exists for: `nat action key
    // backspace` would report success while doing nothing.
    expect(typed.every((value) => value.length > 0)).toBe(true);
    expect(typed).toEqual(["\n", "\n", "\t", " ", "", "", ""]);
  });
});

describe("typeText with --clear", () => {
  it("deletes exactly as many characters as the focused field holds", async () => {
    const { driver, typed } = spyDriver();
    (driver as unknown as { rawSource(): Promise<unknown> }).rawSource = async () => ({
      type: "Application",
      rect: { x: 0, y: 0, width: 393, height: 852 },
      children: [
        {
          type: "TextField",
          label: "Email",
          value: "old@example.com", // 15 characters
          isFocused: "1",
          rect: { x: 40, y: 300, width: 313, height: 44 },
        },
      ],
    });
    (driver as unknown as { screenSize(): Promise<unknown> }).screenSize = async () => ({
      width: 393,
      height: 852,
    });

    await driver.typeText("new@example.com", { clear: true });

    expect(typed[0]).toBe("".repeat("old@example.com".length));
    expect(typed[1]).toBe("new@example.com");
  });

  it("sends no deletes when the focused field is already empty", async () => {
    const { driver, typed } = spyDriver();
    (driver as unknown as { rawSource(): Promise<unknown> }).rawSource = async () => ({
      type: "Application",
      rect: { x: 0, y: 0, width: 393, height: 852 },
      children: [
        {
          type: "TextField",
          label: "Email",
          isFocused: "1",
          rect: { x: 40, y: 300, width: 313, height: 44 },
        },
      ],
    });
    (driver as unknown as { screenSize(): Promise<unknown> }).screenSize = async () => ({
      width: 393,
      height: 852,
    });

    await driver.typeText("hello", { clear: true });
    expect(typed).toEqual(["hello"]);
  });
});
