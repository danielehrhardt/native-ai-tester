import { describe, expect, it } from "vitest";
import { IosDriver, iosRole } from "../src/drivers/ios/ios-driver.js";
import { cleanTree, flatten } from "../src/core/tree.js";
import type { Device } from "../src/core/types.js";

const SCREEN = { width: 393, height: 852, scale: 3 };

const DEVICE: Device = {
  id: "test",
  name: "iPhone",
  platform: "ios",
  kind: "simulator",
  state: "booted",
  ready: true,
};

const driver = new IosDriver(DEVICE, { wdaUrl: "http://127.0.0.1:8100" });

/** A slice of a real WDA `/source?format=json` payload. */
const SOURCE = {
  type: "Application",
  name: "MyApp",
  label: "MyApp",
  rect: { x: 0, y: 0, width: 393, height: 852 },
  isEnabled: "1",
  children: [
    {
      type: "Other",
      rect: { x: 0, y: 0, width: 393, height: 852 },
      isEnabled: "1",
      children: [
        {
          type: "StaticText",
          name: "Welcome back",
          label: "Welcome back",
          rect: { x: 40, y: 100, width: 313, height: 40 },
          isEnabled: "1",
        },
        {
          type: "TextField",
          name: "email",
          label: "Email",
          value: "a@b.com",
          placeholderValue: "Email address",
          rawIdentifier: "login.email",
          rect: { x: 40, y: 300, width: 313, height: 44 },
          isEnabled: "1",
        },
        {
          type: "Button",
          name: "Sign in",
          label: "Sign in",
          rect: { x: 40, y: 700, width: 313, height: 50 },
          isEnabled: false,
        },
      ],
    },
  ],
};

describe("iosRole", () => {
  it("strips the XCUIElementType prefix and maps onto the shared vocabulary", () => {
    expect(iosRole("XCUIElementTypeButton")).toBe("button");
    expect(iosRole("XCUIElementTypeStaticText")).toBe("text");
    expect(iosRole("XCUIElementTypeSecureTextField")).toBe("secure-field");
    expect(iosRole("XCUIElementTypeCollectionView")).toBe("collection");
  });

  it("accepts the short form WDA's JSON output uses", () => {
    expect(iosRole("Button")).toBe("button");
    expect(iosRole("WebView")).toBe("webview");
  });

  it("keeps an unmapped type legible instead of flattening it to `other`", () => {
    expect(iosRole("XCUIElementTypeTouchBar")).toBe("touchbar");
  });
});

describe("normalizeSource", () => {
  const elements = driver.normalizeSource(SOURCE, SCREEN);
  const all = flatten(elements);

  it("converts point rects into the relative 0–1000 space", () => {
    const button = all.find((node) => node.label === "Sign in")!;
    // x 40..353 of 393 → centre 500; y 700..750 of 852 → centre ~851
    expect(button.center.x).toBeCloseTo(500, 0);
    expect(button.center.y).toBeCloseTo(851, 0);
  });

  it("reads WDA's string booleans as well as real ones", () => {
    expect(all.find((node) => node.label === "Welcome back")!.enabled).toBe(true);
    expect(all.find((node) => node.label === "Sign in")!.enabled).toBe(false);
  });

  it("keeps label, value, placeholder and identifier apart", () => {
    const field = all.find((node) => node.role === "field")!;
    expect(field.label).toBe("Email");
    expect(field.value).toBe("a@b.com");
    expect(field.placeholder).toBe("Email address");
    expect(field.identifier).toBe("login.email");
  });

  it("returns nothing for an empty source rather than throwing", () => {
    expect(driver.normalizeSource(undefined, SCREEN)).toEqual([]);
  });

  it("cleans away the anonymous container between the app and its content", () => {
    const cleaned = cleanTree(elements);
    expect(flatten(cleaned).some((node) => node.nativeType === "Other")).toBe(false);
    expect(flatten(cleaned).map((node) => node.label)).toContain("Sign in");
  });
});
