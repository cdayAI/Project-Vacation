import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { isDigest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc } from "../record/migrations.js";
import type { IsoTimestamp } from "../record/types.js";
import type { MemoryDb } from "../store/db.js";
import { assertIsoDate, assertOptionalIsoDate, isInForceOn } from "./migrations.js";
import type { ChunkSearch, DocumentFilter, KnowledgeStore, PutDocumentResult } from "./port.js";
import { GLOBAL_JURISDICTION, type Chunk, type Corpus, type SourceDocument } from "./types.js";

/**
 * In-memory governed retrieval.
 *
 * Held to the same contract as the Postgres adapter, including the parts that
 * are inconvenient to fake. Two of them matter enough to do the hard way.
 *
 * `putDocument` takes a per-corpus lock, mirroring the row lock the Postgres
 * adapter takes on the corpus. Without it, two ingestions of the same document
 * would both read "not present yet" and both insert, and the corpus would hold
 * the same authority twice — which in a lexical index does not look like a
 * duplicate, it looks like corroboration.
 *
 * Everything is cloned in and out. A caller holding a reference to a stored
 * chunk must not be able to edit the passage a citation points at after the
 * answer was given.
 */

const CORPORA = "knowledge_corpus";
const DOCUMENTS = "knowledge_document";
const CHUNKS = "knowledge_chunk";

export class MemoryKnowledgeStore implements KnowledgeStore {
  constructor(private readonly db: MemoryDb) {}

  async createCorpus(corpus: Corpus): Promise<Corpus> {
    assertCorpusWritable(corpus);
    return this.db.withLock(CORPORA, async () => {
      const table = this.db.table<Corpus>(CORPORA);
      if (table.has(corpus.id)) {
        throw new InvalidInputError(`Corpus ${corpus.id} already exists.`, "id");
      }
      for (const existing of table.values()) {
        if (existing.name === corpus.name) {
          throw new InvalidInputError(
            `Corpus name "${corpus.name}" is already in use by ${existing.id}. Names are how operators and workflows refer to a body of authority, so two corpora cannot share one.`,
            "name",
          );
        }
      }
      table.set(corpus.id, structuredClone(corpus));
      return structuredClone(corpus);
    });
  }

  async getCorpus(id: Id<"corpus">): Promise<Corpus | null> {
    const found = this.db.table<Corpus>(CORPORA).get(id);
    return found ? structuredClone(found) : null;
  }

  async requireCorpus(id: Id<"corpus">): Promise<Corpus> {
    const found = await this.getCorpus(id);
    if (!found) {
      // Refused rather than returned empty. A caller retrieving from a corpus
      // that is not there would otherwise get "no results", which reads as "the
      // authority says nothing about this" — the opposite of the truth.
      throw new DeniedError("record.unavailable", `Corpus ${id} is not in the knowledge store.`, {
        corpusId: id,
      });
    }
    return found;
  }

  async findCorpusByName(name: string): Promise<Corpus | null> {
    for (const corpus of this.db.rows<Corpus>(CORPORA)) {
      if (corpus.name === name) return structuredClone(corpus);
    }
    return null;
  }

  async listCorpora(): Promise<readonly Corpus[]> {
    return this.db
      .rows<Corpus>(CORPORA)
      .slice()
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map((corpus) => structuredClone(corpus));
  }

  async touchCorpusReview(id: Id<"corpus">, reviewedAt: IsoTimestamp): Promise<Corpus> {
    assertIsoUtc("reviewedAt", reviewedAt);
    return this.db.withLock(`knowledge:corpus:${id}`, async () => {
      const table = this.db.table<Corpus>(CORPORA);
      const current = table.get(id);
      if (!current) {
        throw new DeniedError("record.unavailable", `Corpus ${id} is not in the knowledge store.`, {
          corpusId: id,
        });
      }
      // Reviews only move forward. Back-dating one would extend the cadence
      // window backwards and could mark a stale corpus fresh by accident.
      if (reviewedAt < current.lastReviewedAt) {
        throw new InvalidInputError(
          `Corpus ${id} was last reviewed at ${current.lastReviewedAt}; a review cannot be recorded earlier, at ${reviewedAt}.`,
          "reviewedAt",
        );
      }
      const next: Corpus = { ...current, lastReviewedAt: reviewedAt };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async putDocument(
    document: SourceDocument,
    chunks: readonly Chunk[],
  ): Promise<PutDocumentResult> {
    assertDocumentWritable(document, chunks);

    return this.db.withLock(`knowledge:documents:${document.corpusId}`, async () => {
      if (!this.db.table<Corpus>(CORPORA).has(document.corpusId)) {
        throw new DeniedError(
          "record.unavailable",
          `Cannot ingest into corpus ${document.corpusId}: no such corpus.`,
          { corpusId: document.corpusId },
        );
      }

      const documents = this.db.table<SourceDocument>(DOCUMENTS);

      // Idempotency, inside the lock. Identical content in the same corpus is a
      // replay of an ingestion that already happened — most often a retry after
      // a crash — and must not become a second copy.
      for (const existing of documents.values()) {
        if (
          existing.corpusId === document.corpusId &&
          existing.contentDigest === document.contentDigest
        ) {
          return { document: structuredClone(existing), created: false };
        }
      }

      if (documents.has(document.id)) {
        throw new InvalidInputError(`Document ${document.id} already exists.`, "id");
      }

      const chunkTable = this.db.table<Chunk>(CHUNKS);
      for (const chunk of chunks) {
        if (chunkTable.has(chunk.id)) {
          throw new InvalidInputError(`Chunk ${chunk.id} already exists.`, "id");
        }
      }

      documents.set(document.id, structuredClone(document));
      for (const chunk of chunks) chunkTable.set(chunk.id, structuredClone(chunk));
      return { document: structuredClone(document), created: true };
    });
  }

  async activateDocument(
    id: Id<"document">,
    receiptId: Id<"auditEntry">,
  ): Promise<SourceDocument> {
    if (typeof receiptId !== "string" || receiptId.length === 0) {
      throw new InvalidInputError(
        "Activating a document requires the id of the audit entry that recorded its ingestion. A document with no receipt must stay unreachable.",
        "receiptId",
      );
    }
    return this.db.withLock(`knowledge:document:${id}`, async () => {
      const table = this.db.table<SourceDocument>(DOCUMENTS);
      const current = table.get(id);
      if (!current) {
        throw new DeniedError(
          "record.unavailable",
          `Document ${id} is not in the knowledge store.`,
          { documentId: id },
        );
      }
      // Idempotent for the same receipt so a retried activation is not an
      // error; refused for a different one, because re-pointing a document at
      // another receipt would break the link between what was approved and what
      // is being cited.
      if (current.status === "active") {
        if (current.receiptId === receiptId) return structuredClone(current);
        throw new InvalidInputError(
          `Document ${id} is already active under receipt ${String(current.receiptId)} and cannot be re-pointed at ${receiptId}.`,
          "receiptId",
        );
      }
      const next: SourceDocument = { ...current, status: "active", receiptId };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async getDocument(id: Id<"document">): Promise<SourceDocument | null> {
    const found = this.db.table<SourceDocument>(DOCUMENTS).get(id);
    return found ? structuredClone(found) : null;
  }

  async listDocuments(filter: DocumentFilter = {}): Promise<readonly SourceDocument[]> {
    return this.db
      .rows<SourceDocument>(DOCUMENTS)
      .filter((document) => matchesDocumentFilter(document, filter))
      .map((document) => structuredClone(document));
  }

  async getChunk(id: Id<"chunk">): Promise<Chunk | null> {
    const found = this.db.table<Chunk>(CHUNKS).get(id);
    return found ? structuredClone(found) : null;
  }

  async listChunks(documentId: Id<"document">): Promise<readonly Chunk[]> {
    return this.db
      .rows<Chunk>(CHUNKS)
      .filter((chunk) => chunk.documentId === documentId)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((chunk) => structuredClone(chunk));
  }

  async searchChunks(query: ChunkSearch): Promise<readonly Chunk[]> {
    assertIsoDate("asOf", query.asOf);
    if (query.corpusIds.length === 0) return [];

    const scope = new Set<string>(query.corpusIds);
    const eligible = new Set<string>();
    for (const document of this.db.rows<SourceDocument>(DOCUMENTS)) {
      if (!scope.has(document.corpusId)) continue;
      // Only active documents. A pending one is a document whose ingestion
      // receipt never landed, and answering from it would be answering from
      // authority the audit log does not know exists.
      if (document.status !== "active") continue;
      if (!isInForceOn(document.effectiveFrom, document.effectiveTo, query.asOf)) continue;
      if (!matchesJurisdiction(document.jurisdiction, query.jurisdictions)) continue;
      eligible.add(document.id);
    }

    return this.db
      .rows<Chunk>(CHUNKS)
      .filter((chunk) => eligible.has(chunk.documentId))
      .sort(compareChunks)
      .map((chunk) => structuredClone(chunk));
  }
}

/** Convenience factory matching the Postgres adapter's shape. */
export function createMemoryKnowledgeStore(db: MemoryDb): MemoryKnowledgeStore {
  return new MemoryKnowledgeStore(db);
}

/**
 * Deterministic ordering for candidate passages.
 *
 * Retrieval sorts by score, and ties are broken by this order. Without a total
 * order over the candidates, two runs of the seeded demo could rank two
 * equally-scored passages differently and cite different sources for the same
 * question.
 */
export function compareChunks(left: Chunk, right: Chunk): number {
  if (left.documentId !== right.documentId) return left.documentId < right.documentId ? -1 : 1;
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Is a document's jurisdiction eligible for a query restricted to `wanted`?
 *
 * Material marked global applies everywhere, so a query scoped to Florida must
 * still see the company-wide procedure. Shared by both adapters so a document
 * cannot be visible through one and invisible through the other.
 */
export function matchesJurisdiction(
  jurisdiction: string,
  wanted: readonly string[] | undefined,
): boolean {
  if (!wanted || wanted.length === 0) return true;
  if (jurisdiction === GLOBAL_JURISDICTION) return true;
  return wanted.includes(jurisdiction);
}

export function matchesDocumentFilter(
  document: SourceDocument,
  filter: DocumentFilter,
): boolean {
  if (filter.corpusId !== undefined && document.corpusId !== filter.corpusId) return false;
  if (filter.status !== undefined && document.status !== filter.status) return false;
  if (filter.jurisdiction !== undefined && document.jurisdiction !== filter.jurisdiction) {
    return false;
  }
  return true;
}

export function assertCorpusWritable(corpus: Corpus): void {
  if (typeof corpus.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(corpus.name)) {
    throw new InvalidInputError(
      `Corpus name "${String(corpus.name)}" must be lower_snake_case, e.g. "rescission_statutes".`,
      "name",
    );
  }
  if (typeof corpus.owner !== "string" || corpus.owner.trim().length === 0) {
    throw new InvalidInputError(
      "A corpus needs a named accountable owner. Authority nobody owns is authority nobody reviews.",
      "owner",
    );
  }
  if (!Number.isInteger(corpus.reviewCadenceDays) || corpus.reviewCadenceDays < 1) {
    throw new InvalidInputError(
      `Review cadence must be a whole number of days, at least 1 — received: ${String(corpus.reviewCadenceDays)}`,
      "reviewCadenceDays",
    );
  }
  assertIsoUtc("lastReviewedAt", corpus.lastReviewedAt);
  assertIsoUtc("createdAt", corpus.createdAt);
}

/**
 * Everything both adapters check before a document is allowed to land.
 *
 * Shared rather than duplicated: the in-memory adapter is supposed to be as
 * strict as Postgres, and the cheapest way to guarantee that is for both to run
 * the same function. The Postgres CHECK constraints in `migrations.ts` restate
 * the subset a database can express, so a write that bypasses this code still
 * fails.
 */
export function assertDocumentWritable(
  document: SourceDocument,
  chunks: readonly Chunk[],
): void {
  if (document.status !== "pending") {
    // Activation is a separate, receipted operation. Allowing a document to be
    // written straight to active would let a caller skip the audit entry that
    // is the only reason we know where a citation came from.
    throw new InvalidInputError(
      `A document must be stored as "pending" and activated once its audit receipt exists; received status "${document.status}".`,
      "status",
    );
  }
  if (document.receiptId !== undefined) {
    throw new InvalidInputError(
      "A pending document must not carry a receipt id; the receipt is attached at activation.",
      "receiptId",
    );
  }
  if (typeof document.title !== "string" || document.title.trim().length === 0) {
    throw new InvalidInputError("A source document needs a title.", "title");
  }
  if (typeof document.version !== "string" || document.version.trim().length === 0) {
    throw new InvalidInputError(
      "A source document needs a version. An unversioned document cannot be effective-dated, and an answer citing it could not say which text was in force.",
      "version",
    );
  }
  if (typeof document.jurisdiction !== "string" || document.jurisdiction.trim().length === 0) {
    throw new InvalidInputError("A source document needs a jurisdiction.", "jurisdiction");
  }
  if (typeof document.ingestedBy !== "string" || document.ingestedBy.trim().length === 0) {
    throw new InvalidInputError("A source document must record who ingested it.", "ingestedBy");
  }
  if (typeof document.sourceUri !== "string" || document.sourceUri.trim().length === 0) {
    throw new InvalidInputError(
      "A source document needs a source URI so a reviewer can reach the original.",
      "sourceUri",
    );
  }
  assertIsoDate("effectiveFrom", document.effectiveFrom);
  assertOptionalIsoDate("effectiveTo", document.effectiveTo);
  if (document.effectiveTo !== null && document.effectiveTo < document.effectiveFrom) {
    throw new InvalidInputError(
      `Effective window ends (${document.effectiveTo}) before it starts (${document.effectiveFrom}); such a document is in force on no date at all.`,
      "effectiveTo",
    );
  }
  assertIsoUtc("ingestedAt", document.ingestedAt);
  if (!isDigest(document.contentDigest)) {
    throw new InvalidInputError(
      `Document contentDigest must be a sha256 digest, received: ${String(document.contentDigest)}`,
      "contentDigest",
    );
  }

  if (chunks.length === 0) {
    throw new InvalidInputError(
      "A document with no passages is authority nothing can cite; ingestion of an empty document is refused.",
      "chunks",
    );
  }
  if (document.chunkCount !== chunks.length) {
    throw new InvalidInputError(
      `Document declares ${document.chunkCount} passages but ${chunks.length} were supplied.`,
      "chunkCount",
    );
  }

  chunks.forEach((chunk, index) => {
    if (chunk.documentId !== document.id) {
      throw new InvalidInputError(
        `Chunk ${chunk.id} names document ${chunk.documentId}, not ${document.id}.`,
        "documentId",
      );
    }
    if (chunk.corpusId !== document.corpusId) {
      throw new InvalidInputError(
        `Chunk ${chunk.id} names corpus ${chunk.corpusId}, not ${document.corpusId}.`,
        "corpusId",
      );
    }
    if (chunk.ordinal !== index) {
      throw new InvalidInputError(
        `Chunk ordinals must run contiguously from 0; expected ${index}, received ${chunk.ordinal}.`,
        "ordinal",
      );
    }
    if (typeof chunk.text !== "string" || chunk.text.trim().length === 0) {
      throw new InvalidInputError(`Chunk ${chunk.id} has no text.`, "text");
    }
    if (!isDigest(chunk.digest)) {
      throw new InvalidInputError(
        `Chunk ${chunk.id} digest must be a sha256 digest, received: ${String(chunk.digest)}`,
        "digest",
      );
    }
    assertProvenanceMatches(chunk, document);
  });
}

/**
 * The provenance carried by a passage must describe the document it came from.
 *
 * Provenance is denormalised so a citation needs no join, and denormalised data
 * that is allowed to disagree with its source is worse than a join: it produces
 * a citation that names a version, a jurisdiction, or an effective window the
 * document never had, and it does so convincingly.
 */
function assertProvenanceMatches(chunk: Chunk, document: SourceDocument): void {
  const provenance = chunk.provenance;
  if (provenance === null || typeof provenance !== "object") {
    throw new InvalidInputError(
      `Chunk ${chunk.id} carries no provenance. A passage that cannot be traced to a source document, version, and effective date is unusable in a regulated answer and is refused at the store.`,
      "provenance",
    );
  }

  const mismatches: string[] = [];
  if (provenance.documentId !== document.id) mismatches.push("documentId");
  if (provenance.corpusId !== document.corpusId) mismatches.push("corpusId");
  if (provenance.documentTitle !== document.title) mismatches.push("documentTitle");
  if (provenance.version !== document.version) mismatches.push("version");
  if (provenance.effectiveFrom !== document.effectiveFrom) mismatches.push("effectiveFrom");
  if (provenance.effectiveTo !== document.effectiveTo) mismatches.push("effectiveTo");
  if (provenance.jurisdiction !== document.jurisdiction) mismatches.push("jurisdiction");
  if (provenance.ingestedBy !== document.ingestedBy) mismatches.push("ingestedBy");
  if (provenance.ingestedAt !== document.ingestedAt) mismatches.push("ingestedAt");
  if (provenance.sourceUri !== document.sourceUri) mismatches.push("sourceUri");
  if (provenance.contentDigest !== document.contentDigest) mismatches.push("contentDigest");

  if (mismatches.length > 0) {
    throw new InvalidInputError(
      `Chunk ${chunk.id} provenance disagrees with its document on: ${mismatches.join(", ")}. A citation assembled from it would name something the document never said.`,
      "provenance",
    );
  }
}
