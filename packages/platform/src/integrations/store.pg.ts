import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import { storeUnavailable, type Db } from "../store/db.js";
import type { CredentialRevocationStore, IntegrationQueueStore } from "./port.js";
import type { CredentialRevocation, ParkedItem, QueuedCall } from "./types.js";

/**
 * Postgres degradation queue and revocation list.
 *
 * `claimDue` is the operation that has to be right under concurrency, and it
 * is written as a single statement: a CTE selects due rows `FOR UPDATE SKIP
 * LOCKED` and the outer `UPDATE` claims exactly those. Two schedulers running
 * against one database therefore take disjoint sets rather than both taking
 * the same row — which, for a queue of external effects, is the difference
 * between one letter and two.
 *
 * `SKIP LOCKED` rather than plain `FOR UPDATE`: a second scheduler should take
 * different work, not wait for the first to finish. Waiting would serialise
 * the whole queue behind whichever call is slowest.
 */

type QueuedCallRow = {
  idempotency_key: string;
  integration: string;
  operation: string;
  subject: Record<string, string>;
  run_id: string | null;
  status: string;
  attempts: number;
  first_failed_at: string;
  last_attempt_at: string;
  next_attempt_at: string;
  last_error: string;
  claimed_at: string | null;
  completed_at: string | null;
};

type ParkedItemRow = {
  reference: string;
  integration: string;
  operation: string;
  subject: Record<string, string>;
  run_id: string | null;
  summary: string;
  reason: string;
  parked_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
};

type RevocationRow = {
  reference: string;
  revoked_at: string;
  revoked_by: string;
  reason: string;
};

/**
 * Declared as a list rather than as a string.
 *
 * `claimDue` needs the same columns qualified with the update's alias, and
 * deriving that by splitting a multi-line string is how a query ends up
 * referencing a column that does not exist — a mistake the type checker cannot
 * see and only a live database would report.
 */
const QUEUE_COLUMN_NAMES = [
  "idempotency_key",
  "integration",
  "operation",
  "subject",
  "run_id",
  "status",
  "attempts",
  "first_failed_at",
  "last_attempt_at",
  "next_attempt_at",
  "last_error",
  "claimed_at",
  "completed_at",
] as const;

const QUEUE_COLUMNS = QUEUE_COLUMN_NAMES.join(", ");
const QUEUE_COLUMNS_QUALIFIED = QUEUE_COLUMN_NAMES.map((column) => `q.${column}`).join(", ");

const PARKED_COLUMNS = `reference, integration, operation, subject, run_id, summary, reason,
  parked_at, resolved_at, resolved_by, resolution`;

const REVOCATION_COLUMNS = `reference, revoked_at, revoked_by, reason`;

export class PgIntegrationQueueStore implements IntegrationQueueStore {
  constructor(private readonly db: Db) {}

  async enqueue(item: QueuedCall): Promise<QueuedCall> {
    assertQueuedCall(item);
    const rows = await this.guard("enqueue", () =>
      this.db.query<QueuedCallRow>(
        `INSERT INTO integration_queued_call (${QUEUE_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (idempotency_key) DO UPDATE
           SET status = EXCLUDED.status,
               attempts = EXCLUDED.attempts,
               last_attempt_at = EXCLUDED.last_attempt_at,
               next_attempt_at = EXCLUDED.next_attempt_at,
               last_error = EXCLUDED.last_error,
               claimed_at = NULL
         RETURNING ${QUEUE_COLUMNS}`,
        [
          item.idempotencyKey,
          item.integration,
          item.operation,
          item.subject,
          item.runId ?? null,
          item.status,
          item.attempts,
          item.firstFailedAt,
          item.lastAttemptAt,
          item.nextAttemptAt,
          item.lastError,
          item.claimedAt ?? null,
          item.completedAt ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new DeniedError(
        "record.unavailable",
        `The failed call to ${item.integration} could not be queued, so it must not be reported as queued.`,
        { integration: item.integration },
      );
    }
    return toQueuedCall(row);
  }

  async getQueued(idempotencyKey: string): Promise<QueuedCall | null> {
    const rows = await this.guard("getQueued", () =>
      this.db.query<QueuedCallRow>(
        `SELECT ${QUEUE_COLUMNS} FROM integration_queued_call WHERE idempotency_key = $1`,
        [idempotencyKey],
      ),
    );
    const row = rows[0];
    return row ? toQueuedCall(row) : null;
  }

  async claimDue(now: string, limit: number): Promise<readonly QueuedCall[]> {
    assertIsoUtc("now", now);
    const rows = await this.guard("claimDue", () =>
      this.db.query<QueuedCallRow>(
        // One statement. The CTE picks due rows and locks them, skipping any
        // another scheduler already holds; the UPDATE claims exactly those.
        `WITH due AS (
           SELECT idempotency_key
           FROM integration_queued_call
           WHERE status = 'queued' AND next_attempt_at <= $1
           ORDER BY next_attempt_at ASC, idempotency_key ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE integration_queued_call AS q
         SET status = 'claimed', claimed_at = $1
         FROM due
         WHERE q.idempotency_key = due.idempotency_key
         RETURNING ${QUEUE_COLUMNS_QUALIFIED}`,
        [now, Math.max(0, limit)],
      ),
    );
    return rows
      .map(toQueuedCall)
      .sort((left, right) =>
        left.nextAttemptAt === right.nextAttemptAt
          ? left.idempotencyKey < right.idempotencyKey
            ? -1
            : 1
          : left.nextAttemptAt < right.nextAttemptAt
            ? -1
            : 1,
      );
  }

  async completeQueued(idempotencyKey: string, at: string): Promise<QueuedCall | null> {
    assertIsoUtc("at", at);
    const rows = await this.guard("completeQueued", () =>
      this.db.query<QueuedCallRow>(
        `UPDATE integration_queued_call
         SET status = 'completed', completed_at = $2
         WHERE idempotency_key = $1 AND status <> 'completed'
         RETURNING ${QUEUE_COLUMNS}`,
        [idempotencyKey, at],
      ),
    );
    const row = rows[0];
    return row ? toQueuedCall(row) : null;
  }

  async releaseQueued(
    idempotencyKey: string,
    at: string,
    error: string,
    nextAttemptAt: string | null,
  ): Promise<QueuedCall | null> {
    assertIsoUtc("at", at);
    assertOptionalIsoUtc("nextAttemptAt", nextAttemptAt);
    const rows = await this.guard("releaseQueued", () =>
      this.db.query<QueuedCallRow>(
        `UPDATE integration_queued_call
         SET status = CASE WHEN $4::text IS NULL THEN 'abandoned' ELSE 'queued' END,
             last_attempt_at = $2,
             next_attempt_at = COALESCE($4::text, next_attempt_at),
             last_error = $3,
             claimed_at = NULL
         WHERE idempotency_key = $1
         RETURNING ${QUEUE_COLUMNS}`,
        [idempotencyKey, at, error, nextAttemptAt],
      ),
    );
    const row = rows[0];
    return row ? toQueuedCall(row) : null;
  }

  async listQueued(
    filter: {
      readonly integration?: string;
      readonly status?: readonly QueuedCall["status"][];
      readonly limit?: number;
    } = {},
  ): Promise<readonly QueuedCall[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.integration !== undefined) {
      values.push(filter.integration);
      clauses.push(`integration = $${values.length}`);
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
    const rows = await this.guard("listQueued", () =>
      this.db.query<QueuedCallRow>(
        `SELECT ${QUEUE_COLUMNS} FROM integration_queued_call
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY first_failed_at ASC, idempotency_key ASC${page}`,
        values,
      ),
    );
    return rows.map(toQueuedCall);
  }

  async park(item: ParkedItem): Promise<ParkedItem> {
    assertIsoUtc("parkedAt", item.parkedAt);
    assertOptionalIsoUtc("resolvedAt", item.resolvedAt);
    if (item.reference.length === 0) {
      throw new InvalidInputError("A parked item needs a reference.", "reference");
    }
    const rows = await this.guard("park", () =>
      this.db.query<ParkedItemRow>(
        // Parking the same work again refreshes the reason and keeps the
        // original parked time, so the age of the oldest open item stays true.
        `INSERT INTO integration_parked_item (${PARKED_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (reference) DO UPDATE
           SET summary = EXCLUDED.summary,
               reason = EXCLUDED.reason
         RETURNING ${PARKED_COLUMNS}`,
        [
          item.reference,
          item.integration,
          item.operation,
          item.subject,
          item.runId ?? null,
          item.summary,
          item.reason,
          item.parkedAt,
          item.resolvedAt ?? null,
          item.resolvedBy ?? null,
          item.resolution ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new DeniedError(
        "record.unavailable",
        `Work for ${item.integration} could not be parked, so it must not be reported as parked.`,
        { integration: item.integration },
      );
    }
    return toParkedItem(row);
  }

  async getParked(reference: string): Promise<ParkedItem | null> {
    const rows = await this.guard("getParked", () =>
      this.db.query<ParkedItemRow>(
        `SELECT ${PARKED_COLUMNS} FROM integration_parked_item WHERE reference = $1`,
        [reference],
      ),
    );
    const row = rows[0];
    return row ? toParkedItem(row) : null;
  }

  async listParked(
    filter: {
      readonly integration?: string;
      readonly includeResolved?: boolean;
      readonly limit?: number;
    } = {},
  ): Promise<readonly ParkedItem[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.integration !== undefined) {
      values.push(filter.integration);
      clauses.push(`integration = $${values.length}`);
    }
    if (filter.includeResolved !== true) clauses.push("resolved_at IS NULL");
    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page = ` LIMIT $${values.length}`;
    }
    const rows = await this.guard("listParked", () =>
      this.db.query<ParkedItemRow>(
        `SELECT ${PARKED_COLUMNS} FROM integration_parked_item
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY parked_at ASC, reference ASC${page}`,
        values,
      ),
    );
    return rows.map(toParkedItem);
  }

  async resolveParked(
    reference: string,
    at: string,
    by: string,
    resolution: string,
  ): Promise<ParkedItem | null> {
    assertIsoUtc("at", at);
    const rows = await this.guard("resolveParked", () =>
      this.db.query<ParkedItemRow>(
        // Compare and set. Two people working one queue must not both believe
        // they closed the same item.
        `UPDATE integration_parked_item
         SET resolved_at = $2, resolved_by = $3, resolution = $4
         WHERE reference = $1 AND resolved_at IS NULL
         RETURNING ${PARKED_COLUMNS}`,
        [reference, at, by, resolution],
      ),
    );
    const row = rows[0];
    return row ? toParkedItem(row) : null;
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DeniedError || error instanceof InvalidInputError) throw error;
      throw storeUnavailable(operation, error);
    }
  }
}

export class PgCredentialRevocationStore implements CredentialRevocationStore {
  constructor(private readonly db: Db) {}

  async revoke(revocation: CredentialRevocation): Promise<CredentialRevocation> {
    assertIsoUtc("revokedAt", revocation.revokedAt);
    const rows = await this.guard("revoke", () =>
      this.db.query<RevocationRow>(
        // First revocation wins. A later call must not move the time a
        // credential stopped being valid: that timestamp is evidence.
        `INSERT INTO integration_credential_revocation (${REVOCATION_COLUMNS})
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (reference) DO NOTHING
         RETURNING ${REVOCATION_COLUMNS}`,
        [revocation.reference, revocation.revokedAt, revocation.revokedBy, revocation.reason],
      ),
    );
    const row = rows[0];
    if (row) return toRevocation(row);

    const existing = await this.guard("revoke", () =>
      this.db.query<RevocationRow>(
        `SELECT ${REVOCATION_COLUMNS} FROM integration_credential_revocation WHERE reference = $1`,
        [revocation.reference],
      ),
    );
    const found = existing[0];
    if (!found) {
      throw new DeniedError(
        "record.unavailable",
        `The revocation of "${revocation.reference}" could not be recorded, so it must not be reported as revoked.`,
        { reference: revocation.reference },
      );
    }
    return toRevocation(found);
  }

  async isRevoked(reference: string): Promise<boolean> {
    const rows = await this.guard("isRevoked", () =>
      this.db.query<{ reference: string }>(
        `SELECT reference FROM integration_credential_revocation WHERE reference = $1`,
        [reference],
      ),
    );
    return rows.length > 0;
  }

  async listRevocations(): Promise<readonly CredentialRevocation[]> {
    const rows = await this.guard("listRevocations", () =>
      this.db.query<RevocationRow>(
        `SELECT ${REVOCATION_COLUMNS} FROM integration_credential_revocation ORDER BY reference ASC`,
      ),
    );
    return rows.map(toRevocation);
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DeniedError || error instanceof InvalidInputError) throw error;
      throw storeUnavailable(operation, error);
    }
  }
}

function assertQueuedCall(item: QueuedCall): void {
  if (item.idempotencyKey.length === 0) {
    throw new InvalidInputError(
      "A queued call needs an idempotency key. A blank key matches every other blank one, and the scheduler reads a match as 'this is the same call'.",
      "idempotencyKey",
    );
  }
  if (!Number.isInteger(item.attempts) || item.attempts < 1) {
    throw new InvalidInputError("A queued call has been attempted at least once.", "attempts");
  }
  assertIsoUtc("firstFailedAt", item.firstFailedAt);
  assertIsoUtc("lastAttemptAt", item.lastAttemptAt);
  assertIsoUtc("nextAttemptAt", item.nextAttemptAt);
  assertOptionalIsoUtc("claimedAt", item.claimedAt);
  assertOptionalIsoUtc("completedAt", item.completedAt);
}

function toQueuedCall(row: QueuedCallRow): QueuedCall {
  return {
    idempotencyKey: row.idempotency_key,
    integration: row.integration,
    operation: row.operation,
    subject: row.subject,
    runId: (row.run_id ?? undefined) as Id<"run"> | undefined,
    status: row.status as QueuedCall["status"],
    attempts: row.attempts,
    firstFailedAt: row.first_failed_at,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    claimedAt: row.claimed_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

function toParkedItem(row: ParkedItemRow): ParkedItem {
  return {
    reference: row.reference,
    integration: row.integration,
    operation: row.operation,
    subject: row.subject,
    runId: (row.run_id ?? undefined) as Id<"run"> | undefined,
    summary: row.summary,
    reason: row.reason,
    parkedAt: row.parked_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    resolution: row.resolution ?? undefined,
  };
}

function toRevocation(row: RevocationRow): CredentialRevocation {
  return {
    reference: row.reference,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    reason: row.reason,
  };
}
