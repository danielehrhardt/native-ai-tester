/**
 * `nat doctor` — check the toolchain and say exactly what to do about each gap.
 *
 * The output is a checklist rather than prose because it is read by two very
 * different audiences: a developer skimming for the red line, and an agent that
 * needs a machine-readable reason it cannot proceed.
 */

import { Command } from "commander";
import { emit, color } from "../core/output.js";
import { run, which } from "../core/exec.js";
import { loadConfig } from "../core/config.js";
import { readSession } from "../core/session.js";
import { listDevices } from "../drivers/index.js";
import { detectTeamIds, isSourceReady } from "../drivers/ios/wda-manager.js";
import { isVisionConfigured } from "../llm/vision.js";
import { paths } from "../core/paths.js";
import { meetsMinimumNode, minimumNode } from "../core/version.js";

type Status = "ok" | "warn" | "fail" | "skip";

interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("check that everything needed to drive a device is in place")
    .option("--platform <platform>", "only check `ios` or `android`")
    .action(async (options: { platform?: string }) => {
      const platform = options.platform?.toLowerCase();
      const checks: Check[] = [];

      checks.push(checkNode());

      if (platform !== "android") checks.push(...(await iosChecks()));
      if (platform !== "ios") checks.push(...(await androidChecks()));

      checks.push(...(await sharedChecks()));

      const failures = checks.filter((check) => check.status === "fail").length;
      const warnings = checks.filter((check) => check.status === "warn").length;

      emit({ checks, failures, warnings }, () => render(checks, failures, warnings));

      if (failures > 0) process.exitCode = 4;
    });
}

function checkNode(): Check {
  const ok = meetsMinimumNode();
  const [major, minor, patch] = minimumNode();
  return {
    name: "Node.js",
    status: ok ? "ok" : "fail",
    detail: `v${process.versions.node}`,
    ...(ok ? {} : { fix: `native-ai-tester needs Node ${major}.${minor}.${patch} or newer.` }),
  };
}

async function iosChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  if (process.platform !== "darwin") {
    return [
      {
        name: "iOS support",
        status: "skip",
        detail: `not available on ${process.platform}`,
        fix: "iOS testing needs macOS with Xcode. Android works everywhere.",
      },
    ];
  }

  const xcodeSelect = await run("xcode-select", ["-p"], { allowFailure: true, timeout: 10_000 });
  if (xcodeSelect.code !== 0) {
    checks.push({
      name: "Xcode",
      status: "fail",
      detail: "not configured",
      fix: "Install Xcode from the App Store, then run `sudo xcode-select -s /Applications/Xcode.app`.",
    });
  } else {
    const version = await run("xcodebuild", ["-version"], { allowFailure: true, timeout: 30_000 });
    const line = version.stdout.split("\n")[0]?.trim() ?? "unknown";
    const major = Number(/Xcode (\d+)/.exec(line)?.[1] ?? 0);
    checks.push({
      name: "Xcode",
      status: major >= 16 ? "ok" : major > 0 ? "warn" : "fail",
      detail: `${line} (${xcodeSelect.stdout.trim()})`,
      ...(major > 0 && major < 16
        ? { fix: "WebDriverAgent needs Xcode 16 or newer to build." }
        : {}),
    });
  }

  const simulators = await listDevices({ platform: "ios" });
  const sims = simulators.filter((device) => device.kind === "simulator");
  const physical = simulators.filter((device) => device.kind === "device");
  const readyPhysical = physical.filter((device) => device.ready);

  checks.push({
    name: "iOS simulators",
    status: sims.length > 0 ? "ok" : "warn",
    detail: `${sims.length} available`,
    ...(sims.length === 0 ? { fix: "Open Xcode → Window → Devices and Simulators to create one." } : {}),
  });

  checks.push({
    name: "iOS devices",
    status: readyPhysical.length > 0 ? "ok" : physical.length > 0 ? "warn" : "skip",
    detail:
      readyPhysical.length > 0
        ? readyPhysical.map((device) => `${device.name} (${device.osVersion ?? "?"})`).join(", ")
        : physical.length > 0
          ? `${physical.length} paired but not connected`
          : "none paired",
    ...(physical.length > 0 && readyPhysical.length === 0
      ? { fix: "Plug the phone in, unlock it, and make sure it is trusted in Finder." }
      : {}),
  });

  const config = await loadConfig();
  if (config.ios?.teamId) {
    checks.push({ name: "Apple team id", status: "ok", detail: config.ios.teamId });
  } else {
    const teams = await detectTeamIds();
    checks.push({
      name: "Apple team id",
      status: teams.length > 0 ? "warn" : physical.length > 0 ? "fail" : "skip",
      detail: teams.length > 0 ? `${teams.length} found in your provisioning profiles, none selected` : "not set",
      fix:
        teams.length > 0
          ? `Run \`nat setup ios\` to pick one, or:\n${teams.map((team) => `    nat config set ios.teamId ${team.teamId}   # ${team.teamName ?? "unnamed team"}`).join("\n")}`
          : "Sign in to Xcode with an Apple Developer account, then run `nat setup ios`. Only needed for real devices.",
    });
  }

  const wdaVersion = config.ios?.wdaVersion ?? "v16.2.1";
  const sourceReady = await isSourceReady(wdaVersion);
  checks.push({
    name: "WebDriverAgent",
    status: sourceReady ? "ok" : "warn",
    detail: sourceReady ? `${wdaVersion} at ${paths.wdaSource()}` : `${wdaVersion} not downloaded yet`,
    ...(sourceReady ? {} : { fix: "It downloads automatically on first connect, or run `nat setup ios` now." }),
  });

  const forwarder = await findWorkingForwarder();
  checks.push({
    name: "USB port forwarding",
    status: forwarder.working ? "ok" : physical.length > 0 ? "fail" : "warn",
    detail: forwarder.working
      ? `${forwarder.working} (${forwarder.path})`
      : forwarder.broken.length > 0
        ? `${forwarder.broken.map((entry) => entry.bin).join(", ")} installed but not runnable`
        : "none installed",
    ...(forwarder.working
      ? {}
      : {
          fix:
            (forwarder.broken.length > 0
              ? `${forwarder.broken.map((entry) => `${entry.bin} at ${entry.path}: ${entry.why}`).join("\n")}\n`
              : "") +
            "A real device's agent listens on the phone, so its port must be bridged over USB:\n" +
            "    brew install libimobiledevice   # provides `iproxy` — the lightest option\n" +
            "    brew install go-ios             # provides `ios forward`\n" +
            "    pipx install pymobiledevice3    # pure Python, no brew\n" +
            "Simulators do not need this.",
        }),
  });

  return checks;
}

/**
 * Find a port forwarder that actually runs.
 *
 * Presence on PATH proves nothing: a Homebrew Python upgrade leaves
 * `pymobiledevice3` as a script pointing at an interpreter that no longer
 * exists, and it fails only when spawned. Doctor's job is to catch that here
 * rather than mid-test.
 */
async function findWorkingForwarder(): Promise<{
  working?: string;
  path?: string;
  broken: Array<{ bin: string; path: string; why: string }>;
}> {
  const broken: Array<{ bin: string; path: string; why: string }> = [];

  for (const bin of ["iproxy", "ios", "pymobiledevice3"]) {
    const path = await which(bin);
    if (!path) continue;

    const probe = await run(path, ["--help"], { allowFailure: true, timeout: 10_000 }).catch((error: unknown) => ({
      code: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }));

    // iproxy answers usage on stderr with a non-zero code; what matters is that
    // the process started at all.
    if (probe.code !== -1 && !/bad interpreter|No such file or directory/i.test(probe.stderr)) {
      return { working: bin, path, broken };
    }
    broken.push({ bin, path, why: firstLine(probe.stderr) || "could not be started" });
  }
  return { broken };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

async function androidChecks(): Promise<Check[]> {
  const adbPath = (await loadConfig()).android?.adbPath ?? (await which("adb"));
  if (!adbPath) {
    return [
      {
        name: "adb",
        status: "warn",
        detail: "not found",
        fix:
          "Install the Android platform tools:\n" +
          "    brew install --cask android-platform-tools\n" +
          "…or point at an existing one: `nat config set android.adbPath /path/to/adb`",
      },
    ];
  }

  const version = await run(adbPath, ["version"], { allowFailure: true, timeout: 15_000 });
  const devices = await listDevices({ platform: "android" });
  const ready = devices.filter((device) => device.ready);

  return [
    {
      name: "adb",
      status: "ok",
      detail: `${version.stdout.split("\n")[0]?.trim() ?? "installed"} (${adbPath})`,
    },
    {
      name: "Android devices",
      status: ready.length > 0 ? "ok" : devices.length > 0 ? "warn" : "skip",
      detail:
        ready.length > 0
          ? ready.map((device) => `${device.name} (${device.osVersion ?? "?"})`).join(", ")
          : devices.length > 0
            ? devices.map((device) => `${device.id}: ${device.note ?? device.state}`).join(", ")
            : "none connected",
      ...(devices.length > 0 && ready.length === 0
        ? { fix: "Unlock the device and accept the USB debugging prompt." }
        : {}),
    },
  ];
}

async function sharedChecks(): Promise<Check[]> {
  const config = await loadConfig();
  const session = await readSession();
  const vision = isVisionConfigured(config);

  return [
    {
      name: "Vision grounding",
      status: vision ? "ok" : "warn",
      detail: vision
        ? `${config.grounding?.provider ?? "auto"}${config.grounding?.model ? ` · ${config.grounding.model}` : ""}`
        : "not configured — descriptions resolve from the accessibility tree only",
      ...(vision
        ? {}
        : {
            fix:
              "Only needed for screens with no element tree (games, canvases, WebViews):\n" +
              "    export ANTHROPIC_API_KEY=…   # or OPENAI_API_KEY",
          }),
    },
    {
      name: "Connected device",
      status: session ? "ok" : "warn",
      detail: session ? `${session.name} (${session.deviceId})` : "none",
      ...(session ? {} : { fix: "Run `nat devices` then `nat devices connect <device-id>`." }),
    },
  ];
}

const MARKS: Record<Status, string> = {
  ok: color.green("✓"),
  warn: color.yellow("!"),
  fail: color.red("✗"),
  skip: color.dim("–"),
};

function render(checks: Check[], failures: number, warnings: number): string {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${MARKS[check.status]} ${check.name.padEnd(22)} ${check.detail}`);
    if (check.fix) {
      for (const fixLine of check.fix.split("\n")) lines.push(color.dim(`    ${fixLine}`));
    }
  }
  lines.push("");
  if (failures === 0 && warnings === 0) lines.push(color.green("Everything checks out."));
  else if (failures === 0) lines.push(color.yellow(`${warnings} warning${warnings === 1 ? "" : "s"} — nothing blocking.`));
  else lines.push(color.red(`${failures} blocking issue${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`));
  return lines.join("\n");
}
