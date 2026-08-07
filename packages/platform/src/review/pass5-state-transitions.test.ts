import { describe, it, expect } from "vitest";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import type { Id } from "../kernel/ids.js";
import { DeniedError } from "../kernel/errors.js";
import { MemoryDb } from "../store/db.js";
import { MemoryRunStore } from "../record/store.memory.js";
import { MemoryParkedActionStore, MemoryEnrollmentStore } from "../external/store.memory.js";
import { isTerminalParkedStatus } from "../external/types.js";
import type { EnrolledAgent, ExternalAgentId, ParkedAction } from "../external/types.js";

/**
 * Pass 5 — are illegal state transitions rejected by the model layer, or only
 * by convention?
 *
 * Tried directly against the stores, with the services bypassed, because that
 * is the only way to tell the two apart. A rule that lives in a service is a
 * rule about one code path; a rule that lives in the port is a rule about the
 * data.
 *
 * The operating record enforces its rules in the port, and the first two tests
 * confirm it: a run that has ended cannot be moved to another outcome, and a
 * step that finished cannot be changed. Both refuse with a `DeniedError`
 * naming the transition. That is the standard the rest of the platform is
 * measured against here.
 *
 * The external plane's parked actions declare the same rule and do not enforce
 * it. `external/types.ts:376` defines `TERMINAL_PARKED_STATUSES` and
 * `isTerminalParkedStatus`, and nothing in the codebase calls either — the
 * helper has no reader outside its own definition. Both adapters implement
 * `transitionParkedAction` as a bare compare-and-set on the current status
 * (`store.memory.ts:719`, `store.pg.ts:1015`), which stops a *stale* writer but
 * permits any transition at all from a writer that reads first.
 *
 * So `committed → pending` succeeds against the store, and so does
 * `indeterminate → approved`. The second is the one that matters. The runbook
 * for `EXTERNAL-ACTION-INDETERMINATE` says an indeterminate action is "never
 * retried automatically" because a retry "could issue a second payment", and
 * that an action still wanted "goes through the whole two-phase path again,
 * including a fresh human approval". Moving it back to `approved` is exactly
 * the state from which a commit proceeds on the *original* approval.
 *
 * `ExecutionService.commit` does check the terminal statuses before it acts
 * (`execute.ts:367-388`), so no shipped caller performs these transitions
 * today. That is why this is reported as a missing control rather than a live
 * exploit — but it is the control the record relies on, it is written down as
 * if it exists, and the run store shows what enforcing it looks like.
 */

const NOW = "2026-08-06T12:00:00.000Z";
const AGENT = "eag_transitions" as ExternalAgentId;

function build() {
  const clock = new FixedClock(NOW);
  const ids = new SeededIdGenerator("pass5-transitions");
  const db = new MemoryDb();
  return {
    clock,
    ids,
    runs: new MemoryRunStore(db, clock, ids),
    parked: new MemoryParkedActionStore(db),
    agents: new MemoryEnrollmentStore(db),
  };
}

function agentRow(): EnrolledAgent {
  return {
    id: AGENT,
    name: "transition-probe",
    owner: "dana.reyes@mvw.example",
    department: "owner-services",
    hostPlatform: "vendor-crm",
    purpose: "Exercise the store's transition rules directly.",
    allowedTools: [],
    riskCeiling: "sensitive",
    spendCeilingUsd: 100,
    budgetPeriod: "monthly",
    wallClockCeilingMs: 60_000,
    dataScopes: [],
    expiresAt: "2026-12-01T00:00:00.000Z",
    status: "active",
    enrolledBy: "admin@mvw.example",
    enrolledAt: NOW,
    updatedAt: NOW,
  };
}

function parkedRow(id: string): ParkedAction {
  return {
    id: id as Id<"parkedAction">,
    agentId: AGENT,
    integration: "crm",
    operation: "issue_refund",
    requestDigest: `sha256:${"a".repeat(64)}`,
    preview: "Issue a refund of $420.00 to contract ctr_0001",
    riskTier: "high_consequence",
    status: "pending",
    createdAt: NOW,
    expiresAt: "2026-08-07T12:00:00.000Z",
  } as ParkedAction;
}

describe("the operating record's own transition rules", () => {
  it("refuses to move a run that has already ended", async () => {
    const h = build();
    const run = await h.runs.createRun({
      kind: "workflow",
      mode: "supervised",
      requestedBy: { actorId: "ops:sam", kind: "human", roles: [] },
      subject: { contractId: "ctr_0001" },
      correlationId: "corr-transitions",
    });
    await h.runs.patchRun(run.id, { status: "succeeded", endedAt: NOW });

    await expect(h.runs.patchRun(run.id, { status: "failed" })).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses to change a step that already finished", async () => {
    const h = build();
    const run = await h.runs.createRun({
      kind: "workflow",
      mode: "supervised",
      requestedBy: { actorId: "ops:sam", kind: "human", roles: [] },
      subject: { contractId: "ctr_0001" },
      correlationId: "corr-transitions",
    });
    const step = await h.runs.appendStep({
      runId: run.id,
      kind: "model_call",
      name: "draft",
      idempotencyKey: "k1",
      status: "running",
    });
    await h.runs.patchStep(step.id, { status: "succeeded", endedAt: NOW });

    await expect(h.runs.patchStep(step.id, { status: "failed" })).rejects.toBeInstanceOf(
      DeniedError,
    );
  });
});

describe("a parked action's terminal statuses, against the store", () => {
  it("declares which statuses are terminal", () => {
    // The rule exists as data. The tests below ask whether anything reads it.
    expect(isTerminalParkedStatus("committed")).toBe(true);
    expect(isTerminalParkedStatus("indeterminate")).toBe(true);
    expect(isTerminalParkedStatus("pending")).toBe(false);
  });

  it("refuses to move a committed action back into the approval queue", async () => {
    const h = build();
    await h.agents.createAgent(agentRow());
    const created = await h.parked.createParkedAction(parkedRow("pact_committed"));
    await h.parked.transitionParkedAction({
      id: created.id,
      expectedStatus: "pending",
      status: "committing",
      at: NOW,
    });
    await h.parked.transitionParkedAction({
      id: created.id,
      expectedStatus: "committing",
      status: "committed",
      at: NOW,
      resultSummary: "Committed crm.issue_refund",
    });

    const undone = await h.parked.transitionParkedAction({
      id: created.id,
      expectedStatus: "committed",
      status: "pending",
      at: NOW,
    });

    // The effect has landed and a human's approval has been spent. Putting the
    // record back in front of an approver invites a second refund for a
    // payment that already went out.
    expect(undone).toBeNull();
    expect((await h.parked.getParkedAction(created.id))?.status).toBe("committed");
  });

  it("refuses to move an indeterminate action back to approved", async () => {
    const h = build();
    await h.agents.createAgent(agentRow());
    const created = await h.parked.createParkedAction(parkedRow("pact_indeterminate"));
    await h.parked.transitionParkedAction({
      id: created.id,
      expectedStatus: "pending",
      status: "committing",
      at: NOW,
    });
    await h.parked.transitionParkedAction({
      id: created.id,
      expectedStatus: "committing",
      status: "indeterminate",
      at: NOW,
      voidReason: "A worker stopped while this action was in flight.",
    });

    const revived = await h.parked.transitionParkedAction({
      id: created.id,
      expectedStatus: "indeterminate",
      status: "approved",
      at: NOW,
    });

    // `indeterminate` is the one state the platform says it cannot resolve.
    // Anything that can move it without a person looking makes that claim
    // false, and the record would then say "approved, ready to commit" about
    // an action that may already have issued a payment.
    expect(revived).toBeNull();
    expect((await h.parked.getParkedAction(created.id))?.status).toBe("indeterminate");
  });
});

describe("an agent's enrollment status, against the store", () => {
  it("refuses to bring a revoked agent back to active", async () => {
    const h = build();
    await h.agents.createAgent(agentRow());
    await h.agents.setAgentStatus({
      id: AGENT,
      expectedStatus: "active",
      status: "revoked",
      reason: "vendor_offboarding",
      by: "ops:dana",
      at: NOW,
    });

    const resurrected = await h.agents.setAgentStatus({
      id: AGENT,
      expectedStatus: "revoked",
      status: "active",
      reason: "changed my mind",
      by: "ops:dana",
      at: NOW,
    });

    // `enrollment.ts:747` states the rule: "Revocation is terminal and there is
    // no release from it — bringing the agent back is a fresh enrollment, which
    // is another deliberate, approved decision rather than a status flip." The
    // store is where that has to hold, because the service is not the only
    // thing that reaches it.
    expect(resurrected).toBeNull();
    expect((await h.agents.getAgent(AGENT))?.status).toBe("revoked");
  });
});
