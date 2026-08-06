import { DeniedError, InvariantError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef } from "../record/types.js";
import { storeUnavailable, type Db } from "../store/db.js";
import { GENESIS_PREVIOUS_HASH } from "./chain.js";
import type { AuditStore, ChainPosition } from "./port.js";
// Shared with the in-memory adapter so both apply exactly the same integrity
// checks. They live there because they are storage-agnostic and that is the
// simpler of the two files; duplicating them would be an invitation to drift.
import { assertAppendable, assertRoundTrip } from "./store.memory.js";
import type { AuditEntry, AuditEventType, AuditFilter, NewAuditEntry } from "./types.js";

/**
 * Postgres audit chain.
 *
 * `appendEntry` is the whole point of this file. It runs inside a transaction
 * that first takes `pg_advisory_xact_lock`, so every appender across every
 * process in the deployment queues behind the lock rather than racing to read
 * the same head. Two writers that both read head `seq = 41` would both build
 * entry 42 linked to the same predecessor; one INSERT would fail on the unique
 * index over `previous_hash` — which is the safety net — but with the lock in
 * place neither has to.
 *
 * The lock is transaction-scoped rather than session-scoped deliberately: a
 * process that dies mid-append releases it at rollback. A session lock leaked
 * by a crashed writer would stop the platform recording anything, and since
 * nothing may proceed unrecorded, that is an outage.
 *
 * There is no update and no delete on this class, and the table refuses both
 * anyway (see `migrations.ts`).
 */

/**
 * Advisory lock key for audit appends.
 *
 * Fixed, arbitrary, and distinct from the migration lock. Anything that takes
 * this lock serialises with every other appender in the deployment.
 */
const AUDIT_APPEND_LOCK_KEY = 4_881_207_301;

type AuditRow = {
  seq: string;
  id: string;
  event_type: string;
  recorded_at: string;
  actor: ActorRef;
  run_id: string | null;
  correlation_id: string | null;
  subject: Record<string, string>;
  input_digests: Record<string, Digest>;
  decision: Record<string, string | number | boolean>;
  previous_hash: string;
  entry_hash: string;
};

const AUDIT_COLUMNS = `seq, id, event_type, recorded_at, actor, run_id, correlation_id,
  subject, input_digests, decision, previous_hash, entry_hash`;

export class PgAuditStore implements AuditStore {
  constructor(private readonly db: Db) {}

  async appendEntry(
    content: NewAuditEntry,
    build: (content: NewAuditEntry, position: ChainPosition) => AuditEntry,
  ): Promise<AuditEntry> {
    return this.guard("appendEntry", () =>
      this.db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [AUDIT_APPEND_LOCK_KEY]);

        const head = (
          await tx.query<{ seq: string; entry_hash: string }>(
            "SELECT seq, entry_hash FROM audit_entry ORDER BY seq DESC LIMIT 1",
          )
        )[0];
        const position: ChainPosition = head
          ? { seq: Number(head.seq) + 1, previousHash: head.entry_hash }
          : { seq: 1, previousHash: GENESIS_PREVIOUS_HASH };

        const entry = build(content, position);
        assertAppendable(entry, position);

        const inserted = (
          await tx.query<AuditRow>(
            `INSERT INTO audit_entry (${AUDIT_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING ${AUDIT_COLUMNS}`,
            [
              entry.seq,
              entry.id,
              entry.eventType,
              entry.recordedAt,
              entry.actor,
              entry.runId ?? null,
              entry.correlationId ?? null,
              entry.subject,
              entry.inputDigests,
              entry.decision,
              entry.previousHash,
              entry.entryHash,
            ],
          )
        )[0];
        if (!inserted) {
          throw new InvariantError(`Audit entry ${entry.seq} was not written.`);
        }

        // Rolls the transaction back if storage changed anything the hash
        // covers. An entry that would fail verification must never commit.
        const stored = toAuditEntry(inserted);
        assertRoundTrip(entry, stored);
        return stored;
      }),
    );
  }

  async listAuditEntries(filter: AuditFilter = {}): Promise<readonly AuditEntry[]> {
    const query = auditFilterSql(filter);
    const values = [...query.values];
    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page += ` LIMIT $${values.length}`;
    }
    if (filter.offset !== undefined) {
      values.push(filter.offset);
      page += ` OFFSET $${values.length}`;
    }

    const rows = await this.guard("listAuditEntries", () =>
      this.db.query<AuditRow>(
        `SELECT ${AUDIT_COLUMNS} FROM audit_entry ${query.where} ORDER BY seq ASC${page}`,
        values,
      ),
    );
    return rows.map(toAuditEntry);
  }

  async countAuditEntries(filter: AuditFilter = {}): Promise<number> {
    const query = auditFilterSql(filter);
    const rows = await this.guard("countAuditEntries", () =>
      this.db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM audit_entry ${query.where}`,
        query.values,
      ),
    );
    return Number(rows[0]?.count ?? 0);
  }

  async readAuditChain(fromSeq?: number, toSeq?: number): Promise<readonly AuditEntry[]> {
    // Ascending, always. The verifier walks the chain forward and would report
    // every link as broken if handed the entries in any other order.
    const rows = await this.guard("readAuditChain", () =>
      this.db.query<AuditRow>(
        `SELECT ${AUDIT_COLUMNS} FROM audit_entry
         WHERE seq >= $1 AND ($2::bigint IS NULL OR seq <= $2::bigint)
         ORDER BY seq ASC`,
        [fromSeq ?? 1, toSeq ?? null],
      ),
    );
    return rows.map(toAuditEntry);
  }

  async auditHead(): Promise<AuditEntry | null> {
    const rows = await this.guard("auditHead", () =>
      this.db.query<AuditRow>(
        `SELECT ${AUDIT_COLUMNS} FROM audit_entry ORDER BY seq DESC LIMIT 1`,
      ),
    );
    const row = rows[0];
    return row ? toAuditEntry(row) : null;
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DeniedError || error instanceof InvariantError) throw error;
      throw storeUnavailable(operation, error);
    }
  }
}

function toAuditEntry(row: AuditRow): AuditEntry {
  return {
    // bigint arrives as a string so a driver cannot silently round it.
    seq: Number(row.seq),
    id: row.id as Id<"auditEntry">,
    eventType: row.event_type as AuditEventType,
    recordedAt: row.recorded_at,
    actor: row.actor,
    // NULL becomes undefined, never null. `{runId: null}` and an absent runId
    // canonicalise differently, and this field is covered by the entry hash —
    // getting it wrong would break verification on an untampered chain.
    runId: row.run_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    subject: row.subject,
    inputDigests: row.input_digests,
    decision: row.decision,
    previousHash: row.previous_hash,
    entryHash: row.entry_hash,
  };
}

function auditFilterSql(filter: AuditFilter): { where: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];

  const add = (clause: (placeholder: string) => string, value: unknown): void => {
    values.push(value);
    clauses.push(clause(`$${values.length}`));
  };

  if (filter.eventType && filter.eventType.length > 0) {
    add((p) => `event_type = ANY(${p}::text[])`, [...filter.eventType]);
  }
  if (filter.runId !== undefined) add((p) => `run_id = ${p}`, filter.runId);
  if (filter.actorId !== undefined) add((p) => `actor_id = ${p}`, filter.actorId);
  if (filter.correlationId !== undefined) add((p) => `correlation_id = ${p}`, filter.correlationId);
  if (filter.recordedAfter !== undefined) add((p) => `recorded_at > ${p}`, filter.recordedAfter);
  if (filter.recordedBefore !== undefined) add((p) => `recorded_at < ${p}`, filter.recordedBefore);
  if (filter.fromSeq !== undefined) add((p) => `seq >= ${p}`, filter.fromSeq);
  if (filter.subject && Object.keys(filter.subject).length > 0) {
    // @> is containment: the entry's subject must include every pair given,
    // and may include more.
    add((p) => `subject @> ${p}::jsonb`, filter.subject);
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", values };
}
