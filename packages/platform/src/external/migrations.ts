import { InvalidInputError } from "../kernel/errors.js";
import type { BudgetPeriod, ParkedActionStatus } from "./types.js";

/**
 * Schema for the external-agent plane.
 *
 * The platform-wide decisions made in `record/migrations.ts` are inherited
 * unchanged: timestamps are text in one UTC form, structured fields are
 * `jsonb`, and every timestamp column carries the same CHECK. The reasoning is
 * set out there and is not repeated.
 *
 * What is specific to this schema is that most of these tables exist to make a
 * governance control survive concurrency, and several of them carry a
 * constraint whose only job is to make a dangerous value unrepresentable rather
 * than merely unlikely:
 *
 * *No credential value is storable.* `external_credential` has no column a
 * secret fits in. A bearer token is a `sha256:` digest and the CHECK enforces
 * that shape, so an adapter that ever passed a raw token through would fail the
 * write rather than persist it. An HMAC secret is a *name* resolved from the
 * secret manager at verify time, and the CHECK restricts it to an identifier
 * character set — a PEM body or a JWT pasted into that column does not match.
 * The per-kind shape constraint then refuses a credential that carries material
 * belonging to a different kind, which is how a downgrade path gets closed
 * before anyone thinks to look for one.
 *
 * *A meter cannot be created by a typo.* `period_key` is constrained to
 * `lifetime` or `YYYY-MM`. Without it, a mistyped key would silently open a
 * fresh meter at zero — which reads to every ceiling check as an agent with no
 * spend, i.e. as an unlimited budget.
 *
 * *A risk ceiling cannot be `prohibited`.* That tier means "never permitted by
 * this platform, whatever the configuration says". An agent enrolled with it as
 * its ceiling would be admitted to do exactly the things the tier exists to
 * forbid, so the value is refused at the column.
 *
 * *Approval ids sort by bytes.* `external_used_approval.approval_id` and the
 * evicted floor beside it are declared `COLLATE "C"`. The ledger's floor is a
 * comparison between two identifier strings, and the in-memory adapter compares
 * them with JavaScript's `<`, which is code-unit order. A database collation
 * that ordered `_` or case differently would make the two adapters disagree
 * about which approvals are refused — the one divergence in this file that
 * would be a security difference rather than a cosmetic one.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;

/** `lifetime`, or a calendar month. Anything else is a typo, not a period. */
const PERIOD_KEY_SQL = String.raw`^(lifetime|\d{4}-(0[1-9]|1[0-2]))$`;

/** The platform's digest form. Deliberately not "anything 64 characters long". */
const DIGEST_SQL = String.raw`^sha256:[0-9a-f]{64}$`;

/** A secret manager key name: no whitespace, no punctuation a PEM body uses. */
const SECRET_NAME_SQL = String.raw`^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`;

/**
 * The same rules the CHECK constraints state, in TypeScript.
 *
 * Both adapters call these before they write, so the in-memory adapter refuses
 * exactly what Postgres refuses. Stating a rule twice is a real cost; stating
 * it twice in the same file is what keeps the two statements from drifting.
 */

export function assertPeriodKey(periodKey: string): void {
  if (typeof periodKey !== "string" || !/^(lifetime|\d{4}-(0[1-9]|1[0-2]))$/.test(periodKey)) {
    throw new InvalidInputError(
      `A budget period key is "lifetime" or a calendar month like "2026-08" — received: ${String(periodKey)}. An unrecognised key would open a fresh meter at zero, which every ceiling check reads as an agent that has spent nothing.`,
      "periodKey",
    );
  }
}

export function assertSpendAmount(amountUsd: number): void {
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) {
    throw new InvalidInputError(
      `Reported spend must be a finite number, received: ${String(amountUsd)}`,
      "amountUsd",
    );
  }
  if (amountUsd < 0) {
    throw new InvalidInputError(
      `Reported spend must not be negative, received: ${amountUsd}. A negative report would buy back headroom under a ceiling the agent never released.`,
      "amountUsd",
    );
  }
}

/** The digest form the platform uses everywhere, `sha256:<64 hex>`. */
export function assertDigestForm(field: string, value: string): void {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new InvalidInputError(
      `${field} must be a platform digest of the form sha256:<64 hex characters> — received: ${String(value)}`,
      field,
    );
  }
}

export function assertOptionalDigestForm(field: string, value: string | undefined | null): void {
  if (value === undefined || value === null) return;
  assertDigestForm(field, value);
}

/**
 * A stored bearer credential is a hash and nothing else.
 *
 * The check is on the *shape* rather than on provenance, because shape is all
 * that can be verified at the store boundary — but a value that is not a
 * `sha256:` digest is certainly not one, and the thing it is most likely to be
 * is the token itself.
 */
export function assertTokenHash(value: string): void {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new InvalidInputError(
      `A bearer credential is stored as sha256:<64 hex characters>, produced by kernel/hash.js digestBytes. The value supplied is not a digest, and a registry that accepted it would be storing something that authenticates on its own.`,
      "tokenHash",
    );
  }
}

/** An HMAC secret is stored as the NAME to resolve, never as a value. */
export function assertSecretRef(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)) {
    throw new InvalidInputError(
      `An HMAC credential stores the name to resolve from the secret manager, e.g. "mvw/crm/hmac-production" — not the secret. The value supplied is not a name of that form.`,
      "secretRef",
    );
  }
}

/**
 * Budget periods, restated so the adapters can validate without importing the
 * whole type module's runtime surface.
 */
export const BUDGET_PERIODS: readonly BudgetPeriod[] = ["monthly", "lifetime"];

/**
 * Parked-action statuses the expiry sweep may move.
 *
 * Terminal statuses are history and are never touched. `expired` is excluded
 * for a different reason: re-expiring an already-expired action would hand it
 * back to the sweeper on every pass, so the queue would never drain.
 *
 * `approved` is included deliberately, and it is the one judgement call in this
 * file. An approved action whose window has closed must stop being committable
 * — the approver agreed to an action *now*, not whenever the agent next gets
 * round to it — and leaving it approved would keep a stale human decision live
 * indefinitely.
 */
export const EXPIRABLE_PARKED_STATUSES: readonly ParkedActionStatus[] = ["pending", "approved"];

export function isExpirableParkedStatus(status: ParkedActionStatus): boolean {
  return EXPIRABLE_PARKED_STATUSES.includes(status);
}

/**
 * Advisory lock class for the rate-limit counters.
 *
 * The two-integer form of `pg_advisory_xact_lock` occupies a different key
 * space from the single-bigint form the migration runner uses, so this cannot
 * collide with it however the object id hashes.
 */
export const RATE_LIMIT_LOCK_CLASS = 918_273_645;

/** The per-agent ceiling on live nonce claims. Never a global one. */
export const DEFAULT_NONCE_CAP_PER_AGENT = 10_000;

const EXTERNAL_SQL = `
CREATE TABLE IF NOT EXISTS external_agent (
  id                     text PRIMARY KEY,
  -- Insertion order, so listings stay deterministic when several agents share
  -- an enrolled_at. Under a fixed clock — the tests, the seeded demo — they do.
  ordinal                bigserial NOT NULL UNIQUE,
  name                   text NOT NULL,
  owner                  text NOT NULL,
  department             text NOT NULL,
  host_platform          text NOT NULL,
  purpose                text NOT NULL,
  allowed_tools          jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_ceiling           text NOT NULL,
  spend_ceiling_usd      numeric(20, 10) NOT NULL,
  budget_period          text NOT NULL,
  wall_clock_ceiling_ms  bigint NOT NULL,
  data_scopes            jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at             text NOT NULL,
  status                 text NOT NULL,
  status_reason          text,
  status_changed_at      text,
  status_changed_by      text,
  enrolled_by            text NOT NULL,
  enrolled_at            text NOT NULL,
  updated_at             text NOT NULL,
  last_seen_at           text,
  CONSTRAINT external_agent_status_known CHECK (status IN ('active','contained','revoked')),
  -- 'prohibited' is absent on purpose. It means "never permitted by this
  -- platform, whatever the configuration says", so an agent holding it as a
  -- ceiling would be admitted to do precisely what the tier forbids.
  CONSTRAINT external_agent_risk_ceiling_known CHECK (
    risk_ceiling IN ('routine','sensitive','high_consequence')
  ),
  CONSTRAINT external_agent_budget_period_known CHECK (budget_period IN ('monthly','lifetime')),
  CONSTRAINT external_agent_name_present CHECK (name <> ''),
  -- Accountability is the point of enrolment. A blank owner is an agent nobody
  -- answers for, which is the condition this module exists to end.
  CONSTRAINT external_agent_owner_present CHECK (owner <> ''),
  CONSTRAINT external_agent_spend_ceiling_non_negative CHECK (spend_ceiling_usd >= 0),
  CONSTRAINT external_agent_wall_clock_positive CHECK (wall_clock_ceiling_ms > 0),
  CONSTRAINT external_agent_tools_are_a_list CHECK (jsonb_typeof(allowed_tools) = 'array'),
  CONSTRAINT external_agent_scopes_are_a_list CHECK (jsonb_typeof(data_scopes) = 'array'),
  CONSTRAINT external_agent_expires_at_utc CHECK (expires_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT external_agent_enrolled_at_utc CHECK (enrolled_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT external_agent_updated_at_utc CHECK (updated_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT external_agent_status_changed_at_utc CHECK (
    status_changed_at IS NULL OR status_changed_at ~ '${ISO_UTC_SQL}'
  ),
  CONSTRAINT external_agent_last_seen_at_utc CHECK (
    last_seen_at IS NULL OR last_seen_at ~ '${ISO_UTC_SQL}'
  )
);

-- Byte ordering, so the unique check and the roster ordering mean the same
-- thing here as they do in the in-memory adapter.
CREATE UNIQUE INDEX IF NOT EXISTS external_agent_name_unique
  ON external_agent (name COLLATE "C");
CREATE INDEX IF NOT EXISTS external_agent_status_idx ON external_agent (status);
CREATE INDEX IF NOT EXISTS external_agent_department_idx ON external_agent (department);

/*
 * The seat counter.
 *
 * One row, incremented under a row lock. Counting agents and then inserting
 * one lets two concurrent enrolments both observe count < cap and both
 * succeed, which makes the commercial term unenforceable at exactly the moment
 * it is worth money. The counter is separate from the agent table because the
 * cap is on seats claimed rather than on rows present: an agent may be revoked
 * and still hold its seat until an operator releases it.
 */
CREATE TABLE IF NOT EXISTS external_seat (
  id       text PRIMARY KEY,
  claimed  integer NOT NULL,
  CONSTRAINT external_seat_claimed_non_negative CHECK (claimed >= 0)
);

CREATE TABLE IF NOT EXISTS external_spend_meter (
  agent_id    text NOT NULL,
  period_key  text NOT NULL,
  -- Exact decimal rather than a float. This column is compared against a
  -- ceiling, and accumulated binary rounding error in a control is a control
  -- that fails at the boundary.
  spent_usd   numeric(20, 10) NOT NULL DEFAULT 0,
  updated_at  text NOT NULL,
  PRIMARY KEY (agent_id, period_key),
  CONSTRAINT external_spend_meter_non_negative CHECK (spent_usd >= 0),
  CONSTRAINT external_spend_meter_period_known CHECK (period_key ~ '${PERIOD_KEY_SQL}'),
  CONSTRAINT external_spend_meter_updated_at_utc CHECK (updated_at ~ '${ISO_UTC_SQL}')
);

CREATE TABLE IF NOT EXISTS external_credential (
  id              text PRIMARY KEY,
  ordinal         bigserial NOT NULL UNIQUE,
  -- The one foreign key in this schema. A credential row whose agent was never
  -- enrolled would authenticate a principal the registry has never heard of,
  -- and admission is built entirely on the registry.
  agent_id        text NOT NULL REFERENCES external_agent (id) ON DELETE RESTRICT,
  kind            text NOT NULL,
  label           text NOT NULL,
  token_hash      text,
  issuer          text,
  audience        text,
  jwks_path       text,
  secret_ref      text,
  public_key      text,
  created_by      text NOT NULL,
  created_at      text NOT NULL,
  expires_at      text,
  revoked_at      text,
  revoked_by      text,
  revoked_reason  text,
  last_used_at    text,
  CONSTRAINT external_credential_kind_known CHECK (kind IN ('bearer','jwt','hmac','envelope')),
  CONSTRAINT external_credential_label_present CHECK (label <> ''),
  CONSTRAINT external_credential_token_hash_is_a_digest CHECK (
    token_hash IS NULL OR token_hash ~ '${DIGEST_SQL}'
  ),
  CONSTRAINT external_credential_secret_ref_is_a_name CHECK (
    secret_ref IS NULL OR secret_ref ~ '${SECRET_NAME_SQL}'
  ),
  -- Each kind carries its own material and nothing else. Without this a bearer
  -- row could also carry a secret_ref, and a verifier that trusted the row's
  -- kind would have a second, unexamined way in.
  CONSTRAINT external_credential_shape CHECK (
    CASE kind
      WHEN 'bearer' THEN
        token_hash IS NOT NULL AND secret_ref IS NULL AND public_key IS NULL
        AND jwks_path IS NULL AND issuer IS NULL AND audience IS NULL
      WHEN 'jwt' THEN
        issuer IS NOT NULL AND audience IS NOT NULL AND jwks_path IS NOT NULL
        AND token_hash IS NULL AND secret_ref IS NULL AND public_key IS NULL
      WHEN 'hmac' THEN
        secret_ref IS NOT NULL AND token_hash IS NULL AND public_key IS NULL
        AND jwks_path IS NULL
      WHEN 'envelope' THEN
        public_key IS NOT NULL AND token_hash IS NULL AND secret_ref IS NULL
        AND jwks_path IS NULL
      ELSE false
    END
  ),
  CONSTRAINT external_credential_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT external_credential_expires_at_utc CHECK (
    expires_at IS NULL OR expires_at ~ '${ISO_UTC_SQL}'
  ),
  CONSTRAINT external_credential_revoked_at_utc CHECK (
    revoked_at IS NULL OR revoked_at ~ '${ISO_UTC_SQL}'
  ),
  CONSTRAINT external_credential_last_used_at_utc CHECK (
    last_used_at IS NULL OR last_used_at ~ '${ISO_UTC_SQL}'
  )
);

-- Two agents sharing a token hash would mean one token authenticating as
-- either of them, and the lookup would have to pick. It cannot be created.
CREATE UNIQUE INDEX IF NOT EXISTS external_credential_token_hash_unique
  ON external_credential (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS external_credential_agent_idx ON external_credential (agent_id);

/*
 * Nonce claims.
 *
 * Durable and shared, because an in-memory cache lets a captured request
 * replay successfully against a second worker. Bounded per agent rather than
 * globally, because a global bound lets two busy agents evict everyone else's
 * claims and lock them out — a denial of service one tenant inflicts on
 * another simply by being ordinary.
 */
CREATE TABLE IF NOT EXISTS external_nonce (
  agent_id    text NOT NULL,
  nonce       text NOT NULL,
  -- Claim order, which is what "evict this agent's oldest" is measured in.
  ordinal     bigserial NOT NULL,
  expires_at  text NOT NULL,
  PRIMARY KEY (agent_id, nonce),
  CONSTRAINT external_nonce_present CHECK (nonce <> ''),
  CONSTRAINT external_nonce_expires_at_utc CHECK (expires_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS external_nonce_agent_idx ON external_nonce (agent_id, ordinal);
CREATE INDEX IF NOT EXISTS external_nonce_expiry_idx ON external_nonce (expires_at);

/*
 * The one-shot ledger for consumed approvals, and its floor.
 *
 * The floor is the part that matters. A bounded ledger that simply forgets
 * makes an old approval reusable the moment it ages out — the protection
 * expires instead of the approval, silently, and nothing in the system looks
 * different afterwards. So eviction raises a floor of the highest id it has
 * ever dropped, and anything at or below the floor is reported as consumed.
 *
 * That deliberately over-refuses: identifiers are not ordered by time, so ids
 * below the floor that were never used are refused too. Which is the correct
 * direction. Forgetting must only ever refuse.
 */
CREATE TABLE IF NOT EXISTS external_used_approval (
  approval_id  text COLLATE "C" PRIMARY KEY,
  consumed_at  text NOT NULL,
  CONSTRAINT external_used_approval_consumed_at_utc CHECK (consumed_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS external_used_approval_consumed_at_idx
  ON external_used_approval (consumed_at);

CREATE TABLE IF NOT EXISTS external_approval_floor (
  id                 text PRIMARY KEY,
  floor_approval_id  text COLLATE "C" NOT NULL,
  -- The cutoff that produced this floor, so an operator reading the table can
  -- tell what was dropped rather than only how high the wall is.
  evicted_before     text NOT NULL,
  CONSTRAINT external_approval_floor_evicted_before_utc CHECK (
    evicted_before ~ '${ISO_UTC_SQL}'
  )
);

CREATE TABLE IF NOT EXISTS external_parked_action (
  id              text PRIMARY KEY,
  ordinal         bigserial NOT NULL UNIQUE,
  agent_id        text NOT NULL,
  integration     text NOT NULL,
  operation       text NOT NULL,
  -- What the approval binds to. Any difference between the approved request
  -- and the committed one is a different digest and voids the action.
  request_digest  text NOT NULL,
  preview         jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_id     text,
  status          text NOT NULL,
  created_at      text NOT NULL,
  expires_at      text NOT NULL,
  committed_at    text,
  result_digest   text,
  result_summary  text,
  void_reason     text,
  run_id          text,
  correlation_id  text,
  CONSTRAINT external_parked_action_status_known CHECK (
    status IN ('pending','approved','committed','rejected','voided','expired','indeterminate')
  ),
  CONSTRAINT external_parked_action_request_digest_form CHECK (request_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT external_parked_action_result_digest_form CHECK (
    result_digest IS NULL OR result_digest ~ '${DIGEST_SQL}'
  ),
  CONSTRAINT external_parked_action_preview_is_a_list CHECK (jsonb_typeof(preview) = 'array'),
  CONSTRAINT external_parked_action_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT external_parked_action_expires_at_utc CHECK (expires_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT external_parked_action_committed_at_utc CHECK (
    committed_at IS NULL OR committed_at ~ '${ISO_UTC_SQL}'
  )
);

CREATE INDEX IF NOT EXISTS external_parked_action_agent_idx
  ON external_parked_action (agent_id, status);
-- The sweep's query, partial on the statuses it can still move. There will
-- eventually be far more settled actions than live ones.
CREATE INDEX IF NOT EXISTS external_parked_action_expiry_idx
  ON external_parked_action (expires_at)
  WHERE status IN ('pending','approved');

CREATE TABLE IF NOT EXISTS external_run (
  id                 text PRIMARY KEY,
  ordinal            bigserial NOT NULL UNIQUE,
  agent_id           text NOT NULL,
  -- The operating-record run this external work is accounted for under. One
  -- record, one queue, one report — a parallel system for external agents
  -- would recreate the blind spot this module exists to close.
  run_id             text NOT NULL,
  goal               text NOT NULL,
  status             text NOT NULL,
  started_at         text NOT NULL,
  last_heartbeat_at  text NOT NULL,
  ended_at           text,
  outcome            text,
  cost_usd           numeric(20, 10) NOT NULL DEFAULT 0,
  correlation_id     text,
  CONSTRAINT external_run_status_known CHECK (
    status IN ('running','finished','failed','stopped','reclaimed')
  ),
  CONSTRAINT external_run_cost_non_negative CHECK (cost_usd >= 0),
  CONSTRAINT external_run_started_at_utc CHECK (started_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT external_run_heartbeat_utc CHECK (last_heartbeat_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT external_run_ended_at_utc CHECK (ended_at IS NULL OR ended_at ~ '${ISO_UTC_SQL}')
);

-- One external run per operating-record run, so cost and step queries cannot
-- silently aggregate two episodes into one.
CREATE UNIQUE INDEX IF NOT EXISTS external_run_record_run_unique ON external_run (run_id);
CREATE INDEX IF NOT EXISTS external_run_agent_idx ON external_run (agent_id, ordinal DESC);
-- The reclaim sweep. A run that has stopped heartbeating is reclaimed rather
-- than assumed healthy, because the heartbeat is the only moment an agent that
-- runs elsewhere can be told to stop.
CREATE INDEX IF NOT EXISTS external_run_stale_idx
  ON external_run (last_heartbeat_at) WHERE status = 'running';

/*
 * Exactly-once report ingestion.
 *
 * The key is scoped to the agent. A global key space would let one agent
 * suppress another's report by claiming its key first — which is both a
 * denial of service and a way to make work disappear from the record.
 */
CREATE TABLE IF NOT EXISTS external_report_claim (
  agent_id         text NOT NULL,
  idempotency_key  text NOT NULL,
  run_id           text NOT NULL,
  claimed_at       text NOT NULL,
  PRIMARY KEY (agent_id, idempotency_key),
  -- A blank key matches every other blank key, so a blank key does not
  -- deduplicate reports, it merges unrelated ones into the first.
  CONSTRAINT external_report_claim_key_present CHECK (idempotency_key <> ''),
  CONSTRAINT external_report_claim_claimed_at_utc CHECK (claimed_at ~ '${ISO_UTC_SQL}')
);

/*
 * Sliding-window counters.
 *
 * Rows rather than a running total, because a total cannot forget the requests
 * that have fallen out of the window. Each recorder prunes its own key's
 * expired rows inside the same transaction, so the tables stay bounded by the
 * window rather than by the deployment's lifetime.
 */
CREATE TABLE IF NOT EXISTS external_rate_request (
  ordinal    bigserial PRIMARY KEY,
  agent_id   text NOT NULL,
  operation  text NOT NULL,
  at         text NOT NULL,
  CONSTRAINT external_rate_request_at_utc CHECK (at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS external_rate_request_window_idx
  ON external_rate_request (agent_id, operation, at);

CREATE TABLE IF NOT EXISTS external_rate_denial (
  ordinal       bigserial PRIMARY KEY,
  agent_id      text NOT NULL,
  -- Misbehaviour counts toward automatic containment. Infrastructure denials
  -- are stored so an operator can see them and are deliberately not counted:
  -- containing an agent because our own database blinked punishes a
  -- well-behaved team for our outage.
  denial_class  text NOT NULL,
  at            text NOT NULL,
  CONSTRAINT external_rate_denial_class_known CHECK (
    denial_class IN ('misbehaviour','infrastructure')
  ),
  CONSTRAINT external_rate_denial_at_utc CHECK (at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS external_rate_denial_window_idx
  ON external_rate_denial (agent_id, denial_class, at);
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0016_external", sql: EXTERNAL_SQL },
];
