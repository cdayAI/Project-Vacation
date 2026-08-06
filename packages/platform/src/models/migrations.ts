/**
 * Schema for model invocations.
 *
 * One row per gateway call, keyed by the operating-record step it belongs to.
 * Reusing the step id as the primary key does two things at once: it makes the
 * idempotent write a plain `ON CONFLICT DO NOTHING`, and it makes "one step,
 * one model call" a property the database enforces rather than one the gateway
 * remembers. Two calls claiming a single step would double-count the spend the
 * ceiling reads.
 *
 * The columns that could hold a prompt or a response are digest columns, with
 * CHECK constraints that accept nothing else. This table is retained for two
 * years for cost and quality analysis, and two years of prompts and responses
 * would be a second copy of everything the platform has ever read — held
 * outside the systems of record whose access controls and deletion paths
 * govern the originals.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;
const DIGEST_SQL = String.raw`^sha256:[0-9a-f]{64}$`;

const MODELS_SQL = `
CREATE TABLE IF NOT EXISTS model_invocation (
  step_id                 text PRIMARY KEY REFERENCES run_step (id) ON DELETE RESTRICT,
  -- Insertion order, so a listing stays deterministic when several calls share
  -- an invoked_at. Under a fixed clock — the seeded demo, the test suite —
  -- they always do.
  ordinal                 bigserial NOT NULL UNIQUE,
  run_id                  text NOT NULL REFERENCES run (id) ON DELETE RESTRICT,
  task                    text NOT NULL,
  provider                text NOT NULL,
  model_id                text NOT NULL,
  model_version           text NOT NULL,
  prompt_template_id      text NOT NULL,
  prompt_template_version integer NOT NULL,
  prompt_digest           text NOT NULL,
  response_digest         text,
  input_tokens            integer NOT NULL,
  output_tokens           integer NOT NULL,
  -- Exact decimal rather than a float: this column is summed and compared
  -- against a spend ceiling, and accumulated binary rounding error in a
  -- control is a control that fails at the boundary.
  cost_usd                numeric(20, 10) NOT NULL,
  latency_ms              integer NOT NULL,
  attempt                 integer NOT NULL,
  degraded                boolean NOT NULL,
  outcome                 text NOT NULL,
  failure_kind            text,
  invoked_at              text NOT NULL,
  -- A prompt written where a digest belongs is the one mistake that would make
  -- this table a payload store. The database refuses it outright.
  CONSTRAINT model_invocation_prompt_digest_shape CHECK (prompt_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT model_invocation_response_digest_shape CHECK (
    response_digest IS NULL OR response_digest ~ '${DIGEST_SQL}'
  ),
  CONSTRAINT model_invocation_tokens_non_negative CHECK (
    input_tokens >= 0 AND output_tokens >= 0
  ),
  CONSTRAINT model_invocation_latency_non_negative CHECK (latency_ms >= 0),
  CONSTRAINT model_invocation_attempt_positive CHECK (attempt >= 1),
  -- A negative cost would let a caller buy back headroom under the spend
  -- ceiling by recording a refund it never received.
  CONSTRAINT model_invocation_cost_non_negative CHECK (cost_usd >= 0),
  CONSTRAINT model_invocation_outcome_known CHECK (outcome IN ('succeeded','failed')),
  -- A successful call that recorded no response digest would be unprovable:
  -- there would be nothing linking the answer a person acted on to the call
  -- that produced it.
  CONSTRAINT model_invocation_succeeded_has_response CHECK (
    outcome <> 'succeeded' OR response_digest IS NOT NULL
  ),
  CONSTRAINT model_invocation_invoked_at_utc CHECK (invoked_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS model_invocation_run_idx ON model_invocation (run_id);
CREATE INDEX IF NOT EXISTS model_invocation_task_idx ON model_invocation (task, model_id);
-- The retention sweep and every cost-window query ask for a range of
-- invoked_at; without this they scan the whole table.
CREATE INDEX IF NOT EXISTS model_invocation_invoked_at_idx ON model_invocation (invoked_at DESC, ordinal DESC);
-- "Which calls fell back?" is the question asked during and after an incident,
-- and degraded calls are the rare case — a partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS model_invocation_degraded_idx ON model_invocation (invoked_at DESC)
  WHERE degraded;
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0007_models", sql: MODELS_SQL },
];
