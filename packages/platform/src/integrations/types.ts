import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type { IsoDate } from "../timeline/types.js";

/**
 * Systems of record, behind narrow versioned interfaces.
 *
 * ## Read this before building against these shapes
 *
 * **We do not know MVW's internal systems.** Nobody on this project has seen
 * their contract system, their association accounting, or their data
 * dictionary. Every field below is an informed guess about what a rescission
 * check or a board pack needs, expressed in the vocabulary of the domain
 * rather than of any particular vendor.
 *
 * They are deliberately *narrow* for that reason. A wide interface guesses
 * more, and every guessed field is one more thing to renegotiate when the real
 * shape appears. These carry the minimum the first two workflows need and
 * nothing else — which also means the mapping conversation with MVW is short
 * and concrete: "here are eleven fields, what are they called in your system,
 * and which of them do you not have?"
 *
 * `IntegrationDescriptor.shapeConfirmedWithMvw` is `false` on every adapter
 * shipped today, and the console surfaces it. That flag exists so that "this
 * was designed against a guess" is visible in the product rather than buried in
 * a comment nobody opens. It flips to `true` per-integration, in a pull
 * request, when a named person at MVW has confirmed the mapping in writing.
 *
 * ## Two conventions
 *
 * *No owner personal data.* `ContractRecord` carries a contract identifier, a
 * jurisdiction, and some timestamps. It carries no name, address, phone
 * number, email, or account number, because the rescission calculation does
 * not need any of them and pulling them across the boundary would put owner
 * personal data into the operating record, the retention story, and every
 * subject-rights request. If a downstream workflow needs to *contact* an
 * owner, it resolves that separately, at the point of contact, under the
 * contact gate.
 *
 * *Money is integer minor units.* Every amount is `...Cents`. A reserve
 * balance in a board pack is compared, summed, and rendered, and binary
 * floating point accumulates error at exactly the point where a board member
 * checks the arithmetic. There is no `amountUsd: number` anywhere in this
 * module.
 */

export interface IntegrationDescriptor {
  /** Stable machine name, matching the containment switch target. */
  readonly name: string;
  /**
   * Interface version.
   *
   * Versioned rather than evolved in place. When a field has to change shape
   * incompatibly, a `ContractRecordsPortV2` appears beside the v1 interface and
   * both are served until every caller has moved. An adapter declares which
   * version it implements, so a caller can never be handed an adapter that
   * speaks a different dialect of the same name.
   */
  readonly version: number;
  /** The MVW system this stands in front of. Unknown until MVW tells us. */
  readonly systemOfRecord: string;
  readonly description: string;
  /**
   * Whether a named person at MVW has confirmed this shape in writing.
   *
   * False everywhere today. Surfaced in the console rather than hidden here.
   */
  readonly shapeConfirmedWithMvw: boolean;
}

export interface IntegrationHealth {
  readonly name: string;
  readonly version: number;
  readonly available: boolean;
  readonly checkedAt: IsoTimestamp;
  /** Non-sensitive detail an operator can act on. */
  readonly detail: string;
}

/** Where a record came from, so an answer can be traced back to its source. */
export interface RecordProvenance {
  readonly system: string;
  readonly retrievedAt: IsoTimestamp;
  /** Fingerprint of the payload the adapter received, for the audit trail. */
  readonly payloadDigest: Digest;
}

export type ContractStatus =
  | "pending"
  | "executed"
  | "rescinded"
  | "cancelled"
  | "closed";

export const CONTRACT_STATUSES: readonly ContractStatus[] = [
  "pending",
  "executed",
  "rescinded",
  "cancelled",
  "closed",
];

/**
 * Contract metadata for a rescission check.
 *
 * Each field earns its place by being something a statutory rescission window
 * actually turns on:
 *
 *   `jurisdiction`             which state's rule applies at all.
 *   `executedAt`               most states run the clock from execution.
 *   `disclosuresDeliveredAt`   several states run it from delivery of the
 *                              public offering statement instead, and some run
 *                              it from the later of the two. An absent value is
 *                              not "delivered at execution" — it is unknown,
 *                              and a window computed from an unknown start is
 *                              a guess presented as a deadline.
 *   `documentSetComplete`      some states toll or restart the period when the
 *                              required document set was incomplete.
 *   `financed`                 financed purchases can carry a different notice
 *                              regime.
 *   `rescissionRequestedAt`    whether the owner has already exercised.
 *
 * The timeline module owns the rules. This type owns only the facts the rules
 * are applied to, which is why it is deliberately dumb.
 */
export interface ContractRecord {
  readonly contractId: Id<"contract">;
  /**
   * The jurisdiction whose rescission rule governs.
   *
   * A two-letter US state code today. **Confirm with MVW** which field this
   * maps to: the property's situs state, the state where the contract was
   * signed, and the purchaser's state of residence can all differ, and they
   * do not all select the same statute.
   */
  readonly jurisdiction: string;
  readonly status: ContractStatus;
  readonly executedAt: IsoTimestamp;
  /** Absent means "we do not know", never "same as execution". */
  readonly disclosuresDeliveredAt?: IsoTimestamp | undefined;
  readonly documentSetComplete: boolean;
  /** Names of required documents the system of record does not hold. */
  readonly missingDocuments: readonly string[];
  readonly financed: boolean;
  readonly rescissionRequestedAt?: IsoTimestamp | undefined;
  readonly provenance: RecordProvenance;
}

/** An association, as an entity. Carries no individual's data. */
export interface AssociationRef {
  readonly associationId: string;
  readonly name: string;
  readonly jurisdiction: string;
  /** 1-12. Board packs and budget cycles hang off the fiscal year end. */
  readonly fiscalYearEndMonth: number;
}

/**
 * Budget and reserve summary for an association board pack.
 *
 * The reserve figures are the ones a board is actually asked to vote on, and
 * the ones an owner writes to the state regulator about. `reserveStudyDate`
 * matters as much as the balances: a funding percentage computed against a
 * six-year-old study is not a current answer, and the board pack has to say so
 * rather than presenting the number bare.
 */
export interface AssociationBudgetSummary {
  readonly associationId: string;
  readonly fiscalYear: number;
  /** ISO 4217. Present so a future non-USD association is not a schema change. */
  readonly currency: string;
  readonly totalBudgetCents: number;
  readonly reserveBalanceCents: number;
  /** What the most recent reserve study says the balance should be. */
  readonly reserveStudyRecommendedCents: number;
  readonly annualAssessmentPerIntervalCents: number;
  /** Absent when no study is on file — which is itself a finding for the pack. */
  readonly reserveStudyDate?: IsoDate | undefined;
  /**
   * Assessment delinquency, in basis points of billed assessments.
   *
   * Basis points rather than a percentage float, for the same reason amounts
   * are cents. **Confirm with MVW** whether this is available per association
   * and how they define it; the Q1 2026 call discussed delinquency at a
   * portfolio level, which is not the same measure.
   */
  readonly delinquencyBasisPoints?: number | undefined;
  readonly asOf: IsoTimestamp;
  readonly provenance: RecordProvenance;
}

/**
 * A credential for an outbound call.
 *
 * `value` is a live secret. It is scoped to specific hosts, so a credential
 * issued for one system cannot be presented to another by a call that got its
 * URL wrong — or by one that got it wrong on purpose.
 *
 * Sealed credentials (see `credentials.ts`) make `value` non-enumerable, so
 * `JSON.stringify`, object spread, and the kernel's `redactValue` cannot reach
 * it. That is a structural guarantee rather than a habit: a future logging
 * call that dumps a credential object gets `{"reference":"..."}` and no secret.
 */
export interface IntegrationCredential {
  /** Opaque name the caller asks for. Safe to log; it is not the secret. */
  readonly reference: string;
  readonly scheme: "bearer" | "header" | "basic";
  /** Header name for `scheme: "header"`, e.g. `x-api-key`. */
  readonly headerName?: string | undefined;
  /** The secret. Never logged, never audited, never returned to a caller. */
  readonly value: string;
  /** Hosts this credential may be presented to. Empty means none. */
  readonly allowedHosts: readonly string[];
  readonly expiresAt?: IsoTimestamp | undefined;
}

export type QueuedCallStatus = "queued" | "claimed" | "completed" | "abandoned";

/**
 * A call that failed and was queued for another attempt.
 *
 * Keyed on the idempotency key, not on a generated id, so enqueuing the same
 * logical call twice updates one row rather than creating two. Two queue
 * entries for one effect is how a retry queue turns a transient failure into a
 * duplicated external effect.
 *
 * What is stored is a *description* of the work, not a serialised closure. A
 * scheduler re-invokes the handler registered for `integration` + `operation`.
 * Persisting executable state would make every queued item a compatibility
 * constraint on the next deployment.
 */
export interface QueuedCall {
  readonly idempotencyKey: string;
  readonly integration: string;
  /** The logical operation, e.g. `contract-records.getContract`. */
  readonly operation: string;
  /** Opaque references identifying the target. Never owner personal data. */
  readonly subject: Readonly<Record<string, string>>;
  readonly runId?: Id<"run"> | undefined;
  readonly status: QueuedCallStatus;
  readonly attempts: number;
  readonly firstFailedAt: IsoTimestamp;
  readonly lastAttemptAt: IsoTimestamp;
  readonly nextAttemptAt: IsoTimestamp;
  /** The failure, redacted and truncated. Never a payload. */
  readonly lastError: string;
  readonly claimedAt?: IsoTimestamp | undefined;
  readonly completedAt?: IsoTimestamp | undefined;
}

/**
 * Work handed to a person because the platform would not guess.
 *
 * The distinction from a queued call is the whole point of having both: a
 * queued call is expected to succeed later without anyone's attention, and a
 * parked item is not. Parking says "a human has to look at this", and the item
 * stays on a queue until one does.
 */
export interface ParkedItem {
  /** Natural key, so parking the same work twice does not stack up items. */
  readonly reference: string;
  readonly integration: string;
  readonly operation: string;
  readonly subject: Readonly<Record<string, string>>;
  readonly runId?: Id<"run"> | undefined;
  /** What a person needs to know to pick this up. Non-sensitive. */
  readonly summary: string;
  readonly reason: string;
  readonly parkedAt: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp | undefined;
  readonly resolvedBy?: string | undefined;
  readonly resolution?: string | undefined;
}

/** A credential taken out of service. Consulted on every credential read. */
export interface CredentialRevocation {
  readonly reference: string;
  readonly revokedAt: IsoTimestamp;
  readonly revokedBy: string;
  readonly reason: string;
}
