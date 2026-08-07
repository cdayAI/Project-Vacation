import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../kernel/config.js";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { buildPlatform, type Platform } from "../platform.js";
import { createServer } from "../api/server.js";
import type { ActorRef } from "../record/types.js";

/**
 * Pass 6 — does the health check tell the truth?
 *
 * The method's instruction is to force each unhealthy condition and confirm it
 * reports, on the grounds that a health check which cannot go unhealthy is a
 * decoration. `api/server.ts:225` and `cli/main.ts:317` both set
 * `status: "ok"` as a literal. Nothing computes it, so nothing can change it.
 *
 * The payload is rich and honest about *conditions* — it carries the
 * containment switches, the configuration warnings, the sandbox containment
 * flag, and the four external-agent rows. What it will not do is draw a
 * conclusion from any of them. Everything that reads only `status` — a load
 * balancer, an uptime monitor, a status page, an operator glancing at a
 * dashboard — is told "ok" in every state the platform can reach.
 *
 * Two conditions are asserted here, chosen because neither is a matter of
 * taste.
 *
 * *A globally paused platform is not healthy.* The pause is the stop button;
 * while it is engaged every action is refused. Reporting that as "ok" is the
 * single case where the health endpoint and the platform's own behaviour
 * contradict each other outright.
 *
 * *An unreachable operating record is not healthy.* This one currently fails in
 * a second way. The handler reads the audit head before it builds the payload,
 * so when the store is unreachable the read throws a `DeniedError` and the
 * error translator turns the whole response into HTTP 409 with a body saying an
 * action was refused. Confirmed against a live Postgres deployment: with the
 * database unreachable, `GET /health` answers
 * `409 {"denied":true,"reason":"record.unavailable"...}`. A probe expecting
 * 2xx-or-5xx sees a 4xx and a health payload never arrives — during the one
 * outage where an operator most needs the endpoint to say what is wrong.
 */

const START = "2026-08-06T12:00:00.000Z";

const OPERATOR: ActorRef = {
  actorId: "dev:operator",
  kind: "human",
  roles: ["platform_admin", "supervisor"],
};

describe("the health endpoint under conditions that are not healthy", () => {
  let platform: Platform;
  let app: FastifyInstance;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("pass6-health"),
      logger: createNullLogger(),
    });
    app = createServer({ platform, developmentActor: OPERATOR });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await platform.close();
  });

  it("says ok when nothing is wrong", async () => {
    // The control. Whatever the fix, this must keep passing: a healthy
    // deployment that reported anything else would train operators to ignore it.
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
  });

  it("does not report ok while the platform is globally paused", async () => {
    await platform.containment.engage("global", "", "ops:dana", "pass 6 drill");

    const response = await app.inject({ method: "GET", url: "/health" });
    const body = response.json();

    // The condition itself is reported, and that part is right.
    expect(body.containment).toContainEqual(expect.objectContaining({ scope: "global", engaged: true }));

    // But the summary an automated reader acts on still says the platform is
    // fine, while every action it can take is being refused.
    expect(body.status).not.toBe("ok");
  });

  it("reports unhealthy rather than refusing when the operating record cannot be read", async () => {
    // Simulate the store going away underneath a live process, which is what a
    // failover, a restart, or an exhausted pool looks like from up here.
    Object.defineProperty(platform.audit, "head", {
      configurable: true,
      value: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    // A health endpoint has one job during an outage: answer, and say it is
    // unwell. Failing the request instead means the probe learns nothing it
    // could not have learned from the connection error.
    expect(response.statusCode).toBe(200);
    expect(response.json().status).not.toBe("ok");
  });
});
