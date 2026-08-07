import { describe, it, expect } from "vitest";
import { buildReviewHarness, parkAndApprove, REVIEW_AGENT } from "./harness.js";

/**
 * Pass 2 — approval binding, commit-time refusals, and what the record says.
 *
 * Every case here is a commit that the platform must either perform or refuse
 * cleanly. The class of defect being hunted is a refusal that is reported as
 * an ambiguous outcome: `indeterminate` tells an operator "this may already
 * have taken effect, go and check the system of record", and saying that about
 * something the platform never attempted is the governance product lying about
 * its own record.
 */

describe("committing an approved read", () => {
  it("performs the read it was approved for, rather than refusing itself", async () => {
    // A read the operator rated high enough to need approval takes the
    // two-phase path (external/execute.ts:137-141), and `external/execute.test.ts`
    // asserts it parks. Nothing asserts it can then be committed.
    const harness = await buildReviewHarness({
      tools: [{ tool: "crm.export_all_contacts", operatorRisk: "high_consequence" }],
      connectors: [
        { integration: "crm", operations: [{ operation: "export_all_contacts", mode: "read" }] },
      ],
    });

    const read = {
      agentId: REVIEW_AGENT,
      integration: "crm",
      operation: "export_all_contacts",
      mode: "read" as const,
      request: { since: "2026-01-01" },
    };

    const parked = await parkAndApprove(harness, read);
    const outcome = await harness.execution.execute({
      ...read,
      parkedActionId: parked.parkedActionId,
    });

    expect(outcome.kind).toBe("completed");
    expect(harness.log.calls).toHaveLength(1);
  });

  it("does not report a refusal it never attempted as an indeterminate effect", async () => {
    // The narrower, more serious half of the same defect. Whatever the right
    // answer is for an approved read, "the action was started and its outcome
    // was not recorded" must not be it — nothing was started.
    const harness = await buildReviewHarness({
      tools: [{ tool: "crm.export_all_contacts", operatorRisk: "high_consequence" }],
      connectors: [
        { integration: "crm", operations: [{ operation: "export_all_contacts", mode: "read" }] },
      ],
    });

    const read = {
      agentId: REVIEW_AGENT,
      integration: "crm",
      operation: "export_all_contacts",
      mode: "read" as const,
      request: { since: "2026-01-01" },
    };

    const parked = await parkAndApprove(harness, read);
    const outcome = await harness.execution.execute({
      ...read,
      parkedActionId: parked.parkedActionId,
    });

    expect(outcome.kind).not.toBe("indeterminate");
    const stored = await harness.parked.getParkedAction(parked.parkedActionId);
    expect(stored?.status).not.toBe("indeterminate");
  });
});

describe("committing a write the connector does not expose", () => {
  it("refuses without claiming the effect may have landed", async () => {
    // Tool grants are free text — `enrollment.ts` never checks a granted tool
    // against the connector registry — so an operator's typo produces an agent
    // whose write parks, is approved by a human, and is then refused by the
    // router. The router refuses *before* calling the operation, so nothing
    // was attempted and nothing is ambiguous.
    const harness = await buildReviewHarness({
      tools: [{ tool: "crm.update_contactt", operatorRisk: "high_consequence" }],
      connectors: [
        { integration: "crm", operations: [{ operation: "update_contact", mode: "write" }] },
      ],
    });

    const write = {
      agentId: REVIEW_AGENT,
      integration: "crm",
      operation: "update_contactt",
      mode: "write" as const,
      request: { contactId: "ctr_0001", value: "post" },
    };

    const parked = await parkAndApprove(harness, write);
    const outcome = await harness.execution.execute({
      ...write,
      parkedActionId: parked.parkedActionId,
    }).catch((error: Error) => error);

    // Either a clean refusal or a clean completion. Not "go and check whether
    // this happened" about a call that was never made.
    if (!(outcome instanceof Error)) {
      expect(outcome.kind).not.toBe("indeterminate");
    }
    expect(harness.log.calls).toHaveLength(0);
    const stored = await harness.parked.getParkedAction(parked.parkedActionId);
    expect(stored?.status).not.toBe("indeterminate");
  });
});
