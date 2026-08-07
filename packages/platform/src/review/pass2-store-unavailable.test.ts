import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../kernel/config.js";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { DeniedError } from "../kernel/errors.js";
import { buildPlatform, type Platform } from "../platform.js";
import { createServer } from "../api/server.js";
import type { ActorRef } from "../record/types.js";

/**
 * Pass 2, group four — a corrupt store, flipped, and watched.
 *
 * The dangerous answer is not an error. It is a two-hundred with an empty list
 * in it. A supervisor who opens the work queue, sees nothing waiting, and goes
 * home has been told something false by a screen whose entire job is to say
 * what is outstanding — and unlike a red banner, an empty queue looks exactly
 * like a quiet afternoon.
 *
 * So each read surface is asked the same question with the operating record
 * refusing underneath it: does it say "I cannot answer", or does it answer?
 */

const START = "2026-08-06T12:00:00.000Z";

const VIEWER: ActorRef = {
  actorId: "usr_dana",
  kind: "human",
  roles: ["supervisor", "platform_admin"],
};

/** What every adapter raises when the database cannot be reached. */
function unavailable(): DeniedError {
  return new DeniedError(
    "record.unavailable",
    "The operating record could not complete this read, so the action was refused.",
    {},
  );
}

/** Replace one method on one port with a store that cannot answer. */
function breaking<T extends object>(port: T, method: keyof T): T {
  return new Proxy(port, {
    get(target, property, receiver) {
      if (property === method) {
        return () => {
          throw unavailable();
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("a read surface whose store cannot answer", () => {
  let platform: Platform;
  let app: FastifyInstance;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("unavailable"),
      logger: createNullLogger(),
    });
  });

  afterEach(async () => {
    if (app) await app.close();
    await platform.close();
  });

  async function serve(overrides: Partial<Platform>): Promise<FastifyInstance> {
    const wrapped = new Proxy(platform, {
      get: (target, property, receiver) =>
        property in overrides
          ? overrides[property as keyof Platform]
          : Reflect.get(target, property, receiver),
    }) as Platform;
    app = createServer({ platform: wrapped, developmentActor: VIEWER });
    await app.ready();
    return app;
  }

  it("refuses the work queue rather than reporting an empty one", async () => {
    const server = await serve({ runs: breaking(platform.runs, "listRuns") });
    const response = await server.inject({ method: "GET", url: "/api/runs" });

    expect(response.statusCode).not.toBe(200);
    // The specific danger: a body a console would render as "nothing waiting".
    expect(response.body).not.toContain('"items":[]');
    expect(response.json()).toMatchObject({ reason: "record.unavailable" });
  });

  it("refuses the queue when only the cost lookup is broken", async () => {
    // Cost is read per row, after the page is chosen. A failure there must not
    // degrade into rows with a zero in the cost column: a zero is a number a
    // supervisor will believe.
    await platform.runs.createRun({
      kind: "rescission.package_check",
      mode: "supervised",
      requestedBy: VIEWER,
      subject: { contractId: "CT-1" },
      correlationId: "corr-1",
    });
    const server = await serve({ runs: breaking(platform.runs, "costForRun") });
    const response = await server.inject({ method: "GET", url: "/api/runs" });

    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toContain('"costUsd":0');
  });

  it("refuses the audit view rather than reporting an empty chain", async () => {
    const server = await serve({ audit: breaking(platform.audit, "list") });
    const response = await server.inject({ method: "GET", url: "/api/audit" });

    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toContain('"entries":[]');
  });

  it("does not report health as ok when it could not read the audit chain", async () => {
    const server = await serve({ audit: breaking(platform.audit, "head") });
    const response = await server.inject({ method: "GET", url: "/health" });

    // Either an explicit unhealthy status or a failure code. What must never
    // happen is a 200 saying "ok" produced by a platform that could not read
    // its own evidence chain.
    const healthy = response.statusCode === 200 && response.body.includes('"status":"ok"');
    expect(healthy).toBe(false);
  });

  it("refuses the approvals queue rather than reporting nothing to approve", async () => {
    const server = await serve({ approvals: breaking(platform.approvals, "list") });
    const response = await server.inject({ method: "GET", url: "/api/approvals" });

    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toContain('"items":[]');
  });

  it("refuses the containment view rather than reporting nothing contained", async () => {
    // The most consequential of the lot. "Nothing is contained" is what an
    // operator reads before deciding the platform is running normally.
    const server = await serve({ containment: breaking(platform.containment, "list") });
    const response = await server.inject({ method: "GET", url: "/api/containment" });

    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toContain('"switches":[]');
  });
});
