import { describe, it, expect } from "vitest";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef } from "../record/types.js";
import { assertGoldenSetNotWeakened } from "../roles/evaluation.js";
import type { CaseResult, EvaluationRun, GoldenCase, GoldenSet } from "../roles/types.js";
import { diffArtifactContent } from "./approve.js";
import {
  MUTABLE_ARTIFACT_KINDS,
  absentArtifact,
  artifactDigest,
  artifactState,
  assertArtifactContent,
  assertMutableArtifact,
  isMutableArtifactKind,
} from "./artifacts.js";
import { clusterObservations, clusterKey } from "./cluster.js";
import { assertComparableTrial, assertOffered, assessTrial } from "./evaluate.js";
import { observationKey } from "./harvest.js";
import { changeDigest, freezeProposal } from "./propose.js";
import { assertTransition, type ArtifactKind, type Observation, type Proposal } from "./types.js";

/**
 * The parts of the improvement loop that are pure functions.
 *
 * Clustering, the artifact allowlist, the trial verdict, and the golden-set
 * protection guard are all decidable without a database, a clock, or an
 * approval — so they are tested without one. What is left in `improve.test.ts`
 * is the behaviour that genuinely needs the whole spine.
 *
 * Every control here is tested twice: once proving it lets the legitimate case
 * through, once proving it refuses. A control tested only on the happy path is
 * a control nobody has confirmed is connected to anything.
 */

const NOW = "2026-08-06T12:00:00.000Z";

const CURATOR: ActorRef = {
  actorId: "act_curator",
  kind: "human",
  roles: ["compliance_reviewer"],
};

function observation(overrides: Partial<Observation> & { id: string }): Observation {
  return {
    kind: "human_correction",
    runId: "run_1" as Id<"run">,
    roleId: "rol_intake" as Id<"role">,
    roleVersion: 1,
    workflowKind: "rescission.verify",
    signature: "deadline.wrong_jurisdiction",
    note: "agent applied the Florida window to a Nevada contract",
    observedBy: CURATOR,
    recordedAt: NOW,
    correctionMinutes: 5,
    costUsd: 0.1,
    subject: {},
    idempotencyKey: `key-${overrides.id}`,
    ...overrides,
  } as Observation;
}

function caseResult(caseId: string, outcome: CaseResult["outcome"]): CaseResult {
  return { caseId, outcome, detail: `case ${caseId}`, latencyMs: 1, costUsd: 0, tags: [] };
}

function evaluationRun(input: {
  readonly id: string;
  readonly results: readonly CaseResult[];
  readonly goldenSetVersion?: number;
  readonly goldenSetDigest?: string;
  readonly threshold?: number;
  readonly roleId?: string;
  readonly errored?: number;
}): EvaluationRun {
  const passed = input.results.filter((entry) => entry.outcome === "passed").length;
  const errored = input.errored ?? input.results.filter((r) => r.outcome === "errored").length;
  const accuracy = input.results.length === 0 ? 0 : passed / input.results.length;
  const threshold = input.threshold ?? 0.5;
  return {
    id: input.id as Id<"evaluation">,
    roleId: (input.roleId ?? "rol_intake") as Id<"role">,
    roleVersion: 1,
    definitionDigest: digestValue({ definition: "intake" }),
    goldenSetId: "intake_cases",
    goldenSetVersion: input.goldenSetVersion ?? 1,
    goldenSetDigest: (input.goldenSetDigest ?? digestValue({ set: "intake_cases", v: 1 })) as string,
    task: "contact.classify_owner_intent",
    modelId: "fake-model",
    modelVersion: "1",
    promptTemplateId: "contact.classify_owner_intent",
    promptTemplateVersion: 1,
    runId: "run_trial" as Id<"run">,
    evaluatedBy: CURATOR,
    startedAt: NOW,
    completedAt: NOW,
    caseCount: input.results.length,
    passed,
    failed: input.results.length - passed - errored,
    errored,
    accuracy: Number(accuracy.toFixed(5)),
    threshold,
    meetsThreshold: accuracy >= threshold,
    syntheticFixtures: true,
    results: input.results,
    totalCostUsd: 0,
  };
}

function goldenCase(overrides: Partial<GoldenCase> & { id: string }): GoldenCase {
  return {
    description: `case ${overrides.id}`,
    input: { categories: "a,b", message: "I want to cancel" },
    expected: { kind: "contains", values: ["rescission_request"] },
    tags: ["jurisdiction:FL"],
    curatedBy: "compliance-operations",
    curatedAt: NOW,
    ...overrides,
  };
}

function goldenSet(overrides: Partial<GoldenSet> = {}): GoldenSet {
  return {
    id: "intake_cases",
    version: 1,
    task: "contact.classify_owner_intent",
    synthetic: true,
    threshold: 0.6,
    curatedBy: "compliance-operations",
    curatedAt: NOW,
    cases: [goldenCase({ id: "cancel-plain" }), goldenCase({ id: "billing-not-rescission" })],
    ...overrides,
  };
}

describe("clustering", () => {
  it("groups by role and signature, and ranks by frequency and cost", () => {
    const clusters = clusterObservations(
      [
        observation({ id: "obs_1" }),
        observation({ id: "obs_2" }),
        observation({ id: "obs_3" }),
        observation({
          id: "obs_4",
          signature: "citation.missing",
          correctionMinutes: 1,
          costUsd: 0.01,
        }),
      ],
      { comparableRuns: { rol_intake: 25 } },
    );

    expect(clusters).toHaveLength(2);
    const first = clusters[0];
    expect(first?.signature).toBe("deadline.wrong_jurisdiction");
    expect(first?.rank).toBe(1);
    expect(first?.count).toBe(3);
    expect(first?.comparableRuns).toBe(25);
    expect(first?.rate).toBe(0.12);
    expect(first?.humanMinutes).toBe(15);
    expect(first?.summary).toContain("12.0% of cases (3 of 25 runs)");
    expect(clusters[1]?.rank).toBe(2);
  });

  it("attaches the evidence an operator needs to check the claim", () => {
    const clusters = clusterObservations([observation({ id: "obs_1" })]);
    const evidence = clusters[0]?.evidence ?? [];
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.observationId).toBe("obs_1");
    expect(evidence[0]?.runId).toBe("run_1");
    expect(evidence[0]?.note).toContain("Florida window");
  });

  it("is deterministic whatever order the observations arrive in", () => {
    const observations = [
      observation({ id: "obs_3", signature: "citation.missing" }),
      observation({ id: "obs_1" }),
      observation({ id: "obs_2", correctionMinutes: 20 }),
    ];
    const forwards = clusterObservations(observations, { comparableRuns: { rol_intake: 10 } });
    const backwards = clusterObservations([...observations].reverse(), {
      comparableRuns: { rol_intake: 10 },
    });
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
  });

  it("reports no rate at all rather than inventing a denominator", () => {
    const clusters = clusterObservations([observation({ id: "obs_1" })]);
    expect(clusters[0]?.comparableRuns).toBe(0);
    expect(clusters[0]?.rate).toBe(0);
    expect(clusters[0]?.summary).toContain("no comparable run count available");
  });

  it("caps the rate at every case rather than reporting more than 100%", () => {
    // Two corrections against one run: the same work was corrected twice. A
    // rate above 100% of cases is not a sentence anybody can act on.
    const clusters = clusterObservations(
      [observation({ id: "obs_1" }), observation({ id: "obs_2" })],
      { comparableRuns: { rol_intake: 1 } },
    );
    expect(clusters[0]?.rate).toBe(1);
  });

  it("keeps clusters for different roles apart", () => {
    const clusters = clusterObservations([
      observation({ id: "obs_1" }),
      observation({ id: "obs_2", roleId: "rol_other" as Id<"role"> }),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((entry) => entry.key).sort()).toEqual([
      clusterKey("rol_intake", "deadline.wrong_jurisdiction"),
      clusterKey("rol_other", "deadline.wrong_jurisdiction"),
    ]);
  });

  it("drops patterns below the minimum count, so one-offs do not fill a queue", () => {
    const clusters = clusterObservations(
      [observation({ id: "obs_1" }), observation({ id: "obs_2" }), observation({ id: "obs_3", signature: "one.off" })],
      { minimumCount: 2 },
    );
    expect(clusters.map((entry) => entry.signature)).toEqual(["deadline.wrong_jurisdiction"]);
  });
});

describe("the artifact allowlist", () => {
  it("permits the declarative artifacts the loop is allowed to change", () => {
    for (const kind of MUTABLE_ARTIFACT_KINDS) {
      expect(isMutableArtifactKind(kind)).toBe(true);
      expect(() => assertMutableArtifact({ kind, id: "rescission_intake.prompt" })).not.toThrow();
    }
  });

  it("refuses a kind that is not on the allowlist", () => {
    expect(() =>
      assertMutableArtifact({ kind: "source_file" as ArtifactKind, id: "anything" }),
    ).toThrowError(
      expect.objectContaining({ reason: "improvement.autonomous_application" }) as Error,
    );
  });

  it.each([
    ["packages/platform/src/improve/apply.ts", "a path"],
    ["src.improve.apply.ts", "an extension"],
    ["../../etc/passwd", "a parent-directory segment"],
    ["package.json", "a configuration file"],
    ["node_modules.evil", "a source directory"],
    ["./relative.rule", "a relative path"],
  ])("refuses %s, which names %s rather than an artifact", (id) => {
    let thrown: unknown;
    try {
      assertMutableArtifact({ kind: "guardrail_rule", id });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeniedError);
    expect((thrown as DeniedError).reason).toBe("improvement.autonomous_application");
  });

  it("refuses artifact content that carries prompt text", () => {
    let thrown: unknown;
    try {
      assertArtifactContent("guardrail_rule", {
        instruction: "Answer as follows: {{owner_message}}",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeniedError);
    expect((thrown as DeniedError).reason).toBe("improvement.autonomous_application");
  });

  it("refuses multi-line content, which is prose wearing a rule's clothes", () => {
    expect(() =>
      assertArtifactContent("guardrail_rule", { instruction: "line one\nline two" }),
    ).toThrow(InvalidInputError);
  });

  it("refuses content that hides a credential", () => {
    let thrown: unknown;
    try {
      assertArtifactContent("routing_rule", {
        endpoint: "https://user:hunter2secretpassword@records.example.com/api",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeniedError);
  });

  it("bounds content in every dimension, so padding one evades nothing", () => {
    const manyKeys: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) manyKeys[`field${index}`] = "x";
    expect(() => assertArtifactContent("guardrail_rule", manyKeys)).toThrow(InvalidInputError);

    expect(() =>
      assertArtifactContent("guardrail_rule", { note: "x".repeat(600) }),
    ).toThrow(InvalidInputError);

    // Every key legal, every value legal, the total far too big.
    const padded: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) padded[`field${index}`] = "x".repeat(500);
    expect(() => assertArtifactContent("guardrail_rule", padded)).toThrow(InvalidInputError);
  });

  it("lets a prompt binding name a committed prompt and nothing else", () => {
    expect(() =>
      assertArtifactContent("prompt_binding", {
        promptTemplateId: "contact.classify_owner_intent",
        promptTemplateVersion: 2,
      }),
    ).not.toThrow();

    expect(() =>
      assertArtifactContent("prompt_binding", {
        promptTemplateId: "contact.classify_owner_intent",
        promptTemplateVersion: 2,
        systemPrompt: "You are a helpful assistant.",
      }),
    ).toThrow(InvalidInputError);
  });

  it("fingerprints identity and body, so two states are comparable", () => {
    const left = artifactState({
      kind: "guardrail_rule",
      id: "intake.threshold",
      version: 2,
      content: { minimumConfidence: 0.8, requireCitation: true },
    });
    const right = artifactState({
      kind: "guardrail_rule",
      id: "intake.threshold",
      version: 2,
      content: { requireCitation: true, minimumConfidence: 0.8 },
    });
    expect(left.digest).toBe(right.digest);
    expect(left.digest).not.toBe(
      artifactDigest({ ...left, content: { minimumConfidence: 0.7, requireCitation: true } }),
    );
  });

  it("names the absence of an artifact rather than leaving a hole", () => {
    const absent = absentArtifact("routing_rule", "intake.route");
    expect(absent.version).toBe(0);
    expect(absent.content).toEqual({});
    expect(absent.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("the golden-set protection guard", () => {
  /**
   * Exercised here as well as in `roles/`, because this is the module that
   * would benefit from weakening it. A loop that can both propose improvements
   * and edit the test that judges them will eventually mark its own homework,
   * and the cheapest path to a better score is always to move the goalposts.
   */
  it("allows cases to be added", () => {
    const current = goldenSet();
    const proposed: GoldenSet = {
      ...current,
      version: 2,
      cases: [...current.cases, goldenCase({ id: "nevada-window" })],
    };
    const delta = assertGoldenSetNotWeakened(current, proposed);
    expect(delta.addedCaseIds).toEqual(["nevada-window"]);
    expect(delta.unchangedCaseCount).toBe(2);
  });

  it.each([
    [
      "deleting a case",
      (current: GoldenSet): GoldenSet => ({
        ...current,
        version: 2,
        cases: current.cases.slice(0, 1),
      }),
    ],
    [
      "relabelling an expectation",
      (current: GoldenSet): GoldenSet => ({
        ...current,
        version: 2,
        cases: [
          goldenCase({ id: "cancel-plain", expected: { kind: "contains", values: ["anything"] } }),
          goldenCase({ id: "billing-not-rescission" }),
        ],
      }),
    ],
    [
      "relaxing an expectation to accept anything",
      (current: GoldenSet): GoldenSet => ({
        ...current,
        version: 2,
        cases: [
          goldenCase({ id: "cancel-plain", expected: { kind: "any" } }),
          goldenCase({ id: "billing-not-rescission" }),
        ],
      }),
    ],
    [
      "renaming a case so the original is orphaned",
      (current: GoldenSet): GoldenSet => ({
        ...current,
        version: 2,
        cases: [
          goldenCase({ id: "cancel-plain-v2" }),
          goldenCase({ id: "billing-not-rescission" }),
        ],
      }),
    ],
    [
      "lowering the threshold",
      (current: GoldenSet): GoldenSet => ({ ...current, version: 2, threshold: 0.1 }),
    ],
    [
      "changing the input while keeping the expectation as cover",
      (current: GoldenSet): GoldenSet => ({
        ...current,
        version: 2,
        cases: [
          goldenCase({ id: "cancel-plain", input: { categories: "a,b", message: "hello" } }),
          goldenCase({ id: "billing-not-rescission" }),
        ],
      }),
    ],
    [
      "retagging so the fairness slices change",
      (current: GoldenSet): GoldenSet => ({
        ...current,
        version: 2,
        cases: [
          goldenCase({ id: "cancel-plain", tags: ["jurisdiction:NV"] }),
          goldenCase({ id: "billing-not-rescission" }),
        ],
      }),
    ],
  ])("refuses %s", (_name, weaken) => {
    const current = goldenSet();
    let thrown: unknown;
    try {
      assertGoldenSetNotWeakened(current, weaken(current));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeniedError);
    expect((thrown as DeniedError).reason).toBe("improvement.protected_case_weakened");
  });
});

describe("the trial verdict", () => {
  const baselineResults = [
    caseResult("a", "passed"),
    caseResult("b", "failed"),
    caseResult("c", "failed"),
    caseResult("d", "passed"),
  ];

  it("offers a change that improves quality with nothing regressing", () => {
    const verdict = assessTrial(
      {
        baseline: evaluationRun({ id: "evl_base", results: baselineResults }),
        candidate: evaluationRun({
          id: "evl_cand",
          results: [
            caseResult("a", "passed"),
            caseResult("b", "passed"),
            caseResult("c", "failed"),
            caseResult("d", "passed"),
          ],
        }),
      },
      { minimumGain: 0, evaluatedAt: NOW },
    );

    expect(verdict.offered).toBe(true);
    expect(verdict.withheldReason).toBe("");
    expect(verdict.improvedCaseIds).toEqual(["b"]);
    expect(verdict.regressedCaseIds).toEqual([]);
    expect(verdict.delta).toBe(0.25);
  });

  it("withholds a change that does not improve measured quality", () => {
    const verdict = assessTrial(
      {
        baseline: evaluationRun({ id: "evl_base", results: baselineResults }),
        candidate: evaluationRun({ id: "evl_cand", results: baselineResults }),
      },
      { minimumGain: 0, evaluatedAt: NOW },
    );
    expect(verdict.offered).toBe(false);
    expect(verdict.withheldReason).toContain("does not improve measured quality");
  });

  it("withholds a change that moves quality around rather than adding any", () => {
    const verdict = assessTrial(
      {
        baseline: evaluationRun({ id: "evl_base", results: baselineResults }),
        candidate: evaluationRun({
          id: "evl_cand",
          results: [
            // Two newly passing, one newly failing: the aggregate improves and
            // a case that used to work is now broken.
            caseResult("a", "failed"),
            caseResult("b", "passed"),
            caseResult("c", "passed"),
            caseResult("d", "passed"),
          ],
        }),
      },
      { minimumGain: 0, evaluatedAt: NOW },
    );
    expect(verdict.offered).toBe(false);
    expect(verdict.regressedCaseIds).toEqual(["a"]);
    expect(verdict.withheldReason).toContain("no longer pass");
  });

  it("withholds a trial that errored, because it measured nothing", () => {
    const verdict = assessTrial(
      {
        baseline: evaluationRun({ id: "evl_base", results: baselineResults }),
        candidate: evaluationRun({
          id: "evl_cand",
          results: [
            caseResult("a", "passed"),
            caseResult("b", "passed"),
            caseResult("c", "passed"),
            caseResult("d", "errored"),
          ],
        }),
      },
      { minimumGain: 0, evaluatedAt: NOW },
    );
    expect(verdict.offered).toBe(false);
    expect(verdict.withheldReason).toContain("errored");
  });

  it("withholds a change that is better and still not good enough", () => {
    const verdict = assessTrial(
      {
        baseline: evaluationRun({
          id: "evl_base",
          results: [caseResult("a", "failed"), caseResult("b", "failed")],
          threshold: 0.9,
        }),
        candidate: evaluationRun({
          id: "evl_cand",
          results: [caseResult("a", "passed"), caseResult("b", "failed")],
          threshold: 0.9,
        }),
      },
      { minimumGain: 0, evaluatedAt: NOW },
    );
    expect(verdict.offered).toBe(false);
    expect(verdict.withheldReason).toContain("Better is not the same as good enough");
  });

  it("withholds a gain smaller than the bar the operator set", () => {
    const verdict = assessTrial(
      {
        baseline: evaluationRun({ id: "evl_base", results: baselineResults }),
        candidate: evaluationRun({
          id: "evl_cand",
          results: [
            caseResult("a", "passed"),
            caseResult("b", "passed"),
            caseResult("c", "failed"),
            caseResult("d", "passed"),
          ],
        }),
      },
      { minimumGain: 0.5, evaluatedAt: NOW },
    );
    expect(verdict.offered).toBe(false);
    expect(verdict.withheldReason).toContain("below the");
  });
});

describe("trial comparability", () => {
  const proposal = { id: "prp_1", roleId: "rol_intake" } as Proposal;

  it("accepts two runs over the same cases for the same role", () => {
    expect(() =>
      assertComparableTrial(proposal, {
        baseline: evaluationRun({ id: "evl_base", results: [caseResult("a", "failed")] }),
        candidate: evaluationRun({ id: "evl_cand", results: [caseResult("a", "passed")] }),
      }),
    ).not.toThrow();
  });

  it("refuses a candidate measured against an easier set", () => {
    let thrown: unknown;
    try {
      assertComparableTrial(proposal, {
        baseline: evaluationRun({ id: "evl_base", results: [caseResult("a", "failed")] }),
        candidate: evaluationRun({
          id: "evl_cand",
          results: [caseResult("a", "passed")],
          goldenSetVersion: 2,
          goldenSetDigest: digestValue({ set: "easier" }),
        }),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeniedError);
    expect((thrown as DeniedError).reason).toBe("approval.digest_mismatch");
  });

  it("refuses one run compared with itself", () => {
    expect(() =>
      assertComparableTrial(proposal, {
        baseline: evaluationRun({ id: "evl_same", results: [caseResult("a", "passed")] }),
        candidate: evaluationRun({ id: "evl_same", results: [caseResult("a", "passed")] }),
      }),
    ).toThrow(DeniedError);
  });

  it("refuses a trial that measured a different role", () => {
    expect(() =>
      assertComparableTrial(proposal, {
        baseline: evaluationRun({ id: "evl_base", results: [caseResult("a", "failed")] }),
        candidate: evaluationRun({
          id: "evl_cand",
          results: [caseResult("a", "passed")],
          roleId: "rol_someone_else",
        }),
      }),
    ).toThrow(DeniedError);
  });

  it("refuses a baseline that errored, because the comparison point is unsound", () => {
    expect(() =>
      assertComparableTrial(proposal, {
        baseline: evaluationRun({
          id: "evl_base",
          results: [caseResult("a", "errored")],
        }),
        candidate: evaluationRun({ id: "evl_cand", results: [caseResult("a", "passed")] }),
      }),
    ).toThrow(DeniedError);
  });
});

describe("the offered gate", () => {
  it("refuses a proposal that has never been measured", () => {
    let thrown: unknown;
    try {
      assertOffered({ id: "prp_1" } as Proposal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeniedError);
    expect((thrown as DeniedError).reason).toBe("improvement.evaluation_regression");
    expect((thrown as Error).message).toContain("never been measured");
  });

  it("refuses a proposal that was withheld", () => {
    const proposal = {
      id: "prp_1",
      evaluation: { offered: false, withheldReason: "no improvement", delta: 0, regressedCaseIds: [] },
    } as unknown as Proposal;
    expect(() => assertOffered(proposal)).toThrow(DeniedError);
  });
});

describe("proposal fingerprints and inertness", () => {
  const base = {
    proposalId: "prp_1" as Id<"proposal">,
    target: { kind: "prompt_binding" as ArtifactKind, id: "intake.prompt" },
    roleId: "rol_intake" as Id<"role">,
    roleVersion: 1,
    beforeDigest: digestValue({ v: 1 }),
    afterDigest: digestValue({ v: 2 }),
  };

  it("is stable for the same change and different for a different one", () => {
    expect(changeDigest(base)).toBe(changeDigest({ ...base }));
    expect(changeDigest({ ...base, afterDigest: digestValue({ v: 3 }) })).not.toBe(
      changeDigest(base),
    );
  });

  it("covers the cases a proposal would add, so one approval cannot cover another", () => {
    const withCase = changeDigest({ ...base, addedCases: [goldenCase({ id: "nevada" })] });
    const withOther = changeDigest({ ...base, addedCases: [goldenCase({ id: "florida" })] });
    expect(withCase).not.toBe(withOther);
    expect(withCase).not.toBe(changeDigest(base));
  });

  it("hands back a frozen value with nothing on it to invoke", () => {
    const proposal = freezeProposal({
      id: "prp_1",
      status: "drafted",
      target: base.target,
      roleId: base.roleId,
      roleVersion: 1,
      clusterKey: "rol_intake::deadline.wrong_jurisdiction",
      observationIds: [],
      rationale: "why",
      before: artifactState({
        kind: "prompt_binding",
        id: "intake.prompt",
        version: 1,
        content: { promptTemplateId: "t", promptTemplateVersion: 1 },
      }),
      after: artifactState({
        kind: "prompt_binding",
        id: "intake.prompt",
        version: 2,
        content: { promptTemplateId: "t", promptTemplateVersion: 2 },
      }),
      digest: changeDigest(base),
      createdAt: NOW,
      createdBy: CURATOR,
    } as Proposal);

    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.after)).toBe(true);
    expect(callableProperties(proposal)).toEqual([]);

    // A caller cannot bolt an executor onto it and pass it on as though the
    // platform had provided one.
    expect(() => {
      (proposal as unknown as Record<string, unknown>)["apply"] = () => undefined;
    }).toThrow(TypeError);
  });
});

describe("the diff an approver reads", () => {
  it("names every field that moved and nothing that did not", () => {
    const changes = diffArtifactContent(
      { promptTemplateId: "intake", promptTemplateVersion: 1, unchanged: true },
      { promptTemplateId: "intake", promptTemplateVersion: 2, added: "yes" },
    );
    expect(changes).toEqual([
      { field: "added", kind: "added", to: "yes" },
      { field: "promptTemplateVersion", kind: "changed", from: "1", to: "2" },
      { field: "unchanged", kind: "removed", from: "true" },
    ]);
  });
});

describe("the proposal state machine", () => {
  it("permits the moves the loop actually makes", () => {
    expect(() => assertTransition("drafted", "offered")).not.toThrow();
    expect(() => assertTransition("offered", "approved")).not.toThrow();
    expect(() => assertTransition("approved", "applied")).not.toThrow();
    expect(() => assertTransition("applied", "reverted")).not.toThrow();
  });

  it.each([
    ["drafted", "applied"],
    ["drafted", "approved"],
    ["withheld", "approved"],
    ["offered", "applied"],
    ["rejected", "offered"],
    ["reverted", "applied"],
    ["applied", "approved"],
  ] as const)("refuses %s → %s", (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(InvalidInputError);
  });
});

describe("observation deduplication keys", () => {
  it("is the same for a retry of the same correction", () => {
    const input = {
      runId: "run_1",
      kind: "human_correction" as const,
      signature: "deadline.wrong_jurisdiction",
      stepId: "stp_1",
      beforeDigest: digestValue({ before: 1 }),
      afterDigest: digestValue({ after: 1 }),
    };
    expect(observationKey(input)).toBe(observationKey({ ...input }));
  });

  it("differs when the correction itself differs", () => {
    const input = {
      runId: "run_1",
      kind: "human_correction" as const,
      signature: "deadline.wrong_jurisdiction",
      stepId: "stp_1",
      beforeDigest: digestValue({ before: 1 }),
      afterDigest: digestValue({ after: 1 }),
    };
    expect(observationKey({ ...input, afterDigest: digestValue({ after: 2 }) })).not.toBe(
      observationKey(input),
    );
  });
});

/** Every property on the value, at any depth, that could be called. */
function callableProperties(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (typeof entry === "function") found.push(here);
    else found.push(...callableProperties(entry, here));
  }
  return found;
}
