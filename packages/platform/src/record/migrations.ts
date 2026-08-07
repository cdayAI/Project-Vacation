import { InvalidInputError } from "../kernel/errors.js";
import type { StepStatus } from "./types.js";

/**
 * Schema for the operating record.
 *
 * Two schema-wide decisions are made here and inherited by every other module,
 * so they are explained once, in the first migration.
 *
 * *Timestamps are stored as text, not `timestamptz`.* The platform's wire form
 * for an instant is the exact string `Date.prototype.toISOString()` produces,
 * and several things depend on that string surviving a round trip byte for
 * byte. The audit chain is the decisive one: `recordedAt` is covered by
 * `entryHash`, so a database that accepted `2026-08-06T13:05:00Z` and returned
 * `2026-08-06T13:05:00.000Z` would make an untampered chain fail verification —
 * a false accusation of tampering, which is an expensive thing to debug and a
 * worse thing to report. Text storage removes the possibility. It costs the
 * date functions, which nothing in this platform uses, and it keeps ordering
 * correct because the fixed-width UTC form sorts lexicographically in
 * chronological order.
 *
 * That last property only holds if every stored timestamp really is in that
 * one form. A single `+02:00` offset would sort before every `Z` value of the
 * same instant and silently corrupt every range query — retention sweeps, the
 * daily spend ceiling, the audit window. So the form is enforced twice: as a
 * CHECK constraint here, and as `assertIsoUtc` below, which the adapters call
 * before they write. The two statements of the rule live in the same file so
 * they cannot drift apart.
 *
 * *Structured fields are `jsonb`.* Subject references, actor records, and step
 * detail are stored whole rather than shredded into columns, so a field added
 * to one of those types later does not need a migration and cannot be silently
 * dropped on the way through storage — which, for anything covered by the
 * audit hash, would again read as tampering. Where a jsonb field needs an
 * index, a stored generated column projects it out.
 */

/** The one accepted timestamp form: `2026-08-06T13:05:00.000Z`. */
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The same rule, in the dialect Postgres CHECK constraints speak. */
const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;

/**
 * Refuse a timestamp that is not in the platform's wire form.
 *
 * @throws {InvalidInputError} — a caller passing a `Date`, a local time, or an
 *   offset-bearing string has made a mistake that would corrupt ordering for
 *   every later reader, and it is far cheaper to catch at the write.
 */
export function assertIsoUtc(field: string, value: string): void {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) {
    throw new InvalidInputError(
      `${field} must be an ISO-8601 UTC timestamp with milliseconds, e.g. 2026-08-06T13:05:00.000Z — received: ${String(value)}`,
      field,
    );
  }
}

/** As `assertIsoUtc`, but tolerates an absent optional timestamp. */
export function assertOptionalIsoUtc(field: string, value: string | undefined | null): void {
  if (value === undefined || value === null) return;
  assertIsoUtc(field, value);
}

/** Decimal places `run_cost.amount_usd` stores: it is `numeric(20, 10)`. */
export const USD_SCALE = 10;

/**
 * Snap a JavaScript number back onto the scale the money column stores.
 *
 * Here for the same reason `assertIsoUtc` is: the rule is stated once in SQL,
 * as `numeric(20, 10)`, and once in TypeScript, and keeping the two in one
 * file is what stops them drifting.
 *
 * Postgres adds those values as exact decimals. The in-memory adapter has only
 * binary doubles, and their error accumulates — three hundred entries of one
 * cent sum to 2.99999999999998, not 3 — so a spend ceiling compared against
 * the in-memory total answers differently from the same ceiling compared
 * against the database's. Snapping each running total back onto the column's
 * grid puts it where exact decimal arithmetic would have left it. Every input
 * and every partial sum then sits on the grid, so nothing drifts off it and
 * the result no longer depends on the order the entries arrived in.
 */
export function toStoredUsd(amount: number): number {
  return Number(amount.toFixed(USD_SCALE));
}

/**
 * Step states that are the end of the story.
 *
 * Lives beside the CHECK constraint that enumerates the same set, for the same
 * reason `assertIsoUtc` does: the rule is stated once in SQL and once in
 * TypeScript, and keeping the two in one file is what stops them drifting.
 */
export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = [
  "succeeded",
  "failed",
  "skipped",
  "compensated",
  "denied",
];

export function isTerminalStepStatus(status: StepStatus): boolean {
  return TERMINAL_STEP_STATUSES.includes(status);
}

const RECORD_SQL = `
CREATE TABLE IF NOT EXISTS run (
  id                     text PRIMARY KEY,
  -- Insertion order, so listings stay deterministic when several runs share a
  -- created_at. Under a fixed clock — the seeded demo, the whole test suite —
  -- they always do.
  ordinal                bigserial NOT NULL UNIQUE,
  kind                   text NOT NULL,
  status                 text NOT NULL,
  mode                   text NOT NULL,
  requested_by           jsonb NOT NULL,
  requested_by_actor_id  text GENERATED ALWAYS AS (requested_by ->> 'actorId') STORED,
  subject                jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id         text NOT NULL,
  workflow_instance_id   text,
  role_id                text,
  role_version           integer,
  created_at             text NOT NULL,
  started_at             text,
  ended_at               text,
  outcome                text,
  denial_reason          text,
  input_digest           text,
  output_digest          text,
  CONSTRAINT run_status_known CHECK (
    status IN ('pending','running','awaiting_human','awaiting_approval','succeeded','failed','cancelled','denied')
  ),
  CONSTRAINT run_mode_known CHECK (
    mode IN ('shadow','assisted','supervised','bounded_autonomy')
  ),
  CONSTRAINT run_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT run_started_at_utc CHECK (started_at IS NULL OR started_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT run_ended_at_utc CHECK (ended_at IS NULL OR ended_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS run_listing_idx ON run (created_at DESC, ordinal DESC);
CREATE INDEX IF NOT EXISTS run_status_idx ON run (status);
CREATE INDEX IF NOT EXISTS run_kind_idx ON run (kind);
CREATE INDEX IF NOT EXISTS run_requested_by_idx ON run (requested_by_actor_id);
CREATE INDEX IF NOT EXISTS run_workflow_instance_idx ON run (workflow_instance_id)
  WHERE workflow_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_role_idx ON run (role_id) WHERE role_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_step (
  id               text PRIMARY KEY,
  run_id           text NOT NULL REFERENCES run (id) ON DELETE RESTRICT,
  seq              integer NOT NULL,
  kind             text NOT NULL,
  name             text NOT NULL,
  status           text NOT NULL,
  idempotency_key  text NOT NULL,
  attempt          integer NOT NULL,
  started_at       text NOT NULL,
  ended_at         text,
  input_digest     text,
  output_digest    text,
  error            text,
  denial_reason    text,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The store serialises appenders per run, but a unique constraint is what
  -- makes a duplicate sequence number impossible rather than merely unlikely.
  -- If the locking is ever wrong, this turns a silently forked step history
  -- into a loud write failure.
  CONSTRAINT run_step_seq_unique UNIQUE (run_id, seq),
  CONSTRAINT run_step_seq_positive CHECK (seq >= 1),
  CONSTRAINT run_step_attempt_positive CHECK (attempt >= 1),
  -- A blank idempotency key would match every other blank one, and the engine
  -- reads a match as "the external effect already happened". Refusing the
  -- write is the difference between a duplicated effect and a skipped one.
  CONSTRAINT run_step_idempotency_key_present CHECK (idempotency_key <> ''),
  CONSTRAINT run_step_status_known CHECK (
    status IN ('pending','running','waiting','succeeded','failed','skipped','compensated','denied')
  ),
  CONSTRAINT run_step_started_at_utc CHECK (started_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT run_step_ended_at_utc CHECK (ended_at IS NULL OR ended_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS run_step_run_idx ON run_step (run_id, seq);
CREATE INDEX IF NOT EXISTS run_step_idempotency_idx ON run_step (idempotency_key);

CREATE TABLE IF NOT EXISTS run_cost (
  ordinal      bigserial PRIMARY KEY,
  run_id       text NOT NULL REFERENCES run (id) ON DELETE RESTRICT,
  step_id      text,
  category     text NOT NULL,
  -- Exact decimal rather than a float: this column is summed and compared
  -- against a spend ceiling, and accumulated binary rounding error in a
  -- control is a control that fails at the boundary.
  amount_usd   numeric(20, 10) NOT NULL,
  units        numeric(20, 6),
  model_id     text,
  recorded_at  text NOT NULL,
  detail       jsonb,
  -- A negative amount would let a caller buy back headroom under the spend
  -- ceiling by recording a refund it never received.
  CONSTRAINT run_cost_amount_non_negative CHECK (amount_usd >= 0),
  CONSTRAINT run_cost_category_known CHECK (
    category IN ('model','integration','storage','compute','human')
  ),
  CONSTRAINT run_cost_recorded_at_utc CHECK (recorded_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS run_cost_run_idx ON run_cost (run_id);
CREATE INDEX IF NOT EXISTS run_cost_recorded_at_idx ON run_cost (recorded_at);
`;

/**
 * The index the work queue's own query needs.
 *
 * `WHERE status = ANY(...) ORDER BY created_at DESC LIMIT n` had no index that
 * satisfied both halves, so Postgres read every matching row and sorted it
 * before the limit applied. Measured against 200,000 runs with 300 open: 22,645
 * shared buffer hits and 25 ms to return 151 rows.
 *
 * The reason this is worth a migration rather than a note is that **the plan
 * flips on data distribution and the bad plan is the realistic one**. With an
 * even open/closed split the planner picks `run_listing_idx` and the query is
 * 0.1 ms; with a small open backlog against a large history — which is what a
 * healthy operations team looks like — it picks the status index and sorts.
 * So the query gets slower precisely as the platform succeeds.
 *
 * Additive, and a new id rather than an edit: the runner checksums applied SQL
 * and refuses the whole run if a released migration changed.
 */
const RUN_LISTING_SQL = `
CREATE INDEX IF NOT EXISTS run_status_listing_idx
  ON run (status, created_at DESC, ordinal DESC);
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0001_record", sql: RECORD_SQL },
  { id: "0019_run_status_listing", sql: RUN_LISTING_SQL },
];
