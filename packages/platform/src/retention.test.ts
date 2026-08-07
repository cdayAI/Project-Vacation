import { describe, it, expect } from "vitest";
import { AuditLog } from "./audit/log.js";
import { verifyChain } from "./audit/chain.js";
import { MemoryAuditStore } from "./audit/store.memory.js";
import type { AuditStore, ChainPosition } from "./audit/port.js";
import type { AuditEntry, NewAuditEntry } from "./audit/types.js";
import { DiscoveryCollector } from "./discovery/collect.js";
import { EnrollmentService } from "./discovery/enrollment.js";
import { discoverySettings } from "./discovery/retention.js";
import { MemoryDiscoveryStore } from "./discovery/store.memory.js";
import { MemoryObservationStore } from "./improve/store.memory.js";
import type { Observation } from "./improve/types.js";
import { DAY, FixedClock } from "./kernel/clock.js";
import { loadConfig, type Config } from "./kernel/config.js";
import { DeniedError, InvariantError } from "./kernel/errors.js";
import { SeededIdGenerator, type Id } from "./kernel/ids.js";
import type { ActorRef } from "./record/types.js";
import { MemoryDb } from "./store/db.js";
import { MaintenanceLoop } from "./maintenance.js";
import { buildPlatform } from "./platform.js";
import {
  IMPROVEMENT_OBSERVATION_DAYS,
  RetentionPurgeJob,
  buildRetentionRules,
  type RetentionRule,
} from "./retention.js";

/**
 * Retention, as a behaviour rather than as a paragraph.
 *
 * The document these tests hold the code to is `retention-and-deletion.md`,
 * which claimed three properties for a job that did not exist. Each of those
 * three has a case here, and so does the fourth that the document originally
 * got wrong in the other direction — it described pruning the audit chain,
 * which is the one thing this job must never do.
 */

const NOW = "2026-08-07T09:00:00.000Z";
const JAY: ActorRef = { actorId: "act_jay", kind: "human", roles: ["owner_services_agent"] };

interface Harness {
  readonly clock: FixedClock;
  readonly config: Config;
  readonly audit: AuditLog;
  readonly auditStore: MemoryAuditStore;
  readonly observations: MemoryObservationStore;
  readonly discovery: DiscoveryCollector;
  readonly discoveryStore: MemoryDiscoveryStore;
  readonly enrollment: EnrollmentService;
  job(options?: { batchLimit?: number; audit?: AuditLog }): RetentionPurgeJob;
}

function harness(
  env: Record<string, string> = {},
  options: { discoveryEnabled?: boolean } = {},
): Harness {
  const db = new MemoryDb();
  const clock = new FixedClock(NOW);
  const ids = new SeededIdGenerator("retention-test");
  const auditStore = new MemoryAuditStore(db);
  const audit = new AuditLog(auditStore, clock, ids);
  const config = loadConfig({ PV_ENV: "development", ...env });

  const observations = new MemoryObservationStore(db);
  const discoveryStore = new MemoryDiscoveryStore(db);
  const settings = discoverySettings({
    discoveryEnabled: options.discoveryEnabled ?? true,
    discoveryRetentionDays: config.discoveryRetentionDays,
  });
  const discovery = new DiscoveryCollector(discoveryStore, clock, ids, settings);
  const enrollment = new EnrollmentService(discoveryStore, clock, audit, settings);

  return {
    clock,
    config,
    audit,
    auditStore,
    observations,
    discovery,
    discoveryStore,
    enrollment,
    job: (jobOptions = {}) =>
      new RetentionPurgeJob(
        buildRetentionRules({ config, clock, observations, discovery }),
        jobOptions.audit ?? audit,
        clock,
        jobOptions.batchLimit === undefined ? {} : { batchLimit: jobOptions.batchLimit },
      ),
  };
}

let counter = 0;

function anObservation(recordedAt: string): Observation {
  counter += 1;
  return {
    id: `obs_${counter}` as Id<"observation">,
    kind: "human_correction",
    runId: "run_1" as Id<"run">,
    signature: "deadline.wrong_jurisdiction",
    note: "The deadline used the wrong state.",
    observedBy: JAY,
    recordedAt,
    correctionMinutes: 4,
    costUsd: 0.1,
    subject: { contractId: "ctr_1" },
    idempotencyKey: `key_${counter}`,
  };
}

/** `n` observations, all recorded far enough back to be past their period. */
async function seedExpired(h: Harness, n: number): Promise<void> {
  const base = Date.parse(NOW) - (IMPROVEMENT_OBSERVATION_DAYS + 30) * DAY;
  for (let i = 0; i < n; i += 1) {
    await h.observations.appendObservation(anObservation(new Date(base + i * 1000).toISOString()));
  }
}

describe("the retention purge job", () => {
  it("deletes what is past its period and records one entry per rule that acted", async () => {
    const h = harness();
    await seedExpired(h, 3);
    await h.observations.appendObservation(anObservation(NOW));

    const report = await h.job().run();

    expect(report.purged).toBe(3);
    expect(await h.observations.countObservations()).toBe(1);

    const entries = await h.audit.list({ eventType: ["retention.purged"] });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.subject["rule"]).toBe("improvement.observations");
    expect(entry?.subject["category"]).toBe("D10");
    expect(entry?.decision["rowsDue"]).toBe(3);
    expect(entry?.decision["periodDays"]).toBe(IMPROVEMENT_OBSERVATION_DAYS);
    expect(entry?.decision["basis"]).toBe("recordedAt");
    // The purge writes to the chain; it must not break it.
    expect(verifyChain(await h.audit.readChain()).intact).toBe(true);
  });

  it("is idempotent — a second run deletes nothing and writes nothing", async () => {
    const h = harness();
    await seedExpired(h, 2);

    await h.job().run();
    const afterFirst = (await h.audit.readChain()).length;

    const second = await h.job().run();
    expect(second.purged).toBe(0);
    expect(second.results.every((result) => result.error === undefined)).toBe(true);
    // No "nothing was due" entry. Once a minute, per rule, forever, would bury
    // the entries that record an actual deletion under a decade of noise.
    expect((await h.audit.readChain()).length).toBe(afterFirst);
  });

  it("is bounded — a batch cap leaves the remainder for the next run", async () => {
    const h = harness();
    await seedExpired(h, 5);

    const first = await h.job({ batchLimit: 2 }).run();
    expect(first.purged).toBe(2);
    expect(await h.observations.countObservations()).toBe(3);

    // The oldest go first, so repeated capped runs converge rather than circle.
    const remaining = await h.observations.listObservations();
    expect(remaining.map((row) => row.id)).not.toContain("obs_1");

    await h.job({ batchLimit: 2 }).run();
    await h.job({ batchLimit: 2 }).run();
    expect(await h.observations.countObservations()).toBe(0);
  });

  it("fails closed — a purge that cannot be recorded does not delete", async () => {
    const h = harness();
    await seedExpired(h, 3);

    const refusing = new AuditLog(refusingStore(), h.clock, new SeededIdGenerator("refusing"));
    const report = await h.job({ audit: refusing }).run();

    expect(report.purged).toBe(0);
    expect(report.results[0]?.error).toContain("audit store is unavailable");
    // Deleting without a record of the deletion is the outcome the chain exists
    // to prevent, so the rows are still there.
    expect(await h.observations.countObservations()).toBe(3);
  });

  it("keeps running the other rules when one fails", async () => {
    const h = harness();
    await seedExpired(h, 1);

    const rules = buildRetentionRules({
      config: h.config,
      clock: h.clock,
      observations: h.observations,
      discovery: h.discovery,
    });
    const broken: RetentionRule = {
      ...rules[0]!,
      name: "broken.rule",
      countDue: () => Promise.reject(new Error("table unreachable")),
    };
    const job = new RetentionPurgeJob([broken, ...rules], h.audit, h.clock);

    const report = await job.run();
    expect(report.results[0]?.error).toBe("table unreachable");
    expect(report.purged).toBe(1);
  });

  it("surfaces a failed rule to the maintenance loop rather than reporting a count", async () => {
    // The job collects rule failures instead of throwing on the first, which
    // would make a failed rule invisible to the loop: the pass would report a
    // count and look healthy while a retention period went unenforced.
    const platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(NOW),
      ids: new SeededIdGenerator("retention-failure"),
    });
    try {
      const broken = {
        run: () =>
          Promise.resolve({
            ranAt: NOW,
            purged: 3,
            results: [
              { rule: "improvement.observations", cutoff: NOW, due: 0, purged: 0, error: "boom" },
            ],
          }),
      };
      const loop = new MaintenanceLoop(
        { ...platform, retention: broken as unknown as typeof platform.retention },
        platform.logger,
        platform.clock,
      );
      const report = await loop.runOnce();
      const pass = report.results.find((result) => result.name === "retention.purge");
      expect(pass?.error).toContain("improvement.observations: boom");
      expect(pass?.affected).toBe(0);
    } finally {
      await platform.close();
    }
  });
});

describe("the audit chain is never a retention target", () => {
  it("refuses to construct a job with a rule that targets the chain", () => {
    const h = harness();
    const rule: RetentionRule = {
      name: "audit.entries",
      category: "D2",
      periodDays: 2555,
      basis: "recordedAt",
      cutoff: () => NOW,
      countDue: async () => 0,
      purge: async () => 0,
    };
    expect(() => new RetentionPurgeJob([rule], h.audit, h.clock)).toThrow(InvariantError);
  });

  it("leaves the chain longer than it found it, never shorter", async () => {
    const h = harness();
    await seedExpired(h, 4);
    const before = await h.audit.readChain();

    await h.job().run();

    const after = await h.audit.readChain();
    expect(after.length).toBeGreaterThan(before.length);
    // Every entry that was there is still there, unchanged and in place. A
    // purge that trimmed a prefix would pass a naive length check and fail this
    // one.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(verifyChain(after).intact).toBe(true);
  });

  it("offers no deletion operation on the audit store to reach for", () => {
    const store: AuditStore = new MemoryAuditStore(new MemoryDb());
    const operations = new Set<string>();
    let proto: object | null = Object.getPrototypeOf(store);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) operations.add(name);
      proto = Object.getPrototypeOf(proto);
    }
    const destructive = [...operations].filter((name) =>
      /delete|purge|prune|truncate|remove|drop/i.test(name),
    );
    expect(
      destructive,
      "An audit store with a deletion operation is one careless caller away from a chain with a hole in it.",
    ).toEqual([]);
  });
});

describe("PV_AUDIT_RETENTION_DAYS", () => {
  it("shortens every rule rather than only naming the chain", async () => {
    // The knob was loaded, documented in `.env.example`, and read by nothing.
    // It is the deployment's overall retention period, so shortening it
    // shortens the rules measured against it.
    const h = harness({ PV_AUDIT_RETENTION_DAYS: "30" });
    const periods = new Map(h.job().describe().map((rule) => [rule.name, rule.periodDays]));
    expect(periods.get("improvement.observations")).toBe(30);

    // An observation ninety days old survives the two-year default and does not
    // survive a thirty-day deployment period.
    const ninetyDaysAgo = new Date(Date.parse(NOW) - 90 * DAY).toISOString();
    await h.observations.appendObservation(anObservation(ninetyDaysAgo));
    expect((await h.job().run()).purged).toBe(1);

    const relaxed = harness();
    await relaxed.observations.appendObservation(anObservation(ninetyDaysAgo));
    expect((await relaxed.job().run()).purged).toBe(0);
  });

  it("can only shorten a rule, never lengthen one", () => {
    const h = harness({ PV_AUDIT_RETENTION_DAYS: "3650", PV_DISCOVERY_RETENTION_DAYS: "7" });
    const periods = new Map(h.job().describe().map((rule) => [rule.name, rule.periodDays]));
    expect(periods.get("discovery.observations")).toBe(7);
    expect(periods.get("improvement.observations")).toBe(IMPROVEMENT_OBSERVATION_DAYS);
  });
});

describe("work-discovery observations", () => {
  /**
   * The thirty-day ceiling is asserted to MVW in two assurance documents, is
   * checked at configuration load, clamped again at purge time, and enforced by
   * a CHECK constraint — and until this rule existed, by nothing that ran.
   */
  it("are purged even though the feature ships disabled", async () => {
    const h = harness({ PV_DISCOVERY_RETENTION_DAYS: "7" }, { discoveryEnabled: true });
    await h.enrollment.enroll(JAY, {
      subjectRef: "sub_jay",
      deviceRef: "dev_laptop_1",
      applicationAllowlist: ["ticketing", "spreadsheet"],
      noticeReference: "notice_2026_08_v1",
      noticeAcknowledgedAt: NOW,
    });
    const session = await h.discovery.start(JAY, "sub_jay", "dev_laptop_1");
    await h.discovery.observe(JAY, session.id, {
      subjectRef: "sub_jay",
      deviceRef: "dev_laptop_1",
      fromApplication: "ticketing",
      toApplication: "spreadsheet",
      observedAt: NOW,
      dwellMs: 60_000,
    });
    expect(await h.discoveryStore.countObservations({})).toBe(1);

    // Eight days later, with the feature switched off in the meantime. The rows
    // left behind by a deployment that stopped observing are exactly the rows
    // that most need deleting, so the purge must not be gated on the flag.
    h.clock.advance(8 * DAY);
    const disabled = new DiscoveryCollector(
      h.discoveryStore,
      h.clock,
      new SeededIdGenerator("disabled"),
      { enabled: false, retentionDays: 7 },
    );
    const job = new RetentionPurgeJob(
      buildRetentionRules({
        config: h.config,
        clock: h.clock,
        observations: h.observations,
        discovery: disabled,
      }),
      h.audit,
      h.clock,
    );

    const report = await job.run();
    expect(report.purged).toBe(1);
    expect(await h.discoveryStore.countObservations({})).toBe(0);

    const entries = await h.audit.list({ eventType: ["retention.purged"] });
    expect(entries.map((entry) => entry.subject["rule"])).toContain("discovery.observations");
  });
});

describe("the maintenance loop", () => {
  it("runs the retention pass, and does not run it while the platform is paused", async () => {
    const platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(NOW),
      ids: new SeededIdGenerator("retention-loop"),
    });
    try {
      const loop = new MaintenanceLoop(platform, platform.logger, platform.clock);
      expect(loop.describe()).toContain("retention.purge");

      await platform.containment.engage(
        "global",
        "",
        "act_admin",
        "Retention pass containment check.",
      );

      const report = await loop.runOnce();
      const pass = report.results.find((result) => result.name === "retention.purge");
      // Deletion is the one maintenance action that cannot be undone once the
      // incident turns out to be the reason the data was needed.
      expect(pass?.skipped).toBe(true);
    } finally {
      await platform.close();
    }
  });
});

/** An audit store that refuses every append, for the fail-closed case. */
function refusingStore(): AuditStore {
  const unavailable = (): never => {
    throw new DeniedError("record.unavailable", "The audit store is unavailable.", {});
  };
  return {
    appendEntry: (_content: NewAuditEntry, _build: (c: NewAuditEntry, p: ChainPosition) => AuditEntry) =>
      unavailable(),
    listAuditEntries: async () => [],
    countAuditEntries: async () => 0,
    readAuditChain: async () => [],
    auditHead: async () => null,
    auditWatermark: async () => null,
  };
}
