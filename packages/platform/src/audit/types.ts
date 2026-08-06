import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";

/**
 * The tamper-evident audit log.
 *
 * This is the artifact that makes the product's claim true: "we automate with
 * a record that survives an audit." It is append-only and hash-chained, so
 * removing or altering an entry after the fact breaks verification at that
 * point and every point after it.
 *
 * What goes in: the decision, who or what made it, and the *fingerprints* of
 * the inputs it was made from. What never goes in: raw payloads, owner
 * personal data, or secrets. A compliance reviewer needs to know that a
 * particular decision was made from a particular input, and can fetch the
 * input from the system of record if they are entitled to see it. The audit
 * log's job is to prove the linkage, not to be a second copy of the data.
 */

export type AuditEventType =
  // Governance decisions
  | "authorization.granted"
  | "authorization.denied"
  | "approval.requested"
  | "approval.granted"
  | "approval.rejected"
  | "approval.expired"
  | "approval.consumed"
  | "ceiling.exceeded"
  | "containment.engaged"
  | "containment.released"
  | "screen.blocked"
  | "sandbox.rejected"
  // Work
  | "run.started"
  | "run.ended"
  | "step.recorded"
  | "workflow.instance_started"
  | "workflow.instance_ended"
  | "workflow.definition_published"
  // Model and role governance
  | "model.invoked"
  | "model.degraded"
  | "role.proposed"
  | "role.promoted"
  | "role.reverted"
  | "role.disabled"
  | "evaluation.completed"
  // Knowledge
  | "corpus.ingested"
  | "corpus.ingest_rejected"
  | "knowledge.answer_grounded"
  | "knowledge.answer_refused"
  // Consumer-facing
  | "contact.gate_passed"
  | "contact.gate_blocked"
  | "consent.recorded"
  | "consent.revoked"
  | "document.generated"
  // Improvement loop
  | "improvement.observation_recorded"
  | "improvement.proposal_created"
  | "improvement.proposal_evaluated"
  | "improvement.proposal_approved"
  | "improvement.proposal_rejected"
  | "improvement.applied"
  | "improvement.reverted"
  | "improvement.refused"
  // Identity and data
  | "identity.session_started"
  | "identity.step_up_completed"
  | "subject_rights.request_recorded"
  | "subject_rights.fulfilled"
  | "retention.purged"
  // Discovery
  | "discovery.enrolled"
  | "discovery.revoked"
  | "discovery.erased";

/**
 * One link in the chain.
 *
 * `entryHash` covers `seq`, `previousHash`, and every field of the entry's
 * content. Because it covers `previousHash`, altering entry N invalidates the
 * hash of entry N and therefore of N+1, N+2, and so on to the head — which is
 * what makes deletion and back-dating detectable rather than merely
 * discouraged.
 */
export interface AuditEntry {
  readonly id: Id<"auditEntry">;
  /** 1-based, contiguous, assigned by the store under a lock. */
  readonly seq: number;
  readonly eventType: AuditEventType;
  readonly recordedAt: IsoTimestamp;
  readonly actor: ActorRef;
  /** The run this decision belongs to, when there is one. */
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  /**
   * What the decision was about, as opaque references.
   * e.g. `{ roleId: "rol_...", state: "FL" }`. Never owner personal data.
   */
  readonly subject: Readonly<Record<string, string>>;
  /** Fingerprints of the inputs the decision was made from. */
  readonly inputDigests: Readonly<Record<string, Digest>>;
  /** The decision itself, in non-sensitive structured form. */
  readonly decision: Readonly<Record<string, string | number | boolean>>;
  /** Hash of the previous entry, or the genesis constant for `seq === 1`. */
  readonly previousHash: string;
  readonly entryHash: string;
}

/** The content of an entry, before the chain assigns sequence and hashes. */
export type NewAuditEntry = Omit<
  AuditEntry,
  "id" | "seq" | "previousHash" | "entryHash" | "recordedAt"
> & {
  readonly recordedAt?: IsoTimestamp;
};

export interface AuditFilter {
  readonly eventType?: readonly AuditEventType[];
  readonly runId?: Id<"run">;
  readonly actorId?: string;
  readonly correlationId?: string;
  readonly recordedAfter?: IsoTimestamp;
  readonly recordedBefore?: IsoTimestamp;
  /** Match entries whose `subject` contains every one of these pairs. */
  readonly subject?: Readonly<Record<string, string>>;
  readonly fromSeq?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export type ChainBreakKind =
  | "hash_mismatch"
  | "previous_hash_mismatch"
  | "sequence_gap"
  | "sequence_duplicate"
  | "genesis_mismatch"
  | "timestamp_regression";

export interface ChainBreak {
  readonly kind: ChainBreakKind;
  readonly seq: number;
  readonly entryId?: string;
  readonly detail: string;
}

export interface VerificationResult {
  readonly intact: boolean;
  readonly entriesChecked: number;
  readonly firstSeq: number | null;
  readonly lastSeq: number | null;
  readonly headHash: string | null;
  readonly breaks: readonly ChainBreak[];
}
