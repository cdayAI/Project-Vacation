/**
 * Schema for templates and generated documents.
 *
 * Four constraints here are controls rather than tidiness, and each is enforced
 * by the database because the application is not the only thing that can reach
 * these tables.
 *
 * *An approved template version is immutable, enforced by trigger.* The port
 * has no update path for a body and no adapter implements one, but that is a
 * promise about this codebase, and the claim MVW will rely on — "this is the
 * text we sent, and it is the text that was approved" — has to hold against
 * someone with a psql prompt. So UPDATE is refused outright once a version is
 * approved, except for the two transitions that are part of its lifecycle:
 * attaching the approval that made it approved, and retiring it. DELETE and
 * TRUNCATE are refused always. What remains is DDL, which is a schema change,
 * visible in the catalogue, and impossible to do by accident.
 *
 * *One reviewer, one decision.* `document_template_approval` carries a unique
 * index over `(template_id, actor_id)`. Dual control means N *distinct* people;
 * without the index, one reviewer satisfying a 2-of-N rule is a double-click
 * away, and no amount of care in the application closes the window between two
 * simultaneous requests. Decisions are their own rows rather than an array on
 * the template, because storing them as an array makes recording one a
 * read-modify-write of the whole template — the shape that loses a decision
 * under concurrency.
 *
 * *A version number identifies exactly one body.* A unique index over
 * `(name, version)` makes the version assignment in the adapters unconditional.
 * Two rows claiming version 4 of one template would leave every citation of
 * "version 4" ambiguous, and citations of template versions are what a
 * generated document is made of.
 *
 * *A document's metadata outlives its body.* `body` is nullable and
 * `body_purged_at` records when it went. Retention and subject-rights erasure
 * both delete text and keep the row: destroying the record that a disclosure
 * was produced would remove the evidence that an obligation was met, which is
 * the opposite of what a retention policy is for. `output_digest` survives the
 * purge, so a document produced elsewhere can still be checked against what
 * this platform generated.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;
const DIGEST_SQL = String.raw`^sha256:[0-9a-f]{64}$`;

const DOCUMENTS_SQL = `
CREATE TABLE IF NOT EXISTS document_template (
  id                  text PRIMARY KEY,
  -- Insertion order, so listings stay deterministic when several versions are
  -- registered in the same millisecond. Under a fixed clock they always are.
  ordinal             bigserial NOT NULL UNIQUE,
  name                text NOT NULL,
  version             integer NOT NULL,
  audience            text NOT NULL,
  owner               text NOT NULL,
  status              text NOT NULL,
  description         text NOT NULL,
  body                text NOT NULL,
  body_digest         text NOT NULL,
  declared_variables  jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_formats      jsonb NOT NULL DEFAULT '[]'::jsonb,
  language            text NOT NULL,
  approvals_required  integer NOT NULL,
  created_by          text NOT NULL,
  created_at          text NOT NULL,
  approved_at         text,
  retired_at          text,
  CONSTRAINT document_template_name_version UNIQUE (name, version),
  CONSTRAINT document_template_version_positive CHECK (version >= 1),
  CONSTRAINT document_template_audience_known CHECK (audience IN ('internal','consumer')),
  CONSTRAINT document_template_status_known CHECK (status IN ('draft','approved','retired')),
  CONSTRAINT document_template_body_present CHECK (body <> ''),
  CONSTRAINT document_template_body_digest_shape CHECK (body_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT document_template_formats_present CHECK (jsonb_array_length(output_formats) >= 1),
  -- Zero required approvers would make "requires approval" self-satisfying, and
  -- anything an owner reads needs a second pair of eyes on it.
  CONSTRAINT document_template_approvals_positive CHECK (approvals_required >= 1),
  CONSTRAINT document_template_consumer_dual_control CHECK (
    audience <> 'consumer' OR approvals_required >= 2
  ),
  CONSTRAINT document_template_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT document_template_approved_at_utc CHECK (
    approved_at IS NULL OR approved_at ~ '${ISO_UTC_SQL}'
  ),
  CONSTRAINT document_template_retired_at_utc CHECK (
    retired_at IS NULL OR retired_at ~ '${ISO_UTC_SQL}'
  ),
  -- A version cannot be approved or retired without saying when.
  CONSTRAINT document_template_approved_has_time CHECK (
    status <> 'approved' OR approved_at IS NOT NULL
  ),
  CONSTRAINT document_template_retired_has_time CHECK (
    status <> 'retired' OR retired_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS document_template_name_idx ON document_template (name, version DESC);
CREATE INDEX IF NOT EXISTS document_template_usable_idx
  ON document_template (name, version DESC) WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS document_template_approval (
  ordinal      bigserial PRIMARY KEY,
  template_id  text NOT NULL REFERENCES document_template (id) ON DELETE RESTRICT,
  actor        jsonb NOT NULL,
  actor_id     text GENERATED ALWAYS AS (actor ->> 'actorId') STORED,
  decision     text NOT NULL,
  decided_at   text NOT NULL,
  -- The body the reviewer actually read. A decision that names a different body
  -- than the stored one is a decision about something else.
  body_digest  text NOT NULL,
  note         text,
  stepped_up   boolean NOT NULL,
  CONSTRAINT document_template_approval_decision_known CHECK (
    decision IN ('approved','rejected')
  ),
  CONSTRAINT document_template_approval_decided_at_utc CHECK (decided_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT document_template_approval_digest_shape CHECK (body_digest ~ '${DIGEST_SQL}')
);

-- Dual control, enforced by the database. One reviewer, one decision.
CREATE UNIQUE INDEX IF NOT EXISTS document_template_approval_one_per_actor
  ON document_template_approval (template_id, actor_id);
CREATE INDEX IF NOT EXISTS document_template_approval_template_idx
  ON document_template_approval (template_id, ordinal);

CREATE OR REPLACE FUNCTION document_template_immutable() RETURNS trigger
LANGUAGE plpgsql AS $document_template_immutable$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The text of a version never changes, at any status. What changes is the
    -- lifecycle: a draft becomes approved, an approved version becomes retired.
    IF NEW.id = OLD.id
       AND NEW.name = OLD.name
       AND NEW.version = OLD.version
       AND NEW.audience = OLD.audience
       AND NEW.body = OLD.body
       AND NEW.body_digest = OLD.body_digest
       AND NEW.declared_variables = OLD.declared_variables
       AND NEW.output_formats = OLD.output_formats
       AND NEW.language = OLD.language
       AND NEW.approvals_required = OLD.approvals_required
       AND NEW.created_by = OLD.created_by
       AND NEW.created_at = OLD.created_at
       AND (
         (OLD.status = 'draft' AND NEW.status IN ('draft','approved'))
         OR (OLD.status = 'approved' AND NEW.status = 'retired')
       )
    THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'document_template rows are immutable except for their lifecycle; % was refused', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Change a template by registering the next version and having it approved. Editing an approved version in place would make "which text did the owner receive" unanswerable, and every generated document cites a version.';
END;
$document_template_immutable$;

CREATE OR REPLACE TRIGGER document_template_no_edit
  BEFORE UPDATE ON document_template
  FOR EACH ROW EXECUTE FUNCTION document_template_immutable();

CREATE OR REPLACE TRIGGER document_template_no_delete
  BEFORE DELETE ON document_template
  FOR EACH ROW EXECUTE FUNCTION document_template_immutable();

-- Statement-level, because TRUNCATE fires no row triggers.
CREATE OR REPLACE TRIGGER document_template_no_truncate
  BEFORE TRUNCATE ON document_template
  FOR EACH STATEMENT EXECUTE FUNCTION document_template_immutable();

CREATE TABLE IF NOT EXISTS generated_document (
  id                      text PRIMARY KEY,
  ordinal                 bigserial NOT NULL UNIQUE,
  template_id             text NOT NULL REFERENCES document_template (id) ON DELETE RESTRICT,
  template_name           text NOT NULL,
  template_version        integer NOT NULL,
  -- Frozen here rather than joined at read time: a document is evidence, and
  -- evidence assembled from a row that could change is evidence that could
  -- change. The template is immutable, so these agree — and if they ever
  -- disagreed, that is exactly what somebody would need to discover.
  template_body_digest    text NOT NULL,
  data_digest             text NOT NULL,
  model_id                text,
  audience                text NOT NULL,
  format                  text NOT NULL,
  output_digest           text NOT NULL,
  body                    text,
  body_retained           boolean NOT NULL,
  run_id                  text NOT NULL,
  correlation_id          text,
  generated_by            text NOT NULL,
  generated_at            text NOT NULL,
  approval_id             text,
  approved_by             jsonb NOT NULL DEFAULT '[]'::jsonb,
  contact_evidence_digest text,
  subject_ref             text,
  receipt_id              text,
  body_purged_at          text,
  CONSTRAINT generated_document_audience_known CHECK (audience IN ('internal','consumer')),
  CONSTRAINT generated_document_format_known CHECK (format IN ('text','html','pdf','docx')),
  CONSTRAINT generated_document_body_digest_shape CHECK (template_body_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT generated_document_data_digest_shape CHECK (data_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT generated_document_output_digest_shape CHECK (output_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT generated_document_generated_at_utc CHECK (generated_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT generated_document_purged_at_utc CHECK (
    body_purged_at IS NULL OR body_purged_at ~ '${ISO_UTC_SQL}'
  ),
  -- A retained body is present; a purged one is not. The two flags cannot
  -- disagree, because a reader deciding whether the text still exists must not
  -- have to consult both and guess.
  CONSTRAINT generated_document_body_consistent CHECK (
    (body_retained AND body IS NOT NULL AND body_purged_at IS NULL)
    OR (NOT body_retained AND body IS NULL)
  ),
  -- Anything an owner sees carries the fingerprint of the contact-gate
  -- evaluation that permitted producing it. No evidence, no consumer document.
  CONSTRAINT generated_document_consumer_has_gate_evidence CHECK (
    audience <> 'consumer' OR contact_evidence_digest IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS generated_document_run_idx ON generated_document (run_id, ordinal);
CREATE INDEX IF NOT EXISTS generated_document_template_idx
  ON generated_document (template_name, template_version);
CREATE INDEX IF NOT EXISTS generated_document_subject_idx
  ON generated_document (subject_ref) WHERE subject_ref IS NOT NULL;
-- The retention sweep asks for documents generated before a date whose body is
-- still present.
CREATE INDEX IF NOT EXISTS generated_document_retention_idx
  ON generated_document (generated_at) WHERE body IS NOT NULL;
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0011_documents", sql: DOCUMENTS_SQL },
];
