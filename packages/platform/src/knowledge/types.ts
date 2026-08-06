import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";
import type { IsoDate } from "../timeline/types.js";

/**
 * Governed retrieval: the shapes.
 *
 * The knowledge layer answers questions from curated authority — state
 * rescission statutes, HOA governing documents, disclosure templates, contact
 * policy, internal procedure. Three properties of these types are the whole
 * point of the module, and each is expressed as a type rule rather than a
 * convention someone has to remember.
 *
 * *Provenance is not optional.* A retrieved passage without its source
 * document, version, effective date, jurisdiction, and ingestion trail is
 * unusable in a regulated answer — a compliance reviewer cannot act on a
 * sentence they cannot trace. So `Chunk.provenance` is a required field of a
 * required type, and every citation is assembled from it without a join. A
 * chunk that lost its provenance would not compile, would not store (the
 * migration checks the same fields), and would not retrieve.
 *
 * *Authority is effective-dated.* Documents carry `effectiveFrom` and
 * `effectiveTo` as civil dates, because a statute takes effect on a date, not
 * at a UTC instant. The question a compliance reviewer actually asks is "what
 * did the rule say on the date of *that* contract", so every query carries an
 * `asOf` and every retrieval is a point-in-time read.
 *
 * *Citations carry evidence, the audit log carries fingerprints.* A `Citation`
 * holds the excerpt so a reviewer can read the passage; the audit record holds
 * only digests. Those are different surfaces with different retention rules and
 * they are deliberately not the same object.
 */

/**
 * Sensitivity of the material in a corpus.
 *
 * Drives what may be shown and where an answer may be surfaced. `privileged`
 * exists because attorney-client material genuinely does live alongside
 * operational procedure in a company this size, and losing track of which is
 * which is a waiver risk rather than a tidiness problem.
 */
export const CLASSIFICATIONS = ["public", "internal", "confidential", "privileged"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/**
 * Jurisdiction marker for material that applies everywhere.
 *
 * A company-wide procedure is in force in Florida and in Nevada alike, so a
 * query scoped to a state must still see it. Filtering treats this value as
 * always eligible; it is a constant rather than an empty string so that
 * "applies everywhere" and "nobody filled the field in" cannot be confused.
 */
export const GLOBAL_JURISDICTION = "GLOBAL";

/**
 * A curated body of authority with a named owner and a review cadence.
 *
 * Ownership and cadence are on the corpus rather than tracked in a spreadsheet
 * because staleness is a governance fact the platform has to be able to assert:
 * `freshness.ts` reads these two fields to decide whether the console shows a
 * warning and whether `answer.ts` refuses a regulated question outright.
 */
export interface Corpus {
  readonly id: Id<"corpus">;
  /** Stable machine name, e.g. `rescission_statutes`. Unique. */
  readonly name: string;
  /** Accountable team or role. Never a personal email address. */
  readonly owner: string;
  /** Days between required reviews. A corpus reviewed less often is stale. */
  readonly reviewCadenceDays: number;
  readonly lastReviewedAt: IsoTimestamp;
  /**
   * Data scopes a reader must hold, matching the `scope:` role convention the
   * authorization chokepoint uses. Empty means every authenticated reader.
   */
  readonly accessScope: readonly string[];
  readonly classification: Classification;
  readonly createdAt: IsoTimestamp;
}

export type NewCorpus = Omit<Corpus, "id" | "createdAt"> & {
  readonly id?: Id<"corpus">;
  readonly createdAt?: IsoTimestamp;
};

/**
 * Whether a document's passages may be retrieved.
 *
 * `pending` is the state between "written to the store" and "the audit receipt
 * for its ingestion committed". Retrieval only ever sees `active`, which is how
 * the platform keeps its promise that nothing enters the corpus unrecorded: if
 * the receipt cannot be written, the document is left where no query will find
 * it rather than quietly becoming authority nobody approved.
 */
export type DocumentStatus = "pending" | "active";

/** How the boundary screen judged the document at ingestion. */
export type IngestScreenVerdict = "clean" | "suspicious";

/**
 * One version of one source document.
 *
 * Documents are never edited. A corrected or superseded text is a new document
 * with its own version and its own effective window, which is what makes
 * "what did this say last March" answerable at all.
 */
export interface SourceDocument {
  readonly id: Id<"document">;
  readonly corpusId: Id<"corpus">;
  readonly title: string;
  /** Publisher's version label, e.g. `2024-rev-B` or `FL@3`. */
  readonly version: string;
  /** First civil date on which this version was in force, inclusive. */
  readonly effectiveFrom: IsoDate;
  /** Last civil date on which it was in force, inclusive. `null` = still in force. */
  readonly effectiveTo: IsoDate | null;
  /** `FL`, `NV`, or {@link GLOBAL_JURISDICTION}. */
  readonly jurisdiction: string;
  readonly ingestedBy: string;
  readonly ingestedAt: IsoTimestamp;
  /** Where the text came from, for a reviewer who wants the original. */
  readonly sourceUri: string;
  /** Digest of the stored (screened and redacted) text. */
  readonly contentDigest: Digest;
  readonly status: DocumentStatus;
  readonly screenVerdict: IngestScreenVerdict;
  readonly chunkCount: number;
  /** Audit entry that recorded the ingestion. Present once `status` is active. */
  readonly receiptId?: Id<"auditEntry"> | undefined;
}

/**
 * Everything a citation needs, frozen at the moment of ingestion.
 *
 * Denormalised onto every chunk on purpose. A citation is evidence, and
 * evidence assembled by joining against a mutable row is evidence that can
 * change after it was relied on. Recomputing this from the document at read
 * time would also mean a reader could not verify a stored answer against what
 * the passage said when it was cited.
 */
export interface Provenance {
  readonly corpusId: Id<"corpus">;
  readonly documentId: Id<"document">;
  readonly documentTitle: string;
  readonly version: string;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
  readonly jurisdiction: string;
  readonly ingestedBy: string;
  readonly ingestedAt: IsoTimestamp;
  readonly sourceUri: string;
  readonly contentDigest: Digest;
}

/** A retrievable passage. */
export interface Chunk {
  readonly id: Id<"chunk">;
  readonly documentId: Id<"document">;
  readonly corpusId: Id<"corpus">;
  /** Position within the document, from 0. Lets a reviewer read in order. */
  readonly ordinal: number;
  readonly text: string;
  readonly digest: Digest;
  /** Required. A passage that cannot be traced cannot be used. */
  readonly provenance: Provenance;
}

/** What retrieval was asked for. */
export interface RetrievalQuery {
  readonly text: string;
  /**
   * The date the answer must be true as of.
   *
   * Required, with no default. A default of "today" would silently answer a
   * question about a 2019 contract from the 2026 statute, which is the exact
   * error this module exists to prevent.
   */
  readonly asOf: IsoDate;
  readonly actor: ActorRef;
  /** Restrict to these corpora. Omitted means every corpus the actor may read. */
  readonly corpusIds?: readonly Id<"corpus">[] | undefined;
  /** Restrict to these jurisdictions. {@link GLOBAL_JURISDICTION} is always eligible. */
  readonly jurisdictions?: readonly string[] | undefined;
  /** Maximum passages to return. */
  readonly limit?: number | undefined;
}

/** One scored passage. */
export interface RetrievedChunk {
  readonly chunk: Chunk;
  /** Normalised to 0..1 so a relevance floor means the same thing across queries. */
  readonly score: number;
  /** The unnormalised BM25 score, kept for debugging and for the console. */
  readonly rawScore: number;
  /** Fraction of the query's distinct terms this passage contains, 0..1. */
  readonly coverage: number;
  readonly matchedTerms: readonly string[];
}

export interface RetrievalResult {
  readonly asOf: IsoDate;
  /** Terms actually searched on, after stopword removal and normalisation. */
  readonly terms: readonly string[];
  readonly corpusIds: readonly Id<"corpus">[];
  /** Passages in force on `asOf` that were scored. */
  readonly candidatesConsidered: number;
  /**
   * Passages the store returned that were **not** in force on `asOf`.
   *
   * Always zero against a correct adapter. Non-zero means the store's
   * effective-date filter disagreed with the provenance on the chunk, and the
   * retriever dropped them rather than trusting either — see `retrieve.ts`.
   */
  readonly excludedOutOfWindow: number;
  readonly results: readonly RetrievedChunk[];
}

/**
 * A pointer a compliance reviewer can follow from an answer to the passage it
 * came from, with everything needed to judge whether it applies.
 */
export interface Citation {
  readonly chunkId: Id<"chunk">;
  readonly documentId: Id<"document">;
  readonly corpusId: Id<"corpus">;
  readonly documentTitle: string;
  readonly version: string;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
  readonly jurisdiction: string;
  readonly sourceUri: string;
  readonly ingestedBy: string;
  readonly ingestedAt: IsoTimestamp;
  readonly contentDigest: Digest;
  readonly chunkDigest: Digest;
  /** The passage itself, so the reviewer reads the source and not a summary. */
  readonly excerpt: string;
  readonly score: number;
}

/**
 * One statement, with the passages it rests on.
 *
 * `citations` is never empty. A claim without a citation is an improvisation,
 * and this module does not produce those.
 */
export interface Claim {
  readonly text: string;
  readonly citations: readonly Citation[];
}

/**
 * The evidence set for a question.
 *
 * Note what this is *not*: it is not prose composed by a model. This module
 * retrieves and cites; it never writes. A caller that wants a narrative answer
 * composes one from `claims` under its own governance, and may cite only what
 * is in `citations` — which is why every citation carries its chunk id.
 */
export interface GroundedAnswer {
  /** The question after screening and redaction, never the raw input. */
  readonly question: string;
  readonly asOf: IsoDate;
  readonly answeredAt: IsoTimestamp;
  readonly claims: readonly Claim[];
  /** Every citation across every claim, best first. */
  readonly citations: readonly Citation[];
  /** Highest normalised score among the citations, 0..1. */
  readonly confidence: number;
  /** True when a cited corpus is past its review cadence but was allowed through. */
  readonly staleAuthority: boolean;
  readonly staleCorpora: readonly Id<"corpus">[];
  readonly candidatesConsidered: number;
  readonly relevanceFloor: number;
  /** Fingerprint of the answer, recorded in the audit log in place of its content. */
  readonly answerDigest: Digest;
}

/** Review status of one corpus, for the console and for the staleness gate. */
export interface CorpusFreshness {
  readonly corpusId: Id<"corpus">;
  readonly name: string;
  readonly owner: string;
  readonly classification: Classification;
  readonly reviewCadenceDays: number;
  readonly lastReviewedAt: IsoTimestamp;
  /** When the next review falls due. */
  readonly dueAt: IsoTimestamp;
  /** Whole days past due. Zero when the corpus is within cadence. */
  readonly daysOverdue: number;
  readonly stale: boolean;
}
