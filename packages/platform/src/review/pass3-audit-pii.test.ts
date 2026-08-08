import { describe, it, expect } from "vitest";
import { buildReviewHarness, REVIEW_AGENT } from "./harness.js";

/**
 * Pass 3 — what actually reaches the audit chain on a path that handles owner
 * data.
 *
 * The chain should carry identifiers and digests, not personal data. Three
 * authorities say so, in the project's own words:
 *
 *   `docs/architecture.md` §4.2  "Entries record digests of inputs, opaque
 *                                subject references, and a structured
 *                                decision. `AuditLog.record` refuses anything
 *                                that looks like a payload."
 *   `docs/assurance/data-inventory.md` §5.3
 *                                "Subject references are opaque ids, capped in
 *                                length."
 *   `docs/assurance/retention-and-deletion.md` §4
 *                                "the audit chain does not need to be modified
 *                                to honour a deletion request, because it holds
 *                                digests and opaque references, not owner
 *                                data."
 *
 * `AuditLog.assertNoRawPayloads` enforces a length cap and a secret detector on
 * subject values. It does not enforce opacity, and the caller filling the
 * subject on the external plane is a third party.
 *
 * This is the highest-consequence shape of the defect: the audit chain is
 * append-only by construction and survives a subject-rights deletion by design,
 * so anything personal that lands here cannot be taken out again.
 */

describe("subject references arriving from an external agent", () => {
  it("does not carry an owner's contact details into the hash chain", async () => {
    const harness = await buildReviewHarness({
      tools: [{ tool: "crm.lookup_owner", operatorRisk: "routine" }],
      connectors: [
        { integration: "crm", operations: [{ operation: "lookup_owner", mode: "read" }] },
      ],
    });

    // The subject map is bounded — sixteen keys, 256 characters each — and
    // screened for credentials. Nothing checks that a value is a reference
    // rather than content, and this is a body a vendor's agent composes.
    const decision = await harness.admission.admit({
      agentId: REVIEW_AGENT,
      operation: "screen",
      tool: "crm.lookup_owner",
      declaredRisk: "routine",
      subject: {
        contractId: "ctr_0001",
        ownerName: "Jane Q. Doe",
        ownerEmail: "jane.doe@example.com",
        ownerPhone: "+1-555-0142",
      },
    });
    expect(decision.outcome).toBe("allowed");

    const chain = await harness.audit.readChain();
    const serialised = JSON.stringify(chain);

    expect(serialised, "an owner's email address is in the audit chain").not.toContain(
      "jane.doe@example.com",
    );
    expect(serialised, "an owner's name is in the audit chain").not.toContain("Jane Q. Doe");
    expect(serialised, "an owner's telephone number is in the audit chain").not.toContain(
      "+1-555-0142",
    );
  });

  it("does not carry them in on a refusal either", async () => {
    // The denial path builds its own subject map from the same untrusted input
    // (external/admission.ts:490), so a refused request writes the same content
    // into the chain — and a refused request is the one an attacker can always
    // make, because it needs no valid tool grant.
    const harness = await buildReviewHarness({
      tools: [{ tool: "crm.lookup_owner", operatorRisk: "routine" }],
      connectors: [
        { integration: "crm", operations: [{ operation: "lookup_owner", mode: "read" }] },
      ],
    });

    const decision = await harness.admission.admit({
      agentId: REVIEW_AGENT,
      operation: "screen",
      tool: "crm.not_granted",
      declaredRisk: "routine",
      subject: { ownerEmail: "jane.doe@example.com" },
    });
    expect(decision.outcome).toBe("denied");

    const chain = await harness.audit.readChain();
    expect(
      JSON.stringify(chain),
      "a refused request wrote an owner's email address into the chain",
    ).not.toContain("jane.doe@example.com");
  });
});
