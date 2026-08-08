import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock } from "../kernel/clock.js";
import { loadConfig } from "../kernel/config.js";
import { DeniedError } from "../kernel/errors.js";
import { SeededIdGenerator, type Id } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { buildPlatform, migrate, type Platform } from "../platform.js";
import type { ActorRef } from "../record/types.js";
import type { GoldenSet } from "../roles/types.js";
import { commandRoles, type CommandArgs, type RolesCommandContext } from "./roles.js";
import { commandEvaluate } from "./evaluate.js";

/**
 * The role factory, driven through the surface an operator actually has.
 *
 * These are not the promotion service's own tests — those live in
 * `roles/roles.test.ts` and prove the rules in isolation. These prove the
 * wiring: that `buildPlatform` composes the factory at all, that the CLI reaches
 * the one composed instance, and that a role authored from a terminal can be
 * drafted, evaluated, proposed, approved, promoted, reverted, and disabled —
 * ending, on Postgres, as a role `pv evaluate --ci` actually measures. Before
 * this file the factory had no caller outside its own tests, so every one of
 * these paths was unreachable.
 */

const START = "2026-08-06T12:00:00.000Z";
const GOLDEN_SET_ID = "cli_rescission_intake_cases";
const TASK = "contact.classify_owner_intent";

const ADMIN: ActorRef = { actorId: "cli:admin", kind: "human", roles: ["platform_admin", "scope:legal"] };
const SUPERVISOR: ActorRef = { actorId: "act_supervisor", kind: "human", roles: ["supervisor", "scope:legal"] };
const AGENT: ActorRef = { actorId: "act_agent", kind: "human", roles: ["owner_services_agent", "scope:legal"] };

/** The plain-language brief that yields the two contract actions and a sensitive ceiling. */
const DESCRIPTION =
  "Check whether a contract is still inside its rescission window, and flag anything doubtful for a compliance reviewer.";

function goldenSet(overrides: Partial<GoldenSet> = {}): GoldenSet {
  return {
    id: GOLDEN_SET_ID,
    version: 1,
    task: TASK,
    synthetic: true,
    // Every case asserts only that the platform answers at all, so the scripted
    // stand-in clears it and this test is about the wiring, not model quality.
    threshold: 0.5,
    curatedBy: "compliance-operations",
    curatedAt: START,
    cases: [
      {
        id: "cancel-plain",
        description: "A plain cancellation request.",
        input: {
          categories: "rescission_request,billing_dispute,general_enquiry",
          message: "I signed on Tuesday and I would like to cancel.",
        },
        expected: { kind: "any" },
        tags: [],
        curatedBy: "compliance-operations",
        curatedAt: START,
      },
      {
        id: "cancel-verbose",
        description: "A wordier cancellation request.",
        input: {
          categories: "rescission_request,billing_dispute,general_enquiry",
          message: "Further to my visit, I wish to unwind the contract I signed.",
        },
        expected: { kind: "any" },
        tags: [],
        curatedBy: "compliance-operations",
        curatedAt: START,
      },
    ],
    ...overrides,
  };
}

function writeGoldenSet(set: GoldenSet): string {
  const dir = mkdtempSync(join(tmpdir(), "pv-roles-cli-"));
  const path = join(dir, "golden.json");
  writeFileSync(path, JSON.stringify(set), "utf8");
  return path;
}

function args(line: string): CommandArgs {
  const tokens = tokenize(line);
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

/** Split on spaces, but keep a single-quoted run together so a flag can carry a sentence. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  const pattern = /'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) out.push(match[1] ?? match[2] ?? "");
  return out;
}

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly thrown?: unknown;
}

async function capture(
  platform: Platform,
  line: string,
  actor: ActorRef = ADMIN,
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (message?: unknown) => out.push(String(message));
  console.error = (message?: unknown) => err.push(String(message));
  const context: RolesCommandContext = { platform, actor };
  try {
    const code = await commandRoles(args(line), context);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } catch (thrown) {
    return { code: 1, stdout: out.join("\n"), stderr: err.join("\n"), thrown };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

async function run(platform: Platform, line: string, actor: ActorRef = ADMIN): Promise<Captured> {
  const result = await capture(platform, line, actor);
  if (result.thrown) throw result.thrown;
  return result;
}

/** Draft, publish the golden set, evaluate, and propose a role through the CLI. */
async function proposed(platform: Platform): Promise<{ roleId: string; evaluationRunId: string }> {
  const draft = await run(
    platform,
    `roles draft --name rescission_intake --description '${DESCRIPTION}' --scope legal --model-task ${TASK} --prompt-template ${TASK} --prompt-version 1 --evaluation-set ${GOLDEN_SET_ID}`,
  );
  const roleId = draft.stdout.trim();

  await run(platform, `roles golden publish --file ${writeGoldenSet(goldenSet())}`);

  const propose = await run(platform, "roles propose --role rescission_intake");
  return { roleId, evaluationRunId: propose.stdout.trim() };
}

/** Raise the promotion approval and grant it as a different, eligible person. */
async function grantedApproval(
  platform: Platform,
  evaluationRunId: string,
): Promise<string> {
  const raised = await run(
    platform,
    `roles promote --role rescission_intake --version 1 --evaluation-run ${evaluationRunId} --raise-approval`,
  );
  const approvalId = raised.stdout.trim();

  // The grant is the approver's act, through the same service `pv approvals
  // decide` posts to. A different person, an eligible role, and an observed
  // step-up — none of which this promoter could supply for themselves.
  await platform.approvals.decide({
    approvalId: approvalId as Id<"approval">,
    actor: SUPERVISOR,
    decision: "granted",
    requiresStepUp: true,
    secondsSinceAuthentication: 5,
    stepUpMaxAgeSeconds: 300,
  });
  return approvalId;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe("the composition root wires the role factory", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("roles-cli"),
      logger: createNullLogger(),
    });
  });

  afterEach(async () => {
    await platform.close();
  });

  it("exposes the registry, the promotion service, and the stores they share", () => {
    expect(platform.roles).toBeDefined();
    expect(platform.rolePromotion).toBeDefined();
    expect(platform.roleStore).toBeDefined();
    expect(platform.evaluations).toBeDefined();
    expect(platform.inventory).toBeDefined();
    expect(platform.templates).toBeDefined();
  });

  it("registers the role lifecycle actions in the one chokepoint", () => {
    // Without these the promotion service's propose, the harness's evaluate, and
    // the registry's revert are each refused with an unknown-action error the
    // moment they are reached — which is why they never were.
    for (const action of ["role.promote", "role.propose", "role.evaluate", "role.revert"]) {
      expect(platform.registry.get(action), `${action} must be registered`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The lifecycle, driven through the CLI
// ---------------------------------------------------------------------------

describe("pv roles, end to end", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("roles-cli"),
      logger: createNullLogger(),
    });
  });

  afterEach(async () => {
    await platform.close();
  });

  it("drafts an inert role that cannot act", async () => {
    const draft = await run(
      platform,
      `roles draft --name rescission_intake --description '${DESCRIPTION}' --scope legal --model-task ${TASK} --prompt-template ${TASK} --prompt-version 1 --evaluation-set ${GOLDEN_SET_ID}`,
    );
    const roleId = draft.stdout.trim();

    const version = await platform.roleStore.requireVersion(roleId as Id<"role">, 1);
    expect(version.status).toBe("draft");
    expect(draft.stderr).toMatch(/CANNOT act/);

    // The structural claim behind the status: nothing it declares can be
    // authorised, because it has not been promoted.
    await expect(
      platform.rolePromotion.authorizeRoleAction({
        roleId: roleId as Id<"role">,
        action: "contract.check_rescission",
        actor: AGENT,
        mode: "assisted",
        requiredScopes: ["legal"],
      }),
    ).rejects.toMatchObject({ reason: "role.not_promoted" });
  });

  it("refuses to promote without recorded evaluation evidence", async () => {
    await run(
      platform,
      `roles draft --name rescission_intake --description '${DESCRIPTION}' --scope legal --model-task ${TASK} --prompt-template ${TASK} --prompt-version 1 --evaluation-set ${GOLDEN_SET_ID}`,
    );

    // No propose, so no evidence exists. Promotion cites a run that is not in
    // the record, and the service refuses on that ground before anything else.
    const result = await capture(
      platform,
      "roles promote --role rescission_intake --version 1 --evaluation-run evl_nothing --approval apr_nothing --reauthenticated",
    );
    expect(result.thrown).toBeInstanceOf(DeniedError);
    expect((result.thrown as DeniedError).reason).toBe("record.unavailable");
    expect(await platform.roleStore.promotedVersion((await platform.roles.findByName("rescission_intake"))!.id)).toBeNull();
  });

  it("refuses to promote without an approval, even with real evidence", async () => {
    const { evaluationRunId } = await proposed(platform);

    const result = await capture(
      platform,
      `roles promote --role rescission_intake --version 1 --evaluation-run ${evaluationRunId} --approval apr_missing --reauthenticated`,
    );
    expect(result.thrown).toBeInstanceOf(DeniedError);
    expect((result.thrown as DeniedError).reason).toBe("approval.required");
    const role = await platform.roles.findByName("rescission_intake");
    expect(await platform.roleStore.promotedVersion(role!.id)).toBeNull();
  });

  it("refuses to promote without the promoter's re-authentication", async () => {
    const { evaluationRunId } = await proposed(platform);
    const approvalId = await grantedApproval(platform, evaluationRunId);

    // Everything is in place except the promoter asserting a fresh step-up.
    const result = await capture(
      platform,
      `roles promote --role rescission_intake --version 1 --evaluation-run ${evaluationRunId} --approval ${approvalId}`,
    );
    expect(result.thrown).toBeInstanceOf(DeniedError);
    expect((result.thrown as DeniedError).reason).toBe("authorization.step_up_required");
  });

  it("promotes on evidence and a granted approval, and only then can the role act", async () => {
    const { roleId, evaluationRunId } = await proposed(platform);
    const approvalId = await grantedApproval(platform, evaluationRunId);

    const promote = await run(
      platform,
      `roles promote --role rescission_intake --version 1 --evaluation-run ${evaluationRunId} --approval ${approvalId} --reauthenticated`,
    );
    expect(promote.code).toBe(0);
    expect(promote.stdout.trim()).toBe("1");

    const promoted = await platform.roleStore.promotedVersion(roleId as Id<"role">);
    expect(promoted?.version).toBe(1);
    expect(promoted?.evidence?.approvalId).toBe(approvalId);
    expect(promoted?.evidence?.evaluationRunId).toBe(evaluationRunId);

    // A drafted role is promoted shadow-only — the conservative default the
    // authoring step warns about — so it cannot yet perform its sensitive
    // action. That is exactly the state the evaluation gate reads: it measures
    // promoted roles in shadow. The role's version now carries its evidence,
    // which is what makes it evaluable rather than merely present.
    expect(promoted?.definition.operatingModes).toEqual(["shadow"]);
    expect(promoted?.status).toBe("promoted");
  });

  it("disables a promoted role instantly, through containment", async () => {
    const { roleId, evaluationRunId } = await proposed(platform);
    const approvalId = await grantedApproval(platform, evaluationRunId);
    await run(
      platform,
      `roles promote --role rescission_intake --version 1 --evaluation-run ${evaluationRunId} --approval ${approvalId} --reauthenticated`,
    );

    expect((await platform.roleStore.promotedVersion(roleId as Id<"role">))?.version).toBe(1);

    const disabled = await run(
      platform,
      "roles disable --role rescission_intake --reason 'wrong category on Nevada contracts'",
    );
    expect(disabled.code).toBe(0);

    // Immediate, in the same call, with no deploy: the containment switch is
    // engaged and the promoted version is disabled by the time disable returns.
    expect(await platform.containment.isEngaged("role", roleId as Id<"role">)).toBe(true);
    expect(await platform.roleStore.promotedVersion(roleId as Id<"role">)).toBeNull();
    const version = await platform.roleStore.requireVersion(roleId as Id<"role">, 1);
    expect(version.status).toBe("disabled");

    // And it cannot act: whichever refusal comes first, the role is stopped.
    await expect(
      platform.rolePromotion.authorizeRoleAction({
        roleId: roleId as Id<"role">,
        action: "contract.check_rescission",
        actor: AGENT,
        mode: "assisted",
        requiredScopes: ["legal"],
      }),
    ).rejects.toThrow(DeniedError);

    // Enable brings it back, releasing the switch.
    const enabled = await run(
      platform,
      "roles enable --role rescission_intake --version 1 --reason 'fix confirmed'",
    );
    expect(enabled.code).toBe(0);
    expect(await platform.containment.isEngaged("role", roleId as Id<"role">)).toBe(false);
    expect((await platform.roleStore.promotedVersion(roleId as Id<"role">))?.version).toBe(1);
  });

  it("reverts to a previously promoted version", async () => {
    const { roleId, evaluationRunId } = await proposed(platform);
    const approvalId = await grantedApproval(platform, evaluationRunId);
    await run(
      platform,
      `roles promote --role rescission_intake --version 1 --evaluation-run ${evaluationRunId} --approval ${approvalId} --reauthenticated`,
    );

    // A second version is authored, evaluated, proposed, approved, and promoted,
    // so v1 becomes a version there is something to roll back to.
    await run(
      platform,
      "roles draft --name rescission_intake --description 'Check whether a contract is still inside its rescission window, and flag anything doubtful for a compliance reviewer. Nevada handling clarified.' --scope legal --model-task " +
        `${TASK} --prompt-template ${TASK} --prompt-version 1 --evaluation-set ${GOLDEN_SET_ID}`,
    );
    const propose2 = await run(platform, "roles propose --role rescission_intake --version 2");
    const evaluation2 = propose2.stdout.trim();
    const raise2 = await run(
      platform,
      `roles promote --role rescission_intake --version 2 --evaluation-run ${evaluation2} --raise-approval`,
    );
    await platform.approvals.decide({
      approvalId: raise2.stdout.trim() as Id<"approval">,
      actor: SUPERVISOR,
      decision: "granted",
      requiresStepUp: true,
      secondsSinceAuthentication: 5,
      stepUpMaxAgeSeconds: 300,
    });
    await run(
      platform,
      `roles promote --role rescission_intake --version 2 --evaluation-run ${evaluation2} --approval ${raise2.stdout.trim()} --reauthenticated`,
    );
    expect((await platform.roleStore.promotedVersion(roleId as Id<"role">))?.version).toBe(2);

    // Roll back to v1. A revert appends a new version restoring the old
    // definition and carries its evidence forward; it does not resurrect v1.
    const revert = await run(
      platform,
      "roles revert --role rescission_intake --to-version 1 --reason 'v2 regressed on Nevada'",
    );
    expect(revert.code).toBe(0);
    const promoted = await platform.roleStore.promotedVersion(roleId as Id<"role">);
    expect(promoted?.version).toBe(3);
    expect(promoted?.restoredFromVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The gate — proved against the store the gate actually reads
// ---------------------------------------------------------------------------

const CONNECTION_STRING = process.env.PV_TEST_DATABASE_URL;

describe.skipIf(!CONNECTION_STRING)("a promoted role becomes visible to pv evaluate --ci", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await buildPlatform(
      loadConfig({
        PV_ENV: "development",
        PV_STORE: "postgres",
        PV_DATABASE_URL: CONNECTION_STRING,
      }),
      { logger: createNullLogger() },
    );
    await migrate(platform);
    // Start from an empty registry so the gate measures only what this test
    // promotes, not a role a previous run left behind — and clear any
    // containment switch a prior test file engaged, since the suite shares this
    // database and runs its files in sequence.
    await platform.db!.query(
      "TRUNCATE agent_role, agent_role_version, role_golden_set, role_evaluation_run, containment_switch RESTART IDENTITY CASCADE",
    );
  });

  afterEach(async () => {
    await platform.close();
  });

  it("stops reporting NOTHING WAS EVALUATED once a role is promoted, and the gate passes", async () => {
    // Before any promotion, --ci runs the shipped baseline and says, loudly,
    // that this deployment's registry measured nothing.
    const before = await runEvaluate(platform, "evaluate --ci --json");
    expect(before.stderr).toMatch(/NOTHING IN THIS DEPLOYMENT'S ROLE REGISTRY WAS EVALUATED/);
    const beforeJson = JSON.parse(before.stdout) as { registry: { evaluated: boolean; outcomes: unknown[] } };
    expect(beforeJson.registry.evaluated).toBe(false);

    // Author, evaluate, propose, approve, and promote a role through the CLI.
    const { evaluationRunId } = await proposed(platform);
    const approvalId = await grantedApproval(platform, evaluationRunId);
    await run(
      platform,
      `roles promote --role rescission_intake --version 1 --evaluation-run ${evaluationRunId} --approval ${approvalId} --reauthenticated`,
    );

    // Now the gate measures the promoted role. The banner is gone, the registry
    // reports what it evaluated, and the build stays green.
    const after = await runEvaluate(platform, "evaluate --ci --json");
    expect(after.code).toBe(0);
    expect(after.stderr).not.toMatch(/NOTHING IN THIS DEPLOYMENT'S ROLE REGISTRY WAS EVALUATED/);
    const afterJson = JSON.parse(after.stdout) as {
      registry: { evaluated: boolean; outcomes: { roleName: string; source: string; meetsThreshold: boolean }[] };
      passed: boolean;
    };
    expect(afterJson.registry.evaluated).toBe(true);
    expect(afterJson.registry.outcomes.some((o) => o.roleName === "rescission_intake" && o.source === "registry")).toBe(
      true,
    );
    expect(afterJson.passed).toBe(true);
  });
});

/** Drive `commandEvaluate`, capturing the streams the same way the roles harness does. */
async function runEvaluate(platform: Platform, line: string): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (message?: unknown) => out.push(String(message));
  console.error = (message?: unknown) => err.push(String(message));
  try {
    const code = await commandEvaluate(args(line), { platform, actor: ADMIN });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

// ---------------------------------------------------------------------------
// Fairness — `analyseFairness`, reachable through the operator surface
// ---------------------------------------------------------------------------

const COHORT_SET_ID = "cli_fairness_cases";

/**
 * A synthetic golden set whose cases carry an invented protected attribute.
 *
 * When `disparate`, cohort B asserts an exact answer the scripted stand-in will
 * never produce, so both of B's cases fail and B's favourable rate falls to
 * zero — the disparity the four-fifths rule is meant to catch.
 */
function cohortGoldenSet(disparate: boolean): GoldenSet {
  const cohortCase = (id: string, cohort: string, fail: boolean): GoldenSet["cases"][number] => ({
    id,
    description: `${cohort} case ${id}`,
    input: {
      categories: "rescission_request,billing_dispute,general_enquiry",
      message: `Owner message for case ${id}.`,
    },
    expected: fail
      ? { kind: "exact", value: "THIS_ANSWER_IS_NEVER_PRODUCED_BY_THE_STAND_IN" }
      : { kind: "any" },
    tags: [],
    protectedAttributes: { cohort },
    curatedBy: "compliance-operations",
    curatedAt: START,
  });
  return {
    id: COHORT_SET_ID,
    version: 1,
    task: TASK,
    synthetic: true,
    threshold: 0.1,
    curatedBy: "compliance-operations",
    curatedAt: START,
    cases: [
      cohortCase("a1", "A", false),
      cohortCase("a2", "A", false),
      cohortCase("b1", "B", disparate),
      cohortCase("b2", "B", disparate),
    ],
  };
}

/** Draft, publish a cohort-bearing golden set, and propose — recording a run to analyse. */
async function proposedWithCohorts(platform: Platform, disparate: boolean): Promise<string> {
  await run(
    platform,
    `roles draft --name rescission_intake --description '${DESCRIPTION}' --scope legal --model-task ${TASK} --prompt-template ${TASK} --prompt-version 1 --evaluation-set ${COHORT_SET_ID}`,
  );
  await run(platform, `roles golden publish --file ${writeGoldenSet(cohortGoldenSet(disparate))}`);
  const propose = await run(platform, `roles propose --role rescission_intake --golden-set ${COHORT_SET_ID}`);
  return propose.stdout.trim();
}

describe("pv roles fairness", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("roles-cli"),
      logger: createNullLogger(),
    });
  });

  afterEach(async () => {
    await platform.close();
  });

  it("measures a recorded run's outcome-rate disparities across protected groups", async () => {
    await proposedWithCohorts(platform, false);

    const report = await run(platform, "roles fairness --role rescission_intake --min-group 2");
    expect(report.code).toBe(0);
    expect(report.stdout).toContain("fairness on synthetic fixtures");
    // Both cohorts present, at parity, so nothing is flagged.
    expect(report.stdout).toContain("A: 2/2");
    expect(report.stdout).toContain("B: 2/2");
    expect(report.stdout).not.toContain("FLAGGED");
    // The caveats travel with the numbers, not beside them.
    expect(report.stdout).toContain("synthetic test fixtures");
    expect(report.stdout).toContain("the human is the decision-maker");
  });

  it("flags a group whose favourable rate falls below the four-fifths line", async () => {
    await proposedWithCohorts(platform, true);

    const report = await run(platform, "roles fairness --role rescission_intake --min-group 2");
    expect(report.code).toBe(0);
    expect(report.stdout).toContain("B: 0/2");
    expect(report.stdout).toContain("FLAGGED");
    expect(report.stdout).toMatch(/impact ratio 0 .* is below 0\.8/);
  });

  it("refuses fairness on a run not measured on synthetic fixtures", async () => {
    // A non-synthetic set carries no protected attributes and records a run
    // `analyseFairness` must refuse: this platform holds protected-class data
    // only as invented fixtures, never about real people.
    await run(
      platform,
      `roles draft --name rescission_intake --description '${DESCRIPTION}' --scope legal --model-task ${TASK} --prompt-template ${TASK} --prompt-version 1 --evaluation-set ${GOLDEN_SET_ID}`,
    );
    await run(platform, `roles golden publish --file ${writeGoldenSet(goldenSet({ synthetic: false }))}`);
    await run(platform, "roles propose --role rescission_intake");

    const result = await capture(platform, "roles fairness --role rescission_intake --min-group 2");
    expect(result.thrown).toBeInstanceOf(DeniedError);
    expect((result.thrown as DeniedError).reason).toBe("authorization.data_scope_violation");
  });

  it("refuses fairness when no run is recorded for the role", async () => {
    await run(
      platform,
      `roles draft --name rescission_intake --description '${DESCRIPTION}' --scope legal --model-task ${TASK} --prompt-template ${TASK} --prompt-version 1 --evaluation-set ${COHORT_SET_ID}`,
    );

    const result = await capture(platform, "roles fairness --role rescission_intake");
    expect(result.thrown).toBeInstanceOf(DeniedError);
    expect((result.thrown as DeniedError).reason).toBe("record.unavailable");
  });
});
