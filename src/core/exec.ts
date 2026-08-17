/**
 * Thin, promise-based wrapper around child_process.
 *
 * Every external tool (xcrun, adb, xcodebuild, iproxy) goes through here so
 * that timeouts, binary-safe output and error formatting are handled once.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { NatError } from "./errors.js";

export interface RunOptions {
  /** Milliseconds before the child is killed. Default 60s. */
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Data piped to the child's stdin. */
  input?: string | Buffer;
  /** Resolve instead of throwing when the exit code is non-zero. */
  allowFailure?: boolean;
  /** Keep stdout as raw bytes (screenshots, binary dumps). */
  binary?: boolean;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT = 60_000;

export async function run(
  command: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<RunResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  };

  return await new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, spawnOptions);
    } catch (cause) {
      reject(spawnFailure(command, cause));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeout)
        : undefined;

    const onAbort = () => {
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(spawnFailure(command, cause));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();

      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const result: RunResult = {
        code: code ?? -1,
        stdout: options.binary ? "" : stdoutBuffer.toString("utf8"),
        stderr,
        stdoutBuffer,
        timedOut,
      };

      if (timedOut && !options.allowFailure) {
        reject(
          new NatError("TIMEOUT", `\`${command}\` timed out after ${timeout}ms`, {
            details: { command, args, stderr: stderr.slice(0, 2000) },
          }),
        );
        return;
      }

      if (result.code !== 0 && !options.allowFailure) {
        reject(
          new NatError(
            "DRIVER_FAILED",
            `\`${command} ${args.join(" ")}\` exited with ${result.code}` +
              (stderr.trim() ? `: ${firstLines(stderr, 4)}` : ""),
            { details: { command, args, code: result.code, stderr: stderr.slice(0, 4000) } },
          ),
        );
        return;
      }

      resolve(result);
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

/** Start a long-lived process and hand back the handle. Used for WDA / iproxy. */
export function spawnBackground(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; onStdout?: (line: string) => void; onStderr?: (line: string) => void } = {},
) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  if (options.onStdout) pipeLines(child.stdout, options.onStdout);
  if (options.onStderr) pipeLines(child.stderr, options.onStderr);

  return child;
}

function pipeLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
    // Guard against a chatty process with no newlines eating memory.
    if (buffer.length > 1_000_000) buffer = buffer.slice(-100_000);
  });
}

/** True when the binary resolves on PATH. */
export async function which(command: string): Promise<string | undefined> {
  const result = await run("/usr/bin/which", [command], {
    allowFailure: true,
    timeout: 5_000,
  });
  if (result.code !== 0) return undefined;
  const path = result.stdout.trim().split("\n")[0];
  return path && path.length > 0 ? path : undefined;
}

function spawnFailure(command: string, cause: unknown): NatError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (!message.includes("ENOENT")) {
    return new NatError("DRIVER_FAILED", `Failed to run \`${command}\`: ${message}`, { cause });
  }

  // ENOENT covers two very different problems: the binary is absent, or it is
  // present but its interpreter is not — the state a Homebrew Python upgrade
  // leaves behind. Saying "not found on PATH" about a file the user can see is
  // the kind of wrong hint that costs an hour.
  const present = command.includes("/") && existsSync(command);
  return new NatError(
    "MISSING_DEPENDENCY",
    present
      ? `\`${command}\` exists but could not be started — its interpreter or a linked library is missing`
      : `\`${command}\` was not found on PATH`,
    {
      hint: present
        ? `Reinstall it (a language runtime it depends on was probably upgraded or removed), or delete it so it stops shadowing a working one.`
        : "Run `nat doctor` to see what is missing and how to install it.",
      cause,
    },
  );
}

function firstLines(text: string, count: number): string {
  return text
    .trim()
    .split("\n")
    .slice(0, count)
    .join(" | ");
}
