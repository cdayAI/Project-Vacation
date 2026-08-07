import { describe, it, expect, beforeEach } from "vitest";
import { FixedClock, HOUR } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { DeniedError } from "../kernel/errors.js";
import { MemoryDb } from "../store/db.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { AuditLog } from "../audit/log.js";
import { MemoryRunStore } from "../record/store.memory.js";
import { MemoryApprovalStore, MemoryContainmentStore } from "../guard/store.memory.js";
import { ApprovalService } from "../guard/approvals.js";
import { ContainmentController } from "../guard/containment.js";
import { AdmissionService } from "./admission.js";
import { ExecutionService, type GovernedIntegration } from "./execute.js";
import type {
  EnrollmentStore,
  ParkedActionStore,
  SpendStore,
  UsedApprovalLedger,
} from "./port.js";
import type { RateLimiterLike } from "./ratelimit-port.js";
import type {
  DenialClass,
  EnrolledAgent,
  ExternalAgentId,
  ParkedAction,
  ParkedActionStatus,
  SpendMeter,
} from "./types.js";

/**
 * Governed-execution tests.
 *
 * Every case here is one of the defects the design set out to avoid. They are
 * written as attacks: a swapped payload, a replayed commit, a revocation
 * arriving while an approval sits in the queue, an approval reused after the
 * ledger forgot it, two workers committing at once, and a worker dying
 * mid-action.
 */

const AGENT = "eag_crm" as ExternalAgentId;
const NOW = "2026-08-06T12:00:00.000Z";

// --- fakes ------------------------------------------------------------------

class FakeEnrollment implements EnrollmentStore {
  agent: EnrolledAgent;
  constructor(overrides: Partial<EnrolledAgent> = {}) {
    this.agent = {
      id: AGENT,
      name: "crm-assistant",
      owner: "dana",
      department: "owner services",
      hostPlatform: "customer relationship system",
      purpose: "answer owner questions about their contract",
      allowedTools: [{ tool: "crm.update_contact", operatorRisk: "high_consequence" }],
      riskCeiling: "high_consequence",
      spendCeilingUsd: 100,
      budgetPeriod: "monthly",
      wallClockCeilingMs: 60_000,
      dataScopes: ["owner_services"],
      expiresAt: "2027-01-01T00:00:00.000Z",
      status: "active",
      enrolledBy: "admin",
      enrolledAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }
  async createAgent(agent: EnrolledAgent) {
    this.agent = agent;
    return agent;
  }
  async getAgent(id: ExternalAgentId) {
    return id === this.agent.id ? this.agent : null;
  }
  async getAgentByName() {
    return this.agent;
  }
  async listAgents() {
    return [this.agent];
  }
  async countAgents() {
    return 1;
  }
  async updateAgent() {
    return this.agent;
  }
  async setAgentStatus(input: {
    expectedStatus: EnrolledAgent["status"];
    status: EnrolledAgent["status"];
    reason: string;
  }) {
    if (this.agent.status !== input.expectedStatus) return null;
    this.agent = { ...this.agent, status: input.status, statusReason: input.reason };
    return this.agent;
  }
  async touchLastSeen() {}
  async claimSeat() {
    return true;
  }
  async releaseSeat() {}
}

class FakeSpend implements SpendStore {
  private readonly meters = new Map<string, number>();
  async addSpend(agentId: ExternalAgentId, periodKey: string, amount: number) {
    const key = `${agentId}:${periodKey}`;
    const next = (this.meters.get(key) ?? 0) + amount;
    this.meters.set(key, next);
    return next;
  }
  async getMeter(agentId: ExternalAgentId, periodKey: string): Promise<SpendMeter | null> {
    const spent = this.meters.get(`${agentId}:${periodKey}`);
    return spent === undefined
      ? null
      : { agentId, periodKey, spentUsd: spent, updatedAt: NOW };
  }
  async listMeters() {
    return [];
  }
}

class FakeParked implements ParkedActionStore {
  readonly actions = new Map<string, ParkedAction>();
  async createParkedAction(action: ParkedAction) {
    this.actions.set(action.id, action);
    return action;
  }
  async getParkedAction(id: string) {
    return this.actions.get(id) ?? null;
  }
  async listParkedActions(filter?: { status?: readonly ParkedActionStatus[] }) {
    const all = [...this.actions.values()];
    return filter?.status ? all.filter((a) => filter.status?.includes(a.status)) : all;
  }
  async bindApproval(id: string, approvalId: string, at: string) {
    const found = this.actions.get(id);
    if (!found || found.status !== "pending") return null;
    const bound = { ...found, approvalId: approvalId as ParkedAction["approvalId"] };
    void at;
    this.actions.set(id, bound);
    return bound;
  }
  async transitionParkedAction(input: {
    id: string;
    expectedStatus: ParkedActionStatus;
    status: ParkedActionStatus;
    at: string;
    resultDigest?: string;
    resultSummary?: string;
    voidReason?: string;
  }) {
    const found = this.actions.get(input.id);
    // Conditional. This null is how a duplicate commit is detected.
    if (!found || found.status !== input.expectedStatus) return null;
    const next: ParkedAction = {
      ...found,
      status: input.status,
      committedAt: input.status === "committed" ? input.at : found.committedAt,
      resultDigest: input.resultDigest ?? found.resultDigest,
      resultSummary: input.resultSummary ?? found.resultSummary,
      voidReason: input.voidReason ?? found.voidReason,
    };
    this.actions.set(input.id, next);
    return next;
  }
  async expireParkedActions() {
    return [];
  }
}

/** A ledger with a bounded size and an eviction floor, as the port requires. */
class FakeLedger implements UsedApprovalLedger {
  private readonly claimed = new Set<string>();
  private floor: string | null = null;
  constructor(private readonly capacity = 1000) {}

  async claimApproval(approvalId: string) {
    if (await this.isConsumed(approvalId)) return false;
    this.claimed.add(approvalId);
    if (this.claimed.size > this.capacity) await this.evictOldest();
    return true;
  }
  async isConsumed(approvalId: string) {
    if (this.claimed.has(approvalId)) return true;
    // Forgetting must only ever refuse.
    return this.floor !== null && approvalId <= this.floor;
  }
  async evictBefore(cutoff: string) {
    for (const id of [...this.claimed]) {
      if (id <= cutoff) {
        this.claimed.delete(id);
        if (this.floor === null || id > this.floor) this.floor = id;
      }
    }
    return this.floor;
  }
  private async evictOldest() {
    const oldest = [...this.claimed].sort()[0];
    if (oldest) await this.evictBefore(oldest);
  }
}

class FakeRateLimiter implements RateLimiterLike {
  readonly denials: DenialClass[] = [];
  allowed = true;
  async check() {
    return { allowed: this.allowed, count: 1 };
  }
  async recordDenial(_agentId: ExternalAgentId, denialClass: DenialClass) {
    this.denials.push(denialClass);
  }
}

class FakeIntegration implements GovernedIntegration {
  enabled = true;
  readOperations = new Set<string>();
  unknownOperations = new Set<string>();
  calls: { operation: string; idempotencyKey: string }[] = [];
  failWith: Error | null = null;
  async isEnabled() {
    return this.enabled;
  }
  /**
   * The registry is the mode authority, and this fake registers everything as
   * a write unless a test says otherwise — matching the real router, which
   * refuses an operation it does not know rather than guessing one.
   */
  modeOf(_integration: string, operation: string): "read" | "write" | null {
    if (this.unknownOperations.has(operation)) return null;
    return this.readOperations.has(operation) ? "read" : "write";
  }
  async perform(input: { operation: string; idempotencyKey: string }) {
    this.calls.push({ operation: input.operation, idempotencyKey: input.idempotencyKey });
    if (this.failWith) throw this.failWith;
    return { ok: true };
  }
}

// --- harness ----------------------------------------------------------------

function build() {
  const clock = new FixedClock(NOW);
  const ids = new SeededIdGenerator("exec");
  const db = new MemoryDb();
  const audit = new AuditLog(new MemoryAuditStore(db), clock, ids);
  const runs = new MemoryRunStore(db, clock, ids);
  const approvals = new ApprovalService(new MemoryApprovalStore(db), clock, ids, audit);
  const containment = new ContainmentController(new MemoryContainmentStore(db), clock, audit, 0);

  const enrollment = new FakeEnrollment();
  const spend = new FakeSpend();
  const rateLimiter = new FakeRateLimiter();
  const parked = new FakeParked();
  const ledger = new FakeLedger();
  const integration = new FakeIntegration();

  const admission = new AdmissionService(
    enrollment,
    spend,
    rateLimiter,
    approvals,
    audit,
    clock,
    { approvalThreshold: "high_consequence" },
  );

  const execution = new ExecutionService(
    admission,
    parked,
    ledger,
    approvals,
    enrollment,
    integration,
    containment,
    runs,
    rateLimiter,
    audit,
    clock,
    ids,
  );

  return {
    clock, ids, audit, runs, approvals, containment,
    enrollment, spend, rateLimiter, parked, ledger, integration,
    admission, execution,
  };
}

type Harness = ReturnType<typeof build>;

const WRITE = {
  agentId: AGENT,
  integration: "crm",
  operation: "update_contact",
  mode: "write" as const,
  request: { contactId: "ctr_0001", field: "mailing_preference", value: "post" },
};

/** Park a write and have a supervisor approve it. */
async function parkAndApprove(h: Harness) {
  const parkedOutcome = await h.execution.execute(WRITE);
  if (parkedOutcome.kind !== "approval_required") throw new Error("expected a parked action");

  await h.approvals.decide({
    approvalId: parkedOutcome.approvalId,
    actor: { actorId: "dana", kind: "human", roles: ["supervisor"] },
    decision: "granted",
    requiresStepUp: false,
  });

  return parkedOutcome;
}

// --- tests ------------------------------------------------------------------

describe("governed writes", () => {
  let h: Harness;
  beforeEach(() => {
    h = build();
  });

  it("parks a write behind a human decision, with a readable preview", async () => {
    const outcome = await h.execution.execute(WRITE);
    expect(outcome.kind).toBe("approval_required");
    if (outcome.kind !== "approval_required") return;

    // The approver is authorising a payload they did not write. A JSON blob is
    // not a decision aid.
    expect(outcome.preview).toEqual(
      expect.arrayContaining([{ label: "contactId", value: "ctr_0001" }]),
    );
    // Nothing has happened yet.
    expect(h.integration.calls).toHaveLength(0);
  });

  it("raises exactly one approval per write", async () => {
    // Regression guard. The admission chain and the parking path each used to
    // raise their own, so a single write put two entries in the queue — one
    // bound to the request digest and one not. An approver would have seen the
    // same action twice and had no way to tell which one mattered.
    await h.execution.execute(WRITE);
    const pending = await h.approvals.list({ status: ["pending"] });
    expect(pending).toHaveLength(1);
    // And the one that exists binds to the request, so the commit can match it.
    expect(pending[0]?.proposalDigest).toBe(
      h.parked.actions.values().next().value?.requestDigest,
    );
  });

  it("labels the approval as raised by an external agent", async () => {
    const outcome = await parkAndApprove(h);
    const approval = await h.approvals.get(outcome.approvalId);
    expect(approval?.summary).toMatch(/\[external agent\]/);
    expect(approval?.subject.externalAgentId).toBe(AGENT);
  });

  it("commits the byte-identical request once approved", async () => {
    const parkedOutcome = await parkAndApprove(h);
    const committed = await h.execution.execute({
      ...WRITE,
      parkedActionId: parkedOutcome.parkedActionId,
    });

    expect(committed.kind).toBe("completed");
    expect(h.integration.calls).toHaveLength(1);
  });

  it("voids the action when the committed request differs from the approved one", async () => {
    // The defect this closes: an approval authorises one payload and a
    // different one executes.
    const parkedOutcome = await parkAndApprove(h);

    await expect(
      h.execution.execute({
        ...WRITE,
        request: { ...WRITE.request, value: "do-not-contact" },
        parkedActionId: parkedOutcome.parkedActionId,
      }),
    ).rejects.toMatchObject({ reason: "approval.digest_mismatch" });

    expect(h.integration.calls).toHaveLength(0);
    expect(h.parked.actions.get(parkedOutcome.parkedActionId)?.status).toBe("voided");
    // And it counts as misbehaviour.
    expect(h.rateLimiter.denials).toContain("misbehaviour");
  });

  it("accepts a re-serialised request with the same content", async () => {
    // Binding to canonical content rather than raw bytes: a legitimate agent
    // whose JSON library orders keys differently must still be able to commit
    // its own approved request.
    const parkedOutcome = await parkAndApprove(h);
    const reordered = {
      ...WRITE,
      request: { value: "post", field: "mailing_preference", contactId: "ctr_0001" },
      parkedActionId: parkedOutcome.parkedActionId,
    };
    await expect(h.execution.execute(reordered)).resolves.toMatchObject({ kind: "completed" });
  });

  it("tells a replayed commit it is already done, never that it expired", async () => {
    // Telling a replay "expired, submit it again" is an instruction to
    // duplicate the effect through a second approval.
    const parkedOutcome = await parkAndApprove(h);
    await h.execution.execute({ ...WRITE, parkedActionId: parkedOutcome.parkedActionId });

    h.clock.advance(48 * HOUR); // well past the parked action's expiry

    const replay = await h.execution.execute({
      ...WRITE,
      parkedActionId: parkedOutcome.parkedActionId,
    });
    expect(replay.kind).toBe("already_done");
    expect(h.integration.calls).toHaveLength(1);
  });

  it("refuses the commit when the agent was revoked while the approval sat in the queue", async () => {
    // A human's yes is necessary, not sufficient.
    const parkedOutcome = await parkAndApprove(h);
    await h.enrollment.setAgentStatus({
      id: AGENT,
      expectedStatus: "active",
      status: "revoked",
      reason: "vendor contract ended",
      by: "admin",
      at: NOW,
    });

    await expect(
      h.execution.execute({ ...WRITE, parkedActionId: parkedOutcome.parkedActionId }),
    ).rejects.toThrow(/does not survive the agent being stopped/);
    expect(h.integration.calls).toHaveLength(0);
  });

  it("refuses the commit when the connector was disabled while the approval sat in the queue", async () => {
    const parkedOutcome = await parkAndApprove(h);
    h.integration.enabled = false;

    await expect(
      h.execution.execute({ ...WRITE, parkedActionId: parkedOutcome.parkedActionId }),
    ).rejects.toMatchObject({ reason: "containment.integration_revoked" });
    expect(h.integration.calls).toHaveLength(0);
  });

  it("refuses the commit when the integration is contained", async () => {
    const parkedOutcome = await parkAndApprove(h);
    await h.containment.engage("integration", "crm", "operator", "vendor incident");

    await expect(
      h.execution.execute({ ...WRITE, parkedActionId: parkedOutcome.parkedActionId }),
    ).rejects.toThrow();
    expect(h.integration.calls).toHaveLength(0);
  });

  it("performs the effect exactly once under two concurrent commits", async () => {
    const parkedOutcome = await parkAndApprove(h);
    const commit = { ...WRITE, parkedActionId: parkedOutcome.parkedActionId };

    const outcomes = await Promise.all([
      h.execution.execute(commit).catch((error: Error) => error),
      h.execution.execute(commit).catch((error: Error) => error),
    ]);

    const completed = outcomes.filter(
      (outcome) => !(outcome instanceof Error) && outcome.kind === "completed",
    );
    expect(completed).toHaveLength(1);
    expect(h.integration.calls).toHaveLength(1);
  });

  it("refuses an approval the ledger has forgotten, rather than permitting it", async () => {
    // The subtle one. A bounded ledger that silently permits what it evicted is
    // worse than no ledger, because the protection expires instead of the
    // approval.
    const parkedOutcome = await parkAndApprove(h);
    await h.execution.execute({ ...WRITE, parkedActionId: parkedOutcome.parkedActionId });

    // Age the ledger out entirely, raising the floor past this approval.
    await h.ledger.evictBefore("zzzzzzzzzzzz");

    expect(await h.ledger.isConsumed(parkedOutcome.approvalId)).toBe(true);
  });

  it("leaves the action indeterminate when the effect fails mid-flight, and never retries it", async () => {
    const parkedOutcome = await parkAndApprove(h);
    h.integration.failWith = new Error("connection reset");

    const outcome = await h.execution.execute({
      ...WRITE,
      parkedActionId: parkedOutcome.parkedActionId,
    });

    expect(outcome.kind).toBe("indeterminate");
    if (outcome.kind === "indeterminate") {
      expect(outcome.message).toMatch(/NOT been retried/);
      expect(outcome.message).toMatch(/system of record/);
    }
    expect(h.parked.actions.get(parkedOutcome.parkedActionId)?.status).toBe("indeterminate");

    // A subsequent commit must not re-run it.
    h.integration.failWith = null;
    const retry = await h.execution.execute({
      ...WRITE,
      parkedActionId: parkedOutcome.parkedActionId,
    });
    expect(retry.kind).toBe("indeterminate");
    expect(h.integration.calls).toHaveLength(1);
  });

  it("sweeps a commit stranded by a dead worker into indeterminate", async () => {
    const parkedOutcome = await parkAndApprove(h);
    // Simulate a worker that transitioned into flight and then died.
    await h.parked.transitionParkedAction({
      id: parkedOutcome.parkedActionId,
      expectedStatus: "pending",
      status: "committing",
      at: NOW,
    });

    h.clock.advance(HOUR);
    const swept = await h.execution.sweepStaleCommits();

    expect(swept).toHaveLength(1);
    expect(swept[0]?.status).toBe("indeterminate");
    expect(swept[0]?.voidReason).toMatch(/has not been retried/);
  });

  it("hands the slot back when the approval cannot be created", async () => {
    // Otherwise a pending record with no approval sits there forever,
    // uncommittable and invisible, and the agent retries into a new one each
    // time.
    const broken = build();
    broken.approvals.request = () => Promise.reject(new Error("approval store unavailable"));

    await expect(broken.execution.execute(WRITE)).rejects.toThrow(/approval store unavailable/);

    const stranded = [...broken.parked.actions.values()];
    expect(stranded).toHaveLength(1);
    expect(stranded[0]?.status).toBe("voided");
    expect(stranded[0]?.voidReason).toMatch(/released/);
  });

  it("refuses a commit against an action that was never parked", async () => {
    await expect(
      h.execution.execute({ ...WRITE, parkedActionId: "pac_nonexistent" as never }),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses a commit while the approval is still pending", async () => {
    const outcome = await h.execution.execute(WRITE);
    if (outcome.kind !== "approval_required") throw new Error("expected a parked action");

    await expect(
      h.execution.execute({ ...WRITE, parkedActionId: outcome.parkedActionId }),
    ).rejects.toBeInstanceOf(DeniedError);
    expect(h.integration.calls).toHaveLength(0);
  });
});

describe("governed reads", () => {
  it("runs immediately and records a run", async () => {
    const h = build();
    h.enrollment.agent = {
      ...h.enrollment.agent,
      allowedTools: [{ tool: "crm.read_contact", operatorRisk: "routine" }],
    };

    const outcome = await h.execution.execute({
      agentId: AGENT,
      integration: "crm",
      operation: "read_contact",
      mode: "read",
      request: { contactId: "ctr_0001" },
    });

    expect(outcome.kind).toBe("completed");
    expect(h.integration.calls).toHaveLength(1);

    if (outcome.kind === "completed") {
      const run = await h.runs.getRun(outcome.runId);
      // One record: external work sits beside native work, marked external.
      expect(run?.kind).toBe("external.execute_read");
      expect(run?.requestedBy.roles).toContain("external_agent");
    }
  });

  it("parks a read the operator rated high, rather than running it", async () => {
    const h = build();
    h.enrollment.agent = {
      ...h.enrollment.agent,
      // The operator's rating floors the routine declaration a read carries.
      allowedTools: [{ tool: "crm.export_all_contacts", operatorRisk: "high_consequence" }],
    };

    const outcome = await h.execution.execute({
      agentId: AGENT,
      integration: "crm",
      operation: "export_all_contacts",
      mode: "read",
      request: {},
    });

    expect(outcome.kind).toBe("approval_required");
    expect(h.integration.calls).toHaveLength(0);
  });
});
