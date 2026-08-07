import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../kernel/config.js";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import type { LogContext, Logger } from "../kernel/logger.js";
import { buildPlatform, type Platform } from "../platform.js";
import { createServer } from "../api/server.js";
import type { ActorRef } from "../record/types.js";

/**
 * Pass 6 — following one case across components, and stopping work already
 * under way.
 *
 * **Correlation.** A correlation id is minted or accepted per request
 * (`api/server.ts:125`) and threaded into the authorization chokepoint, which
 * stamps it onto the audit entry. Tracing a case through the *record* therefore
 * works, and the first test proves it: one header value, and both the audit
 * chain and the run row can be filtered by it.
 *
 * Tracing a case through the *logs* does not work, and the second test is the
 * reproduction. The HTTP layer writes no request log at all — Fastify's logger
 * is switched off at `api/server.ts:101` on the stated grounds that "the
 * platform's own logger already writes structured, redacted lines", and the
 * platform's logger writes two lines for the entire lifetime of a server:
 * `platform starting` and `api listening`. The only per-request line anywhere
 * is `unhandled request failure` (`api/server.ts:147`), and its context is
 * `{ path, method, error }` — no correlation id, no actor, no run.
 *
 * So during the one event where logs are what an operator has, the failure line
 * cannot be joined to the audit entries for the same request, to the run it
 * belonged to, or to the other component that handled the same case. Confirmed
 * against a running server: requests carrying `x-correlation-id` produced no
 * log output whatsoever.
 *
 * **Containment reaching in-flight work.** The claim is that engaging a switch
 * stops work already under way rather than only preventing new work. The third
 * test checks it at the chokepoint every action passes through, with a run
 * already open and a step already recorded against it.
 */

const START = "2026-08-06T12:00:00.000Z";

const OPERATOR: ActorRef = {
  actorId: "dev:operator",
  kind: "human",
  roles: ["platform_admin", "supervisor", "owner_services_agent"],
};

interface CapturedLine {
  readonly level: string;
  readonly message: string;
  readonly context: LogContext | undefined;
}

function capturingLogger(lines: CapturedLine[]): Logger {
  const write =
    (level: string) =>
    (message: string, context?: LogContext): void => {
      lines.push({ level, message, context });
    };
  const logger: Logger = {
    trace: write("trace"),
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    fatal: write("fatal"),
    child: () => logger,
  };
  return logger;
}

describe("following one case across components", () => {
  let platform: Platform;
  let app: FastifyInstance;
  let lines: CapturedLine[];

  beforeEach(async () => {
    lines = [];
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("pass6-correlation"),
      logger: capturingLogger(lines),
    });
    app = createServer({ platform, developmentActor: OPERATOR });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await platform.close();
  });

  it("carries a caller's correlation id into the audit chain", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/runs",
      headers: { "x-correlation-id": "TRACE-ME-0001" },
    });
    expect(response.statusCode).toBe(200);

    const entries = await platform.audit.list({ limit: 50 });
    const traced = entries.filter((entry) => entry.correlationId === "TRACE-ME-0001");

    // This half works, and is the reason a case *can* be followed at all.
    expect(traced.length).toBeGreaterThan(0);
  });

  it("puts the correlation id on the line it writes when a request fails", async () => {
    // Break something below the route so the error handler runs. This is the
    // only per-request line the platform emits.
    Object.defineProperty(platform.runs, "listRuns", {
      configurable: true,
      value: async () => {
        throw new Error("the operating record fell over");
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/runs",
      headers: { "x-correlation-id": "TRACE-ME-0002" },
    });
    expect(response.statusCode).toBe(500);

    const failure = lines.find((line) => line.message === "unhandled request failure");
    expect(failure).toBeDefined();

    // Without this, the log stream and the audit chain describe the same
    // incident in two vocabularies with no key joining them, and "follow this
    // case across components" becomes a manual reconciliation by timestamp.
    expect(JSON.stringify(failure?.context ?? {})).toContain("TRACE-ME-0002");
  });
});

describe("containment reaching work already under way", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("pass6-containment"),
      logger: capturingLogger([]),
    });
  });

  afterEach(async () => {
    await platform.close();
  });

  it("refuses the next action of a run that is already open", async () => {
    const run = await platform.runs.createRun({
      kind: "workflow",
      mode: "supervised",
      requestedBy: OPERATOR,
      subject: { contractId: "ctr_0001" },
      correlationId: "corr-inflight",
    });
    await platform.runs.appendStep({
      runId: run.id,
      kind: "model_call",
      name: "first",
      idempotencyKey: "inflight-1",
      status: "succeeded",
    });

    // The first action of the open run is permitted.
    await platform.authorizer.authorize({
      action: "record.read_run",
      actor: OPERATOR,
      mode: "supervised",
      runId: run.id,
      correlationId: "corr-inflight",
    });

    // An operator presses stop while the run is still open.
    await platform.containment.engage("global", "", "ops:dana", "pass 6 in-flight drill");

    // The next action of that same run must refuse. A switch that only gated
    // new runs would let a long-running instance outrun the stop button.
    await expect(
      platform.authorizer.authorize({
        action: "record.read_run",
        actor: OPERATOR,
        mode: "supervised",
        runId: run.id,
        correlationId: "corr-inflight",
      }),
    ).rejects.toMatchObject({ reason: "containment.global_pause" });
  });
});
