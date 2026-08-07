import { describe, it, expect, beforeEach } from "vitest";
import { FixedClock, MINUTE } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { digestValue } from "../kernel/hash.js";
import { MemoryDb } from "../store/db.js";
import { MemoryRunStore } from "../record/store.memory.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { AuditLog } from "../audit/log.js";
import type { ActorRef } from "../record/types.js";
import { MemoryApprovalStore, MemoryContainmentStore } from "../guard/store.memory.js";
import { ActionRegistry } from "../guard/registry.js";
import { ApprovalService } from "../guard/approvals.js";
import { CeilingEnforcer } from "../guard/ceilings.js";
import { ContainmentController } from "../guard/containment.js";
import { Authorizer } from "../guard/authorize.js";

/**
 * Pass 2 — the chokepoint's own rule about spending a human's decision.
 *
 * `guard/authorize.ts` states it in its header: "Approval is last because
 * consuming an approval is destructive: approvals are single-use, so spending
 * one and then failing a cheaper check would burn a human's decision and force
 * them to approve again. Everything that can refuse for free refuses before
 * anything is spent."
 *
 * `guard.test.ts` proves that rule for containment ("does not consume an
 * approval when a cheaper check fails first"). It does not prove it for the
 * one check that runs *after* the consumption — the defence-in-depth assertion
 * that the approval was raised for this action. That test asserts the refusal
 * and stops there, which is exactly the case this file picks up.
 */

const START = "2026-08-06T12:00:00.000Z";

function actor(actorId: string, roles: string[], kind: ActorRef["kind"] = "human"): ActorRef {
  return { actorId, kind, roles };
}

function build() {
  const clock = new FixedClock(START);
  const ids = new SeededIdGenerator("review-burn");
  const db = new MemoryDb();
  const runs = new MemoryRunStore(db, clock, ids);
  const audit = new AuditLog(new MemoryAuditStore(db), clock, ids);
  const approvals = new ApprovalService(new MemoryApprovalStore(db), clock, ids, audit);
  const containment = new ContainmentController(new MemoryContainmentStore(db), clock, audit, 0);
  const ceilings = new CeilingEnforcer(
    { runSpendUsd: 1, dailySpendUsd: 10, runWallClockMs: 10 * MINUTE, modelCallsPerMinute: 5 },
    clock,
    runs,
  );

  const registry = new ActionRegistry([
    {
      name: "contact.send_letter",
      risk: "high_consequence",
      description: "Send a letter to an owner.",
      reversible: false,
      allowedRoles: ["supervisor"],
      approvalsRequired: 1,
      integration: "messaging",
    },
    {
      name: "contact.send_email",
      risk: "high_consequence",
      description: "Send an email to an owner.",
      reversible: false,
      allowedRoles: ["supervisor"],
      approvalsRequired: 1,
      integration: "messaging",
    },
  ]);

  const authorizer = new Authorizer(registry, containment, ceilings, approvals, audit, clock, 300);
  return { clock, approvals, authorizer };
}

describe("redeeming an approval against the wrong action", () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  it("leaves the approval spendable on the action it was actually raised for", async () => {
    // The proposal digest is not a secret: it is on the approval record the
    // console renders, and in the `inputDigests.proposal` field of the audit
    // entry for every request, grant and consumption. Anyone who can see the
    // queue can therefore present a granted approval against a *different*
    // registered action carrying the same digest.
    const proposalDigest = digestValue({ owner: "ctr_demo", body: "your rescission window" });

    const request = await h.approvals.request({
      action: "contact.send_letter",
      proposalDigest,
      summary: "Send the rescission letter",
      requestedBy: actor("agent-1", ["owner_services_agent"]),
      approvalsRequired: 1,
      eligibleRoles: ["supervisor"],
    });
    await h.approvals.decide({
      approvalId: request.id,
      actor: actor("sup-2", ["supervisor"]),
      decision: "granted",
      requiresStepUp: false,
    });

    // Present it against a different action. This must be refused — and it is.
    await expect(
      h.authorizer.authorize({
        action: "contact.send_email",
        actor: actor("sup-3", ["supervisor"]),
        mode: "supervised",
        proposalDigest,
        approvalId: request.id,
        secondsSinceAuthentication: 10,
      }),
    ).rejects.toMatchObject({ reason: "approval.digest_mismatch" });

    // The refusal must not have cost the supervisor their decision.
    const after = await h.approvals.get(request.id);
    expect(after?.status).toBe("granted");
    expect(after?.consumedAt).toBeUndefined();

    // And the letter it was granted for must still be sendable.
    await expect(
      h.authorizer.authorize({
        action: "contact.send_letter",
        actor: actor("sup-3", ["supervisor"]),
        mode: "supervised",
        proposalDigest,
        approvalId: request.id,
        secondsSinceAuthentication: 10,
      }),
    ).resolves.toMatchObject({ action: "contact.send_letter" });
  });
});
