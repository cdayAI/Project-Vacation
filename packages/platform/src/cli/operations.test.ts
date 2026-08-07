import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FixedClock } from "../kernel/clock.js";
import { loadConfig } from "../kernel/config.js";
import { digestValue } from "../kernel/hash.js";
import { SeededIdGenerator, type Id } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { defineWorkflow } from "../engine/definition.js";
import type { WorkflowStep } from "../engine/types.js";
import { buildPlatform, type Platform } from "../platform.js";
import { commandOperations, type CommandArgs } from "./operations.js";

/**
 * The four verbs the runbooks send an operator to.
 *
 * `pass6-runbook-commands.test.ts` proves each one is dispatched. That is not
 * the same as proving it answers, and the difference is the whole finding: a
 * command that exists and prints nothing useful still leaves a responder with
 * nothing at three in the morning. These assert the answers.
 *
 * Every one runs against a platform built the way the composition root builds
 * it, with a fixed clock, because two of these reports are entirely about
 * elapsed time and a report that reads the wall clock cannot be asserted on.
 */

const START = "2026-08-07T12:00:00.000Z";

const REQUESTER = { actorId: "act_operator", kind: "human" as const, roles: ["owner_services"] };

function args(line: string): CommandArgs {
  const tokens = line.split(" ").filter((token) => token.length > 0);
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        (flags[token.slice(2)] ??= []).push("true");
      } else {
        (flags[token.slice(2)] ??= []).push(next);
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags, json: flags["json"] !== undefined };
}

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(platform: Platform, line: string): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (message?: unknown) => out.push(String(message));
  console.error = (message?: unknown) => err.push(String(message));
  try {
    const code = await commandOperations(args(line), { platform });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

describe("the operator reports the runbooks call for", () => {
  let platform: Platform;
  let clock: FixedClock;

  beforeEach(async () => {
    clock = new FixedClock(START);
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock,
      ids: new SeededIdGenerator("operations"),
      logger: createNullLogger(),
    });
  });

  afterEach(async () => {
    await platform.close();
  });

  // ------------------------------------------------- SPEND-CEILING-APPROACHING

  describe("cost report", () => {
    async function seedSpend(): Promise<{ loop: Id<"run">; ordinary: Id<"run"> }> {
      const loop = await platform.runs.createRun({
        kind: "rescission.verify",
        mode: "supervised",
        requestedBy: REQUESTER,
        subject: { contractId: "ctr_0001" },
        correlationId: "cor_loop",
        roleId: "rol_verifier" as Id<"role">,
        roleVersion: 3,
      });
      const ordinary = await platform.runs.createRun({
        kind: "intake.triage",
        mode: "assisted",
        requestedBy: REQUESTER,
        subject: { contractId: "ctr_0002" },
        correlationId: "cor_ordinary",
      });
      for (let i = 0; i < 20; i += 1) {
        await platform.runs.recordCost({
          runId: loop.id,
          category: "model",
          amountUsd: 0.5,
          recordedAt: START,
        });
      }
      await platform.runs.recordCost({
        runId: ordinary.id,
        category: "integration",
        amountUsd: 1,
        recordedAt: START,
      });
      return { loop: loop.id, ordinary: ordinary.id };
    }

    it("answers the question the alert asks: one run, or many", async () => {
      const { loop } = await seedSpend();
      const result = await run(platform, "cost report --json");

      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as {
        totalUsd: number;
        runs: number;
        largestRunShare: number;
        runsByCost: { runId: string; totalUsd: number; entries: number }[];
        grouped: Record<string, { key: string; totalUsd: number }[]>;
      };

      expect(report.totalUsd).toBeCloseTo(11, 10);
      expect(report.runs).toBe(2);
      // The signature of a loop: one run holding most of the window, with far
      // more entries than anything else in it.
      expect(report.runsByCost[0]?.runId).toBe(loop);
      expect(report.runsByCost[0]?.entries).toBe(20);
      expect(report.largestRunShare).toBeCloseTo(10 / 11, 3);
      expect(report.grouped["workflow"]?.[0]).toMatchObject({ key: "rescission.verify" });
      expect(report.grouped["role"]?.[0]).toMatchObject({ key: "rol_verifier v3" });
    });

    it("counts money by when it was recorded, so it agrees with the ceiling that fired", async () => {
      const run_ = await platform.runs.createRun({
        kind: "rescission.verify",
        mode: "supervised",
        requestedBy: REQUESTER,
        subject: { contractId: "ctr_0003" },
        correlationId: "cor_long",
      });
      // A case opened two days ago that spent money five minutes ago. Counting
      // by when the run started would leave it out of today's report while the
      // daily ceiling counts every cent of it.
      await platform.runs.recordCost({
        runId: run_.id,
        category: "model",
        amountUsd: 7,
        recordedAt: "2026-08-07T11:55:00.000Z",
      });

      const result = await run(platform, "cost report --json");
      const report = JSON.parse(result.stdout) as { totalUsd: number; runs: number };
      expect(report.totalUsd).toBeCloseTo(7, 10);
      expect(report.runs).toBe(1);
      expect(report.totalUsd).toBeCloseTo(
        await platform.runs.costSince("2026-08-06T12:00:00.000Z"),
        10,
      );
    });

    it("does not read an empty window as evidence that nothing was spent", async () => {
      const result = await run(platform, "cost report");
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/No spend was recorded in this window/);
      expect(result.stdout).toMatch(/not the same as no spend/);
    });

    it("refuses a grouping it cannot compute rather than silently dropping it", async () => {
      await seedSpend();
      const result = await run(platform, "cost report --group-by workflow,department");
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/"department" is not a grouping/);
    });

    it("keeps stdout parseable so a report can be filed as evidence", async () => {
      await seedSpend();
      const result = await run(platform, "cost report --json");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
  });

  // ---------------------------------------------------- APPROVAL-QUEUE-AGEING

  describe("approvals list", () => {
    async function park(summary: string, ttlMs: number): Promise<string> {
      const request = await platform.approvals.request({
        action: "contact.send_owner_message",
        proposalDigest: digestValue({ summary }),
        summary,
        requestedBy: REQUESTER,
        approvalsRequired: 2,
        eligibleRoles: ["supervisor", "compliance"],
        subject: { contractId: "ctr_0001" },
        ttlMs,
      });
      return request.id;
    }

    it("keeps only what is close to expiry, least time left first", async () => {
      const soon = await park("expires in half an hour", 30 * 60 * 1000);
      await park("expires tomorrow", 24 * 60 * 60 * 1000);

      const result = await run(platform, "approvals list --status pending --ageing --json");
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as {
        approvals: { approvalId: string; expiresInMs: number }[];
      };
      expect(report.approvals.map((line) => line.approvalId)).toEqual([soon]);
    });

    it("carries who may decide and how far through N-of-M the request is", async () => {
      await park("needs two people", 30 * 60 * 1000);
      const result = await run(platform, "approvals list --ageing --json");
      const report = JSON.parse(result.stdout) as {
        approvals: {
          eligibleRoles: string[];
          grantsSoFar: number;
          approvalsRequired: number;
          subject: Record<string, string>;
        }[];
      };
      // The runbook's action is "notify the eligible approver roles". That is
      // not a step anybody can take from a list that omits them.
      expect(report.approvals[0]?.eligibleRoles).toEqual(["supervisor", "compliance"]);
      expect(report.approvals[0]?.grantsSoFar).toBe(0);
      expect(report.approvals[0]?.approvalsRequired).toBe(2);
      expect(report.approvals[0]?.subject).toEqual({ contractId: "ctr_0001" });
    });

    it("exits non-zero on a pending approval past its expiry, and says what that means", async () => {
      await park("nobody decided this", 30 * 60 * 1000);
      clock.advance(60 * 60 * 1000);

      const result = await run(platform, "approvals list --status pending --ageing");
      // Two facts at once: that decision is no longer usable, and nothing swept
      // it — expiry is a maintenance pass, so this is also evidence about the
      // worker.
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/EXPIRED/);
      expect(result.stderr).toMatch(/pv worker/);
    });

    it("counts only grants toward N-of-M, never a rejection", async () => {
      const id = await park("one grant so far", 60 * 60 * 1000);
      await platform.approvals.decide({
        approvalId: id as Id<"approval">,
        actor: { actorId: "act_supervisor", kind: "human", roles: ["supervisor"] },
        decision: "granted",
        steppedUp: true,
      });

      const result = await run(platform, "approvals list --status pending --json");
      const report = JSON.parse(result.stdout) as { approvals: { grantsSoFar: number }[] };
      expect(report.approvals[0]?.grantsSoFar).toBe(1);
    });

    it("refuses a status that is not one, rather than reporting an empty queue", async () => {
      const result = await run(platform, "approvals list --status waiting");
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/"waiting" is not an approval status/);
    });
  });

  // ---------------------------------------------------- MODEL-PROVIDER-DEGRADED

  describe("models degradation", () => {
    it("refuses to let a deployment that never called a model look healthy", async () => {
      const result = await run(platform, "models degradation");
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/No model call was recorded in this window at all/);
      expect(result.stdout).toMatch(/not evidence that the models are healthy/);
    });

    it("reads the record the alert is raised from, and groups the walks by cause", async () => {
      // `model.degraded` is what the alert fires on, so it is what the check an
      // operator runs has to read. Recorded here the way the gateway records it.
      for (const [from, to, reason] of [
        ["primary-1", "fallback-1", "unavailable"],
        ["primary-1", "fallback-1", "unavailable"],
        ["primary-1", "fallback-1", "rate_limited"],
      ] as const) {
        await platform.audit.record({
          eventType: "model.degraded",
          actor: REQUESTER,
          subject: { task: "rescission.summarise" },
          decision: { task: "rescission.summarise", fromModelId: from, toModelId: to, reason },
        });
      }
      await platform.audit.record({
        eventType: "model.invoked",
        actor: REQUESTER,
        subject: { task: "rescission.summarise" },
        decision: { task: "rescission.summarise", outcome: "failed", failureKind: "unavailable" },
      });

      const result = await run(platform, "models degradation --json");
      const report = JSON.parse(result.stdout) as {
        degradations: number;
        exhaustedCalls: number;
        byReason: { key: string; count: number }[];
        byHop: { key: string; count: number }[];
      };
      expect(report.degradations).toBe(3);
      expect(report.byReason[0]).toEqual({ key: "unavailable", count: 2 });
      expect(report.byHop[0]).toEqual({ key: "primary-1 → fallback-1", count: 3 });

      // A chain that ran out is a refusal, not a degradation, and the runbook
      // escalates it. Non-zero so it can be wired to something.
      expect(report.exhaustedCalls).toBe(1);
      expect(result.code).toBe(1);
    });
  });

  // ------------------------------------------------------ STATUTORY-TIMER-LATE

  describe("engine timers", () => {
    async function startTimerCase(contractId: string): Promise<void> {
      platform.catalogue.publish(
        defineWorkflow({
          name: "rescission.window",
          version: 1,
          description: "Hold the case open until the statutory rescission window closes.",
          mode: "supervised",
          steps: [
            {
              name: "await_deadline",
              type: "timer",
              description: "wait for the statutory rescission deadline",
              schedule: { kind: "duration", ms: 60 * 60 * 1000 },
              next: "close",
            } as WorkflowStep,
            {
              name: "close",
              type: "human_task",
              description: "close the case",
              title: "Close the case",
              assignedRoles: ["supervisor"],
            } as WorkflowStep,
          ],
        }),
      );
      const instance = await platform.engine.start({
        workflow: "rescission.window",
        requestedBy: REQUESTER,
        subject: { contractId },
      });
      await platform.engine.tick(instance.id);
    }

    it("names the affected contracts, which is the runbook's first instruction", async () => {
      await startTimerCase("ctr_0001");
      clock.advance(2 * 60 * 60 * 1000);

      const result = await run(platform, "engine timers --overdue --json");
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as {
        count: number;
        timers: {
          subject: Record<string, string>;
          workflow: string;
          step: string;
          lateByMs: number;
        }[];
      };
      expect(report.count).toBe(1);
      // A responder who did not write the workflow needs the case reference,
      // not the instance id, because the deadline belongs to a contract and the
      // manual handling happens against that contract.
      expect(report.timers[0]?.subject).toEqual({ contractId: "ctr_0001" });
      expect(report.timers[0]?.workflow).toBe("rescission.window");
      expect(report.timers[0]?.step).toBe("await_deadline");
      expect(report.timers[0]?.lateByMs).toBe(60 * 60 * 1000);
    });

    it("holds its fire below the threshold the alert uses", async () => {
      await startTimerCase("ctr_0001");
      clock.advance(60 * 60 * 1000 + 30_000); // due, but only thirty seconds late

      const result = await run(platform, "engine timers --overdue");
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/No timer is more than 60s past due/);
    });

    it("lists timers that have not fired yet, so a deadline can be seen coming", async () => {
      await startTimerCase("ctr_0001");
      const result = await run(platform, "engine timers --json");
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as { timers: { lateByMs: number }[] };
      expect(report.timers).toHaveLength(1);
      // Negative: not due yet. A report that showed this as late would page
      // somebody for a deadline that is an hour away.
      expect(report.timers[0]?.lateByMs).toBe(-60 * 60 * 1000);
    });

    it("says an empty list is not proof that timers can fire", async () => {
      const result = await run(platform, "engine timers --overdue");
      expect(result.code).toBe(0);
      // The failure this whole verb was written for: nothing scheduled and
      // nothing sweeping print the same empty table.
      expect(result.stderr).toMatch(/pv worker/);
    });
  });

  it("prints usage and exits non-zero on a subcommand that does not exist", async () => {
    const result = await run(platform, "cost summary");
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Unknown cost subcommand: summary/);
  });
});
