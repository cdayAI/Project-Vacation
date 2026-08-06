import { InvalidInputError } from "../kernel/errors.js";
import type { IsoDate } from "../timeline/types.js";

/**
 * Schema for governed retrieval.
 *
 * Three constraints in here are controls rather than tidiness, and each is
 * enforced by the database because the application is not the only thing that
 * can reach the tables.
 *
 * *Provenance cannot be dropped on the way in.* `knowledge_chunk` CHECKs that
 * the provenance document actually carries the fields a citation needs. The
 * TypeScript type already requires them; this catches the case where something
 * writes through a different code path, or where a future refactor makes the
 * field optional to satisfy a compiler and quietly ships passages nobody can
 * trace.
 *
 * *An active document has a receipt.* `status = 'active'` requires
 * `receipt_id`, so a document can only become retrievable once the audit entry
 * that recorded its ingestion exists. This is the schema-level half of the
 * two-phase ingestion in `ingest.ts`: no receipt, no authority.
 *
 * *One ingestion cannot land twice.* A unique index over `(corpus_id,
 * content_digest, version, effective_from)` makes the idempotency in
 * `putDocument` unconditional rather than a matter of the adapter checking
 * first. A retried ingestion after a crash must not double the weight of that
 * document in every later lexical search — which is what a duplicate would do,
 * silently, in a way that looks like corroboration. Version and effective start
 * are part of the key because unchanged text is genuinely republished under new
 * versions, and keying on content alone would make that republication invisible.
 *
 * Effective dates are civil dates (`YYYY-MM-DD`) stored as text, for the same
 * reason instants are stored as text elsewhere in this schema: the fixed-width
 * form sorts lexicographically in chronological order, which is what makes the
 * point-in-time window query an index range scan and not a function call on
 * every row. A statute takes effect on a date, in its own jurisdiction, with no
 * timezone attached; storing one as a timestamp invents a precision the source
 * material does not have.
 */

/** The one accepted civil-date form: `2026-08-06`. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The same rule, in the dialect Postgres CHECK constraints speak. */
const ISO_DATE_SQL = String.raw`^\d{4}-\d{2}-\d{2}$`;
const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;

/**
 * Refuse anything that is not a civil date in the platform's form.
 *
 * Rejects `2026-8-6`, `2026-08-06T00:00:00Z`, and a `Date`. Each of those would
 * compare wrongly against a stored date under the string ordering the window
 * query depends on, and the resulting error — a rule version that appears in or
 * vanishes from a point-in-time answer — is invisible at the call site.
 */
export function assertIsoDate(field: string, value: string): asserts value is IsoDate {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    throw new InvalidInputError(
      `${field} must be a civil date in YYYY-MM-DD form, e.g. 2026-08-06 — received: ${String(value)}`,
      field,
    );
  }
  // Reject dates that pass the shape test but do not exist, e.g. 2026-02-30.
  // A non-existent date sorts perfectly well and would silently define an
  // effective window nobody intended.
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (year === undefined || month === undefined || day === undefined) {
    throw new InvalidInputError(`${field} is not a valid civil date: ${value}`, field);
  }
  const asUtc = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(asUtc).toISOString().slice(0, 10);
  if (roundTrip !== value) {
    throw new InvalidInputError(
      `${field} is not a date that exists: ${value} (nearest real date is ${roundTrip})`,
      field,
    );
  }
}

/** As {@link assertIsoDate}, but tolerates an absent open-ended end date. */
export function assertOptionalIsoDate(field: string, value: string | null | undefined): void {
  if (value === null || value === undefined) return;
  assertIsoDate(field, value);
}

/**
 * Was a version in force on `asOf`?
 *
 * Both ends are inclusive: a rule effective from the 1st is in force on the
 * 1st, and `effectiveTo` names the last day it applied rather than the first
 * day it did not. Off-by-one at either boundary is a wrong answer about a
 * contract signed on that day, which is precisely the question this module is
 * asked.
 *
 * Stated once, here, and used by both store adapters and again by the retriever
 * so the three cannot drift into disagreeing.
 */
export function isInForceOn(
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate | null,
  asOf: IsoDate,
): boolean {
  if (effectiveFrom > asOf) return false;
  if (effectiveTo !== null && effectiveTo < asOf) return false;
  return true;
}

const KNOWLEDGE_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_corpus (
  id                   text PRIMARY KEY,
  name                 text NOT NULL UNIQUE,
  owner                text NOT NULL,
  classification       text NOT NULL,
  access_scope         jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_cadence_days  integer NOT NULL,
  last_reviewed_at     text NOT NULL,
  created_at           text NOT NULL,
  CONSTRAINT knowledge_corpus_classification_known CHECK (
    classification IN ('public','internal','confidential','privileged')
  ),
  -- A cadence of zero would mean "review continuously", which in practice means
  -- permanently stale and therefore permanently refusing. A negative one would
  -- mean the review is due before it happened.
  CONSTRAINT knowledge_corpus_cadence_positive CHECK (review_cadence_days >= 1),
  CONSTRAINT knowledge_corpus_reviewed_at_utc CHECK (last_reviewed_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT knowledge_corpus_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}')
);

CREATE TABLE IF NOT EXISTS knowledge_document (
  id              text PRIMARY KEY,
  -- Insertion order, so listings stay deterministic when several documents are
  -- ingested in the same millisecond. Under a fixed clock they always are.
  ordinal         bigserial NOT NULL UNIQUE,
  corpus_id       text NOT NULL REFERENCES knowledge_corpus (id) ON DELETE RESTRICT,
  title           text NOT NULL,
  version         text NOT NULL,
  status          text NOT NULL,
  effective_from  text NOT NULL,
  effective_to    text,
  jurisdiction    text NOT NULL,
  ingested_by     text NOT NULL,
  ingested_at     text NOT NULL,
  source_uri      text NOT NULL,
  content_digest  text NOT NULL,
  screen_verdict  text NOT NULL,
  chunk_count     integer NOT NULL,
  receipt_id      text,
  CONSTRAINT knowledge_document_status_known CHECK (status IN ('pending','active')),
  -- Blocked text never reaches this table; it is refused at the boundary
  -- screen. Only these two verdicts can have produced a stored document.
  CONSTRAINT knowledge_document_screen_verdict_known CHECK (
    screen_verdict IN ('clean','suspicious')
  ),
  CONSTRAINT knowledge_document_digest_shape CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT knowledge_document_effective_from_date CHECK (effective_from ~ '${ISO_DATE_SQL}'),
  CONSTRAINT knowledge_document_effective_to_date CHECK (
    effective_to IS NULL OR effective_to ~ '${ISO_DATE_SQL}'
  ),
  -- A window that ends before it starts is in force on no date at all, so a
  -- document written with one would be silently unreachable rather than wrong.
  CONSTRAINT knowledge_document_window_ordered CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT knowledge_document_ingested_at_utc CHECK (ingested_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT knowledge_document_chunk_count_positive CHECK (chunk_count >= 1),
  -- No receipt, no authority. A document only becomes retrievable once the
  -- audit entry recording its ingestion exists.
  CONSTRAINT knowledge_document_active_has_receipt CHECK (
    status <> 'active' OR receipt_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_document_ingestion_key
  ON knowledge_document (corpus_id, content_digest, version, effective_from);
-- The point-in-time window query, which is every retrieval.
CREATE INDEX IF NOT EXISTS knowledge_document_window_idx
  ON knowledge_document (corpus_id, status, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS knowledge_document_jurisdiction_idx
  ON knowledge_document (jurisdiction);

CREATE TABLE IF NOT EXISTS knowledge_chunk (
  id           text PRIMARY KEY,
  document_id  text NOT NULL REFERENCES knowledge_document (id) ON DELETE RESTRICT,
  corpus_id    text NOT NULL REFERENCES knowledge_corpus (id) ON DELETE RESTRICT,
  ordinal      integer NOT NULL,
  body         text NOT NULL,
  digest       text NOT NULL,
  -- Frozen at ingestion rather than joined at read time: a citation is
  -- evidence, and evidence assembled from a row that can change afterwards is
  -- evidence that can change afterwards.
  provenance   jsonb NOT NULL,
  CONSTRAINT knowledge_chunk_ordinal_unique UNIQUE (document_id, ordinal),
  CONSTRAINT knowledge_chunk_ordinal_non_negative CHECK (ordinal >= 0),
  CONSTRAINT knowledge_chunk_body_present CHECK (body <> ''),
  CONSTRAINT knowledge_chunk_digest_shape CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  -- A passage that cannot be traced cannot be used in a regulated answer, so
  -- one that cannot be traced does not get stored.
  CONSTRAINT knowledge_chunk_provenance_complete CHECK (
    provenance ? 'documentId'
    AND provenance ? 'version'
    AND provenance ? 'effectiveFrom'
    AND provenance ? 'jurisdiction'
    AND provenance ? 'ingestedBy'
    AND provenance ? 'ingestedAt'
    AND provenance ? 'contentDigest'
  )
);

CREATE INDEX IF NOT EXISTS knowledge_chunk_document_idx ON knowledge_chunk (document_id, ordinal);
CREATE INDEX IF NOT EXISTS knowledge_chunk_corpus_idx ON knowledge_chunk (corpus_id);
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0006_knowledge", sql: KNOWLEDGE_SQL },
];
