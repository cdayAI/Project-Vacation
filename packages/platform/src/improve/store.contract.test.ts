import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FixedClock } from "../kernel/clock.js";
import { InvalidInputError } from "../kernel/errors.js";
import { SeededIdGenerator, type Id } from "../kernel/ids.js";
import { MemoryRunStore } from "../record/store.memory.js";
import { PgRunStore } from "../record/store.pg.js";
import type { RunStore } from "../record/port.js";
import type { ActorRef } from "../record/types.js";
import { MemoryDb, PgDb, createPool } from "../store/db.js";
import { runMigrations } from "../store/migrate.js";
import { ALL_MIGRATIONS } from "../store/registry.js";
import type { ObservationStore } from "./port.js";
import { MemoryObservationStore } from "./store.memory.js";
import { PgObservationStore } from "./store.pg.js";
import type { Observation } from "./types.js";

/**
 * The retention purge, held to one contract across both adapters.
 *
 * `purgeObservationsBefore` is the only destructive operation on the
 * improvement loop's storage, and it is driven by a background job nobody
 * watches. That combination is why it is contract-tested rather than tested
 * once against the fake: an adapter that ignored the batch cap, or that deleted
 * an arbitrary subset instead of the oldest rows, would leave a retention
 * period quietly unenforced while every unit test still passed.
 *
 * Runs against Postgres only when `PV_TEST_DATABASE_URL` is set. A run without
 * it exercises the fake alone, which is exactly the false green worth knowing
 * about.
 */

const CONNECTION_STRING = process.env.PV_TEST_DATABASE_URL;

const T0 = "2026-08-07T09:00:00.000Z";
const ACTOR: ActorRef = { actorId: "act_jay", kind: "human", roles: ["supervisor"] };

interface Adapters {
  readonly observations: ObservationStore;
  readonly runs: RunStore;
}

interface Harness {
  prepare(): Promise<void>;
  fresh(): Promise<Adapters>;
  close(): Promise<void>;
}

function memoryHarness(): Harness {
  const db = new MemoryDb();
  return {
    async prepare() {},
    async fresh() {
      db.reset();
      return {
        observations: new MemoryObservationStore(db),
        runs: new MemoryRunStore(db, new FixedClock(T0), new SeededIdGenerator("improve-contract")),
      };
    },
    async close() {},
  };
}

function postgresHarness(connectionString: string): Harness {
  const pool = createPool(connectionString, 4);
  const db = new PgDb(pool);
  return {
    async prepare() {
      await runMigrations(db, ALL_MIGRATIONS);
    },
    async fresh() {
      await db.query(
        `TRUNCATE improvement_quality_sample, improvement_application, improvement_proposal,
         improvement_observation, run_cost, run_step, run RESTART IDENTITY CASCADE`,
      );
      return {
        observations: new PgObservationStore(db),
        runs: new PgRunStore(db, new FixedClock(T0), new SeededIdGenerator("improve-contract")),
      };
    },
    async close() {
      await pool.end();
    },
  };
}

/** A run to hang observations off. Postgres enforces the reference; the fake does not. */
async function aRunId(adapters: Adapters): Promise<Id<"run">> {
  const run = await adapters.runs.createRun({
    kind: "rescission.verify",
    mode: "supervised",
    requestedBy: ACTOR,
    subject: { contractId: "ctr_0001" },
    correlationId: "cor_0001",
  });
  return run.id;
}

function anObservation(runId: Id<"run">, index: number, recordedAt: string): Observation {
  return {
    id: `obs_${index}` as Id<"observation">,
    kind: "human_correction",
    runId,
    signature: "deadline.wrong_jurisdiction",
    note: "The deadline used the wrong state.",
    observedBy: ACTOR,
    recordedAt,
    correctionMinutes: 4,
    costUsd: 0.1,
    subject: { contractId: "ctr_0001" },
    idempotencyKey: `key_${index}`,
  };
}

/** Five observations, one day apart, oldest first. */
async function seed(adapters: Adapters, runId: Id<"run">): Promise<void> {
  for (let index = 1; index <= 5; index += 1) {
    await adapters.observations.appendObservation(
      anObservation(runId, index, `2026-0${index}-01T00:00:00.000Z`),
    );
  }
}

const harnesses: [string, Harness][] = [["memory", memoryHarness()]];
if (CONNECTION_STRING) harnesses.push(["postgres", postgresHarness(CONNECTION_STRING)]);

describe.each(harnesses)("observation retention purge (%s)", (_name, harness) => {
  let adapters: Adapters;
  let runId: Id<"run">;

  beforeAll(async () => {
    await harness.prepare();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    adapters = await harness.fresh();
    runId = await aRunId(adapters);
    await seed(adapters, runId);
  });

  it("deletes only what is past the cut-off", async () => {
    const purged = await adapters.observations.purgeObservationsBefore(
      "2026-03-15T00:00:00.000Z",
      100,
    );
    expect(purged).toBe(3);
    const left = await adapters.observations.listObservations();
    expect(left.map((row) => row.id)).toEqual(["obs_4", "obs_5"]);
  });

  it("caps the batch and takes the oldest rows first", async () => {
    // Oldest-first matters more than it looks. A purge that deleted an
    // arbitrary two would leave January behind indefinitely while reporting
    // progress every run, which is the one outcome retention exists to prevent.
    const purged = await adapters.observations.purgeObservationsBefore(T0, 2);
    expect(purged).toBe(2);
    const left = await adapters.observations.listObservations();
    expect(left.map((row) => row.id)).toEqual(["obs_3", "obs_4", "obs_5"]);
  });

  it("is idempotent — a second pass over an already-purged window deletes nothing", async () => {
    await adapters.observations.purgeObservationsBefore("2026-03-15T00:00:00.000Z", 100);
    expect(
      await adapters.observations.purgeObservationsBefore("2026-03-15T00:00:00.000Z", 100),
    ).toBe(0);
  });

  it("refuses an unbounded batch", async () => {
    // The cap is the whole protection against a purge holding locks on a table
    // the console reads, so a caller passing 0 or a fraction is a mistake worth
    // refusing rather than interpreting.
    await expect(
      adapters.observations.purgeObservationsBefore(T0, 0),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      adapters.observations.purgeObservationsBefore(T0, 1.5),
    ).rejects.toThrow(InvalidInputError);
    expect(await adapters.observations.countObservations()).toBe(5);
  });

  it("refuses a cut-off that is not a UTC instant", async () => {
    await expect(
      adapters.observations.purgeObservationsBefore("2026-03-15", 100),
    ).rejects.toThrow();
    expect(await adapters.observations.countObservations()).toBe(5);
  });
});
