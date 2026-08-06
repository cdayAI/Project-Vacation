import { spawn } from "node:child_process";
import { DeniedError } from "../kernel/errors.js";
import type { SandboxMode } from "../kernel/config.js";

/**
 * Execution containment.
 *
 * Any code or command the platform runs on behalf of a workflow goes through a
 * `Sandbox`. The containment boundary is configurable, and — as the brief
 * requires — the unsafe setting is flagged loudly at startup and in the health
 * check rather than being a quiet default.
 *
 * The three modes and what each is honestly worth:
 *
 *   disabled    Nothing executes. Every request is refused. This is the
 *               default and the only mode that needs no external help to be
 *               safe. Most deployments should stay here: the first workflows
 *               do not execute code.
 *
 *   subprocess  A child process with a wall-clock timeout, a scrubbed
 *               environment, and no shell. This contains *accidents* — a
 *               runaway loop, a script that reads an env var it should not.
 *               It does not contain an adversary: a child process shares the
 *               kernel, the filesystem, and the network namespace. It is
 *               marked unsafe everywhere it appears and must never be used for
 *               untrusted code.
 *
 *   external    Execution is delegated to an isolation service the deployment
 *               provides — gVisor, Firecracker, a container sandbox with
 *               seccomp and no network. This is the only mode appropriate for
 *               untrusted input, and the platform refuses to pretend it can
 *               provide the boundary itself: if no endpoint is configured, it
 *               fails closed rather than falling back to `subprocess`.
 */

export interface SandboxRequest {
  /** Executable to run. Never passed through a shell. */
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  /** Bytes of combined stdout/stderr to keep. Output beyond this is dropped. */
  readonly maxOutputBytes?: number;
  /** Working directory. Must be provided explicitly; there is no default. */
  readonly cwd: string;
  /** Environment. Only these variables are visible to the child. */
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export interface SandboxResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly mode: SandboxMode;
}

export interface Sandbox {
  readonly mode: SandboxMode;
  /** True when this mode provides a real isolation boundary. */
  readonly isContained: boolean;
  /** One line for the startup banner and the health check. */
  describe(): string;
  execute(request: SandboxRequest): Promise<SandboxResult>;
}

/** The default. Refuses everything. */
export class DisabledSandbox implements Sandbox {
  readonly mode: SandboxMode = "disabled";
  readonly isContained = true;

  describe(): string {
    return "sandbox=disabled — code and command execution is refused. This is the safe default.";
  }

  execute(request: SandboxRequest): Promise<SandboxResult> {
    return Promise.reject(
      new DeniedError(
        "sandbox.execution_disabled",
        `Execution is disabled (PV_SANDBOX_MODE=disabled). The request to run "${request.command}" was refused.`,
        { command: request.command },
      ),
    );
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Child-process execution with a timeout and a scrubbed environment.
 *
 * NOT a security boundary. See the module comment.
 */
export class SubprocessSandbox implements Sandbox {
  readonly mode: SandboxMode = "subprocess";
  readonly isContained = false;

  constructor(private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS) {}

  describe(): string {
    return "sandbox=subprocess — UNSAFE: constrains accidents, not adversaries. Shares the host kernel, filesystem, and network. Do not execute untrusted code in this mode.";
  }

  async execute(request: SandboxRequest): Promise<SandboxResult> {
    if (typeof request.command !== "string" || request.command.length === 0) {
      throw new DeniedError("sandbox.policy_violation", "No command was supplied.", {});
    }
    // Refuse anything that looks like it expects shell interpretation. We never
    // spawn a shell, so a caller passing shell syntax has a mistaken model of
    // what this does, and silently running it literally would be worse.
    if (/[;&|`$<>(){}\n]/.test(request.command)) {
      throw new DeniedError(
        "sandbox.policy_violation",
        `Command "${request.command}" contains shell metacharacters. Commands are executed directly, never through a shell.`,
        { command: request.command },
      );
    }

    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const startedAt = Date.now();

    return await new Promise<SandboxResult>((resolve, reject) => {
      let child;
      try {
        child = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          // Only what the caller named. No inherited PATH, no inherited
          // credentials, no proxy variables.
          env: { ...(request.env ?? {}) },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(
          new DeniedError(
            "sandbox.policy_violation",
            `Could not start "${request.command}": ${error instanceof Error ? error.message : String(error)}`,
            { command: request.command },
          ),
        );
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - startedAt,
          mode: this.mode,
        });
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < maxOutputBytes) stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < maxOutputBytes) stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new DeniedError(
            "sandbox.policy_violation",
            `Execution of "${request.command}" failed: ${error.message}`,
            { command: request.command },
          ),
        );
      });

      child.on("close", (code) => finish(code));

      if (request.stdin !== undefined) child.stdin?.write(request.stdin);
      child.stdin?.end();
    });
  }
}

/**
 * Delegation to a deployment-provided isolation service.
 *
 * The platform does not ship an isolation implementation. This adapter exists
 * so that a deployment that has one can wire it in without the rest of the
 * platform changing, and so that "external" is a real, refusing mode rather
 * than a promise.
 */
export class ExternalSandbox implements Sandbox {
  readonly mode: SandboxMode = "external";
  readonly isContained = true;

  constructor(
    private readonly runner?: (request: SandboxRequest) => Promise<SandboxResult>,
  ) {}

  describe(): string {
    return this.runner
      ? "sandbox=external — execution is delegated to the deployment's isolation service."
      : "sandbox=external — MISCONFIGURED: no isolation runner is wired in, so all execution is refused.";
  }

  async execute(request: SandboxRequest): Promise<SandboxResult> {
    if (!this.runner) {
      // Fail closed. Falling back to a subprocess here would silently
      // downgrade the containment the operator asked for.
      throw new DeniedError(
        "sandbox.execution_disabled",
        "PV_SANDBOX_MODE=external but no isolation runner is configured. Execution is refused rather than falling back to an uncontained mode.",
        { command: request.command },
      );
    }
    return this.runner(request);
  }
}

export function createSandbox(
  mode: SandboxMode,
  options: {
    readonly timeoutMs?: number;
    readonly externalRunner?: (request: SandboxRequest) => Promise<SandboxResult>;
  } = {},
): Sandbox {
  switch (mode) {
    case "disabled":
      return new DisabledSandbox();
    case "subprocess":
      return new SubprocessSandbox(options.timeoutMs);
    case "external":
      return new ExternalSandbox(options.externalRunner);
    default: {
      // An unrecognised mode is a configuration error, and the safe reading of
      // an unrecognised containment setting is "contain everything".
      const exhaustive: never = mode;
      void exhaustive;
      return new DisabledSandbox();
    }
  }
}
