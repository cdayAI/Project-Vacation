import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../kernel/config.js";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { digestValue } from "../kernel/hash.js";
import { buildPlatform, type Platform } from "../platform.js";
import { createServer } from "./server.js";
import type { ActorRef } from "../record/types.js";

/**
 * API tests.
 *
 * The point of these is not route coverage; it is that the HTTP layer does not
 * quietly undo a guarantee the platform below it provides. Three properties in
 * particular:
 *
 *   - A refusal reaches the client as a structured denial rather than as a
 *     500, because the console renders denials as outcomes.
 *   - Authorization is re-checked here even when the console would have hidden
 *     the control, since a hidden button is a courtesy and not a control.
 *   - The health endpoint tells the truth about the unsafe settings without
 *     needing a credential, because an operator must be able to see them.
 */

const START = "2026-08-06T12:00:00.000Z";

const AGENT: ActorRef = {
  actorId: "dev:agent",
  kind: "human",
  roles: ["owner_services_agent", "supervisor", "compliance_reviewer", "platform_admin"],
};

describe("api", () => {
  let platform: Platform;
  let app: FastifyInstance;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("api-test"),
      logger: createNullLogger(),
    });
    app = createServer({ platform, developmentActor: AGENT });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await platform.close();
  });

  it("reports health without a credential, and says whether the sandbox contains", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.sandboxIsContained).toBe(true);
    expect(body.discoveryEnabled).toBe(false);
    // The startup warnings must be visible here, not only in the log.
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings.join(" ")).toMatch(/not durable/);
  });

  it("returns the action registry so the capability surface is inspectable", async () => {
    const response = await app.inject({ method: "GET", url: "/api/actions" });
    expect(response.statusCode).toBe(200);
    const names = response.json().items.map((a: { name: string }) => a.name);
    expect(names).toContain("contact.send_owner_message");
    expect(names).toContain("audit.modify_entry");
  });

  it("reports the signed-in actor and their capabilities as a rendering hint", async () => {
    const response = await app.inject({ method: "GET", url: "/api/session" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.actor.actorId).toBe("dev:agent");
    expect(body.capabilities).toContain("record.read_run");
    expect(body.readOnly).toBe(false);
  });

  it("lists runs and their cost", async () => {
    const run = await platform.runs.createRun({
      kind: "rescission.verify",
      mode: "supervised",
      requestedBy: AGENT,
      subject: { contractId: "ctr_fl_0001" },
      correlationId: "corr-1",
    });
    await platform.runs.recordCost({
      runId: run.id,
      category: "model",
      amountUsd: 0.02,
      recordedAt: platform.clock.nowIso(),
    });

    const response = await app.inject({ method: "GET", url: "/api/runs" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toContain("ctr_fl_0001");
    expect(body.items[0].costUsd).toBeCloseTo(0.02, 6);
  });

  it("returns a run's full step trail", async () => {
    const run = await platform.runs.createRun({
      kind: "rescission.verify",
      mode: "supervised",
      requestedBy: AGENT,
      subject: { contractId: "ctr_fl_0001" },
      correlationId: "corr-1",
    });
    await platform.runs.appendStep({
      runId: run.id,
      kind: "retrieval",
      name: "find_rule",
      idempotencyKey: `${run.id}:find_rule`,
      detail: { state: "FL" },
    });

    const response = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].name).toBe("find_rule");
  });

  it("returns 404 for a run that does not exist rather than an empty run", async () => {
    const response = await app.inject({ method: "GET", url: "/api/runs/run_missing" });
    expect(response.statusCode).toBe(404);
  });

  it("renders a refusal as a structured denial, not a server error", async () => {
    // A reason is mandatory on containment. Omitting it is invalid input.
    const invalid = await app.inject({
      method: "POST",
      url: "/api/containment",
      payload: { scope: "global" },
    });
    expect(invalid.statusCode).toBe(400);

    // Engage globally, then attempt an action that containment refuses.
    await app.inject({
      method: "POST",
      url: "/api/containment",
      payload: { scope: "global", reason: "incident drill" },
    });

    const denied = await app.inject({ method: "GET", url: "/api/runs" });
    // 409, not 500: the request was understood and declined on policy grounds.
    expect(denied.statusCode).toBe(409);
    const body = denied.json();
    expect(body.denied).toBe(true);
    expect(body.reason).toBe("containment.global_pause");
    expect(body.message).toMatch(/globally paused/);
  });

  it("records containment changes in the audit chain with their reason", async () => {
    await app.inject({
      method: "POST",
      url: "/api/containment",
      payload: { scope: "workflow", target: "rescission.verify", reason: "bad output observed" },
    });

    const entries = await platform.audit.list({ eventType: ["containment.engaged"] });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.decision.reason).toBe("bad output observed");
  });

  it("reports audit chain verification", async () => {
    await platform.audit.record({
      eventType: "run.started",
      actor: AGENT,
      subject: { contractId: "ctr_fl_0001" },
      inputDigests: { input: digestValue({ a: 1 }) },
      decision: { mode: "supervised" },
    });

    const response = await app.inject({ method: "GET", url: "/api/audit/verification" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intact).toBe(true);
    // More than the one entry written above: authorising the read is itself a
    // decision, so it is recorded too. That is deliberate — "who read this" is
    // a compliance question — and it means the chain grows with read traffic.
    // The volume consequence is noted in docs/ops/observability-and-cost.md.
    expect(body.entriesChecked).toBeGreaterThanOrEqual(1);
  });

  it("records the authorization of a read, so access itself is auditable", async () => {
    await app.inject({ method: "GET", url: "/api/runs" });
    const grants = await platform.audit.list({ eventType: ["authorization.granted"] });
    expect(grants.some((entry) => entry.subject.action === "record.read_run")).toBe(true);
  });

  it("does not leak raw payloads through the audit endpoint", async () => {
    await platform.audit.record({
      eventType: "model.invoked",
      actor: AGENT,
      subject: { contractId: "ctr_fl_0001" },
      inputDigests: { prompt: digestValue({ text: "the owner's full message" }) },
      decision: { task: "rescission.extract" },
    });

    const response = await app.inject({ method: "GET", url: "/api/audit" });
    const serialised = JSON.stringify(response.json());
    expect(serialised).not.toContain("the owner's full message");
    expect(serialised).toContain("sha256:");
  });

  it("shows an approver exactly what they are authorising, and refuses self-approval", async () => {
    const requester: ActorRef = {
      actorId: "dev:agent",
      kind: "human",
      roles: ["owner_services_agent"],
    };
    const approval = await platform.approvals.request({
      action: "contact.send_owner_message",
      proposalDigest: digestValue({ letter: "Your cancellation window closes on 8 August." }),
      summary: "Send a rescission-deadline notice",
      requestedBy: requester,
      approvalsRequired: 1,
      eligibleRoles: ["supervisor"],
      subject: { contractId: "ctr_fl_0001", channel: "letter" },
    });

    const response = await app.inject({ method: "GET", url: `/api/approvals/${approval.id}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.proposalDigest).toBe(approval.proposalDigest);
    expect(body.reversible).toBe(false);
    expect(body.risk).toBe("high_consequence");
    expect(body.proposal).toEqual(
      expect.arrayContaining([{ label: "contractId", value: "ctr_fl_0001" }]),
    );

    // The development actor is also the requester, so the console must disable
    // the decide control and say why rather than letting them click and fail.
    expect(body.viewerMayDecide).toBe(false);
    expect(body.viewerMayNotDecideReason).toMatch(/cannot approve/i);
  });

  it("refuses a self-approval decision at the API, not just in the UI", async () => {
    const approval = await platform.approvals.request({
      action: "contact.send_owner_message",
      proposalDigest: digestValue({ letter: "x" }),
      summary: "Send",
      requestedBy: AGENT,
      approvalsRequired: 1,
      eligibleRoles: ["supervisor"],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decisions`,
      payload: { decision: "granted" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().reason).toBe("approval.self_approval");
  });

  it("rejects a malformed decision", async () => {
    const approval = await platform.approvals.request({
      action: "contact.send_owner_message",
      proposalDigest: digestValue({ letter: "x" }),
      summary: "Send",
      requestedBy: AGENT,
      approvalsRequired: 1,
      eligibleRoles: ["supervisor"],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decisions`,
      payload: { decision: "maybe" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("api identity", () => {
  it("refuses to attribute requests to a development identity outside development", async () => {
    // loadConfig already refuses this combination at startup; the API repeats
    // the check because a control that depends on startup validation having run
    // is one refactor away from not existing.
    const platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("api-identity"),
      logger: createNullLogger(),
    });
    const mutated = {
      ...platform,
      config: { ...platform.config, environment: "production" as const },
    };
    const app = createServer({ platform: mutated });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/session" });
    expect(response.statusCode).toBe(409);
    expect(response.json().reason).toBe("config.missing");

    await app.close();
    await platform.close();
  });
});
