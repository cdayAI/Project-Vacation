import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { PgDb } from "./db.js";
import {
  migrationChecksum,
  orderMigrations,
  readAppliedMigrations,
  runMigrations,
  type Migration,
} from "./migrate.js";
import { ALL_MIGRATIONS } from "./registry.js";

/**
 * The migration runner and the registry it is fed.
 *
 * The structural cases run everywhere. The cases that need a database run when
 * `PV_TEST_DATABASE_URL` is set, against their own schema so that applying,
 * failing, and rolling back migrations here cannot disturb the schema the
 * contract suite is using.
 */

const CONNECTION_STRING = process.env.PV_TEST_DATABASE_URL;
const TEST_SCHEMA = "pv_migrate_runner_test";

const ALPHA: Migration = { id: "0001_alpha", sql: "CREATE TABLE alpha (id text PRIMARY KEY)" };
const BETA: Migration = { id: "0002_beta", sql: "CREATE TABLE beta (id text PRIMARY KEY)" };

describe("migration ordering and identity", () => {
  it("sorts by id regardless of the order modules are registered in", () => {
    const ordered = orderMigrations([BETA, ALPHA]);
    expect(ordered.map((migration) => migration.id)).toEqual(["0001_alpha", "0002_beta"]);
  });

  it("refuses a malformed id", () => {
    for (const id of ["1_alpha", "0001-alpha", "0001_Alpha", "alpha", "00001_alpha", "0001_"]) {
      expect(() => orderMigrations([{ id, sql: "SELECT 1" }])).toThrow(InvalidInputError);
    }
  });

  it("refuses two migrations claiming the same id", () => {
    // Two modules that both took 0002 would each believe the other's schema
    // change was already applied.
    expect(() => orderMigrations([ALPHA, { id: "0001_alpha", sql: "SELECT 2" }])).toThrow(
      InvalidInputError,
    );
  });

  it("refuses a migration with no SQL", () => {
    expect(() => orderMigrations([{ id: "0004_empty", sql: "   " }])).toThrow(InvalidInputError);
  });

  it("fingerprints SQL identically across line-ending conventions", () => {
    // Otherwise a checkout configured for CRLF would report every released
    // migration as tampered with and refuse to start.
    expect(migrationChecksum("CREATE TABLE a (b int);\nSELECT 1;")).toBe(
      migrationChecksum("CREATE TABLE a (b int);\r\nSELECT 1;"),
    );
  });

  it("notices any other change to a migration's SQL", () => {
    expect(migrationChecksum(ALPHA.sql)).not.toBe(migrationChecksum(`${ALPHA.sql} -- edited`));
  });
});

describe("the platform's migration registry", () => {
  it("is ordered, uniquely identified, and covers the spine", () => {
    expect(ALL_MIGRATIONS.map((migration) => migration.id)).toEqual([
      "0001_record",
      "0002_audit",
      "0003_guard",
    ]);
    expect(new Set(ALL_MIGRATIONS.map((m) => m.id)).size).toBe(ALL_MIGRATIONS.length);
  });
});

describe.skipIf(!CONNECTION_STRING)("applying migrations to Postgres", () => {
  let pool: pg.Pool;
  let db: PgDb;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: CONNECTION_STRING,
      max: 8,
      connectionTimeoutMillis: 5_000,
      // Every connection from this pool works inside its own schema, so these
      // cases cannot collide with the contract suite's tables.
      options: `-c search_path=${TEST_SCHEMA}`,
    });
    db = new PgDb(pool);
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  });

  const tableExists = async (name: string): Promise<boolean> => {
    const rows = await db.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2
       ) AS present`,
      [TEST_SCHEMA, name],
    );
    return rows[0]?.present === true;
  };

  it("applies pending migrations in id order and records them", async () => {
    const result = await runMigrations(db, [BETA, ALPHA]);
    expect(result.applied).toEqual(["0001_alpha", "0002_beta"]);
    expect(result.alreadyApplied).toEqual([]);
    expect(await tableExists("alpha")).toBe(true);
    expect(await tableExists("beta")).toBe(true);

    const recorded = await readAppliedMigrations(db);
    expect(recorded.map((entry) => entry.id)).toEqual(["0001_alpha", "0002_beta"]);
    expect(recorded[0]?.checksum).toBe(migrationChecksum(ALPHA.sql));
  });

  it("is a no-op the second time", async () => {
    await runMigrations(db, [ALPHA, BETA]);
    const second = await runMigrations(db, [ALPHA, BETA]);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(["0001_alpha", "0002_beta"]);
  });

  it("applies only what is pending", async () => {
    await runMigrations(db, [ALPHA]);
    const second = await runMigrations(db, [ALPHA, BETA]);
    expect(second.applied).toEqual(["0002_beta"]);
    expect(second.alreadyApplied).toEqual(["0001_alpha"]);
  });

  it("refuses the whole run when an applied migration's SQL has changed", async () => {
    await runMigrations(db, [ALPHA]);

    const edited: Migration = { id: "0001_alpha", sql: `${ALPHA.sql} -- squeezed in a column` };
    await expect(runMigrations(db, [edited, BETA])).rejects.toBeInstanceOf(DeniedError);

    // Nothing at all was applied, including the untouched migration that
    // follows it. A half-migrated database is worse than an unmigrated one.
    expect(await tableExists("beta")).toBe(false);
    expect((await readAppliedMigrations(db)).map((entry) => entry.id)).toEqual(["0001_alpha"]);
  });

  it("reports applied migrations it does not recognise instead of refusing", async () => {
    // A rolling deploy has the old build meeting the new build's migrations.
    // Refusing here would turn a normal deploy into an outage.
    await runMigrations(db, [ALPHA, BETA]);
    const older = await runMigrations(db, [ALPHA]);
    expect(older.unrecognised).toEqual(["0002_beta"]);
    expect(older.applied).toEqual([]);
  });

  it("rolls a failing migration back and does not record it", async () => {
    const broken: Migration = {
      id: "0002_beta",
      sql: "CREATE TABLE beta (id text PRIMARY KEY); SELECT this_function_does_not_exist();",
    };

    await expect(runMigrations(db, [ALPHA, broken])).rejects.toBeInstanceOf(DeniedError);

    expect(await tableExists("alpha")).toBe(true);
    // The half of the migration that succeeded is gone with the transaction.
    expect(await tableExists("beta")).toBe(false);
    expect((await readAppliedMigrations(db)).map((entry) => entry.id)).toEqual(["0001_alpha"]);

    // And the deployment can be fixed forward without manual cleanup.
    const repaired = await runMigrations(db, [ALPHA, BETA]);
    expect(repaired.applied).toEqual(["0002_beta"]);
  });

  it("applies each migration exactly once when two runners start together", async () => {
    const [left, right] = await Promise.all([
      runMigrations(db, [ALPHA, BETA]),
      runMigrations(db, [ALPHA, BETA]),
    ]);

    const appliedTwice = [...left.applied, ...right.applied].sort();
    expect(appliedTwice).toEqual(["0001_alpha", "0002_beta"]);
    expect([...left.applied, ...left.alreadyApplied].sort()).toEqual(["0001_alpha", "0002_beta"]);
    expect([...right.applied, ...right.alreadyApplied].sort()).toEqual(["0001_alpha", "0002_beta"]);
  });

  it("applies the platform's own registry cleanly into an empty schema", async () => {
    const result = await runMigrations(db, ALL_MIGRATIONS);
    expect(result.applied).toEqual(["0001_record", "0002_audit", "0003_guard"]);
    for (const table of [
      "run",
      "run_step",
      "run_cost",
      "audit_entry",
      "approval",
      "approval_decision",
      "containment_switch",
    ]) {
      expect(await tableExists(table)).toBe(true);
    }
  });

  it("refuses rather than proceeding when the database cannot be reached", async () => {
    const unreachable = new pg.Pool({
      connectionString: (CONNECTION_STRING ?? "").replace("/pv_test", "/pv_absent_database"),
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    try {
      await expect(runMigrations(new PgDb(unreachable), [ALPHA])).rejects.toBeInstanceOf(
        DeniedError,
      );
    } finally {
      await unreachable.end();
    }
  });
});
