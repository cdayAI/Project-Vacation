import { describe, it, expect } from "vitest";
import { AuditLog } from "../audit/log.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import type { AuditEventType } from "../audit/types.js";
import { ApprovalService } from "../guard/approvals.js";
import { Authorizer } from "../guard/authorize.js";
import { CeilingEnforcer } from "../guard/ceilings.js";
import { ContainmentController } from "../guard/containment.js";
import { ActionRegistry } from "../guard/registry.js";
import { MemoryApprovalStore, MemoryContainmentStore } from "../guard/store.memory.js";
import { FixedClock, MINUTE, HOUR, DAY } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import { SeededIdGenerator, type Id } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { DEFAULT_PROMPT_TEMPLATES, PromptTemplateRegistry } from "../models/templates.js";
import { MemoryRunStore } from "../record/store.memory.js";
import type { ActorRef } from "../record/types.js";
import { MemoryEvaluationStore, MemoryRoleStore } from "../roles/store.memory.js";
import type {
  CaseResult,
  EvaluationRun,
  GoldenCase,
  GoldenSet,
  RoleDefinition,
} from "../roles/types.js";
import { MemoryDb } from "../store/db.js";
import { PLATFORM_ACTIONS } from "../actions.js";
import { APPLY_WITHOUT_APPROVAL_ACTION, IMPROVEMENT_ACTIONS } from "./actions.js";
import { ImprovementApplier } from "./apply.js";
import { ImprovementApprovalService, approvalDigest } from "./approve.js";
import { GovernedArtifacts } from "./artifacts.js";
import { clusterObservations, comparableRunCounts } from "./cluster.js";
import { ProposalEvaluator } from "./evaluate.js";
import { ObservationHarvester } from "./harvest.js";
import type { ProposalTrial, TrialRequest, TrialResult } from "./port.js";
import { ProposalDrafter } from "./propose.js";
import { createMemoryImprovementStores } from "./store.memory.js";
import type { Proposal } from "./types.js";
import { ImprovementWatch } from "./watch.js";

/**
 * The improvement loop, end to end and under attack.
 *
 * Two claims are on trial in this file, and everything else is scaffolding for
 * them.
 *
 * *The platform gets measurably better.* A correction becomes an observation,
 * observations become a ranked cluster, a cluster becomes a proposal, the
 * proposal is measured, a person approves it, and the change lands with a
 * snapshot behind it.
 *
 * *It never changes its own behaviour on its own authority.* The whole of
 * `describe("the gate")` is an attempt to make that false: no approval, a blank
 * approval, an approval of the wrong shape, one that does not exist, one still
 * pending, one rejected, one expired, one granted for a different proposal, one
 * already spent, a proposal never measured, a proposal that was withheld, a
 * proposal edited in the database after sign-off, an artifact that moved
 * underneath the approval, a containment switch pressed between approval and
 * application, and two processes racing. Each is asserted to be refused, and
 * each refusal is asserted to be in the audit chain.
 */

const NOW = "2026-08-06T12:00:00.000Z";
const TASK = "contact.classify_owner_intent";
const BINDING_ID = "rescission_intake.prompt";
const GOLDEN_SET_ID = "intake_cases";

const ADMIN: ActorRef = {
  actorId: "act_admin",
  kind: "human",
  roles: ["platform_admin", "scope:legal"],
};
const SUPERVISOR: ActorRef = {
  actorId: "act_supervisor",
  kind: "human",
  roles: ["supervisor", "scope:legal"],
};
const AGENT: ActorRef = {
  actorId: "act_agent",
  kind: "human",
  roles: ["owner_services_agent", "scope:legal"],
};

/**
 * The shipped catalogue plus this module's evidence-producing actions.
 *
 * Filtered by name so the day they move into `src/actions.ts` — where they
 * belong — this harness keeps working instead of failing on a duplicate
 * registration.
 */
const TEST_ACTIONS = [
  ...PLATFORM_ACTIONS,
  ...IMPROVEMENT_ACTIONS.filter(
    (action) => !PLATFORM_ACTIONS.some((entry) => entry.name === action.name),
  ),
];

/**
 * A second version of the task's prompt, committed in version control.
 *
 * The loop may propose *binding* to it. It could not have proposed its text:
 * a prompt binding holds an identifier and a version and has no field for
 * words.
 */
const TEMPLATES = new PromptTemplateRegistry([
  ...DEFAULT_PROMPT_TEMPLATES,
  {
    id: TASK,
    version: 2,
    task: TASK,
    system:
      "You classify inbound owner messages into a single routing category. State the jurisdiction you applied.",
    userTemplate: "Categories: {{categories}}\n\n<message>\n{{message}}\n</message>",
    variables: ["categories", "message"],
  },
]);

const INTAKE: RoleDefinition = {
  name: "rescission_intake",
  purpose: "Classify inbound owner messages and route anything doubtful to a reviewer.",
  actions: ["contract.check_rescission", "contract.flag_for_review"],
  riskCeiling: "sensitive",
  dataScopes: ["legal"],
  modelTask: TASK,
  promptTemplateId: TASK,
  promptTemplateVersion: 1,
  evaluationSetId: GOLDEN_SET_ID,
  humanTier: "automatic",
  operatingModes: ["shadow", "assisted", "supervised"],
};

function goldenCase(overrides: Partial<GoldenCase> & { id: string }): GoldenCase {
  return {
    description: `case ${overrides.id}`,
    input: { categories: "rescission_request,billing_dispute", message: "I want to cancel." },
    expected: { kind: "contains", values: ["rescission_request"] },
    tags: [],
    curatedBy: "compliance-operations",
    curatedAt: NOW,
    ...overrides,
  };
}

function goldenSet(): GoldenSet {
  return {
    id: GOLDEN_SET_ID,
    version: 1,
    task: TASK,
    synthetic: true,
    threshold: 0.6,
    curatedBy: "compliance-operations",
    curatedAt: NOW,
    cases: [
      goldenCase({ id: "cancel-plain" }),
      goldenCase({ id: "nevada-window" }),
      goldenCase({ id: "billing-not-rescission" }),
      goldenCase({ id: "ambiguous" }),
    ],
  };
}

function caseResult(caseId: string, outcome: CaseResult["outcome"]): CaseResult {
  return { caseId, outcome, detail: `case ${caseId}`, latencyMs: 1, costUsd: 0, tags: [] };
}

/**
 * A trial the test drives.
 *
 * Stands in for the shadow harness a deployment wires in. It records both runs
 * in the evaluation store, exactly as the real harness does, so the watch can
 * read the candidate's per-case results back later.
 */
class ScriptedTrial implements ProposalTrial {
  private next: ((request: TrialRequest) => TrialResult) | null = null;
  private readonly recorded: EvaluationRun[] = [];

  constructor(private readonly evaluations: MemoryEvaluationStore) {}

  script(builder: (request: TrialRequest) => TrialResult): void {
    this.next = builder;
  }

  async measure(request: TrialRequest): Promise<TrialResult> {
    if (!this.next) throw new Error("no trial scripted");
    const result = this.next(request);
    for (const run of [result.baseline, result.candidate]) {
      if (this.recorded.some((entry) => entry.id === run.id)) continue;
      this.recorded.push(run);
      await this.evaluations.recordEvaluation(run);
    }
    return result;
  }
}

function build() {
  const db = new MemoryDb();
  const clock = new FixedClock(NOW);
  const ids = new SeededIdGenerator("improve-test");

  const audit = new AuditLog(new MemoryAuditStore(db), clock, ids);
  const runs = new MemoryRunStore(db, clock, ids);
  const actions = new ActionRegistry(TEST_ACTIONS);
  // Zero cache window: an engaged switch has to be visible to the very next
  // check under a fixed clock, or the containment test would pass on staleness.
  const containment = new ContainmentController(new MemoryContainmentStore(db), clock, audit, 0);
  const ceilings = new CeilingEnforcer(
    {
      runSpendUsd: 100,
      dailySpendUsd: 1000,
      runWallClockMs: 365 * DAY,
      modelCallsPerMinute: 10_000,
    },
    clock,
    runs,
  );
  const approvals = new ApprovalService(new MemoryApprovalStore(db), clock, ids, audit);
  const authorizer = new Authorizer(actions, containment, ceilings, approvals, audit, clock, 300);

  const roleStore = new MemoryRoleStore(db);
  const evaluationStore = new MemoryEvaluationStore(db);

  const stores = createMemoryImprovementStores(db);
  const artifacts = new GovernedArtifacts(stores.artifacts, clock);

  const harvester = new ObservationHarvester({
    observations: stores.observations,
    runs,
    authorizer,
    audit,
    clock,
    ids,
  });
  const drafter = new ProposalDrafter({
    proposals: stores.proposals,
    observations: stores.observations,
    artifacts,
    roles: roleStore,
    evaluations: evaluationStore,
    templates: TEMPLATES,
    authorizer,
    audit,
    clock,
    ids,
  });
  const trial = new ScriptedTrial(evaluationStore);
  const evaluator = new ProposalEvaluator({
    proposals: stores.proposals,
    trial,
    authorizer,
    audit,
    clock,
  });
  const approver = new ImprovementApprovalService({
    proposals: stores.proposals,
    runs,
    roles: roleStore,
    approvals,
    actions,
    harvester,
    audit,
    clock,
    stepUpMaxAgeSeconds: 300,
  });
  const applier = new ImprovementApplier({
    proposals: stores.proposals,
    artifacts: stores.artifacts,
    evaluations: evaluationStore,
    authorizer,
    audit,
    clock,
  });
  const watch = new ImprovementWatch({
    proposals: stores.proposals,
    observations: stores.observations,
    evaluations: evaluationStore,
    runs,
    audit,
    clock,
    logger: createNullLogger(),
  });

  return {
    db,
    clock,
    ids,
    audit,
    runs,
    actions,
    containment,
    approvals,
    authorizer,
    roleStore,
    evaluationStore,
    stores,
    artifacts,
    harvester,
    drafter,
    trial,
    evaluator,
    approver,
    applier,
    watch,
  };
}

type Harness = ReturnType<typeof build>;

/** Create the role, promote it, publish its golden set, register the binding. */
async function seed(h: Harness): Promise<{ roleId: Id<"role"> }> {
  const roleId = h.ids.next("role");
  const definitionDigest = digestValue(INTAKE);

  await h.roleStore.createRole(
    {
      id: roleId,
      name: INTAKE.name,
      createdAt: NOW,
      createdBy: ADMIN,
      latestVersion: 1,
      identityDigest: digestValue({ actions: INTAKE.actions, task: INTAKE.modelTask }),
    },
    {
      id: h.ids.next("roleVersion"),
      roleId,
      version: 1,
      status: "draft",
      definition: INTAKE,
      definitionDigest,
      createdAt: NOW,
      createdBy: ADMIN,
      changeNote: "initial definition",
    },
  );

  await h.roleStore.promoteVersion({
    roleId,
    version: 1,
    evidence: {
      evaluationRunId: h.ids.next("evaluation"),
      accuracy: 0.75,
      threshold: 0.6,
      approvalId: h.ids.next("approval"),
      promotedAt: NOW,
      promotedBy: ADMIN,
      modelId: "fake-model",
      modelVersion: "1",
      promptTemplateId: TASK,
      promptTemplateVersion: 1,
    },
    at: NOW,
    expectedPromotedVersion: undefined,
  });

  await h.evaluationStore.putGoldenSet(goldenSet());

  await h.artifacts.register({
    kind: "prompt_binding",
    id: BINDING_ID,
    content: { promptTemplateId: TASK, promptTemplateVersion: 1 },
    by: ADMIN,
  });

  return { roleId };
}

async function newRun(
  h: Harness,
  options: { readonly roleId?: Id<"role">; readonly kind?: string } = {},
): Promise<Id<"run">> {
  const run = await h.runs.createRun({
    kind: options.kind ?? "rescission.verify",
    mode: "supervised",
    requestedBy: AGENT,
    subject: {},
    correlationId: "improve-test",
    roleId: options.roleId,
    roleVersion: options.roleId ? 1 : undefined,
  });
  return run.id;
}

/** Record `count` corrections of the same shape against fresh runs. */
async function corrections(
  h: Harness,
  roleId: Id<"role">,
  count: number,
  signature = "deadline.wrong_jurisdiction",
): Promise<readonly Id<"observation">[]> {
  const observationIds: Id<"observation">[] = [];
  for (let index = 0; index < count; index += 1) {
    const runId = await newRun(h, { roleId });
    await h.runs.recordCost({
      runId,
      category: "model",
      amountUsd: 0.02,
      recordedAt: h.clock.nowIso(),
    });
    const result = await h.harvester.correction({
      runId,
      signature,
      note: `agent applied the wrong jurisdiction (${index})`,
      observedBy: SUPERVISOR,
      mode: "supervised",
      correctionMinutes: 4,
      before: { answer: `platform answer ${index}` },
      after: { answer: `human answer ${index}` },
    });
    observationIds.push(result.observation.id);
  }
  return observationIds;
}

/** The improving trial: one previously failing case now passes. */
function improvingTrial(h: Harness): (request: TrialRequest) => TrialResult {
  return (request) => ({
    baseline: evaluationRun(h, {
      id: h.ids.next("evaluation"),
      roleId: request.proposal.roleId,
      results: [
        caseResult("cancel-plain", "passed"),
        caseResult("nevada-window", "failed"),
        caseResult("billing-not-rescission", "passed"),
        caseResult("ambiguous", "failed"),
      ],
    }),
    candidate: evaluationRun(h, {
      id: h.ids.next("evaluation"),
      roleId: request.proposal.roleId,
      results: [
        caseResult("cancel-plain", "passed"),
        caseResult("nevada-window", "passed"),
        caseResult("billing-not-rescission", "passed"),
        caseResult("ambiguous", "failed"),
      ],
    }),
  });
}

function evaluationRun(
  h: Harness,
  input: {
    readonly id: Id<"evaluation">;
    readonly roleId: Id<"role">;
    readonly results: readonly CaseResult[];
    readonly goldenSetVersion?: number;
    readonly goldenSetDigest?: string;
  },
): EvaluationRun {
  const passed = input.results.filter((entry) => entry.outcome === "passed").length;
  const errored = input.results.filter((entry) => entry.outcome === "errored").length;
  const accuracy = Number((passed / input.results.length).toFixed(5));
  return {
    id: input.id,
    roleId: input.roleId,
    roleVersion: 1,
    definitionDigest: digestValue(INTAKE),
    goldenSetId: GOLDEN_SET_ID,
    goldenSetVersion: input.goldenSetVersion ?? 1,
    goldenSetDigest: input.goldenSetDigest ?? digestValue({ set: GOLDEN_SET_ID, version: 1 }),
    task: TASK,
    modelId: "fake-model",
    modelVersion: "1",
    promptTemplateId: TASK,
    promptTemplateVersion: 1,
    runId: "run_trial" as Id<"run">,
    evaluatedBy: ADMIN,
    startedAt: h.clock.nowIso(),
    completedAt: h.clock.nowIso(),
    caseCount: input.results.length,
    passed,
    failed: input.results.length - passed - errored,
    errored,
    accuracy,
    threshold: 0.6,
    meetsThreshold: accuracy >= 0.6,
    syntheticFixtures: true,
    results: input.results,
    totalCostUsd: 0,
  };
}

/** Draft a prompt-binding proposal from real observations. */
async function draftBindingProposal(
  h: Harness,
  roleId: Id<"role">,
  observationIds: readonly Id<"observation">[],
): Promise<Proposal> {
  return h.drafter.draft({
    target: { kind: "prompt_binding", id: BINDING_ID },
    roleId,
    roleVersion: 1,
    clusterKey: `${roleId}::deadline.wrong_jurisdiction`,
    observationIds,
    rationale:
      "Bind the intake role to prompt v2, which states the jurisdiction it applied. Twelve corrections in the window were the wrong state's window.",
    content: { promptTemplateId: TASK, promptTemplateVersion: 2 },
    createdBy: ADMIN,
    mode: "supervised",
    runId: await newRun(h),
  });
}

/** Everything up to and including a granted approval. */
async function approvedProposal(h: Harness): Promise<{
  readonly roleId: Id<"role">;
  readonly proposal: Proposal;
  readonly approvalId: Id<"approval">;
}> {
  const { roleId } = await seed(h);
  const observationIds = await corrections(h, roleId, 3);
  const drafted = await draftBindingProposal(h, roleId, observationIds);

  h.trial.script(improvingTrial(h));
  await h.evaluator.evaluate({
    proposalId: drafted.id,
    actor: ADMIN,
    mode: "supervised",
    runId: await newRun(h),
  });

  const { approval } = await h.approver.requestApproval({
    proposalId: drafted.id,
    requestedBy: ADMIN,
    runId: await newRun(h),
  });
  await h.approver.decide({
    proposalId: drafted.id,
    approvalId: approval.id,
    actor: SUPERVISOR,
    decision: "granted",
    note: "reviewed the diff and the delta",
    runId: await newRun(h),
    mode: "supervised",
    secondsSinceAuthentication: 5,
  });

  return { roleId, proposal: drafted, approvalId: approval.id };
}

/**
 * Somebody else's approved change, landing on the same artifact.
 *
 * Written through the store rather than the applier because the scenario is
 * "another operator got there first", and the point of the test is what the
 * *first* operator's revert or application does when it finds the world moved.
 * The provenance is supplied because the store refuses a version above the
 * first that names no proposal and no approval.
 */
async function installAnotherChange(
  h: Harness,
  version: number,
  expectedHeadVersion: number,
): Promise<void> {
  const content = { promptTemplateId: TASK, promptTemplateVersion: 1 };
  await h.stores.artifacts.installArtifact({
    artifact: {
      kind: "prompt_binding",
      id: BINDING_ID,
      version,
      content,
      digest: digestValue({ kind: "prompt_binding", id: BINDING_ID, version, content }),
      recordedAt: h.clock.nowIso(),
      recordedBy: SUPERVISOR,
      proposalId: h.ids.next("proposal"),
      approvalId: h.ids.next("approval"),
    },
    expectedHeadVersion,
  });
}

async function auditKinds(h: Harness): Promise<readonly AuditEventType[]> {
  const entries = await h.audit.list();
  return entries.map((entry) => entry.eventType);
}

async function denialOf(fn: () => Promise<unknown>): Promise<DeniedError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof DeniedError) return error;
    throw error;
  }
  throw new Error("expected a refusal, and the call succeeded");
}

describe("harvest", () => {
  it("turns a correction into an observation tied to its run", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const runId = await newRun(h, { roleId });
    await h.runs.recordCost({
      runId,
      category: "model",
      amountUsd: 0.25,
      recordedAt: NOW,
    });

    const result = await h.harvester.correction({
      runId,
      signature: "deadline.wrong_jurisdiction",
      note: "applied the Florida window to a Nevada contract",
      observedBy: SUPERVISOR,
      mode: "supervised",
      correctionMinutes: 6,
      before: { deadline: "2026-08-10" },
      after: { deadline: "2026-08-11" },
    });

    expect(result.recorded).toBe(true);
    expect(result.observation.runId).toBe(runId);
    expect(result.observation.roleId).toBe(roleId);
    expect(result.observation.workflowKind).toBe("rescission.verify");
    expect(result.observation.beforeDigest).not.toBe(result.observation.afterDigest);
    expect(await auditKinds(h)).toContain("improvement.observation_recorded");
  });

  it("takes the cost from the operating record, not from the caller", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const runId = await newRun(h, { roleId });
    await h.runs.recordCost({ runId, category: "model", amountUsd: 1.5, recordedAt: NOW });

    const result = await h.harvester.escalation({
      runId,
      signature: "confidence.too_low",
      note: "handed back to a person",
      observedBy: SUPERVISOR,
      mode: "supervised",
    });

    expect(result.observation.costUsd).toBe(1.5);
  });

  it("records every kind the loop learns from", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const kinds: string[] = [];
    for (const record of [
      h.harvester.correction.bind(h.harvester),
      h.harvester.rejectedProposal.bind(h.harvester),
      h.harvester.approvalOverride.bind(h.harvester),
      h.harvester.escalation.bind(h.harvester),
      h.harvester.shadowDisagreement.bind(h.harvester),
    ]) {
      const runId = await newRun(h, { roleId });
      const result = await record({
        runId,
        signature: "deadline.wrong_jurisdiction",
        note: "a disagreement",
        observedBy: SUPERVISOR,
        mode: "supervised",
      });
      kinds.push(result.observation.kind);
    }
    expect(kinds).toEqual([
      "human_correction",
      "proposal_rejected",
      "approval_override",
      "escalation",
      "shadow_disagreement",
    ]);
  });

  it("records a replayed submission once, so a retry cannot inflate a cluster", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const runId = await newRun(h, { roleId });

    const input = {
      runId,
      signature: "deadline.wrong_jurisdiction",
      note: "applied the wrong window",
      observedBy: SUPERVISOR,
      mode: "supervised" as const,
      before: { deadline: "2026-08-10" },
      after: { deadline: "2026-08-11" },
    };

    const first = await h.harvester.correction(input);
    const second = await h.harvester.correction(input);

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(second.observation.id).toBe(first.observation.id);
    expect(await h.harvester.count()).toBe(1);
    // And the chain says it happened once, not twice.
    expect(
      (await auditKinds(h)).filter((kind) => kind === "improvement.observation_recorded"),
    ).toHaveLength(1);
  });

  it("survives two operators recording the same correction at once", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const runId = await newRun(h, { roleId });
    const input = {
      runId,
      signature: "deadline.wrong_jurisdiction",
      note: "applied the wrong window",
      observedBy: SUPERVISOR,
      mode: "supervised" as const,
      before: { a: 1 },
      after: { a: 2 },
    };

    const [first, second] = await Promise.all([
      h.harvester.correction(input),
      h.harvester.correction(input),
    ]);

    expect([first.recorded, second.recorded].filter(Boolean)).toHaveLength(1);
    expect(await h.harvester.count()).toBe(1);
  });

  it("refuses an observation naming a run the record does not have", async () => {
    const h = build();
    await seed(h);
    const denial = await denialOf(async () =>
      h.harvester.correction({
        runId: "run_invented" as Id<"run">,
        signature: "deadline.wrong_jurisdiction",
        note: "a correction against nothing",
        observedBy: SUPERVISOR,
        mode: "supervised",
      }),
    );
    expect(denial.reason).toBe("record.unavailable");
  });

  it("refuses a free-text signature, which would cluster with nothing", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const runId = await newRun(h, { roleId });
    await expect(
      h.harvester.correction({
        runId,
        signature: "the agent got the state wrong again",
        note: "a correction",
        observedBy: SUPERVISOR,
        mode: "supervised",
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("refuses a correction cost large enough to steer the queue", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const runId = await newRun(h, { roleId });
    await expect(
      h.harvester.correction({
        runId,
        signature: "deadline.wrong_jurisdiction",
        note: "a correction",
        observedBy: SUPERVISOR,
        mode: "supervised",
        correctionMinutes: 100_000,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("redacts a secret in the note rather than losing the observation", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const runId = await newRun(h, { roleId });
    const result = await h.harvester.correction({
      runId,
      signature: "integration.auth_failure",
      note: "retried with authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij",
      observedBy: SUPERVISOR,
      mode: "supervised",
    });
    expect(result.observation.note).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(result.observation.note).toContain("[redacted]");
  });

  it("refuses an actor with no role permitted to record one", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const runId = await newRun(h, { roleId });
    const denial = await denialOf(async () =>
      h.harvester.correction({
        runId,
        signature: "deadline.wrong_jurisdiction",
        note: "a correction",
        observedBy: { actorId: "act_outsider", kind: "human", roles: ["auditor"] },
        mode: "supervised",
      }),
    );
    expect(denial.reason).toBe("authorization.action_not_permitted");
  });
});

describe("cluster", () => {
  it("ranks a recurring failure with its rate against real runs", async () => {
    const h = build();
    const { roleId } = await seed(h);
    await corrections(h, roleId, 3);
    // Runs of the same role that nobody corrected: the denominator.
    for (let index = 0; index < 22; index += 1) await newRun(h, { roleId });

    const observations = await h.harvester.list();
    const denominators = await comparableRunCounts(h.runs, [roleId]);
    const clusters = clusterObservations(observations, { comparableRuns: denominators });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.count).toBe(3);
    expect(clusters[0]?.comparableRuns).toBe(25);
    expect(clusters[0]?.rate).toBe(0.12);
    expect(clusters[0]?.summary).toContain("12.0% of cases");
    expect(clusters[0]?.evidence).toHaveLength(3);
  });
});

describe("propose", () => {
  it("drafts an inert proposal against the artifact's current state", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const proposal = await draftBindingProposal(h, roleId, observationIds);

    expect(proposal.status).toBe("drafted");
    expect(proposal.before.version).toBe(1);
    expect(proposal.after.version).toBe(2);
    expect(proposal.after.content["promptTemplateVersion"]).toBe(2);
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(await auditKinds(h)).toContain("improvement.proposal_created");

    // Nothing has changed: the head is still v1.
    const head = await h.artifacts.require("prompt_binding", BINDING_ID);
    expect(head.version).toBe(1);
  });

  it("refuses a proposal targeting the platform's own source", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 1);

    const denial = await denialOf(async () =>
      h.drafter.draft({
        target: { kind: "guardrail_rule", id: "packages/platform/src/improve/apply.ts" },
        roleId,
        roleVersion: 1,
        clusterKey: "k",
        observationIds,
        rationale: "remove the approval check, it slows us down",
        content: { requireApproval: false },
        createdBy: ADMIN,
        mode: "supervised",
      }),
    );
    expect(denial.reason).toBe("improvement.autonomous_application");
    expect(denial.detail["shape"]).toBe("source_artifact");
  });

  it("refuses a binding to a prompt that is not in version control", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 1);

    const denial = await denialOf(async () =>
      h.drafter.draft({
        target: { kind: "prompt_binding", id: BINDING_ID },
        roleId,
        roleVersion: 1,
        clusterKey: "k",
        observationIds,
        rationale: "bind to a prompt nobody has committed",
        content: { promptTemplateId: TASK, promptTemplateVersion: 99 },
        createdBy: ADMIN,
        mode: "supervised",
      }),
    );
    expect(denial.reason).toBe("improvement.autonomous_application");
    expect(denial.detail["shape"]).toBe("prompt_not_in_version_control");
  });

  it("refuses a proposal citing evidence that is not in the record", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const denial = await denialOf(async () =>
      h.drafter.draft({
        target: { kind: "prompt_binding", id: BINDING_ID },
        roleId,
        roleVersion: 1,
        clusterKey: "k",
        observationIds: ["obs_invented" as Id<"observation">],
        rationale: "trust me",
        content: { promptTemplateId: TASK, promptTemplateVersion: 2 },
        createdBy: ADMIN,
        mode: "supervised",
      }),
    );
    expect(denial.reason).toBe("record.unavailable");
  });

  it("refuses a proposal with no evidence at all", async () => {
    const h = build();
    const { roleId } = await seed(h);
    await expect(
      h.drafter.draft({
        target: { kind: "prompt_binding", id: BINDING_ID },
        roleId,
        roleVersion: 1,
        clusterKey: "k",
        observationIds: [],
        rationale: "it feels better",
        content: { promptTemplateId: TASK, promptTemplateVersion: 2 },
        createdBy: ADMIN,
        mode: "supervised",
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("refuses a proposal that changes nothing", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 1);
    await expect(
      h.drafter.draft({
        target: { kind: "prompt_binding", id: BINDING_ID },
        roleId,
        roleVersion: 1,
        clusterKey: "k",
        observationIds,
        rationale: "no change at all",
        content: { promptTemplateId: TASK, promptTemplateVersion: 1 },
        createdBy: ADMIN,
        mode: "supervised",
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("refuses to create an artifact the deployment never declared", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 1);
    const denial = await denialOf(async () =>
      h.drafter.draft({
        target: { kind: "routing_rule", id: "invented.route" },
        roleId,
        roleVersion: 1,
        clusterKey: "k",
        observationIds,
        rationale: "route everything to me",
        content: { route: "somewhere" },
        createdBy: ADMIN,
        mode: "supervised",
      }),
    );
    expect(denial.reason).toBe("record.unavailable");
  });

  it("adds golden-set cases, and refuses one that restates an existing case", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 1);

    const added = await h.drafter.draft({
      target: { kind: "evaluation_case", id: GOLDEN_SET_ID },
      roleId,
      roleVersion: 1,
      clusterKey: "k",
      observationIds,
      rationale: "the Nevada window case is missing from the set entirely",
      content: {
        goldenSetId: GOLDEN_SET_ID,
        fromVersion: 1,
        toVersion: 2,
        addedCaseCount: 1,
      },
      addedCases: [goldenCase({ id: "nevada-window-explicit" })],
      createdBy: ADMIN,
      mode: "supervised",
    });
    expect(added.addedCases).toHaveLength(1);

    // The only shape an automated proposal could use to restate an existing
    // expectation: reuse its id. Refused before it becomes a queue item.
    await expect(
      h.drafter.draft({
        target: { kind: "evaluation_case", id: GOLDEN_SET_ID },
        roleId,
        roleVersion: 1,
        clusterKey: "k",
        observationIds,
        rationale: "make the hard case easier",
        content: {
          goldenSetId: GOLDEN_SET_ID,
          fromVersion: 1,
          toVersion: 2,
          addedCaseCount: 1,
        },
        addedCases: [goldenCase({ id: "cancel-plain", expected: { kind: "any" } })],
        createdBy: ADMIN,
        mode: "supervised",
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("refuses a proposed case with nobody's name on the expected outcome", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 1);
    await expect(
      h.drafter.draft({
        target: { kind: "evaluation_case", id: GOLDEN_SET_ID },
        roleId,
        roleVersion: 1,
        clusterKey: "k",
        observationIds,
        rationale: "add a case",
        content: {
          goldenSetId: GOLDEN_SET_ID,
          fromVersion: 1,
          toVersion: 2,
          addedCaseCount: 1,
        },
        addedCases: [goldenCase({ id: "unattributed", curatedBy: "" })],
        createdBy: ADMIN,
        mode: "supervised",
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("evaluate", () => {
  it("offers a change that improves quality, and records the delta", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);

    h.trial.script(improvingTrial(h));
    const { proposal, evaluation } = await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });

    expect(proposal.status).toBe("offered");
    expect(evaluation.offered).toBe(true);
    expect(evaluation.improvedCaseIds).toEqual(["nevada-window"]);
    expect(evaluation.regressedCaseIds).toEqual([]);
    expect(evaluation.delta).toBeCloseTo(0.25, 5);
    expect(await auditKinds(h)).toContain("improvement.proposal_evaluated");
  });

  it("withholds a change that does not improve quality, and never offers it", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);

    h.trial.script((request) => {
      const results = [
        caseResult("cancel-plain", "passed"),
        caseResult("nevada-window", "failed"),
        caseResult("billing-not-rescission", "passed"),
        caseResult("ambiguous", "failed"),
      ];
      return {
        baseline: evaluationRun(h, {
          id: h.ids.next("evaluation"),
          roleId: request.proposal.roleId,
          results,
        }),
        candidate: evaluationRun(h, {
          id: h.ids.next("evaluation"),
          roleId: request.proposal.roleId,
          results,
        }),
      };
    });

    const { proposal, evaluation } = await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });

    expect(proposal.status).toBe("withheld");
    expect(evaluation.offered).toBe(false);

    // And it cannot reach a human: there is no review packet for it.
    const denial = await denialOf(async () =>
      h.approver.requestApproval({
        proposalId: drafted.id,
        requestedBy: ADMIN,
        runId: await newRun(h),
      }),
    );
    expect(denial.reason).toBe("improvement.evaluation_regression");
  });

  it("refuses a trial that measured the candidate against an easier set", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);

    h.trial.script((request) => ({
      baseline: evaluationRun(h, {
        id: h.ids.next("evaluation"),
        roleId: request.proposal.roleId,
        results: [caseResult("cancel-plain", "failed")],
      }),
      candidate: evaluationRun(h, {
        id: h.ids.next("evaluation"),
        roleId: request.proposal.roleId,
        results: [caseResult("cancel-plain", "passed")],
        goldenSetVersion: 2,
        goldenSetDigest: digestValue({ set: "much easier" }),
      }),
    }));

    const denial = await denialOf(async () =>
      h.evaluator.evaluate({
        proposalId: drafted.id,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
      }),
    );
    expect(denial.reason).toBe("approval.digest_mismatch");
  });

  it("refuses to re-measure a proposal that has already been decided", async () => {
    const h = build();
    const { proposal } = await approvedProposal(h);
    h.trial.script(improvingTrial(h));
    const denial = await denialOf(async () =>
      h.evaluator.evaluate({
        proposalId: proposal.id,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
      }),
    );
    expect(denial.reason).toBe("improvement.evaluation_regression");
  });
});

describe("approve", () => {
  it("computes the blast radius from the operating record", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    for (let index = 0; index < 4; index += 1) {
      await newRun(h, { roleId, kind: "rescission.acknowledge" });
    }
    const drafted = await draftBindingProposal(h, roleId, observationIds);
    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });

    const packet = await h.approver.reviewPacket(drafted.id);

    expect(packet.blastRadius.roleIds).toEqual([roleId]);
    expect(packet.blastRadius.roleNames).toEqual(["rescission_intake"]);
    expect(packet.blastRadius.workflowKinds).toEqual([
      "rescission.acknowledge",
      "rescission.verify",
    ]);
    // Two corrected runs plus four more, all still pending.
    expect(packet.blastRadius.runCount).toBe(6);
    expect(packet.blastRadius.openRunCount).toBe(6);
    expect(packet.blastRadius.sampleRunIds.length).toBeGreaterThan(0);
    expect(packet.changes).toEqual([
      { field: "promptTemplateVersion", kind: "changed", from: "1", to: "2" },
    ]);
    expect(packet.summary).toContain("Blast radius");
    expect(packet.summary).toContain("Measured: 50.0% → 75.0%");
  });

  it("refuses an approver who requested the change", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);
    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });
    const { approval } = await h.approver.requestApproval({
      proposalId: drafted.id,
      requestedBy: ADMIN,
      runId: await newRun(h),
    });

    const denial = await denialOf(async () =>
      h.approver.decide({
        proposalId: drafted.id,
        approvalId: approval.id,
        actor: ADMIN,
        decision: "granted",
        runId: await newRun(h),
        mode: "supervised",
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("approval.self_approval");
  });

  it("refuses an approver who holds no eligible role", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);
    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });
    const { approval } = await h.approver.requestApproval({
      proposalId: drafted.id,
      requestedBy: ADMIN,
      runId: await newRun(h),
    });

    const denial = await denialOf(async () =>
      h.approver.decide({
        proposalId: drafted.id,
        approvalId: approval.id,
        actor: AGENT,
        decision: "granted",
        runId: await newRun(h),
        mode: "supervised",
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("approval.insufficient_approvers");
  });

  it("refuses an approver who has not re-authenticated", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);
    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });
    const { approval } = await h.approver.requestApproval({
      proposalId: drafted.id,
      requestedBy: ADMIN,
      runId: await newRun(h),
    });

    const denial = await denialOf(async () =>
      h.approver.decide({
        proposalId: drafted.id,
        approvalId: approval.id,
        actor: SUPERVISOR,
        decision: "granted",
        runId: await newRun(h),
        mode: "supervised",
        secondsSinceAuthentication: 100_000,
      }),
    );
    expect(denial.reason).toBe("authorization.step_up_required");
  });

  it("turns a rejection into evidence the loop learns from", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);
    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });
    const { approval } = await h.approver.requestApproval({
      proposalId: drafted.id,
      requestedBy: ADMIN,
      runId: await newRun(h),
    });

    const before = await h.harvester.count();
    const outcome = await h.approver.decide({
      proposalId: drafted.id,
      approvalId: approval.id,
      actor: SUPERVISOR,
      decision: "rejected",
      note: "the new prompt drops the citation requirement",
      runId: await newRun(h, { roleId }),
      mode: "supervised",
      secondsSinceAuthentication: 5,
    });

    expect(outcome.proposal.status).toBe("rejected");
    expect(await h.harvester.count()).toBe(before + 1);
    const rejections = await h.harvester.list({ kind: ["proposal_rejected"] });
    expect(rejections[0]?.note).toContain("citation requirement");
    expect(await auditKinds(h)).toContain("improvement.proposal_rejected");

    // A rejected proposal is not revived: somebody said no.
    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: drafted.id,
        approvalId: approval.id,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("improvement.autonomous_application");
  });
});

describe("apply and revert", () => {
  it("applies an approved change, and can undo it in one action", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);

    const applied = await h.applier.apply({
      proposalId: proposal.id,
      approvalId,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
      secondsSinceAuthentication: 5,
    });

    expect(applied.approvalId).toBe(approvalId);
    expect(applied.snapshot.version).toBe(1);
    expect(applied.installed.version).toBe(2);
    expect(applied.revertible).toBe(true);
    expect(await auditKinds(h)).toContain("improvement.applied");

    const head = await h.artifacts.require("prompt_binding", BINDING_ID);
    expect(head.version).toBe(2);
    expect(head.content["promptTemplateVersion"]).toBe(2);
    expect(head.approvalId).toBe(approvalId);

    const reverted = await h.applier.revert({
      proposalId: proposal.id,
      actor: SUPERVISOR,
      mode: "supervised",
      runId: await newRun(h),
      reason: "owners reported worse routing overnight",
    });

    expect(reverted.revertedAt).toBeTruthy();
    expect(reverted.revertedBy?.actorId).toBe(SUPERVISOR.actorId);
    const restored = await h.artifacts.require("prompt_binding", BINDING_ID);
    expect(restored.version).toBe(1);
    expect(restored.digest).toBe(applied.snapshot.digest);
    expect(await auditKinds(h)).toContain("improvement.reverted");

    // The history is intact: reverting moved the pointer, it did not erase v2.
    const history = await h.artifacts.history("prompt_binding", BINDING_ID);
    expect(history.map((entry) => entry.version)).toEqual([1, 2]);

    const stored = await h.stores.proposals.requireProposal(proposal.id);
    expect(stored.status).toBe("reverted");
  });

  it("refuses a second revert", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);
    await h.applier.apply({
      proposalId: proposal.id,
      approvalId,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
      secondsSinceAuthentication: 5,
    });
    await h.applier.revert({
      proposalId: proposal.id,
      actor: SUPERVISOR,
      mode: "supervised",
      runId: await newRun(h),
      reason: "first revert",
    });

    const denial = await denialOf(async () =>
      h.applier.revert({
        proposalId: proposal.id,
        actor: SUPERVISOR,
        mode: "supervised",
        runId: await newRun(h),
        reason: "second revert",
      }),
    );
    expect(denial.reason).toBe("record.unavailable");
    expect(denial.message).toContain("already reverted");
  });

  it("refuses a revert once something else has been applied over it", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);
    await h.applier.apply({
      proposalId: proposal.id,
      approvalId,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
      secondsSinceAuthentication: 5,
    });

    // Another approved change has landed on top. Reverting now would restore a
    // state nobody chose over the one that is live.
    await installAnotherChange(h, 3, 2);

    const denial = await denialOf(async () =>
      h.applier.revert({
        proposalId: proposal.id,
        actor: SUPERVISOR,
        mode: "supervised",
        runId: await newRun(h),
        reason: "roll it back",
      }),
    );
    expect(denial.reason).toBe("record.unavailable");
    expect(denial.message).toContain("no longer at v2");
  });

  it("refuses to revert added golden-set cases: the cases stay", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);

    const drafted = await h.drafter.draft({
      target: { kind: "evaluation_case", id: GOLDEN_SET_ID },
      roleId,
      roleVersion: 1,
      clusterKey: "k",
      observationIds,
      rationale: "the corrections show a case the set does not cover",
      content: { goldenSetId: GOLDEN_SET_ID, fromVersion: 1, toVersion: 2, addedCaseCount: 1 },
      addedCases: [goldenCase({ id: "nevada-window-explicit" })],
      createdBy: ADMIN,
      mode: "supervised",
    });

    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });
    const { approval } = await h.approver.requestApproval({
      proposalId: drafted.id,
      requestedBy: ADMIN,
      runId: await newRun(h),
    });
    await h.approver.decide({
      proposalId: drafted.id,
      approvalId: approval.id,
      actor: SUPERVISOR,
      decision: "granted",
      runId: await newRun(h),
      mode: "supervised",
      secondsSinceAuthentication: 5,
    });

    const applied = await h.applier.apply({
      proposalId: drafted.id,
      approvalId: approval.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
      secondsSinceAuthentication: 5,
    });

    expect(applied.revertible).toBe(false);
    const published = await h.evaluationStore.requireGoldenSet(GOLDEN_SET_ID);
    expect(published.version).toBe(2);
    expect(published.cases.map((entry) => entry.id)).toContain("nevada-window-explicit");
    // Every original case survived: additions only.
    expect(published.cases).toHaveLength(5);

    const denial = await denialOf(async () =>
      h.applier.revert({
        proposalId: drafted.id,
        actor: SUPERVISOR,
        mode: "supervised",
        runId: await newRun(h),
        reason: "undo the new case",
      }),
    );
    expect(denial.reason).toBe("improvement.protected_case_weakened");
  });

  it("refuses a revert with no reason", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);
    await h.applier.apply({
      proposalId: proposal.id,
      approvalId,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
      secondsSinceAuthentication: 5,
    });
    await expect(
      h.applier.revert({
        proposalId: proposal.id,
        actor: SUPERVISOR,
        mode: "supervised",
        runId: await newRun(h),
        reason: "   ",
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("the gate: no autonomous application", () => {
  /**
   * Every plausible way to apply a change without a human decision, and the
   * assertion that each is refused. ADR 0011 records why there is no
   * configuration that would make any of these succeed.
   */

  it("refuses an application with no approval id", async () => {
    const h = build();
    const { proposal } = await approvedProposal(h);
    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: proposal.id,
        approvalId: undefined as unknown as Id<"approval">,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("improvement.autonomous_application");
    expect(denial.detail["shape"]).toBe("no_approval_presented");
    expect(await auditKinds(h)).toContain("improvement.refused");
  });

  it("refuses a blank approval id", async () => {
    const h = build();
    const { proposal } = await approvedProposal(h);
    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: proposal.id,
        approvalId: "   " as Id<"approval">,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("improvement.autonomous_application");
  });

  it("refuses something that is not an approval identifier", async () => {
    const h = build();
    const { proposal } = await approvedProposal(h);
    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: proposal.id,
        approvalId: "run_pretending_to_be_an_approval" as Id<"approval">,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("improvement.autonomous_application");
    expect(denial.detail["shape"]).toBe("not_an_approval_id");
  });

  it("refuses an approval id that does not exist", async () => {
    const h = build();
    const { proposal } = await approvedProposal(h);
    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: proposal.id,
        approvalId: "apr_invented000000000000" as Id<"approval">,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("approval.digest_mismatch");
  });

  it("refuses an approval nobody has granted yet", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);
    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });
    const { approval } = await h.approver.requestApproval({
      proposalId: drafted.id,
      requestedBy: ADMIN,
      runId: await newRun(h),
    });

    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: drafted.id,
        approvalId: approval.id,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    // The proposal is still `offered`, so it never reaches the chokepoint.
    expect(denial.reason).toBe("improvement.autonomous_application");
    expect(denial.detail["shape"]).toBe("not_approved");
  });

  it("refuses an approval that has expired between the decision and the change", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);
    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });
    const { approval } = await h.approver.requestApproval({
      proposalId: drafted.id,
      requestedBy: ADMIN,
      runId: await newRun(h),
      ttlMs: HOUR,
    });
    await h.approver.decide({
      proposalId: drafted.id,
      approvalId: approval.id,
      actor: SUPERVISOR,
      decision: "granted",
      runId: await newRun(h),
      mode: "supervised",
      secondsSinceAuthentication: 5,
    });

    h.clock.advance(2 * HOUR);

    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: drafted.id,
        approvalId: approval.id,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("approval.expired");
    expect(await auditKinds(h)).toContain("improvement.refused");
  });

  it("refuses an approval granted for a different proposal", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);

    // Two proposals against different artifacts, each approved on its own.
    await h.artifacts.register({
      kind: "guardrail_rule",
      id: "intake.confidence",
      content: { minimumConfidence: 0.7 },
      by: ADMIN,
    });
    const other = await h.drafter.draft({
      target: { kind: "guardrail_rule", id: "intake.confidence" },
      roleId,
      roleVersion: 1,
      clusterKey: "k",
      observationIds,
      rationale: "raise the confidence floor",
      content: { minimumConfidence: 0.85 },
      createdBy: ADMIN,
      mode: "supervised",
    });
    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: other.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });
    const otherApproval = await h.approver.requestApproval({
      proposalId: other.id,
      requestedBy: ADMIN,
      runId: await newRun(h),
    });
    await h.approver.decide({
      proposalId: other.id,
      approvalId: otherApproval.approval.id,
      actor: SUPERVISOR,
      decision: "granted",
      runId: await newRun(h),
      mode: "supervised",
      secondsSinceAuthentication: 5,
    });

    const target = await draftBindingProposal(h, roleId, observationIds);
    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: target.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });
    const targetApproval = await h.approver.requestApproval({
      proposalId: target.id,
      requestedBy: ADMIN,
      runId: await newRun(h),
    });
    await h.approver.decide({
      proposalId: target.id,
      approvalId: targetApproval.approval.id,
      actor: SUPERVISOR,
      decision: "granted",
      runId: await newRun(h),
      mode: "supervised",
      secondsSinceAuthentication: 5,
    });

    // The approval for the other change does not authorise this one.
    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: target.id,
        approvalId: otherApproval.approval.id,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("approval.digest_mismatch");
  });

  it("refuses a replay: an approval is spent exactly once", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);
    await h.applier.apply({
      proposalId: proposal.id,
      approvalId,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
      secondsSinceAuthentication: 5,
    });

    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: proposal.id,
        approvalId,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    // The proposal is `applied` now, so it is refused before the approval is
    // even consulted — and the approval is spent as well.
    expect(denial.reason).toBe("improvement.autonomous_application");
    const head = await h.artifacts.require("prompt_binding", BINDING_ID);
    expect(head.version).toBe(2);
  });

  it("lets exactly one of two racing applications win", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);
    const runId = await newRun(h);

    const settled = await Promise.allSettled([
      h.applier.apply({
        proposalId: proposal.id,
        approvalId,
        actor: ADMIN,
        mode: "supervised",
        runId,
        secondsSinceAuthentication: 5,
      }),
      h.applier.apply({
        proposalId: proposal.id,
        approvalId,
        actor: ADMIN,
        mode: "supervised",
        runId,
        secondsSinceAuthentication: 5,
      }),
    ]);

    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const head = await h.artifacts.require("prompt_binding", BINDING_ID);
    expect(head.version).toBe(2);
    const history = await h.artifacts.history("prompt_binding", BINDING_ID);
    expect(history).toHaveLength(2);
  });

  it("refuses a proposal that was never measured", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);

    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: drafted.id,
        approvalId: "apr_never_granted00000" as Id<"approval">,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("improvement.autonomous_application");
    expect(await auditKinds(h)).toContain("improvement.refused");
  });

  it("refuses a proposal edited in the database after it was approved", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);

    // Reach past every service and rewrite the row, as somebody with a psql
    // prompt could. The fingerprint no longer matches its contents.
    const table = h.db.table<Proposal>("improvement_proposal");
    const stored = table.get(proposal.id);
    if (!stored) throw new Error("fixture missing");
    table.set(proposal.id, {
      ...stored,
      after: {
        ...stored.after,
        content: { promptTemplateId: TASK, promptTemplateVersion: 1 },
      },
    });

    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: proposal.id,
        approvalId,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("approval.digest_mismatch");
    expect(denial.message).toContain("altered since it was created");
  });

  it("refuses an application over an artifact that moved after the approval", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);

    await installAnotherChange(h, 2, 1);

    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: proposal.id,
        approvalId,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("approval.digest_mismatch");
    expect(denial.message).toContain("not the state this proposal was approved against");
  });

  it("stops an application that tried to outrun the stop button", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);

    await h.containment.engage("global", "", SUPERVISOR.actorId, "quality incident");

    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: proposal.id,
        approvalId,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("containment.global_pause");
    const head = await h.artifacts.require("prompt_binding", BINDING_ID);
    expect(head.version).toBe(1);
  });

  it("refuses an applier who has not re-authenticated", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);
    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: proposal.id,
        approvalId,
        actor: ADMIN,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 100_000,
      }),
    );
    expect(denial.reason).toBe("authorization.step_up_required");
  });

  it("refuses an applier whose role may not apply improvements", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);
    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: proposal.id,
        approvalId,
        actor: AGENT,
        mode: "supervised",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("authorization.action_not_permitted");
  });

  it("refuses an application in shadow mode, where nothing may land", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);
    const denial = await denialOf(async () =>
      h.applier.apply({
        proposalId: proposal.id,
        approvalId,
        actor: ADMIN,
        mode: "shadow",
        runId: await newRun(h),
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("authorization.action_not_permitted");
  });

  it("refuses the action that exists so the refusal is explicit", async () => {
    const h = build();
    await seed(h);
    const denial = await denialOf(async () =>
      h.authorizer.authorize({
        action: APPLY_WITHOUT_APPROVAL_ACTION,
        actor: ADMIN,
        mode: "supervised",
        secondsSinceAuthentication: 5,
      }),
    );
    expect(denial.reason).toBe("authorization.action_not_permitted");
    expect(denial.message).toContain("cannot be enabled by configuration");
  });

  it("refuses a stored artifact version that names no human decision", async () => {
    const h = build();
    await seed(h);
    const content = { promptTemplateId: TASK, promptTemplateVersion: 2 };

    // Reaching past the applier entirely, straight at the store. The version
    // above the first has to name the proposal and the approval that produced
    // it, so this is refused by the store as well as by everything above it.
    await expect(
      h.stores.artifacts.installArtifact({
        artifact: {
          kind: "prompt_binding",
          id: BINDING_ID,
          version: 2,
          content,
          digest: digestValue({ kind: "prompt_binding", id: BINDING_ID, version: 2, content }),
          recordedAt: h.clock.nowIso(),
          recordedBy: ADMIN,
        },
        expectedHeadVersion: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    const head = await h.artifacts.require("prompt_binding", BINDING_ID);
    expect(head.version).toBe(1);
  });

  it("records every refusal in the chain, so fifty attempts are visible", async () => {
    const h = build();
    const { proposal } = await approvedProposal(h);

    for (const approvalId of [
      undefined as unknown as Id<"approval">,
      "" as Id<"approval">,
      "run_not_an_approval" as Id<"approval">,
      "apr_does_not_exist0000" as Id<"approval">,
    ]) {
      await denialOf(async () =>
        h.applier.apply({
          proposalId: proposal.id,
          approvalId,
          actor: ADMIN,
          mode: "supervised",
          runId: await newRun(h),
          secondsSinceAuthentication: 5,
        }),
      );
    }

    const refusals = (await h.audit.list()).filter(
      (entry) => entry.eventType === "improvement.refused",
    );
    expect(refusals).toHaveLength(4);
    for (const entry of refusals) {
      expect(entry.subject["proposalId"]).toBe(proposal.id);
      expect(entry.decision["reason"]).toBeTruthy();
    }
  });

  it("leaves the audit chain intact across the whole loop", async () => {
    const h = build();
    const { proposal, approvalId } = await approvedProposal(h);
    await h.applier.apply({
      proposalId: proposal.id,
      approvalId,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
      secondsSinceAuthentication: 5,
    });

    const kinds = await auditKinds(h);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "improvement.observation_recorded",
        "improvement.proposal_created",
        "improvement.proposal_evaluated",
        "improvement.proposal_approved",
        "improvement.applied",
      ]),
    );
  });
});

describe("watch", () => {
  async function applied(h: Harness): Promise<{
    readonly roleId: Id<"role">;
    readonly proposal: Proposal;
  }> {
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);
    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });
    const { approval } = await h.approver.requestApproval({
      proposalId: drafted.id,
      requestedBy: ADMIN,
      runId: await newRun(h),
    });
    await h.approver.decide({
      proposalId: drafted.id,
      approvalId: approval.id,
      actor: SUPERVISOR,
      decision: "granted",
      runId: await newRun(h),
      mode: "supervised",
      secondsSinceAuthentication: 5,
    });
    await h.applier.apply({
      proposalId: drafted.id,
      approvalId: approval.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
      secondsSinceAuthentication: 5,
    });
    return { roleId, proposal: drafted };
  }

  it("reports no regression while the change holds", async () => {
    const h = build();
    const { roleId, proposal } = await applied(h);

    h.clock.advance(DAY);
    await h.watch.recordSample({
      proposalId: proposal.id,
      run: evaluationRun(h, {
        id: h.ids.next("evaluation"),
        roleId,
        results: [
          caseResult("cancel-plain", "passed"),
          caseResult("nevada-window", "passed"),
          caseResult("billing-not-rescission", "passed"),
          caseResult("ambiguous", "failed"),
        ],
      }),
      actor: ADMIN,
    });

    const report = await h.watch.assess(proposal.id);
    expect(report.sampleCount).toBe(1);
    expect(report.regressed).toBe(false);
    expect(report.delta).toBeCloseTo(0.25, 5);
    expect(report.revert.available).toBe(true);
    expect(await auditKinds(h)).toContain("improvement.proposal_evaluated");
  });

  it("alerts and offers the revert when quality falls back", async () => {
    const h = build();
    const { roleId, proposal } = await applied(h);

    h.clock.advance(DAY);
    await h.watch.recordSample({
      proposalId: proposal.id,
      run: evaluationRun(h, {
        id: h.ids.next("evaluation"),
        roleId,
        results: [
          caseResult("cancel-plain", "passed"),
          // The case the change was measured to fix has stopped passing.
          caseResult("nevada-window", "failed"),
          caseResult("billing-not-rescission", "failed"),
          caseResult("ambiguous", "failed"),
        ],
      }),
      actor: ADMIN,
    });

    const report = await h.watch.assess(proposal.id);
    expect(report.regressed).toBe(true);
    expect(report.regressedCaseIds).toContain("nevada-window");
    expect(report.reasons.join(" ")).toContain("has not held");
    expect(report.revert.available).toBe(true);
    expect(report.revert.restoresVersion).toBe(1);
    expect(report.revert.action).toBe("improvement.revert");

    // The offer is data. The watch has taken no action of its own.
    expect(typeof (report.revert as unknown as Record<string, unknown>)["execute"]).toBe(
      "undefined",
    );
    const head = await h.artifacts.require("prompt_binding", BINDING_ID);
    expect(head.version).toBe(2);

    // And the regressions queue finds it.
    const regressions = await h.watch.regressions();
    expect(regressions.map((entry) => entry.proposalId)).toEqual([proposal.id]);
  });

  it("notices operators correcting more work than before the change", async () => {
    const h = build();
    const { roleId, proposal } = await applied(h);

    // Before the change: two corrections across ten runs of this role.
    for (let index = 0; index < 8; index += 1) await newRun(h, { roleId });

    // After it: five corrections across five runs. The golden set still looks
    // fine — the cases do not cover what the operators are fixing.
    h.clock.advance(DAY);
    await corrections(h, roleId, 5, "routing.wrong_queue");

    const report = await h.watch.assess(proposal.id);
    expect(report.corrections.comparable).toBe(true);
    expect(report.corrections.afterRate).toBeGreaterThan(report.corrections.beforeRate);
    expect(report.regressed).toBe(true);
    expect(report.reasons.join(" ")).toContain("correcting");
  });

  it("refuses a measurement taken against a different set of cases", async () => {
    const h = build();
    const { roleId, proposal } = await applied(h);
    h.clock.advance(HOUR);

    const denial = await denialOf(async () =>
      h.watch.recordSample({
        proposalId: proposal.id,
        run: evaluationRun(h, {
          id: h.ids.next("evaluation"),
          roleId,
          results: [caseResult("cancel-plain", "passed")],
          goldenSetVersion: 2,
          goldenSetDigest: digestValue({ set: "different" }),
        }),
        actor: ADMIN,
      }),
    );
    expect(denial.reason).toBe("approval.digest_mismatch");
  });

  it("refuses to watch a change that was never applied", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 1);
    const drafted = await draftBindingProposal(h, roleId, observationIds);
    const denial = await denialOf(async () => h.watch.assess(drafted.id));
    expect(denial.reason).toBe("improvement.evaluation_regression");
  });

  it("withdraws the offer once the change has been reverted", async () => {
    const h = build();
    const { proposal } = await applied(h);
    h.clock.advance(MINUTE * 5);
    await h.applier.revert({
      proposalId: proposal.id,
      actor: SUPERVISOR,
      mode: "supervised",
      runId: await newRun(h),
      reason: "regressed overnight",
    });

    const report = await h.watch.assess(proposal.id);
    expect(report.revert.available).toBe(false);
    expect(report.revert.unavailableReason).toContain("already reverted");
  });
});

describe("approval binding", () => {
  it("changes when the evidence changes, so evidence cannot be swapped", async () => {
    const h = build();
    const { roleId } = await seed(h);
    const observationIds = await corrections(h, roleId, 2);
    const drafted = await draftBindingProposal(h, roleId, observationIds);
    h.trial.script(improvingTrial(h));
    await h.evaluator.evaluate({
      proposalId: drafted.id,
      actor: ADMIN,
      mode: "supervised",
      runId: await newRun(h),
    });

    const stored = await h.stores.proposals.requireProposal(drafted.id);
    const digest = approvalDigest(stored);
    const withOtherEvidence = approvalDigest({
      ...stored,
      evaluation: stored.evaluation
        ? { ...stored.evaluation, candidateAccuracy: 0.99, delta: 0.49 }
        : undefined,
    });
    expect(withOtherEvidence).not.toBe(digest);
  });
});
