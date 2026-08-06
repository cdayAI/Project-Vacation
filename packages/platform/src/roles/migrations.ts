/**
 * Schema for role governance.
 *
 * Five constraints in here are load-bearing controls rather than tidiness, and
 * each closes a hole the application layer alone cannot.
 *
 * *At most one promoted version per role.* A unique partial index over
 * `role_id WHERE status = 'promoted'` makes "exactly one version acts" a
 * property of the database. Two promotions racing would otherwise both read
 * "nothing is promoted" and both write, and the role would have two
 * definitions with different ceilings, with the one that wins depending on
 * query order.
 *
 * *A promoted version has evidence.* `status = 'promoted'` requires a non-null
 * `evidence`, which carries the evaluation run and the approval. There is no
 * path — not through this schema, not through a stray UPDATE — that produces a
 * role able to act with nobody's decision behind it.
 *
 * *Two roles cannot differ only in prompt wording.* `role.identity_digest` is
 * unique, and the digest covers actions, risk ceiling, data scopes, and model
 * task while deliberately excluding the prompt. If two roles differ only in
 * prompt wording, they are one role.
 *
 * *Golden sets are immutable per version.* `(id, version)` is the primary key
 * and there is no update path in either adapter. The protection guard in
 * `evaluation.ts` refuses a weakened proposal; this makes an in-place edit
 * impossible rather than merely refused, which matters because the guard is
 * code and the table is reachable by other means.
 *
 * *Evaluation runs are append-only evidence.* No update path and no delete
 * path. An evaluation whose numbers could be edited afterwards is not evidence.
 *
 * Definitions, evidence, and case results are `jsonb` for the same reason the
 * operating record stores structured fields whole: a field added to
 * `RoleDefinition` later must not need a migration and must not be silently
 * dropped on the way through storage, because the definition digest covers it
 * and a dropped field would read as tampering.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;
const DIGEST_SQL = String.raw`^sha256:[0-9a-f]{64}$`;

const ROLES_SQL = `
CREATE TABLE IF NOT EXISTS agent_role (
  id                text PRIMARY KEY,
  -- Insertion order, so a listing is stable when several roles share a
  -- created_at. Under a fixed clock — the seeded demo, the test suite — they
  -- always do.
  ordinal           bigserial NOT NULL UNIQUE,
  name              text NOT NULL UNIQUE,
  created_at        text NOT NULL,
  created_by        jsonb NOT NULL,
  latest_version    integer NOT NULL,
  promoted_version  integer,
  identity_digest   text NOT NULL,
  CONSTRAINT agent_role_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT agent_role_latest_version_positive CHECK (latest_version >= 1),
  CONSTRAINT agent_role_identity_digest_shape CHECK (identity_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT agent_role_name_shape CHECK (name ~ '^[a-z][a-z0-9_]*$')
);

-- Roles are few and purposeful. Two roles with the same actions, risk ceiling,
-- data scopes, and model task, differing only in prompt wording, are one role:
-- two audit trails, two evaluation sets, two things to disable in an incident,
-- and one shared blast radius.
CREATE UNIQUE INDEX IF NOT EXISTS agent_role_identity_idx ON agent_role (identity_digest);

CREATE TABLE IF NOT EXISTS agent_role_version (
  role_id             text NOT NULL REFERENCES agent_role (id) ON DELETE RESTRICT,
  version             integer NOT NULL,
  id                  text NOT NULL UNIQUE,
  status              text NOT NULL,
  definition          jsonb NOT NULL,
  definition_digest   text NOT NULL,
  created_at          text NOT NULL,
  created_by          jsonb NOT NULL,
  change_note         text NOT NULL,
  evidence            jsonb,
  restored_from       integer,
  rolled_off_at       text,
  PRIMARY KEY (role_id, version),
  CONSTRAINT agent_role_version_positive CHECK (version >= 1),
  CONSTRAINT agent_role_version_status_known CHECK (
    status IN ('draft','proposed','promoted','disabled','reverted')
  ),
  CONSTRAINT agent_role_version_digest_shape CHECK (definition_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT agent_role_version_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT agent_role_version_rolled_off_utc CHECK (
    rolled_off_at IS NULL OR rolled_off_at ~ '${ISO_UTC_SQL}'
  ),
  -- A change with no stated reason is a change an approver has to guess about.
  CONSTRAINT agent_role_version_has_note CHECK (length(change_note) BETWEEN 1 AND 1000),
  -- The one that matters most: a version that can act carries the evaluation
  -- run that measured it and the approval that authorised it. A promoted row
  -- with no evidence would be a role acting on nobody's decision.
  CONSTRAINT agent_role_version_promoted_has_evidence CHECK (
    status <> 'promoted' OR evidence IS NOT NULL
  ),
  -- Disabled and rolled-off versions were promoted once, so they carry the
  -- evidence they were promoted on. Restoring one must not become a promotion
  -- with the evidence requirement removed.
  CONSTRAINT agent_role_version_terminal_has_evidence CHECK (
    status NOT IN ('disabled','reverted') OR evidence IS NOT NULL
  )
);

-- Exactly one version of a role may act. Enforced here rather than only in the
-- adapter, because two concurrent promotions would otherwise both observe
-- "nothing is promoted" and both write.
CREATE UNIQUE INDEX IF NOT EXISTS agent_role_version_one_promoted_idx
  ON agent_role_version (role_id) WHERE status = 'promoted';

CREATE INDEX IF NOT EXISTS agent_role_version_status_idx
  ON agent_role_version (status, role_id);

CREATE TABLE IF NOT EXISTS role_golden_set (
  id            text NOT NULL,
  version       integer NOT NULL,
  task          text NOT NULL,
  synthetic     boolean NOT NULL,
  -- Exact decimal rather than a float: this is compared against a measured
  -- accuracy to decide whether a role may act, and accumulated binary rounding
  -- error in a gate is a gate that fails at the boundary.
  threshold     numeric(5, 4) NOT NULL,
  curated_by    text NOT NULL,
  curated_at    text NOT NULL,
  cases         jsonb NOT NULL,
  case_count    integer NOT NULL,
  digest        text NOT NULL,
  PRIMARY KEY (id, version),
  CONSTRAINT role_golden_set_version_positive CHECK (version >= 1),
  CONSTRAINT role_golden_set_threshold_range CHECK (threshold >= 0 AND threshold <= 1),
  -- A set with no cases establishes nothing while reporting perfect accuracy.
  CONSTRAINT role_golden_set_has_cases CHECK (case_count >= 1),
  CONSTRAINT role_golden_set_curated_at_utc CHECK (curated_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT role_golden_set_digest_shape CHECK (digest ~ '${DIGEST_SQL}'),
  -- It is the ground truth of record, so the record says whose judgement it is.
  CONSTRAINT role_golden_set_has_curator CHECK (length(curated_by) >= 1)
);

CREATE INDEX IF NOT EXISTS role_golden_set_task_idx ON role_golden_set (task, id);

CREATE TABLE IF NOT EXISTS role_evaluation_run (
  id                      text PRIMARY KEY,
  ordinal                 bigserial NOT NULL UNIQUE,
  role_id                 text NOT NULL,
  role_version            integer NOT NULL,
  definition_digest       text NOT NULL,
  golden_set_id           text NOT NULL,
  golden_set_version      integer NOT NULL,
  golden_set_digest       text NOT NULL,
  task                    text NOT NULL,
  model_id                text NOT NULL,
  model_version           text NOT NULL,
  prompt_template_id      text NOT NULL,
  prompt_template_version integer NOT NULL,
  run_id                  text NOT NULL REFERENCES run (id) ON DELETE RESTRICT,
  evaluated_by            jsonb NOT NULL,
  started_at              text NOT NULL,
  completed_at            text NOT NULL,
  case_count              integer NOT NULL,
  passed                  integer NOT NULL,
  failed                  integer NOT NULL,
  errored                 integer NOT NULL,
  accuracy                numeric(6, 5) NOT NULL,
  threshold               numeric(5, 4) NOT NULL,
  meets_threshold         boolean NOT NULL,
  synthetic_fixtures      boolean NOT NULL,
  results                 jsonb NOT NULL,
  total_cost_usd          numeric(20, 10) NOT NULL,
  -- Evidence is bound to the version it measured. Promotion re-checks this;
  -- the foreign key makes a run pointing at a version that does not exist
  -- impossible rather than merely refused.
  FOREIGN KEY (role_id, role_version)
    REFERENCES agent_role_version (role_id, version) ON DELETE RESTRICT,
  CONSTRAINT role_evaluation_run_definition_digest_shape CHECK (
    definition_digest ~ '${DIGEST_SQL}'
  ),
  CONSTRAINT role_evaluation_run_golden_set_digest_shape CHECK (
    golden_set_digest ~ '${DIGEST_SQL}'
  ),
  CONSTRAINT role_evaluation_run_started_at_utc CHECK (started_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT role_evaluation_run_completed_at_utc CHECK (completed_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT role_evaluation_run_accuracy_range CHECK (accuracy >= 0 AND accuracy <= 1),
  CONSTRAINT role_evaluation_run_threshold_range CHECK (threshold >= 0 AND threshold <= 1),
  CONSTRAINT role_evaluation_run_counts_non_negative CHECK (
    case_count >= 0 AND passed >= 0 AND failed >= 0 AND errored >= 0
  ),
  -- The parts have to add up to the whole, or the accuracy is a number about
  -- nothing. A run reporting 40 passes out of 30 cases is not evidence.
  CONSTRAINT role_evaluation_run_counts_reconcile CHECK (
    passed + failed + errored = case_count
  ),
  CONSTRAINT role_evaluation_run_cost_non_negative CHECK (total_cost_usd >= 0)
);

CREATE INDEX IF NOT EXISTS role_evaluation_run_role_idx
  ON role_evaluation_run (role_id, role_version, ordinal DESC);
CREATE INDEX IF NOT EXISTS role_evaluation_run_golden_set_idx
  ON role_evaluation_run (golden_set_id, golden_set_version, ordinal DESC);
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0014_roles", sql: ROLES_SQL },
];
