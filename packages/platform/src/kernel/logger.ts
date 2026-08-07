import { pino, destination as pinoDestination, type Logger as PinoLogger } from "pino";
import { redactValue } from "./redact.js";

/**
 * Structured logging with correlation.
 *
 * Every payload passes through `redactValue` before it reaches a sink, because
 * "no secrets in source or logs" has to be enforced somewhere other than in
 * each author's memory. That one *is* unconditional: it happens in `write`, so
 * no call site can skip it.
 *
 * A line carries a correlation id **when its caller supplies one**. This
 * comment used to say every line does, which is a promise this type cannot
 * keep: `correlationId` is optional on `LogContext` and a caller passing no
 * context at all is legal — the platform's own startup lines are exactly that.
 * `child()` is how a caller makes correlation automatic for everything below
 * it, and it is the right habit; it is not enforced.
 *
 * Worth knowing before relying on the log stream to reconstruct a case: there
 * is no HTTP request log. Fastify's own logger is switched off deliberately —
 * two loggers with different redaction rules is how a secret reaches a log —
 * and nothing replaced it, so a successful request writes nothing here. The
 * audit chain and the operating record both carry the caller's correlation id
 * and are where a case is actually followed today.
 */

export interface LogContext {
  /** Ties log lines to one unit of work end to end. */
  readonly correlationId?: string;
  /** The operating-record run this line belongs to, when there is one. */
  readonly runId?: string;
  /** The authenticated subject, when there is one. Never an email or a name. */
  readonly actorId?: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  /** Derive a logger that stamps `context` onto every line it writes. */
  child(context: LogContext): Logger;
}

class PinoAdapter implements Logger {
  constructor(private readonly inner: PinoLogger) {}

  private write(
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal",
    message: string,
    context?: LogContext,
  ): void {
    const payload = context ? (redactValue(context) as Record<string, unknown>) : {};
    this.inner[level](payload, message);
  }

  trace(message: string, context?: LogContext): void {
    this.write("trace", message, context);
  }
  debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }
  info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }
  error(message: string, context?: LogContext): void {
    this.write("error", message, context);
  }
  fatal(message: string, context?: LogContext): void {
    this.write("fatal", message, context);
  }

  child(context: LogContext): Logger {
    return new PinoAdapter(this.inner.child(redactValue(context) as Record<string, unknown>));
  }
}

export interface LoggerOptions {
  readonly level?: string;
  readonly serviceName?: string;
  readonly environment?: string;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new PinoAdapter(
    pino(
      {
        level: options.level ?? "info",
        base: {
          service: options.serviceName ?? "project-vacation",
          environment: options.environment ?? "development",
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        // Belt and braces: redactValue already handles these, but pino's own
        // redaction runs even on paths that bypass the adapter.
        redact: {
          paths: [
            "password",
            "*.password",
            "token",
            "*.token",
            "authorization",
            "*.authorization",
            "apiKey",
            "*.apiKey",
            "secret",
            "*.secret",
          ],
          censor: "[redacted]",
        },
      },
      // Diagnostics go to stderr; stdout carries the answer.
      //
      // This matters more than it looks. `pv audit verify > evidence.txt` has
      // to produce a file an auditor can read, and `pnpm demo` has to produce
      // output that is byte-identical across runs so CI can diff it. A log line
      // with a timestamp in it, interleaved on stdout, would break both.
      pinoDestination(2),
    ),
  );
}

/** A logger that discards everything. Used in tests to keep output readable. */
export function createNullLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

/** A logger that keeps lines in memory so tests can assert on them. */
export class RecordingLogger implements Logger {
  readonly lines: { level: string; message: string; context: Record<string, unknown> }[] = [];

  constructor(private readonly base: LogContext = {}) {}

  private write(level: string, message: string, context?: LogContext): void {
    this.lines.push({
      level,
      message,
      context: redactValue({ ...this.base, ...context }) as Record<string, unknown>,
    });
  }

  trace(message: string, context?: LogContext): void {
    this.write("trace", message, context);
  }
  debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }
  info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }
  error(message: string, context?: LogContext): void {
    this.write("error", message, context);
  }
  fatal(message: string, context?: LogContext): void {
    this.write("fatal", message, context);
  }

  child(context: LogContext): Logger {
    const child = new RecordingLogger({ ...this.base, ...context });
    // Share the buffer so assertions can read every line from the root.
    Object.defineProperty(child, "lines", { value: this.lines });
    return child;
  }
}
