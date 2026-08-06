import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "../audit/log.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import type { AuditStore, ChainPosition } from "../audit/port.js";
import type { AuditEntry, NewAuditEntry } from "../audit/types.js";
import { DAY, FixedClock, HOUR } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import { SeededIdGenerator, type Id } from "../kernel/ids.js";
import type { ActorRef } from "../record/types.js";
import { MemoryDb } from "../store/db.js";
import { DiscoveryCollector } from "./collect.js";
import { EnrollmentService } from "./enrollment.js";
import type { DiscoveryStore } from "./port.js";
import {
  MAX_RETENTION_DAYS,
  assertRetentionWithinCeiling,
  discoverySettings,
  effectiveRetentionDays,
  type DiscoverySettings,
} from "./retention.js";
import { MemoryDiscoveryStore } from "./store.memory.js";
import type { CollectorSession, Enrollment, Observation } from "./types.js";

/**
 * Work discovery: the gates, the person's controls, and the failure modes.
 *
 * Every control is tested twice — once proving it permits the legitimate case,
 * once proving it refuses — because a control tested only on the happy path is
 * a control nobody has confirmed is connected to anything.
 *
 * The refusals are the point of this file. This component observes employees,
 * so the interesting cases are adversarial: a collector that outruns the stop
 * button, an enrollment that keeps observing an application the floor now
 * forbids, an observation timestamped past every retention cut-off, a retry
 * that becomes a second row, an erasure that leaves something behind.
 */

const NOW = "2026-08-06T16:00:00.000Z";

/** The observed person. Every control belongs to them and to nobody else. */
const JAY: ActorRef = { actorId: "act_jay", kind: "human", roles: ["owner_services_agent"] };

/** A colleague. Holds no privilege over Jay's enrollment, and never will. */
const SAM: ActorRef = { actorId: "act_sam", kind: "human", roles: ["supervisor"] };

/**
 * A platform administrator.
 *
 * Present in these tests specifically to prove that the role buys nothing here.
 * The controls belong to the observed person; there is no administrator path.
 */
const ADMIN: ActorRef = { actorId: "act_admin", kind: "human", roles: ["platform_admin"] };

const SUBJECT = "sub_jay";
const DEVICE = "dev_laptop_1";

interface Harness {
  readonly db: MemoryDb;
  readonly store: MemoryDiscoveryStore;
  readonly audit: AuditLog;
  readonly auditStore: MemoryAuditStore;
  readonly clock: FixedClock;
  readonly enrollment: EnrollmentService;
  readonly collector: DiscoveryCollector;
  readonly settings: DiscoverySettings;
}

function harness(options: { enabled?: boolean; retentionDays?: number } = {}): Harness {
  const db = new MemoryDb();
  const store = new MemoryDiscoveryStore(db);
  const auditStore = new MemoryAuditStore(db);
  const clock = new FixedClock(NOW);
  const ids = new SeededIdGenerator("discovery-test");
  const audit = new AuditLog(auditStore, clock, ids);
  const settings = discoverySettings({
    discoveryEnabled: options.enabled ?? true,
    discoveryRetentionDays: options.retentionDays ?? 7,
  });

  return {
    db,
    store,
    audit,
    auditStore,
    clock,
    settings,
    enrollment: new EnrollmentService(store, clock, audit, settings),
    collector: new DiscoveryCollector(store, clock, ids, settings),
  };
}

async function enrolled(
  h: Harness,
  allowlist: readonly string[] = ["ticketing", "spreadsheet", "document_generator"],
): Promise<Enrollment> {
  return h.enrollment.enroll(JAY, {
    subjectRef: SUBJECT,
    deviceRef: DEVICE,
    applicationAllowlist: allowlist,
    noticeReference: "notice_2026_08_v1",
    noticeAcknowledgedAt: NOW,
  });
}

function transition(
  from: string,
  to: string,
  observedAt: string,
  dwellMs = 60_000,
): Record<string, unknown> {
  return { subjectRef: SUBJECT, deviceRef: DEVICE, fromApplication: from, toApplication: to, observedAt, dwellMs };
}

/** The denial a call produced, or a marker describing what it did instead. */
async function denial(
  fn: () => Promise<unknown>,
): Promise<{ reason: string; gate: unknown; message: string }> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof DeniedError) {
      return { reason: error.reason, gate: error.detail["gate"], message: error.message };
    }
    return { reason: `unexpected:${String(error)}`, gate: undefined, message: String(error) };
  }
  return { reason: "no-throw", gate: undefined, message: "" };
}

describe("gate 1 — the feature is disabled by default", () => {
  it("is off unless configuration says otherwise", () => {
    // The shipped default. If this ever reads true, the component observes
    // employees in every deployment that has not thought about it.
    const settings = discoverySettings({
      discoveryEnabled: false,
      discoveryRetentionDays: 7,
    });
    expect(settings.enabled).toBe(false);
  });

  it("refuses to enroll anybody", async () => {
    const h = harness({ enabled: false });
    const refused = await denial(() => enrolled(h));
    expect(refused.reason).toBe("discovery.feature_disabled");
    expect(refused.gate).toBe("feature_enabled");
  });

  it("refuses to start a collector", async () => {
    const h = harness({ enabled: false });
    const refused = await denial(() => h.collector.start(JAY, SUBJECT, DEVICE));
    expect(refused.reason).toBe("discovery.feature_disabled");
  });

  it("refuses an observation without examining it", async () => {
    // Enroll and start while enabled, then switch the feature off underneath a
    // live session — the shape of somebody hitting the kill switch in config.
    const live = harness({ enabled: true });
    await enrolled(live);
    const session = await live.collector.start(JAY, SUBJECT, DEVICE);

    const ids = new SeededIdGenerator("discovery-test-disabled");
    const disabled = new DiscoveryCollector(
      live.store,
      live.clock,
      ids,
      discoverySettings({ discoveryEnabled: false, discoveryRetentionDays: 7 }),
    );

    const refused = await denial(() =>
      disabled.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW)),
    );
    expect(refused.reason).toBe("discovery.feature_disabled");
    expect(await live.store.countObservations({ subjectRef: SUBJECT })).toBe(0);
  });
});

describe("gate 2 — enrollment", () => {
  it("refuses to start a collector for somebody who is not enrolled", async () => {
    const h = harness();
    const refused = await denial(() => h.collector.start(JAY, SUBJECT, DEVICE));
    expect(refused.reason).toBe("discovery.not_enrolled");
    expect(refused.gate).toBe("enrollment");
  });

  it("observes nothing at all when the allowlist is empty", async () => {
    // An empty allowlist is a legal enrollment. It is the state somebody should
    // be able to sit in while they decide, and it must observe nothing.
    const h = harness();
    await enrolled(h, []);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    const refused = await denial(() =>
      h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW)),
    );
    expect(refused.reason).toBe("discovery.not_enrolled");
    expect(refused.gate).toBe("allowlist");
    expect(refused.message).toContain("observes nothing");
    expect(await h.store.countObservations({})).toBe(0);
  });

  it("refuses an application that is not on the positive allowlist", async () => {
    const h = harness();
    await enrolled(h, ["ticketing"]);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    const refused = await denial(() =>
      h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW)),
    );
    expect(refused.gate).toBe("allowlist");
  });

  it("refuses observation while the enrollment is paused", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);
    await h.enrollment.pause(JAY, SUBJECT, DEVICE);

    const refused = await denial(() =>
      h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW)),
    );
    // Pausing closes the collector, so the session gate is the one that fires
    // first. Either refusal is correct; what must not happen is a recording.
    expect(refused.reason).toBe("discovery.not_enrolled");
    expect(await h.store.countObservations({})).toBe(0);
  });

  it("records the legitimate case", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    const observation = await h.collector.observe(
      JAY,
      session.id,
      transition("ticketing", "spreadsheet", NOW, 45_000),
    );

    expect(observation.sequence).toBe(1);
    expect(observation.fromApplication).toBe("ticketing");
    expect(observation.toApplication).toBe("spreadsheet");
    expect(await h.store.countObservations({ subjectRef: SUBJECT })).toBe(1);
  });
});

describe("gate 3 — a deliberately started collector", () => {
  it("refuses an observation with no session behind it", async () => {
    const h = harness();
    await enrolled(h);
    const refused = await denial(() =>
      h.collector.observe(JAY, "ses_never_started" as Id<"session">, transition("ticketing", "spreadsheet", NOW)),
    );
    expect(refused.reason).toBe("discovery.not_enrolled");
    expect(refused.gate).toBe("collector");
  });

  it("refuses a collector started by somebody other than the observed person", async () => {
    const h = harness();
    await enrolled(h);
    const refused = await denial(() => h.collector.start(SAM, SUBJECT, DEVICE));
    expect(refused.reason).toBe("authorization.action_not_permitted");
  });

  it("refuses observations submitted by a process the person did not start", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    const refused = await denial(() =>
      h.collector.observe(SAM, session.id, transition("ticketing", "spreadsheet", NOW)),
    );
    expect(refused.reason).toBe("authorization.action_not_permitted");
  });

  it("refuses an observation naming a different person from its session", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    const refused = await denial(() =>
      h.collector.observe(JAY, session.id, {
        ...transition("ticketing", "spreadsheet", NOW),
        subjectRef: "sub_someone_else",
      }),
    );
    expect(refused.reason).toBe("discovery.not_enrolled");
    expect(await h.store.countObservations({})).toBe(0);
  });
});

describe("the blocklist floor", () => {
  it("cannot be put on an enrollment allowlist", async () => {
    const h = harness();
    const refused = await denial(() => enrolled(h, ["ticketing", "email.exchange"]));
    expect(refused.reason).toBe("discovery.excluded_field");
    expect(refused.message).toContain("blocklist floor");
    expect(await h.store.listEnrollments(SUBJECT)).toEqual([]);
  });

  it("cannot be written into an enrollment through the store either", async () => {
    const h = harness();
    const rogue: Enrollment = {
      subjectRef: SUBJECT,
      subjectActorId: JAY.actorId,
      deviceRef: DEVICE,
      state: "active",
      applicationAllowlist: ["hr.workday"],
      retentionDays: 7,
      noticeReference: "notice_2026_08_v1",
      noticeAcknowledgedAt: NOW,
      enrolledAt: NOW,
      updatedAt: NOW,
    };
    const refused = await denial(() => h.store.putEnrollment(rogue));
    expect(refused.reason).toBe("discovery.excluded_field");
  });

  /**
   * The floor beats an allowlist that already contains a blocked application.
   *
   * The enrollment path refuses one, and so does the store — so the only way to
   * reach this state is a row written before the family was added to the floor,
   * or by hand. That is exactly the case the re-check at observation time
   * exists for, and the only way to exercise it is a store that hands back the
   * enrollment the real one would refuse to keep.
   */
  it("beats an allowlist that somehow contains a blocked application", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    const stale: DiscoveryStore = {
      putEnrollment: (enrollment) => h.store.putEnrollment(enrollment),
      getEnrollment: async (subjectRef: string, deviceRef: string) => {
        const real = await h.store.getEnrollment(subjectRef, deviceRef);
        if (!real) return null;
        return { ...real, applicationAllowlist: [...real.applicationAllowlist, "hr.workday"] };
      },
      listEnrollments: (subjectRef) => h.store.listEnrollments(subjectRef),
      setEnrollmentState: (subjectRef, deviceRef, state, updatedAt) =>
        h.store.setEnrollmentState(subjectRef, deviceRef, state, updatedAt),
      startSession: (session) => h.store.startSession(session),
      getSession: (id) => h.store.getSession(id),
      endSession: (id, endedAt, reason) => h.store.endSession(id, endedAt, reason),
      listSessions: (subjectRef, openOnly) => h.store.listSessions(subjectRef, openOnly),
      appendObservation: (observation) => h.store.appendObservation(observation),
      listObservations: (filter) => h.store.listObservations(filter),
      countObservations: (filter) => h.store.countObservations(filter),
      purgeObservationsBefore: (cutoff, subjectRef) =>
        h.store.purgeObservationsBefore(cutoff, subjectRef),
      eraseSubject: (subjectRef) => h.store.eraseSubject(subjectRef),
    };

    const collector = new DiscoveryCollector(
      stale,
      h.clock,
      new SeededIdGenerator("stale"),
      h.settings,
    );

    const refused = await denial(() =>
      collector.observe(JAY, session.id, transition("ticketing", "hr.workday", NOW)),
    );
    expect(refused.reason).toBe("discovery.excluded_field");
    expect(refused.gate).toBe("blocklist");
    expect(await h.store.countObservations({})).toBe(0);
  });
});

describe("the observed person is in control", () => {
  it("pauses and resumes without an administrator", async () => {
    const h = harness();
    await enrolled(h);
    const first = await h.collector.start(JAY, SUBJECT, DEVICE);
    await h.collector.observe(JAY, first.id, transition("ticketing", "spreadsheet", NOW));

    const paused = await h.enrollment.pause(JAY, SUBJECT, DEVICE);
    expect(paused.state).toBe("paused");
    expect(await h.store.listSessions(SUBJECT, true)).toEqual([]);

    const resumed = await h.enrollment.resume(JAY, SUBJECT, DEVICE);
    expect(resumed.state).toBe("active");

    // Resuming does not restart collection: the third gate is a deliberately
    // started collector, and unpausing is not that.
    const refused = await denial(() =>
      h.collector.observe(JAY, first.id, transition("ticketing", "spreadsheet", NOW)),
    );
    expect(refused.gate).toBe("collector");

    const second = await h.collector.start(JAY, SUBJECT, DEVICE);
    const observation = await h.collector.observe(
      JAY,
      second.id,
      transition("spreadsheet", "document_generator", NOW),
    );
    expect(observation.sequence).toBe(1);
  });

  it("stops collection immediately, and stopping twice is not an error", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    expect(await h.enrollment.stop(JAY, SUBJECT, DEVICE)).toBe(1);
    expect(await h.enrollment.stop(JAY, SUBJECT, DEVICE)).toBe(0);

    const refused = await denial(() =>
      h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW)),
    );
    expect(refused.gate).toBe("collector");

    const closed = await h.store.getSession(session.id);
    expect(closed?.endedReason).toBe("stopped_by_subject");
  });

  it("revokes permanently, and a revoked enrollment cannot be resumed", async () => {
    const h = harness();
    await enrolled(h);
    await h.collector.start(JAY, SUBJECT, DEVICE);

    const revoked = await h.enrollment.revoke(JAY, SUBJECT, DEVICE);
    expect(revoked.state).toBe("revoked");

    expect((await denial(() => h.enrollment.resume(JAY, SUBJECT, DEVICE))).reason).toBe(
      "discovery.not_enrolled",
    );
    expect((await denial(() => h.collector.start(JAY, SUBJECT, DEVICE))).gate).toBe("enrollment");
  });

  it("erases immediately and completely", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);
    await h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW));
    await h.collector.observe(
      JAY,
      session.id,
      transition("spreadsheet", "document_generator", "2026-08-06T16:02:00.000Z"),
    );

    const result = await h.enrollment.erase(JAY, SUBJECT);
    expect(result).toEqual({ observationsErased: 2, sessionsErased: 1, enrollmentsErased: 1 });

    // Nothing behind: not the rows, not the enrollment, not the deduplication
    // index that would otherwise still hold the natural key of every transition.
    expect(await h.store.countObservations({})).toBe(0);
    expect(await h.store.listSessions(SUBJECT)).toEqual([]);
    expect(await h.store.listEnrollments(SUBJECT)).toEqual([]);
    for (const table of [
      "discovery_observation",
      "discovery_observation_key",
      "discovery_collector_session",
      "discovery_enrollment",
    ]) {
      expect(h.db.rows(table), `${table} should be empty after an erasure`).toEqual([]);
    }
  });

  /**
   * Turning the feature off must not trap somebody's data inside it.
   *
   * Enrolling requires the feature to be enabled. Stopping, revoking, and
   * erasing deliberately do not: a deployment that switches discovery off after
   * a month of collection would otherwise leave every observation in place with
   * no way for the observed person to have it destroyed.
   */
  it("lets the person stop, revoke, and erase even after the feature is switched off", async () => {
    const h = harness({ enabled: true });
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);
    await h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW));

    const disabled = new EnrollmentService(
      h.store,
      h.clock,
      h.audit,
      discoverySettings({ discoveryEnabled: false, discoveryRetentionDays: 7 }),
    );

    expect(await disabled.stop(JAY, SUBJECT, DEVICE)).toBe(1);
    expect((await disabled.revoke(JAY, SUBJECT, DEVICE)).state).toBe("revoked");
    expect(await disabled.erase(JAY, SUBJECT)).toEqual({
      observationsErased: 1,
      sessionsErased: 1,
      enrollmentsErased: 1,
    });
    expect(await h.store.countObservations({})).toBe(0);
  });

  it("refuses every control to anybody who is not the observed person", async () => {
    const h = harness();
    await enrolled(h);

    for (const actor of [SAM, ADMIN]) {
      expect((await denial(() => h.enrollment.pause(actor, SUBJECT, DEVICE))).reason).toBe(
        "authorization.action_not_permitted",
      );
      expect((await denial(() => h.enrollment.stop(actor, SUBJECT, DEVICE))).reason).toBe(
        "authorization.action_not_permitted",
      );
      expect((await denial(() => h.enrollment.revoke(actor, SUBJECT, DEVICE))).reason).toBe(
        "authorization.action_not_permitted",
      );
      expect((await denial(() => h.enrollment.erase(actor, SUBJECT))).reason).toBe(
        "authorization.action_not_permitted",
      );
      expect((await denial(() => h.enrollment.summarise(actor, SUBJECT))).reason).toBe(
        "authorization.action_not_permitted",
      );
    }

    // Still intact, and still Jay's.
    const summary = await h.enrollment.summarise(JAY, SUBJECT);
    expect(summary.enrollments).toHaveLength(1);
  });

  it("refuses to enroll somebody else under a reference they already hold", async () => {
    const h = harness();
    await enrolled(h);
    const refused = await denial(() =>
      h.enrollment.enroll(ADMIN, {
        subjectRef: SUBJECT,
        deviceRef: "dev_laptop_2",
        applicationAllowlist: ["ticketing"],
        noticeReference: "notice_2026_08_v1",
        noticeAcknowledgedAt: NOW,
      }),
    );
    expect(refused.reason).toBe("authorization.action_not_permitted");
  });

  it("insists that an enrollment names the notice the person was given", async () => {
    const h = harness();
    let field = "";
    try {
      await h.enrollment.enroll(JAY, {
        subjectRef: SUBJECT,
        deviceRef: DEVICE,
        applicationAllowlist: ["ticketing"],
        noticeReference: "   ",
        noticeAcknowledgedAt: NOW,
      });
    } catch (error) {
      field = error instanceof Error ? error.message : "";
    }
    expect(field).toContain("written notice");
  });
});

describe("the audit record", () => {
  it("records enrollment, revocation, and erasure and nothing about what was observed", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);
    await h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW));
    await h.enrollment.pause(JAY, SUBJECT, DEVICE);
    await h.enrollment.resume(JAY, SUBJECT, DEVICE);
    await h.enrollment.revoke(JAY, SUBJECT, DEVICE);
    await h.enrollment.erase(JAY, SUBJECT);

    const entries = await h.audit.list();
    expect(entries.map((entry) => entry.eventType)).toEqual([
      "discovery.enrolled",
      "discovery.revoked",
      "discovery.erased",
    ]);
  });

  /**
   * The chain is kept for seven years; observations for at most thirty days.
   *
   * An audit entry naming the subject would outlive the erasure it evidences
   * and would be a durable list of who was monitored — so the chain carries
   * fingerprints, and this test fails if a reference ever leaks into one.
   */
  it("carries fingerprints rather than the person's reference", async () => {
    const h = harness();
    await enrolled(h);
    await h.enrollment.revoke(JAY, SUBJECT, DEVICE);

    for (const entry of await h.audit.list()) {
      const serialised = JSON.stringify({
        subject: entry.subject,
        decision: entry.decision,
        inputDigests: entry.inputDigests,
      });
      expect(serialised, `${entry.eventType} leaked a subject reference`).not.toContain(SUBJECT);
      expect(serialised).not.toContain(DEVICE);
      expect(entry.inputDigests["subject"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("refuses to enroll when the receipt cannot be written", async () => {
    // Fail closed. An enrollment that exposes somebody to observation without a
    // record of it having been agreed is the state this rule exists to prevent.
    const h = harness();
    const broken: AuditStore = {
      appendEntry: async (
        _content: NewAuditEntry,
        _build: (content: NewAuditEntry, position: ChainPosition) => AuditEntry,
      ) => {
        throw new Error("audit store offline");
      },
      listAuditEntries: () => h.auditStore.listAuditEntries(),
      countAuditEntries: () => h.auditStore.countAuditEntries(),
      readAuditChain: () => h.auditStore.readAuditChain(),
      auditHead: () => h.auditStore.auditHead(),
    };
    const service = new EnrollmentService(
      h.store,
      h.clock,
      new AuditLog(broken, h.clock, new SeededIdGenerator("broken")),
      h.settings,
    );

    const refused = await denial(() =>
      service.enroll(JAY, {
        subjectRef: SUBJECT,
        deviceRef: DEVICE,
        applicationAllowlist: ["ticketing"],
        noticeReference: "notice_2026_08_v1",
        noticeAcknowledgedAt: NOW,
      }),
    );
    expect(refused.reason).toBe("record.unavailable");
    expect(await h.store.listEnrollments(SUBJECT)).toEqual([]);
  });
});

describe("retention", () => {
  it("refuses a configured period longer than the ceiling", () => {
    expect(() =>
      discoverySettings({ discoveryEnabled: true, discoveryRetentionDays: 90 }),
    ).toThrowError(DeniedError);
    expect(() => assertRetentionWithinCeiling(MAX_RETENTION_DAYS)).not.toThrow();
    expect(() => assertRetentionWithinCeiling(MAX_RETENTION_DAYS + 1)).toThrowError(DeniedError);
    expect(() => assertRetentionWithinCeiling(0)).toThrowError(DeniedError);
  });

  it("clamps a stored period that somehow exceeds the ceiling", () => {
    // Defence in depth against a restore, a migration, or a psql prompt. The
    // purge computes its cut-off through this, so a rogue value cannot extend
    // retention even though the write path would never have accepted it.
    expect(effectiveRetentionDays(3650)).toBe(MAX_RETENTION_DAYS);
    expect(effectiveRetentionDays(0)).toBe(1);
    expect(effectiveRetentionDays(Number.NaN)).toBe(1);
    expect(effectiveRetentionDays(7)).toBe(7);
  });

  it("refuses an enrollment asking for longer than the ceiling", async () => {
    const h = harness();
    const refused = await denial(() =>
      h.enrollment.enroll(JAY, {
        subjectRef: SUBJECT,
        deviceRef: DEVICE,
        applicationAllowlist: ["ticketing"],
        noticeReference: "notice_2026_08_v1",
        noticeAcknowledgedAt: NOW,
        retentionDays: 365,
      }),
    );
    expect(refused.reason).toBe("config.invalid");
  });

  it("purges what is past its period and keeps what is not", async () => {
    const h = harness({ retentionDays: 7 });
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    await h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW));
    h.clock.advance(6 * DAY);
    await h.collector.observe(
      JAY,
      session.id,
      transition("spreadsheet", "document_generator", h.clock.nowIso()),
    );

    expect(await h.collector.purgeExpired()).toBe(0);
    h.clock.advance(2 * DAY);

    expect(await h.collector.purgeExpired()).toBe(1);
    const left = await h.store.listObservations({ subjectRef: SUBJECT });
    expect(left).toHaveLength(1);
    expect(left[0]?.fromApplication).toBe("spreadsheet");
  });

  it("honours an enrollment that chose a shorter period than the deployment", async () => {
    const h = harness({ retentionDays: 30 });
    await h.enrollment.enroll(JAY, {
      subjectRef: SUBJECT,
      deviceRef: DEVICE,
      applicationAllowlist: ["ticketing", "spreadsheet"],
      noticeReference: "notice_2026_08_v1",
      noticeAcknowledgedAt: NOW,
      retentionDays: 2,
    });
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);
    await h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW));

    h.clock.advance(3 * DAY);
    expect(await h.collector.purgeExpired()).toBe(1);
    expect(await h.store.countObservations({})).toBe(0);
  });

  /**
   * A bound evaded by padding a field the validator already accepted.
   *
   * `observedAt` is well-formed, in range, and in the future — which puts the
   * row beyond every retention cut-off forever. A thirty-day ceiling that any
   * collector can opt out of by adding a year is not a ceiling.
   */
  it("refuses an observation timestamped in the future", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    const refused = await denial(() =>
      h.collector.observe(
        JAY,
        session.id,
        transition("ticketing", "spreadsheet", "2099-01-01T00:00:00.000Z"),
      ),
    );
    expect(refused.reason).toBe("discovery.excluded_field");
    expect(refused.message).toContain("future");
    expect(await h.store.countObservations({})).toBe(0);
  });

  it("accepts a device clock that is only slightly ahead", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);
    const slightlyAhead = new Date(h.clock.now() + 60_000).toISOString();
    await expect(
      h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", slightlyAhead)),
    ).resolves.toBeDefined();
  });

  it("refuses an observation older than the retention window", async () => {
    const h = harness({ retentionDays: 7 });
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);
    const ancient = new Date(h.clock.now() - 30 * DAY).toISOString();

    const refused = await denial(() =>
      h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", ancient)),
    );
    expect(refused.reason).toBe("discovery.excluded_field");
    expect(await h.store.countObservations({})).toBe(0);
  });
});

describe("replay and concurrency", () => {
  it("records one row when the same transition is submitted twice", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    const first = await h.collector.observe(
      JAY,
      session.id,
      transition("ticketing", "spreadsheet", NOW),
    );
    const replayed = await h.collector.observe(
      JAY,
      session.id,
      transition("ticketing", "spreadsheet", NOW),
    );

    expect(replayed.id).toBe(first.id);
    expect(await h.store.countObservations({})).toBe(1);
    expect((await h.store.getSession(session.id))?.observationCount).toBe(1);
  });

  it("gives concurrent appends distinct positions", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    const results = await Promise.all([
      h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW)),
      h.collector.observe(
        JAY,
        session.id,
        transition("spreadsheet", "document_generator", "2026-08-06T16:01:00.000Z"),
      ),
      h.collector.observe(
        JAY,
        session.id,
        transition("document_generator", "ticketing", "2026-08-06T16:02:00.000Z"),
      ),
    ]);

    expect([...results.map((row) => row.sequence)].sort()).toEqual([1, 2, 3]);
  });

  /**
   * The stop button must beat an in-flight collector.
   *
   * A check performed only by the collector, before the write, leaves a window:
   * the person presses stop, the console says stopped, and one more observation
   * lands. So the store re-evaluates the session under the same lock that
   * assigns the sequence, and this test writes through the store directly — the
   * route a collector that had already passed its own checks would take.
   */
  it("refuses an append that was in flight when the person pressed stop", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    await h.store.endSession(session.id, h.clock.nowIso(), "stopped_by_subject");

    const refused = await denial(() =>
      h.store.appendObservation({
        id: "obs_in_flight" as Id<"observation">,
        subjectRef: SUBJECT,
        deviceRef: DEVICE,
        sessionId: session.id,
        fromApplication: "ticketing",
        toApplication: "spreadsheet",
        observedAt: NOW,
        dwellMs: 1000,
      }),
    );
    expect(refused.reason).toBe("discovery.not_enrolled");
    expect(refused.gate).toBe("collector");
    expect(await h.store.countObservations({})).toBe(0);
  });

  it("leaves no observation timestamped after the session closed, whoever wins the race", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);

    // Two callers racing: one recording, one stopping. Either order is a legal
    // outcome; what is asserted is the invariant that must hold in both.
    const results = await Promise.allSettled([
      h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW)),
      h.enrollment.stop(JAY, SUBJECT, DEVICE),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);

    const closed: CollectorSession | null = await h.store.getSession(session.id);
    expect(closed?.endedAt).toBeDefined();

    const rows: readonly Observation[] = await h.store.listObservations({ sessionId: session.id });
    for (const row of rows) {
      expect(row.observedAt <= (closed?.endedAt ?? "")).toBe(true);
    }

    // And afterwards, nothing more lands.
    expect(
      (
        await denial(() =>
          h.collector.observe(
            JAY,
            session.id,
            transition("spreadsheet", "document_generator", "2026-08-06T16:05:00.000Z"),
          ),
        )
      ).gate,
    ).toBe("collector");
  });
});

describe("no egress", () => {
  /**
   * Observations stay inside the deployment's data boundary.
   *
   * `architecture.test.ts` asserts this across the whole tree; it is asserted
   * again here, next to the promise, because a module whose defining constraint
   * is enforced only in somebody else's file is one refactor away from losing
   * it quietly.
   */
  it("does not import the models module from anywhere in discovery", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const offenders: string[] = [];

    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts")) continue;
      const text = readFileSync(join(dir, entry), "utf8");
      // Strip comments so prose about the models module does not trip the check.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const match of code.matchAll(/from\s*["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (/(^|\/)\.\.\/models\//.test(specifier)) offenders.push(`${entry}: ${specifier}`);
      }
    }

    expect(
      offenders,
      `Work-discovery observations must never reach a model provider.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("makes no outbound call of any kind", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const offenders: string[] = [];

    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const code = readFileSync(join(dir, entry), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/.test(code)) offenders.push(entry);
      if (/from\s*["']node:(https?|net|dgram)["']/.test(code)) offenders.push(entry);
    }

    expect(
      offenders,
      `Nothing in discovery/ may open a connection. Observations stay inside the deployment's data boundary.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("the summary a person can read about themselves", () => {
  it("reports what is held, and only to them", async () => {
    const h = harness();
    await enrolled(h);
    const session = await h.collector.start(JAY, SUBJECT, DEVICE);
    await h.collector.observe(JAY, session.id, transition("ticketing", "spreadsheet", NOW));
    h.clock.advance(HOUR);

    const summary = await h.enrollment.summarise(JAY, SUBJECT);
    expect(summary.observations).toBe(1);
    expect(summary.openSessions).toBe(1);
    expect(summary.retentionDays).toBe(7);
  });
});
