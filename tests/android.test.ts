import { describe, expect, it } from "vitest";
import {
  androidKeycode,
  androidRole,
  parseBounds,
  parseUiAutomatorXml,
} from "../src/drivers/android/android-driver.js";
import { escapeForInput } from "../src/drivers/android/adb.js";
import { cleanTree, flatten } from "../src/core/tree.js";
import { NatError } from "../src/core/errors.js";

const SCREEN = { width: 1080, height: 2400 };

const HIERARCHY = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" clickable="false" enabled="true">
    <node index="0" class="androidx.recyclerview.widget.RecyclerView" resource-id="com.example:id/list" bounds="[0,200][1080,2000]" scrollable="true" enabled="true">
      <node index="0" class="android.widget.LinearLayout" bounds="[0,200][1080,400]" clickable="true" enabled="true">
        <node index="0" class="android.widget.TextView" text="Inbox" bounds="[40,240][400,360]" clickable="false" enabled="true"/>
      </node>
    </node>
    <node index="1" class="android.widget.Button" text="Send" content-desc="Send message" bounds="[700,2100][1040,2280]" clickable="true" enabled="true"/>
    <node index="2" class="android.widget.EditText" text="" hint="Type a message" resource-id="com.example:id/input" bounds="[40,2100][660,2280]" clickable="true" enabled="true"/>
    <node index="3" class="android.widget.Button" text="Disabled" bounds="[40,1900][300,2000]" clickable="true" enabled="false"/>
  </node>
</hierarchy>`;

describe("parseBounds", () => {
  it("reads the UiAutomator bounds format", () => {
    expect(parseBounds("[40,240][400,360]")).toEqual({ x: 40, y: 240, width: 360, height: 120 });
  });

  it("handles negative coordinates for partly off-screen elements", () => {
    expect(parseBounds("[-20,-10][100,90]")).toEqual({ x: -20, y: -10, width: 120, height: 100 });
  });

  it("returns an empty box rather than throwing on junk", () => {
    expect(parseBounds("nonsense")).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("parseUiAutomatorXml", () => {
  const elements = parseUiAutomatorXml(HIERARCHY, SCREEN);
  const all = flatten(elements);

  it("converts pixel bounds into the relative 0–1000 space", () => {
    const send = all.find((node) => node.label === "Send message")!;
    // 700..1040 of 1080 wide → centre at 805.5 in the relative space
    expect(send.center.x).toBeCloseTo(805.5, 1);
    expect(send.center.y).toBeCloseTo(912.5, 1);
  });

  it("prefers content-desc over text for the accessible name", () => {
    expect(all.find((node) => node.nativeType.endsWith("Button"))!.label).toBe("Send message");
  });

  it("keeps the text as the value when it differs from the name", () => {
    expect(all.find((node) => node.label === "Send message")!.value).toBe("Send");
  });

  it("carries the hint through as a placeholder", () => {
    const input = all.find((node) => node.role === "field")!;
    expect(input.placeholder).toBe("Type a message");
  });

  it("shortens resource-ids to the part that identifies the element", () => {
    expect(all.find((node) => node.role === "field")!.identifier).toBe("input");
  });

  it("records disabled state", () => {
    expect(all.find((node) => node.label === "Disabled")!.enabled).toBe(false);
  });

  it("survives a hierarchy that is not valid XML by reporting, not crashing silently", () => {
    expect(() => parseUiAutomatorXml("<hierarchy><node", SCREEN)).toThrow(NatError);
  });
});

describe("androidRole", () => {
  it("maps common widgets onto the shared vocabulary", () => {
    expect(androidRole("android.widget.Button")).toBe("button");
    expect(androidRole("android.widget.EditText")).toBe("field");
    expect(androidRole("android.widget.TextView")).toBe("text");
    expect(androidRole("android.widget.ImageView")).toBe("image");
    expect(androidRole("android.webkit.WebView")).toBe("webview");
    expect(androidRole("androidx.recyclerview.widget.RecyclerView")).toBe("collection");
  });

  it("treats a clickable layout as a tappable cell, because that is what it is", () => {
    expect(androidRole("android.widget.LinearLayout", { clickable: true })).toBe("cell");
    expect(androidRole("android.widget.LinearLayout", { clickable: false })).toBe("group");
  });

  it("treats a clickable label or icon as a button", () => {
    expect(androidRole("android.widget.TextView", { clickable: true })).toBe("button");
    expect(androidRole("android.widget.ImageView", { clickable: true })).toBe("button");
  });

  it("maps a game surface to canvas, so the agent knows the tree will not help", () => {
    expect(androidRole("android.opengl.GLSurfaceView")).toBe("canvas");
    expect(androidRole("android.view.SurfaceView")).toBe("canvas");
  });

  it("falls back on the clickable flag for unknown custom views", () => {
    expect(androidRole("com.unity3d.player.UnityPlayer", { clickable: true })).toBe("button");
    expect(androidRole("com.example.MysteryView")).toBe("other");
  });
});

describe("cleaning an Android tree", () => {
  it("keeps every actionable element and drops the scaffolding", () => {
    const cleaned = cleanTree(parseUiAutomatorXml(HIERARCHY, SCREEN));
    const labels = flatten(cleaned).map((node) => node.label ?? node.value);
    expect(labels).toContain("Send message");
    expect(labels).toContain("Inbox");
    // The outer FrameLayout carries no name and only one child — it goes.
    expect(flatten(cleaned).some((node) => node.nativeType === "android.widget.FrameLayout")).toBe(false);
  });
});

describe("escapeForInput", () => {
  it("encodes spaces the way `input text` expects", () => {
    expect(escapeForInput("hello world")).toBe("hello%sworld");
  });

  it("escapes shell metacharacters so a password cannot become a command", () => {
    const escaped = escapeForInput("p@ss;rm -rf /");
    expect(escaped).not.toMatch(/(^|[^\\]);/);
    expect(escaped).toContain("\\;");
  });

  it("escapes quotes and backslashes", () => {
    expect(escapeForInput('a"b')).toBe('a\\"b');
    expect(escapeForInput("a\\b")).toBe("a\\\\b");
  });
});

describe("androidKeycode", () => {
  it("maps friendly names", () => {
    expect(androidKeycode("back")).toBe("KEYCODE_BACK");
    expect(androidKeycode("enter")).toBe("KEYCODE_ENTER");
    expect(androidKeycode("volume-up")).toBe("KEYCODE_VOLUME_UP");
  });

  it("passes raw keycodes through", () => {
    expect(androidKeycode("KEYCODE_MEDIA_PLAY")).toBe("KEYCODE_MEDIA_PLAY");
  });

  it("rejects an unknown key with the list of valid ones", () => {
    expect(() => androidKeycode("wiggle")).toThrow(/Unknown key/);
  });
});
