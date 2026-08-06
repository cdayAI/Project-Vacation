import pg from "pg";
import { DeniedError } from "../kernel/errors.js";

/**
 * Database access.
 *
 * Two adapters implement every persistence port in this platform: Postgres for
 * real deployments, and an in-memory adapter for tests, local development, and
 * the seeded demo. A shared contract-test suite runs against both, so the fake
 * cannot quietly become more permissive than the real thing.
 *
 * `Db` is the narrow seam the Postgres adapters share. The in-memory adapters
 * do not implement it — they are not pretending to speak SQL — they use
 * `MemoryDb` instead. Keeping those two apart is deliberate: a fake that
 * emulates a query planner is a second database with its own bugs, whereas a
 * fake that stores objects in maps is obviously correct by inspection.
 */
export interface Db {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  /**
   * Run `fn` inside a transaction.
   *
   * Nested calls join the enclosing transaction rather than opening a second
   * one, so a helper that wants atomicity can ask for it without knowing
   * whether its caller already did.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export class PgDb implements Db {
  constructor(
    private readonly pool: pg.Pool,
    private readonly client?: pg.PoolClient,
  ) {}

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    const executor = this.client ?? this.pool;
    const result = await executor.query<R>(text, params as unknown[]);
    return result.rows;
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.client) return fn(this);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PgDb(this.pool, client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A rollback failure must not mask the original error, which is the
        // one that explains what actually went wrong.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    // Fail fast rather than hanging a request behind an exhausted pool. A
    // caller that cannot reach the operating record must refuse its action,
    // and it can only do that if the attempt returns.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

/**
 * In-memory tables with an async mutex.
 *
 * The mutex is what makes the in-memory adapter a *realistic* fake rather than
 * a convenient one. Several ports require operations that must be atomic under
 * concurrency — assigning an audit sequence number, appending a step's
 * sequence, consuming a single-use approval. In Postgres those are a
 * transaction with row locking. Here they are `withLock`, and the contract
 * tests exercise both with concurrent callers.
 */
export class MemoryDb {
  private readonly tables = new Map<string, Map<string, unknown>>();
  private readonly locks = new Map<string, Promise<unknown>>();

  table<T>(name: string): Map<string, T> {
    let table = this.tables.get(name);
    if (!table) {
      table = new Map<string, unknown>();
      this.tables.set(name, table);
    }
    return table as Map<string, T>;
  }

  /** Every row in a table, in insertion order. */
  rows<T>(name: string): T[] {
    return [...this.table<T>(name).values()];
  }

  /**
   * Serialise `fn` against others holding the same named lock.
   *
   * Callers are queued in arrival order. A rejection releases the lock for the
   * next waiter rather than poisoning the chain.
   */
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      name,
      previous.then(() => gate),
    );

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Discard everything. Used between tests. */
  reset(): void {
    this.tables.clear();
    this.locks.clear();
  }
}

/** Raised when a store cannot serve a read or a write. Always fails closed. */
export function storeUnavailable(operation: string, error: unknown): DeniedError {
  return new DeniedError(
    "record.unavailable",
    `The operating record could not complete "${operation}", so the action was refused: ${error instanceof Error ? error.message : String(error)}`,
    { operation },
  );
}
