import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestBytes, type Digest } from "../kernel/hash.js";
import { storeUnavailable, type Db } from "./db.js";

/**
 * The schema migration runner.
 *
 * Three properties matter here, and each closes a specific way a deployment
 * loses its operating record.
 *
 * *Immutability.* A migration that has been applied to a production database
 * describes a change that has already happened. Editing its SQL afterwards
 * does not change the database; it only makes the code lie about what the
 * database contains, and the next environment to be built from scratch ends
 * up with a different schema from the one in production. So every applied
 * migration's SQL is fingerprinted, and a run that finds a fingerprint has
 * changed refuses to do anything at all — including applying the unrelated
 * migrations that follow it. Refusing wholesale is deliberate: a half-migrated
 * database is worse than an unmigrated one.
 *
 * *Atomicity.* Each migration runs inside a transaction, so a migration that
 * fails halfway leaves no trace and is not recorded as applied. Postgres
 * makes DDL transactional, which is the reason this platform can make that
 * promise at all.
 *
 * *Safety under concurrency.* Deployments roll. Two instances starting at the
 * same time will both try to migrate. Each migration is applied while holding
 * a transaction-scoped advisory lock and re-checks the registry under that
 * lock, so the loser of the race observes the winner's row and skips rather
 * than applying the same DDL twice.
 *
 * The runner speaks `Db`, which only the Postgres adapters implement. The
 * in-memory adapters have no schema to migrate — that asymmetry is the point
 * of keeping `MemoryDb` off the `Db` interface.
 */

/**
 * One released schema change.
 *
 * Declared structurally rather than imported by the modules that produce it,
 * so a module's `migrations.ts` has no dependency on the runner.
 */
export interface Migration {
  readonly id: string;
  readonly sql: string;
}

/** A row of the registry: a migration this database has already applied. */
export interface AppliedMigration {
  readonly id: string;
  readonly checksum: Digest;
  readonly appliedAt: string;
}

export interface MigrationRunResult {
  /** Ids applied by this run, in the order they were applied. */
  readonly applied: readonly string[];
  /** Ids this database already had, left untouched. */
  readonly alreadyApplied: readonly string[];
  /**
   * Ids the database has applied that this build does not know about.
   *
   * Reported rather than refused. During a rolling deploy an older instance
   * legitimately sees migrations a newer instance applied moments earlier, and
   * refusing there would turn a normal deploy into an outage. An operator
   * still wants to see it, because outside a deploy window it means someone
   * has been applying schema changes by hand.
   */
  readonly unrecognised: readonly string[];
}

export const MIGRATION_REGISTRY_TABLE = "schema_migrations";

/**
 * Ids are `NNNN_lower_snake_name`.
 *
 * The zero-padded prefix makes lexicographic order and intended order the same
 * thing, so ordering never depends on parsing a number out of a name.
 */
const MIGRATION_ID_PATTERN = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Advisory lock key for the migration run.
 *
 * An arbitrary but fixed constant. It only has to be stable across builds and
 * distinct from the other advisory locks this platform takes; it is not
 * derived from anything, so nothing can accidentally collide with it by
 * hashing the same string.
 */
const MIGRATION_LOCK_KEY = 6_143_207_618;

const REGISTRY_SQL = `
CREATE TABLE IF NOT EXISTS ${MIGRATION_REGISTRY_TABLE} (
  id          text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
)`;

type RegistryRow = {
  id: string;
  checksum: string;
  applied_at: Date;
};

/**
 * Fingerprint a migration's SQL.
 *
 * Line endings are normalised first. Without that, the same file checked out
 * on a machine configured for CRLF would produce a different fingerprint and
 * every deployment from that machine would refuse to start, reporting tampering
 * that never happened.
 */
export function migrationChecksum(sql: string): Digest {
  return digestBytes(sql.replace(/\r\n/g, "\n"));
}

/**
 * Sort migrations into application order and reject a malformed set.
 *
 * @throws {InvalidInputError} on a malformed id or a duplicate id. Both are
 *   programming errors in the registry rather than deployment conditions, and
 *   both would otherwise produce a database whose schema depends on module
 *   import order.
 */
export function orderMigrations(migrations: readonly Migration[]): readonly Migration[] {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (!MIGRATION_ID_PATTERN.test(migration.id)) {
      throw new InvalidInputError(
        `Migration id "${migration.id}" is malformed. Ids look like "0007_knowledge": four digits, an underscore, then a lower_snake_case name.`,
        "id",
      );
    }
    if (seen.has(migration.id)) {
      throw new InvalidInputError(
        `Migration id "${migration.id}" is declared twice. Ids identify a released schema change and must be unique across every module.`,
        "id",
      );
    }
    if (migration.sql.trim().length === 0) {
      throw new InvalidInputError(`Migration "${migration.id}" has no SQL.`, "sql");
    }
    seen.add(migration.id);
  }
  return [...migrations].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Everything this database has applied, in id order. */
export async function readAppliedMigrations(db: Db): Promise<readonly AppliedMigration[]> {
  try {
    await ensureRegistry(db);
    const rows = await db.query<RegistryRow>(
      `SELECT id, checksum, applied_at FROM ${MIGRATION_REGISTRY_TABLE} ORDER BY id ASC`,
    );
    return rows.map((row) => ({
      id: row.id,
      checksum: row.checksum,
      // Read back as an instant and re-rendered in the platform's wire form.
      // Reading a stored value is not a wall-clock reading.
      appliedAt: row.applied_at.toISOString(),
    }));
  } catch (error) {
    throw storeUnavailable("readAppliedMigrations", error);
  }
}

async function ensureRegistry(db: Db): Promise<void> {
  // Two runners issuing CREATE TABLE IF NOT EXISTS simultaneously can collide
  // in the system catalogue, so even this is taken under the lock.
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    await tx.query(REGISTRY_SQL);
  });
}

/**
 * A migration this build knows about whose SQL no longer matches what was
 * applied. `runMigrations` refuses outright on any of these, and refuses
 * wholesale — including the unrelated migrations that follow.
 */
export interface ChangedMigration {
  readonly id: string;
  readonly appliedAt: string;
  /** What this database recorded when the migration was applied. */
  readonly appliedChecksum: Digest;
  /** What the SQL in this build hashes to now. */
  readonly buildChecksum: Digest;
}

export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  /** Ids this build has that the database does not, in the order they will run. */
  readonly pending: readonly string[];
  /** Ids the database has that this build does not know about. */
  readonly unrecognised: readonly string[];
  /** Applied migrations whose SQL has since been edited. Nothing will migrate. */
  readonly changed: readonly ChangedMigration[];
}

/**
 * What this database has, what it is missing, and whether the two agree.
 *
 * Read-only in the sense that matters: it applies no migration and changes no
 * table this platform owns. It does create the registry table if it is absent,
 * because otherwise "no migration has been applied here" and "this database is
 * unreachable" would be told apart by a query that errors — and a status
 * command has to distinguish those two rather than confuse them.
 *
 * Separate from `runMigrations` because the questions are different. An
 * operator during an incident is asking whether the schema is where the build
 * expects it, and answering that by *migrating* is the last thing anybody
 * wants at three in the morning.
 */
export async function migrationStatus(
  db: Db,
  migrations: readonly Migration[],
): Promise<MigrationStatus> {
  const ordered = orderMigrations(migrations);
  const applied = await readAppliedMigrations(db);
  const appliedById = new Map(applied.map((entry) => [entry.id, entry]));

  const pending: string[] = [];
  const changed: ChangedMigration[] = [];

  for (const migration of ordered) {
    const record = appliedById.get(migration.id);
    if (!record) {
      pending.push(migration.id);
      continue;
    }
    const checksum = migrationChecksum(migration.sql);
    if (record.checksum !== checksum) {
      changed.push({
        id: migration.id,
        appliedAt: record.appliedAt,
        appliedChecksum: record.checksum,
        buildChecksum: checksum,
      });
    }
  }

  const known = new Set(ordered.map((migration) => migration.id));
  const unrecognised = [...appliedById.keys()].filter((id) => !known.has(id)).sort();

  return { applied, pending, unrecognised, changed };
}

/**
 * Apply every pending migration, in id order.
 *
 * @throws {DeniedError} `config.invalid` if an applied migration's SQL has
 *   changed since it was applied. Nothing is applied in that case.
 * @throws {DeniedError} `record.unavailable` if the database cannot be reached
 *   or a migration fails, so a process that cannot establish its schema
 *   refuses to serve rather than running against a half-built one.
 */
export async function runMigrations(
  db: Db,
  migrations: readonly Migration[],
): Promise<MigrationRunResult> {
  const ordered = orderMigrations(migrations);

  const applied = await readAppliedMigrations(db);
  const appliedById = new Map(applied.map((entry) => [entry.id, entry]));

  // Immutability is checked across the whole set before a single statement
  // runs. Checking as we go would apply the migrations that precede the
  // altered one and leave the database in a state no build produces.
  for (const migration of ordered) {
    const record = appliedById.get(migration.id);
    if (!record) continue;
    const checksum = migrationChecksum(migration.sql);
    if (record.checksum !== checksum) {
      throw new DeniedError(
        "config.invalid",
        `Migration "${migration.id}" has changed since it was applied to this database on ${record.appliedAt}. Released migrations are immutable: restore the original SQL and express the change as a new, additive migration.`,
        { migrationId: migration.id, appliedAt: record.appliedAt },
      );
    }
  }

  const known = new Set(ordered.map((migration) => migration.id));
  const unrecognised = [...appliedById.keys()].filter((id) => !known.has(id)).sort();

  const appliedNow: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of ordered) {
    if (appliedById.has(migration.id)) {
      alreadyApplied.push(migration.id);
      continue;
    }

    const checksum = migrationChecksum(migration.sql);
    let didApply = false;

    try {
      await db.transaction(async (tx) => {
        // Serialises concurrent runners. Released at commit or rollback, so a
        // crashed runner cannot wedge a deployment.
        await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_KEY]);

        // Re-read under the lock. Another instance may have applied this
        // migration between our listing and our turn.
        const existing = await tx.query<{ checksum: string }>(
          `SELECT checksum FROM ${MIGRATION_REGISTRY_TABLE} WHERE id = $1`,
          [migration.id],
        );
        const row = existing[0];
        if (row) {
          if (row.checksum !== checksum) {
            throw new DeniedError(
              "config.invalid",
              `Migration "${migration.id}" was applied concurrently with different SQL. Two builds disagree about what this migration contains.`,
              { migrationId: migration.id },
            );
          }
          return;
        }

        // No parameters, so node-postgres uses the simple query protocol and a
        // migration may contain several statements.
        await tx.query(migration.sql);
        await tx.query(
          `INSERT INTO ${MIGRATION_REGISTRY_TABLE} (id, checksum) VALUES ($1, $2)`,
          [migration.id, checksum],
        );
        didApply = true;
      });
    } catch (error) {
      if (error instanceof DeniedError) throw error;
      throw storeUnavailable(`migrate ${migration.id}`, error);
    }

    if (didApply) appliedNow.push(migration.id);
    else alreadyApplied.push(migration.id);
  }

  return { applied: appliedNow, alreadyApplied, unrecognised };
}
