/**
 * Core domain types shared by every driver, command and the MCP server.
 *
 * Coordinate contract
 * -------------------
 * Everything the CLI *emits* and *accepts* on its public surface uses
 * **relative coordinates in a 0–1000 space**, with the origin at the top-left
 * of the screen. That keeps test steps portable across an iPhone SE, an iPad
 * and a 1440p Android tablet, and it means an agent never has to know the
 * physical resolution of the device it is driving.
 *
 * Drivers convert to and from native device points at the very edge.
 */

export const RELATIVE_SPACE = 1000;

export type Platform = "ios" | "android";

export type DeviceKind = "device" | "simulator" | "emulator";

export type DeviceState =
  | "connected"
  | "booted"
  | "shutdown"
  | "unavailable"
  | "unauthorized"
  | "offline";

export interface Device {
  /** Stable identifier: UDID (iOS) or adb serial (Android). */
  id: string;
  name: string;
  platform: Platform;
  kind: DeviceKind;
  state: DeviceState;
  osVersion?: string;
  model?: string;
  /** True when the device can be driven right now without extra setup. */
  ready: boolean;
  /** Human-readable reason when `ready` is false. */
  note?: string;
}

/** A point in the relative 0–1000 space. */
export interface Point {
  x: number;
  y: number;
}

/** A rectangle in the relative 0–1000 space. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point in native device points (what the driver actually sends). */
export interface DevicePoint {
  x: number;
  y: number;
}

export interface ScreenSize {
  /** Width in native device points. */
  width: number;
  /** Height in native device points. */
  height: number;
  /** Pixel density / scale factor, when the platform reports one. */
  scale?: number;
}

/**
 * One node of the normalized accessibility tree.
 *
 * The same shape is produced from XCUITest (iOS) and UiAutomator (Android) so
 * that a test step written against one platform reads identically on the other.
 */
export interface UiElement {
  /** Index path from the root, e.g. `0.3.1`. Stable within a single snapshot. */
  id: string;
  /** Normalized role: button, text, field, image, switch, cell, … */
  role: string;
  /** Raw platform class name (XCUIElementTypeButton, android.widget.Button). */
  nativeType: string;
  /** Accessible name. */
  label?: string;
  /** Current value / text content. */
  value?: string;
  /** Placeholder or hint text. */
  placeholder?: string;
  /** Developer-assigned identifier (accessibilityIdentifier / resource-id). */
  identifier?: string;
  rect: Rect;
  center: Point;
  enabled: boolean;
  focused?: boolean;
  selected?: boolean;
  /**
   * Sequential number drawn on a marked screenshot, assigned in reading order
   * to the elements worth pointing at. Present only on those elements, so it
   * doubles as "this is a tap target".
   */
  mark?: number;
  children: UiElement[];
}

export interface ScreenSnapshot {
  platform: Platform;
  deviceId: string;
  /** Bundle id / package name of the foreground app, when known. */
  app?: string;
  screen: ScreenSize;
  elements: UiElement[];
  /** Elements dropped by the cleaner, for the `--full` diagnostics line. */
  stats: {
    rawNodes: number;
    keptNodes: number;
  };
}

export type SwipeDirection = "up" | "down" | "left" | "right";

export interface TapOptions {
  /** Long-press duration in seconds. Omit or 0 for a plain tap. */
  duration?: number;
  double?: boolean;
}

export interface SwipeOptions {
  /** Total gesture duration in seconds. */
  duration?: number;
}

export interface InputOptions {
  /** Clear the field before typing. */
  clear?: boolean;
  /**
   * How many characters the field currently holds.
   *
   * Set by the caller when it just tapped a resolved element, because that is
   * the only reliable count: platform "focused" flags are set on far more than
   * the field being edited.
   */
  clearLength?: number;
  /** Submit / press enter after typing. */
  submit?: boolean;
}

export type AlertAction = "accept" | "dismiss";

export interface AppInfo {
  bundleId: string;
  name?: string;
  version?: string;
}

/**
 * The contract every platform backend implements.
 *
 * Implementations receive and return **native device points** — the relative
 * 0–1000 conversion happens one layer up, in `core/coords.ts`, so that the
 * conversion logic is written and tested exactly once.
 */
export interface Driver {
  readonly device: Device;
  readonly platform: Platform;

  /** Establish whatever session/agent the platform needs. Idempotent. */
  connect(): Promise<void>;
  /** Tear down transient resources. Must never throw. */
  dispose(): Promise<void>;
  /** Cheap liveness probe used by `nat devices current`. */
  isAlive(): Promise<boolean>;

  screenSize(): Promise<ScreenSize>;
  screenshot(): Promise<Buffer>;
  /** Raw, platform-shaped tree; normalization happens in `core/tree.ts`. */
  rawSource(): Promise<unknown>;
  /** Turn the raw tree into the normalized element list. */
  normalizeSource(raw: unknown, screen: ScreenSize): UiElement[];

  tap(point: DevicePoint, options?: TapOptions): Promise<void>;
  swipe(from: DevicePoint, to: DevicePoint, options?: SwipeOptions): Promise<void>;
  drag(from: DevicePoint, to: DevicePoint, options?: SwipeOptions): Promise<void>;
  typeText(text: string, options?: InputOptions): Promise<void>;
  pressKey(key: string): Promise<void>;

  activateApp(bundleId: string): Promise<void>;
  terminateApp(bundleId: string): Promise<void>;
  backgroundApp(): Promise<void>;
  openUrl(url: string): Promise<void>;
  currentApp(): Promise<string | undefined>;

  installApp(path: string): Promise<void>;
  uninstallApp(bundleId: string): Promise<void>;
  listApps(): Promise<AppInfo[]>;

  handleAlert(action: AlertAction): Promise<void>;
  /** Text of the visible system alert, if any. */
  alertText(): Promise<string | undefined>;
}
