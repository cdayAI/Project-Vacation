import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../kernel/config.js";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { buildPlatform, type Platform } from "../platform.js";
import type { ActorRef } from "../record/types.js";
import { parseWorkQueueQuery, workQueuePage } from "../api/work-queue.js";

/**
 * Pass 2, group five — N+1 queries on the console's landing screen.
 *
 * `workQueuePage` reads a window of runs, then calls `costForRun` once per run
 * to fill the queue's cost column. That is one database round-trip per row.
 *
 * The amplification is what makes it worth a finding rather than a note. Any
 * saved view, and any assignee filter, sets `needsPostFilter`, which widens the
 * store read from the caller's page size to `POST_FILTER_WINDOW` — five hundred
 * rows — because those filters are resolved in this process rather than in SQL.
 * The cost lookups then run over all five hundred, sequentially, in a `for`
 * loop with an `await` in it, to return a page of fifty. On a Postgres store
 * that is five hundred serialised round-trips per keystroke on the filter bar,
 * and the four hundred and fifty rows that get discarded were paid for in full.
 *
 * The test measures the round-trips rather than the wall clock, so it means the
 * same thing on every machine.
 */

const START = "2026-08-06T12:00:00.000Z";

const VIEWER: ActorRef = {
  actorId: "usr_dana",
  kind: "human",
  roles: ["supervisor"],
};

/** More runs than a page, fewer than the post-filter window. */
const SEEDED_RUNS = 200;
const PAGE_LIMIT = 50;

describe("the work queue's cost column", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("queue-cost"),
      logger: createNullLogger(),
    });
  });

  afterEach(async () => {
    await platform.close();
  });

  /** A view of the platform whose run store counts what it is asked for. */
  function counting(): { platform: Platform; costCalls: () => number } {
    let calls = 0;
    const runs = new Proxy(platform.runs, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "costForRun" || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const wrapped = new Proxy(platform, {
      get: (target, property, receiver) =>
        property === "runs" ? runs : Reflect.get(target, property, receiver),
    });
    return { platform: wrapped as Platform, costCalls: () => calls };
  }

  async function seed(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await platform.runs.createRun({
        kind: "rescission.package_check",
        mode: "supervised",
        requestedBy: VIEWER,
        subject: { contractId: `CT-${String(i).padStart(4, "0")}` },
        correlationId: `corr-${i}`,
      });
    }
  }

  it("costs the rows it returns, not the whole post-filter window", async () => {
    await seed(SEEDED_RUNS);
    const { platform: watched, costCalls } = counting();

    // "Unassigned" is one of the five saved views the filter bar offers as a
    // pill, and it is the ordinary way an operator picks up new work.
    const filter = parseWorkQueueQuery({ view: "unassigned", limit: String(PAGE_LIMIT) });
    const page = await workQueuePage(watched, filter, VIEWER);

    expect(page.items).toHaveLength(PAGE_LIMIT);
    // One lookup per returned row is the shape a batched port method would
    // replace; one lookup per row *examined* is the defect. The bound is the
    // page, plus a little slack, never the window.
    expect(costCalls()).toBeLessThanOrEqual(PAGE_LIMIT + 1);
  });

  it("costs nothing extra when a filter discards every row", async () => {
    await seed(SEEDED_RUNS);
    const { platform: watched, costCalls } = counting();

    // Under a fixed clock nothing has aged past its target, so "Breaching"
    // returns an empty queue. The work of costing two hundred runs to display
    // none of them is pure waste, and it is the state the pill sits in for most
    // of a normal day.
    const filter = parseWorkQueueQuery({ view: "breaching", limit: String(PAGE_LIMIT) });
    const page = await workQueuePage(watched, filter, VIEWER);

    expect(page.items).toHaveLength(0);
    expect(costCalls()).toBe(0);
  });

  it("still ranks by cost when asked to, and says so with the same numbers", async () => {
    // Ranking by cost is the one sort that genuinely needs every candidate's
    // cost, so it is allowed to pay for the window. The guard against a fix
    // that quietly drops the column: the figures must still be right.
    await seed(3);
    const all = await platform.runs.listRuns({ limit: 10 });
    const [first, second] = all;
    if (!first || !second) throw new Error("seed did not produce enough runs");

    await platform.runs.recordCost({
      runId: first.id,
      category: "model",
      amountUsd: 0.25,
      recordedAt: START,
    });
    await platform.runs.recordCost({
      runId: second.id,
      category: "model",
      amountUsd: 1.5,
      recordedAt: START,
    });

    const page = await workQueuePage(
      platform,
      parseWorkQueueQuery({ sort: "cost_desc", limit: "10" }),
      VIEWER,
    );

    expect(page.items[0]?.runId).toBe(second.id);
    expect(page.items[0]?.costUsd).toBe(1.5);
    expect(page.items[1]?.runId).toBe(first.id);
    expect(page.items[1]?.costUsd).toBe(0.25);
    expect(page.items[2]?.costUsd).toBe(0);
  });
});
