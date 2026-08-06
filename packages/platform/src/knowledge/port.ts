import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type { IsoDate } from "../timeline/types.js";
import type { Chunk, Corpus, DocumentStatus, SourceDocument } from "./types.js";

/**
 * Persistence port for governed retrieval.
 *
 * Two operations here carry requirements that cannot be met by a read followed
 * by a write in the caller, so they are expressed as single atomic operations
 * and implemented as such in both adapters.
 *
 *   - `putDocument` lands a document and all of its passages together. A
 *     partial write would leave a document whose text is half in the corpus,
 *     and retrieval would answer from the half that made it — silently, with a
 *     citation that looks complete.
 *
 *   - `putDocument` is also the idempotency point. Re-running the same
 *     ingestion — same corpus, same content, same version, same effective start
 *     — returns the existing document rather than creating a second copy, so a
 *     retry after a crash does not double the weight of that authority in every
 *     later search. The `created` flag tells the caller which happened.
 *     Unchanged text under a *different* version or effective date is a
 *     different document, because it is: the same words can be republished with
 *     a new window, and a citation has to name the right one.
 *
 * Documents are written once and then only ever flipped from `pending` to
 * `active`. There is no update path for text, effective dates, or provenance,
 * and no delete path at all: a superseded document is a new document with a new
 * effective window, which is the only shape that keeps "what did this say last
 * March" answerable.
 *
 * A read that cannot be served must raise rather than return an empty result.
 * "This corpus has nothing on that" and "we could not reach the corpus" lead to
 * opposite actions, and an answer built on the second while believing the first
 * is exactly the failure this platform refuses to have.
 */

export interface PutDocumentResult {
  readonly document: SourceDocument;
  /** False when identical content was already present and was returned instead. */
  readonly created: boolean;
}

export interface DocumentFilter {
  readonly corpusId?: Id<"corpus"> | undefined;
  readonly status?: DocumentStatus | undefined;
  readonly jurisdiction?: string | undefined;
}

/**
 * A point-in-time candidate lookup.
 *
 * The store filters; it does not score. Scoring lives above the port so that
 * both adapters rank identically and so that swapping in a different retrieval
 * strategy later is a change in one file rather than in every adapter.
 *
 * `corpusIds` is required and never inferred. The retriever resolves which
 * corpora the actor may read before it gets here, which keeps entitlement
 * decisions in one place instead of duplicated into each adapter's SQL.
 */
export interface ChunkSearch {
  readonly corpusIds: readonly Id<"corpus">[];
  /** Only passages whose document version was in force on this civil date. */
  readonly asOf: IsoDate;
  /** Optional jurisdiction filter; global material is always eligible. */
  readonly jurisdictions?: readonly string[] | undefined;
}

export interface KnowledgeStore {
  createCorpus(corpus: Corpus): Promise<Corpus>;
  getCorpus(id: Id<"corpus">): Promise<Corpus | null>;
  /** @throws {DeniedError} when the corpus is absent or unreachable. */
  requireCorpus(id: Id<"corpus">): Promise<Corpus>;
  findCorpusByName(name: string): Promise<Corpus | null>;
  listCorpora(): Promise<readonly Corpus[]>;
  /** Record that a review happened. The only mutable field on a corpus. */
  touchCorpusReview(id: Id<"corpus">, reviewedAt: IsoTimestamp): Promise<Corpus>;

  /** Atomically store a document and its passages, or return the existing one. */
  putDocument(document: SourceDocument, chunks: readonly Chunk[]): Promise<PutDocumentResult>;
  /**
   * Make a stored document retrievable, naming the audit entry that recorded it.
   *
   * Separate from `putDocument` because the receipt has to exist first. Until
   * this succeeds the document is inert.
   */
  activateDocument(id: Id<"document">, receiptId: Id<"auditEntry">): Promise<SourceDocument>;
  getDocument(id: Id<"document">): Promise<SourceDocument | null>;
  listDocuments(filter?: DocumentFilter): Promise<readonly SourceDocument[]>;

  getChunk(id: Id<"chunk">): Promise<Chunk | null>;
  listChunks(documentId: Id<"document">): Promise<readonly Chunk[]>;

  /** Every active passage in scope and in force on `asOf`. Unscored. */
  searchChunks(query: ChunkSearch): Promise<readonly Chunk[]>;
}
