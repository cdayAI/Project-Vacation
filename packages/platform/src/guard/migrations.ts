/**
 * Schema for the governance controls.
 *
 * Two constraints in here are load-bearing controls rather than tidiness.
 *
 * *One decision per approver, per request.* `approval_decision` carries a
 * unique index over `(approval_id, actor_id)`. Dual control means N *distinct*
 * people; without that index, one person satisfying a 2-of-M requirement is
 * a double-click away, and no amount of care in the application layer closes
 * the window between two simultaneous requests. The adapter also takes a row
 * lock and checks explicitly, but the index is what makes the guarantee
 * unconditional.
 *
 * *Decisions are their own rows.* Storing them as an array on the approval
 * would make recording one a read-modify-write of the whole approval, which is
 * precisely the shape that loses a decision under concurrency.
 *
 * The consumption flag lives on `approval.status`, so spending an approval is
 * a single conditional UPDATE — the compare-and-set that makes an approval
 * genuinely single-use.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;

const GUARD_SQL = `
CREATE TABLE IF NOT EXISTS approval (
  id                     text PRIMARY KEY,
  -- Insertion order, so a queue of approvals raised in the same millisecond
  -- still has one stable order for an approver to work through.
  ordinal                bigserial NOT NULL UNIQUE,
  action                 text NOT NULL,
  status                 text NOT NULL,
  proposal_digest        text NOT NULL,
  summary                text NOT NULL,
  requested_by           jsonb NOT NULL,
  requested_by_actor_id  text GENERATED ALWAYS AS (requested_by ->> 'actorId') STORED,
  requested_at           text NOT NULL,
  expires_at             text NOT NULL,
  run_id                 text,
  correlation_id         text,
  subject                jsonb NOT NULL DEFAULT '{}'::jsonb,
  approvals_required     integer NOT NULL,
  eligible_roles         jsonb NOT NULL DEFAULT '[]'::jsonb,
  consumed_at            text,
  consumed_by_run_id     text,
  CONSTRAINT approval_status_known CHECK (
    status IN ('pending','granted','rejected','expired','consumed')
  ),
  -- An approval bound to something that is not a digest is bound to nothing,
  -- and a proposal could then be swapped after sign-off.
  CONSTRAINT approval_digest_shape CHECK (proposal_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- Zero required approvers would make "requires approval" self-satisfying.
  CONSTRAINT approval_required_positive CHECK (approvals_required >= 1),
  CONSTRAINT approval_requested_at_utc CHECK (requested_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT approval_expires_at_utc CHECK (expires_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT approval_consumed_at_utc CHECK (consumed_at IS NULL OR consumed_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS approval_status_idx ON approval (status);
CREATE INDEX IF NOT EXISTS approval_action_idx ON approval (action);
CREATE INDEX IF NOT EXISTS approval_run_idx ON approval (run_id) WHERE run_id IS NOT NULL;
-- The expiry sweep asks for pending approvals past their time; a partial index
-- keeps that from scanning every approval ever raised.
CREATE INDEX IF NOT EXISTS approval_expiry_idx ON approval (expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS approval_decision (
  ordinal      bigserial PRIMARY KEY,
  approval_id  text NOT NULL REFERENCES approval (id) ON DELETE RESTRICT,
  actor        jsonb NOT NULL,
  actor_id     text GENERATED ALWAYS AS (actor ->> 'actorId') STORED,
  decision     text NOT NULL,
  decided_at   text NOT NULL,
  note         text,
  stepped_up   boolean NOT NULL,
  CONSTRAINT approval_decision_known CHECK (decision IN ('granted','rejected')),
  CONSTRAINT approval_decision_decided_at_utc CHECK (decided_at ~ '${ISO_UTC_SQL}')
);

-- Dual control, enforced by the database. One approver, one decision.
CREATE UNIQUE INDEX IF NOT EXISTS approval_decision_one_per_actor
  ON approval_decision (approval_id, actor_id);
CREATE INDEX IF NOT EXISTS approval_decision_approval_idx
  ON approval_decision (approval_id, ordinal);

CREATE TABLE IF NOT EXISTS containment_switch (
  scope       text NOT NULL,
  -- Empty for the global switch, so the primary key covers all four scopes
  -- without a nullable column that would need IS NOT DISTINCT FROM to match.
  target      text NOT NULL,
  engaged     boolean NOT NULL,
  engaged_by  text,
  engaged_at  text,
  reason      text,
  PRIMARY KEY (scope, target),
  CONSTRAINT containment_scope_known CHECK (
    scope IN ('global','workflow','role','integration')
  ),
  CONSTRAINT containment_engaged_at_utc CHECK (engaged_at IS NULL OR engaged_at ~ '${ISO_UTC_SQL}')
);
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0003_guard", sql: GUARD_SQL },
];
