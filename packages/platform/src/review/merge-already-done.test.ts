import { describe, it, expect } from "vitest";
import { buildReviewHarness, parkAndApprove, REVIEW_AGENT, REVIEW_NOW } from "./harness.js";

/**
 * Verification pass — a second reproduction for the synthesised `already_done`.
 *
 * `pass2-ledger-and-races.test.ts` reproduces this through the used-approval
 * ledger's eviction floor. That reproduction is correct, but it reaches the
 * defect through `evictBefore`, which has no caller anywhere in the product —
 * so on its own it leaves the finding looking latent, and a reader could
 * reasonably defer it until eviction is wired.
 *
 * It is not latent. The same branch is reachable with no dead code involved,
 * through the window every two-statement sequence has: `ExecutionService.commit`
 * claims the approval in the ledger (`external/execute.ts:482`) and only then
 * moves the parked action into `committing` (`:493`). A worker that dies
 * between those two lines leaves the approval claimed and the action still
 * sitting at `pending`. Nothing was performed — the outbound call is at `:510`,
 * further down.
 *
 * The agent's retry then reads `isConsumed` at `:470`, finds it true, and is
 * told the action is already done. `api/external.ts` renders that as "This
 * action was already committed. The original outcome is returned; it was not
 * performed a second time" — about a write that never happened, with an empty
 * `resultSummary` because there was never a result.
 *
 * This is the same defect the ledger-floor test found, reached the way it will
 * actually be reached in production: a crash, not an eviction. It is stated
 * separately so that fixing the ledger's floor alone cannot be mistaken for
 * fixing this.
 */

const WRITE = {
  agentId: REVIEW_AGENT,
  integration: "crm",
  operation: "update_contact",
  mode: "write" as const,
  request: { contactId: "ctr_0001", field: "mailing_preference", value: "post" },
};

const TOOLS = [{ tool: "crm.update_contact", operatorRisk: "high_consequence" as const }];
const CONNECTORS = [
  { integration: "crm", operations: [{ operation: "update_contact", mode: "write" as const }] },
];

describe("a commit whose worker died between claiming the approval and going in flight", () => {
  it("is not told the action was already committed", async () => {
    const harness = await buildReviewHarness({ tools: TOOLS, connectors: CONNECTORS });
    const parked = await parkAndApprove(harness, WRITE);

    // The durable state a crash at `execute.ts:482` leaves behind: the ledger
    // holds the claim, the parked action has not moved, and no call was made.
    await harness.ledger.claimApproval(parked.approvalId, REVIEW_NOW);
    const beforeRetry = await harness.parked.getParkedAction(parked.parkedActionId);
    expect(beforeRetry?.status).toBe("pending");
    expect(harness.log.calls).toHaveLength(0);

    const outcome = await harness.execution
      .execute({ ...WRITE, parkedActionId: parked.parkedActionId })
      .catch((error: Error) => error);

    // Whatever the right answer is, it is not "already committed". The record
    // itself says the action never left `pending`, so the platform is
    // contradicting its own operating record in the agent's favour — the one
    // direction a governance product must never round in.
    if (!(outcome instanceof Error)) {
      expect(outcome.kind).not.toBe("already_done");
    }
    expect(harness.log.calls).toHaveLength(0);
  });

  it("does not answer from a status the parked action never reached", async () => {
    // Stated as a property rather than as a value, so it survives whichever
    // answer the owner chooses: a refusal, or an honest `indeterminate`. The
    // rule is that `already_done` must be read off the record, never
    // synthesised from a negative signal somewhere else.
    const harness = await buildReviewHarness({ tools: TOOLS, connectors: CONNECTORS });
    const parked = await parkAndApprove(harness, WRITE);
    await harness.ledger.claimApproval(parked.approvalId, REVIEW_NOW);

    const outcome = await harness.execution
      .execute({ ...WRITE, parkedActionId: parked.parkedActionId })
      .catch((error: Error) => error);

    const stored = await harness.parked.getParkedAction(parked.parkedActionId);
    if (!(outcome instanceof Error) && outcome.kind === "already_done") {
      expect(stored?.status).toBe("committed");
    }
  });
});
