/**
 * WebDriverAgent HTTP client.
 *
 * WebDriverAgent is the XCUITest server Apple's own test runner hosts on the
 * device; Appium drives it too. We talk to it directly rather than running
 * Appium on top, which removes an entire Node server, its driver plugins and
 * its capability negotiation from the install path — the thing the user has to
 * set up is exactly the thing that has to exist anyway.
 *
 * All gestures go through the W3C Actions endpoint. WDA's older bespoke
 * `/wda/tap`, `/wda/dragfromtoforduration` routes drift between releases;
 * `/actions` is the spec-defined surface and expresses tap, long-press, swipe
 * and drag with one payload shape.
 */

import { NatError } from "../../core/errors.js";
import { debug } from "../../core/output.js";
import type { AlertAction, DevicePoint, ScreenSize } from "../../core/types.js";

export interface WdaStatus {
  ready: boolean;
  sessionId?: string;
  build?: Record<string, unknown>;
  ios?: Record<string, unknown>;
}

interface WdaResponse<T> {
  value: T;
  sessionId?: string;
}

const DEFAULT_TIMEOUT = 30_000;

export class WdaClient {
  readonly baseUrl: string;
  private sessionId: string | undefined;

  constructor(baseUrl: string, sessionId?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.sessionId = sessionId;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  async status(timeout = 5_000): Promise<WdaStatus> {
    const value = await this.request<Record<string, unknown>>("GET", "/status", undefined, timeout);
    return {
      ready: value?.["ready"] !== false,
      sessionId: typeof value?.["sessionId"] === "string" ? (value["sessionId"] as string) : undefined,
      build: value?.["build"] as Record<string, unknown> | undefined,
      ios: value?.["ios"] as Record<string, unknown> | undefined,
    };
  }

  /** True when the agent answers `/status` — used to reuse a live agent. */
  async isUp(timeout = 2_000): Promise<boolean> {
    try {
      await this.status(timeout);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create (or adopt) a session.
   *
   * WDA keeps one session at a time and reports it on `/status`; adopting it
   * matters because creating a fresh session resets the device to the home
   * screen, which would destroy the state a test just built up.
   */
  async ensureSession(bundleId?: string): Promise<string> {
    if (this.sessionId && (await this.sessionAlive(this.sessionId))) return this.sessionId;

    const status = await this.status();
    if (status.sessionId && (await this.sessionAlive(status.sessionId))) {
      this.sessionId = status.sessionId;
      debug(`wda: adopted existing session ${this.sessionId}`);
      return this.sessionId;
    }

    const alwaysMatch: Record<string, unknown> = {
      // Leave the foreground app alone unless the caller asked for one.
      "appium:shouldWaitForQuiescence": false,
      "appium:waitForQuiescenceTimeout": 0,
    };
    if (bundleId) alwaysMatch["bundleId"] = bundleId;

    const created = await this.request<Record<string, unknown>>(
      "POST",
      "/session",
      { capabilities: { alwaysMatch, firstMatch: [{}] } },
      60_000,
    );
    const id = (created?.["sessionId"] as string | undefined) ?? this.lastSessionId;
    if (!id) {
      throw new NatError("AGENT_UNAVAILABLE", "WebDriverAgent did not return a session id", {
        hint: "Run `nat doctor` — the agent may have started but failed to attach to the device.",
      });
    }
    this.sessionId = id;
    debug(`wda: created session ${id}`);
    return id;
  }

  private lastSessionId: string | undefined;

  private async sessionAlive(sessionId: string): Promise<boolean> {
    try {
      await this.request("GET", `/session/${sessionId}/window/size`, undefined, 5_000);
      return true;
    } catch {
      return false;
    }
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.request("DELETE", `/session/${this.sessionId}`, undefined, 10_000);
    } catch {
      // A dead session is the desired end state either way.
    }
    this.sessionId = undefined;
  }

  // ---------------------------------------------------------------- reading

  async windowSize(): Promise<ScreenSize> {
    const session = await this.ensureSession();
    const size = await this.request<{ width: number; height: number }>(
      "GET",
      `/session/${session}/window/size`,
    );
    let scale: number | undefined;
    try {
      const screen = await this.request<{ scale?: number }>("GET", `/session/${session}/wda/screen`);
      scale = screen?.scale;
    } catch {
      // `wda/screen` is a nicety; the point size is what gestures need.
    }
    return { width: size.width, height: size.height, ...(scale ? { scale } : {}) };
  }

  async screenshot(): Promise<Buffer> {
    const base64 = await this.request<string>("GET", "/screenshot", undefined, 30_000);
    return Buffer.from(base64, "base64");
  }

  async source(): Promise<unknown> {
    const session = await this.ensureSession();
    return await this.request<unknown>(
      "GET",
      `/session/${session}/source?format=json&excluded_attributes=visible`,
      undefined,
      60_000,
    );
  }

  async activeAppInfo(): Promise<{ bundleId?: string } | undefined> {
    try {
      const session = await this.ensureSession();
      return await this.request<{ bundleId?: string }>("GET", `/session/${session}/wda/activeAppInfo`);
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------- acting

  async tap(point: DevicePoint, options: { duration?: number; double?: boolean } = {}): Promise<void> {
    const holdMs = Math.round((options.duration ?? 0) * 1000) || 60;
    const sequence: PointerAction[] = [
      { type: "pointerMove", duration: 0, x: point.x, y: point.y },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: holdMs },
      { type: "pointerUp", button: 0 },
    ];
    if (options.double) {
      sequence.push(
        { type: "pause", duration: 80 },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 60 },
        { type: "pointerUp", button: 0 },
      );
    }
    await this.performActions(sequence);
  }

  async swipe(from: DevicePoint, to: DevicePoint, durationSeconds = 0.35): Promise<void> {
    const moveMs = Math.max(50, Math.round(durationSeconds * 1000));
    await this.performActions([
      { type: "pointerMove", duration: 0, x: from.x, y: from.y },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 30 },
      { type: "pointerMove", duration: moveMs, x: to.x, y: to.y },
      { type: "pointerUp", button: 0 },
    ]);
  }

  /**
   * A drag differs from a swipe by the press that precedes the movement:
   * drag-and-drop targets (list reordering, a card onto a drop zone) only pick
   * up after a long press, and a fast flick would scroll instead.
   */
  async drag(from: DevicePoint, to: DevicePoint, durationSeconds = 1): Promise<void> {
    const moveMs = Math.max(200, Math.round(durationSeconds * 1000));
    await this.performActions([
      { type: "pointerMove", duration: 0, x: from.x, y: from.y },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 700 },
      { type: "pointerMove", duration: moveMs, x: to.x, y: to.y },
      { type: "pause", duration: 250 },
      { type: "pointerUp", button: 0 },
    ]);
  }

  private async performActions(actions: PointerAction[]): Promise<void> {
    const session = await this.ensureSession();
    await this.request(
      "POST",
      `/session/${session}/actions`,
      {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions,
          },
        ],
      },
      60_000,
    );
  }

  async typeText(text: string): Promise<void> {
    const session = await this.ensureSession();
    await this.request("POST", `/session/${session}/wda/keys`, { value: [...text] }, 60_000);
  }

  async pressButton(name: string): Promise<void> {
    const session = await this.ensureSession();
    await this.request("POST", `/session/${session}/wda/pressButton`, { name });
  }

  // ------------------------------------------------------------ app control

  async launchApp(bundleId: string, args: string[] = []): Promise<void> {
    const session = await this.ensureSession();
    await this.request(
      "POST",
      `/session/${session}/wda/apps/launch`,
      { bundleId, arguments: args, shouldWaitForQuiescence: false },
      60_000,
    );
  }

  async activateApp(bundleId: string): Promise<void> {
    const session = await this.ensureSession();
    await this.request("POST", `/session/${session}/wda/apps/activate`, { bundleId }, 60_000);
  }

  async terminateApp(bundleId: string): Promise<void> {
    const session = await this.ensureSession();
    await this.request("POST", `/session/${session}/wda/apps/terminate`, { bundleId }, 60_000);
  }

  async backgroundApp(seconds = -1): Promise<void> {
    const session = await this.ensureSession();
    await this.request("POST", `/session/${session}/wda/deactivateApp`, { duration: seconds }, 60_000);
  }

  async openUrl(url: string): Promise<void> {
    const session = await this.ensureSession();
    await this.request("POST", `/session/${session}/url`, { url }, 60_000);
  }

  async alertText(): Promise<string | undefined> {
    try {
      const session = await this.ensureSession();
      return await this.request<string>("GET", `/session/${session}/alert/text`, undefined, 5_000);
    } catch {
      return undefined;
    }
  }

  async handleAlert(action: AlertAction): Promise<void> {
    const session = await this.ensureSession();
    await this.request("POST", `/session/${session}/alert/${action}`, {}, 15_000);
  }

  // ---------------------------------------------------------------- plumbing

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "AbortError";
      throw new NatError(
        aborted ? "TIMEOUT" : "AGENT_UNAVAILABLE",
        aborted
          ? `WebDriverAgent did not answer ${method} ${path} within ${timeout}ms`
          : `Cannot reach WebDriverAgent at ${this.baseUrl}`,
        {
          hint: "The agent may have stopped. Reconnect with `nat devices connect <device-id>`, or run `nat doctor`.",
          cause,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: WdaResponse<T> | undefined;
    try {
      payload = text ? (JSON.parse(text) as WdaResponse<T>) : undefined;
    } catch {
      payload = undefined;
    }

    if (payload?.sessionId) this.lastSessionId = payload.sessionId;

    if (!response.ok || isWdaError(payload?.value)) {
      throw wdaError(method, path, response.status, payload?.value, text);
    }
    return payload?.value as T;
  }
}

type PointerAction =
  | { type: "pointerMove"; duration: number; x: number; y: number }
  | { type: "pointerDown"; button: number }
  | { type: "pointerUp"; button: number }
  | { type: "pause"; duration: number };

function isWdaError(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "error" in (value as Record<string, unknown>));
}

function wdaError(
  method: string,
  path: string,
  status: number,
  value: unknown,
  raw: string,
): NatError {
  const record = (value ?? {}) as Record<string, unknown>;
  const wdaMessage =
    (typeof record["message"] === "string" && record["message"]) ||
    (typeof record["error"] === "string" && record["error"]) ||
    raw.slice(0, 400);
  const code = typeof record["error"] === "string" ? record["error"] : undefined;

  if (code === "no such element" || code === "no such alert") {
    return new NatError("ELEMENT_NOT_FOUND", String(wdaMessage), {
      details: { method, path, status },
    });
  }
  return new NatError("DRIVER_FAILED", `WebDriverAgent rejected ${method} ${path}: ${wdaMessage}`, {
    details: { status, code },
  });
}
