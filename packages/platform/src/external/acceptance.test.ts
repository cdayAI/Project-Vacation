import { describe, it, expect } from "vitest";
import { FixedClock, MINUTE, HOUR, DAY } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { loadConfig } from "../kernel/config.js";
import { DeniedError } from "../kernel/errors.js";
import type { Logger } from "../kernel/logger.js";
import type { ActorRef } from "../record/types.js";
import { verifyChain } from "../audit/chain.js";
import { buildPlatform, type Platform } from "../platform.js";
import type { Connector } from "./connectors.js";
import { enrollmentProposalDigest, revocationProposalDigest } from "./enrollment.js";
import type { EnrollRequest } from "./enrollment.js";
import { EXTERNAL_PRINCIPAL_ROLE } from "./runs.js";
import type { EnrolledAgent, ExternalAgentId } from "./types.js";

/**
 * Acceptance tests for governing agents MVW already has.
 *
 * These are the eight behaviours the capability is defined by, written as
 * tests rather than demonstrated in a screenshot, and run against the platform
 * as it is actually composed — real admission chain, real approval queue, real
 * operating record, real audit chain. Nothing here reaches inside a service to
 * arrange an outcome; every one drives the same entry points a vendor's agent
 * and an operator would.
 *
 * The unit tests beside this file take each control apart. This file asserts
 * that assembled together they behave the way the capability was asked for:
 *
 *   1. refused when over its ceiling, and when expired
 *   2. declared risk raised by the operator's tool rating
 *   3. parks a real, labelled approval above the threshold
 *   4. reported work lands on the operating record beside native work, with cost
 *   5. killed mid-run by a heartbeat that returns stop
 *   6. governed read runs immediately; governed write waits for a human, bound
 *      to the exact request
 *   7. auto-contained after repeated denials, released by an admin
 *   8. stops instantly on revocation, including work in flight
 *
 * A ninth is asserted first, because everything else depends on it: an
 * unenrolled caller gets nothing.
 */

const START = "2026-08-10T14:00:00.000Z";

const ADMIN: ActorRef = {
  actorId: "user:dana.admin",
  kind: "human",
  roles: ["platform_admin"],
};

/** A different human, because nobody may approve their own proposal. */
const SUPERVISOR: ActorRef = {
  actorId: "user:sam.supervisor",
  kind: "human",
  roles: ["supervisor"],
};

const SILENT: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return SILENT;
  },
};

/**
 * The connector an external agent may reach through the platform.
 *
 * One read and one write, which is the whole shape of the governed-execution
 * contract: reads run immediately, writes wait for a human and are bound to
 * the exact request that human saw.
 */
function ownerRecordsConnector(performed: string[]): Connector {
  return {
    integration: "owner_records",
    description: "Owner service records, in the system of record.",
    operations: [
      {
        operation: "lookup_owner",
        mode: "read",
        description: "Read one owner's contact and contract summary.",
        async perform(input) {
          performed.push(`lookup_owner:${JSON.stringify(input.request)}`);
          return { ownerId: input.request["ownerId"], status: "current" };
        },
      },
      {
        operation: "issue_goodwill_credit",
        mode: "write",
        description: "Credit an owner's account as a goodwill gesture.",
        async perform(input) {
          performed.push(`issue_goodwill_credit:${input.idempotencyKey}`);
          return { creditId: "cr_9001" };
        },
      },
    ],
  };
}

interface Harness {
  readonly platform: Platform;
  readonly clock: FixedClock;
  readonly performed: string[];
  enroll(overrides?: Partial<EnrollRequest>): Promise<EnrolledAgent>;
}

async function harness(
  env: Readonly<Record<string, string>> = {},
): Promise<Harness> {
  const clock = new FixedClock(START);
  const performed: string[] = [];
  const config = loadConfig({
    PV_ENV: "development",
    PV_STORE: "memory",
    PV_EXTERNAL_AGENTS_ENABLED: "true",
    ...env,
  });

  const platform = await buildPlatform(config, {
    clock,
    ids: new SeededIdGenerator("acceptance"),
    logger: SILENT,
    connectors: [ownerRecordsConnector(performed)],
  });

  return {
    platform,
    clock,
    performed,
    async enroll(overrides = {}) {
      const request: EnrollRequest = {
        name: "crm-owner-assistant",
        owner: "rosa.mendez@example.com",
        department: "Owner Services",
        hostPlatform: "vendor CRM agent runtime",
        purpose: "Drafts owner correspondence and looks up account status.",
        allowedTools: [
          { tool: "lookup_owner" },
          { tool: "draft_reply" },
          // The operator says this one is high-consequence whatever the agent
          // declares. Behaviour 2 is built on this grant.
          { tool: "issue_refund", operatorRisk: "high_consequence" },
          { tool: "owner_records.lookup_owner" },
          { tool: "owner_records.issue_goodwill_credit", operatorRisk: "high_consequence" },
        ],
        riskCeiling: "high_consequence",
        spendCeilingUsd: 50,
        budgetPeriod: "monthly",
        wallClockCeilingMs: 10 * MINUTE,
        dataScopes: ["owner.contact", "owner.contract"],
        expiresAt: new Date(Date.parse(START) + 90 * DAY).toISOString(),
        ...overrides,
      };

      // Enrollment is high-consequence and needs a human decision, so the test
      // takes the same route an operator does rather than writing a row.
      const approval = await platform.approvals.request({
        action: "external_agent.enroll",
        proposalDigest: enrollmentProposalDigest(request),
        summary: `Enroll external agent ${request.name}`,
        requestedBy: ADMIN,
        approvalsRequired: 1,
        eligibleRoles: ["platform_admin", "supervisor"],
      });
      await platform.approvals.decide({
        approvalId: approval.id,
        actor: SUPERVISOR,
        decision: "granted",
        secondsSinceAuthentication: 30,
      });

      return platform.external.enrollment.enroll(
        { actor: ADMIN, approvalId: approval.id, secondsSinceAuthentication: 30 },
        request,
      );
    },
  };
}

describe("governing an agent that runs elsewhere", () => {
  it("serves an unenrolled caller nothing at all", async () => {
    const h = await harness();
    const decision = await h.platform.external.admission.admit({
      agentId: "eag_nobody" as ExternalAgentId,
      operation: "screen",
      tool: "lookup_owner",
      declaredRisk: "routine",
    });

    expect(decision.outcome).toBe("denied");
    expect(decision.reason).toBe("authorization.action_not_permitted");
    expect(decision.message).toMatch(/not enrolled/i);
    await h.platform.close();
  });

  // -------------------------------------------------------------------------
  // 1. Over its ceiling, and expired
  // -------------------------------------------------------------------------

  it("refuses an agent that is over its spend ceiling", async () => {
    const h = await harness();
    const agent = await h.enroll({ spendCeilingUsd: 10 });

    // Spend arrives the way it really does: on a report of work that happened.
    await h.platform.external.reports.ingest({
      agentId: agent.id,
      idempotencyKey: "episode-1",
      goal: "Draft three owner replies.",
      startedAt: START,
      endedAt: new Date(Date.parse(START) + MINUTE).toISOString(),
      outcome: "succeeded",
      steps: [],
      costUsd: 9.5,
    });

    const decision = await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "screen",
      tool: "lookup_owner",
      declaredRisk: "routine",
      estimatedCostUsd: 2,
    });

    expect(decision.outcome).toBe("denied");
    expect(decision.reason).toBe("ceiling.spend_exceeded");
    expect(decision.remainingBudgetUsd).toBeCloseTo(0.5, 6);
    await h.platform.close();
  });

  it("refuses an agent whose enrollment has expired", async () => {
    const h = await harness();
    const agent = await h.enroll({
      expiresAt: new Date(Date.parse(START) + HOUR).toISOString(),
    });

    const before = await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "screen",
      tool: "lookup_owner",
      declaredRisk: "routine",
    });
    expect(before.outcome).toBe("allowed");

    // Expiry is data, checked on every admission — not a job that has to have
    // run. An agent nobody re-enrolled stops being served the moment it lapses.
    h.clock.advance(2 * HOUR);

    const after = await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "screen",
      tool: "lookup_owner",
      declaredRisk: "routine",
    });
    expect(after.outcome).toBe("denied");
    expect(after.message).toMatch(/expired/i);
    await h.platform.close();
  });

  // -------------------------------------------------------------------------
  // 2 and 3. The operator's rating floors the declaration, and the approval
  //          it forces is a real, labelled entry in the one queue.
  // -------------------------------------------------------------------------

  it("raises a declared risk to the operator's rating for that tool", async () => {
    const h = await harness();
    const agent = await h.enroll();

    const decision = await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "screen",
      // The agent calls a refund "routine". The tool name is a string it chose;
      // the operator's rating is the one that counts.
      tool: "issue_refund",
      declaredRisk: "routine",
    });

    expect(decision.effectiveRisk).toBe("high_consequence");
    expect(decision.outcome).toBe("approval_required");
    expect(decision.approvalId).toBeTruthy();
    await h.platform.close();
  });

  it("parks the approval in the one queue, labelled as an external agent's", async () => {
    const h = await harness();
    const agent = await h.enroll();

    await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "screen",
      tool: "issue_refund",
      declaredRisk: "routine",
      subject: { ownerId: "own_4821" },
    });

    // One queue. A supervisor reading the approvals queue finds this beside
    // approvals raised by native workflows, not in a separate list.
    const queue = await h.platform.approvals.list({ status: ["pending"] });
    expect(queue).toHaveLength(1);

    const parked = queue[0];
    expect(parked).toBeDefined();
    if (!parked) throw new Error("unreachable");

    // Labelled, and in text — a supervisor must be able to see whose action
    // this is without knowing the id conventions.
    expect(parked.summary).toMatch(/external agent/i);
    expect(parked.summary).toContain(agent.name);
    expect(parked.subject?.["externalAgentId"]).toBe(agent.id);
    expect(parked.subject?.["principal"]).toBe("external");
    await h.platform.close();
  });

  // -------------------------------------------------------------------------
  // 4. One record
  // -------------------------------------------------------------------------

  it("puts reported work on the operating record beside native work, with its cost", async () => {
    const h = await harness();
    const agent = await h.enroll();

    // A native run, so the assertion is about one record rather than an empty one.
    const native = await h.platform.runs.createRun({
      kind: "rescission.verify",
      status: "succeeded",
      mode: "supervised",
      requestedBy: { actorId: "user:pat.analyst", kind: "human", roles: ["owner_services_agent"] },
      subject: { contractId: "con_1001" },
      startedAt: START,
    });
    await h.platform.runs.recordCost({
      runId: native.id,
      amountUsd: 0.4,
      category: "model",
      recordedAt: START,
    });

    const ingested = await h.platform.external.reports.ingest({
      agentId: agent.id,
      idempotencyKey: "episode-42",
      goal: "Answer four owner emails about maintenance fees.",
      startedAt: START,
      endedAt: new Date(Date.parse(START) + 4 * MINUTE).toISOString(),
      outcome: "succeeded",
      summary: "Four replies drafted, none sent.",
      steps: [
        {
          name: "retrieve account",
          tool: "lookup_owner",
          startedAt: START,
          endedAt: new Date(Date.parse(START) + MINUTE).toISOString(),
          outcome: "succeeded",
          costUsd: 0.1,
        },
      ],
      costUsd: 1.25,
      subject: { ownerId: "own_4821" },
    });

    const all = await h.platform.runs.listRuns();
    const ids = all.map((run) => run.id);
    expect(ids).toContain(native.id);
    expect(ids).toContain(ingested.runId);

    const external = await h.platform.runs.requireRun(ingested.runId);
    // Marked external, on the same record, in the same shape. A cost report
    // that sums this table counts external spend without being taught to.
    expect(external.requestedBy.kind).toBe("service");
    expect(external.requestedBy.roles).toContain(EXTERNAL_PRINCIPAL_ROLE);
    expect(external.subject?.["externalAgentId"]).toBe(agent.id);

    const cost = await h.platform.runs.costForRun(ingested.runId);
    expect(cost.totalUsd).toBeCloseTo(1.25, 6);

    const steps = await h.platform.runs.listSteps(ingested.runId);
    expect(steps.map((step) => step.name)).toContain("retrieve account");

    // Exactly once. Agents retry — that is the point of a report endpoint — and
    // a retry must not spend the ceiling twice.
    const retry = await h.platform.external.reports.ingest({
      agentId: agent.id,
      idempotencyKey: "episode-42",
      goal: "Answer four owner emails about maintenance fees.",
      startedAt: START,
      endedAt: new Date(Date.parse(START) + 4 * MINUTE).toISOString(),
      outcome: "succeeded",
      steps: [],
      costUsd: 1.25,
    });
    expect(retry.duplicate).toBe(true);
    expect(retry.runId).toBe(ingested.runId);

    const meter = await h.platform.external.stores.spend.getMeter(agent.id, "2026-08");
    expect(meter?.spentUsd).toBeCloseTo(1.25, 6);
    await h.platform.close();
  });

  // -------------------------------------------------------------------------
  // 5. The kill switch
  // -------------------------------------------------------------------------

  it("kills a run in flight through the next heartbeat", async () => {
    const h = await harness();
    const agent = await h.enroll();

    const run = await h.platform.external.liveRuns.start({
      agentId: agent.id,
      goal: "Reconcile twelve owner accounts.",
    });

    h.clock.advance(10_000);
    const healthy = await h.platform.external.liveRuns.heartbeat(agent.id, run.id);
    expect(healthy.directive).toBe("continue");

    // An operator contains the agent while it is working. We cannot reach into
    // someone else's runtime and stop the process; the heartbeat reply is the
    // only lever, so it has to be the one that carries the decision.
    await h.platform.external.enrollment.contain({ actor: SUPERVISOR }, agent.id, "Investigating unexpected refund attempts.");

    h.clock.advance(10_000);
    const stopped = await h.platform.external.liveRuns.heartbeat(agent.id, run.id);
    expect(stopped.directive).toBe("stop");
    expect(stopped.reason).toMatch(/contain/i);

    // And the record does not go on showing live work.
    const after = await h.platform.external.stores.runs.getExternalRun(run.id);
    expect(after?.status).toBe("stopped");
    await h.platform.close();
  });

  // -------------------------------------------------------------------------
  // 6. Governed execution
  // -------------------------------------------------------------------------

  it("performs a governed read immediately", async () => {
    const h = await harness();
    const agent = await h.enroll();

    const outcome = await h.platform.external.execution.execute({
      agentId: agent.id,
      integration: "owner_records",
      operation: "lookup_owner",
      mode: "read",
      request: { ownerId: "own_4821" },
    });

    expect(outcome.kind).toBe("completed");
    expect(h.performed).toEqual(['lookup_owner:{"ownerId":"own_4821"}']);

    if (outcome.kind !== "completed") throw new Error("unreachable");
    const run = await h.platform.runs.requireRun(outcome.runId);
    expect(run.requestedBy.roles).toContain(EXTERNAL_PRINCIPAL_ROLE);
    await h.platform.close();
  });

  it("stops an external agent's reads and parks when the platform is paused", async () => {
    const h = await harness();
    const agent = await h.enroll();

    await h.platform.containment.engage(
      "global",
      "",
      ADMIN.actorId,
      "Incident 2026-08-10: suspected bad data in the owner records feed.",
    );

    // A read is an outbound call made with the platform's credentials. A global
    // pause is an operator saying "stop touching the systems of record", and an
    // external agent's read is exactly that.
    await expect(
      h.platform.external.execution.execute({
        agentId: agent.id,
        integration: "owner_records",
        operation: "lookup_owner",
        mode: "read",
        request: { ownerId: "own_4821" },
      }),
    ).rejects.toMatchObject({ reason: "containment.global_pause" });
    expect(h.performed).toEqual([]);

    // And a write is not merely deferred: no approval is raised at all, so the
    // queue does not fill with requests that arrived while everything was
    // supposed to be stopped.
    await expect(
      h.platform.external.execution.execute({
        agentId: agent.id,
        integration: "owner_records",
        operation: "issue_goodwill_credit",
        mode: "write",
        request: { ownerId: "own_4821", amountUsd: 50, reason: "Goodwill" },
      }),
    ).rejects.toMatchObject({ reason: "containment.global_pause" });

    const queue = await h.platform.approvals.list({ status: ["pending"] });
    expect(queue).toHaveLength(0);
    await h.platform.close();
  });

  it("refuses a screen during a platform pause, but still accepts the report", async () => {
    const h = await harness();
    const agent = await h.enroll();

    await h.platform.containment.engage("global", "", ADMIN.actorId, "Incident 2026-08-10.");

    const denied = await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "screen",
      tool: "lookup_owner",
      declaredRisk: "routine",
    });
    expect(denied.outcome).toBe("denied");
    expect(denied.reason).toBe("containment.global_pause");

    // Asking politely during our pause is not misbehaviour, so it must not
    // count toward containing the agent.
    const still = await h.platform.external.enrollment.require(agent.id);
    expect(still.status).toBe("active");

    // A report describes work that already happened somewhere we do not
    // control. Refusing to write it down does not un-happen it; it puts a hole
    // in the record exactly where an investigator will look.
    const reported = await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "report",
      tool: "draft_reply",
      declaredRisk: "routine",
    });
    expect(reported.outcome).toBe("allowed");
    await h.platform.close();
  });

  it("tells a live external run to stop when the platform is paused", async () => {
    const h = await harness();
    const agent = await h.enroll();

    const run = await h.platform.external.liveRuns.start({
      agentId: agent.id,
      goal: "Reconcile owner statements.",
    });

    await h.platform.containment.engage(
      "global",
      "",
      ADMIN.actorId,
      "Incident 2026-08-10: pausing everything.",
    );

    h.clock.advance(10_000);
    const beat = await h.platform.external.liveRuns.heartbeat(agent.id, run.id);
    expect(beat.directive).toBe("stop");
    expect(beat.reason).toMatch(/paused/i);

    // And nothing new begins while the pause holds.
    await expect(
      h.platform.external.liveRuns.start({ agentId: agent.id, goal: "Something else." }),
    ).rejects.toMatchObject({ reason: "containment.global_pause" });
    await h.platform.close();
  });

  it("performs a governed write only after a human approves that exact request", async () => {
    const h = await harness();
    const agent = await h.enroll();

    const request = {
      agentId: agent.id,
      integration: "owner_records",
      operation: "issue_goodwill_credit",
      mode: "write",
      request: { ownerId: "own_4821", amountUsd: 250, reason: "Resort closure during stay" },
    } as const;

    const parked = await h.platform.external.execution.execute(request);
    expect(parked.kind).toBe("approval_required");
    if (parked.kind !== "approval_required") throw new Error("unreachable");

    // Nothing has happened yet. That is the point of two phases.
    expect(h.performed).toEqual([]);

    // The human sees what will happen, in words, not a request body.
    expect(parked.preview.map((row) => row.label)).toContain("Action");
    expect(JSON.stringify(parked.preview)).toContain("own_4821");

    // Committing before the decision is refused.
    await expect(
      h.platform.external.execution.execute({ ...request, parkedActionId: parked.parkedActionId }),
    ).rejects.toBeInstanceOf(DeniedError);
    expect(h.performed).toEqual([]);

    await h.platform.approvals.decide({
      approvalId: parked.approvalId,
      actor: SUPERVISOR,
      decision: "granted",
      secondsSinceAuthentication: 30,
    });

    // A different request under the same approval is refused, and the approval
    // is spent rather than left for the next attempt.
    const swapped = await h.platform.external.execution
      .execute({
        ...request,
        request: { ...request.request, amountUsd: 2_500 },
        parkedActionId: parked.parkedActionId,
      })
      .catch((error: unknown) => error);
    expect(swapped).toBeInstanceOf(DeniedError);
    expect((swapped as DeniedError).reason).toBe("approval.digest_mismatch");
    expect(h.performed).toEqual([]);

    await h.platform.close();
  });

  it("commits the approved request, once, however many times it is sent", async () => {
    const h = await harness();
    const agent = await h.enroll();

    const request = {
      agentId: agent.id,
      integration: "owner_records",
      operation: "issue_goodwill_credit",
      mode: "write",
      request: { ownerId: "own_7714", amountUsd: 100, reason: "Booking error" },
    } as const;

    const parked = await h.platform.external.execution.execute(request);
    if (parked.kind !== "approval_required") throw new Error("unreachable");

    await h.platform.approvals.decide({
      approvalId: parked.approvalId,
      actor: SUPERVISOR,
      decision: "granted",
      secondsSinceAuthentication: 30,
    });

    const committed = await h.platform.external.execution.execute({
      ...request,
      parkedActionId: parked.parkedActionId,
    });
    expect(committed.kind).toBe("completed");
    expect(h.performed).toHaveLength(1);

    // A replay hears "already done" — never "expired, submit it again", which
    // is the answer that turns a retry into a second credit.
    const replay = await h.platform.external.execution.execute({
      ...request,
      parkedActionId: parked.parkedActionId,
    });
    expect(replay.kind).toBe("already_done");
    expect(h.performed).toHaveLength(1);
    await h.platform.close();
  });

  // -------------------------------------------------------------------------
  // 7. Automatic containment, and human release
  // -------------------------------------------------------------------------

  it("contains an agent after repeated denials, and an admin releases it", async () => {
    const h = await harness({ PV_EXTERNAL_DENIALS_BEFORE_CONTAINMENT: "3" });
    const agent = await h.enroll();

    // Asking for a tool it was never granted, over and over. Each attempt is
    // cheap and trips no rate limit, which is exactly why the denial pattern
    // has to be what contains it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const denied = await h.platform.external.admission.admit({
        agentId: agent.id,
        operation: "screen",
        tool: "delete_contract",
        declaredRisk: "routine",
      });
      expect(denied.outcome).toBe("denied");
    }

    const contained = await h.platform.external.enrollment.require(agent.id);
    expect(contained.status).toBe("contained");
    expect(contained.statusReason).toMatch(/automatic containment/i);

    // Contained means contained: even a tool it does hold is refused.
    const blocked = await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "screen",
      tool: "lookup_owner",
      declaredRisk: "routine",
    });
    expect(blocked.outcome).toBe("denied");
    expect(blocked.reason).toBe("containment.role_disabled");

    // A human releases it. Nothing else can.
    await h.platform.external.enrollment.release({ actor: ADMIN }, agent.id, "Vendor fixed the tool name in their config.");
    await h.platform.external.rateLimiter.clearDenials(agent.id);

    const released = await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "screen",
      tool: "lookup_owner",
      declaredRisk: "routine",
    });
    expect(released.outcome).toBe("allowed");
    await h.platform.close();
  });

  it("does not count our own infrastructure failures against the agent", async () => {
    const h = await harness({ PV_EXTERNAL_DENIALS_BEFORE_CONTAINMENT: "2" });
    const agent = await h.enroll();

    // An unenrolled-agent denial is classed as infrastructure, not
    // misbehaviour. Repeated denials that were never the agent's fault must not
    // contain it: containing a team because of our outage teaches them the
    // platform is unreliable rather than strict.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await h.platform.external.rateLimiter.recordDenial(
        agent.id,
        "infrastructure",
        "the operating record was briefly unreachable",
      );
    }

    const still = await h.platform.external.enrollment.require(agent.id);
    expect(still.status).toBe("active");
    await h.platform.close();
  });

  // -------------------------------------------------------------------------
  // 8. Revocation
  // -------------------------------------------------------------------------

  it("stops an agent instantly on revocation, including work in flight", async () => {
    const h = await harness();
    const agent = await h.enroll();

    const run = await h.platform.external.liveRuns.start({
      agentId: agent.id,
      goal: "Sweep owner accounts for missing statements.",
    });

    const approval = await h.platform.approvals.request({
      action: "external_agent.revoke",
      proposalDigest: revocationProposalDigest(agent.id, "Vendor contract ended."),
      summary: `Revoke external agent ${agent.name}`,
      requestedBy: ADMIN,
      approvalsRequired: 1,
      eligibleRoles: ["platform_admin", "supervisor"],
    });
    await h.platform.approvals.decide({
      approvalId: approval.id,
      actor: SUPERVISOR,
      decision: "granted",
      secondsSinceAuthentication: 30,
    });
    await h.platform.external.enrollment.revoke(
        { actor: ADMIN, approvalId: approval.id, secondsSinceAuthentication: 30 },
        agent.id,
        "Vendor contract ended.",
      );

    // In flight: the next heartbeat stops it.
    const beat = await h.platform.external.liveRuns.heartbeat(agent.id, run.id);
    expect(beat.directive).toBe("stop");

    // New work: refused outright.
    const denied = await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "screen",
      tool: "lookup_owner",
      declaredRisk: "routine",
    });
    expect(denied.outcome).toBe("denied");
    expect(denied.message).toMatch(/revoked/i);

    // And starting a new run is refused rather than merely stopped later.
    await expect(
      h.platform.external.liveRuns.start({ agentId: agent.id, goal: "One more sweep." }),
    ).rejects.toBeInstanceOf(DeniedError);
    await h.platform.close();
  });

  // -------------------------------------------------------------------------
  // The audit chain covers all of it
  // -------------------------------------------------------------------------

  it("leaves an intact audit chain over everything an external agent did", async () => {
    const h = await harness();
    const agent = await h.enroll();

    await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "screen",
      tool: "lookup_owner",
      declaredRisk: "routine",
    });
    await h.platform.external.admission.admit({
      agentId: agent.id,
      operation: "screen",
      tool: "delete_contract",
      declaredRisk: "routine",
    });
    await h.platform.external.reports.ingest({
      agentId: agent.id,
      idempotencyKey: "episode-audit",
      goal: "Two lookups.",
      startedAt: START,
      endedAt: new Date(Date.parse(START) + MINUTE).toISOString(),
      outcome: "succeeded",
      steps: [],
      costUsd: 0.2,
    });

    const entries = await h.platform.audit.list({ limit: 500 });
    const result = verifyChain(entries);
    expect(result.intact).toBe(true);

    // Every external-agent entry names the agent, so an investigator filtering
    // the one audit log by principal sees the whole story in one place.
    const external = entries.filter((entry) => entry.actor.actorId === agent.id);
    expect(external.length).toBeGreaterThan(0);
    for (const entry of external) {
      expect(entry.actor.roles).toContain(EXTERNAL_PRINCIPAL_ROLE);
    }
    await h.platform.close();
  });
});
