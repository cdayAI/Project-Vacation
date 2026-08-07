import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { FixedClock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError, InvariantError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import { SeededIdGenerator, type Id } from "../kernel/ids.js";
import { computeEntryHash, verifyChain, GENESIS_PREVIOUS_HASH } from "../audit/chain.js";
import { AuditLog, decision as auditDecision } from "../audit/log.js";
import type { AuditStore, ChainPosition } from "../audit/port.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { PgAuditStore } from "../audit/store.pg.js";
import type { AuditEntry, NewAuditEntry } from "../audit/types.js";
import type { RunStore } from "../record/port.js";
import { MemoryRunStore } from "../record/store.memory.js";
import { PgRunStore } from "../record/store.pg.js";
import type { NewRun, NewStep } from "../record/types.js";
import type { ApprovalStore, ContainmentStore } from "../guard/port.js";
import { MemoryApprovalStore, MemoryContainmentStore } from "../guard/store.memory.js";
import { PgApprovalStore, PgContainmentStore } from "../guard/store.pg.js";
import type { ApprovalDecision, ApprovalRequest } from "../guard/types.js";
import { MemoryDb, PgDb, createPool } from "./db.js";
import { runMigrations } from "./migrate.js";
import { ALL_MIGRATIONS } from "./registry.js";

/**
 * One contract, two adapters.
 *
 * Every assertion below runs against the in-memory adapter and, when
 * `PV_TEST_DATABASE_URL` is set, against Postgres. That is the point of the
 * file: a fake that is more forgiving than the real store makes the whole test
 * suite lie, and the only way to know it has not drifted is to hold both to
 * the same assertions rather than to two suites written by the same hand on
 * two different days.
 *
 * The concurrency tests are the ones worth reading. Sequence assignment,
 * chain appends, approver decisions, and approval consumption are all
 * read-then-write operations that are correct in isolation and wrong under
 * load, and each of them is a governance control rather than a convenience.
 */

const CONNECTION_STRING = process.env.PV_TEST_DATABASE_URL;

const T0 = "2026-08-06T12:00:00.000Z";
const T_PLUS_DAY = "2026-08-07T12:00:00.000Z";

interface Adapters {
  readonly runs: RunStore;
  readonly audit: AuditStore;
  readonly approvals: ApprovalStore;
  readonly containment: ContainmentStore;
  readonly clock: FixedClock;
  readonly ids: SeededIdGenerator;
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
      const clock = new FixedClock(T0);
      const ids = new SeededIdGenerator("contract");
      return {
        runs: new MemoryRunStore(db, clock, ids),
        audit: new MemoryAuditStore(db),
        approvals: new MemoryApprovalStore(db),
        containment: new MemoryContainmentStore(db),
        clock,
        ids,
      };
    },
    async close() {},
  };
}

function postgresHarness(connectionString: string): Harness {
  // Wide enough that twenty concurrent transactions each hold a connection
  // while waiting on a row or advisory lock held by one of the others.
  const pool = createPool(connectionString, 24);
  const db = new PgDb(pool);
  return {
    async prepare() {
      await runMigrations(db, ALL_MIGRATIONS);
    },
    async fresh() {
      // The audit table refuses TRUNCATE by trigger, which is the behaviour
      // under test elsewhere in this file. Disabling the triggers to empty it
      // between cases is exactly the deliberate, visible act the trigger is
      // meant to require.
      await db.query("ALTER TABLE audit_entry DISABLE TRIGGER USER");
      await db.query(
        `TRUNCATE audit_entry, approval_decision, approval, containment_switch,
         run_cost, run_step, run RESTART IDENTITY CASCADE`,
      );
      await db.query("ALTER TABLE audit_entry ENABLE TRIGGER USER");

      const clock = new FixedClock(T0);
      const ids = new SeededIdGenerator("contract");
      return {
        runs: new PgRunStore(db, clock, ids),
        audit: new PgAuditStore(db),
        approvals: new PgApprovalStore(db),
        containment: new PgContainmentStore(db),
        clock,
        ids,
      };
    },
    async close() {
      await pool.end();
    },
  };
}

function aRun(overrides: Partial<NewRun> = {}): NewRun {
  return {
    kind: "rescission.verify",
    mode: "supervised",
    requestedBy: { actorId: "act_operator", kind: "human", roles: ["owner_services"] },
    subject: { contractId: "ctr_0001" },
    correlationId: "cor_0001",
    ...overrides,
  };
}

function aStep(runId: Id<"run">, overrides: Partial<NewStep> = {}): NewStep {
  return {
    runId,
    kind: "automated_action",
    name: "verify_eligibility",
    idempotencyKey: `verify:${runId}:1`,
    detail: {},
    ...overrides,
  };
}

function anApproval(id: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: id as Id<"approval">,
    action: "contact.send_letter",
    status: "pending",
    proposalDigest: digestValue({ letter: "rescission-acknowledgement" }),
    summary: "Send the rescission acknowledgement letter",
    requestedBy: { actorId: "act_requester", kind: "human", roles: ["owner_services"] },
    requestedAt: T0,
    expiresAt: T_PLUS_DAY,
    subject: { contractId: "ctr_0001" },
    approvalsRequired: 2,
    eligibleRoles: ["supervisor"],
    decisions: [],
    ...overrides,
  };
}

function aDecision(actorId: string, overrides: Partial<ApprovalDecision> = {}): ApprovalDecision {
  return {
    actor: { actorId, kind: "human", roles: ["supervisor"] },
    decision: "granted",
    decidedAt: T0,
    steppedUp: true,
    ...overrides,
  };
}

function anEntry(
  position: ChainPosition,
  overrides: Partial<AuditEntry> = {},
): AuditEntry {
  const base = {
    seq: position.seq,
    eventType: "run.started" as const,
    recordedAt: T0,
    actor: { actorId: "act_operator", kind: "human" as const, roles: [] },
    runId: undefined,
    correlationId: undefined,
    subject: {},
    inputDigests: {},
    decision: {},
    previousHash: position.previousHash,
    ...overrides,
  };
  return { id: `aud_${base.seq}`, ...base, entryHash: computeEntryHash(base) } as AuditEntry;
}

function runContract(name: string, factory: () => Harness, skip: boolean): void {
  const block = skip ? describe.skip : describe;

  block(name, () => {
    let harness: Harness;
    let store: Adapters;

    beforeAll(async () => {
      harness = factory();
      await harness.prepare();
    });

    afterAll(async () => {
      await harness.close();
    });

    beforeEach(async () => {
      store = await harness.fresh();
    });

    // ---------------------------------------------------------------- runs

    describe("runs", () => {
      it("assigns an id, a creation time from the clock, and a pending status", async () => {
        const run = await store.runs.createRun(aRun());
        expect(run.id.startsWith("run_")).toBe(true);
        expect(run.createdAt).toBe(T0);
        expect(run.status).toBe("pending");
        expect(await store.runs.getRun(run.id)).toEqual(run);
      });

      it("honours a caller-supplied id and refuses to reuse one", async () => {
        const created = await store.runs.createRun(aRun({ id: "run_fixed" as Id<"run"> }));
        expect(created.id).toBe("run_fixed");
        await expect(
          store.runs.createRun(aRun({ id: "run_fixed" as Id<"run"> })),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it("returns null for an unknown run but refuses when one is required", async () => {
        expect(await store.runs.getRun("run_missing" as Id<"run">)).toBeNull();
        await expect(store.runs.requireRun("run_missing" as Id<"run">)).rejects.toBeInstanceOf(
          DeniedError,
        );
      });

      it("applies a patch and leaves unmentioned fields alone", async () => {
        const run = await store.runs.createRun(aRun());
        const patched = await store.runs.patchRun(run.id, {
          status: "running",
          startedAt: T0,
        });
        expect(patched.status).toBe("running");
        expect(patched.startedAt).toBe(T0);
        expect(patched.kind).toBe(run.kind);
        expect(patched.correlationId).toBe(run.correlationId);
      });

      it("refuses to move a finished run to another outcome", async () => {
        const run = await store.runs.createRun(aRun());
        await store.runs.patchRun(run.id, { status: "succeeded", endedAt: T0 });
        await expect(store.runs.patchRun(run.id, { status: "failed" })).rejects.toBeInstanceOf(
          DeniedError,
        );
        expect((await store.runs.requireRun(run.id)).status).toBe("succeeded");
      });

      it("refuses a timestamp that is not the platform's UTC wire form", async () => {
        const run = await store.runs.createRun(aRun());
        await expect(
          store.runs.patchRun(run.id, { startedAt: "2026-08-06T12:00:00Z" }),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(
          store.runs.patchRun(run.id, { startedAt: "2026-08-06T14:00:00.000+02:00" }),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it("lists newest first with insertion order as the tiebreak", async () => {
        const first = await store.runs.createRun(aRun({ correlationId: "cor_a" }));
        const second = await store.runs.createRun(aRun({ correlationId: "cor_b" }));
        const third = await store.runs.createRun(aRun({ correlationId: "cor_c" }));
        const listed = await store.runs.listRuns();
        expect(listed.map((run) => run.id)).toEqual([third.id, second.id, first.id]);
      });

      it("filters by status, kind, mode, actor and workflow instance", async () => {
        const target = await store.runs.createRun(
          aRun({ kind: "contact.letter", mode: "shadow", workflowInstanceId: "wfi_1" }),
        );
        await store.runs.createRun(aRun());
        await store.runs.patchRun(target.id, { status: "running" });

        expect((await store.runs.listRuns({ kind: "contact.letter" })).map((r) => r.id)).toEqual([
          target.id,
        ]);
        expect((await store.runs.listRuns({ mode: "shadow" })).map((r) => r.id)).toEqual([target.id]);
        expect((await store.runs.listRuns({ status: ["running"] })).map((r) => r.id)).toEqual([
          target.id,
        ]);
        expect(
          (await store.runs.listRuns({ workflowInstanceId: "wfi_1" as Id<"workflowInstance"> })).map(
            (r) => r.id,
          ),
        ).toEqual([target.id]);
        expect(await store.runs.listRuns({ requestedByActorId: "act_nobody" })).toEqual([]);
      });

      it("treats createdAfter and createdBefore as strict bounds", async () => {
        await store.runs.createRun(aRun());
        expect(await store.runs.listRuns({ createdAfter: T0 })).toEqual([]);
        expect(await store.runs.listRuns({ createdBefore: T0 })).toEqual([]);
        expect((await store.runs.listRuns({ createdAfter: "2026-08-06T11:59:59.999Z" })).length).toBe(
          1,
        );
      });

      it("pages with limit and offset, and counts without them", async () => {
        const first = await store.runs.createRun(aRun());
        const second = await store.runs.createRun(aRun());
        const third = await store.runs.createRun(aRun());

        expect((await store.runs.listRuns({ limit: 2 })).map((r) => r.id)).toEqual([
          third.id,
          second.id,
        ]);
        expect((await store.runs.listRuns({ limit: 1, offset: 2 })).map((r) => r.id)).toEqual([
          first.id,
        ]);
        expect(await store.runs.countRuns({ limit: 1 })).toBe(3);
      });

      it("does not let a caller mutate the record through the object it was handed", async () => {
        const input = aRun({ subject: { contractId: "ctr_0001" } });
        const run = await store.runs.createRun(input);

        // The object handed in, mutated after the write.
        (input.subject as Record<string, string>).contractId = "ctr_tampered";
        // The object handed back, mutated by a caller that ignores readonly.
        (run.subject as Record<string, string>).contractId = "ctr_tampered";

        const reread = await store.runs.requireRun(run.id);
        expect(reread.subject).toEqual({ contractId: "ctr_0001" });
      });
    });

    // --------------------------------------------------------------- steps

    describe("steps", () => {
      it("assigns sequence numbers from one, in order", async () => {
        const run = await store.runs.createRun(aRun());
        const first = await store.runs.appendStep(aStep(run.id, { idempotencyKey: "k1" }));
        const second = await store.runs.appendStep(aStep(run.id, { idempotencyKey: "k2" }));
        expect(first.seq).toBe(1);
        expect(second.seq).toBe(2);
        expect((await store.runs.listSteps(run.id)).map((s) => s.seq)).toEqual([1, 2]);
      });

      it("gives twenty concurrent appends twenty distinct sequence numbers", async () => {
        const run = await store.runs.createRun(aRun());
        const appended = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            store.runs.appendStep(aStep(run.id, { idempotencyKey: `concurrent:${index}` })),
          ),
        );

        const seqs = appended.map((step) => step.seq).sort((a, b) => a - b);
        expect(new Set(seqs).size).toBe(20);
        expect(seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

        const stored = await store.runs.listSteps(run.id);
        expect(stored.map((step) => step.seq)).toEqual(seqs);
      });

      it("does not burn a sequence number on a rejected append", async () => {
        const run = await store.runs.createRun(aRun());
        await store.runs.appendStep(
          aStep(run.id, { id: "stp_fixed" as Id<"step">, idempotencyKey: "k1" }),
        );
        await expect(
          store.runs.appendStep(
            aStep(run.id, { id: "stp_fixed" as Id<"step">, idempotencyKey: "k2" }),
          ),
        ).rejects.toBeInstanceOf(InvalidInputError);

        // A refused append must leave no hole behind it, or the step history
        // reads as though a step was recorded and then removed.
        const next = await store.runs.appendStep(aStep(run.id, { idempotencyKey: "k3" }));
        expect(next.seq).toBe(2);
      });

      it("numbers each run's steps independently", async () => {
        const left = await store.runs.createRun(aRun());
        const right = await store.runs.createRun(aRun());
        const leftStep = await store.runs.appendStep(aStep(left.id, { idempotencyKey: "l1" }));
        const rightStep = await store.runs.appendStep(aStep(right.id, { idempotencyKey: "r1" }));
        expect(leftStep.seq).toBe(1);
        expect(rightStep.seq).toBe(1);
      });

      it("refuses a step for a run that is not in the record", async () => {
        await expect(
          store.runs.appendStep(aStep("run_missing" as Id<"run">, { idempotencyKey: "k" })),
        ).rejects.toBeInstanceOf(DeniedError);
      });

      it("refuses a blank idempotency key, on write and on lookup", async () => {
        const run = await store.runs.createRun(aRun());
        await expect(
          store.runs.appendStep(aStep(run.id, { idempotencyKey: "" })),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(
          store.runs.appendStep(aStep(run.id, { idempotencyKey: "   " })),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(store.runs.findStepByIdempotencyKey("")).rejects.toBeInstanceOf(
          InvalidInputError,
        );
      });

      it("matches an idempotency key exactly and nothing else", async () => {
        const run = await store.runs.createRun(aRun());
        const step = await store.runs.appendStep(
          aStep(run.id, { idempotencyKey: "letter:ctr_0001:2" }),
        );

        expect((await store.runs.findStepByIdempotencyKey("letter:ctr_0001:2"))?.id).toBe(step.id);
        expect(await store.runs.findStepByIdempotencyKey("letter:ctr_0001:")).toBeNull();
        expect(await store.runs.findStepByIdempotencyKey("LETTER:ctr_0001:2")).toBeNull();
        expect(await store.runs.findStepByIdempotencyKey("letter:ctr_0001:23")).toBeNull();
        expect(await store.runs.findStepByIdempotencyKey("%")).toBeNull();
      });

      it("finds a key across runs, so a retry in a new run sees the old effect", async () => {
        const first = await store.runs.createRun(aRun());
        const second = await store.runs.createRun(aRun());
        const original = await store.runs.appendStep(
          aStep(first.id, { idempotencyKey: "shared-effect" }),
        );
        await store.runs.appendStep(aStep(second.id, { idempotencyKey: "shared-effect" }));

        // The earliest step owns the effect; a later one is a retry of it.
        expect((await store.runs.findStepByIdempotencyKey("shared-effect"))?.id).toBe(original.id);
      });

      it("advances a step to a terminal status", async () => {
        const run = await store.runs.createRun(aRun());
        const step = await store.runs.appendStep(aStep(run.id, { idempotencyKey: "k" }));
        const done = await store.runs.patchStep(step.id, {
          status: "succeeded",
          endedAt: T0,
          outputDigest: digestValue({ ok: true }),
        });
        expect(done.status).toBe("succeeded");
        expect(done.endedAt).toBe(T0);
      });

      it("refuses to move a step out of a terminal status", async () => {
        const run = await store.runs.createRun(aRun());
        const step = await store.runs.appendStep(aStep(run.id, { idempotencyKey: "k" }));

        for (const terminal of ["succeeded", "failed", "skipped", "compensated", "denied"] as const) {
          const fresh = await store.runs.appendStep(
            aStep(run.id, { idempotencyKey: `k-${terminal}` }),
          );
          await store.runs.patchStep(fresh.id, { status: terminal });
          await expect(
            store.runs.patchStep(fresh.id, { status: "running" }),
          ).rejects.toBeInstanceOf(DeniedError);
          expect((await store.runs.getStep(fresh.id))?.status).toBe(terminal);
        }

        await store.runs.patchStep(step.id, { status: "succeeded" });
        await expect(store.runs.patchStep(step.id, { status: "failed" })).rejects.toBeInstanceOf(
          DeniedError,
        );
      });

      it("refuses to change any field of a finished step, not only its status", async () => {
        const run = await store.runs.createRun(aRun());
        const step = await store.runs.appendStep(aStep(run.id, { idempotencyKey: "k" }));
        await store.runs.patchStep(step.id, { status: "failed", error: "upstream timeout" });

        await expect(
          store.runs.patchStep(step.id, { error: "actually it was fine" }),
        ).rejects.toBeInstanceOf(DeniedError);
        expect((await store.runs.getStep(step.id))?.error).toBe("upstream timeout");
      });

      it("lets a repeat of an already-applied patch through unchanged", async () => {
        const run = await store.runs.createRun(aRun());
        const step = await store.runs.appendStep(aStep(run.id, { idempotencyKey: "k" }));
        const patch = { status: "succeeded", endedAt: T0, detail: { attempts: 1 } } as const;
        const first = await store.runs.patchStep(step.id, patch);
        // A crash-then-recover replay must not be an error in itself.
        const again = await store.runs.patchStep(step.id, patch);
        expect(again).toEqual(first);
      });

      it("lets exactly one of two racing writers finish a step", async () => {
        const run = await store.runs.createRun(aRun());
        const step = await store.runs.appendStep(aStep(run.id, { idempotencyKey: "k" }));

        const outcomes = await Promise.allSettled([
          store.runs.patchStep(step.id, { status: "succeeded", endedAt: T0 }),
          store.runs.patchStep(step.id, { status: "failed", error: "raced" }),
        ]);
        const fulfilled = outcomes.filter((result) => result.status === "fulfilled");
        expect(fulfilled).toHaveLength(1);
        for (const result of outcomes) {
          if (result.status === "rejected") expect(result.reason).toBeInstanceOf(DeniedError);
        }
      });

      it("refuses to patch a step that is not in the record", async () => {
        await expect(
          store.runs.patchStep("stp_missing" as Id<"step">, { status: "succeeded" }),
        ).rejects.toBeInstanceOf(DeniedError);
      });
    });

    // ---------------------------------------------------------------- cost

    describe("cost", () => {
      it("totals a run's spend overall and by category", async () => {
        const run = await store.runs.createRun(aRun());
        await store.runs.recordCost({
          runId: run.id,
          category: "model",
          amountUsd: 0.25,
          recordedAt: T0,
          modelId: "fake-1",
        });
        await store.runs.recordCost({
          runId: run.id,
          category: "model",
          amountUsd: 0.5,
          recordedAt: T0,
        });
        await store.runs.recordCost({
          runId: run.id,
          category: "integration",
          amountUsd: 1.25,
          recordedAt: T0,
        });

        const summary = await store.runs.costForRun(run.id);
        expect(summary.totalUsd).toBeCloseTo(2, 10);
        expect(summary.byCategory["model"]).toBeCloseTo(0.75, 10);
        expect(summary.byCategory["integration"]).toBeCloseTo(1.25, 10);
      });

      it("reports zero for a run that has spent nothing", async () => {
        const run = await store.runs.createRun(aRun());
        expect(await store.runs.costForRun(run.id)).toEqual({ totalUsd: 0, byCategory: {} });
      });

      it("sums spend at or after the given instant", async () => {
        const run = await store.runs.createRun(aRun());
        await store.runs.recordCost({
          runId: run.id,
          category: "model",
          amountUsd: 1,
          recordedAt: "2026-08-06T11:59:59.999Z",
        });
        await store.runs.recordCost({
          runId: run.id,
          category: "model",
          amountUsd: 2,
          recordedAt: T0,
        });
        await store.runs.recordCost({
          runId: run.id,
          category: "model",
          amountUsd: 4,
          recordedAt: "2026-08-06T12:00:00.001Z",
        });

        // Inclusive of the boundary: money spent at exactly the window's start
        // was spent inside the window.
        expect(await store.runs.costSince(T0)).toBeCloseTo(6, 10);
        expect(await store.runs.costSince("2026-08-06T12:00:00.001Z")).toBeCloseTo(4, 10);
        expect(await store.runs.costSince("2026-08-06T12:00:00.002Z")).toBeCloseTo(0, 10);
      });

      it("refuses a negative amount, which would buy back ceiling headroom", async () => {
        const run = await store.runs.createRun(aRun());
        await expect(
          store.runs.recordCost({
            runId: run.id,
            category: "model",
            amountUsd: -5,
            recordedAt: T0,
          }),
        ).rejects.toBeInstanceOf(InvalidInputError);
        expect((await store.runs.costForRun(run.id)).totalUsd).toBe(0);
      });

      it("refuses a non-finite amount", async () => {
        const run = await store.runs.createRun(aRun());
        await expect(
          store.runs.recordCost({
            runId: run.id,
            category: "model",
            amountUsd: Number.NaN,
            recordedAt: T0,
          }),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it("refuses spend attributed to a run that does not exist", async () => {
        await expect(
          store.runs.recordCost({
            runId: "run_missing" as Id<"run">,
            category: "model",
            amountUsd: 1,
            recordedAt: T0,
          }),
        ).rejects.toBeInstanceOf(DeniedError);
      });

      it("lists a run's cost entries in the order they were recorded", async () => {
        const run = await store.runs.createRun(aRun());
        const other = await store.runs.createRun(aRun());
        await store.runs.recordCost({ runId: run.id, category: "model", amountUsd: 1, recordedAt: T0 });
        await store.runs.recordCost({ runId: other.id, category: "model", amountUsd: 9, recordedAt: T0 });
        await store.runs.recordCost({
          runId: run.id,
          category: "compute",
          amountUsd: 2,
          recordedAt: T0,
          units: 30,
          detail: { region: "us-east-1" },
        });

        const entries = await store.runs.listCostEntries(run.id);
        expect(entries.map((entry) => entry.category)).toEqual(["model", "compute"]);
        expect(entries[1]?.units).toBe(30);
        expect(entries[1]?.detail).toEqual({ region: "us-east-1" });
      });

      it("rolls the window up per run, carrying the attributes a report groups by", async () => {
        const loop = await store.runs.createRun(
          aRun({ kind: "rescission.verify", roleId: "rol_verifier" as Id<"role">, roleVersion: 3 }),
        );
        const ordinary = await store.runs.createRun(aRun({ kind: "intake.triage" }));

        await store.runs.recordCost({
          runId: loop.id,
          category: "model",
          amountUsd: 4,
          recordedAt: T0,
        });
        await store.runs.recordCost({
          runId: loop.id,
          category: "integration",
          amountUsd: 2,
          recordedAt: "2026-08-06T12:00:05.000Z",
        });
        await store.runs.recordCost({
          runId: ordinary.id,
          category: "model",
          amountUsd: 1,
          recordedAt: T0,
        });

        const rollup = await store.runs.costRollupSince(T0);
        expect(rollup).toHaveLength(2);

        // Most expensive first: the row that tells a loop from ordinary volume
        // is the one an operator reads first during a spend alert.
        const [first, second] = rollup;
        expect(first?.runId).toBe(loop.id);
        expect(first?.kind).toBe("rescission.verify");
        expect(first?.roleId).toBe("rol_verifier");
        expect(first?.roleVersion).toBe(3);
        expect(first?.mode).toBe("supervised");
        expect(first?.totalUsd).toBeCloseTo(6, 10);
        expect(first?.entries).toBe(2);
        expect(first?.byCategory["model"]).toBeCloseTo(4, 10);
        expect(first?.byCategory["integration"]).toBeCloseTo(2, 10);
        expect(first?.lastRecordedAt).toBe("2026-08-06T12:00:05.000Z");
        expect(second?.kind).toBe("intake.triage");
        expect(second?.roleId).toBeUndefined();
      });

      it("counts the same window the daily ceiling counts, and totals to the same money", async () => {
        // The report and the meter must be one number. An operator deciding
        // whether to raise a ceiling is reasoning about the figure that fired
        // the alert, and a report that quietly counted a different window —
        // when the run started, rather than when the money was recorded —
        // would send them to the wrong run.
        const older = await store.runs.createRun(aRun());
        const inside = await store.runs.createRun(aRun());

        await store.runs.recordCost({
          runId: older.id,
          category: "model",
          amountUsd: 8,
          recordedAt: "2026-08-06T11:59:59.999Z",
        });
        // Same run, spent inside the window: a long case that started before
        // the window still belongs in it for every dollar recorded since.
        await store.runs.recordCost({
          runId: older.id,
          category: "model",
          amountUsd: 3,
          recordedAt: T0,
        });
        await store.runs.recordCost({
          runId: inside.id,
          category: "human",
          amountUsd: 5,
          recordedAt: "2026-08-06T12:00:00.001Z",
        });

        const rollup = await store.runs.costRollupSince(T0);
        const total = rollup.reduce((sum, row) => sum + row.totalUsd, 0);
        expect(total).toBeCloseTo(await store.runs.costSince(T0), 10);
        expect(total).toBeCloseTo(8, 10);

        const olderRow = rollup.find((row) => row.runId === older.id);
        expect(olderRow?.totalUsd).toBeCloseTo(3, 10);
        expect(olderRow?.entries).toBe(1);
      });

      it("returns nothing for a window with no spend in it", async () => {
        const run = await store.runs.createRun(aRun());
        await store.runs.recordCost({
          runId: run.id,
          category: "model",
          amountUsd: 1,
          recordedAt: T0,
        });
        expect(await store.runs.costRollupSince(T_PLUS_DAY)).toEqual([]);
      });
    });

    // --------------------------------------------------------------- audit

    describe("audit chain", () => {
      const log = (adapters: Adapters): AuditLog =>
        new AuditLog(adapters.audit, adapters.clock, adapters.ids);

      it("starts at sequence one, linked to the genesis constant", async () => {
        const entry = await log(store).record(
          auditDecision({ eventType: "run.started", actorId: "act_operator", actorKind: "human" }),
        );
        expect(entry.seq).toBe(1);
        expect(entry.previousHash).toBe(GENESIS_PREVIOUS_HASH);
        expect(await store.audit.auditHead()).toEqual(entry);
      });

      it("produces a chain that verifies, and reads back in ascending order", async () => {
        const audit = log(store);
        for (let index = 0; index < 5; index += 1) {
          await audit.record(
            auditDecision({
              eventType: "step.recorded",
              actorId: "act_operator",
              actorKind: "service",
              decision: { index },
            }),
          );
        }
        const chain = await store.audit.readAuditChain();
        expect(chain.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
        expect(verifyChain(chain).intact).toBe(true);
      });

      it("keeps the chain intact under twenty concurrent appends", async () => {
        const audit = log(store);
        await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            audit.record(
              auditDecision({
                eventType: "model.invoked",
                actorId: "act_service",
                actorKind: "service",
                decision: { index },
              }),
            ),
          ),
        );

        const chain = await store.audit.readAuditChain();
        expect(chain).toHaveLength(20);
        expect(chain.map((entry) => entry.seq)).toEqual(
          Array.from({ length: 20 }, (_, index) => index + 1),
        );

        const result = verifyChain(chain);
        expect(result.breaks).toEqual([]);
        expect(result.intact).toBe(true);
        expect(new Set(chain.map((entry) => entry.previousHash)).size).toBe(20);
      });

      it("reads a window of the chain", async () => {
        const audit = log(store);
        for (let index = 0; index < 5; index += 1) {
          await audit.record(
            auditDecision({ eventType: "step.recorded", actorId: "a", actorKind: "system" }),
          );
        }
        const window = await store.audit.readAuditChain(2, 4);
        expect(window.map((entry) => entry.seq)).toEqual([2, 3, 4]);

        // A window still verifies when told what it should link to.
        const previous = (await store.audit.readAuditChain(1, 1))[0];
        expect(previous).toBeDefined();
        expect(verifyChain(window, previous?.entryHash ?? "").intact).toBe(true);
      });

      it("has an empty head and an intact empty chain before anything is written", async () => {
        expect(await store.audit.auditHead()).toBeNull();
        expect(verifyChain(await store.audit.readAuditChain()).intact).toBe(true);
      });

      it("filters by event type, run, actor, correlation and sequence", async () => {
        const audit = log(store);
        await audit.record(
          auditDecision({
            eventType: "authorization.granted",
            actorId: "act_alice",
            actorKind: "human",
            runId: "run_1",
            correlationId: "cor_1",
          }),
        );
        await audit.record(
          auditDecision({
            eventType: "authorization.denied",
            actorId: "act_bob",
            actorKind: "human",
            runId: "run_2",
            correlationId: "cor_2",
          }),
        );

        expect(
          (await store.audit.listAuditEntries({ eventType: ["authorization.denied"] })).map(
            (entry) => entry.actor.actorId,
          ),
        ).toEqual(["act_bob"]);
        expect(await store.audit.countAuditEntries({ actorId: "act_alice" })).toBe(1);
        expect(
          (await store.audit.listAuditEntries({ runId: "run_2" as Id<"run"> })).map((e) => e.seq),
        ).toEqual([2]);
        expect((await store.audit.listAuditEntries({ correlationId: "cor_1" })).length).toBe(1);
        expect((await store.audit.listAuditEntries({ fromSeq: 2 })).map((e) => e.seq)).toEqual([2]);
        expect(await store.audit.listAuditEntries({ actorId: "act_nobody" })).toEqual([]);
      });

      it("matches a subject only when every requested pair is present", async () => {
        const audit = log(store);
        await audit.record(
          auditDecision({
            eventType: "contact.gate_passed",
            actorId: "act_service",
            actorKind: "service",
            subject: { contractId: "ctr_1", state: "FL" },
          }),
        );
        await audit.record(
          auditDecision({
            eventType: "contact.gate_passed",
            actorId: "act_service",
            actorKind: "service",
            subject: { contractId: "ctr_2", state: "FL" },
          }),
        );

        expect((await store.audit.listAuditEntries({ subject: { state: "FL" } })).length).toBe(2);
        expect(
          (await store.audit.listAuditEntries({ subject: { contractId: "ctr_1" } })).length,
        ).toBe(1);
        expect(
          (await store.audit.listAuditEntries({ subject: { contractId: "ctr_1", state: "FL" } }))
            .length,
        ).toBe(1);
        // Every pair must match: this one asks for a combination nothing has.
        expect(
          (await store.audit.listAuditEntries({ subject: { contractId: "ctr_1", state: "NV" } }))
            .length,
        ).toBe(0);
      });

      it("treats recordedAfter and recordedBefore as strict bounds", async () => {
        const audit = log(store);
        await audit.record(
          auditDecision({ eventType: "run.started", actorId: "a", actorKind: "system" }),
        );
        expect(await store.audit.listAuditEntries({ recordedAfter: T0 })).toEqual([]);
        expect(await store.audit.listAuditEntries({ recordedBefore: T0 })).toEqual([]);
        expect(
          (await store.audit.listAuditEntries({ recordedAfter: "2026-08-06T11:59:59.999Z" })).length,
        ).toBe(1);
      });

      it("pages entries in sequence order", async () => {
        const audit = log(store);
        for (let index = 0; index < 4; index += 1) {
          await audit.record(
            auditDecision({ eventType: "step.recorded", actorId: "a", actorKind: "system" }),
          );
        }
        expect((await store.audit.listAuditEntries({ limit: 2 })).map((e) => e.seq)).toEqual([1, 2]);
        expect(
          (await store.audit.listAuditEntries({ limit: 2, offset: 2 })).map((e) => e.seq),
        ).toEqual([3, 4]);
        expect(await store.audit.countAuditEntries({ limit: 1 })).toBe(4);
      });

      it("does not advance the chain when the builder fails", async () => {
        const audit = log(store);
        const first = await audit.record(
          auditDecision({ eventType: "run.started", actorId: "a", actorKind: "system" }),
        );

        await expect(
          store.audit.appendEntry(
            { eventType: "run.ended", actor: { actorId: "a", kind: "system", roles: [] }, subject: {}, inputDigests: {}, decision: {}, recordedAt: T0 },
            () => {
              throw new Error("builder exploded");
            },
          ),
        ).rejects.toThrow();

        expect(await store.audit.auditHead()).toEqual(first);
        const next = await audit.record(
          auditDecision({ eventType: "run.ended", actorId: "a", actorKind: "system" }),
        );
        expect(next.seq).toBe(2);
        expect(next.previousHash).toBe(first.entryHash);
      });

      it("refuses an entry that ignores the position it was given", async () => {
        const content: NewAuditEntry = {
          eventType: "run.started",
          actor: { actorId: "a", kind: "system", roles: [] },
          subject: {},
          inputDigests: {},
          decision: {},
          recordedAt: T0,
        };

        await expect(
          store.audit.appendEntry(content, (_c, position) =>
            anEntry({ seq: position.seq + 7, previousHash: position.previousHash }),
          ),
        ).rejects.toBeInstanceOf(InvariantError);

        await expect(
          store.audit.appendEntry(content, (_c, position) =>
            anEntry({ seq: position.seq, previousHash: "sha256:" + "0".repeat(64) }),
          ),
        ).rejects.toBeInstanceOf(InvariantError);

        expect(await store.audit.auditHead()).toBeNull();
      });

      it("refuses an entry whose recorded hash does not match its content", async () => {
        await expect(
          store.audit.appendEntry(
            {
              eventType: "run.started",
              actor: { actorId: "a", kind: "system", roles: [] },
              subject: {},
              inputDigests: {},
              decision: {},
              recordedAt: T0,
            },
            (_c, position) => ({
              ...anEntry(position),
              entryHash: "sha256:" + "1".repeat(64),
            }),
          ),
        ).rejects.toBeInstanceOf(InvariantError);
        expect(await store.audit.auditHead()).toBeNull();
      });

      it("does not let a caller alter a stored entry through the object it was handed", async () => {
        const entry = await log(store).record(
          auditDecision({
            eventType: "run.started",
            actorId: "a",
            actorKind: "system",
            subject: { contractId: "ctr_1" },
          }),
        );
        (entry.subject as Record<string, string>).contractId = "ctr_tampered";
        (entry as { entryHash: string }).entryHash = "sha256:" + "0".repeat(64);

        const chain = await store.audit.readAuditChain();
        expect(chain[0]?.subject).toEqual({ contractId: "ctr_1" });
        expect(verifyChain(chain).intact).toBe(true);
      });
    });

    // ----------------------------------------------------------- approvals

    describe("approvals", () => {
      it("stores and returns an approval request whole", async () => {
        const request = anApproval("apr_1", { runId: "run_1" as Id<"run">, correlationId: "cor_1" });
        const created = await store.approvals.createApproval(request);
        expect(created).toEqual(request);
        expect(await store.approvals.getApproval(request.id)).toEqual(request);
      });

      it("returns null for an approval that does not exist", async () => {
        expect(await store.approvals.getApproval("apr_missing" as Id<"approval">)).toBeNull();
      });

      it("refuses to reuse an approval id", async () => {
        await store.approvals.createApproval(anApproval("apr_1"));
        await expect(
          store.approvals.createApproval(anApproval("apr_1")),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it("records a decision and moves the request to the next status", async () => {
        await store.approvals.createApproval(anApproval("apr_1"));
        const afterFirst = await store.approvals.recordApprovalDecision(
          "apr_1" as Id<"approval">,
          aDecision("act_first"),
          "pending",
        );
        expect(afterFirst.status).toBe("pending");
        expect(afterFirst.decisions).toHaveLength(1);

        const afterSecond = await store.approvals.recordApprovalDecision(
          "apr_1" as Id<"approval">,
          aDecision("act_second"),
          "granted",
        );
        expect(afterSecond.status).toBe("granted");
        expect(afterSecond.decisions.map((entry) => entry.actor.actorId)).toEqual([
          "act_first",
          "act_second",
        ]);
      });

      it("refuses a second decision from the same approver", async () => {
        await store.approvals.createApproval(anApproval("apr_1"));
        await store.approvals.recordApprovalDecision(
          "apr_1" as Id<"approval">,
          aDecision("act_first"),
          "pending",
        );
        await expect(
          store.approvals.recordApprovalDecision(
            "apr_1" as Id<"approval">,
            aDecision("act_first", { note: "second bite" }),
            "granted",
          ),
        ).rejects.toBeInstanceOf(DeniedError);

        const stored = await store.approvals.getApproval("apr_1" as Id<"approval">);
        expect(stored?.decisions).toHaveLength(1);
        expect(stored?.status).toBe("pending");
      });

      it("lets exactly one of ten simultaneous decisions from one approver land", async () => {
        await store.approvals.createApproval(anApproval("apr_1"));
        const outcomes = await Promise.allSettled(
          Array.from({ length: 10 }, () =>
            store.approvals.recordApprovalDecision(
              "apr_1" as Id<"approval">,
              aDecision("act_impatient"),
              "pending",
            ),
          ),
        );

        expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const stored = await store.approvals.getApproval("apr_1" as Id<"approval">);
        expect(stored?.decisions).toHaveLength(1);
      });

      it("refuses a decision on a request that is no longer pending", async () => {
        await store.approvals.createApproval(anApproval("apr_1", { status: "rejected" }));
        await expect(
          store.approvals.recordApprovalDecision(
            "apr_1" as Id<"approval">,
            aDecision("act_first"),
            "granted",
          ),
        ).rejects.toBeInstanceOf(DeniedError);
      });

      it("refuses a decision on a request that does not exist", async () => {
        await expect(
          store.approvals.recordApprovalDecision(
            "apr_missing" as Id<"approval">,
            aDecision("act_first"),
            "granted",
          ),
        ).rejects.toBeInstanceOf(DeniedError);
      });

      it("consumes a granted approval exactly once", async () => {
        await store.approvals.createApproval(anApproval("apr_1", { status: "granted" }));
        const consumed = await store.approvals.consumeApproval(
          "apr_1" as Id<"approval">,
          T0,
          "run_1" as Id<"run">,
        );
        expect(consumed?.status).toBe("consumed");
        expect(consumed?.consumedAt).toBe(T0);
        expect(consumed?.consumedByRunId).toBe("run_1");

        expect(await store.approvals.consumeApproval("apr_1" as Id<"approval">, T0)).toBeNull();
      });

      it("lets exactly one of ten concurrent consumers win", async () => {
        await store.approvals.createApproval(anApproval("apr_1", { status: "granted" }));
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            store.approvals.consumeApproval("apr_1" as Id<"approval">, T0, "run_1" as Id<"run">),
          ),
        );

        expect(results.filter((result) => result !== null)).toHaveLength(1);
        expect((await store.approvals.getApproval("apr_1" as Id<"approval">))?.status).toBe(
          "consumed",
        );
      });

      it("refuses to consume anything that is not granted", async () => {
        for (const status of ["pending", "rejected", "expired", "consumed"] as const) {
          const id = `apr_${status}`;
          await store.approvals.createApproval(anApproval(id, { status }));
          expect(await store.approvals.consumeApproval(id as Id<"approval">, T0)).toBeNull();
        }
        expect(await store.approvals.consumeApproval("apr_missing" as Id<"approval">, T0)).toBeNull();
      });

      it("expires pending requests that are past their expiry, and nothing else", async () => {
        await store.approvals.createApproval(anApproval("apr_pending"));
        await store.approvals.createApproval(anApproval("apr_granted", { status: "granted" }));
        await store.approvals.createApproval(
          anApproval("apr_later", { expiresAt: "2026-08-09T12:00:00.000Z" }),
        );

        // Still live at the instant it expires.
        expect(await store.approvals.expireApprovals(T_PLUS_DAY)).toEqual([]);

        const expired = await store.approvals.expireApprovals("2026-08-07T12:00:00.001Z");
        expect(expired.map((request) => request.id)).toEqual(["apr_pending"]);
        expect((await store.approvals.getApproval("apr_pending" as Id<"approval">))?.status).toBe(
          "expired",
        );
        expect((await store.approvals.getApproval("apr_granted" as Id<"approval">))?.status).toBe(
          "granted",
        );
        expect((await store.approvals.getApproval("apr_later" as Id<"approval">))?.status).toBe(
          "pending",
        );
      });

      it("lists oldest first so nothing in the queue starves", async () => {
        await store.approvals.createApproval(anApproval("apr_1"));
        await store.approvals.createApproval(
          anApproval("apr_2", { requestedAt: "2026-08-06T13:00:00.000Z" }),
        );
        await store.approvals.createApproval(
          anApproval("apr_3", { action: "role.promote", status: "granted" }),
        );

        expect((await store.approvals.listApprovals()).map((r) => r.id)).toEqual([
          "apr_1",
          "apr_3",
          "apr_2",
        ]);
        expect(
          (await store.approvals.listApprovals({ status: ["pending"] })).map((r) => r.id),
        ).toEqual(["apr_1", "apr_2"]);
        expect(
          (await store.approvals.listApprovals({ action: "role.promote" })).map((r) => r.id),
        ).toEqual(["apr_3"]);
        expect((await store.approvals.listApprovals({ limit: 1 })).map((r) => r.id)).toEqual([
          "apr_1",
        ]);
      });

      it("refuses a timestamp outside the platform's UTC wire form", async () => {
        await expect(
          store.approvals.createApproval(anApproval("apr_1", { requestedAt: "2026-08-06T12:00:00Z" })),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });
    });

    // --------------------------------------------------------- containment

    describe("containment switches", () => {
      it("reports an unset switch as absent rather than as disengaged", async () => {
        // The controller distinguishes these: a switch it cannot read is
        // refused, a switch that is absent is simply not engaged.
        expect(await store.containment.getSwitch("global", "")).toBeNull();
        expect(await store.containment.listSwitches()).toEqual([]);
      });

      it("stores and replaces a switch by scope and target", async () => {
        const engaged = await store.containment.setSwitch({
          scope: "workflow",
          target: "rescission.verify",
          engaged: true,
          engagedBy: "act_operator",
          engagedAt: T0,
          reason: "regression in eligibility check",
        });
        expect(engaged.engaged).toBe(true);
        expect(await store.containment.getSwitch("workflow", "rescission.verify")).toEqual(engaged);

        const released = await store.containment.setSwitch({
          scope: "workflow",
          target: "rescission.verify",
          engaged: false,
          engagedBy: "act_operator",
          engagedAt: T0,
          reason: "fix shipped",
        });
        expect(released.engaged).toBe(false);
        expect((await store.containment.listSwitches()).length).toBe(1);
      });

      it("keeps the four scopes independent, including the empty global target", async () => {
        await store.containment.setSwitch({ scope: "global", target: "", engaged: true });
        await store.containment.setSwitch({
          scope: "role",
          target: "rol_1",
          engaged: false,
        });
        await store.containment.setSwitch({
          scope: "integration",
          target: "letters",
          engaged: true,
        });

        expect((await store.containment.getSwitch("global", ""))?.engaged).toBe(true);
        expect((await store.containment.getSwitch("role", "rol_1"))?.engaged).toBe(false);
        expect((await store.containment.getSwitch("integration", "letters"))?.engaged).toBe(true);
        expect((await store.containment.listSwitches()).map((s) => `${s.scope}:${s.target}`)).toEqual([
          "global:",
          "integration:letters",
          "role:rol_1",
        ]);
      });
    });
  });
}

runContract("in-memory adapters", memoryHarness, false);
runContract(
  "postgres adapters",
  () => postgresHarness(CONNECTION_STRING ?? ""),
  CONNECTION_STRING === undefined || CONNECTION_STRING === "",
);

/**
 * Guarantees that only Postgres can make.
 *
 * The `AuditStore` port has no update and no delete, so no code path in this
 * platform can alter an entry. These cases cover the path that does not go
 * through this platform at all.
 */
describe.skipIf(!CONNECTION_STRING)("postgres enforces the audit log's append-only rule", () => {
  let pool: pg.Pool;
  let db: PgDb;

  beforeAll(async () => {
    pool = createPool(CONNECTION_STRING ?? "", 4);
    db = new PgDb(pool);
    await runMigrations(db, ALL_MIGRATIONS);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.query("ALTER TABLE audit_entry DISABLE TRIGGER USER");
    await db.query("TRUNCATE audit_entry RESTART IDENTITY CASCADE");
    await db.query("ALTER TABLE audit_entry ENABLE TRIGGER USER");

    const store = new PgAuditStore(db);
    const log = new AuditLog(store, new FixedClock(T0), new SeededIdGenerator("immutability"));
    await log.record(
      auditDecision({
        eventType: "approval.granted",
        actorId: "act_supervisor",
        actorKind: "human",
        subject: { contractId: "ctr_0001" },
      }),
    );
  });

  it("raises on UPDATE", async () => {
    await expect(
      db.query("UPDATE audit_entry SET decision = '{\"granted\": false}'::jsonb WHERE seq = 1"),
    ).rejects.toThrow(/append-only/i);
    const rows = await db.query<{ decision: Record<string, unknown> }>(
      "SELECT decision FROM audit_entry WHERE seq = 1",
    );
    expect(rows[0]?.decision).toEqual({});
  });

  it("raises on DELETE", async () => {
    await expect(db.query("DELETE FROM audit_entry WHERE seq = 1")).rejects.toThrow(/append-only/i);
    const rows = await db.query<{ count: string }>("SELECT COUNT(*) AS count FROM audit_entry");
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("raises on TRUNCATE, which fires no row triggers", async () => {
    await expect(db.query("TRUNCATE audit_entry")).rejects.toThrow(/append-only/i);
    const rows = await db.query<{ count: string }>("SELECT COUNT(*) AS count FROM audit_entry");
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("refuses a second entry claiming the same predecessor, so the chain cannot fork", async () => {
    const head = (
      await db.query<{ entry_hash: string }>("SELECT entry_hash FROM audit_entry WHERE seq = 1")
    )[0];
    expect(head).toBeDefined();

    // Both branches would be internally consistent; only the unique index over
    // previous_hash tells them apart.
    await db.query(
      `INSERT INTO audit_entry (seq, id, event_type, recorded_at, actor, subject, input_digests,
         decision, previous_hash, entry_hash)
       VALUES (2, 'aud_branch_a', 'run.ended', $1, '{"actorId":"a","kind":"system","roles":[]}'::jsonb,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $2, $3)`,
      [T0, head?.entry_hash, "sha256:" + "a".repeat(64)],
    );

    await expect(
      db.query(
        `INSERT INTO audit_entry (seq, id, event_type, recorded_at, actor, subject, input_digests,
           decision, previous_hash, entry_hash)
         VALUES (3, 'aud_branch_b', 'run.ended', $1, '{"actorId":"a","kind":"system","roles":[]}'::jsonb,
           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $2, $3)`,
        [T0, head?.entry_hash, "sha256:" + "b".repeat(64)],
      ),
    ).rejects.toThrow();
  });

  it("refuses a timestamp that is not the platform's UTC wire form", async () => {
    await expect(
      db.query(
        `INSERT INTO audit_entry (seq, id, event_type, recorded_at, actor, subject, input_digests,
           decision, previous_hash, entry_hash)
         VALUES (99, 'aud_bad_time', 'run.ended', '2026-08-06 12:00:00+02',
           '{"actorId":"a","kind":"system","roles":[]}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
           $1, $2)`,
        ["sha256:" + "c".repeat(64), "sha256:" + "d".repeat(64)],
      ),
    ).rejects.toThrow();
  });
});

/**
 * An unreadable store and an empty one must never look the same.
 *
 * One means "nothing happened"; the other means "we do not know what
 * happened", and a reader that cannot tell them apart will report the second
 * as the first. Every read below has to refuse rather than return nothing.
 */
describe.skipIf(!CONNECTION_STRING)("a store that cannot answer refuses", () => {
  let pool: pg.Pool;
  let db: PgDb;

  beforeAll(() => {
    // A real connection string pointed at a database that does not exist, so
    // failures come from the driver rather than from a mock that might be
    // kinder than the real thing.
    pool = new pg.Pool({
      // Replace the database name whatever it is called. Matching a literal
      // "/pv_test" would be a silent no-op against any other name, and these
      // tests would then run against the real database and assert that a
      // working store fails.
      connectionString: (CONNECTION_STRING ?? "").replace(
        /\/[^/?]*(?=\?|$)/,
        "/pv_absent_database",
      ),
      max: 2,
      connectionTimeoutMillis: 2_000,
    });
    db = new PgDb(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("refuses reads of the operating record", async () => {
    const runs = new PgRunStore(db, new FixedClock(T0), new SeededIdGenerator("unreachable"));
    await expect(runs.listRuns()).rejects.toBeInstanceOf(DeniedError);
    await expect(runs.getRun("run_1" as Id<"run">)).rejects.toBeInstanceOf(DeniedError);
    await expect(runs.countRuns()).rejects.toBeInstanceOf(DeniedError);
    await expect(runs.listSteps("run_1" as Id<"run">)).rejects.toBeInstanceOf(DeniedError);
    await expect(runs.findStepByIdempotencyKey("k")).rejects.toBeInstanceOf(DeniedError);
    await expect(runs.costSince(T0)).rejects.toBeInstanceOf(DeniedError);
    await expect(runs.costForRun("run_1" as Id<"run">)).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses writes to the operating record", async () => {
    const runs = new PgRunStore(db, new FixedClock(T0), new SeededIdGenerator("unreachable"));
    await expect(runs.createRun(aRun())).rejects.toBeInstanceOf(DeniedError);
    await expect(
      runs.appendStep(aStep("run_1" as Id<"run">, { idempotencyKey: "k" })),
    ).rejects.toBeInstanceOf(DeniedError);
    await expect(
      runs.recordCost({ runId: "run_1" as Id<"run">, category: "model", amountUsd: 1, recordedAt: T0 }),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses to report an audit chain it cannot read", async () => {
    const audit = new PgAuditStore(db);
    await expect(audit.readAuditChain()).rejects.toBeInstanceOf(DeniedError);
    await expect(audit.auditHead()).rejects.toBeInstanceOf(DeniedError);
    await expect(audit.countAuditEntries()).rejects.toBeInstanceOf(DeniedError);

    // And the write path refuses, which is what stops an action proceeding
    // unrecorded: AuditLog turns this into the denial the caller sees.
    const log = new AuditLog(audit, new FixedClock(T0), new SeededIdGenerator("unreachable"));
    await expect(
      log.record(auditDecision({ eventType: "run.started", actorId: "a", actorKind: "system" })),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses approval and containment reads rather than reporting nothing pending", async () => {
    const approvals = new PgApprovalStore(db);
    const containment = new PgContainmentStore(db);
    await expect(approvals.listApprovals()).rejects.toBeInstanceOf(DeniedError);
    await expect(approvals.getApproval("apr_1" as Id<"approval">)).rejects.toBeInstanceOf(
      DeniedError,
    );
    await expect(approvals.expireApprovals(T0)).rejects.toBeInstanceOf(DeniedError);
    // An unreadable switch must not read as "not paused".
    await expect(containment.getSwitch("global", "")).rejects.toBeInstanceOf(DeniedError);
    await expect(containment.listSwitches()).rejects.toBeInstanceOf(DeniedError);
  });
});
