/**
 * MCP server — the same device loop, exposed as tools instead of a CLI.
 *
 * Two ways to reach the device, one implementation behind both. The CLI is the
 * lower-friction path for coding agents that can run shell commands (Claude
 * Code, Codex, Cursor); MCP is for hosts that prefer typed tools, and for
 * editors where shell access is restricted.
 *
 * The tool vocabulary matches the CLI verb for verb, so a failure an agent hits
 * over MCP can be reproduced by a human typing `nat` commands.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { isNatError } from "../core/errors.js";
import { readScreen } from "../core/screen.js";
import { renderSnapshot } from "../core/tree.js";
import { toDevicePoint } from "../core/coords.js";
import { attachDriverEnsuringAgent, connectDevice, listDevices } from "../drivers/index.js";
import { readSession } from "../core/session.js";
import { resolveTarget, directionToSwipe } from "../commands/shared.js";
import type { AlertAction, Driver, Point } from "../core/types.js";

type TextResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

/** Target flags shared by the gesture tools. */
const target = {
  x: z.number().min(0).max(1000).optional().describe("Horizontal tap position, 0-1000 (from mobile_screen)."),
  y: z.number().min(0).max(1000).optional().describe("Vertical tap position, 0-1000."),
  description: z
    .string()
    .optional()
    .describe("Plain-language description of the element — use when the tree has nothing to aim at."),
};

const direction = z.enum(["up", "down", "left", "right"]);

export async function startMcpServer(version: string): Promise<void> {
  const server = new McpServer({ name: "native-ai-tester", version });

  server.registerTool(
    "mobile_devices",
    {
      description:
        "List connected iOS and Android devices, simulators and emulators. Start here to find a device id.",
      inputSchema: { platform: z.enum(["ios", "android"]).optional() },
    },
    (args) =>
      guard(async () => {
        const devices = await listDevices(args.platform ? { platform: args.platform } : {});
        const session = await readSession();
        if (devices.length === 0) {
          return text(
            "No devices found. Connect a phone by cable and unlock it, or start a simulator/emulator. Run `nat doctor` in a shell for a full toolchain check.",
          );
        }
        const rows = devices.map(
          (device) =>
            `${session?.deviceId === device.id ? "* " : "  "}${device.id}  ${device.platform}/${device.kind}  ${device.osVersion ?? "?"}  ${device.name}${device.ready ? "" : `  [${device.note ?? device.state}]`}`,
        );
        return text(
          `${rows.join("\n")}\n\n${session ? `Connected: ${session.name} (${session.deviceId})` : "Nothing connected — call mobile_connect."}`,
        );
      }),
  );

  server.registerTool(
    "mobile_connect",
    {
      description:
        "Connect to a device so later calls can drive it. Boots a simulator and starts the iOS agent — the first iOS connect can take a few minutes while WebDriverAgent builds.",
      inputSchema: { device_id: z.string().optional().describe("Device id, id prefix, or name.") },
    },
    (args) =>
      guard(async () => {
        const result = await connectDevice(args.device_id);
        return text(
          `Connected ${result.device.name} (${result.device.id}) — ${result.device.platform} ${result.device.osVersion ?? ""}.\nCall mobile_screen to read the UI.`,
        );
      }),
  );

  server.registerTool(
    "mobile_screen",
    {
      description:
        "Read the current UI as a cleaned element tree with a tap point for every element, in a 0-1000 coordinate space. Call this before and after every action — it is much cheaper than a screenshot.",
      inputSchema: { full: z.boolean().optional().describe("Return the raw, unfiltered platform tree.") },
    },
    (args) =>
      guard(async () => {
        const { driver } = await attachDriverEnsuringAgent();
        const snapshot = await readScreen(driver, { full: args.full === true });
        return text(renderSnapshot(snapshot));
      }),
  );

  server.registerTool(
    "mobile_screenshot",
    {
      description:
        "Capture the screen as an image. Use only when the element tree is empty or cannot answer the question — a game, a canvas, a visual defect.",
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const { driver } = await attachDriverEnsuringAgent();
        const image = await driver.screenshot();
        return { content: [{ type: "image" as const, data: image.toString("base64"), mimeType: "image/png" }] };
      }),
  );

  server.registerTool(
    "mobile_tap",
    {
      description: "Tap, double-tap or long-press an element.",
      inputSchema: {
        ...target,
        double: z.boolean().optional(),
        duration: z.number().optional().describe("Hold this many seconds for a long press."),
      },
    },
    (args) =>
      guard(async () => {
        const { driver } = await attachDriverEnsuringAgent();
        const resolved = await resolveTarget(driver, targetOptions(args));
        await driver.tap(resolved.point, {
          ...(args.double ? { double: true } : {}),
          ...(args.duration ? { duration: args.duration } : {}),
        });
        return text(`Tapped ${resolved.relative.x},${resolved.relative.y}.`);
      }),
  );

  for (const kind of ["swipe", "drag"] as const) {
    server.registerTool(
      `mobile_${kind}`,
      {
        description:
          kind === "swipe"
            ? "Swipe or scroll — by direction, between two points, or on a described element."
            : "Press, hold and drag — for reordering lists and dropping an item onto a target.",
        inputSchema: {
          ...target,
          direction: direction.optional(),
          x2: z.number().min(0).max(1000).optional().describe("End x, when giving explicit points."),
          y2: z.number().min(0).max(1000).optional().describe("End y, when giving explicit points."),
          duration: z.number().optional().describe("Gesture duration in seconds."),
        },
      },
      (args) =>
        guard(async () => {
          const { driver } = await attachDriverEnsuringAgent();
          const screen = await driver.screenSize();
          const { from, to } = await gesturePoints(driver, args);
          const options = args.duration ? { duration: args.duration } : {};
          if (kind === "swipe") await driver.swipe(toDevicePoint(from, screen), toDevicePoint(to, screen), options);
          else await driver.drag(toDevicePoint(from, screen), toDevicePoint(to, screen), options);
          return text(`${kind === "swipe" ? "Swiped" : "Dragged"} ${from.x},${from.y} to ${to.x},${to.y}.`);
        }),
    );
  }

  server.registerTool(
    "mobile_type",
    {
      description: "Tap a field and type into it. Omit the target to type into the already-focused field.",
      inputSchema: {
        ...target,
        text: z.string(),
        clear: z.boolean().optional().describe("Clear the field first."),
        submit: z.boolean().optional().describe("Press enter afterwards."),
      },
    },
    (args) =>
      guard(async () => {
        const { driver } = await attachDriverEnsuringAgent();
        let clearLength: number | undefined;
        if (args.x !== undefined || args.description !== undefined) {
          const resolved = await resolveTarget(driver, targetOptions(args));
          await driver.tap(resolved.point);
          clearLength = resolved.grounding?.element?.value?.length;
        }
        await driver.typeText(args.text, {
          ...(args.clear ? { clear: true } : {}),
          ...(clearLength !== undefined ? { clearLength } : {}),
          ...(args.submit ? { submit: true } : {}),
        });
        return text(`Typed ${JSON.stringify(args.text)}.`);
      }),
  );

  server.registerTool(
    "mobile_key",
    {
      description: "Press a hardware or keyboard key: home, back, enter, tab, escape, volumeup, volumedown.",
      inputSchema: { key: z.string() },
    },
    (args) =>
      guard(async () => {
        const { driver } = await attachDriverEnsuringAgent();
        await driver.pressKey(args.key);
        return text(`Pressed ${args.key}.`);
      }),
  );

  server.registerTool(
    "mobile_app",
    {
      description:
        "Foreground, quit or restart an app, or list what is installed. `restart` is the reliable way back to a known state.",
      inputSchema: {
        action: z.enum(["activate", "terminate", "restart", "background", "list"]),
        bundle_id: z.string().optional().describe("iOS bundle id or Android package name."),
      },
    },
    (args) =>
      guard(async () => {
        const { driver } = await attachDriverEnsuringAgent();
        switch (args.action) {
          case "list": {
            const apps = await driver.listApps();
            return text(
              apps.length === 0
                ? "No apps found."
                : apps.map((app) => `${app.bundleId}${app.name ? `  ${app.name}` : ""}`).join("\n"),
            );
          }
          case "background":
            await driver.backgroundApp();
            return text("Sent the app to the background.");
          case "activate":
            await driver.activateApp(requireBundleId(args.bundle_id));
            return text(`Activated ${args.bundle_id}.`);
          case "terminate":
            await driver.terminateApp(requireBundleId(args.bundle_id));
            return text(`Terminated ${args.bundle_id}.`);
          case "restart":
            await driver.terminateApp(requireBundleId(args.bundle_id));
            await driver.activateApp(requireBundleId(args.bundle_id));
            return text(`Restarted ${args.bundle_id}.`);
        }
      }),
  );

  server.registerTool(
    "mobile_open_url",
    {
      description:
        "Open a URL or deep link. Use this to jump straight to a screen that would otherwise take several taps to reach, or to test that a deep link resolves to the right place.",
      inputSchema: { url: z.string() },
    },
    (args) =>
      guard(async () => {
        const { driver } = await attachDriverEnsuringAgent();
        await driver.openUrl(args.url);
        return text(`Opened ${args.url}.`);
      }),
  );

  server.registerTool(
    "mobile_alert",
    {
      description: "Accept or dismiss a system alert — permissions, sign-in sheets, rating prompts.",
      inputSchema: { action: z.enum(["accept", "dismiss"]) },
    },
    (args) =>
      guard(async () => {
        const { driver } = await attachDriverEnsuringAgent();
        const alertText = await driver.alertText().catch(() => undefined);
        await driver.handleAlert(args.action as AlertAction);
        return text(
          `${args.action === "accept" ? "Accepted" : "Dismissed"} the alert${alertText ? `: ${alertText}` : ""}.`,
        );
      }),
  );

  server.registerTool(
    "mobile_wait",
    {
      description:
        "Pause while the app settles — a network call, an animation, a splash screen. Prefer re-reading the screen over long waits.",
      inputSchema: { seconds: z.number().min(0).max(30) },
    },
    (args) =>
      guard(async () => {
        await delay(args.seconds * 1000);
        return text(`Waited ${args.seconds}s.`);
      }),
  );

  await server.connect(new StdioServerTransport());
}

function requireBundleId(bundleId: string | undefined): string {
  if (!bundleId) throw new Error("bundle_id is required for this action");
  return bundleId;
}

function targetOptions(args: { x?: number; y?: number; description?: string }) {
  return {
    ...(args.x !== undefined ? { x: args.x } : {}),
    ...(args.y !== undefined ? { y: args.y } : {}),
    ...(args.description ? { description: args.description } : {}),
  };
}

async function gesturePoints(
  driver: Driver,
  args: { x?: number; y?: number; x2?: number; y2?: number; direction?: string; description?: string },
): Promise<{ from: Point; to: Point }> {
  if (args.x !== undefined && args.y !== undefined && args.x2 !== undefined && args.y2 !== undefined) {
    return { from: { x: args.x, y: args.y }, to: { x: args.x2, y: args.y2 } };
  }
  const dir = (args.direction ?? "up") as "up" | "down" | "left" | "right";
  if (args.description) {
    const resolved = await resolveTarget(driver, { description: args.description });
    const box = resolved.grounding?.element?.rect;
    const span = box ? Math.max(120, Math.min(box.width, box.height) * 0.8) : 400;
    return around(resolved.relative, dir, span);
  }
  return directionToSwipe(dir);
}

function around(center: Point, dir: "up" | "down" | "left" | "right", span: number): { from: Point; to: Point } {
  const half = span / 2;
  const clamp = (value: number) => Math.min(995, Math.max(5, Math.round(value * 10) / 10));
  switch (dir) {
    case "up":
      return { from: { x: center.x, y: clamp(center.y + half) }, to: { x: center.x, y: clamp(center.y - half) } };
    case "down":
      return { from: { x: center.x, y: clamp(center.y - half) }, to: { x: center.x, y: clamp(center.y + half) } };
    case "left":
      return { from: { x: clamp(center.x + half), y: center.y }, to: { x: clamp(center.x - half), y: center.y } };
    case "right":
      return { from: { x: clamp(center.x - half), y: center.y }, to: { x: clamp(center.x + half), y: center.y } };
  }
}

function text(value: string): TextResult {
  return { content: [{ type: "text", text: value }] };
}

/**
 * Failures come back as tool results, not protocol errors.
 *
 * "no device connected" or "that element isn't on screen" is information the
 * model should act on — reconnecting, or reading the screen again — not a
 * transport-level fault that ends the conversation.
 */
async function guard(body: () => Promise<TextResult>): Promise<TextResult> {
  try {
    return await body();
  } catch (error) {
    const message = isNatError(error)
      ? error.hint
        ? `${error.message}\n\nhint: ${error.hint}`
        : error.message
      : error instanceof Error
        ? error.message
        : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
