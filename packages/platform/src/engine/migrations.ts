/**
 * Schema for the workflow engine.
 *
 * Two shapes, and the reasoning behind each is worth stating because both
 * choices are load-bearing.
 *
 * *An instance is one row.* Tokens, join barriers, step history, and the
 * compensation queue are `jsonb` columns on `workflow_instance` rather than
 * child tables. That is what makes a transition atomic without a transaction
 * spanning several tables: the engine's compare-and-swap is a single
 * conditional UPDATE, and either the whole transition lands or none of it does.
 * A partially-applied transition — a token advanced but its barrier not
 * counted — is the kind of state a resume cannot reason about, and the row
 * shape removes the possibility rather than defending against it. The cost is
 * that these fields are not independently queryable, which is acceptable
 * because nothing queries them: the console reads whole instances, and the
 * sweep uses the denormalised `runnable` and `wake_at` columns instead.
 *
 * *A human task is its own row.* Tasks are queried the other way round — by
 * role, by breach, across every instance — so they need their own indexes.
 * Their primary key is the operating-record step they belong to, which makes
 * "which step is this person blocking" a fact rather than a join.
 *
 * `revision` is the concurrency control. Every save is
 * `UPDATE ... WHERE id = $1 AND revision = $2`, so two engines that both read
 * the same state cannot both advance it. The engine claims a step by saving
 * before it acts, which is what turns this column into the thing that stops an
 * effect happening twice.
 *
 * Timestamps are text in the platform's one UTC form, matching the operating
 * record. The reasons are set out in record/migrations.ts and apply unchanged:
 * byte-stable round trips, and lexicographic ordering that is also
 * chronological — which is what makes the `wake_at` index a range scan.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;

const ENGINE_SQL = `
CREATE TABLE IF NOT EXISTS workflow_instance (
  id                  text PRIMARY KEY,
  -- Insertion order, so listings stay deterministic when several instances
  -- share a created_at. Under a fixed clock they always do.
  ordinal             bigserial NOT NULL UNIQUE,
  definition_name     text NOT NULL,
  definition_version  integer NOT NULL,
  -- Content fingerprint of the pinned version. The version number is a promise
  -- that a published definition never changes; this column is the check of it,
  -- and it is what lets a resume refuse to run the second half of a case under
  -- rules the first half never saw.
  definition_digest   text NOT NULL,
  status              text NOT NULL,
  terminal_status     text,
  mode                text NOT NULL,
  run_id              text NOT NULL REFERENCES run (id) ON DELETE RESTRICT,
  correlation_id      text NOT NULL,
  requested_by        jsonb NOT NULL,
  subject             jsonb NOT NULL DEFAULT '{}'::jsonb,
  context             jsonb NOT NULL DEFAULT '{}'::jsonb,
  tokens              jsonb NOT NULL DEFAULT '[]'::jsonb,
  barriers            jsonb NOT NULL DEFAULT '[]'::jsonb,
  history             jsonb NOT NULL DEFAULT '[]'::jsonb,
  compensation_queue  jsonb NOT NULL DEFAULT '[]'::jsonb,
  approvals           jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision            integer NOT NULL DEFAULT 1,
  -- Denormalised from tokens so the sweep is an index scan rather than a
  -- jsonb predicate over every live instance.
  runnable            boolean NOT NULL DEFAULT false,
  created_at          text NOT NULL,
  updated_at          text NOT NULL,
  ended_at            text,
  wake_at             text,
  stuck_reason        text,
  denial_reason       text,
  failure_reason      text,
  CONSTRAINT workflow_instance_version_positive CHECK (definition_version >= 1),
  CONSTRAINT workflow_instance_revision_positive CHECK (revision >= 1),
  CONSTRAINT workflow_instance_status_known CHECK (
    status IN ('running','waiting_human','waiting_approval','waiting_event','waiting_timer',
               'compensating','succeeded','failed','denied','cancelled')
  ),
  CONSTRAINT workflow_instance_terminal_status_known CHECK (
    terminal_status IS NULL OR terminal_status IN ('succeeded','failed','denied','cancelled')
  ),
  CONSTRAINT workflow_instance_mode_known CHECK (
    mode IN ('shadow','assisted','supervised','bounded_autonomy')
  ),
  -- Tokens and history are lists and the rest are objects. A jsonb column that
  -- accepted a scalar would deserialise into an instance the engine could not
  -- reason about, and the failure would surface as a resumed case behaving
  -- oddly rather than as a write error.
  CONSTRAINT workflow_instance_tokens_are_a_list CHECK (jsonb_typeof(tokens) = 'array'),
  CONSTRAINT workflow_instance_barriers_are_a_list CHECK (jsonb_typeof(barriers) = 'array'),
  CONSTRAINT workflow_instance_history_is_a_list CHECK (jsonb_typeof(history) = 'array'),
  CONSTRAINT workflow_instance_queue_is_a_list CHECK (jsonb_typeof(compensation_queue) = 'array'),
  CONSTRAINT workflow_instance_context_is_an_object CHECK (jsonb_typeof(context) = 'object'),
  CONSTRAINT workflow_instance_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT workflow_instance_updated_at_utc CHECK (updated_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT workflow_instance_ended_at_utc CHECK (ended_at IS NULL OR ended_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT workflow_instance_wake_at_utc CHECK (wake_at IS NULL OR wake_at ~ '${ISO_UTC_SQL}')
);

-- One instance per run. The operating record already points a run at its
-- instance; this makes the other direction unambiguous, so cost and step
-- queries cannot silently aggregate two instances into one case.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_instance_run_unique ON workflow_instance (run_id);

-- The sweep's two queries. Both are partial on unfinished instances, because a
-- finished one is never woken again and there will eventually be far more of
-- those than of live cases.
CREATE INDEX IF NOT EXISTS workflow_instance_wake_idx
  ON workflow_instance (wake_at)
  WHERE ended_at IS NULL AND wake_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_instance_runnable_idx
  ON workflow_instance (updated_at)
  WHERE ended_at IS NULL AND runnable;

CREATE INDEX IF NOT EXISTS workflow_instance_definition_idx
  ON workflow_instance (definition_name, definition_version);
CREATE INDEX IF NOT EXISTS workflow_instance_status_idx ON workflow_instance (status);
CREATE INDEX IF NOT EXISTS workflow_instance_listing_idx
  ON workflow_instance (created_at DESC, ordinal DESC);

CREATE TABLE IF NOT EXISTS workflow_human_task (
  -- The operating-record step this task is. Not a second identity for the same
  -- fact: the queue and the record are one thing seen from two sides.
  id                  text PRIMARY KEY REFERENCES run_step (id) ON DELETE RESTRICT,
  instance_id         text NOT NULL REFERENCES workflow_instance (id) ON DELETE RESTRICT,
  run_id              text NOT NULL REFERENCES run (id) ON DELETE RESTRICT,
  workflow_name       text NOT NULL,
  step_name           text NOT NULL,
  title               text NOT NULL,
  assigned_roles      jsonb NOT NULL,
  status              text NOT NULL,
  created_at          text NOT NULL,
  due_at              text,
  escalation_level    integer NOT NULL DEFAULT 0,
  escalated_at        text,
  escalated_to_roles  jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalation_note     text,
  completed_at        text,
  completed_by        text,
  outcome             text,
  subject             jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT workflow_human_task_status_known CHECK (status IN ('open','completed','cancelled')),
  CONSTRAINT workflow_human_task_escalation_non_negative CHECK (escalation_level >= 0),
  -- A task nobody may act on would wait forever and never appear on a queue.
  -- The type test comes first: jsonb_array_length raises on a non-array, and a
  -- raising CHECK is a confusing way to reject a badly-shaped write.
  CONSTRAINT workflow_human_task_has_an_owner CHECK (
    jsonb_typeof(assigned_roles) = 'array' AND jsonb_array_length(assigned_roles) >= 1
  ),
  CONSTRAINT workflow_human_task_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT workflow_human_task_due_at_utc CHECK (due_at IS NULL OR due_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT workflow_human_task_escalated_at_utc CHECK (escalated_at IS NULL OR escalated_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT workflow_human_task_completed_at_utc CHECK (completed_at IS NULL OR completed_at ~ '${ISO_UTC_SQL}')
);

-- The breach queue, which is the whole point of the SLA machinery: overdue work
-- has to be a row a supervisor sees rather than a line in a log nobody reads.
CREATE INDEX IF NOT EXISTS workflow_human_task_breach_idx
  ON workflow_human_task (due_at)
  WHERE status = 'open' AND due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_human_task_instance_idx ON workflow_human_task (instance_id);
CREATE INDEX IF NOT EXISTS workflow_human_task_status_idx ON workflow_human_task (status, created_at);
-- "What is on my team's queue" asks whether the roles array holds any of the
-- roles this person has, which is the ?| operator. The default jsonb_ops
-- opclass is required: jsonb_path_ops indexes containment only, so it would be
-- silently unused by exactly the query this index exists for.
CREATE INDEX IF NOT EXISTS workflow_human_task_roles_idx
  ON workflow_human_task USING gin (assigned_roles);
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0013_engine", sql: ENGINE_SQL },
];
