import { DeniedError, InvalidInputError, InvariantError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc } from "../record/migrations.js";
import type { IsoTimestamp } from "../record/types.js";
import { storeUnavailable, type Db } from "../store/db.js";
import { assertIsoDate } from "./migrations.js";
import type { ChunkSearch, DocumentFilter, KnowledgeStore, PutDocumentResult } from "./port.js";
// Shared with the in-memory adapter so both apply exactly the same rules before
// anything lands. They live there because they are storage-agnostic and that is
// the simpler of the two files; duplicating them would invite drift, and the
// drift would show up as a citation that is valid in test and wrong in
// production.
import { assertCorpusWritable, assertDocumentWritable } from "./store.memory.js";
import {
  GLOBAL_JURISDICTION,
  type Chunk,
  type Classification,
  type Corpus,
  type DocumentStatus,
  type IngestScreenVerdict,
  type Provenance,
  type SourceDocument,
} from "./types.js";

/**
 * Postgres governed retrieval.
 *
 * `putDocument` runs inside a transaction that first takes a row lock on the
 * corpus (`SELECT ... FOR UPDATE`). Ingestion into one corpus therefore
 * serialises across every process in the deployment, which is what makes the
 * check-then-insert for identical content correct rather than merely usually
 * correct. The unique index over `(corpus_id, content_digest)` is the
 * unconditional backstop: if the lock were ever wrong, the second writer fails
 * its INSERT instead of silently doubling that document's weight in every later
 * search.
 *
 * The lock is on the corpus rather than the whole table so that ingesting into
 * the Florida statute corpus does not queue behind ingesting into the HOA
 * document corpus.
 *
 * `searchChunks` deliberately returns every candidate passage in force on the
 * asked-for date rather than a pre-filtered subset. Scoring happens above the
 * port (see `retrieve.ts`), and the collection statistics it needs — how many
 * passages there are, how many contain a term — are only correct if the whole
 * effective-dated slice is present. That is affordable for curated corpora of
 * the size this platform serves. When it stops being affordable, this query is
 * where a `tsvector` GIN prefilter or a vector index goes, behind the same port
 * and without touching the answer contract.
 */

type CorpusRow = {
  id: string;
  name: string;
  owner: string;
  classification: string;
  access_scope: string[];
  review_cadence_days: number;
  last_reviewed_at: string;
  created_at: string;
};

type DocumentRow = {
  id: string;
  corpus_id: string;
  title: string;
  version: string;
  status: string;
  effective_from: string;
  effective_to: string | null;
  jurisdiction: string;
  ingested_by: string;
  ingested_at: string;
  source_uri: string;
  content_digest: string;
  screen_verdict: string;
  chunk_count: number;
  receipt_id: string | null;
};

type ChunkRow = {
  id: string;
  document_id: string;
  corpus_id: string;
  ordinal: number;
  body: string;
  digest: string;
  provenance: Provenance;
};

const CORPUS_COLUMNS = `id, name, owner, classification, access_scope, review_cadence_days,
  last_reviewed_at, created_at`;

const DOCUMENT_COLUMNS = `id, corpus_id, title, version, status, effective_from, effective_to,
  jurisdiction, ingested_by, ingested_at, source_uri, content_digest, screen_verdict,
  chunk_count, receipt_id`;

const CHUNK_COLUMNS = `id, document_id, corpus_id, ordinal, body, digest, provenance`;

export class PgKnowledgeStore implements KnowledgeStore {
  constructor(private readonly db: Db) {}

  async createCorpus(corpus: Corpus): Promise<Corpus> {
    assertCorpusWritable(corpus);
    const rows = await this.guard("createCorpus", () =>
      this.db.query<CorpusRow>(
        `INSERT INTO knowledge_corpus (${CORPUS_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${CORPUS_COLUMNS}`,
        [
          corpus.id,
          corpus.name,
          corpus.owner,
          corpus.classification,
          JSON.stringify([...corpus.accessScope]),
          corpus.reviewCadenceDays,
          corpus.lastReviewedAt,
          corpus.createdAt,
        ],
      ),
    );
    const row = rows[0];
    if (!row) throw new InvariantError(`Corpus ${corpus.id} was not written.`);
    return toCorpus(row);
  }

  async getCorpus(id: Id<"corpus">): Promise<Corpus | null> {
    const rows = await this.guard("getCorpus", () =>
      this.db.query<CorpusRow>(`SELECT ${CORPUS_COLUMNS} FROM knowledge_corpus WHERE id = $1`, [id]),
    );
    const row = rows[0];
    return row ? toCorpus(row) : null;
  }

  async requireCorpus(id: Id<"corpus">): Promise<Corpus> {
    const found = await this.getCorpus(id);
    if (!found) {
      throw new DeniedError("record.unavailable", `Corpus ${id} is not in the knowledge store.`, {
        corpusId: id,
      });
    }
    return found;
  }

  async findCorpusByName(name: string): Promise<Corpus | null> {
    const rows = await this.guard("findCorpusByName", () =>
      this.db.query<CorpusRow>(`SELECT ${CORPUS_COLUMNS} FROM knowledge_corpus WHERE name = $1`, [
        name,
      ]),
    );
    const row = rows[0];
    return row ? toCorpus(row) : null;
  }

  async listCorpora(): Promise<readonly Corpus[]> {
    const rows = await this.guard("listCorpora", () =>
      this.db.query<CorpusRow>(`SELECT ${CORPUS_COLUMNS} FROM knowledge_corpus ORDER BY name ASC`),
    );
    return rows.map(toCorpus);
  }

  async touchCorpusReview(id: Id<"corpus">, reviewedAt: IsoTimestamp): Promise<Corpus> {
    assertIsoUtc("reviewedAt", reviewedAt);
    return this.guard("touchCorpusReview", () =>
      this.db.transaction(async (tx) => {
        const current = (
          await tx.query<CorpusRow>(
            `SELECT ${CORPUS_COLUMNS} FROM knowledge_corpus WHERE id = $1 FOR UPDATE`,
            [id],
          )
        )[0];
        if (!current) {
          throw new DeniedError(
            "record.unavailable",
            `Corpus ${id} is not in the knowledge store.`,
            { corpusId: id },
          );
        }
        // Reviews only move forward; see the in-memory adapter for why.
        if (reviewedAt < current.last_reviewed_at) {
          throw new InvalidInputError(
            `Corpus ${id} was last reviewed at ${current.last_reviewed_at}; a review cannot be recorded earlier, at ${reviewedAt}.`,
            "reviewedAt",
          );
        }
        const updated = (
          await tx.query<CorpusRow>(
            `UPDATE knowledge_corpus SET last_reviewed_at = $2 WHERE id = $1
             RETURNING ${CORPUS_COLUMNS}`,
            [id, reviewedAt],
          )
        )[0];
        if (!updated) throw new InvariantError(`Corpus ${id} review was not recorded.`);
        return toCorpus(updated);
      }),
    );
  }

  async putDocument(
    document: SourceDocument,
    chunks: readonly Chunk[],
  ): Promise<PutDocumentResult> {
    assertDocumentWritable(document, chunks);

    return this.guard("putDocument", () =>
      this.db.transaction(async (tx) => {
        // Serialise ingestion into this corpus. Without the lock two identical
        // ingestions would both find nothing and both insert; one would then
        // fail the unique index, but only after doing the work, and the caller
        // that lost would see a store error rather than the replay it actually
        // performed.
        const corpus = (
          await tx.query<{ id: string }>(
            "SELECT id FROM knowledge_corpus WHERE id = $1 FOR UPDATE",
            [document.corpusId],
          )
        )[0];
        if (!corpus) {
          throw new DeniedError(
            "record.unavailable",
            `Cannot ingest into corpus ${document.corpusId}: no such corpus.`,
            { corpusId: document.corpusId },
          );
        }

        const existing = (
          await tx.query<DocumentRow>(
            `SELECT ${DOCUMENT_COLUMNS} FROM knowledge_document
             WHERE corpus_id = $1 AND content_digest = $2`,
            [document.corpusId, document.contentDigest],
          )
        )[0];
        if (existing) return { document: toDocument(existing), created: false };

        const inserted = (
          await tx.query<DocumentRow>(
            `INSERT INTO knowledge_document (${DOCUMENT_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING ${DOCUMENT_COLUMNS}`,
            [
              document.id,
              document.corpusId,
              document.title,
              document.version,
              document.status,
              document.effectiveFrom,
              document.effectiveTo,
              document.jurisdiction,
              document.ingestedBy,
              document.ingestedAt,
              document.sourceUri,
              document.contentDigest,
              document.screenVerdict,
              document.chunkCount,
              null,
            ],
          )
        )[0];
        if (!inserted) throw new InvariantError(`Document ${document.id} was not written.`);

        // One statement for every passage, inside the same transaction as the
        // document. A document whose passages landed separately could be half
        // ingested, and retrieval would answer from the half that made it.
        const values: unknown[] = [];
        const tuples = chunks.map((chunk, index) => {
          const base = index * 7;
          values.push(
            chunk.id,
            chunk.documentId,
            chunk.corpusId,
            chunk.ordinal,
            chunk.text,
            chunk.digest,
            chunk.provenance,
          );
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
        });
        const written = await tx.query<{ id: string }>(
          `INSERT INTO knowledge_chunk (${CHUNK_COLUMNS}) VALUES ${tuples.join(",")} RETURNING id`,
          values,
        );
        if (written.length !== chunks.length) {
          throw new InvariantError(
            `Document ${document.id} declared ${chunks.length} passages but ${written.length} were written.`,
          );
        }

        return { document: toDocument(inserted), created: true };
      }),
    );
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
    return this.guard("activateDocument", () =>
      this.db.transaction(async (tx) => {
        // Compare-and-set: only a pending document moves, so two concurrent
        // activations cannot both believe they were the one that published it.
        const updated = (
          await tx.query<DocumentRow>(
            `UPDATE knowledge_document SET status = 'active', receipt_id = $2
             WHERE id = $1 AND status = 'pending'
             RETURNING ${DOCUMENT_COLUMNS}`,
            [id, receiptId],
          )
        )[0];
        if (updated) return toDocument(updated);

        const current = (
          await tx.query<DocumentRow>(
            `SELECT ${DOCUMENT_COLUMNS} FROM knowledge_document WHERE id = $1`,
            [id],
          )
        )[0];
        if (!current) {
          throw new DeniedError(
            "record.unavailable",
            `Document ${id} is not in the knowledge store.`,
            { documentId: id },
          );
        }
        // Already active: the receipt that won stands. See the in-memory
        // adapter for why a second receipt does not overwrite the first.
        return toDocument(current);
      }),
    );
  }

  async getDocument(id: Id<"document">): Promise<SourceDocument | null> {
    const rows = await this.guard("getDocument", () =>
      this.db.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS} FROM knowledge_document WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toDocument(row) : null;
  }

  async listDocuments(filter: DocumentFilter = {}): Promise<readonly SourceDocument[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (clause: (placeholder: string) => string, value: unknown): void => {
      values.push(value);
      clauses.push(clause(`$${values.length}`));
    };
    if (filter.corpusId !== undefined) add((p) => `corpus_id = ${p}`, filter.corpusId);
    if (filter.status !== undefined) add((p) => `status = ${p}`, filter.status);
    if (filter.jurisdiction !== undefined) add((p) => `jurisdiction = ${p}`, filter.jurisdiction);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.guard("listDocuments", () =>
      this.db.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS} FROM knowledge_document ${where} ORDER BY ordinal ASC`,
        values,
      ),
    );
    return rows.map(toDocument);
  }

  async getChunk(id: Id<"chunk">): Promise<Chunk | null> {
    const rows = await this.guard("getChunk", () =>
      this.db.query<ChunkRow>(`SELECT ${CHUNK_COLUMNS} FROM knowledge_chunk WHERE id = $1`, [id]),
    );
    const row = rows[0];
    return row ? toChunk(row) : null;
  }

  async listChunks(documentId: Id<"document">): Promise<readonly Chunk[]> {
    const rows = await this.guard("listChunks", () =>
      this.db.query<ChunkRow>(
        `SELECT ${CHUNK_COLUMNS} FROM knowledge_chunk WHERE document_id = $1 ORDER BY ordinal ASC`,
        [documentId],
      ),
    );
    return rows.map(toChunk);
  }

  async searchChunks(query: ChunkSearch): Promise<readonly Chunk[]> {
    assertIsoDate("asOf", query.asOf);
    if (query.corpusIds.length === 0) return [];

    const jurisdictions =
      query.jurisdictions && query.jurisdictions.length > 0 ? [...query.jurisdictions] : null;

    const rows = await this.guard("searchChunks", () =>
      this.db.query<ChunkRow>(
        `SELECT c.id, c.document_id, c.corpus_id, c.ordinal, c.body, c.digest, c.provenance
         FROM knowledge_chunk c
         JOIN knowledge_document d ON d.id = c.document_id
         WHERE d.corpus_id = ANY($1::text[])
           -- Pending documents are ones whose ingestion receipt never landed.
           AND d.status = 'active'
           -- The effective-dating predicate, inclusive at both ends. This is
           -- what stops a rule version that took effect after the asked-for
           -- date from appearing in the answer.
           AND d.effective_from <= $2
           AND (d.effective_to IS NULL OR d.effective_to >= $2)
           AND (
             $3::text[] IS NULL
             OR d.jurisdiction = ANY($3::text[])
             OR d.jurisdiction = $4
           )
         ORDER BY c.document_id ASC, c.ordinal ASC, c.id ASC`,
        [[...query.corpusIds], query.asOf, jurisdictions, GLOBAL_JURISDICTION],
      ),
    );
    return rows.map(toChunk);
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof DeniedError ||
        error instanceof InvalidInputError ||
        error instanceof InvariantError
      ) {
        throw error;
      }
      throw storeUnavailable(operation, error);
    }
  }
}

function toCorpus(row: CorpusRow): Corpus {
  return {
    id: row.id as Id<"corpus">,
    name: row.name,
    owner: row.owner,
    classification: row.classification as Classification,
    accessScope: Object.freeze([...row.access_scope]),
    reviewCadenceDays: Number(row.review_cadence_days),
    lastReviewedAt: row.last_reviewed_at,
    createdAt: row.created_at,
  };
}

function toDocument(row: DocumentRow): SourceDocument {
  return {
    id: row.id as Id<"document">,
    corpusId: row.corpus_id as Id<"corpus">,
    title: row.title,
    version: row.version,
    status: row.status as DocumentStatus,
    effectiveFrom: row.effective_from,
    // NULL means "still in force" and is represented as null throughout, never
    // as undefined: the two mean different things to the window predicate and
    // an absent field would read as "no end date recorded".
    effectiveTo: row.effective_to,
    jurisdiction: row.jurisdiction,
    ingestedBy: row.ingested_by,
    ingestedAt: row.ingested_at,
    sourceUri: row.source_uri,
    contentDigest: row.content_digest as Digest,
    screenVerdict: row.screen_verdict as IngestScreenVerdict,
    chunkCount: Number(row.chunk_count),
    receiptId: row.receipt_id === null ? undefined : (row.receipt_id as Id<"auditEntry">),
  };
}

function toChunk(row: ChunkRow): Chunk {
  return {
    id: row.id as Id<"chunk">,
    documentId: row.document_id as Id<"document">,
    corpusId: row.corpus_id as Id<"corpus">,
    ordinal: Number(row.ordinal),
    text: row.body,
    digest: row.digest as Digest,
    provenance: row.provenance,
  };
}
