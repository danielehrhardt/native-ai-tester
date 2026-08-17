/**
 * Error taxonomy.
 *
 * Every failure an agent can plausibly recover from gets its own code plus a
 * `hint` describing the next concrete action. Agents read the hint; humans read
 * the message. Unknown internal failures stay as plain `Error`s so they surface
 * with a stack trace instead of being dressed up as user error.
 */

export type ErrorCode =
  | "NO_DEVICE"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_NOT_READY"
  | "NOT_CONNECTED"
  | "DRIVER_FAILED"
  | "AGENT_UNAVAILABLE"
  | "MISSING_DEPENDENCY"
  | "ELEMENT_NOT_FOUND"
  | "AMBIGUOUS_TARGET"
  | "GROUNDING_UNAVAILABLE"
  | "APP_NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "TIMEOUT"
  | "UNSUPPORTED";

export class NatError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "NatError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isNatError(value: unknown): value is NatError {
  return value instanceof NatError;
}

/** Exit codes are part of the CLI contract — scripts and agents branch on them. */
export const EXIT_CODES: Record<ErrorCode | "OK" | "INTERNAL", number> = {
  OK: 0,
  INTERNAL: 1,
  INVALID_ARGUMENT: 2,
  NO_DEVICE: 3,
  DEVICE_NOT_FOUND: 3,
  NOT_CONNECTED: 3,
  DEVICE_NOT_READY: 4,
  MISSING_DEPENDENCY: 4,
  AGENT_UNAVAILABLE: 4,
  DRIVER_FAILED: 5,
  ELEMENT_NOT_FOUND: 6,
  AMBIGUOUS_TARGET: 6,
  GROUNDING_UNAVAILABLE: 7,
  APP_NOT_FOUND: 8,
  TIMEOUT: 9,
  UNSUPPORTED: 10,
};

export function exitCodeFor(error: unknown): number {
  if (isNatError(error)) return EXIT_CODES[error.code] ?? EXIT_CODES.INTERNAL;
  return EXIT_CODES.INTERNAL;
}
