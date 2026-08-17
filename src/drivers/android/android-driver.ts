/**
 * The Android driver.
 *
 * Everything routes through adb, so there is nothing to install on the device
 * and nothing to keep running between commands — `connect` is little more than
 * a reachability check.
 */

import { XMLParser } from "fast-xml-parser";
import { NatError } from "../../core/errors.js";
import { centerOf, toRelativeRect } from "../../core/coords.js";
import { flatten } from "../../core/tree.js";
import type {
  AlertAction,
  AppInfo,
  Device,
  DevicePoint,
  Driver,
  InputOptions,
  ScreenSize,
  SwipeOptions,
  TapOptions,
  UiElement,
} from "../../core/types.js";
import * as adb from "./adb.js";

export class AndroidDriver implements Driver {
  readonly platform = "android" as const;
  readonly device: Device;
  private cachedScreen: ScreenSize | undefined;

  constructor(device: Device) {
    this.device = device;
  }

  async connect(): Promise<void> {
    const state = await adb.getProp(this.device.id, "sys.boot_completed");
    if (state.trim() !== "1") {
      throw new NatError("DEVICE_NOT_READY", `${this.device.name} has not finished booting`, {
        hint: "Wait for the home screen to appear, then connect again.",
      });
    }
  }

  async dispose(): Promise<void> {
    // adb is stateless from our side.
  }

  async isAlive(): Promise<boolean> {
    try {
      return (await adb.getProp(this.device.id, "sys.boot_completed")).trim() === "1";
    } catch {
      return false;
    }
  }

  async screenSize(): Promise<ScreenSize> {
    if (!this.cachedScreen) this.cachedScreen = await adb.screenSize(this.device.id);
    return this.cachedScreen;
  }

  async screenshot(): Promise<Buffer> {
    return await adb.screenshot(this.device.id);
  }

  async rawSource(): Promise<unknown> {
    return await adb.uiHierarchy(this.device.id);
  }

  normalizeSource(raw: unknown, screen: ScreenSize): UiElement[] {
    return parseUiAutomatorXml(String(raw), screen);
  }

  async tap(point: DevicePoint, options: TapOptions = {}): Promise<void> {
    if (options.duration && options.duration > 0) {
      await adb.longPress(this.device.id, point.x, point.y, Math.round(options.duration * 1000));
      return;
    }
    await adb.tap(this.device.id, point.x, point.y);
    if (options.double) await adb.tap(this.device.id, point.x, point.y);
  }

  async swipe(from: DevicePoint, to: DevicePoint, options: SwipeOptions = {}): Promise<void> {
    await adb.swipe(
      this.device.id,
      from.x,
      from.y,
      to.x,
      to.y,
      Math.round((options.duration ?? 0.35) * 1000),
    );
  }

  async drag(from: DevicePoint, to: DevicePoint, options: SwipeOptions = {}): Promise<void> {
    await adb.dragAndDrop(
      this.device.id,
      from.x,
      from.y,
      to.x,
      to.y,
      Math.round((options.duration ?? 1) * 1000),
    );
  }

  async typeText(text: string, options: InputOptions = {}): Promise<void> {
    if (options.clear) {
      // Move to the end of the field, then delete backwards. `input keyevent`
      // accepts a list, so this is one round trip rather than one per character.
      // Deleting past the start of a field is a no-op, so when the caller has
      // not told us the length a generous sweep is safe.
      const deletes = Math.min(500, Math.max(1, options.clearLength ?? 120));
      await adb.keyEvent(this.device.id, "KEYCODE_MOVE_END");
      await adb.shell(
        this.device.id,
        `input keyevent ${Array(deletes).fill("KEYCODE_DEL").join(" ")}`,
        120_000,
      );
    }
    await adb.typeText(this.device.id, text);
    if (options.submit) await adb.keyEvent(this.device.id, "KEYCODE_ENTER");
  }

  async pressKey(key: string): Promise<void> {
    await adb.keyEvent(this.device.id, androidKeycode(key));
  }

  async activateApp(bundleId: string): Promise<void> {
    await adb.launchPackage(this.device.id, bundleId);
  }

  async terminateApp(bundleId: string): Promise<void> {
    await adb.forceStop(this.device.id, bundleId);
  }

  async backgroundApp(): Promise<void> {
    await adb.keyEvent(this.device.id, "KEYCODE_HOME");
  }

  async openUrl(url: string): Promise<void> {
    await adb.openUrl(this.device.id, url);
  }

  async currentApp(): Promise<string | undefined> {
    return await adb.currentPackage(this.device.id);
  }

  async installApp(path: string): Promise<void> {
    await adb.installApk(this.device.id, path);
  }

  async uninstallApp(bundleId: string): Promise<void> {
    await adb.uninstallPackage(this.device.id, bundleId);
  }

  async listApps(): Promise<AppInfo[]> {
    return await adb.listPackages(this.device.id);
  }

  /**
   * Android has no alert API — a permission dialog is ordinary UI. So we read
   * the tree, find the button that matches the intent and tap it, which is
   * exactly what a human does and works for OEM dialogs too.
   */
  async handleAlert(action: AlertAction): Promise<void> {
    const screen = await this.screenSize();
    const elements = this.normalizeSource(await this.rawSource(), screen);
    const candidates = flatten(elements).filter(
      (node) => node.role === "button" && (node.label || node.value),
    );

    const patterns =
      action === "accept"
        ? [/^(allow|ok|yes|accept|continue|agree|while using the app|only this time|got it)$/i, /allow/i, /^ok$/i]
        : [/^(deny|cancel|no|dont allow|don't allow|not now|later|reject)$/i, /deny/i, /cancel/i];

    for (const pattern of patterns) {
      const match = candidates.find((node) => pattern.test((node.label ?? node.value ?? "").trim()));
      if (match) {
        await this.tap({
          x: Math.round((match.center.x / 1000) * screen.width),
          y: Math.round((match.center.y / 1000) * screen.height),
        });
        return;
      }
    }

    throw new NatError("ELEMENT_NOT_FOUND", `No ${action} button is visible on screen`, {
      hint: "Run `nat screen` to see what is actually shown, then tap the button by coordinates or description.",
      details: { buttons: candidates.map((node) => node.label ?? node.value).slice(0, 12) },
    });
  }

  async alertText(): Promise<string | undefined> {
    const screen = await this.screenSize();
    const elements = this.normalizeSource(await this.rawSource(), screen);
    const texts = flatten(elements)
      .filter((node) => node.role === "text" && node.label)
      .map((node) => node.label as string);
    return texts.length > 0 ? texts.slice(0, 4).join(" ") : undefined;
  }
}

// ------------------------------------------------------- tree normalization

interface RawNode {
  ":@"?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * UiAutomator emits `bounds="[left,top][right,bottom]"` in device pixels; the
 * rest of the attributes map cleanly onto the shared element shape.
 */
export function parseUiAutomatorXml(xml: string, screen: ScreenSize): UiElement[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    attributesGroupName: ":@",
    preserveOrder: true,
    parseAttributeValue: false,
    trimValues: true,
  });

  let parsed: RawNode[];
  try {
    parsed = parser.parse(xml) as RawNode[];
  } catch (cause) {
    throw new NatError("DRIVER_FAILED", "Could not parse the UiAutomator hierarchy", { cause });
  }

  const hierarchy = parsed.find((entry) => "hierarchy" in entry);
  const roots = (hierarchy?.["hierarchy"] as RawNode[] | undefined) ?? [];
  return convertNodes(roots, screen, "");
}

function convertNodes(nodes: RawNode[], screen: ScreenSize, prefix: string): UiElement[] {
  const out: UiElement[] = [];
  let index = 0;
  for (const entry of nodes) {
    const childKey = Object.keys(entry).find((key) => key !== ":@");
    if (childKey !== "node") continue;

    const attributes = entry[":@"] ?? {};
    const id = prefix ? `${prefix}.${index}` : String(index);
    index += 1;

    const bounds = parseBounds(attributes["bounds"] ?? "");
    const rect = toRelativeRect(bounds, screen);
    const nativeType = attributes["class"] ?? "android.view.View";
    const label = firstText(attributes["content-desc"], attributes["text"]);
    const value = attributes["text"]?.trim() || undefined;
    const clickable = attributes["clickable"] === "true";
    const scrollable = attributes["scrollable"] === "true";

    out.push({
      id,
      role: androidRole(nativeType, { clickable, scrollable, checkable: attributes["checkable"] === "true" }),
      nativeType,
      ...(label ? { label } : {}),
      ...(value && value !== label ? { value } : {}),
      ...(attributes["hint"] ? { placeholder: attributes["hint"] } : {}),
      ...(attributes["resource-id"] ? { identifier: shortResourceId(attributes["resource-id"]) } : {}),
      rect,
      center: centerOf(rect),
      enabled: attributes["enabled"] !== "false",
      ...(attributes["focused"] === "true" ? { focused: true } : {}),
      ...(attributes["selected"] === "true" || attributes["checked"] === "true" ? { selected: true } : {}),
      children: convertNodes((entry[childKey] as RawNode[] | undefined) ?? [], screen, id),
    });
  }
  return out;
}

export function parseBounds(bounds: string): { x: number; y: number; width: number; height: number } {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(bounds);
  if (!match) return { x: 0, y: 0, width: 0, height: 0 };
  const [, left, top, right, bottom] = match.map(Number) as [number, number, number, number, number];
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const ANDROID_ROLES: Array<[RegExp, string]> = [
  [/Button$|MaterialButton|Chip$/, "button"],
  [/ImageButton$/, "button"],
  [/EditText$|TextInputEditText|AutoCompleteTextView/, "field"],
  [/SearchView/, "search-field"],
  [/CheckBox$|CheckedTextView/, "checkbox"],
  [/RadioButton$/, "radio"],
  [/Switch$|SwitchCompat|ToggleButton$/, "switch"],
  [/SeekBar$|Slider$/, "slider"],
  [/RatingBar$/, "slider"],
  [/TextView$|MaterialTextView/, "text"],
  [/ImageView$/, "image"],
  [/WebView$/, "webview"],
  [/MapView|com\.google\.android\.gms\.maps/, "map"],
  [/SurfaceView$|TextureView$|GLSurfaceView/, "canvas"],
  [/RecyclerView$|ListView$|GridView$/, "collection"],
  [/ScrollView$|NestedScrollView|ViewPager/, "scroll"],
  [/TabLayout|TabWidget/, "tabbar"],
  [/Toolbar$|ActionBar/, "toolbar"],
  [/ProgressBar$/, "progress"],
  [/Layout$|ViewGroup$/, "group"],
];

export function androidRole(
  nativeType: string,
  flags: { clickable?: boolean; scrollable?: boolean; checkable?: boolean } = {},
): string {
  for (const [pattern, role] of ANDROID_ROLES) {
    if (pattern.test(nativeType)) {
      // A clickable list row is a cell the agent can tap, not a plain group.
      if (role === "group" && flags.clickable) return "cell";
      if (role === "text" && flags.clickable) return "button";
      if (role === "image" && flags.clickable) return "button";
      return role;
    }
  }
  if (flags.scrollable) return "scroll";
  if (flags.checkable) return "checkbox";
  if (flags.clickable) return "button";
  return "other";
}

function shortResourceId(value: string): string {
  const slash = value.indexOf("/");
  return slash === -1 ? value : value.slice(slash + 1);
}

function firstText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

const KEYCODES: Record<string, string> = {
  home: "KEYCODE_HOME",
  back: "KEYCODE_BACK",
  enter: "KEYCODE_ENTER",
  return: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  space: "KEYCODE_SPACE",
  backspace: "KEYCODE_DEL",
  delete: "KEYCODE_DEL",
  escape: "KEYCODE_ESCAPE",
  menu: "KEYCODE_MENU",
  power: "KEYCODE_POWER",
  volumeup: "KEYCODE_VOLUME_UP",
  volumedown: "KEYCODE_VOLUME_DOWN",
  recents: "KEYCODE_APP_SWITCH",
  search: "KEYCODE_SEARCH",
  camera: "KEYCODE_CAMERA",
};

export function androidKeycode(key: string): string {
  const normalized = key.toLowerCase().replace(/[\s_-]/g, "");
  const mapped = KEYCODES[normalized];
  if (mapped) return mapped;
  if (/^KEYCODE_[A-Z0-9_]+$/.test(key)) return key;
  throw new NatError("INVALID_ARGUMENT", `Unknown key \`${key}\` for Android`, {
    hint: `Supported: ${Object.keys(KEYCODES).join(", ")} — or any raw KEYCODE_* constant.`,
  });
}
