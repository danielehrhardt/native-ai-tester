/**
 * The iOS driver.
 *
 * Responsibilities are split by what each tool is actually good at:
 *   • simctl / devicectl — device lifecycle, install, uninstall, list apps
 *   • WebDriverAgent     — the element tree, every gesture, app foregrounding
 *
 * Screenshots come from simctl on a simulator (faster, and it works even when
 * the agent is mid-restart) and from WDA on a real device.
 */

import { NatError } from "../../core/errors.js";
import { toRelativeRect, centerOf } from "../../core/coords.js";
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
import { WdaClient } from "./wda-client.js";
import * as simctl from "./simctl.js";
import * as devicectl from "./devicectl.js";

/** Buttons WDA presses through the hardware API rather than the keyboard. */
const HARDWARE_BUTTONS = new Set(["home", "volumeup", "volumedown", "power", "snapshot"]);

/** Roles whose contents backspacing can actually remove. */
const TEXT_ENTRY_ROLES = new Set(["field", "secure-field", "search-field"]);

/**
 * Keys XCUITest types as literal characters. These are the XCUIKeyboardKey
 * constants: an empty string here would silently do nothing, which is how a
 * "clear the field" step ends up passing while changing nothing.
 */
const IOS_KEYS: Record<string, string> = {
  enter: "\n",
  return: "\n",
  tab: "\t",
  space: " ",
  delete: "\u0008",
  backspace: "\u0008",
  escape: "\u001b",
};

export interface IosDriverState {
  wdaUrl: string;
  wdaPid?: number;
  tunnelPid?: number;
  /** CoreDevice identifier — devicectl accepts it and the UDID alike. */
  coreDeviceId?: string;
}

export class IosDriver implements Driver {
  readonly platform = "ios" as const;
  readonly device: Device;
  readonly wda: WdaClient;
  private readonly state: IosDriverState;
  private cachedScreen: ScreenSize | undefined;

  constructor(device: Device, state: IosDriverState) {
    this.device = device;
    this.state = state;
    this.wda = new WdaClient(state.wdaUrl);
  }

  private get isSimulator(): boolean {
    return this.device.kind === "simulator";
  }

  private get deviceRef(): string {
    return this.state.coreDeviceId ?? this.device.id;
  }

  async connect(): Promise<void> {
    await this.wda.ensureSession();
  }

  async dispose(): Promise<void> {
    // The agent deliberately outlives the process — see wda-manager's header.
  }

  async isAlive(): Promise<boolean> {
    return await this.wda.isUp(3_000);
  }

  async screenSize(): Promise<ScreenSize> {
    if (!this.cachedScreen) this.cachedScreen = await this.wda.windowSize();
    return this.cachedScreen;
  }

  async screenshot(): Promise<Buffer> {
    if (this.isSimulator) return await simctl.screenshot(this.device.id);
    return await this.wda.screenshot();
  }

  async rawSource(): Promise<unknown> {
    return await this.wda.source();
  }

  normalizeSource(raw: unknown, screen: ScreenSize): UiElement[] {
    const root = raw as XcuiNode | undefined;
    if (!root) return [];
    return normalizeNodes([root], screen, "");
  }

  async tap(point: DevicePoint, options: TapOptions = {}): Promise<void> {
    await this.wda.tap(point, options);
  }

  async swipe(from: DevicePoint, to: DevicePoint, options: SwipeOptions = {}): Promise<void> {
    await this.wda.swipe(from, to, options.duration ?? 0.35);
  }

  async drag(from: DevicePoint, to: DevicePoint, options: SwipeOptions = {}): Promise<void> {
    await this.wda.drag(from, to, options.duration ?? 1);
  }

  async typeText(text: string, options: InputOptions = {}): Promise<void> {
    if (options.clear) await this.clearFocusedField(options.clearLength);
    await this.wda.typeText(text);
    if (options.submit) await this.wda.typeText(IOS_KEYS["enter"]!);
  }

  /**
   * Empty the field being edited.
   *
   * XCUITest can only clear through an element handle, and this driver works
   * from coordinates by design — so it sends one delete per character instead.
   * Getting the count right is the whole problem: deleting in an empty field is
   * a no-op, so over-counting is harmless and under-counting silently leaves
   * text behind.
   *
   * The caller's count wins, because it comes from the element it just tapped.
   * Falling back on the tree, only text-entry roles are considered: WDA sets
   * `isFocused` on ordinary web content too, and trusting it there is how a
   * clear ends up deleting a single character.
   */
  private async clearFocusedField(knownLength?: number): Promise<void> {
    let length = knownLength;

    if (length === undefined) {
      const screen = await this.screenSize();
      const focused = flatten(this.normalizeSource(await this.rawSource(), screen)).find(
        (node) => node.focused && TEXT_ENTRY_ROLES.has(node.role) && (node.value ?? "").length > 0,
      );
      length = focused?.value?.length ?? 0;
    }

    if (length <= 0) return;
    await this.wda.typeText(IOS_KEYS["delete"]!.repeat(length));
  }

  async pressKey(key: string): Promise<void> {
    const normalized = key.toLowerCase().replace(/[\s_-]/g, "");
    if (HARDWARE_BUTTONS.has(normalized)) {
      await this.wda.pressButton(normalized);
      return;
    }

    const literal = IOS_KEYS[normalized];
    if (literal === undefined) {
      throw new NatError("INVALID_ARGUMENT", `Unknown key \`${key}\` for iOS`, {
        hint:
          normalized === "back"
            ? 'iOS has no hardware back button. Tap the navigation bar back control (`nat action tap -d "Back"`), or swipe in from the left edge.'
            : `Supported: ${[...HARDWARE_BUTTONS].join(", ")}, ${Object.keys(IOS_KEYS).join(", ")} - or pass literal text to \`nat action input\`.`,
      });
    }
    await this.wda.typeText(literal);
  }

  async activateApp(bundleId: string): Promise<void> {
    await this.wda.activateApp(bundleId);
  }

  async terminateApp(bundleId: string): Promise<void> {
    await this.wda.terminateApp(bundleId);
  }

  async backgroundApp(): Promise<void> {
    await this.wda.backgroundApp(-1);
  }

  async openUrl(url: string): Promise<void> {
    if (this.isSimulator) {
      await simctl.openUrl(this.device.id, url);
      return;
    }
    await this.wda.openUrl(url);
  }

  async currentApp(): Promise<string | undefined> {
    const info = await this.wda.activeAppInfo();
    return info?.bundleId;
  }

  async installApp(path: string): Promise<void> {
    if (this.isSimulator) {
      await simctl.installApp(this.device.id, path);
      return;
    }
    await devicectl.installApp(this.deviceRef, path);
  }

  async uninstallApp(bundleId: string): Promise<void> {
    if (this.isSimulator) {
      await simctl.uninstallApp(this.device.id, bundleId);
      return;
    }
    await devicectl.uninstallApp(this.deviceRef, bundleId);
  }

  async listApps(): Promise<AppInfo[]> {
    return this.isSimulator
      ? await simctl.listApps(this.device.id)
      : await devicectl.listApps(this.deviceRef);
  }

  async handleAlert(action: AlertAction): Promise<void> {
    await this.wda.handleAlert(action);
  }

  async alertText(): Promise<string | undefined> {
    return await this.wda.alertText();
  }
}

// ------------------------------------------------------- tree normalization

interface XcuiNode {
  type?: string;
  name?: string;
  label?: string;
  value?: unknown;
  placeholderValue?: string;
  rawIdentifier?: string;
  isEnabled?: boolean | string;
  isVisible?: boolean | string;
  isFocused?: boolean | string;
  isSelected?: boolean | string;
  rect?: { x: number; y: number; width: number; height: number };
  children?: XcuiNode[];
}

function normalizeNodes(nodes: XcuiNode[], screen: ScreenSize, prefix: string): UiElement[] {
  const out: UiElement[] = [];
  nodes.forEach((node, index) => {
    const id = prefix ? `${prefix}.${index}` : String(index);
    const nativeType = node.type ?? "XCUIElementTypeOther";
    const rect = toRelativeRect(node.rect ?? { x: 0, y: 0, width: 0, height: 0 }, screen);
    const label = firstText(node.label, node.name);
    const value = stringifyValue(node.value);

    out.push({
      id,
      role: iosRole(nativeType),
      nativeType,
      ...(label ? { label } : {}),
      ...(value ? { value } : {}),
      ...(node.placeholderValue ? { placeholder: node.placeholderValue } : {}),
      ...(node.rawIdentifier ? { identifier: node.rawIdentifier } : {}),
      rect,
      center: centerOf(rect),
      enabled: truthy(node.isEnabled, true),
      ...(truthy(node.isFocused, false) ? { focused: true } : {}),
      ...(truthy(node.isSelected, false) ? { selected: true } : {}),
      children: normalizeNodes(node.children ?? [], screen, id),
    });
  });
  return out;
}

/**
 * Map XCUIElementType names onto the shared role vocabulary. Anything unmapped
 * keeps a lower-cased version of its native type so a new element kind shows up
 * legibly instead of collapsing into "other".
 */
const IOS_ROLES: Record<string, string> = {
  Application: "app",
  Window: "window",
  Button: "button",
  StaticText: "text",
  TextField: "field",
  SecureTextField: "secure-field",
  SearchField: "search-field",
  TextView: "field",
  Image: "image",
  Icon: "image",
  Switch: "switch",
  Toggle: "switch",
  Slider: "slider",
  Stepper: "stepper",
  PickerWheel: "picker",
  Picker: "picker",
  DatePicker: "picker",
  Cell: "cell",
  Link: "link",
  Table: "table",
  CollectionView: "collection",
  ScrollView: "scroll",
  WebView: "webview",
  Map: "map",
  NavigationBar: "navbar",
  TabBar: "tabbar",
  TabGroup: "tabbar",
  Toolbar: "toolbar",
  Alert: "alert",
  Sheet: "sheet",
  Keyboard: "keyboard",
  Key: "key",
  SegmentedControl: "segment",
  MenuItem: "menu-item",
  ProgressIndicator: "progress",
  ActivityIndicator: "progress",
  Other: "other",
  Group: "group",
};

export function iosRole(nativeType: string): string {
  const bare = nativeType.replace(/^XCUIElementType/, "");
  return IOS_ROLES[bare] ?? bare.toLowerCase();
}

function firstText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function truthy(value: boolean | string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return value === "1" || value.toLowerCase() === "true";
}

export { simctl, devicectl };
