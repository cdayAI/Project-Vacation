import { describe, it, expect } from "vitest";
import { buildReviewHarness, REVIEW_AGENT, type ReviewHarness } from "./harness.js";
import type { EnrolledAgent, ExternalAgentId } from "../external/types.js";
import { DeniedError } from "../kernel/errors.js";

/**
 * Pass 3 — object-level authorization on the external plane.
 *
 * The defect class: change an id in a payload to another party's record and
 * see whether the server refuses. It is invisible to every test that only ever
 * uses one fixture id, which is what `external/execute.test.ts` and the pass-2
 * review tests do — they enrol one agent and drive the whole two-phase commit
 * with it.
 *
 * The plane takes ownership seriously in three other places, which is what
 * makes the commit path's silence a defect rather than a decision:
 *
 *   `external/runs.ts:291`  a heartbeat for a run belonging to another agent
 *                           is refused.
 *   `external/runs.ts:348`  so is finishing one.
 *   `api/external.ts:471`   polling an approval raised by another agent 404s,
 *                           deliberately indistinguishable from "no such
 *                           approval", so an agent cannot walk the id space.
 *
 * `ExecutionService.commit` (external/execute.ts:330) reads the parked action
 * by id and never compares `action.agentId` to the caller.
 */

const SECOND_AGENT = "eag_second" as ExternalAgentId;

const WRITE = {
  integration: "crm",
  operation: "update_contact",
  mode: "write" as const,
  request: { contactId: "ctr_0001", mailingAddress: "12 Elm Street" },
};

/** Enrol a second agent with the same grants, as a real deployment has. */
async function enrolSecondAgent(harness: ReviewHarness, tool: string): Promise<EnrolledAgent> {
  return harness.agents.createAgent({
    id: SECOND_AGENT,
    name: "second-agent",
    owner: "morgan",
    department: "owner services",
    hostPlatform: "a different vendor platform",
    purpose: "a second enrolled agent, as any real deployment has",
    allowedTools: [{ tool, operatorRisk: "high_consequence" }],
    riskCeiling: "high_consequence",
    spendCeilingUsd: 100,
    budgetPeriod: "monthly",
    wallClockCeilingMs: 60_000,
    dataScopes: ["owner_services"],
    expiresAt: "2027-01-01T00:00:00.000Z",
    status: "active",
    enrolledBy: "admin",
    enrolledAt: "2026-08-06T12:00:00.000Z",
    updatedAt: "2026-08-06T12:00:00.000Z",
  });
}

/** Park a write for the first agent and have a supervisor grant it. */
async function parkedAndApproved(harness: ReviewHarness) {
  const outcome = await harness.execution.execute({ agentId: REVIEW_AGENT, ...WRITE });
  if (outcome.kind !== "approval_required") {
    throw new Error(`expected the write to park, received ${outcome.kind}`);
  }
  await harness.approvals.decide({
    approvalId: outcome.approvalId,
    actor: { actorId: "dana", kind: "human", roles: ["supervisor"] },
    decision: "granted",
    requiresStepUp: false,
  });
  return outcome;
}

async function harnessWithTwoAgents(): Promise<ReviewHarness> {
  const harness = await buildReviewHarness({
    tools: [{ tool: "crm.update_contact", operatorRisk: "high_consequence" }],
    connectors: [
      { integration: "crm", operations: [{ operation: "update_contact", mode: "write" }] },
    ],
  });
  await enrolSecondAgent(harness, "crm.update_contact");
  return harness;
}

describe("committing a parked action that belongs to another agent", () => {
  it("does not perform the effect", async () => {
    // This one passes today, and it is kept because the reason it passes is
    // incidental: `digestOf` (external/execute.ts:100) folds `agentId` into the
    // request digest, so a second agent's commit fails the digest comparison
    // rather than an ownership check. Anyone who ever narrows that digest to
    // the request payload — a reasonable-looking change — removes the only
    // thing standing between one vendor's agent and another's approved write.
    const harness = await harnessWithTwoAgents();
    const parked = await parkedAndApproved(harness);

    const outcome = await harness.execution
      .execute({ agentId: SECOND_AGENT, ...WRITE, parkedActionId: parked.parkedActionId })
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(DeniedError);
    expect(harness.log.calls, "the outbound write was performed for the wrong agent").toHaveLength(
      0,
    );
  });

  it("leaves the approved action intact instead of destroying it", async () => {
    // The finding. Because the digest check runs before any ownership check,
    // a commit presenting another agent's parked action id is classified as
    // *that action being tampered with*: the record is voided, the human's
    // approval becomes unspendable, and the agent the supervisor actually
    // approved is refused for the rest of the action's life.
    //
    // One enrolled agent can therefore cancel every other agent's approved,
    // pending work by naming its id — with no credential of theirs, and
    // without the platform ever asking whose action it is.
    const harness = await harnessWithTwoAgents();
    const parked = await parkedAndApproved(harness);

    await harness.execution
      .execute({ agentId: SECOND_AGENT, ...WRITE, parkedActionId: parked.parkedActionId })
      .catch(() => undefined);

    const stored = await harness.parked.getParkedAction(parked.parkedActionId);
    expect(
      stored?.status,
      "another agent's commit attempt voided this agent's approved action",
    ).toBe("pending");

    const outcome = await harness.execution.execute({
      agentId: REVIEW_AGENT,
      ...WRITE,
      parkedActionId: parked.parkedActionId,
    });
    expect(outcome.kind, "the agent the human approved can no longer perform its action").toBe(
      "completed",
    );
  });

  it("does not write a tampering accusation against the agent that did nothing", async () => {
    // The governance half, and the more serious one. The void reason recorded
    // on the first agent's action reads "The committed request did not match
    // the approved request. What a human approved is not what was about to be
    // done." Nobody reviewing that record afterwards can tell that the first
    // agent never submitted anything — the platform's own record accuses it of
    // substituting a payload it never sent.
    const harness = await harnessWithTwoAgents();
    const parked = await parkedAndApproved(harness);

    await harness.execution
      .execute({ agentId: SECOND_AGENT, ...WRITE, parkedActionId: parked.parkedActionId })
      .catch(() => undefined);

    const stored = await harness.parked.getParkedAction(parked.parkedActionId);
    expect(
      stored?.voidReason ?? "",
      "the record accuses the wrong agent of substituting its payload",
    ).not.toMatch(/did not match the approved request/);
  });
});
