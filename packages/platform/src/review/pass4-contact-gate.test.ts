import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "../audit/log.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { ApprovalService } from "../guard/approvals.js";
import { Authorizer } from "../guard/authorize.js";
import { CeilingEnforcer } from "../guard/ceilings.js";
import { ContainmentController } from "../guard/containment.js";
import { ActionRegistry } from "../guard/registry.js";
import { MemoryApprovalStore, MemoryContainmentStore } from "../guard/store.memory.js";
import { FixedClock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { MemoryRunStore } from "../record/store.memory.js";
import type { ActorRef } from "../record/types.js";
import { MemoryDb } from "../store/db.js";
import { PLATFORM_ACTIONS } from "../actions.js";
import {
  CONTACT_ACTIONS,
  SEND_HIGH_RISK_MESSAGE_ACTION,
  SEND_MESSAGE_ACTION,
} from "../contact/actions.js";
import { ConsentLedger } from "../contact/consent.js";
import { ContactGate, destinationFingerprint } from "../contact/gate.js";
import {
  assertRecipientTimeZone,
  isWithinQuietWindow,
  resolveQuietHours,
} from "../contact/policy.js";
import { isKnownTimeZone } from "../timeline/calendar.js";
import { MemoryContactStore } from "../contact/store.memory.js";
import { ALL_CHANNELS, ALL_PURPOSES } from "../contact/types.js";
import type { ContactPolicy, OutboundRequest } from "../contact/types.js";

/**
 * Pass 4, group four — the outbound gate.
 *
 * Three questions, in the order they matter.
 *
 * *Is there one gate, and can anything get past it?* The gate has no reachable
 * caller in this build — Pass 0 established that, and it is the right order to
 * have built it in — so the question here is structural: when a channel does
 * arrive, is there a second way to write an outbound record?
 *
 * *Is quiet hours measured on the recipient's clock?* 47 C.F.R.
 * § 64.1200(c)(1) restricts solicitation by the time **at the called party's
 * location**. A company in Florida calling an owner in Honolulu is governed by
 * the clock in Honolulu, and the failure mode is invisible in any test whose
 * fixtures share a timezone.
 *
 * *Is the evidence stored, or recomputed?* If it is recomputed, a policy change
 * rewrites the answer to "were we allowed to send that, on the day we sent it".
 */

const NOW = "2026-08-06T16:00:00.000Z";

const SUPERVISOR: ActorRef = { actorId: "act_supervisor", kind: "human", roles: ["supervisor"] };
const COMPLIANCE: ActorRef = {
  actorId: "act_compliance",
  kind: "human",
  roles: ["compliance_reviewer"],
};

/**
 * A policy owned by this file.
 *
 * The federal window is 21:00–08:00. The Nevada row is deliberately *wider*
 * than the federal one, which is the shape the state-override rule is probed
 * with below.
 */
const REVIEW_POLICY: ContactPolicy = {
  version: "pass4-review-policy",
  owner: "review",
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
      jurisdiction: "NV",
      channels: ["voice", "sms"],
      localStart: "23:00",
      localEnd: "06:00",
      citation: "a hypothetical state window wider than the federal one",
      verified: true,
    },
  ],
  frequencyCaps: [
    {
      jurisdiction: "US",
      channel: "sms",
      purpose: ALL_PURPOSES,
      maxMessages: 5,
      windowHours: 24,
      citation: "review",
      verified: true,
    },
    {
      jurisdiction: "US",
      channel: "voice",
      purpose: ALL_PURPOSES,
      maxMessages: 3,
      windowHours: 24,
      citation: "review",
      verified: true,
    },
    {
      jurisdiction: "US",
      channel: "email",
      purpose: ALL_PURPOSES,
      maxMessages: 10,
      windowHours: 24,
      citation: "review",
      verified: true,
    },
    {
      jurisdiction: "US",
      channel: "postal",
      purpose: ALL_PURPOSES,
      maxMessages: 4,
      windowHours: 720,
      citation: "review",
      verified: true,
    },
  ],
  quietHoursExemptChannels: ["postal", "email"],
  elevatedPurposes: ["collections", "marketing"],
  elevatedChannels: ["voice"],
  collectionsThirdPartyPermitted: false,
};

const REVIEW_ACTIONS = [
  ...PLATFORM_ACTIONS,
  ...CONTACT_ACTIONS.filter(
    (action) => !PLATFORM_ACTIONS.some((existing) => existing.name === action.name),
  ),
];

function harness() {
  const clock = new FixedClock(NOW);
  const ids = new SeededIdGenerator("pass4-contact");
  const db = new MemoryDb();
  const audit = new AuditLog(new MemoryAuditStore(db), clock, ids);
  const runs = new MemoryRunStore(db, clock, ids);
  const registry = new ActionRegistry(REVIEW_ACTIONS);
  const containment = new ContainmentController(new MemoryContainmentStore(db), clock, audit, 0);
  const ceilings = new CeilingEnforcer(
    { runSpendUsd: 100, dailySpendUsd: 1000, runWallClockMs: 60_000, modelCallsPerMinute: 100 },
    clock,
    runs,
  );
  const approvals = new ApprovalService(new MemoryApprovalStore(db), clock, ids, audit);
  const authorizer = new Authorizer(registry, containment, ceilings, approvals, audit, clock, 300);
  const store = new MemoryContactStore(db);

  return {
    clock,
    store,
    approvals,
    ledger: new ConsentLedger(store, authorizer, audit, clock, ids),
    gate: new ContactGate(store, authorizer, audit, clock, ids, { policy: REVIEW_POLICY }),
  };
}

/** Park and grant the approval an outbound send requires, as an operator would. */
async function approveSend(h: ReturnType<typeof harness>, outbound: OutboundRequest) {
  const band = h.gate.riskBand(outbound);
  const approval = await h.approvals.request({
    action: band === "elevated" ? SEND_HIGH_RISK_MESSAGE_ACTION : SEND_MESSAGE_ACTION,
    proposalDigest: h.gate.proposalDigest(outbound),
    summary: `Send a ${outbound.channel} message to ${outbound.subjectRef}`,
    requestedBy: { actorId: "act_agent", kind: "human", roles: ["owner_services_agent"] },
    approvalsRequired: 1,
    eligibleRoles: ["supervisor", "compliance_reviewer"],
  });
  await h.approvals.decide({
    approvalId: approval.id,
    actor: SUPERVISOR,
    decision: "granted",
    secondsSinceAuthentication: 10,
    stepUpMaxAgeSeconds: 300,
  });
  return approval.id;
}

const DESTINATION = destinationFingerprint("sms", "+1 (407) 555-0134");

function request(overrides: Partial<OutboundRequest> = {}): OutboundRequest {
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
    idempotencyKey: "pass4-idem-1",
    secondsSinceAuthentication: 10,
    ...overrides,
  };
}

async function grant(h: ReturnType<typeof harness>, effectiveAt = "2026-01-01T00:00:00.000Z") {
  return h.ledger.record({
    subjectRef: "ctr_owner_1",
    channel: "sms",
    purpose: "servicing",
    kind: "granted",
    effectiveAt,
    provenance: {
      source: "signed_document",
      capturedBy: "act_sales",
      evidenceDigest: digestValue({ artifact: "signed-consent-form" }),
    },
    actor: COMPLIANCE,
    mode: "supervised",
  });
}

function checkNamed(evidence: { readonly checks: readonly { readonly name: string }[] }, name: string) {
  return evidence.checks.find((check) => check.name === name);
}

describe("quiet hours are measured on the recipient's clock", () => {
  it("blocks an owner in Honolulu at an hour that is fine in Florida", async () => {
    // 2026-08-06T16:00Z is 12:00 in New York and 06:00 in Honolulu. The
    // federal window runs 21:00–08:00 local, so the Hawaii recipient is inside
    // it and the Florida recipient is not. If the server's clock were used,
    // both would pass.
    const h = harness();
    await grant(h);

    const florida = await h.gate.evaluate(request({ recipientTimeZone: "America/New_York" }));
    expect(checkNamed(florida, "quiet_hours")?.outcome).toBe("pass");

    const hawaii = await h.gate.evaluate(request({ recipientTimeZone: "Pacific/Honolulu" }));
    const quiet = checkNamed(hawaii, "quiet_hours");
    expect(quiet?.outcome).toBe("block");
    expect(quiet?.reason).toBe("contact.quiet_hours");
    expect(hawaii.recipientLocalTime).toContain("T06:00");
  });

  it("refuses rather than defaulting when the recipient's timezone is unusable", async () => {
    const h = harness();
    await grant(h);
    for (const zone of ["", "UTC-5", "Mars/Olympus", "-05:00"]) {
      const evidence = await h.gate.evaluate(request({ recipientTimeZone: zone }));
      expect(checkNamed(evidence, "quiet_hours")?.outcome, zone).toBe("unavailable");
      expect(evidence.allowed, zone).toBe(false);
      await expect(h.gate.clear(request({ recipientTimeZone: zone }))).rejects.toThrow(DeniedError);
    }
  });

  it("treats the window as half-open at both ends, across midnight", () => {
    const federal = REVIEW_POLICY.quietHours[0];
    if (!federal) throw new Error("the federal window is missing");
    expect(isWithinQuietWindow(20 * 60 + 59, federal)).toBe(false);
    expect(isWithinQuietWindow(21 * 60, federal)).toBe(true);
    expect(isWithinQuietWindow(0, federal)).toBe(true);
    expect(isWithinQuietWindow(7 * 60 + 59, federal)).toBe(true);
    expect(isWithinQuietWindow(8 * 60, federal)).toBe(false);
  });

  it("refuses a channel the policy neither covers nor exempts", () => {
    const gappy: ContactPolicy = { ...REVIEW_POLICY, quietHours: [], quietHoursExemptChannels: [] };
    expect(() => resolveQuietHours(gappy, "US", "voice")).toThrow(DeniedError);
  });

  it("refuses a bare UTC offset in place of a zone", async () => {
    // F-408. `Intl.DateTimeFormat` accepts `-05:00`, `-0500`, and `-05` as
    // time zones, so `isKnownTimeZone` accepted them and
    // `assertRecipientTimeZone` waved them through — while its own refusal text
    // read "A fixed offset is not acceptable: it is wrong twice a year".
    //
    // The consequence is one-directional and unlawful. At 2026-08-06T16:00Z an
    // owner in New York is at 12:00 EDT; read through `-05:00` they are at
    // 11:00. Every reading is an hour early for the whole of daylight saving,
    // so a call placed at 21:30 local clears a 21:00 quiet-hours check.
    const h = harness();
    await grant(h);

    for (const offset of ["-05:00", "+05:00", "-0500", "-05"]) {
      expect(assertOffsetRefused(() => assertRecipientTimeZone(offset)), offset).toBe(true);
      const evidence = await h.gate.evaluate(request({ recipientTimeZone: offset }));
      expect(checkNamed(evidence, "quiet_hours")?.outcome, offset).toBe("unavailable");
      expect(evidence.allowed, offset).toBe(false);
    }

    // Named zones still resolve.
    for (const zone of ["America/New_York", "Pacific/Honolulu", "America/Phoenix", "UTC"]) {
      expect(isKnownTimeZone(zone), zone).toBe(true);
    }
  });

  it("refuses an abbreviation alias that freezes the offset, like EST or Etc/GMT+5", async () => {
    // L18. `Intl` resolves the tz database's legacy aliases — `EST`, `MST`,
    // `HST`, `GMT` — and the whole `Etc/GMT±N` family, and every one is a fixed
    // offset with no daylight-saving rule. It is the same fault as the bare
    // `-05:00` above, wearing an IANA-shaped name, and it fails in the one
    // direction that clears an unlawful call.
    //
    // 2026-08-07T01:30Z is 21:30 EDT in New York — inside the 21:00 window.
    // Read through `EST`, a frozen UTC-5, it is 20:30, outside the window, so an
    // accepted `EST` would clear a call the recipient's real clock forbids.
    const h = harness();
    h.clock.set("2026-08-07T01:30:00.000Z");
    await grant(h);

    // The control: the recipient's real zone blocks the call at this instant.
    const real = await h.gate.evaluate(request({ recipientTimeZone: "America/New_York" }));
    expect(checkNamed(real, "quiet_hours")?.outcome).toBe("block");

    for (const alias of ["EST", "Etc/GMT+5", "MST", "GMT"]) {
      expect(isKnownTimeZone(alias), alias).toBe(false);
      expect(assertOffsetRefused(() => assertRecipientTimeZone(alias)), alias).toBe(true);
      const evidence = await h.gate.evaluate(request({ recipientTimeZone: alias }));
      // Refused, not read an hour early: the quiet-hours check cannot be
      // answered without a real zone, so the send fails closed rather than
      // clearing on a frozen offset.
      expect(checkNamed(evidence, "quiet_hours")?.outcome, alias).toBe("unavailable");
      expect(evidence.allowed, alias).toBe(false);
    }

    // A curated deny-list of the offset aliases, not a ban on single-part zone
    // names: a genuine place that happens not to observe daylight saving still
    // resolves.
    for (const zone of ["Singapore", "Japan", "Iceland", "UTC"]) {
      expect(isKnownTimeZone(zone), zone).toBe(true);
    }
  });
});

function assertOffsetRefused(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof DeniedError;
  }
}

describe("a state quiet-hours window that is wider than the federal one", () => {
  it("does not let a state entry permit an hour the federal baseline forbids", () => {
    // F-407. `resolveQuietHours` picks the jurisdiction entry if one exists and
    // otherwise the federal entry; it never intersects the two. The shipped
    // policy only carries a *narrower* state row (Florida), so the behaviour is
    // invisible today — but the resolution rule is what decides the answer the
    // day MVW compliance adds a state, and a wider state row would let the gate
    // clear a 22:00 call that 47 C.F.R. § 64.1200(c)(1) prohibits.
    //
    // The federal quiet window is a ceiling on solicitation hours, not a
    // default that a state may relax. `resolveFrequencyCaps` deliberately
    // *does* let a state override, with the rationale written down; the same
    // rationale is not stated for quiet hours and does not obviously carry
    // across, which is why this is being asked rather than changed.
    const nevada = resolveQuietHours(REVIEW_POLICY, "NV", "voice");
    if (!nevada) throw new Error("Nevada resolved to an exemption");

    // 22:00 local is inside the federal window and outside the wider state one.
    const minuteOfDay = 22 * 60;
    expect(
      isWithinQuietWindow(minuteOfDay, nevada),
      "22:00 is quiet under the federal baseline; the state row must not open it",
    ).toBe(true);
  });
});

describe("evidence is stored with the message rather than recomputed", () => {
  it("keeps the checks that actually permitted the send, not the ones that would pass now", async () => {
    const h = harness();
    await grant(h);

    const send = request();
    const clearance = await h.gate.clear({ ...send, approvalId: await approveSend(h, send) });
    expect(clearance.message.status).toBe("cleared");
    expect(clearance.message.receiptId).toBeDefined();

    const storedAtSendTime = structuredClone(clearance.message.evidence);
    expect(storedAtSendTime.policyVersion).toBe("pass4-review-policy");
    expect(storedAtSendTime.checks.length).toBeGreaterThanOrEqual(5);
    expect(storedAtSendTime.recipientTimeZone).toBe("America/New_York");

    // Move the clock into the quiet window and revoke consent. Everything that
    // decided the send is now false; the record of it must not move.
    h.clock.set("2026-08-07T02:00:00.000Z");
    await h.ledger.record({
      subjectRef: "ctr_owner_1",
      channel: ALL_CHANNELS,
      purpose: ALL_PURPOSES,
      kind: "revoked",
      effectiveAt: "2026-08-07T01:00:00.000Z",
      provenance: {
        source: "sms_reply",
        capturedBy: "act_agent",
        evidenceDigest: digestValue({ artifact: "STOP" }),
      },
      actor: COMPLIANCE,
      mode: "supervised",
    });

    const reread = await h.store.findOutboundMessageByKey("pass4-idem-1");
    expect(reread?.evidence).toEqual(storedAtSendTime);
    expect(reread?.evidence.allowed).toBe(true);
    expect(reread?.evidenceDigest).toBe(clearance.message.evidenceDigest);

    // And the gate now refuses a fresh send, so the stored evidence is history
    // rather than a live permission.
    const again = request({ idempotencyKey: "pass4-idem-2" });
    await expect(h.gate.clear(again)).rejects.toThrow(DeniedError);
  });

  it("records a blocked attempt with its evidence, since it exists nowhere else", async () => {
    const h = harness();
    // No consent at all.
    await expect(h.gate.clear(request())).rejects.toThrow(DeniedError);

    // Read back through the history the console would show, because
    // `findOutboundMessageByKey` deliberately answers only for cleared
    // messages — it exists to stop a duplicate send, not to list attempts.
    const history = await h.store.listOutboundMessages({ subjectRef: "ctr_owner_1" });
    const stored = history.find((message) => message.idempotencyKey === "pass4-idem-1");
    expect(stored?.status).toBe("blocked");
    expect(stored?.denialReason).toBe("contact.no_consent");
    expect(stored?.receiptId).toBeDefined();
    expect(checkNamed(stored!.evidence, "consent")?.outcome).toBe("block");
  });
});

describe("revocation", () => {
  it("beats a grant recorded afterwards but back-dated to before it", async () => {
    const h = harness();
    await grant(h, "2026-01-01T00:00:00.000Z");
    await h.ledger.record({
      subjectRef: "ctr_owner_1",
      channel: "sms",
      purpose: "servicing",
      kind: "revoked",
      effectiveAt: "2026-02-01T00:00:00.000Z",
      provenance: {
        source: "sms_reply",
        capturedBy: "act_agent",
        evidenceDigest: digestValue({ artifact: "STOP" }),
      },
      actor: COMPLIANCE,
      mode: "supervised",
    });
    // Recorded now, claiming to have happened before the opt-out. This is what
    // an import from a system that had not yet seen the revocation produces.
    await grant(h, "2026-01-15T00:00:00.000Z");

    const evidence = await h.gate.evaluate(request());
    expect(checkNamed(evidence, "revocation")?.outcome).toBe("block");
    expect(evidence.allowed).toBe(false);
    await expect(h.gate.clear(request())).rejects.toThrow(DeniedError);
  });

  it("beats a grant already in the ledger that claims to take effect later", async () => {
    const h = harness();
    await grant(h, "2026-03-01T00:00:00.000Z");
    await h.ledger.record({
      subjectRef: "ctr_owner_1",
      channel: "sms",
      purpose: "servicing",
      kind: "revoked",
      effectiveAt: "2026-02-01T00:00:00.000Z",
      provenance: {
        source: "sms_reply",
        capturedBy: "act_agent",
        evidenceDigest: digestValue({ artifact: "STOP" }),
      },
      actor: COMPLIANCE,
      mode: "supervised",
    });

    const evidence = await h.gate.evaluate(request());
    expect(checkNamed(evidence, "revocation")?.outcome).toBe("block");
  });
});

describe("one chokepoint", () => {
  const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));

  function productionFiles(): readonly { path: string; text: string }[] {
    const files: { path: string; text: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "review") walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
          files.push({ path: full.slice(SOURCE_ROOT.length), text: readFileSync(full, "utf8") });
        }
      }
    };
    walk(SOURCE_ROOT);
    return files;
  }

  it("is the only thing that writes an outbound message record", () => {
    // The property that has to survive the arrival of the first channel: an
    // adapter delivers a clearance the gate issued, and cannot originate one.
    const writers = productionFiles()
      .filter((file) => /\brecordOutboundMessage\s*\(/.test(file.text))
      .map((file) => file.path)
      .filter((path) => !path.startsWith("contact/"));
    expect(writers).toEqual([]);
  });

  it("is required, not optional, by the one module that generates owner-facing content", () => {
    const generate = productionFiles().find((file) => file.path === "documents/generate.ts");
    expect(generate).toBeDefined();
    // A constructor parameter, so a deployment cannot assemble the generator
    // without it.
    expect(generate?.text).toMatch(/private readonly contactGate: ContactGate/);
  });
});
