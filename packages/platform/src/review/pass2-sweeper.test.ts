import { describe, it, expect } from "vitest";
import { HOUR } from "../kernel/clock.js";
import { buildReviewHarness, deferred, parkAndApprove, REVIEW_AGENT } from "./harness.js";

/**
 * Pass 2 — the stale-commit sweeper.
 *
 * `ExecutionService.sweepStaleCommits` exists to find commits abandoned by a
 * worker that died mid-effect and mark them indeterminate so a human looks.
 * The question this file asks is what it measures staleness *from*. A sweeper
 * that measures the wrong interval is worse than none: it converts healthy
 * in-flight work into "this may have taken effect, go and check", which is the
 * one message the design says must never be sent falsely.
 */

const WRITE = {
  agentId: REVIEW_AGENT,
  integration: "crm",
  operation: "update_contact",
  mode: "write" as const,
  request: { contactId: "ctr_0001", field: "mailing_preference", value: "post" },
};

async function harnessWithWrite(gate?: () => Promise<void>) {
  return buildReviewHarness({
    tools: [{ tool: "crm.update_contact", operatorRisk: "high_consequence" }],
    connectors: [
      { integration: "crm", operations: [{ operation: "update_contact", mode: "write", gate }] },
    ],
  });
}

describe("the stale-commit sweeper", () => {
  it("leaves a commit alone that only just went in flight", async () => {
    const harness = await harnessWithWrite();
    const parked = await parkAndApprove(harness, WRITE);

    // An approval waiting in a human queue for an hour is the normal case, not
    // an exceptional one.
    harness.clock.advance(HOUR);

    // A worker picks it up now: the commit has been in flight for one second.
    await harness.parked.transitionParkedAction({
      id: parked.parkedActionId,
      expectedStatus: "pending",
      status: "committing",
      at: harness.clock.nowIso(),
    });
    harness.clock.advance(1000);

    const swept = await harness.execution.sweepStaleCommits();

    // The default staleness window is five minutes. One second is not stale.
    expect(swept).toHaveLength(0);
    const stored = await harness.parked.getParkedAction(parked.parkedActionId);
    expect(stored?.status).toBe("committing");
  });

  it("does not tell an agent an action completed while the record says indeterminate", async () => {
    // The consequence of measuring staleness from the wrong timestamp: the
    // sweeper reaches a live commit, terminalises it, and the commit's own
    // conditional write back then matches nothing — so the agent is told
    // "completed" and the operating record says "a worker stopped while this
    // was in flight". Two contradictory statements about one action, and the
    // audit trail carries the wrong one.
    const gate = deferred();
    const harness = await harnessWithWrite(() => gate.promise);
    const parked = await parkAndApprove(harness, WRITE);

    harness.clock.advance(HOUR);

    const inFlight = harness.execution.execute({
      ...WRITE,
      parkedActionId: parked.parkedActionId,
    });
    // Let the commit reach the outbound call and block there.
    for (let tick = 0; tick < 200 && harness.log.calls.length === 0; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(harness.log.calls).toHaveLength(1);

    const swept = await harness.execution.sweepStaleCommits();
    expect(swept).toHaveLength(0);

    gate.release();
    const outcome = await inFlight;
    expect(outcome.kind).toBe("completed");

    const stored = await harness.parked.getParkedAction(parked.parkedActionId);
    expect(stored?.status).toBe("committed");
  });

  it("still sweeps a commit a dead worker really did abandon", async () => {
    // The behaviour that must survive any fix.
    const harness = await harnessWithWrite();
    const parked = await parkAndApprove(harness, WRITE);

    await harness.parked.transitionParkedAction({
      id: parked.parkedActionId,
      expectedStatus: "pending",
      status: "committing",
      at: harness.clock.nowIso(),
    });
    harness.clock.advance(HOUR);

    const swept = await harness.execution.sweepStaleCommits();
    expect(swept).toHaveLength(1);
    expect(swept[0]?.status).toBe("indeterminate");
  });
});
