import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { Authorizer } from "../guard/authorize.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError, type DenialReason } from "../kernel/errors.js";
import { digestBytes, digestValue, isDigest, type Digest } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import { zonedFieldsAt } from "../timeline/calendar.js";
import { SEND_HIGH_RISK_MESSAGE_ACTION, SEND_MESSAGE_ACTION } from "./actions.js";
import { deriveConsentState, suppressionApplies } from "./consent.js";
import {
  CONTACT_POLICY,
  assertRecipientTimeZone,
  isElevated,
  isWithinQuietWindow,
  resolveFrequencyCaps,
  resolveQuietHours,
} from "./policy.js";
import type { ContactStore } from "./port.js";
import { ALL_PURPOSES, CONTACT_CHANNELS, CONTACT_PURPOSES } from "./types.js";
import type {
  ContactChannel,
  ContactCheck,
  ContactCheckName,
  ContactClearance,
  ContactEvidence,
  ContactPolicy,
  ContactRiskBand,
  FrequencyCap,
  OutboundMessage,
  OutboundRequest,
} from "./types.js";

/**
 * The outbound compliance gate.
 *
 * **One chokepoint. Every message, call, or text passes through `clear()`.**
 * There is no second path, no "internal" bypass, and no channel adapter that
 * may originate a send on its own — an adapter delivers a clearance this gate
 * issued, or it delivers nothing. This module was built before any channel
 * existed, deliberately, so that the first channel had to be written against a
 * gate that already worked rather than the other way round.
 *
 * ## The obligations this is scaffolding for
 *
 * *TCPA* (47 U.S.C. § 227, 47 C.F.R. § 64.1200). Prior express consent for
 * autodialled or prerecorded calls and for texts; prior express *written*
 * consent where the content is marketing; calls restricted to 8 a.m.–9 p.m.
 * **at the called party's location**; an internal do-not-call list that must be
 * honoured and retained. Statutory damages run per message, which is why this
 * gate refuses rather than warns.
 *
 * *State do-not-call and telephone solicitation acts.* Several states run their
 * own registers and several set narrower calling hours than the federal rule.
 * Those are policy values in `policy.ts` keyed by jurisdiction, not conditionals
 * in this file.
 *
 * *FDCPA* (15 U.S.C. § 1692c) wherever a delinquent balance is involved. It
 * restricts the hours at which a consumer may be contacted and — the part a
 * consent check alone misses entirely — prohibits discussing the debt with
 * third parties. That is why `OutboundRequest` carries a recipient
 * relationship and why a collections message to a third party is refused
 * outright.
 *
 * **None of this is legal advice, and this module does not decide what the
 * obligations are.** MVW compliance owns the policy values — the quiet-hour
 * windows, the caps, which purposes need which consent. They are configuration
 * in version control (`policy.ts`), versioned as an artifact, named in the
 * evidence of every decision. Engineering owns making them unskippable and
 * computing them correctly.
 *
 * ## The order of checks, and why it is that order
 *
 *   1. **Consent** for this channel *and* this purpose. Not one consent for
 *      "contact"; consent is not transferable between channels or purposes.
 *   2. **Revocation**, which always wins — including over a consent record that
 *      appears later. See `deriveConsentState` for the rule that makes a
 *      back-dated or stale grant unable to displace an opt-out.
 *   3. **Do-not-call**, matched on the owner reference and on the destination
 *      fingerprint, across the internal, state, and federal registers.
 *   4. **Quiet hours**, computed from the *recipient's* IANA timezone. Never
 *      the server's, never a fixed offset. A company in Florida calling an
 *      owner in Honolulu is governed by the clock in Honolulu, and an offset
 *      hard-coded anywhere here would be wrong twice a year.
 *   5. **Frequency caps**, over a rolling window rather than a calendar day. A
 *      day-boundary cap permits a burst at 23:55 and another at 00:05, which is
 *      the pattern a regulator reads as harassment.
 *
 * Every check records what it asked, what it was told, and which policy it was
 * measured against — whether the message went out or not. A blocked attempt is
 * the more interesting record of the two, because it is the only place that
 * attempt exists at all.
 *
 * **A check that cannot be answered refuses.** An unreachable consent ledger,
 * an unresolvable timezone, a jurisdiction the policy does not cover: each
 * produces `contact.evidence_unavailable` and no message. "We could not tell"
 * and "we were allowed" are opposite answers, and only one of them is safe to
 * guess.
 */

/** Milliseconds in an hour, for the rolling frequency window. */
const HOUR_MS = 3_600_000;

export interface ContactGateOptions {
  /** The policy artifact to measure against. Defaults to the shipped one. */
  readonly policy?: ContactPolicy;
}

export class ContactGate {
  private readonly policy: ContactPolicy;

  constructor(
    private readonly store: ContactStore,
    private readonly authorizer: Authorizer,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    options: ContactGateOptions = {},
  ) {
    this.policy = options.policy ?? CONTACT_POLICY;
  }

  /**
   * Run every check and assemble the evidence, without sending anything.
   *
   * Used by the console to explain why a message is or is not sendable, and by
   * `documents/` before it generates anything an owner will read. It performs
   * no authorization, consumes no approval, and records nothing, so it is safe
   * to call speculatively.
   *
   * It does not throw for a refusal. The evidence *is* the refusal: `allowed`
   * is false and `blockingReason` names why. Anything acting on this must check
   * `allowed` — `clear()` is the only path that may actually send, and it
   * raises.
   */
  async evaluate(request: OutboundRequest): Promise<ContactEvidence> {
    assertOutboundRequest(request);

    const nowMs = this.clock.now();
    const nowIso = this.clock.nowIso();

    // Resolved first because every later check reports against it, and because
    // a recipient whose timezone we cannot resolve is one whose quiet hours we
    // cannot compute — which is a refusal, not a default.
    let localTime = "unavailable";
    let minuteOfDay: number | null = null;
    let timeZoneProblem: string | null = null;
    try {
      assertRecipientTimeZone(request.recipientTimeZone);
      const fields = zonedFieldsAt(nowMs, request.recipientTimeZone);
      minuteOfDay = fields.hour * 60 + fields.minute;
      localTime =
        `${pad(fields.year, 4)}-${pad(fields.month, 2)}-${pad(fields.day, 2)}` +
        `T${pad(fields.hour, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)}`;
    } catch (error) {
      // allow-swallow: this is not a denial being stepped over. The failure is
      // turned into recorded evidence that the check could not be answered,
      // which `clear()` below converts back into a refusal that is raised. The
      // reason it is captured rather than thrown is that a refusal with no
      // evidence attached is exactly what this module exists to prevent.
      timeZoneProblem = error instanceof Error ? error.message : String(error);
    }

    const consentEvents = await this.answer(() =>
      this.store.listConsentEvents({
        subjectRef: request.subjectRef,
        channel: request.channel,
        purpose: request.purpose,
      }),
    );

    const checks: ContactCheck[] = [];

    // ---- 1. Consent, for this channel AND this purpose. -----------------
    if (consentEvents.outcome !== "ok") {
      checks.push(unavailable("consent", consentEvents.problem));
    } else if (
      request.purpose === "collections" &&
      request.relationship === "third_party" &&
      !this.policy.collectionsThirdPartyPermitted
    ) {
      // FDCPA § 1692c(b). A consent check alone would pass this — the third
      // party may well have consented to being contacted — and the message
      // would still be unlawful, because the prohibition is about discussing
      // someone else's debt rather than about who agreed to hear from us.
      checks.push({
        name: "consent",
        outcome: "block",
        reason: "contact.no_consent",
        summary:
          "Collections contact addressed to a third party is prohibited; the platform holds no basis for discussing an owner's balance with anyone else.",
        detail: {
          relationship: request.relationship,
          purpose: request.purpose,
          citation: "15 U.S.C. § 1692c(b)",
          policyVersion: this.policy.version,
        },
      });
    } else {
      const state = deriveConsentState(consentEvents.value, {
        subjectRef: request.subjectRef,
        channel: request.channel,
        purpose: request.purpose,
        asOf: nowIso,
      });
      const grants = consentEvents.value.filter(
        (event) => event.kind === "granted" && event.effectiveAt <= nowIso,
      );
      // A grant whose audit receipt never landed is in the ledger but is not
      // usable consent: we cannot evidence it, and consent we cannot evidence
      // is consent we do not have. Note the deliberate asymmetry — the
      // revocation check below honours an unreceipted revocation. Evidence is
      // required to act, never to stop.
      const receipted = grants.filter((event) => event.receiptId !== undefined);

      if (receipted.length === 0) {
        checks.push({
          name: "consent",
          outcome: "block",
          reason: "contact.no_consent",
          summary:
            grants.length === 0
              ? `No consent on record for ${request.channel}/${request.purpose}.`
              : `Consent for ${request.channel}/${request.purpose} exists in the ledger but carries no audit receipt, so it cannot be evidenced.`,
          detail: {
            channel: request.channel,
            purpose: request.purpose,
            eventsConsidered: state.eventsConsidered,
            grantsFound: grants.length,
            receiptedGrants: 0,
          },
        });
      } else {
        const latest = receipted[receipted.length - 1];
        checks.push({
          name: "consent",
          outcome: "pass",
          reason: null,
          summary: `Consent on record for ${request.channel}/${request.purpose}.`,
          detail: {
            channel: request.channel,
            purpose: request.purpose,
            grantsFound: grants.length,
            receiptedGrants: receipted.length,
            eventsConsidered: state.eventsConsidered,
            ...(latest
              ? {
                  consentId: latest.id,
                  effectiveAt: latest.effectiveAt,
                  source: latest.provenance.source,
                }
              : {}),
          },
        });
      }

      // ---- 2. Revocation. It wins, always. ------------------------------
      if (state.status === "revoked") {
        checks.push({
          name: "revocation",
          outcome: "block",
          reason: "contact.revoked",
          summary: `Contact was revoked for ${request.channel}/${request.purpose}${state.since ? ` effective ${state.since}` : ""}.`,
          detail: {
            channel: request.channel,
            purpose: request.purpose,
            revokedAt: state.since ?? "unknown",
            decidedBy: state.decidedBy ?? "unknown",
            eventsConsidered: state.eventsConsidered,
          },
        });
      } else {
        checks.push({
          name: "revocation",
          outcome: "pass",
          reason: null,
          summary: "No revocation governs this channel and purpose.",
          detail: {
            channel: request.channel,
            purpose: request.purpose,
            eventsConsidered: state.eventsConsidered,
            status: state.status,
          },
        });
      }
    }

    // ---- 3. Do-not-call. ------------------------------------------------
    const suppressions = await this.answer(() =>
      this.store.findDoNotCall({
        subjectRef: request.subjectRef,
        destinationDigest: request.destinationDigest,
        channel: request.channel,
        asOf: nowIso,
      }),
    );
    if (suppressions.outcome !== "ok") {
      checks.push(unavailable("do_not_call", suppressions.problem));
    } else {
      const biting = suppressions.value.filter((entry) =>
        suppressionApplies(entry, request.channel, nowIso),
      );
      const first = biting[0];
      checks.push(
        first
          ? {
              name: "do_not_call",
              outcome: "block",
              reason: "contact.do_not_call",
              summary: `Suppressed on the ${first.list} do-not-call list for ${first.jurisdiction}.`,
              detail: {
                list: first.list,
                jurisdiction: first.jurisdiction,
                registeredAt: first.registeredAt,
                expiresAt: first.expiresAt ?? "never",
                matches: biting.length,
              },
            }
          : {
              name: "do_not_call",
              outcome: "pass",
              reason: null,
              summary: "No do-not-call entry matches this owner or this destination.",
              detail: { entriesConsidered: suppressions.value.length, channel: request.channel },
            },
      );
    }

    // ---- 4. Quiet hours, in the recipient's timezone. -------------------
    if (timeZoneProblem !== null || minuteOfDay === null) {
      checks.push(
        unavailable(
          "quiet_hours",
          timeZoneProblem ?? "The recipient's local time could not be computed.",
        ),
      );
    } else {
      const window = await this.answer(async () =>
        resolveQuietHours(this.policy, request.jurisdiction, request.channel),
      );
      if (window.outcome !== "ok") {
        checks.push(unavailable("quiet_hours", window.problem));
      } else if (window.value === null) {
        checks.push({
          name: "quiet_hours",
          outcome: "pass",
          reason: null,
          summary: `Policy ${this.policy.version} declares ${request.channel} exempt from quiet hours.`,
          detail: {
            channel: request.channel,
            jurisdiction: request.jurisdiction,
            policyVersion: this.policy.version,
            exempt: true,
          },
        });
      } else {
        const quiet = isWithinQuietWindow(minuteOfDay, window.value);
        checks.push({
          name: "quiet_hours",
          outcome: quiet ? "block" : "pass",
          reason: quiet ? "contact.quiet_hours" : null,
          summary: quiet
            ? `${localTime} is inside the ${window.value.localStart}–${window.value.localEnd} quiet window for ${window.value.jurisdiction}, in the recipient's timezone ${request.recipientTimeZone}.`
            : `${localTime} is outside the ${window.value.localStart}–${window.value.localEnd} quiet window for ${window.value.jurisdiction}.`,
          detail: {
            recipientTimeZone: request.recipientTimeZone,
            recipientLocalTime: localTime,
            windowJurisdiction: window.value.jurisdiction,
            localStart: window.value.localStart,
            localEnd: window.value.localEnd,
            citation: window.value.citation,
            verified: window.value.verified,
            policyVersion: this.policy.version,
          },
        });
      }
    }

    // ---- 5. Frequency caps, over a rolling window. ----------------------
    const caps = await this.answer(async () =>
      resolveFrequencyCaps(this.policy, request.jurisdiction, request.channel, request.purpose),
    );
    if (caps.outcome !== "ok") {
      checks.push(unavailable("frequency_cap", caps.problem));
    } else {
      const counted = await this.answer(async () => {
        const measured: { cap: FrequencyCap; count: number }[] = [];
        for (const cap of caps.value) {
          const since = new Date(nowMs - cap.windowHours * HOUR_MS).toISOString();
          const count = await this.store.countMessagesSince({
            subjectRef: request.subjectRef,
            channel: request.channel,
            purpose: cap.purpose === ALL_PURPOSES ? ALL_PURPOSES : request.purpose,
            since,
          });
          measured.push({ cap, count });
        }
        return measured;
      });

      if (counted.outcome !== "ok") {
        checks.push(unavailable("frequency_cap", counted.problem));
      } else {
        // Every applicable cap must hold. A stricter purpose-specific cap
        // stacked on an aggregate one binds at the stricter of the two, and
        // stopping at the first match would silently apply whichever entry
        // happened to be first in the policy array.
        const breached = counted.value.find((entry) => entry.count >= entry.cap.maxMessages);
        checks.push(
          breached
            ? {
                name: "frequency_cap",
                outcome: "block",
                reason: "contact.frequency_cap",
                summary: `${breached.count} message(s) already sent on ${request.channel} in the last ${breached.cap.windowHours}h; the cap is ${breached.cap.maxMessages}.`,
                detail: {
                  channel: request.channel,
                  purpose: String(breached.cap.purpose),
                  sentInWindow: breached.count,
                  maxMessages: breached.cap.maxMessages,
                  windowHours: breached.cap.windowHours,
                  citation: breached.cap.citation,
                  verified: breached.cap.verified,
                  policyVersion: this.policy.version,
                },
              }
            : {
                name: "frequency_cap",
                outcome: "pass",
                reason: null,
                summary: `Within every applicable cap (${counted.value
                  .map((entry) => `${entry.count}/${entry.cap.maxMessages} per ${entry.cap.windowHours}h`)
                  .join("; ")}).`,
                detail: {
                  channel: request.channel,
                  capsApplied: counted.value.length,
                  policyVersion: this.policy.version,
                },
              },
        );
      }
    }

    const failing = checks.find((check) => check.outcome !== "pass");
    return Object.freeze({
      evaluatedAt: nowIso,
      subjectRef: request.subjectRef,
      channel: request.channel,
      purpose: request.purpose,
      relationship: request.relationship,
      jurisdiction: request.jurisdiction,
      recipientTimeZone: request.recipientTimeZone,
      recipientLocalTime: localTime,
      policyVersion: this.policy.version,
      checks: Object.freeze(checks),
      allowed: failing === undefined,
      blockingReason: failing?.reason ?? undefined,
    });
  }

  /**
   * The chokepoint. Nothing reaches an owner without passing through here.
   *
   * Compliance checks run before authorization, matching the chokepoint's own
   * ordering rule: consuming an approval is destructive, so everything that can
   * refuse for free refuses first. Burning a supervisor's decision on a message
   * that was never sendable would cost them a second signature and teach them
   * that approvals are noise.
   *
   * @returns a clearance a channel adapter may deliver against, exactly once,
   *   and only once its `receiptId` is set — see `OutboundMessage.receiptId`.
   * @throws {DeniedError} on any refusal — including `contact.evidence_unavailable`
   *   when a check could not be answered at all. The message did not go out.
   */
  async clear(request: OutboundRequest): Promise<ContactClearance> {
    assertOutboundRequest(request);

    // Replay first. A retry after a crash reuses the idempotency key, and the
    // owner must receive one message rather than one per attempt. This is the
    // fast path; the store's unique key is the unconditional backstop for two
    // callers arriving at once.
    //
    // A clearance found without a receipt is one whose audit entry never
    // landed. It is inert — nothing may be delivered against it — so the retry
    // finishes it rather than starting again. Re-running authorization would
    // try to spend an approval this very message already consumed, and the
    // failure would leave the clearance permanently unusable.
    const existing = await this.readExisting(request.idempotencyKey);
    if (existing) {
      const finished = existing.receiptId ? existing : await this.finalise(request, existing);
      return { message: finished, evidence: finished.evidence, replayed: true };
    }

    const evidence = await this.evaluate(request);
    const band = this.riskBand(request);
    const messageId = this.ids.next("message");
    const evidenceDigest = digestValue(evidence);

    if (!evidence.allowed) {
      const reason: DenialReason = evidence.blockingReason ?? "contact.evidence_unavailable";
      const failing = evidence.checks.find((check) => check.outcome !== "pass");
      const denied = new DeniedError(
        reason,
        `Outbound ${request.channel} message to ${request.subjectRef} was refused at the contact gate: ${failing?.summary ?? "a required check could not be answered."}`,
        {
          subjectRef: request.subjectRef,
          channel: request.channel,
          purpose: request.purpose,
          check: failing?.name ?? "unknown",
          policyVersion: this.policy.version,
        },
      );

      // Recorded before the refusal propagates. A blocked attempt exists
      // nowhere else in the platform, and it is the record that proves the
      // control fired — which is the first thing anyone will ask for.
      await this.persistBlocked(request, evidence, evidenceDigest, band, messageId, denied);

      // Rethrown, never swallowed. Nothing was sent.
      throw denied;
    }

    // Authorization, including the approval this send requires. Both outbound
    // actions are `proposed_then_approved`: a message cannot be unsent, and the
    // registry refuses to let an irreversible action run automatically. The
    // elevated band asks for two approvers rather than one — that is what "above
    // a risk threshold the send additionally requires human approval" resolves
    // to here, and it is enforced by the chokepoint rather than reimplemented.
    const action = band === "elevated" ? SEND_HIGH_RISK_MESSAGE_ACTION : SEND_MESSAGE_ACTION;
    const proposalDigest = proposalDigestFor(request, band);
    try {
      await this.authorizer.authorize({
        action,
        actor: request.actor,
        mode: request.mode,
        runId: request.runId,
        correlationId: request.correlationId,
        subject: {
          subjectRef: request.subjectRef,
          channel: request.channel,
          purpose: request.purpose,
          jurisdiction: request.jurisdiction,
        },
        proposalDigest,
        approvalId: request.approvalId,
        secondsSinceAuthentication: request.secondsSinceAuthentication,
      });
    } catch (error) {
      const denied =
        error instanceof DeniedError
          ? error
          : new DeniedError(
              "authorization.action_not_permitted",
              `Authorization failed for ${action}: ${error instanceof Error ? error.message : String(error)}`,
              { action },
            );
      // The compliance checks passed and the governance checks did not. Both
      // are reasons the owner did not hear from us, and both belong in the same
      // place — otherwise "why was this never sent" has two answers in two
      // systems.
      await this.persistBlocked(request, evidence, evidenceDigest, band, messageId, denied);
      throw denied;
    }

    // Two phases, in this order, for the same reason knowledge ingestion lands
    // a document before activating it.
    //
    // The clearance is stored first, without a receipt. In that state it is
    // inert: a channel adapter delivers against a clearance carrying a
    // `receiptId` and against nothing else, so a message whose audit entry
    // never landed cannot go out. Then the receipt is written and attached.
    //
    // Writing the audit entry first would be worse in a way that is easy to
    // miss: two callers racing one idempotency key would both write a
    // `contact.gate_passed` entry, and the loser's entry would name a message
    // id that was never stored — a dangling reference in the one record that is
    // supposed to be checkable. Here the loser writes nothing, because the
    // store tells it that it lost before any receipt exists.
    const stored = await this.store.recordOutboundMessage(
      this.buildMessage(request, evidence, evidenceDigest, band, messageId, { status: "cleared" }),
    );

    // Another caller reached the same idempotency key first and finished the
    // job. Theirs is the clearance. One owner, one message.
    if (!stored.created && stored.message.receiptId) {
      return { message: stored.message, evidence: stored.message.evidence, replayed: true };
    }

    const receipted = await this.finalise(request, stored.message, {
      action,
      proposalDigest,
      band,
    });
    return {
      message: receipted,
      evidence: receipted.evidence,
      replayed: !stored.created,
    };
  }

  /**
   * Write the receipt for a stored clearance and attach it.
   *
   * Reached on the ordinary path and again on a retry that found a clearance
   * whose receipt never landed. The evidence comes off the stored message
   * rather than being recomputed, so the entry describes the checks that
   * actually permitted the send rather than the checks that would pass now.
   */
  private async finalise(
    request: OutboundRequest,
    message: OutboundMessage,
    context?: {
      readonly action: string;
      readonly proposalDigest: Digest;
      readonly band: ContactRiskBand;
    },
  ): Promise<OutboundMessage> {
    const receipt = await this.audit.record(
      auditDecision({
        eventType: "contact.gate_passed",
        actorId: request.actor.actorId,
        actorKind: request.actor.kind,
        actorRoles: request.actor.roles,
        runId: request.runId,
        correlationId: request.correlationId,
        subject: {
          subjectRef: message.subjectRef,
          messageId: message.id,
          channel: message.channel,
          purpose: message.purpose,
          jurisdiction: message.jurisdiction,
        },
        inputDigests: {
          evidence: message.evidenceDigest,
          content: message.contentDigest,
          destination: message.destinationDigest as Digest,
          ...(context ? { proposal: context.proposalDigest } : {}),
        },
        decision: {
          riskBand: context?.band ?? message.riskBand,
          ...(context ? { action: context.action } : {}),
          policyVersion: message.evidence.policyVersion,
          recipientTimeZone: message.recipientTimeZone,
          recipientLocalTime: message.evidence.recipientLocalTime,
          checksPassed: message.evidence.checks.length,
          ...(message.modelId ? { modelId: message.modelId } : {}),
          ...(message.templateId ? { templateId: message.templateId } : {}),
        },
      }),
    );
    return this.store.attachMessageReceipt(message.id, receipt.id);
  }

  /** Every send attempt against a subject, cleared and blocked alike. */
  history(subjectRef: string): Promise<readonly OutboundMessage[]> {
    return this.store.listOutboundMessages({ subjectRef });
  }

  /** Which approval path a request attracts, without evaluating anything else. */
  riskBand(request: OutboundRequest): ContactRiskBand {
    return isElevated(this.policy, {
      channel: request.channel,
      purpose: request.purpose,
      modelGenerated: request.modelId !== undefined,
      toThirdParty: request.relationship !== "owner",
    })
      ? "elevated"
      : "standard";
  }

  /** The digest an approval for this send must be bound to. */
  proposalDigest(request: OutboundRequest): Digest {
    return proposalDigestFor(request, this.riskBand(request));
  }

  private async readExisting(idempotencyKey: string): Promise<OutboundMessage | null> {
    try {
      return await this.store.findOutboundMessageByKey(idempotencyKey);
    } catch (error) {
      // A store that cannot tell us whether this message already went out is a
      // store that cannot stop us sending it twice.
      throw new DeniedError(
        "contact.evidence_unavailable",
        `The outbound record could not be read, so whether this message was already sent is unknown. Refusing rather than risking a duplicate: ${error instanceof Error ? error.message : String(error)}`,
        { idempotencyKey },
      );
    }
  }

  private async persistBlocked(
    request: OutboundRequest,
    evidence: ContactEvidence,
    evidenceDigest: Digest,
    band: ContactRiskBand,
    messageId: Id<"message">,
    denied: DeniedError,
  ): Promise<void> {
    const message = this.buildMessage(request, evidence, evidenceDigest, band, messageId, {
      status: "blocked",
      denialReason: denied.reason,
    });
    const stored = await this.store.recordOutboundMessage(message);

    const receipt = await this.audit.record(
      auditDecision({
        eventType: "contact.gate_blocked",
        actorId: request.actor.actorId,
        actorKind: request.actor.kind,
        actorRoles: request.actor.roles,
        runId: request.runId,
        correlationId: request.correlationId,
        subject: {
          subjectRef: request.subjectRef,
          messageId: stored.message.id,
          channel: request.channel,
          purpose: request.purpose,
          jurisdiction: request.jurisdiction,
        },
        inputDigests: {
          evidence: evidenceDigest,
          content: request.contentDigest,
          destination: request.destinationDigest as Digest,
        },
        decision: {
          reason: denied.reason,
          riskBand: band,
          policyVersion: this.policy.version,
          recipientTimeZone: request.recipientTimeZone,
          recipientLocalTime: evidence.recipientLocalTime,
          failedCheck: evidence.checks.find((check) => check.outcome !== "pass")?.name ?? "authorization",
        },
      }),
    );

    await this.store.attachMessageReceipt(stored.message.id, receipt.id);
  }

  private buildMessage(
    request: OutboundRequest,
    evidence: ContactEvidence,
    evidenceDigest: Digest,
    riskBand: ContactRiskBand,
    id: Id<"message">,
    outcome: {
      readonly status: OutboundMessage["status"];
      readonly denialReason?: string;
      readonly receiptId?: Id<"auditEntry">;
    },
  ): OutboundMessage {
    return {
      id,
      runId: request.runId,
      correlationId: request.correlationId,
      subjectRef: request.subjectRef,
      channel: request.channel,
      purpose: request.purpose,
      relationship: request.relationship,
      destinationDigest: request.destinationDigest,
      contentDigest: request.contentDigest,
      jurisdiction: request.jurisdiction,
      recipientTimeZone: request.recipientTimeZone,
      templateId: request.templateId,
      templateVersion: request.templateVersion,
      modelId: request.modelId,
      riskBand,
      status: outcome.status,
      evidence,
      evidenceDigest,
      requestedBy: request.actor.actorId,
      requestedAt: evidence.evaluatedAt,
      idempotencyKey: request.idempotencyKey,
      approvalId: request.approvalId,
      denialReason: outcome.denialReason,
      receiptId: outcome.receiptId,
    };
  }

  /**
   * Run one check's data access, converting any failure into "unavailable".
   *
   * The conversion is the point. A check whose source could not be read has not
   * passed — it has not happened — and the difference has to survive into the
   * evidence rather than being flattened into an exception that loses which of
   * the five questions went unanswered.
   */
  private async answer<T>(
    fn: () => Promise<T>,
  ): Promise<{ outcome: "ok"; value: T } | { outcome: "unavailable"; problem: string }> {
    try {
      return { outcome: "ok", value: await fn() };
    } catch (error) {
      // allow-swallow: a DeniedError here is a data source refusing to answer,
      // and it is recorded as an unanswered check. `clear()` turns any
      // unanswered check back into a raised `contact.evidence_unavailable`
      // before anything is sent, so nothing proceeds on a swallowed refusal —
      // see the `!evidence.allowed` branch above, which always throws.
      return {
        outcome: "unavailable",
        problem: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function pad(value: number, width: number): string {
  return String(Math.abs(value)).padStart(width, "0");
}

function unavailable(name: ContactCheckName, problem: string): ContactCheck {
  return {
    name,
    outcome: "unavailable",
    reason: "contact.evidence_unavailable",
    summary: `The ${name.replace(/_/g, " ")} check could not be answered: ${problem}`,
    detail: { answered: false },
  };
}

/**
 * The digest an approval is bound to.
 *
 * Covers what the approver is agreeing to — this recipient, this channel, this
 * purpose, this content, this risk band — and deliberately excludes the gate
 * evidence and the timestamps. Evidence is measured again at `clear()`, so
 * binding an approval to it would mean an approval expiring the moment a clock
 * ticked past a quiet-hours boundary. What an approver signs off is the
 * message; what the gate re-checks is whether it may go out now.
 */
export function proposalDigestFor(request: OutboundRequest, band: ContactRiskBand): Digest {
  return digestValue({
    action: "contact.send",
    subjectRef: request.subjectRef,
    channel: request.channel,
    purpose: request.purpose,
    relationship: request.relationship,
    destinationDigest: request.destinationDigest,
    contentDigest: request.contentDigest,
    jurisdiction: request.jurisdiction,
    riskBand: band,
    templateId: request.templateId ?? null,
    templateVersion: request.templateVersion ?? null,
    modelId: request.modelId ?? null,
  });
}

/**
 * Fingerprint a destination.
 *
 * The platform never holds a phone number or an email address: those are owner
 * personal data and they live in MVW's system of record. A fingerprint is
 * enough to match a do-not-call entry, to deduplicate, and to count frequency,
 * and it is not enough to contact anybody — which is the property that keeps
 * this module out of the blast radius of its own database.
 *
 * The channel is part of the input so the same string on two channels does not
 * collide, and the value is normalised so trivial formatting differences do not
 * defeat a suppression entry. Normalisation is deliberately aggressive for
 * telephone destinations: `+1 (407) 555-0134` and `4075550134` are the same
 * number, and a do-not-call list that missed the second one would be worthless.
 */
export function destinationFingerprint(channel: ContactChannel, destination: string): Digest {
  if (typeof destination !== "string" || destination.trim().length === 0) {
    throw new InvalidInputError("A destination is required to fingerprint.", "destination");
  }
  const normalised =
    channel === "voice" || channel === "sms"
      ? destination.replace(/[^\d]/g, "").replace(/^1(?=\d{10}$)/, "")
      : destination.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalised.length === 0) {
    throw new InvalidInputError(
      `"${destination}" normalises to nothing on the ${channel} channel, so it cannot be matched against a suppression list.`,
      "destination",
    );
  }
  return digestBytes(`${channel}:${normalised}`);
}

/** Structural validation. Refuses a request that could not be evaluated at all. */
export function assertOutboundRequest(request: OutboundRequest): void {
  if (typeof request.subjectRef !== "string" || request.subjectRef.trim().length === 0) {
    throw new InvalidInputError(
      "An outbound message needs the owner reference it is addressed to.",
      "subjectRef",
    );
  }
  if (!CONTACT_CHANNELS.includes(request.channel)) {
    throw new InvalidInputError(`Unknown contact channel "${String(request.channel)}".`, "channel");
  }
  if (!CONTACT_PURPOSES.includes(request.purpose)) {
    throw new InvalidInputError(`Unknown contact purpose "${String(request.purpose)}".`, "purpose");
  }
  if (!isDigest(request.destinationDigest)) {
    throw new InvalidInputError(
      "destinationDigest must be a sha256 fingerprint from destinationFingerprint(). The gate never handles a raw phone number or address.",
      "destinationDigest",
    );
  }
  if (!isDigest(request.contentDigest)) {
    throw new InvalidInputError(
      "contentDigest must be a sha256 digest of exactly what would be sent.",
      "contentDigest",
    );
  }
  if (typeof request.jurisdiction !== "string" || request.jurisdiction.trim().length === 0) {
    throw new InvalidInputError(
      "A jurisdiction is required: quiet hours and caps are per-jurisdiction policy.",
      "jurisdiction",
    );
  }
  if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.trim().length === 0) {
    throw new InvalidInputError(
      "An idempotency key is required so a retry after a crash sends one message rather than one per attempt.",
      "idempotencyKey",
    );
  }
}
