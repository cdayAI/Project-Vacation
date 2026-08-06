import { describe, it, expect } from "vitest";
import { AuditLog } from "../audit/log.js";
import type { AuditStore, ChainPosition } from "../audit/port.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import type {
  AuditEntry,
  AuditEventType,
  AuditFilter,
  NewAuditEntry,
} from "../audit/types.js";
import { ApprovalService } from "../guard/approvals.js";
import { Authorizer } from "../guard/authorize.js";
import { CeilingEnforcer } from "../guard/ceilings.js";
import { ContainmentController } from "../guard/containment.js";
import { ActionRegistry } from "../guard/registry.js";
import { MemoryApprovalStore, MemoryContainmentStore } from "../guard/store.memory.js";
import { FixedClock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import { SeededIdGenerator, type Id } from "../kernel/ids.js";
import { MemoryRunStore } from "../record/store.memory.js";
import type { ActorRef } from "../record/types.js";
import { MemoryDb } from "../store/db.js";
import { PLATFORM_ACTIONS } from "../actions.js";
import { CONTACT_ACTIONS, SEND_HIGH_RISK_MESSAGE_ACTION, SEND_MESSAGE_ACTION } from "./actions.js";
import { ConsentLedger, deriveConsentState } from "./consent.js";
import { ContactGate, destinationFingerprint } from "./gate.js";
import { CONTACT_POLICY, validateContactPolicy } from "./policy.js";
import type { ConsentEventFilter, ContactStore } from "./port.js";
import { MemoryContactStore } from "./store.memory.js";
import { ALL_CHANNELS, ALL_PURPOSES } from "./types.js";
import type {
  ConsentEvent,
  ContactPolicy,
  OutboundMessage,
  OutboundRequest,
} from "./types.js";

/**
 * The contact gate's behaviour, and its refusals.
 *
 * Every control is tested twice: once proving it lets the legitimate case
 * through, once proving it refuses. A control tested only on the happy path is
 * a control nobody has confirmed is connected to anything.
 *
 * The refusal tests here are the point of the module. This is the surface where
 * a mistake is a statutory-damages claim per message, so the interesting cases
 * are the adversarial ones: a grant back-dated past a revocation, a quiet-hours
 * check that would pass if the server's clock were used, a frequency cap evaded
 * by waiting for midnight, a retry that becomes a second letter.
 */

const NOW = "2026-08-06T16:00:00.000Z";

/** Requests approvals; may not send. */
const AGENT: ActorRef = {
  actorId: "act_agent",
  kind: "human",
  roles: ["owner_services_agent"],
};

/** Holds the role the standard outbound action permits. */
const SUPERVISOR: ActorRef = { actorId: "act_supervisor", kind: "human", roles: ["supervisor"] };

/** A second supervisor, for the elevated path's two distinct approvers. */
const SUPERVISOR_TWO: ActorRef = {
  actorId: "act_supervisor_two",
  kind: "human",
  roles: ["supervisor"],
};

const COMPLIANCE: ActorRef = {
  actorId: "act_compliance",
  kind: "human",
  roles: ["compliance_reviewer"],
};

/**
 * A policy written for the tests rather than the shipped one.
 *
 * Behaviour is asserted against values this file controls, so that the day MVW
 * compliance changes a quiet-hour window or a cap the suite reports a policy
 * change rather than a broken gate. The shipped artifact is checked separately,
 * for well-formedness, further down.
 */
const TEST_POLICY: ContactPolicy = {
  version: "test-policy-v1",
  owner: "test",
  quietHours: [
    {
      jurisdiction: "US",
      channels: ["voice", "sms"],
      localStart: "21:00",
      localEnd: "08:00",
      citation: "47 C.F.R. § 64.1200(c)(1)",
      verified: true,
    },
    {
      jurisdiction: "FL",
      channels: ["voice", "sms"],
      localStart: "20:00",
      localEnd: "08:00",
      citation: "Fla. Stat. § 501.059",
      verified: true,
    },
  ],
  frequencyCaps: [
    {
      jurisdiction: "US",
      channel: "sms",
      purpose: ALL_PURPOSES,
      maxMessages: 2,
      windowHours: 24,
      citation: "test",
      verified: true,
    },
    {
      jurisdiction: "US",
      channel: "voice",
      purpose: ALL_PURPOSES,
      maxMessages: 3,
      windowHours: 24,
      citation: "test",
      verified: true,
    },
    {
      jurisdiction: "US",
      channel: "email",
      purpose: ALL_PURPOSES,
      maxMessages: 10,
      windowHours: 24,
      citation: "test",
      verified: true,
    },
    {
      jurisdiction: "US",
      channel: "postal",
      purpose: ALL_PURPOSES,
      maxMessages: 4,
      windowHours: 720,
      citation: "test",
      verified: true,
    },
  ],
  quietHoursExemptChannels: ["postal", "email"],
  elevatedPurposes: ["collections", "marketing"],
  elevatedChannels: ["voice"],
  collectionsThirdPartyPermitted: false,
};

const TEST_ACTIONS = [
  ...PLATFORM_ACTIONS,
  ...CONTACT_ACTIONS.filter(
    (action) => !PLATFORM_ACTIONS.some((existing) => existing.name === action.name),
  ),
];

const EVIDENCE_DIGEST = digestValue({ artifact: "signed-consent-form" });

/**
 * An audit store that fails a fixed number of times for one event type.
 *
 * Needed because the interesting failure is narrow: authorization must succeed
 * so the send gets as far as being stored, and only then must the gate receipt
 * fail. A store that failed everything would prove that authorization fails
 * closed, which is another module's test.
 */
class FlakyAuditStore implements AuditStore {
  private remaining: number;

  constructor(
    private readonly inner: AuditStore,
    private readonly failFor: AuditEventType,
    failures: number,
  ) {
    this.remaining = failures;
  }

  async appendEntry(
    content: NewAuditEntry,
    build: (content: NewAuditEntry, position: ChainPosition) => AuditEntry,
  ): Promise<AuditEntry> {
    if (content.eventType === this.failFor && this.remaining > 0) {
      this.remaining -= 1;
      throw new Error("audit sink unreachable");
    }
    return this.inner.appendEntry(content, build);
  }

  listAuditEntries(filter?: AuditFilter): Promise<readonly AuditEntry[]> {
    return this.inner.listAuditEntries(filter);
  }
  countAuditEntries(filter?: AuditFilter): Promise<number> {
    return this.inner.countAuditEntries(filter);
  }
  readAuditChain(fromSeq?: number, toSeq?: number): Promise<readonly AuditEntry[]> {
    return this.inner.readAuditChain(fromSeq, toSeq);
  }
  auditHead(): Promise<AuditEntry | null> {
    return this.inner.auditHead();
  }
}

interface Harness {
  readonly clock: FixedClock;
  readonly db: MemoryDb;
  readonly store: ContactStore;
  readonly ledger: ConsentLedger;
  readonly gate: ContactGate;
  readonly approvals: ApprovalService;
  readonly audit: AuditLog;
  readonly auditStore: MemoryAuditStore;
  readonly ids: SeededIdGenerator;
}

function harness(
  options: {
    store?: (inner: ContactStore) => ContactStore;
    /** Number of times the gate receipt should fail before it succeeds. */
    receiptFailures?: number;
  } = {},
): Harness {
  const clock = new FixedClock(NOW);
  const ids = new SeededIdGenerator("contact-test");
  const db = new MemoryDb();

  const auditStore = new MemoryAuditStore(db);
  const audit = new AuditLog(
    options.receiptFailures
      ? new FlakyAuditStore(auditStore, "contact.gate_passed", options.receiptFailures)
      : auditStore,
    clock,
    ids,
  );
  const runs = new MemoryRunStore(db, clock, ids);

  const registry = new ActionRegistry(TEST_ACTIONS);
  const containment = new ContainmentController(new MemoryContainmentStore(db), clock, audit);
  const ceilings = new CeilingEnforcer(
    {
      runSpendUsd: 100,
      dailySpendUsd: 1000,
      runWallClockMs: 60_000,
      modelCallsPerMinute: 100,
    },
    clock,
    runs,
  );
  const approvals = new ApprovalService(new MemoryApprovalStore(db), clock, ids, audit);
  const authorizer = new Authorizer(registry, containment, ceilings, approvals, audit, clock, 300);

  const inner = new MemoryContactStore(db);
  const store = options.store ? options.store(inner) : inner;

  return {
    clock,
    db,
    store,
    ledger: new ConsentLedger(store, authorizer, audit, clock, ids),
    gate: new ContactGate(store, authorizer, audit, clock, ids, { policy: TEST_POLICY }),
    approvals,
    audit,
    auditStore,
    ids,
  };
}

const DESTINATION = destinationFingerprint("sms", "+1 (407) 555-0134");

function sendRequest(overrides: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    subjectRef: "ctr_owner_1",
    channel: "sms",
    purpose: "servicing",
    relationship: "owner",
    destinationDigest: DESTINATION,
    contentDigest: digestValue({ body: "Your maintenance fee statement is ready." }),
    jurisdiction: "US",
    recipientTimeZone: "America/New_York",
    actor: SUPERVISOR,
    mode: "supervised",
    idempotencyKey: "idem-1",
    secondsSinceAuthentication: 10,
    ...overrides,
  };
}

/** Grant consent for one channel and purpose, through the governed path. */
async function grant(
  h: Harness,
  input: { channel?: OutboundRequest["channel"]; purpose?: OutboundRequest["purpose"] } = {},
): Promise<ConsentEvent> {
  return h.ledger.record({
    subjectRef: "ctr_owner_1",
    channel: input.channel ?? "sms",
    purpose: input.purpose ?? "servicing",
    kind: "granted",
    effectiveAt: h.clock.nowIso(),
    provenance: {
      source: "signed_document",
      capturedBy: AGENT.actorId,
      evidenceDigest: EVIDENCE_DIGEST,
    },
    actor: AGENT,
    mode: "supervised",
  });
}

/** Raise and grant an approval bound to exactly this send. */
async function approveSend(
  h: Harness,
  request: OutboundRequest,
  approvers: readonly ActorRef[] = [SUPERVISOR],
): Promise<Id<"approval">> {
  const band = h.gate.riskBand(request);
  const approval = await h.approvals.request({
    action: band === "elevated" ? SEND_HIGH_RISK_MESSAGE_ACTION : SEND_MESSAGE_ACTION,
    proposalDigest: h.gate.proposalDigest(request),
    summary: `Send a ${request.channel} message to ${request.subjectRef}`,
    requestedBy: AGENT,
    approvalsRequired: approvers.length,
    eligibleRoles: ["supervisor", "compliance_reviewer"],
  });
  for (const approver of approvers) {
    await h.approvals.decide({
      approvalId: approval.id,
      actor: approver,
      decision: "granted",
      secondsSinceAuthentication: 10,
      stepUpMaxAgeSeconds: 300,
    });
  }
  return approval.id;
}

function entriesOfType(store: MemoryAuditStore, type: string): Promise<readonly AuditEntry[]> {
  return store.listAuditEntries({ eventType: [type as AuditEntry["eventType"]] });
}

// ---------------------------------------------------------------------------
// The consent ledger
// ---------------------------------------------------------------------------

describe("consent ledger", () => {
  it("records a grant with its provenance and attaches an audit receipt", async () => {
    const h = harness();
    const event = await grant(h);

    expect(event.kind).toBe("granted");
    expect(event.provenance.source).toBe("signed_document");
    expect(event.receiptId).toBeDefined();
    // Both clocks are kept: when the owner acted, and when we learned of it.
    expect(event.effectiveAt).toBe(NOW);
    expect(event.recordedAt).toBe(NOW);

    const recorded = await entriesOfType(h.auditStore, "consent.recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.inputDigests["evidence"]).toBe(EVIDENCE_DIGEST);
  });

  it("refuses a blanket grant but accepts a blanket revocation", async () => {
    const h = harness();

    await expect(
      h.ledger.record({
        subjectRef: "ctr_owner_1",
        channel: ALL_CHANNELS,
        purpose: "servicing",
        kind: "granted",
        effectiveAt: NOW,
        provenance: {
          source: "web_form",
          capturedBy: AGENT.actorId,
          evidenceDigest: EVIDENCE_DIGEST,
        },
        actor: AGENT,
        mode: "supervised",
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    const revocation = await h.ledger.record({
      subjectRef: "ctr_owner_1",
      channel: ALL_CHANNELS,
      purpose: ALL_PURPOSES,
      kind: "revoked",
      effectiveAt: NOW,
      provenance: {
        source: "inbound_call",
        capturedBy: AGENT.actorId,
        evidenceDigest: EVIDENCE_DIGEST,
      },
      actor: AGENT,
      mode: "supervised",
    });
    expect(revocation.kind).toBe("revoked");

    // A blanket revocation covers a channel and purpose it never named.
    const state = await h.ledger.stateFor({
      subjectRef: "ctr_owner_1",
      channel: "email",
      purpose: "marketing",
      asOf: NOW,
    });
    expect(state.status).toBe("revoked");
  });

  it("refuses a consent event that has not happened yet", async () => {
    const h = harness();
    await expect(
      h.ledger.record({
        subjectRef: "ctr_owner_1",
        channel: "sms",
        purpose: "marketing",
        kind: "granted",
        effectiveAt: "2027-01-01T00:00:00.000Z",
        provenance: {
          source: "web_form",
          capturedBy: AGENT.actorId,
          evidenceDigest: EVIDENCE_DIGEST,
        },
        actor: AGENT,
        mode: "supervised",
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("refuses to record consent through an actor without the role", async () => {
    const h = harness();
    const outsider: ActorRef = { actorId: "act_outsider", kind: "human", roles: ["finance"] };
    await expect(
      h.ledger.record({
        subjectRef: "ctr_owner_1",
        channel: "sms",
        purpose: "servicing",
        kind: "granted",
        effectiveAt: NOW,
        provenance: {
          source: "web_form",
          capturedBy: outsider.actorId,
          evidenceDigest: EVIDENCE_DIGEST,
        },
        actor: outsider,
        mode: "supervised",
      }),
    ).rejects.toMatchObject({ reason: "authorization.action_not_permitted" });
  });
});

describe("derived consent state", () => {
  const base = {
    subjectRef: "ctr_owner_1",
    channel: "sms",
    purpose: "servicing",
    provenance: {
      source: "web_form" as const,
      capturedBy: "act_agent",
      evidenceDigest: EVIDENCE_DIGEST,
    },
  };

  const event = (
    id: string,
    kind: ConsentEvent["kind"],
    effectiveAt: string,
    recordedAt: string,
  ): ConsentEvent =>
    ({
      ...base,
      id: id as Id<"consent">,
      kind,
      effectiveAt,
      recordedAt,
      receiptId: "aud_x" as Id<"auditEntry">,
    }) as ConsentEvent;

  const query = {
    subjectRef: "ctr_owner_1",
    channel: "sms" as const,
    purpose: "servicing" as const,
    asOf: "2026-08-06T23:00:00.000Z",
  };

  it("grants when only a grant is on record", () => {
    const state = deriveConsentState(
      [event("cns_1", "granted", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z")],
      query,
    );
    expect(state.status).toBe("granted");
  });

  it("revocation beats a grant back-dated after it was recorded", () => {
    // The stale-read shape: consent captured from a snapshot taken before the
    // opt-out landed, written afterwards and claiming an earlier moment.
    const state = deriveConsentState(
      [
        event("cns_1", "granted", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
        event("cns_2", "revoked", "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
        event("cns_3", "granted", "2026-08-02T00:00:00.000Z", "2026-08-05T00:00:00.000Z"),
      ],
      query,
    );
    expect(state.status).toBe("revoked");
    expect(state.decidedBy).toBe("cns_2");
  });

  it("revocation beats a grant already on file that claims to take effect later", () => {
    // The other stale-read shape: ordering by effectiveAt alone would let this
    // win, because it claims a later moment than the revocation while having
    // been recorded before anyone knew about the opt-out.
    const state = deriveConsentState(
      [
        event("cns_1", "granted", "2026-08-04T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
        event("cns_2", "revoked", "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
      ],
      query,
    );
    expect(state.status).toBe("revoked");
  });

  it("revocation wins a tie at the same instant", () => {
    const state = deriveConsentState(
      [
        event("cns_1", "granted", "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
        event("cns_2", "revoked", "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
      ],
      query,
    );
    expect(state.status).toBe("revoked");
  });

  it("a genuine re-consent, later on both clocks, restores consent", () => {
    const state = deriveConsentState(
      [
        event("cns_1", "granted", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
        event("cns_2", "revoked", "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
        event("cns_3", "granted", "2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z"),
      ],
      query,
    );
    expect(state.status).toBe("granted");
    expect(state.decidedBy).toBe("cns_3");
  });

  it("answers historically: an event that had not taken effect yet did not govern", () => {
    const events = [
      event("cns_1", "granted", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
      event("cns_2", "revoked", "2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z"),
    ];
    expect(deriveConsentState(events, { ...query, asOf: "2026-08-03T00:00:00.000Z" }).status).toBe(
      "granted",
    );
    expect(deriveConsentState(events, { ...query, asOf: "2026-08-06T00:00:00.000Z" }).status).toBe(
      "revoked",
    );
  });
});

// ---------------------------------------------------------------------------
// The gate: the legitimate case
// ---------------------------------------------------------------------------

describe("contact gate", () => {
  it("clears a consented, in-hours, under-cap message and records the evidence", async () => {
    const h = harness();
    await grant(h);

    const request = sendRequest();
    const approvalId = await approveSend(h, request);
    const clearance = await h.gate.clear({ ...request, approvalId });

    expect(clearance.replayed).toBe(false);
    expect(clearance.message.status).toBe("cleared");
    expect(clearance.evidence.allowed).toBe(true);
    // 16:00Z is 12:00 in New York: outside the 21:00–08:00 window.
    expect(clearance.evidence.recipientLocalTime).toBe("2026-08-06T12:00:00");
    expect(clearance.evidence.policyVersion).toBe("test-policy-v1");

    const names = clearance.evidence.checks.map((check) => check.name);
    expect(names).toEqual([
      "consent",
      "revocation",
      "do_not_call",
      "quiet_hours",
      "frequency_cap",
    ]);
    expect(clearance.evidence.checks.every((check) => check.outcome === "pass")).toBe(true);

    const passed = await entriesOfType(h.auditStore, "contact.gate_passed");
    expect(passed).toHaveLength(1);
    // The audit entry carries the fingerprint of the evidence, not the evidence.
    expect(passed[0]?.inputDigests["evidence"]).toBe(clearance.message.evidenceDigest);
    expect(passed[0]?.decision["riskBand"]).toBe("standard");
    expect(clearance.message.receiptId).toBe(passed[0]?.id);
  });

  it("refuses without consent and records the block with its evidence", async () => {
    const h = harness();
    const request = sendRequest();
    const approvalId = await approveSend(h, request);

    await expect(h.gate.clear({ ...request, approvalId })).rejects.toMatchObject({
      reason: "contact.no_consent",
    });

    const blocked = await h.gate.history("ctr_owner_1");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.status).toBe("blocked");
    expect(blocked[0]?.denialReason).toBe("contact.no_consent");
    expect(blocked[0]?.evidence.checks[0]?.name).toBe("consent");

    const entries = await entriesOfType(h.auditStore, "contact.gate_blocked");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.inputDigests["evidence"]).toBe(blocked[0]?.evidenceDigest);
    expect(entries[0]?.decision["reason"]).toBe("contact.no_consent");
  });

  it("refuses when consent was granted for a different purpose", async () => {
    const h = harness();
    await grant(h, { purpose: "servicing" });

    const request = sendRequest({ purpose: "survey", idempotencyKey: "idem-purpose" });
    const approvalId = await approveSend(h, request);
    await expect(h.gate.clear({ ...request, approvalId })).rejects.toMatchObject({
      reason: "contact.no_consent",
    });
  });

  it("refuses after a revocation, even though consent is still in the ledger", async () => {
    const h = harness();
    await grant(h);
    h.clock.advance(60_000);
    await h.ledger.record({
      subjectRef: "ctr_owner_1",
      channel: ALL_CHANNELS,
      purpose: ALL_PURPOSES,
      kind: "revoked",
      effectiveAt: h.clock.nowIso(),
      provenance: {
        source: "inbound_call",
        capturedBy: AGENT.actorId,
        evidenceDigest: EVIDENCE_DIGEST,
      },
      actor: AGENT,
      mode: "supervised",
    });

    const request = sendRequest({ idempotencyKey: "idem-revoked" });
    const approvalId = await approveSend(h, request);
    await expect(h.gate.clear({ ...request, approvalId })).rejects.toMatchObject({
      reason: "contact.revoked",
    });

    const evidence = await h.gate.evaluate(request);
    // The consent check still passes — a grant genuinely is on file. The
    // revocation check is what refuses, which is the distinction a reviewer
    // needs to see.
    expect(evidence.checks.find((check) => check.name === "consent")?.outcome).toBe("pass");
    expect(evidence.checks.find((check) => check.name === "revocation")?.outcome).toBe("block");
  });

  it("refuses a message against a do-not-call entry, matched by destination", async () => {
    const h = harness();
    await grant(h);
    await h.ledger.suppress({
      list: "internal",
      // No subject reference: this entry matches on the destination alone, the
      // way a register download does.
      subjectRef: "",
      destinationDigest: DESTINATION,
      channels: [],
      jurisdiction: "US",
      registeredAt: NOW,
      expiresAt: null,
      source: "owner asked an agent to stop",
      actor: AGENT,
      mode: "supervised",
    });

    const request = sendRequest({ idempotencyKey: "idem-dnc" });
    const approvalId = await approveSend(h, request);
    await expect(h.gate.clear({ ...request, approvalId })).rejects.toMatchObject({
      reason: "contact.do_not_call",
    });
  });

  it("refuses a collections message addressed to a third party", async () => {
    const h = harness();
    await grant(h, { purpose: "collections" });

    const request = sendRequest({
      purpose: "collections",
      relationship: "third_party",
      idempotencyKey: "idem-fdcpa",
    });
    const evidence = await h.gate.evaluate(request);
    expect(evidence.allowed).toBe(false);
    const consent = evidence.checks.find((check) => check.name === "consent");
    expect(consent?.outcome).toBe("block");
    expect(consent?.detail["citation"]).toBe("15 U.S.C. § 1692c(b)");
  });
});

// ---------------------------------------------------------------------------
// Quiet hours: the recipient's clock, not ours
// ---------------------------------------------------------------------------

describe("quiet hours", () => {
  /** The same UTC instant, evaluated for one recipient. */
  async function quietAt(instant: string, timeZone: string, jurisdiction = "US"): Promise<boolean> {
    const h = harness();
    h.clock.set(instant);
    await grant(h);
    const evidence = await h.gate.evaluate(
      sendRequest({ recipientTimeZone: timeZone, jurisdiction }),
    );
    const check = evidence.checks.find((entry) => entry.name === "quiet_hours");
    return check?.outcome === "block";
  }

  it("uses the recipient's timezone, not the server's", async () => {
    // 16:00 UTC is midday in New York and 06:00 in Honolulu. One is sendable,
    // the other is not, and the difference is entirely the recipient's clock.
    expect(await quietAt(NOW, "America/New_York")).toBe(false);
    expect(await quietAt(NOW, "Pacific/Honolulu")).toBe(true);
  });

  it("follows a daylight-saving transition rather than a fixed offset", async () => {
    // United States clocks moved forward on 8 March 2026. 12:30 UTC is 07:30
    // Eastern before the change and 08:30 Eastern after it — inside the quiet
    // window, then outside it. A hard-coded -5 offset would call both quiet;
    // a hard-coded -4 would call both sendable. Both would be wrong for half
    // the year, and the wrong half is the one nobody tests in.
    expect(await quietAt("2026-03-07T12:30:00.000Z", "America/New_York")).toBe(true);
    expect(await quietAt("2026-03-09T12:30:00.000Z", "America/New_York")).toBe(false);
  });

  it("applies a narrower state window over the federal baseline", async () => {
    // 00:30 UTC on the 7th is 20:30 on the 6th in New York: inside Florida's
    // 20:00 window, outside the federal 21:00 one.
    expect(await quietAt("2026-08-07T00:30:00.000Z", "America/New_York", "FL")).toBe(true);
    expect(await quietAt("2026-08-07T00:30:00.000Z", "America/New_York", "US")).toBe(false);
  });

  it("treats the window as half-open at both ends", async () => {
    // 21:00 local is quiet; 08:00 local is not.
    expect(await quietAt("2026-08-07T01:00:00.000Z", "America/New_York")).toBe(true);
    expect(await quietAt("2026-08-06T12:00:00.000Z", "America/New_York")).toBe(false);
  });

  it("honours a declared exemption instead of inferring one", async () => {
    const h = harness();
    h.clock.set("2026-08-06T09:00:00.000Z"); // 05:00 in New York
    await grant(h, { channel: "postal" });
    const evidence = await h.gate.evaluate(
      sendRequest({ channel: "postal", destinationDigest: destinationFingerprint("postal", "ref-1") }),
    );
    const check = evidence.checks.find((entry) => entry.name === "quiet_hours");
    expect(check?.outcome).toBe("pass");
    expect(check?.detail["exempt"]).toBe(true);
  });

  it("refuses when the recipient's timezone is unusable", async () => {
    const h = harness();
    await grant(h);
    for (const timeZone of ["", "US/Eastern-ish", "UTC-5"]) {
      const evidence = await h.gate.evaluate(sendRequest({ recipientTimeZone: timeZone }));
      expect(evidence.allowed).toBe(false);
      expect(evidence.blockingReason).toBe("contact.evidence_unavailable");
    }

    const request = sendRequest({ recipientTimeZone: "UTC-5", idempotencyKey: "idem-tz" });
    const approvalId = await approveSend(h, request);
    await expect(h.gate.clear({ ...request, approvalId })).rejects.toMatchObject({
      reason: "contact.evidence_unavailable",
    });
  });

  it("refuses when the policy covers neither the channel nor an exemption", async () => {
    const h = harness();
    const gapped = new ContactGate(h.store, ...gateDependencies(h), {
      policy: { ...TEST_POLICY, quietHours: [], quietHoursExemptChannels: [] },
    });
    await grant(h);
    const evidence = await gapped.evaluate(sendRequest());
    expect(evidence.allowed).toBe(false);
    expect(evidence.checks.find((check) => check.name === "quiet_hours")?.outcome).toBe(
      "unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// Frequency caps
// ---------------------------------------------------------------------------

describe("frequency caps", () => {
  /** Put a cleared message into the record at a chosen past instant. */
  async function seedCleared(h: Harness, requestedAt: string): Promise<void> {
    const message: OutboundMessage = {
      id: h.ids.next("message"),
      subjectRef: "ctr_owner_1",
      channel: "sms",
      purpose: "servicing",
      relationship: "owner",
      destinationDigest: DESTINATION,
      contentDigest: digestValue({ body: "earlier" }),
      jurisdiction: "US",
      recipientTimeZone: "America/New_York",
      riskBand: "standard",
      status: "cleared",
      evidence: {
        evaluatedAt: requestedAt,
        subjectRef: "ctr_owner_1",
        channel: "sms",
        purpose: "servicing",
        relationship: "owner",
        jurisdiction: "US",
        recipientTimeZone: "America/New_York",
        recipientLocalTime: "2026-08-05T12:00:00",
        policyVersion: TEST_POLICY.version,
        checks: [],
        allowed: true,
      },
      evidenceDigest: digestValue({ seeded: requestedAt }),
      requestedBy: SUPERVISOR.actorId,
      requestedAt,
      idempotencyKey: `seed-${requestedAt}`,
    };
    await h.store.recordOutboundMessage(message);
  }

  it("counts a rolling window, not a calendar day", async () => {
    const h = harness();
    await grant(h);

    // Cap is 2 per 24h. One message 25 hours ago is outside the window; one
    // five hours ago is inside it. A calendar-day cap would count neither,
    // because both fall on an earlier date than "now".
    await seedCleared(h, "2026-08-05T15:00:00.000Z");
    await seedCleared(h, "2026-08-06T11:00:00.000Z");

    const first = await h.gate.evaluate(sendRequest());
    const check = first.checks.find((entry) => entry.name === "frequency_cap");
    expect(check?.outcome).toBe("pass");
    expect(check?.detail["capsApplied"]).toBe(1);

    // A third message inside the window takes the count to the cap.
    await seedCleared(h, "2026-08-06T13:00:00.000Z");
    const second = await h.gate.evaluate(sendRequest());
    const blockedCheck = second.checks.find((entry) => entry.name === "frequency_cap");
    expect(blockedCheck?.outcome).toBe("block");
    expect(blockedCheck?.detail["sentInWindow"]).toBe(2);
    expect(second.blockingReason).toBe("contact.frequency_cap");
  });

  it("does not count blocked attempts against the cap", async () => {
    const h = harness();
    const request = sendRequest({ idempotencyKey: "idem-blocked-count" });
    const approvalId = await approveSend(h, request);
    // No consent yet: this attempt is refused and recorded.
    await expect(h.gate.clear({ ...request, approvalId })).rejects.toBeInstanceOf(DeniedError);

    await grant(h);
    const evidence = await h.gate.evaluate(sendRequest());
    const check = evidence.checks.find((entry) => entry.name === "frequency_cap");
    expect(check?.outcome).toBe("pass");
  });

  it("refuses when no cap is declared for the channel", async () => {
    const h = harness();
    const gapped = new ContactGate(h.store, ...gateDependencies(h), {
      policy: { ...TEST_POLICY, frequencyCaps: [] },
    });
    await grant(h);
    const evidence = await gapped.evaluate(sendRequest());
    expect(evidence.allowed).toBe(false);
    expect(evidence.checks.find((check) => check.name === "frequency_cap")?.outcome).toBe(
      "unavailable",
    );
  });

  it("applies the strictest of several stacked caps", async () => {
    const h = harness();
    const stacked = new ContactGate(h.store, ...gateDependencies(h), {
      policy: {
        ...TEST_POLICY,
        frequencyCaps: [
          ...TEST_POLICY.frequencyCaps,
          {
            jurisdiction: "US",
            channel: "sms",
            purpose: "servicing",
            maxMessages: 1,
            windowHours: 24,
            citation: "test",
            verified: true,
          },
        ],
      },
    });
    await grant(h);

    const evidence = await stacked.evaluate(sendRequest());
    expect(evidence.checks.find((check) => check.name === "frequency_cap")?.detail["capsApplied"]).toBe(
      2,
    );
  });
});

// ---------------------------------------------------------------------------
// Fail closed when a check cannot be answered
// ---------------------------------------------------------------------------

describe("evidence availability", () => {
  it("refuses when the consent ledger cannot be read", async () => {
    const failing = (inner: ContactStore): ContactStore =>
      new Proxy(inner, {
        get(target, property, receiver) {
          if (property === "listConsentEvents") {
            return async (_filter: ConsentEventFilter): Promise<never> => {
              throw new DeniedError("record.unavailable", "consent ledger unreachable", {});
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });

    const h = harness({ store: failing });
    const request = sendRequest({ idempotencyKey: "idem-unavailable" });
    const approvalId = await approveSend(h, request);

    await expect(h.gate.clear({ ...request, approvalId })).rejects.toMatchObject({
      reason: "contact.evidence_unavailable",
    });

    // The refusal is evidenced: an unanswerable check is recorded as
    // unanswered, not silently treated as passed.
    const blocked = await h.gate.history("ctr_owner_1");
    expect(blocked[0]?.status).toBe("blocked");
    expect(blocked[0]?.evidence.checks[0]).toMatchObject({
      name: "consent",
      outcome: "unavailable",
    });
    const entries = await entriesOfType(h.auditStore, "contact.gate_blocked");
    expect(entries).toHaveLength(1);
  });

  it("refuses when it cannot tell whether the message was already sent", async () => {
    const failing = (inner: ContactStore): ContactStore =>
      new Proxy(inner, {
        get(target, property, receiver) {
          if (property === "findOutboundMessageByKey") {
            return async (): Promise<never> => {
              throw new Error("replica lag");
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });

    const h = harness({ store: failing });
    await grant(h);
    await expect(h.gate.clear(sendRequest())).rejects.toMatchObject({
      reason: "contact.evidence_unavailable",
    });
  });
});

// ---------------------------------------------------------------------------
// Approval, risk banding, replay
// ---------------------------------------------------------------------------

describe("authorization and replay", () => {
  it("refuses a send with no approval, and records the refusal", async () => {
    const h = harness();
    await grant(h);

    await expect(h.gate.clear(sendRequest())).rejects.toMatchObject({ reason: "approval.required" });

    const history = await h.gate.history("ctr_owner_1");
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("blocked");
    expect(history[0]?.denialReason).toBe("approval.required");
  });

  it("puts a collections message on the elevated two-approver path", async () => {
    const h = harness();
    await grant(h, { purpose: "collections" });

    const request = sendRequest({ purpose: "collections", idempotencyKey: "idem-collections" });
    // Collections is FDCPA territory, so it takes the two-approver descriptor
    // rather than the ordinary one.
    expect(h.gate.riskBand(request)).toBe("elevated");

    // A single grant leaves the approval pending, so nothing can be spent
    // against it and the send is refused.
    const pending = await h.approvals.request({
      action: SEND_HIGH_RISK_MESSAGE_ACTION,
      proposalDigest: h.gate.proposalDigest(request),
      summary: "collections message",
      requestedBy: AGENT,
      approvalsRequired: 2,
      eligibleRoles: ["supervisor"],
    });
    await h.approvals.decide({
      approvalId: pending.id,
      actor: SUPERVISOR,
      decision: "granted",
      secondsSinceAuthentication: 10,
      stepUpMaxAgeSeconds: 300,
    });
    expect((await h.approvals.get(pending.id))?.status).toBe("pending");
    await expect(h.gate.clear({ ...request, approvalId: pending.id })).rejects.toMatchObject({
      reason: "approval.required",
    });

    // Two distinct approvers, and it clears.
    const approvalId = await approveSend(h, request, [SUPERVISOR, SUPERVISOR_TWO]);
    const clearance = await h.gate.clear({
      ...request,
      idempotencyKey: "idem-collections-2",
      approvalId,
    });
    expect(clearance.message.riskBand).toBe("elevated");
    expect(clearance.message.status).toBe("cleared");
  });

  it("treats model-written content as elevated whatever its purpose", () => {
    const h = harness();
    expect(h.gate.riskBand(sendRequest())).toBe("standard");
    expect(h.gate.riskBand(sendRequest({ modelId: "some-model" }))).toBe("elevated");
  });

  it("binds the approval to the proposal, so swapping the content fails", async () => {
    const h = harness();
    await grant(h);
    const request = sendRequest({ idempotencyKey: "idem-swap" });
    const approvalId = await approveSend(h, request);

    const swapped = {
      ...request,
      contentDigest: digestValue({ body: "something else entirely" }),
      approvalId,
    };
    await expect(h.gate.clear(swapped)).rejects.toMatchObject({
      reason: "approval.digest_mismatch",
    });
  });

  it("replays an idempotency key rather than sending twice", async () => {
    const h = harness();
    await grant(h);
    const request = sendRequest({ idempotencyKey: "idem-replay" });
    const approvalId = await approveSend(h, request);

    const first = await h.gate.clear({ ...request, approvalId });
    const second = await h.gate.clear({ ...request, approvalId });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.message.id).toBe(first.message.id);

    const cleared = await h.store.listOutboundMessages({ status: "cleared" });
    expect(cleared).toHaveLength(1);
    // And the replay consumed nothing: the approval was spent exactly once.
    const passed = await entriesOfType(h.auditStore, "contact.gate_passed");
    expect(passed).toHaveLength(1);
  });

  it("leaves a clearance inert when its receipt fails, and finishes it on retry", async () => {
    const h = harness({ receiptFailures: 1 });
    await grant(h);
    const request = sendRequest({ idempotencyKey: "idem-receipt" });
    const approvalId = await approveSend(h, request);

    // The receipt could not be written, so the caller is refused.
    await expect(h.gate.clear({ ...request, approvalId })).rejects.toMatchObject({
      reason: "record.unavailable",
    });

    // The clearance exists but carries no receipt, which makes it inert: a
    // channel adapter delivers against a receipted clearance and nothing else.
    const stranded = await h.store.findOutboundMessageByKey("idem-receipt");
    expect(stranded?.status).toBe("cleared");
    expect(stranded?.receiptId).toBeUndefined();
    expect(await entriesOfType(h.auditStore, "contact.gate_passed")).toHaveLength(0);

    // The retry finishes the job rather than starting again. It does not
    // re-authorize, because the approval this very message consumed is spent —
    // trying to spend it twice would strand the clearance permanently.
    const clearance = await h.gate.clear({ ...request, approvalId });
    expect(clearance.replayed).toBe(true);
    expect(clearance.message.id).toBe(stranded?.id);
    expect(clearance.message.receiptId).toBeDefined();
    expect(await entriesOfType(h.auditStore, "contact.gate_passed")).toHaveLength(1);
    // Still one message. The owner hears from us once.
    expect(await h.store.listOutboundMessages({ status: "cleared" })).toHaveLength(1);
  });

  it("sends once when two callers race the same idempotency key", async () => {
    const h = harness();
    await grant(h);
    const request = sendRequest({ idempotencyKey: "idem-race" });
    const approvalId = await approveSend(h, request);

    const outcomes = await Promise.allSettled([
      h.gate.clear({ ...request, approvalId }),
      h.gate.clear({ ...request, approvalId }),
    ]);

    const cleared = await h.store.listOutboundMessages({ status: "cleared" });
    expect(cleared).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled").length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(DeniedError);
      }
    }
  });

  it("stops an in-flight send when containment is engaged", async () => {
    const h = harness();
    await grant(h);
    const request = sendRequest({ idempotencyKey: "idem-contained" });
    const approvalId = await approveSend(h, request);

    const containment = new ContainmentController(
      new MemoryContainmentStore(h.db),
      h.clock,
      h.audit,
    );
    await containment.engage("global", "", COMPLIANCE.actorId, "investigating a template defect");
    // Containment state is cached briefly on the hot path, so a pause takes
    // effect within that window rather than instantly. Moving the clock past it
    // is what an operator experiences as "a second or two".
    h.clock.advance(2_000);

    // The switch is read on the authorization path, so a send that had already
    // passed every compliance check still stops.
    await expect(h.gate.clear({ ...request, approvalId })).rejects.toMatchObject({
      reason: "containment.global_pause",
    });
  });
});

// ---------------------------------------------------------------------------
// Suppression lists and destination fingerprints
// ---------------------------------------------------------------------------

describe("suppression", () => {
  it("widens but never narrows an existing entry", async () => {
    const h = harness();
    await h.ledger.suppress({
      list: "internal",
      subjectRef: "ctr_owner_1",
      destinationDigest: "",
      channels: [],
      jurisdiction: "US",
      registeredAt: NOW,
      expiresAt: null,
      source: "owner request",
      actor: AGENT,
      mode: "supervised",
    });

    await expect(
      h.ledger.suppress({
        list: "internal",
        subjectRef: "ctr_owner_1",
        destinationDigest: "",
        channels: ["sms"],
        jurisdiction: "US",
        registeredAt: NOW,
        expiresAt: "2026-09-01T00:00:00.000Z",
        source: "cleanup job",
        actor: AGENT,
        mode: "supervised",
      }),
    ).rejects.toMatchObject({ reason: "contact.do_not_call" });
  });

  it("fingerprints a telephone destination past its formatting", () => {
    expect(destinationFingerprint("sms", "+1 (407) 555-0134")).toBe(
      destinationFingerprint("sms", "407-555-0134"),
    );
    expect(destinationFingerprint("email", "Owner@Example.com ")).toBe(
      destinationFingerprint("email", "owner@example.com"),
    );
    // The channel is part of the input, so the same string on two channels does
    // not collide.
    expect(destinationFingerprint("sms", "4075550134")).not.toBe(
      destinationFingerprint("voice", "4075550134"),
    );
  });

  it("stops matching once an entry has lapsed", async () => {
    const h = harness();
    await grant(h);
    await h.ledger.suppress({
      list: "state",
      subjectRef: "ctr_owner_1",
      destinationDigest: "",
      channels: ["sms"],
      jurisdiction: "FL",
      registeredAt: NOW,
      expiresAt: "2026-08-06T18:00:00.000Z",
      source: "state register",
      actor: AGENT,
      mode: "supervised",
    });

    expect((await h.gate.evaluate(sendRequest())).blockingReason).toBe("contact.do_not_call");
    h.clock.set("2026-08-06T18:00:00.001Z");
    expect((await h.gate.evaluate(sendRequest())).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The shipped policy artifact
// ---------------------------------------------------------------------------

describe("the shipped contact policy", () => {
  it("is well formed: every channel is either covered or explicitly exempt", () => {
    const problems = validateContactPolicy(CONTACT_POLICY);
    expect(problems.filter((problem) => problem.severity === "error")).toEqual([]);
  });

  it("reports every unverified value rather than letting it pass quietly", () => {
    const warnings = validateContactPolicy(CONTACT_POLICY).filter(
      (problem) => problem.severity === "warning",
    );
    // Every shipped value is an engineering placeholder awaiting MVW
    // compliance sign-off, and the validator must say so every time it runs.
    expect(warnings.length).toBe(
      CONTACT_POLICY.quietHours.length + CONTACT_POLICY.frequencyCaps.length,
    );
  });

  it("does not permit collections contact with third parties", () => {
    expect(CONTACT_POLICY.collectionsThirdPartyPermitted).toBe(false);
  });
});

/**
 * The gate's dependencies, so a test can build a second gate over the same
 * stores with a different policy.
 */
function gateDependencies(
  h: Harness,
): [Authorizer, AuditLog, FixedClock, SeededIdGenerator] {
  const registry = new ActionRegistry(TEST_ACTIONS);
  const containment = new ContainmentController(new MemoryContainmentStore(h.db), h.clock, h.audit);
  const runs = new MemoryRunStore(h.db, h.clock, h.ids);
  const ceilings = new CeilingEnforcer(
    { runSpendUsd: 100, dailySpendUsd: 1000, runWallClockMs: 60_000, modelCallsPerMinute: 100 },
    h.clock,
    runs,
  );
  const approvals = new ApprovalService(new MemoryApprovalStore(h.db), h.clock, h.ids, h.audit);
  return [
    new Authorizer(registry, containment, ceilings, approvals, h.audit, h.clock, 300),
    h.audit,
    h.clock,
    h.ids,
  ];
}
