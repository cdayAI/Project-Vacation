import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { Authorizer } from "../guard/authorize.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { isDigest } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import { assertIsoUtc } from "../record/migrations.js";
import type { ActorRef, IsoTimestamp, OperatingMode } from "../record/types.js";
import { RECORD_CONSENT_ACTION, RECORD_DO_NOT_CALL_ACTION } from "./actions.js";
import type { ContactStore } from "./port.js";
import {
  ALL_CHANNELS,
  ALL_PURPOSES,
  CONSENT_SOURCES,
  CONTACT_CHANNELS,
  CONTACT_PURPOSES,
} from "./types.js";
import type {
  ConsentChannelScope,
  ConsentEvent,
  ConsentProvenance,
  ConsentPurposeScope,
  ConsentState,
  ContactChannel,
  ContactPurpose,
  DoNotCallEntry,
  DoNotCallList,
} from "./types.js";

/**
 * The consent ledger.
 *
 * Consent is modelled as an append-only event history with a derived current
 * state, because the question the platform will actually be asked is not "may
 * we contact them" but "when did they consent, through what channel, for what
 * purpose, and how do we know". A boolean column answers none of that, and a
 * boolean column that was overwritten cannot even be reconstructed.
 *
 * The derivation rule is the interesting part of this file, and it exists to
 * close one specific hole. See {@link deriveConsentState}.
 */

/** How to answer a consent question. */
export interface ConsentQuery {
  readonly subjectRef: string;
  readonly channel: ContactChannel;
  readonly purpose: ContactPurpose;
  /** Answer as of this instant. Required; there is no implicit "now". */
  readonly asOf: IsoTimestamp;
}

export interface RecordConsentRequest {
  readonly subjectRef: string;
  readonly channel: ConsentChannelScope;
  readonly purpose: ConsentPurposeScope;
  readonly kind: ConsentEvent["kind"];
  /** When the owner acted. May precede now; may not be in the future. */
  readonly effectiveAt: IsoTimestamp;
  readonly provenance: ConsentProvenance;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export interface RecordSuppressionRequest {
  readonly list: DoNotCallList;
  readonly subjectRef: string;
  readonly destinationDigest: string;
  readonly channels: readonly ContactChannel[];
  readonly jurisdiction: string;
  readonly registeredAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp | null;
  readonly source: string;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
}

export class ConsentLedger {
  constructor(
    private readonly store: ContactStore,
    private readonly authorizer: Authorizer,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Append a consent grant or a revocation.
   *
   * The write order — ledger first, receipt second — is deliberate and is not
   * the order the rest of the platform uses. Elsewhere (knowledge ingestion,
   * for instance) the artifact stays inert until its audit receipt lands,
   * because the risk is an unrecorded thing becoming authoritative. Here the
   * asymmetry runs the other way for revocations: losing an owner's "stop
   * contacting me" because an audit write failed is the worst outcome
   * available, so the stop signal is made durable first and the refusal still
   * propagates if the receipt cannot be written.
   *
   * Grants carry the opposite asymmetry, and it is enforced at the gate rather
   * than here: a grant whose receipt never landed stays in the ledger but is
   * not usable consent. Evidence is required to *act*; it is never required to
   * *stop*.
   *
   * @throws {DeniedError} from the chokepoint, the store, or a failed receipt.
   */
  async record(request: RecordConsentRequest): Promise<ConsentEvent> {
    this.assertWellFormed(request);

    await this.authorizer.authorize({
      action: RECORD_CONSENT_ACTION,
      actor: request.actor,
      mode: request.mode,
      runId: request.runId,
      correlationId: request.correlationId,
      subject: {
        subjectRef: request.subjectRef,
        channel: request.channel,
        purpose: request.purpose,
        kind: request.kind,
      },
      secondsSinceAuthentication: request.secondsSinceAuthentication,
    });

    const event: ConsentEvent = {
      id: this.ids.next("consent"),
      subjectRef: request.subjectRef,
      channel: request.channel,
      purpose: request.purpose,
      kind: request.kind,
      effectiveAt: request.effectiveAt,
      // Assigned here, never accepted from the caller. `recordedAt` is the
      // platform's own statement of when it learned something, and a caller
      // able to set it could back-date a grant past a revocation — which is
      // precisely the manipulation deriveConsentState refuses.
      recordedAt: this.clock.nowIso(),
      provenance: request.provenance,
    };

    const appended = await this.store.appendConsentEvent(event);

    const receipt = await this.audit.record(
      auditDecision({
        eventType: request.kind === "granted" ? "consent.recorded" : "consent.revoked",
        actorId: request.actor.actorId,
        actorKind: request.actor.kind,
        actorRoles: request.actor.roles,
        runId: request.runId,
        correlationId: request.correlationId,
        subject: {
          subjectRef: appended.subjectRef,
          consentId: appended.id,
          channel: appended.channel,
          purpose: appended.purpose,
        },
        inputDigests: { evidence: request.provenance.evidenceDigest },
        decision: {
          kind: appended.kind,
          source: request.provenance.source,
          effectiveAt: appended.effectiveAt,
          recordedAt: appended.recordedAt,
          // Recorded because a large gap between the two is the signal that
          // something was imported or written up long after the fact, which is
          // what a reviewer wants to know when the grant is disputed.
          backdatedMs: Date.parse(appended.recordedAt) - Date.parse(appended.effectiveAt),
          capturedBy: request.provenance.capturedBy,
        },
      }),
    );

    return this.store.attachConsentReceipt(appended.id, receipt.id);
  }

  /** The derived state for one channel and purpose, at one moment. */
  async stateFor(query: ConsentQuery): Promise<ConsentState> {
    assertIsoUtc("asOf", query.asOf);
    const events = await this.store.listConsentEvents({
      subjectRef: query.subjectRef,
      channel: query.channel,
      purpose: query.purpose,
    });
    return deriveConsentState(events, query);
  }

  /** The full ledger for a subject, oldest first. For the console and evidence. */
  history(subjectRef: string): Promise<readonly ConsentEvent[]> {
    return this.store.listConsentEvents({ subjectRef });
  }

  /**
   * Add an owner or a destination to a suppression list.
   *
   * Widening only: an existing entry can gain channels or lose its expiry, and
   * never the reverse. The store enforces that, so a mistaken or malicious
   * "renewal" with a shorter window cannot quietly un-suppress somebody.
   */
  async suppress(request: RecordSuppressionRequest): Promise<DoNotCallEntry> {
    if (request.subjectRef.trim().length === 0 && request.destinationDigest.trim().length === 0) {
      throw new InvalidInputError(
        "A suppression entry needs a subject reference, a destination fingerprint, or both. One with neither would match nothing.",
        "subjectRef",
      );
    }
    assertIsoUtc("registeredAt", request.registeredAt);
    if (request.expiresAt !== null) assertIsoUtc("expiresAt", request.expiresAt);

    await this.authorizer.authorize({
      action: RECORD_DO_NOT_CALL_ACTION,
      actor: request.actor,
      mode: request.mode,
      runId: request.runId,
      correlationId: request.correlationId,
      subject: {
        subjectRef: request.subjectRef,
        list: request.list,
        jurisdiction: request.jurisdiction,
      },
    });

    const entry: DoNotCallEntry = {
      list: request.list,
      subjectRef: request.subjectRef,
      destinationDigest: request.destinationDigest,
      channels: Object.freeze([...request.channels]),
      jurisdiction: request.jurisdiction,
      registeredAt: request.registeredAt,
      expiresAt: request.expiresAt,
      source: request.source,
      recordedAt: this.clock.nowIso(),
    };

    const stored = await this.store.putDoNotCallEntry(entry);

    await this.audit.record(
      auditDecision({
        eventType: "consent.revoked",
        actorId: request.actor.actorId,
        actorKind: request.actor.kind,
        actorRoles: request.actor.roles,
        runId: request.runId,
        correlationId: request.correlationId,
        subject: {
          subjectRef: stored.subjectRef,
          list: stored.list,
          jurisdiction: stored.jurisdiction,
        },
        decision: {
          suppression: true,
          channels: stored.channels.length === 0 ? "all" : stored.channels.join(","),
          registeredAt: stored.registeredAt,
          expiresAt: stored.expiresAt ?? "never",
          source: stored.source,
        },
      }),
    );

    return stored;
  }

  private assertWellFormed(request: RecordConsentRequest): void {
    if (typeof request.subjectRef !== "string" || request.subjectRef.trim().length === 0) {
      throw new InvalidInputError(
        "A consent event needs the owner reference it belongs to.",
        "subjectRef",
      );
    }
    if (request.kind !== "granted" && request.kind !== "revoked") {
      throw new InvalidInputError(
        `Consent event kind must be "granted" or "revoked"; received ${String(request.kind)}.`,
        "kind",
      );
    }

    const channelOk =
      request.channel === ALL_CHANNELS ||
      CONTACT_CHANNELS.includes(request.channel as ContactChannel);
    if (!channelOk) {
      throw new InvalidInputError(
        `Unknown contact channel "${String(request.channel)}".`,
        "channel",
      );
    }
    const purposeOk =
      request.purpose === ALL_PURPOSES ||
      CONTACT_PURPOSES.includes(request.purpose as ContactPurpose);
    if (!purposeOk) {
      throw new InvalidInputError(
        `Unknown contact purpose "${String(request.purpose)}".`,
        "purpose",
      );
    }

    // Breadth is available to revocations and to nothing else. "Stop
    // contacting me" is a thing an owner says and the law honours; "you may
    // contact me however you like about anything" is not consent, it is the
    // absence of a question having been asked.
    if (request.kind === "granted") {
      if (request.channel === ALL_CHANNELS || request.purpose === ALL_PURPOSES) {
        throw new InvalidInputError(
          "Consent is granted for one channel and one purpose. A blanket grant is not consent to anything specific, and could not be evidenced if it were challenged. Blanket scope is available to revocations only.",
          request.channel === ALL_CHANNELS ? "channel" : "purpose",
        );
      }
    }

    assertIsoUtc("effectiveAt", request.effectiveAt);
    if (request.effectiveAt > this.clock.nowIso()) {
      // A grant that takes effect later is not consent yet, and storing one
      // invites exactly the back-dating game deriveConsentState guards against.
      throw new InvalidInputError(
        `A consent event cannot take effect in the future (effectiveAt ${request.effectiveAt}). Record it when it happens.`,
        "effectiveAt",
      );
    }

    const provenance = request.provenance;
    if (!provenance || !CONSENT_SOURCES.includes(provenance.source)) {
      throw new InvalidInputError(
        `Consent provenance needs a known source, one of: ${CONSENT_SOURCES.join(", ")}.`,
        "provenance.source",
      );
    }
    if (typeof provenance.capturedBy !== "string" || provenance.capturedBy.trim().length === 0) {
      throw new InvalidInputError(
        "Consent provenance must record who captured it.",
        "provenance.capturedBy",
      );
    }
    if (!isDigest(provenance.evidenceDigest)) {
      throw new InvalidInputError(
        `Consent provenance must carry a sha256 fingerprint of the underlying evidence — the signed form, the recording, the form submission — not the artifact itself. Received: ${String(provenance.evidenceDigest)}`,
        "provenance.evidenceDigest",
      );
    }
  }
}

/**
 * Is this ledger event in scope for this question?
 *
 * A revocation scoped to every channel covers the specific channel being asked
 * about, and likewise for purpose. Exported because both store adapters filter
 * with it and the gate's evidence assembly reads it, and three copies of this
 * predicate would eventually disagree about whether a blanket opt-out counts.
 */
export function coversConsentQuery(
  event: ConsentEvent,
  channel: ContactChannel,
  purpose: ContactPurpose,
): boolean {
  const channelMatch = event.channel === channel || event.channel === ALL_CHANNELS;
  const purposeMatch = event.purpose === purpose || event.purpose === ALL_PURPOSES;
  return channelMatch && purposeMatch;
}

/**
 * Total order over ledger events.
 *
 * By when the owner acted, then by when we learned of it, then by id. The last
 * tiebreak exists so the derivation is deterministic for the seeded demo even
 * when two events share both timestamps.
 */
export function compareConsentEvents(left: ConsentEvent, right: ConsentEvent): number {
  if (left.effectiveAt !== right.effectiveAt) return left.effectiveAt < right.effectiveAt ? -1 : 1;
  if (left.recordedAt !== right.recordedAt) return left.recordedAt < right.recordedAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Fold a ledger into the state that governs right now.
 *
 * **Revocation always wins, including over a later consent read.** That
 * sentence is the requirement; this is the rule that implements it.
 *
 * A revocation is displaced only by a grant that is later on *both* clocks —
 * strictly later `effectiveAt` and strictly later `recordedAt`. A genuine
 * re-consent satisfies both: the owner acted after they opted out, and we
 * learned of it after we learned of the opt-out. Two things fail the test, and
 * they are the two shapes a stale or manipulated read takes:
 *
 *   - A grant recorded *after* the revocation but back-dated to *before* it.
 *     This is what an import from a system that had not yet seen the opt-out
 *     produces, and what someone reconstructing a paper trail would produce
 *     deliberately. Ordering by `effectiveAt` alone would place it before the
 *     revocation and it would lose — but ordering by `recordedAt` alone would
 *     place it after and it would win. Requiring both closes it.
 *
 *   - A grant already in the ledger claiming to take effect *after* the
 *     revocation. This is the stale read: consent captured from a snapshot
 *     taken before the opt-out landed. Ordering by `effectiveAt` alone would
 *     let it win.
 *
 * Ties go to the revocation. Two events at the same instant, one saying stop
 * and one saying go, resolve to stop.
 */
export function deriveConsentState(
  events: readonly ConsentEvent[],
  query: ConsentQuery,
): ConsentState {
  const inScope = events
    .filter(
      (event) =>
        event.subjectRef === query.subjectRef &&
        coversConsentQuery(event, query.channel, query.purpose) &&
        // An event that had not taken effect by the asked-for moment did not
        // govern at that moment. This is what makes the ledger answerable
        // historically — "were we permitted to send that, on the day we sent
        // it" — rather than only in the present tense.
        event.effectiveAt <= query.asOf,
    )
    .slice()
    .sort(compareConsentEvents);

  let governing: ConsentEvent | null = null;
  for (const event of inScope) {
    if (governing === null) {
      governing = event;
      continue;
    }
    if (governing.kind === "revoked" && event.kind === "granted") {
      const laterOnBothClocks =
        event.effectiveAt > governing.effectiveAt && event.recordedAt > governing.recordedAt;
      if (!laterOnBothClocks) continue;
    }
    governing = event;
  }

  const basis = inScope.map((event) => event.id);

  if (governing === null) {
    return {
      subjectRef: query.subjectRef,
      channel: query.channel,
      purpose: query.purpose,
      status: "never_given",
      basis,
      eventsConsidered: inScope.length,
    };
  }

  return {
    subjectRef: query.subjectRef,
    channel: query.channel,
    purpose: query.purpose,
    status: governing.kind === "granted" ? "granted" : "revoked",
    since: governing.effectiveAt,
    decidedBy: governing.id,
    basis,
    eventsConsidered: inScope.length,
  };
}

/**
 * Does a suppression entry bite, for this channel at this moment?
 *
 * An entry with no channels covers every channel — a person who says "stop
 * contacting me" has not enumerated a list. Shared by both adapters so a
 * suppression cannot bind through one and not the other.
 */
export function suppressionApplies(
  entry: DoNotCallEntry,
  channel: ContactChannel,
  asOf: IsoTimestamp,
): boolean {
  if (entry.channels.length > 0 && !entry.channels.includes(channel)) return false;
  if (entry.registeredAt > asOf) return false;
  if (entry.expiresAt !== null && entry.expiresAt <= asOf) return false;
  return true;
}

/**
 * Refuse a suppression write that would narrow an existing one.
 *
 * Suppression only ever widens. Without this, "renewing" an entry with a
 * shorter expiry or a smaller channel list is an un-suppression that leaves no
 * trace of having been one — the row simply looks like the current policy.
 *
 * @throws {DeniedError} because this is a refusal to weaken a control, not a
 *   malformed request.
 */
export function assertSuppressionNotWeakened(
  existing: DoNotCallEntry | undefined,
  next: DoNotCallEntry,
): void {
  if (!existing) return;

  if (existing.expiresAt === null && next.expiresAt !== null) {
    throw new DeniedError(
      "contact.do_not_call",
      `Suppression for ${existing.subjectRef || existing.destinationDigest} on the ${existing.list} list does not expire; it cannot be replaced with one that does.`,
      { list: existing.list },
    );
  }
  if (existing.expiresAt !== null && next.expiresAt !== null && next.expiresAt < existing.expiresAt) {
    throw new DeniedError(
      "contact.do_not_call",
      `Suppression already runs to ${existing.expiresAt}; it cannot be shortened to ${next.expiresAt}.`,
      { list: existing.list },
    );
  }
  if (existing.channels.length === 0 && next.channels.length > 0) {
    throw new DeniedError(
      "contact.do_not_call",
      `Suppression for ${existing.subjectRef || existing.destinationDigest} covers every channel; it cannot be narrowed to ${next.channels.join(", ")}.`,
      { list: existing.list },
    );
  }
  const dropped = existing.channels.filter((channel) => !next.channels.includes(channel));
  if (next.channels.length > 0 && dropped.length > 0) {
    throw new DeniedError(
      "contact.do_not_call",
      `Suppression cannot drop channel(s) ${dropped.join(", ")}. Entries widen; they never narrow.`,
      { list: existing.list },
    );
  }
}
