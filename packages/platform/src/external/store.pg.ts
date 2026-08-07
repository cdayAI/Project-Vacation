import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import { storeUnavailable, type Db } from "../store/db.js";
import {
  BUDGET_PERIODS,
  DEFAULT_NONCE_CAP_PER_AGENT,
  EXPIRABLE_PARKED_STATUSES,
  RATE_LIMIT_LOCK_CLASS,
  assertDigestForm,
  assertOptionalDigestForm,
  assertPeriodKey,
  assertSecretRef,
  assertSpendAmount,
  assertTokenHash,
} from "./migrations.js";
import type {
  CredentialStore,
  EnrollmentStore,
  ExternalRunStore,
  NonceStore,
  ParkedActionStore,
  RateLimitStore,
  SpendStore,
  UsedApprovalLedger,
} from "./port.js";
import {
  STRONG_CREDENTIAL_KINDS,
  TERMINAL_AGENT_STATUSES,
  TERMINAL_PARKED_STATUSES,
  type AgentCredential,
  type AgentStatus,
  type BudgetPeriod,
  type CredentialKind,
  type DenialClass,
  type EnrolledAgent,
  type EnrollmentUpdate,
  type ExternalAgentId,
  type ExternalRun,
  type ExternalRunStatus,
  type ParkedAction,
  type ParkedActionStatus,
  type SpendMeter,
  type ToolGrant,
} from "./types.js";

/**
 * Postgres external-agent plane.
 *
 * Every method the port marks atomic is a single statement or a transaction
 * with a lock, never a read followed by a write in this file. Each of them is a
 * governance control that is correct in isolation and wrong under load, and
 * this service runs as several workers:
 *
 *   `claimSeat` is one conditional upsert. Counting agents and then inserting
 *   lets two enrolments both observe `count < cap`.
 *
 *   `addSpend` is `INSERT ... ON CONFLICT DO UPDATE SET spent = spent +
 *   EXCLUDED.spent RETURNING`. Read-modify-write loses concurrent reports, and
 *   a lost report is spend that happened and does not count.
 *
 *   `claimNonce` is `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so of two
 *   workers handed the same replayed request exactly one sees a row.
 *
 *   `claimApproval` is a guarded insert that also consults the evicted floor,
 *   so an approval the ledger has forgotten is refused rather than replayed.
 *
 *   `transitionParkedAction` and `setAgentStatus` are compare-and-set updates.
 *   The empty result is the answer: a duplicate commit, or a containment
 *   decided from a stale read that must not clobber a revocation.
 *
 *   `claimReport` is `ON CONFLICT DO UPDATE`, which blocks on a concurrent
 *   claim and then reports the id it committed. `DO NOTHING` is the obvious
 *   alternative and is wrong here — see the comment on the method.
 *
 *   `recordRequest` and `recordDenial` take a transaction-scoped advisory lock
 *   on their own key, so concurrent recorders queue rather than each counting a
 *   window that does not yet contain the others.
 *
 * Every database failure is wrapped in `storeUnavailable`, which raises a
 * `DeniedError`: a caller that cannot reach this store must refuse rather than
 * admit an agent it cannot account for.
 */

type AgentRow = {
  id: string;
  name: string;
  owner: string;
  department: string;
  host_platform: string;
  purpose: string;
  allowed_tools: ToolGrant[];
  risk_ceiling: string;
  spend_ceiling_usd: string;
  budget_period: string;
  wall_clock_ceiling_ms: string;
  data_scopes: string[];
  expires_at: string;
  status: string;
  status_reason: string | null;
  status_changed_at: string | null;
  status_changed_by: string | null;
  enrolled_by: string;
  enrolled_at: string;
  updated_at: string;
  last_seen_at: string | null;
};

type MeterRow = {
  agent_id: string;
  period_key: string;
  spent_usd: string;
  updated_at: string;
};

type CredentialRow = {
  id: string;
  agent_id: string;
  kind: string;
  label: string;
  token_hash: string | null;
  issuer: string | null;
  audience: string | null;
  jwks_path: string | null;
  secret_ref: string | null;
  public_key: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
  last_used_at: string | null;
};

type ParkedRow = {
  id: string;
  agent_id: string;
  integration: string;
  operation: string;
  mode: string;
  request_digest: string;
  preview: { label: string; value: string }[];
  approval_id: string | null;
  status: string;
  created_at: string;
  expires_at: string;
  committed_at: string | null;
  committing_at: string | null;
  result_digest: string | null;
  result_summary: string | null;
  void_reason: string | null;
  run_id: string | null;
  correlation_id: string | null;
};

type ExternalRunRow = {
  id: string;
  agent_id: string;
  run_id: string;
  goal: string;
  status: string;
  started_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  outcome: string | null;
  cost_usd: string;
  correlation_id: string | null;
};

const AGENT_COLUMNS = `id, name, owner, department, host_platform, purpose, allowed_tools,
  risk_ceiling, spend_ceiling_usd, budget_period, wall_clock_ceiling_ms, data_scopes,
  expires_at, status, status_reason, status_changed_at, status_changed_by, enrolled_by,
  enrolled_at, updated_at, last_seen_at`;

const METER_COLUMNS = `agent_id, period_key, spent_usd, updated_at`;

const CREDENTIAL_COLUMNS = `id, agent_id, kind, label, token_hash, issuer, audience, jwks_path,
  secret_ref, public_key, created_by, created_at, expires_at, revoked_at, revoked_by,
  revoked_reason, last_used_at`;

const PARKED_COLUMNS = `id, agent_id, integration, operation, mode, request_digest, preview,
  approval_id, status, created_at, expires_at, committed_at, committing_at, result_digest,
  result_summary, void_reason, run_id, correlation_id`;

const EXTERNAL_RUN_COLUMNS = `id, agent_id, run_id, goal, status, started_at, last_heartbeat_at,
  ended_at, outcome, cost_usd, correlation_id`;

/**
 * The fields a re-enrolment may write, and the columns they map to.
 *
 * `status`, `enrolled_at` and the spend meters are absent by construction. If a
 * re-enrolment could reach them it would become the documented way to reset a
 * meter and lift a containment, which is precisely how an enrolment system
 * stops meaning anything.
 */
const ENROLLMENT_UPDATE_COLUMNS: Readonly<Record<keyof EnrollmentUpdate, string>> = {
  owner: "owner",
  department: "department",
  hostPlatform: "host_platform",
  purpose: "purpose",
  allowedTools: "allowed_tools",
  riskCeiling: "risk_ceiling",
  spendCeilingUsd: "spend_ceiling_usd",
  budgetPeriod: "budget_period",
  wallClockCeilingMs: "wall_clock_ceiling_ms",
  dataScopes: "data_scopes",
  expiresAt: "expires_at",
};

/** Update fields that are stored as jsonb and so have to be serialised. */
const JSON_UPDATE_FIELDS: readonly (keyof EnrollmentUpdate)[] = ["allowedTools", "dataScopes"];

const SEAT_ROW = "seats";
const FLOOR_ROW = "floor";

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export class PgEnrollmentStore implements EnrollmentStore {
  constructor(private readonly db: Db) {}

  async createAgent(agent: EnrolledAgent): Promise<EnrolledAgent> {
    assertAgent(agent);

    return this.guard("createAgent", () =>
      this.db.transaction(async (tx) => {
        // The NOT EXISTS produces a readable refusal in the ordinary case. The
        // unique index over `name` is what makes a duplicate impossible in the
        // racing case — there the loser's write fails and is refused, which is
        // the correct outcome with a less helpful message.
        const inserted = await tx.query<AgentRow>(
          `INSERT INTO external_agent (${AGENT_COLUMNS})
           SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb,
                  $8::text, $9::numeric, $10::text, $11::bigint, $12::jsonb, $13::text,
                  $14::text, $15::text, $16::text, $17::text, $18::text, $19::text,
                  $20::text, $21::text
           WHERE NOT EXISTS (SELECT 1 FROM external_agent WHERE name = $2)
           ON CONFLICT (id) DO NOTHING
           RETURNING ${AGENT_COLUMNS}`,
          [
            agent.id,
            agent.name,
            agent.owner,
            agent.department,
            agent.hostPlatform,
            agent.purpose,
            JSON.stringify([...agent.allowedTools]),
            agent.riskCeiling,
            agent.spendCeilingUsd,
            agent.budgetPeriod,
            agent.wallClockCeilingMs,
            JSON.stringify([...agent.dataScopes]),
            agent.expiresAt,
            agent.status,
            agent.statusReason ?? null,
            agent.statusChangedAt ?? null,
            agent.statusChangedBy ?? null,
            agent.enrolledBy,
            agent.enrolledAt,
            agent.updatedAt,
            agent.lastSeenAt ?? null,
          ],
        );

        const row = inserted[0];
        if (row) return toAgent(row);

        // Nothing landed. Read back inside the same transaction to say which
        // of the two uniqueness rules was hit, because "already exists" without
        // saying what already exists is an unhelpful thing to hand an operator.
        const clash = await tx.query<{ id: string; name: string }>(
          "SELECT id, name FROM external_agent WHERE id = $1 OR name = $2",
          [agent.id, agent.name],
        );
        if (clash.some((existing) => existing.id === agent.id)) {
          throw new InvalidInputError(
            `External agent ${agent.id} already exists. Agent identifiers are assigned once; reusing one would silently re-point every credential, meter and run that already refers to it.`,
            "id",
          );
        }
        throw new InvalidInputError(
          `An external agent named "${agent.name}" is already enrolled. Names are how operators identify an agent in the roster and in an incident, so two agents cannot share one.`,
          "name",
        );
      }),
    );
  }

  async getAgent(id: ExternalAgentId): Promise<EnrolledAgent | null> {
    const rows = await this.guard("getAgent", () =>
      this.db.query<AgentRow>(`SELECT ${AGENT_COLUMNS} FROM external_agent WHERE id = $1`, [id]),
    );
    const row = rows[0];
    return row ? toAgent(row) : null;
  }

  async getAgentByName(name: string): Promise<EnrolledAgent | null> {
    // `=` on the indexed column: an exact comparison, never a pattern and
    // never a case-insensitive one. "CRM-Bot" and "crm-bot" are two enrolments
    // with two owners and two ceilings.
    const rows = await this.guard("getAgentByName", () =>
      this.db.query<AgentRow>(`SELECT ${AGENT_COLUMNS} FROM external_agent WHERE name = $1`, [name]),
    );
    const row = rows[0];
    return row ? toAgent(row) : null;
  }

  async listAgents(
    filter: {
      readonly status?: readonly AgentStatus[];
      readonly department?: string;
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): Promise<readonly EnrolledAgent[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.status && filter.status.length > 0) {
      values.push([...filter.status]);
      clauses.push(`status = ANY($${values.length}::text[])`);
    }
    if (filter.department !== undefined) {
      values.push(filter.department);
      clauses.push(`department = $${values.length}`);
    }

    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page += ` LIMIT $${values.length}`;
    }
    if (filter.offset !== undefined) {
      values.push(filter.offset);
      page += ` OFFSET $${values.length}`;
    }

    const rows = await this.guard("listAgents", () =>
      this.db.query<AgentRow>(
        `SELECT ${AGENT_COLUMNS} FROM external_agent
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY name COLLATE "C" ASC${page}`,
        values,
      ),
    );
    return rows.map(toAgent);
  }

  async countAgents(): Promise<number> {
    const rows = await this.guard("countAgents", () =>
      this.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM external_agent"),
    );
    return Number(rows[0]?.count ?? 0);
  }

  async updateAgent(
    id: ExternalAgentId,
    update: EnrollmentUpdate,
    at: string,
  ): Promise<EnrolledAgent> {
    assertIsoUtc("at", at);
    assertOptionalIsoUtc("expiresAt", update.expiresAt);
    if (update.riskCeiling !== undefined) assertRiskCeiling(update.riskCeiling);
    if (update.budgetPeriod !== undefined) assertBudgetPeriod(update.budgetPeriod);
    if (update.spendCeilingUsd !== undefined) assertSpendAmount(update.spendCeilingUsd);

    const sql: string[] = [];
    const values: unknown[] = [];
    for (const [field, value] of Object.entries(update)) {
      if (value === undefined) continue;
      // Only declared update fields reach the SET clause. A caller that passes
      // a whole agent where an update was expected cannot rewrite its status
      // or its enrolment time through this door.
      const column = ENROLLMENT_UPDATE_COLUMNS[field as keyof EnrollmentUpdate];
      if (!column) continue;
      const serialise = JSON_UPDATE_FIELDS.includes(field as keyof EnrollmentUpdate);
      values.push(serialise ? JSON.stringify(value) : value);
      sql.push(`${column} = $${values.length}${serialise ? "::jsonb" : ""}`);
    }
    values.push(at);
    sql.push(`updated_at = $${values.length}`);
    values.push(id);

    const rows = await this.guard("updateAgent", () =>
      this.db.query<AgentRow>(
        `UPDATE external_agent SET ${sql.join(", ")} WHERE id = $${values.length}
         RETURNING ${AGENT_COLUMNS}`,
        values,
      ),
    );
    const row = rows[0];
    if (!row) throw unknownAgent(id);
    return toAgent(row);
  }

  async setAgentStatus(input: {
    readonly id: ExternalAgentId;
    readonly expectedStatus: AgentStatus;
    readonly status: AgentStatus;
    readonly reason: string;
    readonly by: string;
    readonly at: string;
  }): Promise<EnrolledAgent | null> {
    assertIsoUtc("at", input.at);

    // Compare and set in one statement. Postgres serialises concurrent updates
    // of a row, so a containment decided from a stale read matches nothing
    // rather than overwriting a revocation another process already applied.
    //
    // The terminal-status clause is a second, different control, and it is in
    // the WHERE rather than in a service because compare-and-set stops only a
    // *stale* writer: a caller that reads first and then asks for
    // `revoked → active` satisfies `status = $2` exactly. Matching nothing is
    // what stops an offboarding being undone by a status flip. The list is
    // `TERMINAL_AGENT_STATUSES`, shared with the memory adapter so a rule one
    // store keeps and the other does not cannot exist.
    const rows = await this.guard("setAgentStatus", () =>
      this.db.query<AgentRow>(
        `UPDATE external_agent
         SET status = $3, status_reason = $4, status_changed_at = $5, status_changed_by = $6,
             updated_at = $5
         WHERE id = $1 AND status = $2 AND NOT (status = ANY($7::text[]))
         RETURNING ${AGENT_COLUMNS}`,
        [
          input.id,
          input.expectedStatus,
          input.status,
          input.reason,
          input.at,
          input.by,
          [...TERMINAL_AGENT_STATUSES],
        ],
      ),
    );
    const row = rows[0];
    return row ? toAgent(row) : null;
  }

  async touchLastSeen(id: ExternalAgentId, at: string): Promise<void> {
    assertIsoUtc("at", at);
    // Silent when the agent is gone. This is telemetry on the admission path
    // and must never be the thing that refuses a request.
    await this.guard("touchLastSeen", () =>
      this.db.query("UPDATE external_agent SET last_seen_at = $2 WHERE id = $1", [id, at]),
    );
  }

  async claimSeat(cap: number): Promise<boolean> {
    assertCap(cap);

    // One conditional upsert. `ON CONFLICT DO UPDATE` re-reads the current row
    // version under a row lock, so concurrent claimants queue and each sees
    // the previous one's increment — which is the whole difference between a
    // seat cap and a suggestion. The `WHERE $1 >= 1` guard covers the
    // first-ever claim against a cap of zero, where there is no row to conflict
    // with and the plain insert would hand out a seat that does not exist.
    const rows = await this.guard("claimSeat", () =>
      this.db.query<{ claimed: number }>(
        `INSERT INTO external_seat (id, claimed)
         SELECT $2::text, 1 WHERE $1::integer >= 1
         ON CONFLICT (id) DO UPDATE SET claimed = external_seat.claimed + 1
           WHERE external_seat.claimed < $1::integer
         RETURNING claimed`,
        [cap, SEAT_ROW],
      ),
    );
    return rows.length > 0;
  }

  async releaseSeat(): Promise<void> {
    // Floored at zero. A release without a matching claim is an operator
    // error, and a negative counter would hand out free seats.
    await this.guard("releaseSeat", () =>
      this.db.query("UPDATE external_seat SET claimed = GREATEST(claimed - 1, 0) WHERE id = $1", [
        SEAT_ROW,
      ]),
    );
  }

  private guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return runGuarded(operation, fn);
  }
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

export class PgSpendStore implements SpendStore {
  constructor(private readonly db: Db) {}

  async addSpend(
    agentId: ExternalAgentId,
    periodKey: string,
    amountUsd: number,
    at: string,
  ): Promise<number> {
    assertPeriodKey(periodKey);
    assertSpendAmount(amountUsd);
    assertIsoUtc("at", at);

    // The addition happens inside the database, on the row Postgres has
    // locked. A read followed by a write loses concurrent reports, and every
    // lost report is spend that happened and does not count against the
    // ceiling — the failure mode that makes a ceiling decorative.
    const rows = await runGuarded("addSpend", () =>
      this.db.query<{ spent_usd: string }>(
        `INSERT INTO external_spend_meter (${METER_COLUMNS})
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (agent_id, period_key) DO UPDATE
           SET spent_usd = external_spend_meter.spent_usd + EXCLUDED.spent_usd,
               updated_at = EXCLUDED.updated_at
         RETURNING spent_usd`,
        [agentId, periodKey, amountUsd, at],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new DeniedError(
        "record.unavailable",
        `Spend for ${agentId} could not be recorded, so the work it paid for must be refused rather than performed uncounted.`,
        { agentId, periodKey },
      );
    }
    return Number(row.spent_usd);
  }

  async getMeter(agentId: ExternalAgentId, periodKey: string): Promise<SpendMeter | null> {
    assertPeriodKey(periodKey);
    const rows = await runGuarded("getMeter", () =>
      this.db.query<MeterRow>(
        `SELECT ${METER_COLUMNS} FROM external_spend_meter WHERE agent_id = $1 AND period_key = $2`,
        [agentId, periodKey],
      ),
    );
    const row = rows[0];
    return row ? toMeter(row) : null;
  }

  async listMeters(agentId: ExternalAgentId): Promise<readonly SpendMeter[]> {
    const rows = await runGuarded("listMeters", () =>
      this.db.query<MeterRow>(
        `SELECT ${METER_COLUMNS} FROM external_spend_meter WHERE agent_id = $1
         ORDER BY period_key COLLATE "C" ASC`,
        [agentId],
      ),
    );
    return rows.map(toMeter);
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export class PgCredentialStore implements CredentialStore {
  constructor(private readonly db: Db) {}

  async createCredential(credential: AgentCredential): Promise<AgentCredential> {
    assertCredential(credential);

    return runGuarded("createCredential", () =>
      this.db.transaction(async (tx) => {
        const inserted = await tx.query<CredentialRow>(
          `INSERT INTO external_credential (${CREDENTIAL_COLUMNS})
           SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text,
                  $8::text, $9::text, $10::text, $11::text, $12::text, $13::text,
                  $14::text, $15::text, $16::text, $17::text
           WHERE EXISTS (SELECT 1 FROM external_agent WHERE id = $2)
             AND NOT EXISTS (SELECT 1 FROM external_credential WHERE token_hash = $5)
           ON CONFLICT (id) DO NOTHING
           RETURNING ${CREDENTIAL_COLUMNS}`,
          [
            credential.id,
            credential.agentId,
            credential.kind,
            credential.label,
            credential.tokenHash ?? null,
            credential.issuer ?? null,
            credential.audience ?? null,
            credential.jwksPath ?? null,
            credential.secretRef ?? null,
            credential.publicKey ?? null,
            credential.createdBy,
            credential.createdAt,
            credential.expiresAt ?? null,
            credential.revokedAt ?? null,
            credential.revokedBy ?? null,
            credential.revokedReason ?? null,
            credential.lastUsedAt ?? null,
          ],
        );

        const row = inserted[0];
        if (row) return toCredential(row);

        // Say which rule refused it. Three can, and they mean different things
        // to whoever is trying to mint a credential.
        const agent = await tx.query<{ id: string }>(
          "SELECT id FROM external_agent WHERE id = $1",
          [credential.agentId],
        );
        if (agent.length === 0) {
          throw new InvalidInputError(
            `Cannot mint a credential for ${credential.agentId}: no such external agent is enrolled. A credential without an enrolment authenticates a principal nothing governs.`,
            "agentId",
          );
        }
        const existing = await tx.query<{ id: string }>(
          "SELECT id FROM external_credential WHERE id = $1",
          [credential.id],
        );
        if (existing.length > 0) {
          throw new InvalidInputError(`Credential ${credential.id} already exists.`, "id");
        }
        throw new InvalidInputError(
          "That bearer token is already registered to another credential. One token cannot authenticate as two principals.",
          "tokenHash",
        );
      }),
    );
  }

  async getCredential(id: Id<"credential">): Promise<AgentCredential | null> {
    const rows = await runGuarded("getCredential", () =>
      this.db.query<CredentialRow>(
        `SELECT ${CREDENTIAL_COLUMNS} FROM external_credential WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toCredential(row) : null;
  }

  async listCredentials(agentId: ExternalAgentId): Promise<readonly AgentCredential[]> {
    const rows = await runGuarded("listCredentials", () =>
      this.db.query<CredentialRow>(
        `SELECT ${CREDENTIAL_COLUMNS} FROM external_credential WHERE agent_id = $1
         ORDER BY ordinal ASC`,
        [agentId],
      ),
    );
    return rows.map(toCredential);
  }

  async findByTokenHash(tokenHash: string): Promise<AgentCredential | null> {
    // The store refuses to look up anything that is not a digest. A caller
    // that passed the raw token would otherwise send it across the wire to the
    // database and into its query logs.
    assertTokenHash(tokenHash);

    // Revoked and expired credentials come back rather than being hidden. The
    // verifier has to be able to say "that credential was revoked" instead of
    // "no such credential": the second invites a caller to conclude it used
    // the wrong token and keep trying.
    const rows = await runGuarded("findByTokenHash", () =>
      this.db.query<CredentialRow>(
        `SELECT ${CREDENTIAL_COLUMNS} FROM external_credential WHERE token_hash = $1`,
        [tokenHash],
      ),
    );
    const row = rows[0];
    return row ? toCredential(row) : null;
  }

  async revokeCredential(
    id: Id<"credential">,
    at: string,
    by: string,
    reason: string,
  ): Promise<AgentCredential | null> {
    assertIsoUtc("at", at);

    // Conditional on being unrevoked, so the first revocation wins and a
    // second cannot rewrite who stopped this credential or why — the field an
    // incident review reads first.
    const rows = await runGuarded("revokeCredential", () =>
      this.db.query<CredentialRow>(
        `UPDATE external_credential
         SET revoked_at = $2, revoked_by = $3, revoked_reason = $4
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING ${CREDENTIAL_COLUMNS}`,
        [id, at, by, reason],
      ),
    );
    const row = rows[0];
    return row ? toCredential(row) : null;
  }

  async touchCredentialUsed(id: Id<"credential">, at: string): Promise<void> {
    assertIsoUtc("at", at);
    await runGuarded("touchCredentialUsed", () =>
      this.db.query("UPDATE external_credential SET last_used_at = $2 WHERE id = $1", [id, at]),
    );
  }

  async hasStrongCredential(agentId: ExternalAgentId, now: string): Promise<boolean> {
    assertIsoUtc("now", now);
    // The kind list comes from STRONG_CREDENTIAL_KINDS rather than being
    // spelled out here. A switch that names two of the three strong kinds
    // leaves the third as a silent downgrade path, and the way to make that
    // impossible is to have exactly one list.
    const rows = await runGuarded("hasStrongCredential", () =>
      this.db.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM external_credential
           WHERE agent_id = $1 AND kind = ANY($2::text[]) AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > $3)
         ) AS present`,
        [agentId, [...STRONG_CREDENTIAL_KINDS], now],
      ),
    );
    return rows[0]?.present ?? false;
  }
}

// ---------------------------------------------------------------------------
// Nonces
// ---------------------------------------------------------------------------

export class PgNonceStore implements NonceStore {
  constructor(
    private readonly db: Db,
    private readonly capPerAgent: number = DEFAULT_NONCE_CAP_PER_AGENT,
  ) {
    assertCap(capPerAgent);
  }

  async claimNonce(
    agentId: ExternalAgentId,
    nonce: string,
    expiresAt: string,
  ): Promise<boolean> {
    assertNonce(nonce);
    assertIsoUtc("expiresAt", expiresAt);

    return runGuarded("claimNonce", () =>
      this.db.transaction(async (tx) => {
        // The claim itself. `DO NOTHING` is right here — unlike in
        // `claimReport` — because nothing needs to be read back from the
        // conflicting row: losing the insert *is* the answer. A concurrent
        // claimant that later rolls back leaves this call having refused a
        // nonce nobody kept, which is a false refusal rather than a permitted
        // replay, and that is the direction to be wrong in.
        const claimed = await tx.query<{ ordinal: string }>(
          `INSERT INTO external_nonce (agent_id, nonce, expires_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (agent_id, nonce) DO NOTHING
           RETURNING ordinal`,
          [agentId, nonce, expiresAt],
        );
        if (claimed.length === 0) return false;

        // Trim this agent's own oldest claims and nobody else's. Expressed as
        // "delete everything older than the newest `cap`" rather than "delete
        // the excess", so two concurrent claimants cannot each evict a batch
        // and between them cut the window shorter than the bound.
        await tx.query(
          `DELETE FROM external_nonce
           WHERE agent_id = $1
             AND ordinal <= (
               SELECT ordinal FROM external_nonce WHERE agent_id = $1
               ORDER BY ordinal DESC OFFSET $2 LIMIT 1
             )`,
          [agentId, this.capPerAgent],
        );
        return true;
      }),
    );
  }

  async purgeExpiredNonces(now: string): Promise<number> {
    assertIsoUtc("now", now);
    // Strictly past expiry: a claim is still held at the instant it expires.
    // Holding a nonce a moment longer refuses a replay; dropping it a moment
    // early permits one.
    const rows = await runGuarded("purgeExpiredNonces", () =>
      this.db.query<{ purged: number }>(
        "DELETE FROM external_nonce WHERE expires_at < $1 RETURNING 1 AS purged",
        [now],
      ),
    );
    return rows.length;
  }

  async countNonces(agentId: ExternalAgentId): Promise<number> {
    const rows = await runGuarded("countNonces", () =>
      this.db.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM external_nonce WHERE agent_id = $1",
        [agentId],
      ),
    );
    return Number(rows[0]?.count ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Used-approval ledger
// ---------------------------------------------------------------------------

export class PgUsedApprovalLedger implements UsedApprovalLedger {
  constructor(private readonly db: Db) {}

  async claimApproval(approvalId: Id<"approval">, at: string): Promise<boolean> {
    assertIsoUtc("at", at);

    // One statement: the floor check and the claim cannot be separated, or a
    // claim could pass a floor that rises before the insert lands.
    const rows = await runGuarded("claimApproval", () =>
      this.db.query<{ approval_id: string }>(
        `INSERT INTO external_used_approval (approval_id, consumed_at)
         SELECT $1::text, $2::text
         WHERE NOT EXISTS (
           SELECT 1 FROM external_approval_floor
           WHERE id = $3 AND floor_approval_id >= ($1::text COLLATE "C")
         )
         ON CONFLICT (approval_id) DO NOTHING
         RETURNING approval_id`,
        [approvalId, at, FLOOR_ROW],
      ),
    );
    return rows.length > 0;
  }

  async isConsumed(approvalId: Id<"approval">): Promise<boolean> {
    // Two questions, one answer: is it in the ledger, or is it at or below the
    // highest id the ledger has ever forgotten. Without the second clause an
    // old approval becomes reusable the moment it ages out — the protection
    // expiring instead of the approval, silently.
    const rows = await runGuarded("isConsumed", () =>
      this.db.query<{ consumed: boolean }>(
        `SELECT (
           EXISTS (SELECT 1 FROM external_used_approval WHERE approval_id = $1)
           OR EXISTS (
             SELECT 1 FROM external_approval_floor
             WHERE id = $2 AND floor_approval_id >= ($1::text COLLATE "C")
           )
         ) AS consumed`,
        [approvalId, FLOOR_ROW],
      ),
    );
    return rows[0]?.consumed ?? false;
  }

  async evictBefore(cutoff: string): Promise<string | null> {
    assertIsoUtc("cutoff", cutoff);

    return runGuarded("evictBefore", () =>
      this.db.transaction(async (tx) => {
        // The delete and the floor-raise are one statement, so no other
        // transaction can observe an interval in which an entry has been
        // dropped but the floor covering it has not yet been written. That
        // interval is exactly when a spent approval would be reusable.
        //
        // GREATEST keeps the floor monotonic: an eviction that drops only low
        // ids must never lower a wall a previous eviction already built.
        await tx.query(
          `WITH evicted AS (
             DELETE FROM external_used_approval WHERE consumed_at < $1 RETURNING approval_id
           ), peak AS (
             SELECT MAX(approval_id) AS approval_id FROM evicted
           )
           INSERT INTO external_approval_floor (id, floor_approval_id, evicted_before)
           SELECT $2::text, peak.approval_id, $1::text FROM peak WHERE peak.approval_id IS NOT NULL
           ON CONFLICT (id) DO UPDATE
             SET floor_approval_id = GREATEST(
                   external_approval_floor.floor_approval_id, EXCLUDED.floor_approval_id
                 ),
                 evicted_before = EXCLUDED.evicted_before`,
          [cutoff, FLOOR_ROW],
        );

        const rows = await tx.query<{ floor_approval_id: string }>(
          "SELECT floor_approval_id FROM external_approval_floor WHERE id = $1",
          [FLOOR_ROW],
        );
        return rows[0]?.floor_approval_id ?? null;
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Parked actions
// ---------------------------------------------------------------------------

export class PgParkedActionStore implements ParkedActionStore {
  constructor(private readonly db: Db) {}

  async createParkedAction(action: ParkedAction): Promise<ParkedAction> {
    assertParkedAction(action);

    const rows = await runGuarded("createParkedAction", () =>
      this.db.query<ParkedRow>(
        `INSERT INTO external_parked_action (${PARKED_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${PARKED_COLUMNS}`,
        [
          action.id,
          action.agentId,
          action.integration,
          action.operation,
          action.mode,
          action.requestDigest,
          JSON.stringify([...action.preview]),
          action.approvalId ?? null,
          action.status,
          action.createdAt,
          action.expiresAt,
          action.committedAt ?? null,
          action.committingAt ?? null,
          action.resultDigest ?? null,
          action.resultSummary ?? null,
          action.voidReason ?? null,
          action.runId ?? null,
          action.correlationId ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new InvalidInputError(
        `Parked action ${action.id} already exists. Reusing the id would let a spent approval be presented against a different request.`,
        "id",
      );
    }
    return toParkedAction(row);
  }

  async getParkedAction(id: Id<"parkedAction">): Promise<ParkedAction | null> {
    const rows = await runGuarded("getParkedAction", () =>
      this.db.query<ParkedRow>(
        `SELECT ${PARKED_COLUMNS} FROM external_parked_action WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toParkedAction(row) : null;
  }

  async listParkedActions(
    filter: {
      readonly agentId?: ExternalAgentId;
      readonly status?: readonly ParkedActionStatus[];
      readonly limit?: number;
    } = {},
  ): Promise<readonly ParkedAction[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.agentId !== undefined) {
      values.push(filter.agentId);
      clauses.push(`agent_id = $${values.length}`);
    }
    if (filter.status && filter.status.length > 0) {
      values.push([...filter.status]);
      clauses.push(`status = ANY($${values.length}::text[])`);
    }
    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page = ` LIMIT $${values.length}`;
    }

    // Oldest first. This is a human work queue, and newest-first with a limit
    // would starve whatever has been waiting longest.
    const rows = await runGuarded("listParkedActions", () =>
      this.db.query<ParkedRow>(
        `SELECT ${PARKED_COLUMNS} FROM external_parked_action
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY created_at ASC, ordinal ASC${page}`,
        values,
      ),
    );
    return rows.map(toParkedAction);
  }

  /**
   * Attach the approval this action waits on.
   *
   * The WHERE clause is the whole control: `pending` and `approval_id IS NULL`.
   * Rebinding a different approval to an already-bound request would let a
   * decision taken about one request be spent on another — the substitution the
   * digest binding exists to prevent — so a second bind returns null and the
   * caller voids rather than proceeding.
   */
  async bindApproval(
    id: Id<"parkedAction">,
    approvalId: Id<"approval">,
    at: string,
  ): Promise<ParkedAction | null> {
    assertIsoUtc("at", at);

    const rows = await runGuarded("bindApproval", () =>
      this.db.query<ParkedRow>(
        `UPDATE external_parked_action
            SET approval_id = $2
          WHERE id = $1 AND status = 'pending' AND approval_id IS NULL
         RETURNING ${PARKED_COLUMNS}`,
        [id, approvalId],
      ),
    );
    const row = rows[0];
    return row ? toParkedAction(row) : null;
  }

  async transitionParkedAction(input: {
    readonly id: Id<"parkedAction">;
    readonly expectedStatus: ParkedActionStatus;
    readonly status: ParkedActionStatus;
    readonly at: string;
    readonly resultDigest?: string;
    readonly resultSummary?: string;
    readonly voidReason?: string;
  }): Promise<ParkedAction | null> {
    assertIsoUtc("at", input.at);
    assertOptionalDigestForm("resultDigest", input.resultDigest);

    // Compare and set. Postgres serialises concurrent updates of one row, so
    // of N callers committing the same parked action exactly one matches
    // `status = expected` and the rest match nothing. That empty result is how
    // a duplicate commit is detected — and it is what stops the second commit
    // overwriting the first one's recorded result.
    //
    // The terminal-status clause is the separate control. Compare-and-set stops
    // a stale writer and permits anything from a writer that reads first, so
    // without it `committed → pending` matches its row and puts a refund that
    // already went out back in front of an approver. `committing` is
    // deliberately absent from `TERMINAL_PARKED_STATUSES` and so from this
    // clause: the commit path leaves `committing` for `committed`, `pending`
    // and `indeterminate`, and excluding it here would break the writer this
    // rule exists to protect.
    const rows = await runGuarded("transitionParkedAction", () =>
      this.db.query<ParkedRow>(
        `UPDATE external_parked_action
         SET status = $3,
             -- Only a commit carries a completion time. Setting it on a
             -- rejection would make the console read as though the action
             -- had landed.
             committed_at = CASE WHEN $3::text = 'committed' THEN $4::text ELSE committed_at END,
             -- Stamped by the store, because the sweeper's question is "how
             -- long has this row been in flight" and the row is the only thing
             -- that knows when it entered that state. Measuring from
             -- created_at instead measures how long ago a human was asked,
             -- which is normally hours earlier and declares every live commit
             -- abandoned on the first sweep.
             committing_at = CASE WHEN $3::text = 'committing' THEN $4::text ELSE committing_at END,
             result_digest = COALESCE($5::text, result_digest),
             result_summary = COALESCE($6::text, result_summary),
             void_reason = COALESCE($7::text, void_reason)
         WHERE id = $1 AND status = $2 AND NOT (status = ANY($8::text[]))
         RETURNING ${PARKED_COLUMNS}`,
        [
          input.id,
          input.expectedStatus,
          input.status,
          input.at,
          input.resultDigest ?? null,
          input.resultSummary ?? null,
          input.voidReason ?? null,
          [...TERMINAL_PARKED_STATUSES],
        ],
      ),
    );
    const row = rows[0];
    return row ? toParkedAction(row) : null;
  }

  async expireParkedActions(now: string): Promise<readonly ParkedAction[]> {
    assertIsoUtc("now", now);

    // Terminal statuses are history and are never touched, and `expired` is
    // excluded so the sweep drains instead of handing the same rows back on
    // every pass. `approved` is swept alongside `pending` because an approver
    // agreed to an action now, not whenever the agent next gets round to it.
    const rows = await runGuarded("expireParkedActions", () =>
      this.db.query<ParkedRow>(
        `UPDATE external_parked_action SET status = 'expired'
         WHERE status = ANY($2::text[]) AND expires_at < $1
         RETURNING ${PARKED_COLUMNS}`,
        [now, [...EXPIRABLE_PARKED_STATUSES]],
      ),
    );
    return rows
      .map(toParkedAction)
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id < right.id
            ? -1
            : 1
          : left.createdAt < right.createdAt
            ? -1
            : 1,
      );
  }
}

// ---------------------------------------------------------------------------
// Live runs and report ingestion
// ---------------------------------------------------------------------------

export class PgExternalRunStore implements ExternalRunStore {
  constructor(private readonly db: Db) {}

  async createExternalRun(run: ExternalRun): Promise<ExternalRun> {
    assertExternalRun(run);

    return runGuarded("createExternalRun", () =>
      this.db.transaction(async (tx) => {
        const inserted = await tx.query<ExternalRunRow>(
          `INSERT INTO external_run (${EXTERNAL_RUN_COLUMNS})
           SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text,
                  $8::text, $9::text, $10::numeric, $11::text
           WHERE NOT EXISTS (SELECT 1 FROM external_run WHERE run_id = $3)
           ON CONFLICT (id) DO NOTHING
           RETURNING ${EXTERNAL_RUN_COLUMNS}`,
          [
            run.id,
            run.agentId,
            run.runId,
            run.goal,
            run.status,
            run.startedAt,
            run.lastHeartbeatAt,
            run.endedAt ?? null,
            run.outcome ?? null,
            run.costUsd,
            run.correlationId ?? null,
          ],
        );
        const row = inserted[0];
        if (row) return toExternalRun(row);

        const clash = await tx.query<{ id: string }>("SELECT id FROM external_run WHERE id = $1", [
          run.id,
        ]);
        if (clash.length > 0) {
          throw new InvalidInputError(`External run ${run.id} already exists.`, "id");
        }
        throw new InvalidInputError(
          `Run ${run.runId} already accounts for an episode of external work. One operating-record run holds one episode, so cost and step queries cannot silently aggregate two.`,
          "runId",
        );
      }),
    );
  }

  async getExternalRun(id: Id<"externalRun">): Promise<ExternalRun | null> {
    const rows = await runGuarded("getExternalRun", () =>
      this.db.query<ExternalRunRow>(
        `SELECT ${EXTERNAL_RUN_COLUMNS} FROM external_run WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toExternalRun(row) : null;
  }

  async listExternalRuns(
    filter: {
      readonly agentId?: ExternalAgentId;
      readonly status?: readonly ExternalRunStatus[];
      readonly limit?: number;
    } = {},
  ): Promise<readonly ExternalRun[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.agentId !== undefined) {
      values.push(filter.agentId);
      clauses.push(`agent_id = $${values.length}`);
    }
    if (filter.status && filter.status.length > 0) {
      values.push([...filter.status]);
      clauses.push(`status = ANY($${values.length}::text[])`);
    }
    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page = ` LIMIT $${values.length}`;
    }

    // Newest first: this is a live view of what is running right now.
    const rows = await runGuarded("listExternalRuns", () =>
      this.db.query<ExternalRunRow>(
        `SELECT ${EXTERNAL_RUN_COLUMNS} FROM external_run
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY started_at DESC, ordinal DESC${page}`,
        values,
      ),
    );
    return rows.map(toExternalRun);
  }

  async heartbeat(id: Id<"externalRun">, at: string): Promise<ExternalRun | null> {
    assertIsoUtc("at", at);

    // Conditional on still running. A heartbeat must not resurrect a run that
    // containment stopped or that the sweep reclaimed: the null is what makes
    // the caller answer "stop", which is the only kill switch there is for an
    // agent executing somewhere we cannot reach.
    const rows = await runGuarded("heartbeat", () =>
      this.db.query<ExternalRunRow>(
        `UPDATE external_run SET last_heartbeat_at = $2
         WHERE id = $1 AND status = 'running'
         RETURNING ${EXTERNAL_RUN_COLUMNS}`,
        [id, at],
      ),
    );
    const row = rows[0];
    return row ? toExternalRun(row) : null;
  }

  async finishExternalRun(input: {
    readonly id: Id<"externalRun">;
    readonly status: ExternalRunStatus;
    readonly at: string;
    readonly outcome?: string;
    readonly costUsd?: number;
  }): Promise<ExternalRun | null> {
    assertIsoUtc("at", input.at);
    if (input.costUsd !== undefined) assertSpendAmount(input.costUsd);

    // A run ends once. How it ended is the answer to "what did this agent do",
    // and a second writer moving it to another outcome would rewrite that
    // rather than report it.
    const rows = await runGuarded("finishExternalRun", () =>
      this.db.query<ExternalRunRow>(
        `UPDATE external_run
         SET status = $2, ended_at = $3,
             outcome = COALESCE($4::text, outcome),
             cost_usd = COALESCE($5::numeric, cost_usd)
         WHERE id = $1 AND status = 'running'
         RETURNING ${EXTERNAL_RUN_COLUMNS}`,
        [input.id, input.status, input.at, input.outcome ?? null, input.costUsd ?? null],
      ),
    );
    const row = rows[0];
    return row ? toExternalRun(row) : null;
  }

  async findStaleRuns(cutoff: string, limit: number): Promise<readonly ExternalRun[]> {
    assertIsoUtc("cutoff", cutoff);
    // Oldest silence first, so a bounded sweep reclaims the runs that have
    // been gone longest rather than an arbitrary slice of them.
    const rows = await runGuarded("findStaleRuns", () =>
      this.db.query<ExternalRunRow>(
        `SELECT ${EXTERNAL_RUN_COLUMNS} FROM external_run
         WHERE status = 'running' AND last_heartbeat_at < $1
         ORDER BY last_heartbeat_at ASC, ordinal ASC LIMIT $2`,
        [cutoff, limit],
      ),
    );
    return rows.map(toExternalRun);
  }

  async claimReport(
    agentId: ExternalAgentId,
    idempotencyKey: string,
    runId: Id<"run">,
    at: string,
  ): Promise<{ readonly claimed: boolean; readonly existingRunId: Id<"run"> }> {
    assertIdempotencyKey(idempotencyKey);
    assertIsoUtc("at", at);

    // `DO UPDATE`, deliberately, where `DO NOTHING` would be the obvious
    // choice. `DO NOTHING` does not wait for a conflicting transaction: a
    // concurrent claim can leave this statement with no row inserted *and*
    // nothing to read back, so a follow-up SELECT would find nothing and the
    // caller would conclude the key was free. `DO UPDATE` takes the lock,
    // waits, and returns the row that actually committed.
    //
    // The self-assignment is a deliberate no-op: the first claim owns the run
    // id and a retry must not overwrite it, or the second copy of a report
    // would be recorded against a run the first one never used.
    //
    // `xmax = 0` on the returned row distinguishes the insert from the update,
    // which is what tells the caller whether it is ingesting or replaying.
    const rows = await runGuarded("claimReport", () =>
      this.db.query<{ run_id: string; inserted: boolean }>(
        `INSERT INTO external_report_claim (agent_id, idempotency_key, run_id, claimed_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (agent_id, idempotency_key)
           DO UPDATE SET run_id = external_report_claim.run_id
         RETURNING run_id, (xmax = 0) AS inserted`,
        [agentId, idempotencyKey, runId, at],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new DeniedError(
        "record.unavailable",
        `The report claim for ${agentId} could not be recorded, so the report is refused rather than ingested without a deduplication key.`,
        { agentId },
      );
    }
    return { claimed: row.inserted, existingRunId: row.run_id };
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export class PgRateLimitStore implements RateLimitStore {
  constructor(private readonly db: Db) {}

  async recordRequest(
    agentId: ExternalAgentId,
    operation: string,
    at: string,
    windowMs: number,
  ): Promise<number> {
    assertIsoUtc("at", at);
    assertWindow(windowMs);
    const from = windowStart(at, windowMs);

    return runGuarded("recordRequest", () =>
      this.db.transaction(async (tx) => {
        // Serialise recorders for this agent and operation. Without it two
        // concurrent requests each count a window that does not yet contain
        // the other's uncommitted row, and both come back as "1 of 60" — an
        // agent can then exceed its limit by being fast rather than by being
        // allowed to. The two-integer lock space is distinct from the
        // single-bigint one the migration runner uses, so this cannot collide
        // with a deploy in progress.
        await tx.query("SELECT pg_advisory_xact_lock($1::integer, hashtext($2))", [
          RATE_LIMIT_LOCK_CLASS,
          `request:${agentId}:${operation}`,
        ]);

        // Prune this key's fallen-out rows, so the table stays bounded by the
        // window rather than by uptime. Other agents' rows are untouched: one
        // busy agent must not shorten anyone else's window.
        await tx.query(
          "DELETE FROM external_rate_request WHERE agent_id = $1 AND operation = $2 AND at <= $3",
          [agentId, operation, from],
        );
        await tx.query(
          "INSERT INTO external_rate_request (agent_id, operation, at) VALUES ($1, $2, $3)",
          [agentId, operation, at],
        );

        const rows = await tx.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM external_rate_request
           WHERE agent_id = $1 AND operation = $2 AND at > $3`,
          [agentId, operation, from],
        );
        return Number(rows[0]?.count ?? 0);
      }),
    );
  }

  async recordDenial(
    agentId: ExternalAgentId,
    at: string,
    windowMs: number,
    denialClass: DenialClass,
  ): Promise<number> {
    assertIsoUtc("at", at);
    assertWindow(windowMs);
    assertDenialClass(denialClass);
    const from = windowStart(at, windowMs);

    return runGuarded("recordDenial", () =>
      this.db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock($1::integer, hashtext($2))", [
          RATE_LIMIT_LOCK_CLASS,
          `denial:${agentId}`,
        ]);

        await tx.query("DELETE FROM external_rate_denial WHERE agent_id = $1 AND at <= $2", [
          agentId,
          from,
        ]);
        // Infrastructure denials are stored and not counted. Containing an
        // agent because our own store was briefly unreachable punishes a
        // well-behaved team for our outage and teaches them the platform is
        // unreliable rather than strict.
        await tx.query(
          "INSERT INTO external_rate_denial (agent_id, denial_class, at) VALUES ($1, $2, $3)",
          [agentId, denialClass, at],
        );

        const rows = await tx.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM external_rate_denial
           WHERE agent_id = $1 AND denial_class = 'misbehaviour' AND at > $2`,
          [agentId, from],
        );
        return Number(rows[0]?.count ?? 0);
      }),
    );
  }

  async clearDenials(agentId: ExternalAgentId): Promise<void> {
    await runGuarded("clearDenials", () =>
      this.db.query("DELETE FROM external_rate_denial WHERE agent_id = $1", [agentId]),
    );
  }
}

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

function toAgent(row: AgentRow): EnrolledAgent {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    department: row.department,
    hostPlatform: row.host_platform,
    purpose: row.purpose,
    allowedTools: row.allowed_tools,
    riskCeiling: row.risk_ceiling as EnrolledAgent["riskCeiling"],
    // numeric and bigint both arrive as strings so that a driver cannot round
    // them on the way out. The conversion happens once, here.
    spendCeilingUsd: Number(row.spend_ceiling_usd),
    budgetPeriod: row.budget_period as BudgetPeriod,
    wallClockCeilingMs: Number(row.wall_clock_ceiling_ms),
    dataScopes: row.data_scopes,
    expiresAt: row.expires_at,
    status: row.status as AgentStatus,
    // NULL becomes undefined rather than null: `{a: null}` and `{}` are
    // different values to the canonical serialiser, and several of these
    // fields end up inside something that gets hashed.
    statusReason: row.status_reason ?? undefined,
    statusChangedAt: row.status_changed_at ?? undefined,
    statusChangedBy: row.status_changed_by ?? undefined,
    enrolledBy: row.enrolled_by,
    enrolledAt: row.enrolled_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at ?? undefined,
  };
}

function toMeter(row: MeterRow): SpendMeter {
  return {
    agentId: row.agent_id,
    periodKey: row.period_key,
    spentUsd: Number(row.spent_usd),
    updatedAt: row.updated_at,
  };
}

function toCredential(row: CredentialRow): AgentCredential {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind as CredentialKind,
    label: row.label,
    tokenHash: row.token_hash ?? undefined,
    issuer: row.issuer ?? undefined,
    audience: row.audience ?? undefined,
    jwksPath: row.jwks_path ?? undefined,
    secretRef: row.secret_ref ?? undefined,
    publicKey: row.public_key ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    revokedBy: row.revoked_by ?? undefined,
    revokedReason: row.revoked_reason ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

function toParkedAction(row: ParkedRow): ParkedAction {
  return {
    id: row.id,
    agentId: row.agent_id,
    integration: row.integration,
    operation: row.operation,
    mode: row.mode === "read" ? "read" : "write",
    requestDigest: row.request_digest as Digest,
    preview: row.preview,
    approvalId: row.approval_id ?? undefined,
    status: row.status as ParkedActionStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    committedAt: row.committed_at ?? undefined,
    committingAt: row.committing_at ?? undefined,
    resultDigest: (row.result_digest ?? undefined) as Digest | undefined,
    resultSummary: row.result_summary ?? undefined,
    voidReason: row.void_reason ?? undefined,
    runId: row.run_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
  };
}

function toExternalRun(row: ExternalRunRow): ExternalRun {
  return {
    id: row.id,
    agentId: row.agent_id,
    runId: row.run_id,
    goal: row.goal,
    status: row.status as ExternalRunStatus,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    endedAt: row.ended_at ?? undefined,
    outcome: row.outcome ?? undefined,
    costUsd: Number(row.cost_usd),
    correlationId: row.correlation_id ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a database failure so it refuses the caller's action.
 *
 * `DeniedError` and `InvalidInputError` pass through untouched: a refusal this
 * adapter raised deliberately must not be reported as an infrastructure
 * problem, because the two are answered very differently — one by fixing the
 * request, the other by paging.
 */
async function runGuarded<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DeniedError || error instanceof InvalidInputError) throw error;
    throw storeUnavailable(operation, error);
  }
}

/** The start of a sliding window, exclusive. Never a wall-clock reading. */
function windowStart(at: string, windowMs: number): string {
  return new Date(Date.parse(at) - windowMs).toISOString();
}

function unknownAgent(id: string): DeniedError {
  return new DeniedError(
    "record.unavailable",
    `External agent ${id} is not enrolled. An unenrolled caller is refused: there is no anonymous access to this plane and no default-allow.`,
    { agentId: id },
  );
}

function assertCap(cap: number): void {
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0) {
    throw new InvalidInputError(
      `A cap must be a non-negative integer, received: ${String(cap)}`,
      "cap",
    );
  }
}

function assertWindow(windowMs: number): void {
  if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new InvalidInputError(
      `A rate-limit window must be a positive number of milliseconds, received: ${String(windowMs)}. A window of zero counts nothing, which reads to the caller as an agent making no requests at all.`,
      "windowMs",
    );
  }
}

function assertNonce(nonce: string): void {
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new InvalidInputError(
      "A nonce must be a non-empty string. A blank nonce collides with every other blank one, so the first blank claim would lock out every later request from that agent.",
      "nonce",
    );
  }
}

function assertIdempotencyKey(key: string): void {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new InvalidInputError(
      "A report needs a non-empty idempotency key. A blank key matches every other blank key, so the second unrelated report would be discarded as a duplicate of the first and the work would vanish from the record.",
      "idempotencyKey",
    );
  }
}

function assertDenialClass(denialClass: DenialClass): void {
  if (denialClass !== "misbehaviour" && denialClass !== "infrastructure") {
    throw new InvalidInputError(
      `Unknown denial class: ${String(denialClass)}. A denial that cannot be classified must not be counted toward containment by default.`,
      "denialClass",
    );
  }
}

function assertRiskCeiling(tier: EnrolledAgent["riskCeiling"]): void {
  if (tier === "prohibited") {
    throw new InvalidInputError(
      'An external agent cannot be enrolled with a risk ceiling of "prohibited". That tier means never permitted by this platform whatever the configuration says, so an agent holding it as a ceiling would be admitted to do exactly what the tier forbids.',
      "riskCeiling",
    );
  }
  if (!["routine", "sensitive", "high_consequence"].includes(tier)) {
    throw new InvalidInputError(`Unknown risk tier: ${String(tier)}`, "riskCeiling");
  }
}

function assertBudgetPeriod(period: BudgetPeriod): void {
  if (!BUDGET_PERIODS.includes(period)) {
    throw new InvalidInputError(`Unknown budget period: ${String(period)}`, "budgetPeriod");
  }
}

function assertAgent(agent: EnrolledAgent): void {
  assertIsoUtc("enrolledAt", agent.enrolledAt);
  assertIsoUtc("updatedAt", agent.updatedAt);
  assertIsoUtc("expiresAt", agent.expiresAt);
  assertOptionalIsoUtc("statusChangedAt", agent.statusChangedAt);
  assertOptionalIsoUtc("lastSeenAt", agent.lastSeenAt);
  assertRiskCeiling(agent.riskCeiling);
  assertBudgetPeriod(agent.budgetPeriod);
  assertSpendAmount(agent.spendCeilingUsd);

  if (agent.name.trim().length === 0) {
    throw new InvalidInputError("An external agent needs a name.", "name");
  }
  if (agent.owner.trim().length === 0) {
    throw new InvalidInputError(
      "An external agent needs a named owner. Accountability is the point of enrolment, and a blank owner is an agent nobody answers for.",
      "owner",
    );
  }
  if (!Number.isFinite(agent.wallClockCeilingMs) || agent.wallClockCeilingMs <= 0) {
    throw new InvalidInputError(
      `A wall-clock ceiling must be a positive number of milliseconds, received: ${String(agent.wallClockCeilingMs)}`,
      "wallClockCeilingMs",
    );
  }
}

function assertCredential(credential: AgentCredential): void {
  assertIsoUtc("createdAt", credential.createdAt);
  assertOptionalIsoUtc("expiresAt", credential.expiresAt);
  assertOptionalIsoUtc("revokedAt", credential.revokedAt);
  assertOptionalIsoUtc("lastUsedAt", credential.lastUsedAt);

  if (credential.label.trim().length === 0) {
    throw new InvalidInputError("A credential needs an operator label.", "label");
  }

  // Widened before the switch so the unreachable default can still name what
  // it was handed. A caller reaching this store from untyped JSON is exactly
  // who that branch is for.
  const kind: string = credential.kind;

  // The same per-kind shape the CHECK constraint enforces, stated here so the
  // refusal arrives as readable input validation rather than as a constraint
  // violation — and so the in-memory adapter can refuse identically.
  switch (credential.kind) {
    case "bearer":
      if (credential.tokenHash === undefined) {
        throw new InvalidInputError("A bearer credential stores a token hash.", "tokenHash");
      }
      assertTokenHash(credential.tokenHash);
      refuseExtras(credential, ["secretRef", "publicKey", "jwksPath", "issuer", "audience"]);
      break;
    case "jwt":
      if (
        credential.issuer === undefined ||
        credential.audience === undefined ||
        credential.jwksPath === undefined
      ) {
        throw new InvalidInputError(
          "A JWT credential needs an expected issuer, an audience, and a local JWKS path. Without all three the token is checked against nothing in particular.",
          "issuer",
        );
      }
      refuseExtras(credential, ["tokenHash", "secretRef", "publicKey"]);
      break;
    case "hmac":
      if (credential.secretRef === undefined) {
        throw new InvalidInputError(
          "An HMAC credential stores the name to resolve from the secret manager.",
          "secretRef",
        );
      }
      assertSecretRef(credential.secretRef);
      refuseExtras(credential, ["tokenHash", "publicKey", "jwksPath"]);
      break;
    case "envelope":
      if (credential.publicKey === undefined) {
        throw new InvalidInputError(
          "An envelope credential pins the public key it verifies against.",
          "publicKey",
        );
      }
      refuseExtras(credential, ["tokenHash", "secretRef", "jwksPath"]);
      break;
    default:
      throw new InvalidInputError(`Unknown credential kind: ${kind}`, "kind");
  }
}

function refuseExtras(
  credential: AgentCredential,
  fields: readonly (keyof AgentCredential)[],
): void {
  for (const field of fields) {
    if (credential[field] !== undefined) {
      throw new InvalidInputError(
        `A ${credential.kind} credential must not carry ${String(field)}. Material belonging to another kind is a verification path nobody reviewed.`,
        String(field),
      );
    }
  }
}

function assertParkedAction(action: ParkedAction): void {
  assertIsoUtc("createdAt", action.createdAt);
  assertIsoUtc("expiresAt", action.expiresAt);
  assertOptionalIsoUtc("committedAt", action.committedAt);
  assertDigestForm("requestDigest", action.requestDigest);
  assertOptionalDigestForm("resultDigest", action.resultDigest);
}

function assertExternalRun(run: ExternalRun): void {
  assertIsoUtc("startedAt", run.startedAt);
  assertIsoUtc("lastHeartbeatAt", run.lastHeartbeatAt);
  assertOptionalIsoUtc("endedAt", run.endedAt);
  assertSpendAmount(run.costUsd);
}
