/**
 * Schema for the audit chain.
 *
 * The table carries three guarantees that are enforced by the database rather
 * than by the code above it, because the code above it is not the only thing
 * that can reach the table.
 *
 * *Append-only, enforced by trigger.* The `AuditStore` port has no update and
 * no delete, and no adapter implements one. That is worth something, but it is
 * a promise about this codebase, and the claim the product makes — "a record
 * that survives an audit" — has to hold against someone with a psql prompt and
 * a reason to be embarrassed. So UPDATE, DELETE, and TRUNCATE all raise. What
 * remains is DDL: an owner can still drop the trigger. That is a deliberately
 * higher bar — it is a schema change, it is visible in the catalogue, and it
 * cannot be done by accident — and it is stated plainly here rather than
 * implied to be impossible.
 *
 * *The chain cannot fork, enforced by a unique index.* `previous_hash` is
 * unique, so two entries can never both claim the same predecessor. If the
 * append lock were ever wrong, the second writer would fail its INSERT instead
 * of quietly creating a branch that verification would later report as a
 * duplicate sequence with no way to tell which side was real.
 *
 * *Sequence numbers are unique and contiguous*, enforced by the primary key on
 * `seq` together with the append lock.
 *
 * A correction to a mistaken entry is a new entry that supersedes it. That is
 * the only shape a correction can take in an append-only log, and it is also
 * the shape an auditor expects.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;

const AUDIT_SQL = `
CREATE TABLE IF NOT EXISTS audit_entry (
  seq             bigint PRIMARY KEY,
  id              text NOT NULL UNIQUE,
  event_type      text NOT NULL,
  recorded_at     text NOT NULL,
  actor           jsonb NOT NULL,
  actor_id        text GENERATED ALWAYS AS (actor ->> 'actorId') STORED,
  run_id          text,
  correlation_id  text,
  subject         jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_digests   jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision        jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash   text NOT NULL,
  entry_hash      text NOT NULL,
  CONSTRAINT audit_entry_seq_positive CHECK (seq >= 1),
  CONSTRAINT audit_entry_recorded_at_utc CHECK (recorded_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT audit_entry_hash_shape CHECK (entry_hash ~ '^sha256:[0-9a-f]{64}$')
);

-- One entry per predecessor. This is what makes a fork impossible rather than
-- merely unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS audit_entry_previous_hash_key
  ON audit_entry (previous_hash);
CREATE UNIQUE INDEX IF NOT EXISTS audit_entry_entry_hash_key
  ON audit_entry (entry_hash);

CREATE INDEX IF NOT EXISTS audit_entry_event_type_idx ON audit_entry (event_type);
CREATE INDEX IF NOT EXISTS audit_entry_recorded_at_idx ON audit_entry (recorded_at);
CREATE INDEX IF NOT EXISTS audit_entry_actor_idx ON audit_entry (actor_id);
CREATE INDEX IF NOT EXISTS audit_entry_run_idx ON audit_entry (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_entry_correlation_idx ON audit_entry (correlation_id)
  WHERE correlation_id IS NOT NULL;
-- Containment queries ("every entry whose subject includes this contract id")
-- are answered with the @> operator, which needs a GIN index to be anything
-- other than a full scan of seven years of history.
CREATE INDEX IF NOT EXISTS audit_entry_subject_idx
  ON audit_entry USING gin (subject jsonb_path_ops);

-- CREATE OR REPLACE TRIGGER needs PostgreSQL 14 or later. The platform targets
-- 16; on anything older this migration fails rather than silently leaving the
-- table mutable, which is the correct way round for a control.
CREATE OR REPLACE FUNCTION audit_entry_append_only() RETURNS trigger
LANGUAGE plpgsql AS $audit_append_only$
BEGIN
  RAISE EXCEPTION
    'audit_entry is append-only; % is not permitted on this table', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct a mistaken audit entry by appending an entry that supersedes it. Editing history breaks the hash chain from that point to the head, which is the property the log exists to provide.';
END;
$audit_append_only$;

CREATE OR REPLACE TRIGGER audit_entry_no_update
  BEFORE UPDATE ON audit_entry
  FOR EACH ROW EXECUTE FUNCTION audit_entry_append_only();

CREATE OR REPLACE TRIGGER audit_entry_no_delete
  BEFORE DELETE ON audit_entry
  FOR EACH ROW EXECUTE FUNCTION audit_entry_append_only();

-- Statement-level, because TRUNCATE fires no row triggers. Without this, the
-- row triggers above would be theatre: one statement would empty the table.
CREATE OR REPLACE TRIGGER audit_entry_no_truncate
  BEFORE TRUNCATE ON audit_entry
  FOR EACH STATEMENT EXECUTE FUNCTION audit_entry_append_only();
`;

/**
 * A high-water mark the chain cannot be shortened past unnoticed.
 *
 * `verifyChain` reports alteration and mid-chain deletion correctly, and is
 * blind to the cheapest tampering of all: deleting the newest entries, or the
 * whole table. It is deliberately storage-independent so an auditor can verify
 * an exported archive, and a function handed only the surviving entries cannot
 * know how many it was not handed. Nothing persisted how far the chain had
 * reached, so nothing could notice it had got shorter — an emptied table
 * verified as INTACT and the verifier exited zero.
 *
 * One row, updated on every append, with a constraint that it may only ever go
 * up. A truncation then contradicts a durable fact rather than leaving no trace.
 *
 * **This raises the bar; it is not proof.** A watermark in the same database is
 * defeated by anyone who can write to that database — it detects accident,
 * ordinary tampering, and a restore from the wrong backup, and it does not
 * detect a determined administrator. Making that claim would need an anchor
 * outside this system, such as a periodically published head hash. The
 * assurance documentation must describe it as what it is.
 */
const AUDIT_WATERMARK_SQL = `
CREATE TABLE IF NOT EXISTS audit_watermark (
  id          text PRIMARY KEY DEFAULT 'chain',
  max_seq     bigint NOT NULL,
  head_hash   text NOT NULL,
  updated_at  text NOT NULL,
  CONSTRAINT audit_watermark_single_row CHECK (id = 'chain'),
  CONSTRAINT audit_watermark_seq_positive CHECK (max_seq >= 1)
);

-- The mark only ever rises. An UPDATE that would lower it is refused by the
-- database rather than by whoever remembered to write the guard in code.
CREATE OR REPLACE FUNCTION audit_watermark_never_decreases() RETURNS trigger AS $$
BEGIN
  IF NEW.max_seq < OLD.max_seq THEN
    RAISE EXCEPTION 'audit watermark cannot decrease: % -> %', OLD.max_seq, NEW.max_seq;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_watermark_monotonic ON audit_watermark;
CREATE TRIGGER audit_watermark_monotonic
  BEFORE UPDATE ON audit_watermark
  FOR EACH ROW EXECUTE FUNCTION audit_watermark_never_decreases();
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0002_audit", sql: AUDIT_SQL },
  { id: "0018_audit_watermark", sql: AUDIT_WATERMARK_SQL },
];
