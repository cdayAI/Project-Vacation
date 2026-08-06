import type { DenialReason } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, IsoTimestamp, OperatingMode } from "../record/types.js";

/**
 * Outbound contact: the shapes.
 *
 * If the platform ever contacts an owner, this is the highest-liability surface
 * in the product. The obligations it is scaffolding for are real and they carry
 * statutory damages per message: the Telephone Consumer Protection Act (47
 * U.S.C. § 227) and its implementing rules at 47 C.F.R. § 64.1200, the federal
 * and state do-not-call registries, and — wherever a delinquent account is
 * involved — the Fair Debt Collection Practices Act (15 U.S.C. § 1692c), which
 * restricts *when* a consumer may be contacted and *who else* may be contacted
 * about the debt at all.
 *
 * **This module is engineering scaffolding for those obligations. It is not
 * legal advice and it does not decide what the obligations are.** Every policy
 * value — which hours are quiet in which state, how many messages a month is
 * too many, which purposes need which consent — is configuration owned by MVW
 * compliance, expressed as a declarative artifact in version control and
 * reviewed by the people accountable for it. The code's job is to make the
 * values unskippable, to compute them correctly, and to leave evidence.
 *
 * Four decisions run through every type here.
 *
 * *Consent is an event history, not a flag.* A boolean someone set once cannot
 * answer "when did they consent, through what channel, and how do we know" —
 * which is the only question that matters when a demand letter arrives. So
 * `ConsentEvent` is append-only with provenance and two timestamps, and the
 * current state is *derived*. Nothing overwrites anything.
 *
 * *There are two clocks on every consent event, deliberately.* `effectiveAt` is
 * when the owner acted; `recordedAt` is when we learned about it. They differ
 * whenever consent arrives through a batch import or a call-centre write-up,
 * and the difference is exactly what a back-dated grant exploits. See
 * `consent.ts` for the rule that uses both.
 *
 * *Revocation is broad, consent is narrow.* A revocation may be scoped to every
 * channel or every purpose at once, because "stop contacting me" is a thing
 * people say and a thing the law honours. A grant may never be: consent is
 * given for a specific channel and a specific purpose or it is not consent.
 *
 * *The platform holds fingerprints of destinations, never destinations.* A
 * phone number or an email address is owner personal data and belongs in MVW's
 * system of record. This module carries a `destinationDigest` so it can match a
 * do-not-call entry, deduplicate, and count frequency without ever holding the
 * number. The channel adapter resolves the real destination from the subject
 * reference at the moment of delivery, under its own controls.
 */

/**
 * How a message would reach someone.
 *
 * Deliberately a closed set. A new channel is a new regulatory surface — a fax
 * is not an email is not an autodialled call — so adding one is a reviewable
 * change here and in the policy artifact, not a string a caller invents.
 */
export const CONTACT_CHANNELS = ["voice", "sms", "email", "postal"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/**
 * Why the message is being sent.
 *
 * Consent is per channel *and* per purpose because that is how the obligation
 * works: an owner who agreed to servicing texts about their reservation has not
 * agreed to marketing texts, and treating the two as one consent is the single
 * most common way a company ends up in a class action.
 */
export const CONTACT_PURPOSES = [
  /** Something the owner asked for, tied to a transaction in flight. */
  "transactional",
  /** Account servicing: maintenance fees, reservations, association notices. */
  "servicing",
  /** Anything touching a delinquent balance. FDCPA territory. */
  "collections",
  "marketing",
  "survey",
] as const;
export type ContactPurpose = (typeof CONTACT_PURPOSES)[number];

/**
 * Wildcards usable on a revocation only.
 *
 * Distinct string values rather than `"*"` or an empty string so that a
 * wildcard can never be produced by a missing field, a trimmed input, or a
 * malformed import. A revocation is the one direction where breadth is safe.
 */
export const ALL_CHANNELS = "all_channels";
export const ALL_PURPOSES = "all_purposes";

export type ConsentChannelScope = ContactChannel | typeof ALL_CHANNELS;
export type ConsentPurposeScope = ContactPurpose | typeof ALL_PURPOSES;

export type ConsentEventKind = "granted" | "revoked";

/**
 * How a consent or revocation reached us.
 *
 * A closed set because "how do we know" has to be answerable with something
 * more specific than "it was in the database". Each value implies a different
 * evidence artifact and a different level of proof.
 */
export const CONSENT_SOURCES = [
  "signed_document",
  "web_form",
  "inbound_call",
  "outbound_call_recorded",
  "sms_reply",
  "email_reply",
  "agent_recorded",
  "system_of_record_import",
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/**
 * The evidence trail for one consent event.
 *
 * `evidenceDigest` fingerprints the artifact — the signed form, the call
 * recording, the web-form submission — held wherever such artifacts are held.
 * The digest is what lets a reviewer prove the artifact they are looking at is
 * the one the consent was recorded from, without this module becoming a second
 * copy of it.
 */
export interface ConsentProvenance {
  readonly source: ConsentSource;
  /** Who captured it. An actor id, never a name or an email address. */
  readonly capturedBy: string;
  /** Fingerprint of the underlying evidence artifact. */
  readonly evidenceDigest: Digest;
  /** Where a reviewer can retrieve that artifact. */
  readonly evidenceUri?: string | undefined;
  /** Short non-personal note, e.g. the form version or the IVR prompt id. */
  readonly note?: string | undefined;
}

/**
 * One immutable entry in the consent ledger.
 *
 * Never updated, never deleted. A mistaken entry is corrected by appending a
 * superseding one — the same shape the audit chain uses, for the same reason.
 */
export interface ConsentEvent {
  readonly id: Id<"consent">;
  /** Opaque owner reference, e.g. a contract or membership id. Never a name. */
  readonly subjectRef: string;
  readonly channel: ConsentChannelScope;
  readonly purpose: ConsentPurposeScope;
  readonly kind: ConsentEventKind;
  /** When the owner acted. May precede `recordedAt`. */
  readonly effectiveAt: IsoTimestamp;
  /** When the platform learned of it. Assigned from the clock, never supplied. */
  readonly recordedAt: IsoTimestamp;
  readonly provenance: ConsentProvenance;
  /** Audit entry that recorded this event. */
  readonly receiptId?: Id<"auditEntry"> | undefined;
}

/**
 * A revocation, narrowed.
 *
 * Named as its own type because revocation is the event the rest of the module
 * treats specially: it always wins, it may be broad, and it is the one thing
 * that must never be lost. Anywhere a function takes a `Revocation` rather than
 * a `ConsentEvent`, that asymmetry is the reason.
 */
export type Revocation = ConsentEvent & { readonly kind: "revoked" };

export type ConsentStatus = "granted" | "revoked" | "never_given";

/**
 * The derived answer for one (subject, channel, purpose) at one moment.
 *
 * Derived on every read rather than stored, so there is no cached copy that can
 * be stale at the moment a message goes out. `basis` names the event ids the
 * answer rests on, which is what makes the evidence checkable rather than
 * merely asserted.
 */
export interface ConsentState {
  readonly subjectRef: string;
  readonly channel: ContactChannel;
  readonly purpose: ContactPurpose;
  readonly status: ConsentStatus;
  /** When the governing event took effect. Absent when nothing was ever given. */
  readonly since?: IsoTimestamp | undefined;
  /** The event that decided the status. */
  readonly decidedBy?: Id<"consent"> | undefined;
  /** Every event that was in scope for this question, oldest first. */
  readonly basis: readonly Id<"consent">[];
  /** Count of in-scope events, including any that were disregarded. */
  readonly eventsConsidered: number;
}

/**
 * Which register a suppression came from.
 *
 * `internal` is MVW's own list and is the one that binds hardest: an owner who
 * told an agent to stop is suppressed regardless of what any federal register
 * says.
 */
export const DO_NOT_CALL_LISTS = ["federal", "state", "internal"] as const;
export type DoNotCallList = (typeof DO_NOT_CALL_LISTS)[number];

/**
 * One suppression record.
 *
 * Keyed by the *pair* (subject reference, destination fingerprint) so both
 * routes are covered: a registry hit arrives as a number and is matched by
 * digest, while an owner's verbal "stop calling me" is recorded against the
 * subject and suppresses every destination they have.
 */
export interface DoNotCallEntry {
  readonly list: DoNotCallList;
  /** Opaque owner reference, or the empty string for a destination-only entry. */
  readonly subjectRef: string;
  /** Fingerprint of the destination, or the empty string for a subject-wide entry. */
  readonly destinationDigest: string;
  /** Channels suppressed. Empty means every channel. */
  readonly channels: readonly ContactChannel[];
  /** `US` for the federal register, or a state code. */
  readonly jurisdiction: string;
  readonly registeredAt: IsoTimestamp;
  /** When the entry lapses. `null` means it does not. */
  readonly expiresAt: IsoTimestamp | null;
  readonly source: string;
  readonly recordedAt: IsoTimestamp;
}

/**
 * The hours during which a channel may not be used, in the *recipient's* local
 * time.
 *
 * The federal baseline is 8 a.m. to 9 p.m. at the called party's location (47
 * C.F.R. § 64.1200(c)(1)); several states are narrower, and the FDCPA applies
 * its own inconvenient-hours presumption to collections contact. **The values
 * shipped in `policy.ts` are engineering defaults pending MVW compliance
 * sign-off**, which is why every entry carries a citation and a `verified` flag.
 */
export interface QuietHoursPolicy {
  /** `US` for the federal baseline, or a state code such as `FL`. */
  readonly jurisdiction: string;
  /** Channels this window applies to. */
  readonly channels: readonly ContactChannel[];
  /** Local wall-clock start of the quiet window, `HH:MM`, inclusive. */
  readonly localStart: string;
  /** Local wall-clock end of the quiet window, `HH:MM`, exclusive. */
  readonly localEnd: string;
  /** Statute or rule this window comes from. */
  readonly citation: string;
  /** False until MVW compliance has confirmed the value. */
  readonly verified: boolean;
}

/**
 * A ceiling on how often one owner may be contacted, over a rolling window.
 *
 * Rolling, not per calendar day: a cap that resets at midnight permits a burst
 * at 23:55 followed by another at 00:05, which is precisely the pattern a
 * regulator reads as harassment.
 */
export interface FrequencyCap {
  readonly jurisdiction: string;
  readonly channel: ContactChannel;
  /** Purpose this cap covers, or `all_purposes` for an aggregate ceiling. */
  readonly purpose: ConsentPurposeScope;
  /** Maximum cleared messages within the window. */
  readonly maxMessages: number;
  readonly windowHours: number;
  readonly citation: string;
  readonly verified: boolean;
}

/**
 * Who the message would reach.
 *
 * Present because the FDCPA restricts communication *about a debt* with anyone
 * other than the consumer (15 U.S.C. § 1692c(b)). A collections message routed
 * to a third party is the failure mode that produces both a statutory claim and
 * a news story, and it is invisible to a consent check that only asks "did this
 * subject opt in".
 */
export const RECIPIENT_RELATIONSHIPS = [
  "owner",
  "co_owner",
  "authorised_representative",
  "third_party",
] as const;
export type RecipientRelationship = (typeof RECIPIENT_RELATIONSHIPS)[number];

/**
 * The complete outbound policy, as one versioned artifact.
 *
 * Versioned as a whole so that a piece of gate evidence can name the exact
 * policy it was evaluated against. "We checked quiet hours" is worth little
 * three years later; "we checked quiet hours against policy v3, which said
 * 21:00–08:00 for Florida" is evidence.
 */
export interface ContactPolicy {
  readonly version: string;
  /** Accountable owner. A team or role, never a person. */
  readonly owner: string;
  readonly quietHours: readonly QuietHoursPolicy[];
  readonly frequencyCaps: readonly FrequencyCap[];
  /**
   * Channels for which quiet hours do not apply, declared explicitly.
   *
   * Postal mail has no delivery time the sender controls. That exemption is
   * *declared* rather than inferred, because an inferred exemption is
   * indistinguishable from a policy someone forgot to write.
   */
  readonly quietHoursExemptChannels: readonly ContactChannel[];
  /** Purposes that always require the elevated approval path. */
  readonly elevatedPurposes: readonly ContactPurpose[];
  /** Channels that always require the elevated approval path. */
  readonly elevatedChannels: readonly ContactChannel[];
  /**
   * Whether a collections message may ever be addressed to someone other than
   * the consumer. Ships false, and 15 U.S.C. § 1692c(b) is the reason.
   */
  readonly collectionsThirdPartyPermitted: boolean;
}

/** The five questions the gate asks, in the order it asks them. */
export const CONTACT_CHECKS = [
  "consent",
  "revocation",
  "do_not_call",
  "quiet_hours",
  "frequency_cap",
] as const;
export type ContactCheckName = (typeof CONTACT_CHECKS)[number];

/**
 * The outcome of one check.
 *
 * `unavailable` is a third state on purpose. A check whose data source could
 * not be read has not passed and has not failed — it has not happened, and
 * conflating that with `pass` is the exact failure this platform refuses to
 * have.
 */
export type ContactCheckOutcome = "pass" | "block" | "unavailable";

export interface ContactCheck {
  readonly name: ContactCheckName;
  readonly outcome: ContactCheckOutcome;
  /** The denial reason this check would raise. Null when it passed. */
  readonly reason: DenialReason | null;
  /** One sentence a compliance reviewer can read without reading the code. */
  readonly summary: string;
  /** Non-personal structured detail: policy values, counts, event ids. */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/**
 * What was checked, against what, and what each check said.
 *
 * Recorded alongside the message and fingerprinted into the audit entry. This
 * object is the answer to "prove you were allowed to send that", and it is
 * assembled whether the message went out or not — a blocked send is the more
 * interesting record of the two.
 */
export interface ContactEvidence {
  readonly evaluatedAt: IsoTimestamp;
  readonly subjectRef: string;
  readonly channel: ContactChannel;
  readonly purpose: ContactPurpose;
  readonly relationship: RecipientRelationship;
  /** Jurisdiction whose rules were applied, e.g. `FL`. */
  readonly jurisdiction: string;
  /** IANA zone of the *recipient*. Never the server's. */
  readonly recipientTimeZone: string;
  /** The recipient's local wall-clock time at evaluation, `YYYY-MM-DDTHH:MM:SS`. */
  readonly recipientLocalTime: string;
  readonly policyVersion: string;
  readonly checks: readonly ContactCheck[];
  readonly allowed: boolean;
  /** The reason of the first check that refused. */
  readonly blockingReason?: DenialReason | undefined;
}

/** How much governance a particular send attracts. */
export type ContactRiskBand = "standard" | "elevated";

/** What a caller is asking to send. */
export interface OutboundRequest {
  readonly subjectRef: string;
  readonly channel: ContactChannel;
  readonly purpose: ContactPurpose;
  readonly relationship: RecipientRelationship;
  /**
   * Fingerprint of the destination, from `destinationFingerprint()`.
   *
   * The gate never sees the number or the address. See the module header.
   */
  readonly destinationDigest: string;
  /** Fingerprint of the exact content that would be sent. */
  readonly contentDigest: Digest;
  /** Jurisdiction whose contact rules govern, e.g. `FL`. */
  readonly jurisdiction: string;
  /** IANA zone of the recipient, e.g. `America/New_York`. Required. */
  readonly recipientTimeZone: string;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly templateId?: Id<"template"> | undefined;
  readonly templateVersion?: number | undefined;
  /** Set when a model wrote any part of the content. Always elevates the band. */
  readonly modelId?: string | undefined;
  /**
   * Deduplication key for the send.
   *
   * A retry after a crash must reuse it, so the owner receives one message
   * rather than one per attempt.
   */
  readonly idempotencyKey: string;
  readonly approvalId?: Id<"approval"> | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export type OutboundStatus = "cleared" | "blocked";

/**
 * The record of one send attempt, cleared or refused.
 *
 * Both outcomes are stored. A blocked attempt is evidence that the control
 * worked, and it is the only place that attempt exists — nothing else in the
 * platform would show it.
 */
export interface OutboundMessage {
  readonly id: Id<"message">;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly subjectRef: string;
  readonly channel: ContactChannel;
  readonly purpose: ContactPurpose;
  readonly relationship: RecipientRelationship;
  readonly destinationDigest: string;
  readonly contentDigest: Digest;
  readonly jurisdiction: string;
  readonly recipientTimeZone: string;
  readonly templateId?: Id<"template"> | undefined;
  readonly templateVersion?: number | undefined;
  readonly modelId?: string | undefined;
  readonly riskBand: ContactRiskBand;
  readonly status: OutboundStatus;
  readonly evidence: ContactEvidence;
  readonly evidenceDigest: Digest;
  /** Actor id of the requester. */
  readonly requestedBy: string;
  readonly requestedAt: IsoTimestamp;
  readonly idempotencyKey: string;
  readonly approvalId?: Id<"approval"> | undefined;
  readonly denialReason?: string | undefined;
  readonly receiptId?: Id<"auditEntry"> | undefined;
}

/** A cleared send, and the token a channel adapter must present to deliver it. */
export interface ContactClearance {
  readonly message: OutboundMessage;
  readonly evidence: ContactEvidence;
  /** True when this call replayed an earlier clearance for the same key. */
  readonly replayed: boolean;
}

/** Counting query for the rolling frequency cap. */
export interface MessageCountQuery {
  readonly subjectRef: string;
  readonly channel: ContactChannel;
  /** `all_purposes` counts every purpose on the channel. */
  readonly purpose: ConsentPurposeScope;
  /** Inclusive lower bound of the rolling window. */
  readonly since: IsoTimestamp;
}
