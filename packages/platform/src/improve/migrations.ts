/**
 * Schema for the improvement loop.
 *
 * Six constraints in here are controls rather than tidiness, and each closes a
 * hole the application layer alone cannot — because the application layer is
 * not the only thing that can reach these tables.
 *
 * *Nothing is applied without a human decision.* `improvement_application`
 * requires a non-null `approval_id` shaped like an approval identifier. There
 * is no row in this table, and therefore no applied change in this platform,
 * that does not name the approval it was applied on. The gate is in `apply.ts`,
 * in the authorization chokepoint, and here — three independent places, because
 * "no autonomous self-modification" is the claim this product is judged on.
 *
 * *A change is applied once.* `proposal_id` is the primary key of
 * `improvement_application`. A second application of the same proposal fails at
 * the database even if every check above it were bypassed.
 *
 * *A revert names who did it.* A row with `reverted_at` set must carry
 * `reverted_by` and a reason. A rollback with nobody's name on it is exactly
 * the shape an autonomous rollback would take.
 *
 * *Artifact history is append-only, and the head is a pointer into it.*
 * `improvement_artifact` is keyed by `(kind, id, version)` with no update path
 * in either adapter; `improvement_artifact_head` names which version is live
 * and is the only mutable row. Reverting moves the pointer, so "what was live
 * between Tuesday and Thursday" stays answerable — which is the first question
 * an incident review asks.
 *
 * *Observations deduplicate.* `idempotency_key` is unique. A console that
 * retries cannot double the frequency a cluster reports, and frequency is what
 * decides which failure gets a person's attention.
 *
 * *Evidence is real.* Observations reference a run in the operating record and
 * proposals reference a role, both `ON DELETE RESTRICT`. An observation
 * attributed to work that never happened is not evidence, and the improvement
 * queue is built entirely out of evidence.
 *
 * Structured fields are `jsonb` for the same reason as everywhere else in this
 * platform: a field added to one of these types later must not need a migration
 * and must not be silently dropped on the way through storage — which, for
 * anything covered by a digest, would read as tampering.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;
const DIGEST_SQL = String.raw`^sha256:[0-9a-f]{64}$`;

const IMPROVE_SQL = `
CREATE TABLE IF NOT EXISTS improvement_observation (
  id                  text PRIMARY KEY,
  -- Insertion order, so a listing is stable when several observations share a
  -- recorded_at. Under a fixed clock — the test suite, the seeded demo — they
  -- always do.
  ordinal             bigserial NOT NULL UNIQUE,
  kind                text NOT NULL,
  run_id              text NOT NULL REFERENCES run (id) ON DELETE RESTRICT,
  step_id             text,
  role_id             text,
  role_version        integer,
  workflow_kind       text,
  signature           text NOT NULL,
  note                text NOT NULL,
  observed_by         jsonb NOT NULL,
  observed_by_actor   text GENERATED ALWAYS AS (observed_by ->> 'actorId') STORED,
  recorded_at         text NOT NULL,
  before_digest       text,
  after_digest        text,
  correction_minutes  numeric(10, 2) NOT NULL DEFAULT 0,
  cost_usd            numeric(20, 10) NOT NULL DEFAULT 0,
  subject             jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key     text NOT NULL,
  CONSTRAINT improvement_observation_kind_known CHECK (
    kind IN ('human_correction','proposal_rejected','approval_override','escalation','shadow_disagreement')
  ),
  CONSTRAINT improvement_observation_recorded_at_utc CHECK (recorded_at ~ '${ISO_UTC_SQL}'),
  -- Clustering groups on the signature, so free text would produce one cluster
  -- per typist and nothing would ever recur.
  CONSTRAINT improvement_observation_signature_shape CHECK (
    signature ~ '^[a-z][a-z0-9_]*(\\.[a-z0-9][a-z0-9_]*)*$' AND length(signature) <= 96
  ),
  CONSTRAINT improvement_observation_note_length CHECK (length(note) BETWEEN 1 AND 500),
  CONSTRAINT improvement_observation_before_digest_shape CHECK (
    before_digest IS NULL OR before_digest ~ '${DIGEST_SQL}'
  ),
  CONSTRAINT improvement_observation_after_digest_shape CHECK (
    after_digest IS NULL OR after_digest ~ '${DIGEST_SQL}'
  ),
  CONSTRAINT improvement_observation_minutes_bounded CHECK (
    correction_minutes >= 0 AND correction_minutes <= 1440
  ),
  CONSTRAINT improvement_observation_cost_non_negative CHECK (cost_usd >= 0)
);

-- The deduplication rule. A retried submission must not double a cluster's
-- count, because the count is what decides whose problem gets looked at.
CREATE UNIQUE INDEX IF NOT EXISTS improvement_observation_idempotency_key
  ON improvement_observation (idempotency_key);

CREATE INDEX IF NOT EXISTS improvement_observation_role_idx
  ON improvement_observation (role_id, recorded_at) WHERE role_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS improvement_observation_signature_idx
  ON improvement_observation (signature, recorded_at);
CREATE INDEX IF NOT EXISTS improvement_observation_run_idx
  ON improvement_observation (run_id);
CREATE INDEX IF NOT EXISTS improvement_observation_recorded_at_idx
  ON improvement_observation (recorded_at);

CREATE TABLE IF NOT EXISTS improvement_artifact (
  kind          text NOT NULL,
  id            text NOT NULL,
  version       integer NOT NULL,
  content       jsonb NOT NULL,
  digest        text NOT NULL,
  recorded_at   text NOT NULL,
  recorded_by   jsonb NOT NULL,
  proposal_id   text,
  approval_id   text,
  PRIMARY KEY (kind, id, version),
  CONSTRAINT improvement_artifact_kind_known CHECK (
    kind IN ('prompt_binding','routing_rule','guardrail_rule','knowledge_gap','evaluation_case')
  ),
  CONSTRAINT improvement_artifact_version_positive CHECK (version >= 1),
  -- An identifier, never a location. The improvement loop names artifacts; it
  -- does not locate files, and it never changes the platform's source.
  CONSTRAINT improvement_artifact_id_shape CHECK (
    id ~ '^[a-z][a-z0-9_]*(\\.[a-z0-9][a-z0-9_]*)*$' AND length(id) <= 128
  ),
  CONSTRAINT improvement_artifact_digest_shape CHECK (digest ~ '${DIGEST_SQL}'),
  CONSTRAINT improvement_artifact_recorded_at_utc CHECK (recorded_at ~ '${ISO_UTC_SQL}'),
  -- Version 1 is the artifact as the deployment declared it: reviewed in source
  -- control, so it carries no runtime approval. **Every version after it names
  -- the proposal and the approval that produced it**, which is what makes "no
  -- behaviour change without a recorded human decision" true of the table
  -- rather than only of the code path that usually writes to it.
  CONSTRAINT improvement_artifact_provenance CHECK (
    (version = 1 AND proposal_id IS NULL AND approval_id IS NULL)
    OR (version > 1 AND proposal_id IS NOT NULL AND approval_id IS NOT NULL
        AND approval_id ~ '^apr_')
  )
);

-- Which version is live. The only mutable row in the artifact story; the
-- history above it is append-only.
CREATE TABLE IF NOT EXISTS improvement_artifact_head (
  kind        text NOT NULL,
  id          text NOT NULL,
  version     integer NOT NULL,
  updated_at  text NOT NULL,
  -- Who last moved the pointer. A revert moves it without writing a new
  -- version, so without this the head would not say who rolled it back.
  updated_by  jsonb NOT NULL,
  PRIMARY KEY (kind, id),
  CONSTRAINT improvement_artifact_head_updated_at_utc CHECK (updated_at ~ '${ISO_UTC_SQL}'),
  FOREIGN KEY (kind, id, version)
    REFERENCES improvement_artifact (kind, id, version) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS improvement_proposal (
  id                text PRIMARY KEY,
  ordinal           bigserial NOT NULL UNIQUE,
  status            text NOT NULL,
  target_kind       text NOT NULL,
  target_id         text NOT NULL,
  role_id           text NOT NULL REFERENCES agent_role (id) ON DELETE RESTRICT,
  role_version      integer NOT NULL,
  cluster_key       text NOT NULL,
  observation_ids   jsonb NOT NULL,
  rationale         text NOT NULL,
  before_state      jsonb NOT NULL,
  after_state       jsonb NOT NULL,
  added_cases       jsonb,
  digest            text NOT NULL,
  created_at        text NOT NULL,
  created_by        jsonb NOT NULL,
  evaluation        jsonb,
  decision          jsonb,
  CONSTRAINT improvement_proposal_status_known CHECK (
    status IN ('drafted','withheld','offered','rejected','approved','applied','reverted')
  ),
  CONSTRAINT improvement_proposal_kind_known CHECK (
    target_kind IN ('prompt_binding','routing_rule','guardrail_rule','knowledge_gap','evaluation_case')
  ),
  CONSTRAINT improvement_proposal_target_shape CHECK (
    target_id ~ '^[a-z][a-z0-9_]*(\\.[a-z0-9][a-z0-9_]*)*$' AND length(target_id) <= 128
  ),
  CONSTRAINT improvement_proposal_digest_shape CHECK (digest ~ '${DIGEST_SQL}'),
  CONSTRAINT improvement_proposal_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}'),
  -- An approver who has to read an essay is an approver who stops reading.
  CONSTRAINT improvement_proposal_rationale_length CHECK (
    length(rationale) BETWEEN 1 AND 1000
  ),
  CONSTRAINT improvement_proposal_role_version_positive CHECK (role_version >= 1),
  -- Every state past drafted was reached by measuring it. A proposal cannot
  -- be offered, approved, or applied without the evaluation that justified it.
  CONSTRAINT improvement_proposal_measured_before_offered CHECK (
    status = 'drafted' OR evaluation IS NOT NULL
  ),
  -- And every state past offered was reached by a person deciding.
  CONSTRAINT improvement_proposal_decided_before_applied CHECK (
    status IN ('drafted','withheld','offered') OR decision IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS improvement_proposal_status_idx
  ON improvement_proposal (status, ordinal DESC);
CREATE INDEX IF NOT EXISTS improvement_proposal_role_idx
  ON improvement_proposal (role_id, ordinal DESC);
CREATE INDEX IF NOT EXISTS improvement_proposal_target_idx
  ON improvement_proposal (target_kind, target_id);

CREATE TABLE IF NOT EXISTS improvement_application (
  -- One application per proposal. A change is applied once, and this is where
  -- that stops being a convention.
  proposal_id     text PRIMARY KEY REFERENCES improvement_proposal (id) ON DELETE RESTRICT,
  ordinal         bigserial NOT NULL UNIQUE,
  -- The whole product claim, as a column constraint: there is no applied change
  -- without a recorded human decision.
  approval_id     text NOT NULL,
  target_kind     text NOT NULL,
  target_id       text NOT NULL,
  snapshot        jsonb NOT NULL,
  installed       jsonb NOT NULL,
  revertible      boolean NOT NULL,
  applied_at      text NOT NULL,
  applied_by      jsonb NOT NULL,
  run_id          text NOT NULL REFERENCES run (id) ON DELETE RESTRICT,
  reverted_at     text,
  reverted_by     jsonb,
  revert_reason   text,
  CONSTRAINT improvement_application_approval_shape CHECK (approval_id ~ '^apr_'),
  CONSTRAINT improvement_application_applied_at_utc CHECK (applied_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT improvement_application_reverted_at_utc CHECK (
    reverted_at IS NULL OR reverted_at ~ '${ISO_UTC_SQL}'
  ),
  -- A rollback with nobody's name on it is the shape an autonomous rollback
  -- would take, so it is refused here as well as in the code.
  CONSTRAINT improvement_application_revert_attributed CHECK (
    reverted_at IS NULL
    OR (reverted_by IS NOT NULL AND revert_reason IS NOT NULL AND length(revert_reason) >= 1)
  ),
  CONSTRAINT improvement_application_revertible_or_not_reverted CHECK (
    revertible OR reverted_at IS NULL
  )
);

CREATE INDEX IF NOT EXISTS improvement_application_live_idx
  ON improvement_application (ordinal DESC) WHERE reverted_at IS NULL;

CREATE TABLE IF NOT EXISTS improvement_quality_sample (
  proposal_id         text NOT NULL REFERENCES improvement_proposal (id) ON DELETE RESTRICT,
  evaluation_run_id   text NOT NULL,
  golden_set_digest   text NOT NULL,
  accuracy            numeric(6, 5) NOT NULL,
  case_count          integer NOT NULL,
  regressed_case_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_at         text NOT NULL,
  PRIMARY KEY (proposal_id, evaluation_run_id),
  CONSTRAINT improvement_quality_sample_accuracy_range CHECK (accuracy >= 0 AND accuracy <= 1),
  CONSTRAINT improvement_quality_sample_cases_non_negative CHECK (case_count >= 0),
  CONSTRAINT improvement_quality_sample_digest_shape CHECK (golden_set_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT improvement_quality_sample_observed_at_utc CHECK (observed_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS improvement_quality_sample_proposal_idx
  ON improvement_quality_sample (proposal_id, observed_at);
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0015_improve", sql: IMPROVE_SQL },
];
