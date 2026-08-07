import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { MemoryDb, PgDb, createPool } from "../store/db.js";
import { runMigrations } from "../store/migrate.js";
import { ALL_MIGRATIONS } from "../store/registry.js";
import { MemoryRunStore } from "../record/store.memory.js";
import { PgRunStore } from "../record/store.pg.js";
import type { RunStore } from "../record/port.js";
import { MemorySpendStore } from "../external/store.memory.js";
import { PgSpendStore } from "../external/store.pg.js";
import type { SpendStore } from "../external/port.js";
import type { ExternalAgentId } from "../external/types.js";

/**
 * Pass 2, group five — money.
 *
 * Both money columns in this platform are declared `numeric(20, 10)`, and both
 * migrations say in a comment why:
 *
 *   record/migrations.ts   "Exact decimal rather than a float: this column is
 *                          summed and compared against a spend ceiling, and
 *                          accumulated binary rounding error in a control is a
 *                          control that fails at the boundary."
 *   external/migrations.ts the same sentence, about `external_spend_meter`.
 *
 * Postgres honours that: `SUM(amount_usd)` and `spent_usd = spent_usd +
 * EXCLUDED.spent_usd` are exact decimal arithmetic inside the database. The
 * in-memory adapters accumulate the same figures in a JavaScript double, which
 * is precisely the binary rounding the comment forbids.
 *
 * These are not two implementations of a loose contract. `MemoryDb` is the
 * store every deployment runs on by default (`PV_STORE` defaults to `memory`),
 * it is what the demo and the whole non-Postgres test suite exercise, and
 * ADR 0006 says one contract suite governs both adapters. So a figure the two
 * disagree about is a control whose verdict depends on which store is wired.
 *
 * The reproduction is deliberately mundane: three hundred model calls at one
 * cent. Nothing adversarial, nothing large, nothing a reviewer has to accept as
 * plausible — an agent doing a day's work.
 */

const CONNECTION_STRING = process.env.PV_TEST_DATABASE_URL;

const NOW = "2026-08-06T12:00:00.000Z";

/**
 * Every identifier and every cost timestamp is unique to this run.
 *
 * Nothing here truncates a table. The Postgres test database is shared — with
 * the rest of the suite and, during this pass, with whoever else is running it
 * — and a `TRUNCATE run` issued from a review test would delete somebody else's
 * fixtures and report their absence as a defect. Scoping by id instead means
 * these assertions are true whatever else is in the database.
 */
const RUN_TAG = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let sequence = 0;
const nextAgent = (): ExternalAgentId => `eag_money_${RUN_TAG}_${(sequence += 1)}` as ExternalAgentId;

/**
 * When this run's cost entries are recorded.
 *
 * Far past anything the rest of the suite writes, so it cannot collide with a
 * fixture, and monotonic in wall-clock time so a later invocation is always
 * later than an earlier one.
 */
const COST_INSTANT_MS = Date.UTC(2090, 0, 1) + (Date.now() - Date.UTC(2020, 0, 1));
const COST_AT = new Date(COST_INSTANT_MS).toISOString();

/**
 * The window `costSince` is asked about, and why only the in-memory adapter is
 * asked.
 *
 * `costSince` answers "everything at or after this instant" across every run in
 * the store. On the in-memory adapter that is exactly this test's entries,
 * because the harness resets the database first. On Postgres the database is
 * shared and persistent, so the honest answer includes whatever earlier
 * invocations left behind, and no choice of window fixes that — a window low
 * enough to catch these entries catches those too.
 *
 * Rather than weaken the assertion to something a drifting total would also
 * satisfy, it is made where it is exact. Nothing is lost: the subject is the
 * in-memory adapter's own accumulation loop, which is separate code from
 * `costForRun`'s. Postgres reaches both answers through the same exact-decimal
 * `SUM(amount_usd)`, and that is asserted directly by the `costForRun` case
 * above, on both adapters.
 */
const COST_WINDOW_START = new Date(COST_INSTANT_MS - 1).toISOString();

const PERIOD = "2026-08";

/** Three hundred entries of one cent. True total: exactly $3.00. */
const ENTRY_USD = 0.01;
const ENTRY_COUNT = 300;
const TRUE_TOTAL_USD = 3;

interface SpendHarness {
  readonly label: string;
  prepare(): Promise<void>;
  fresh(): Promise<{ spend: SpendStore; runs: RunStore }>;
  close(): Promise<void>;
}

function memoryHarness(): SpendHarness {
  const db = new MemoryDb();
  const clock = new FixedClock(NOW);
  const ids = new SeededIdGenerator(`money-${RUN_TAG}`);
  return {
    label: "memory",
    async prepare() {},
    async fresh() {
      db.reset();
      return { spend: new MemorySpendStore(db), runs: new MemoryRunStore(db, clock, ids) };
    },
    async close() {},
  };
}

function postgresHarness(connectionString: string): SpendHarness {
  const pool = createPool(connectionString, 4);
  const db = new PgDb(pool);
  const clock = new FixedClock(NOW);
  const ids = new SeededIdGenerator(`money-${RUN_TAG}`);
  return {
    label: "postgres",
    async prepare() {
      await runMigrations(db, ALL_MIGRATIONS);
    },
    async fresh() {
      return { spend: new PgSpendStore(db), runs: new PgRunStore(db, clock, ids) };
    },
    async close() {
      await pool.end();
    },
  };
}

const harnesses: SpendHarness[] = [memoryHarness()];
if (CONNECTION_STRING) harnesses.push(postgresHarness(CONNECTION_STRING));

for (const harness of harnesses) {
  describe(`money arithmetic (${harness.label})`, () => {
    let spend: SpendStore;
    let runs: RunStore;

    beforeAll(async () => {
      await harness.prepare();
    });
    afterAll(async () => {
      await harness.close();
    });
    beforeEach(async () => {
      ({ spend, runs } = await harness.fresh());
    });

    it("an external agent's spend meter reads exactly what it spent", async () => {
      const agent = nextAgent();
      for (let i = 0; i < ENTRY_COUNT; i += 1) {
        await spend.addSpend(agent, PERIOD, ENTRY_USD, NOW);
      }
      const meter = await spend.getMeter(agent, PERIOD);
      expect(meter?.spentUsd).toBe(TRUE_TOTAL_USD);
    });

    it("an agent that has spent its whole ceiling is at its ceiling", async () => {
      // The admission chain's first budget gate is `spent >= ceiling`. An agent
      // whose ceiling is $3.00 and which has spent exactly $3.00 has no
      // headroom left, and a meter that reads a hair under lets it keep going.
      const agent = nextAgent();
      const ceilingUsd = TRUE_TOTAL_USD;
      for (let i = 0; i < ENTRY_COUNT; i += 1) {
        await spend.addSpend(agent, PERIOD, ENTRY_USD, NOW);
      }
      const meter = await spend.getMeter(agent, PERIOD);
      const spent = meter?.spentUsd ?? 0;
      expect(spent >= ceilingUsd).toBe(true);
    });

    it("the run cost rollup reads exactly what the run cost", async () => {
      const run = await runs.createRun({
        kind: "rescission.package_check",
        mode: "supervised",
        requestedBy: { actorId: "svc:test", kind: "service", roles: ["platform_admin"] },
        subject: { contractId: `CT-${RUN_TAG}` },
        correlationId: `corr-money-${RUN_TAG}`,
      });
      for (let i = 0; i < ENTRY_COUNT; i += 1) {
        await runs.recordCost({
          runId: run.id,
          category: "model",
          amountUsd: ENTRY_USD,
          recordedAt: COST_AT,
        });
      }
      const cost = await runs.costForRun(run.id);
      expect(cost.totalUsd).toBe(TRUE_TOTAL_USD);
      expect(cost.byCategory["model"]).toBe(TRUE_TOTAL_USD);

      // The figure the daily spend ceiling reads. See COST_WINDOW_START for
      // why this is asserted on the adapter with a private database.
      if (harness.label === "memory") {
        expect(await runs.costSince(COST_WINDOW_START)).toBe(TRUE_TOTAL_USD);
      }
    });

    it("the meter does not depend on the order the spend was reported in", async () => {
      // Same three amounts, two orders, two meters. A control whose verdict
      // depends on the sequence reports happened to arrive in is not a control.
      const amounts = [0.1, 0.2, 0.3];

      const forwards = nextAgent();
      for (const amount of amounts) await spend.addSpend(forwards, PERIOD, amount, NOW);
      const ascending = (await spend.getMeter(forwards, PERIOD))?.spentUsd;

      const backwards = nextAgent();
      for (const amount of [...amounts].reverse()) {
        await spend.addSpend(backwards, PERIOD, amount, NOW);
      }
      const descending = (await spend.getMeter(backwards, PERIOD))?.spentUsd;

      expect(ascending).toBe(descending);
      expect(ascending).toBe(0.6);
    });
  });
}
