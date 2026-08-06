/**
 * Schema for integration degradation.
 *
 * There is no table here for integration *responses*. Nothing from a system of
 * record is cached in this platform's database, and that is a decision rather
 * than an omission: a cache is how "the integration is down" quietly becomes
 * "here is last week's answer, presented as today's". Contract facts and
 * association budgets are read live or the caller degrades explicitly. The
 * digests in the operating record prove which payload a decision was made
 * from without keeping a second copy of somebody else's data.
 *
 * Three tables, and two of them are keyed on a natural key rather than a
 * generated id.
 *
 * *`integration_queued_call` is keyed on the idempotency key.* One logical
 * call, one queue entry, however many times it fails. A generated id would let
 * a call that fails five times produce five queue entries, and a scheduler
 * working through them would perform the effect five times — which is the
 * exact failure idempotency keys exist to prevent, reintroduced by the retry
 * mechanism itself.
 *
 * *`integration_parked_item` is keyed on a reference.* Parking the same work
 * twice updates one item rather than putting two copies of one problem on a
 * person's queue.
 *
 * *`integration_credential_revocation` is the platform's own record of
 * credentials taken out of service.* It exists so revocation does not depend
 * on whoever owns the vault: the secret provider consults this table on every
 * read, so an operator's decision takes effect on the next call rather than at
 * the next rotation. Rows are never deleted — an un-revocation is a new
 * credential, not the removal of a row.
 *
 * Timestamps are text in the platform's ISO-8601 UTC form, for the reasons set
 * out in `record/migrations.ts`. The queue's due-work query is a range scan on
 * `next_attempt_at`, which only sorts chronologically because that form is
 * fixed-width.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;

const INTEGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS integration_queued_call (
  -- Natural key. One logical call is one queue entry, whatever its history.
  idempotency_key  text PRIMARY KEY,
  integration      text NOT NULL,
  operation        text NOT NULL,
  subject          jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_id           text,
  status           text NOT NULL,
  attempts         integer NOT NULL,
  first_failed_at  text NOT NULL,
  last_attempt_at  text NOT NULL,
  next_attempt_at  text NOT NULL,
  -- Redacted and truncated by the caller. Never a payload.
  last_error       text NOT NULL,
  claimed_at       text,
  completed_at     text,
  CONSTRAINT integration_queued_call_status_known CHECK (
    status IN ('queued','claimed','completed','abandoned')
  ),
  CONSTRAINT integration_queued_call_attempts_positive CHECK (attempts >= 1),
  -- A blank key would collide with every other blank one, and the scheduler
  -- reads a match as "this is the same call".
  CONSTRAINT integration_queued_call_key_present CHECK (idempotency_key <> ''),
  CONSTRAINT integration_queued_call_first_failed_utc CHECK (first_failed_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT integration_queued_call_last_attempt_utc CHECK (last_attempt_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT integration_queued_call_next_attempt_utc CHECK (next_attempt_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT integration_queued_call_claimed_utc CHECK (claimed_at IS NULL OR claimed_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT integration_queued_call_completed_utc CHECK (completed_at IS NULL OR completed_at ~ '${ISO_UTC_SQL}')
);

-- The scheduler asks for queued work that is due. A partial index keeps that
-- off every call the queue has ever handled.
CREATE INDEX IF NOT EXISTS integration_queued_call_due_idx
  ON integration_queued_call (next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS integration_queued_call_integration_idx
  ON integration_queued_call (integration, status);

CREATE TABLE IF NOT EXISTS integration_parked_item (
  -- Natural key, so parking the same work twice does not put two copies of
  -- one problem on a person's queue.
  reference     text PRIMARY KEY,
  integration   text NOT NULL,
  operation     text NOT NULL,
  subject       jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_id        text,
  summary       text NOT NULL,
  reason        text NOT NULL,
  parked_at     text NOT NULL,
  resolved_at   text,
  resolved_by   text,
  resolution    text,
  CONSTRAINT integration_parked_item_reference_present CHECK (reference <> ''),
  CONSTRAINT integration_parked_item_parked_at_utc CHECK (parked_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT integration_parked_item_resolved_at_utc CHECK (resolved_at IS NULL OR resolved_at ~ '${ISO_UTC_SQL}'),
  -- A resolution nobody signed is not a resolution anyone can evidence.
  CONSTRAINT integration_parked_item_resolution_complete CHECK (
    (resolved_at IS NULL AND resolved_by IS NULL)
    OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  )
);

-- The human queue: oldest unresolved first, so nothing waits indefinitely.
CREATE INDEX IF NOT EXISTS integration_parked_item_open_idx
  ON integration_parked_item (parked_at) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS integration_credential_revocation (
  -- The reference is a name, not a secret. The credential itself is never here.
  reference    text PRIMARY KEY,
  revoked_at   text NOT NULL,
  revoked_by   text NOT NULL,
  reason       text NOT NULL,
  CONSTRAINT integration_credential_revocation_at_utc CHECK (revoked_at ~ '${ISO_UTC_SQL}')
);
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0009_integrations", sql: INTEGRATIONS_SQL },
];
