import { describe, it, expect } from "vitest";
import { MemoryUsedApprovalLedger } from "../external/store.memory.js";
import { MemoryDb } from "../store/db.js";
import { buildReviewHarness, parkAndApprove, REVIEW_AGENT, REVIEW_NOW } from "./harness.js";

/**
 * Pass 2 — the used-approval ledger, and two workers committing at once.
 *
 * `port.ts` states the rule the ledger is built to: "if forgetting is
 * possible, forgetting must only ever refuse". The ledger keeps that promise.
 * The question here is what the *caller* does with the refusal, and whether an
 * over-refusal — which the ledger's own comment says is deliberate, because
 * identifiers are not ordered by time — survives the trip back to the agent as
 * a refusal or arrives as something else.
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

describe("an approval the ledger's floor covers", () => {
  it("is refused, not reported as an effect that already happened", async () => {
    // `RandomIdGenerator` produces ids from a 32-character alphabet with no
    // time ordering (kernel/ids.ts:68-74), so the highest id an eviction ever
    // dropped sits above roughly half the ids minted afterwards — and after a
    // few evictions, above nearly all of them. The ledger answers `isConsumed`
    // for those, exactly as its comment says it should.
    const db = new MemoryDb();
    const ledger = new MemoryUsedApprovalLedger(db);
    await ledger.claimApproval("apr_zzzzzzzzzzzzzzzzzzzzzz", REVIEW_NOW);
    const floor = await ledger.evictBefore("2027-01-01T00:00:00.000Z");
    expect(floor).toBe("apr_zzzzzzzzzzzzzzzzzzzzzz");

    const harness = await buildReviewHarness({ tools: TOOLS, connectors: CONNECTORS, ledger });
    const parked = await parkAndApprove(harness, WRITE);
    // The freshly minted approval sits below the floor, as most would.
    expect(await ledger.isConsumed(parked.approvalId)).toBe(true);

    const outcome = await harness.execution
      .execute({ ...WRITE, parkedActionId: parked.parkedActionId })
      .catch((error: Error) => error);

    // Nothing was performed, so the agent must not be told the action is done.
    expect(harness.log.calls).toHaveLength(0);
    if (!(outcome instanceof Error)) {
      expect(outcome.kind).not.toBe("already_done");
    }
  });
});

describe("two workers committing the same action", () => {
  /**
   * A regression guard rather than a finding.
   *
   * The first draft of this test asserted the loser hears the `already_done`
   * outcome. It does not: it is refused with `approval.already_used`, because
   * the guard store's compare-and-set in `ApprovalService.consume` fires before
   * the commit reaches the branches that return `already_done`. That was the
   * wrong assertion to make and it is recorded here rather than deleted.
   *
   * The property that actually matters is the one Pass 2 asks for — exactly one
   * effect — plus the narrower rule that no answer may read as "submit it
   * again". `approval.already_used` satisfies both: it is terminal, it names
   * the approval as spent, and a client that retries anyway gets `already_done`
   * from the parked action's own status. So the concurrent-loser answer is
   * inconsistent with the sequential-replay answer, and that is a wart, not a
   * defect.
   */
  it("performs the effect once and never invites the loser to resubmit", async () => {
    const harness = await buildReviewHarness({ tools: TOOLS, connectors: CONNECTORS });
    const parked = await parkAndApprove(harness, WRITE);
    const commit = { ...WRITE, parkedActionId: parked.parkedActionId };

    const outcomes = await Promise.all([
      harness.execution.execute(commit).catch((error: Error) => error),
      harness.execution.execute(commit).catch((error: Error) => error),
    ]);

    // Exactly one effect. This part the design gets right.
    expect(harness.log.calls).toHaveLength(1);

    const completed = outcomes.filter(
      (outcome) => !(outcome instanceof Error) && outcome.kind === "completed",
    );
    expect(completed).toHaveLength(1);

    const loser = outcomes.find(
      (outcome) => outcome instanceof Error || outcome.kind !== "completed",
    );
    if (loser instanceof Error) {
      expect(loser).toMatchObject({ reason: "approval.already_used" });
      expect(loser.message).not.toMatch(/submit|resubmit|try again|expired/i);
    } else {
      expect(loser?.kind).toBe("already_done");
    }

    // And a client that retries after the race hears the settled answer.
    const retry = await harness.execution.execute(commit);
    expect(retry.kind).toBe("already_done");
    expect(harness.log.calls).toHaveLength(1);
  });
});
