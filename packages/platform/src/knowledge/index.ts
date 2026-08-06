/**
 * Governed retrieval.
 *
 * The platform's only source of cited authority. Everything a workflow, a
 * document template, or a model is allowed to assert about a rule, a covenant,
 * or a procedure comes from here with provenance attached, or it does not come
 * at all.
 *
 * Three rules hold across the module and are worth stating once:
 *
 *   - Nothing enters a corpus without passing the boundary screen and leaving
 *     an audit receipt. A document whose receipt never landed stays unreachable.
 *   - Every query is a point-in-time query. Authority is effective-dated, and
 *     a passage that was not in force on the asked-for date is not returned.
 *   - No grounding, no answer. When nothing clears the relevance floor, or the
 *     authority that would be cited is overdue for review, the question is
 *     refused, recorded, and routed to a person.
 */

export type {
  Chunk,
  Citation,
  Claim,
  Classification,
  Corpus,
  CorpusFreshness,
  DocumentStatus,
  GroundedAnswer,
  IngestScreenVerdict,
  NewCorpus,
  Provenance,
  RetrievalQuery,
  RetrievalResult,
  RetrievedChunk,
  SourceDocument,
} from "./types.js";
export { CLASSIFICATIONS, GLOBAL_JURISDICTION } from "./types.js";

export type {
  ChunkSearch,
  DocumentFilter,
  KnowledgeStore,
  PutDocumentResult,
} from "./port.js";

export {
  INGEST_DOCUMENT_ACTION,
  KNOWLEDGE_ACTIONS,
  RECORD_CORPUS_REVIEW_ACTION,
} from "./actions.js";

export { IngestionService, chunkDigest, splitIntoChunks } from "./ingest.js";
export type { ChunkingOptions, IngestRequest, IngestResult, IngestionOptions } from "./ingest.js";

export { Retriever, citedCorpora, scoreChunks, tokenise } from "./retrieve.js";
export type { RetrieverOptions, ScoringOptions } from "./retrieve.js";

export {
  DEFAULT_COVERAGE_FLOOR,
  DEFAULT_MAX_CITATIONS,
  DEFAULT_RELEVANCE_FLOOR,
  GroundedAnswerService,
  assertGrounded,
  digestAnswer,
} from "./answer.js";
export type { AnswerReferral, AnswerRequest, GroundedAnswerOptions } from "./answer.js";

export { FreshnessMonitor, corpusFreshness, isStale } from "./freshness.js";
export type { RecordReviewRequest } from "./freshness.js";

export {
  MemoryKnowledgeStore,
  compareChunks,
  createMemoryKnowledgeStore,
  matchesJurisdiction,
} from "./store.memory.js";
export { PgKnowledgeStore } from "./store.pg.js";

export {
  ISO_DATE_PATTERN,
  MIGRATIONS as KNOWLEDGE_MIGRATIONS,
  assertIsoDate,
  assertOptionalIsoDate,
  isInForceOn,
} from "./migrations.js";
