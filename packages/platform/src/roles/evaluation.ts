import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { Authorizer } from "../guard/authorize.js";
import { canonicalJson } from "../kernel/canonical.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import type { ModelInventory } from "../models/inventory.js";
import type { ModelGateway } from "../models/invoke.js";
import type { PromptTemplateRegistry } from "../models/templates.js";
import { roundUsd } from "../models/types.js";
import type { ActorRef, OperatingMode } from "../record/types.js";
import { EVALUATE_ROLE_ACTION } from "./actions.js";
import type { EvaluationStore, RoleStore } from "./port.js";
import {
  STRICTNESS_RANK,
  type CaseOutcome,
  type CaseResult,
  type EvaluationRun,
  type ExpectedOutcome,
  type GoldenCase,
  type GoldenSet,
} from "./types.js";

/**
 * The evaluation harness.
 *
 * "Quality is measured, not asserted" is the sentence this module has to make
 * true. A role does not get to act because someone believes it works; it acts
 * because it was run against a curated set of real-shaped cases, the results
 * were recorded, and a person read them.
 *
 * Three things here are controls rather than machinery.
 *
 * *The golden set is the ground truth of record.* It is curated by humans, it
 * is immutable per version, and `assertGoldenSetNotWeakened` refuses any
 * proposal that deletes, relabels, weakens, or renames an existing case.
 * That guard exists for the improvement loop: a system that can both propose
 * improvements and edit the test that judges them is a system that will
 * eventually mark its own homework. Adding cases is always allowed, because
 * that is how a golden set grows and it can only make the bar higher.
 *
 * *Evidence names the system it measured.* An `EvaluationRun` records the
 * definition digest, the golden-set digest, and the model and prompt versions
 * it actually ran against. Promotion checks all of them, so evidence that
 * describes a different model, a different prompt, or a different set of cases
 * cannot be presented as evidence for what is about to run.
 *
 * *The answers are not retained.* Each case result carries a digest of the
 * answer, the operating-record step it came from, and a description of the
 * expectation that was or was not met. Keeping the model's text for every case
 * for the life of a role would make this table a second copy of everything the
 * platform has ever been asked, held outside the systems whose retention rules
 * govern the originals.
 */

/**
 * Denial reasons that end the whole evaluation rather than scoring one case.
 *
 * A screen refusing crafted input, or a model declining a question, is a
 * measurement: the case has an outcome and the run continues. A ceiling being
 * passed, a containment switch being engaged, or the record being unreachable
 * are not measurements — they mean the platform must stop, and a harness that
 * scored them as failing cases would report a quality regression when what
 * actually happened is that an operator hit the stop button.
 */
const ABORTING_DENIAL_PREFIXES: readonly string[] = [
  "ceiling.",
  "containment.",
  "record.",
  "config.",
  "model.not_in_inventory",
];

function abortsEvaluation(reason: string): boolean {
  return ABORTING_DENIAL_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/** Fingerprint of exactly which cases a run was measured against. */
export function goldenSetDigest(set: GoldenSet): Digest {
  return digestValue({
    id: set.id,
    version: set.version,
    task: set.task,
    threshold: set.threshold,
    synthetic: set.synthetic,
    cases: [...set.cases]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((entry) => ({
        id: entry.id,
        input: entry.input,
        expected: entry.expected,
        tags: [...entry.tags].sort(),
        protectedAttributes: entry.protectedAttributes ?? {},
      })),
  });
}

/**
 * Validate a curated set.
 *
 * @throws {InvalidInputError} on a structural problem, and specifically when a
 *   case carries protected-class attributes on a set that is not marked
 *   synthetic. This platform does not hold protected-class attributes about
 *   real people; a fairness fixture that did would be a larger problem than
 *   the disparity it was measuring.
 */
export function assertGoldenSet(set: GoldenSet, templateVariables?: readonly string[]): void {
  if (typeof set.id !== "string" || set.id.trim().length === 0) {
    throw new InvalidInputError("A golden set needs a stable id.", "id");
  }
  if (!Number.isInteger(set.version) || set.version < 1) {
    throw new InvalidInputError(`Golden set "${set.id}" needs a positive version.`, "version");
  }
  if (typeof set.task !== "string" || set.task.trim().length === 0) {
    throw new InvalidInputError(
      `Golden set "${set.id}" needs the logical model task its cases exercise.`,
      "task",
    );
  }
  if (typeof set.threshold !== "number" || set.threshold < 0 || set.threshold > 1) {
    throw new InvalidInputError(
      `Golden set "${set.id}" needs a threshold between 0 and 1.`,
      "threshold",
    );
  }
  if (typeof set.curatedBy !== "string" || set.curatedBy.trim().length === 0) {
    throw new InvalidInputError(
      `Golden set "${set.id}" needs to name who curated it. It is the ground truth of record, so the record says whose judgement it is.`,
      "curatedBy",
    );
  }
  if (set.cases.length === 0) {
    throw new InvalidInputError(
      `Golden set "${set.id}" has no cases, so a run against it would establish nothing while reporting perfect accuracy.`,
      "cases",
    );
  }

  const seen = new Set<string>();
  for (const entry of set.cases) {
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
      throw new InvalidInputError(`Golden set "${set.id}" has a case with no id.`, "cases");
    }
    if (seen.has(entry.id)) {
      throw new InvalidInputError(
        `Golden set "${set.id}" has two cases with id "${entry.id}". Case ids are how a result joins to its expectation.`,
        "cases",
      );
    }
    seen.add(entry.id);

    assertExpectation(set.id, entry);

    if (entry.protectedAttributes && Object.keys(entry.protectedAttributes).length > 0) {
      if (!set.synthetic) {
        throw new InvalidInputError(
          `Case "${entry.id}" in golden set "${set.id}" carries protected-class attributes, but the set is not marked synthetic. Fairness fixtures are synthetic test data only — this platform does not hold protected-class attributes about real people.`,
          "protectedAttributes",
        );
      }
    }

    if (templateVariables) {
      const supplied = Object.keys(entry.input).sort();
      const required = [...templateVariables].sort();
      if (canonicalJson(supplied) !== canonicalJson(required)) {
        // Caught here rather than at the first model call, so a mis-shaped set
        // refuses before any of it has been paid for.
        throw new InvalidInputError(
          `Case "${entry.id}" in golden set "${set.id}" supplies [${supplied.join(", ")}] but the prompt template declares [${required.join(", ")}].`,
          "input",
        );
      }
    }
  }
}

function assertExpectation(setId: string, entry: GoldenCase): void {
  const expected = entry.expected;
  switch (expected.kind) {
    case "exact":
      if (typeof expected.value !== "string" || expected.value.trim().length === 0) {
        throw new InvalidInputError(
          `Case "${entry.id}" in golden set "${setId}" expects an exact answer but states none.`,
          "expected",
        );
      }
      return;
    case "contains":
      if (expected.values.length === 0 || expected.values.some((value) => value.trim() === "")) {
        throw new InvalidInputError(
          `Case "${entry.id}" in golden set "${setId}" expects phrases but lists none. A "contains" case with no phrases passes on any answer.`,
          "expected",
        );
      }
      return;
    case "refusal":
      if (typeof expected.ground !== "string" || expected.ground.trim().length === 0) {
        throw new InvalidInputError(
          `Case "${entry.id}" in golden set "${setId}" expects a refusal but states no ground for it.`,
          "expected",
        );
      }
      return;
    case "any":
      return;
    default: {
      const unreachable: never = expected;
      throw new InvalidInputError(
        `Case "${entry.id}" in golden set "${setId}" has an unknown expectation: ${JSON.stringify(unreachable)}`,
        "expected",
      );
    }
  }
}

export interface GoldenSetDelta {
  readonly addedCaseIds: readonly string[];
  readonly unchangedCaseCount: number;
}

/**
 * Refuse a proposed golden set that weakens the existing one.
 *
 * This is the guard the improvement loop uses. The loop may propose that the
 * ground truth grow; it may not propose that the ground truth get easier. The
 * four shapes it would otherwise take are all refused:
 *
 *   delete a case          the hard case simply disappears
 *   change an expectation  the case now expects what the role already does
 *   relax an expectation   `exact` becomes `contains`, `contains` becomes `any`
 *   rename a case id       the original is orphaned and the "new" case is easy
 *
 * Adding cases is allowed and is the only permitted change, because a larger
 * set can only make the bar higher. Lowering the threshold is refused for the
 * same reason a weakened case is: it is the aggregate version of the same
 * move.
 *
 * Tightening an existing case is refused here too, and that is deliberate
 * rather than an oversight. A golden set is curated by humans and this
 * function is the automated path; a curator who wants to strengthen a case
 * does so directly, as a curation change with their name on it. Allowing the
 * automated loop to "tighten" would require this function to decide which
 * rewrites are genuinely stronger, and that decision is exactly the thing that
 * must not be automated.
 *
 * @throws {DeniedError} `improvement.protected_case_weakened`
 */
export function assertGoldenSetNotWeakened(
  current: GoldenSet,
  proposed: GoldenSet,
): GoldenSetDelta {
  if (current.id !== proposed.id) {
    throw new DeniedError(
      "improvement.protected_case_weakened",
      `A proposal to change golden set "${current.id}" arrived under the id "${proposed.id}". A set under a different id is a different body of ground truth, not a change to this one.`,
      { goldenSetId: current.id, proposedId: proposed.id },
    );
  }
  if (current.task !== proposed.task) {
    throw new DeniedError(
      "improvement.protected_case_weakened",
      `Golden set "${current.id}" measures task "${current.task}"; the proposal measures "${proposed.task}". Repointing a set at a different task orphans every result ever recorded against it.`,
      { goldenSetId: current.id },
    );
  }
  if (proposed.synthetic !== current.synthetic) {
    // Both directions are refused. Flipping to `true` would let a fairness
    // analysis run over material that is not invented, which is the one thing
    // bias.ts exists to prevent; flipping to `false` would silently disable
    // every fairness comparison that has been made against this set.
    throw new DeniedError(
      "improvement.protected_case_weakened",
      `The proposal changes golden set "${current.id}" from synthetic=${current.synthetic} to synthetic=${proposed.synthetic}. Whether a set is invented test data is a fact about how it was curated, not a flag a proposal may set.`,
      { goldenSetId: current.id, shape: "synthetic_changed" },
    );
  }
  if (proposed.threshold < current.threshold) {
    throw new DeniedError(
      "improvement.protected_case_weakened",
      `The proposal lowers the threshold for golden set "${current.id}" from ${current.threshold} to ${proposed.threshold}. Lowering the bar is the aggregate form of weakening a case.`,
      {
        goldenSetId: current.id,
        currentThreshold: current.threshold,
        proposedThreshold: proposed.threshold,
      },
    );
  }

  const proposedById = new Map(proposed.cases.map((entry) => [entry.id, entry]));
  const currentById = new Map(current.cases.map((entry) => [entry.id, entry]));
  const addedCaseIds: string[] = [];
  for (const entry of proposed.cases) {
    if (!currentById.has(entry.id)) addedCaseIds.push(entry.id);
  }

  for (const existing of current.cases) {
    const candidate = proposedById.get(existing.id);
    if (!candidate) {
      // Distinguish a deletion from a rename, because they are different
      // mistakes and the person reading the refusal needs to know which.
      const renamedTo = addedCaseIds.find((id) => {
        const added = proposedById.get(id);
        return added !== undefined && sameSubstance(existing, added);
      });
      throw new DeniedError(
        "improvement.protected_case_weakened",
        renamedTo
          ? `Case "${existing.id}" in golden set "${current.id}" was renamed to "${renamedTo}". The original id is what every recorded result joins to, so renaming it orphans the history and presents an old case as a new one.`
          : `Case "${existing.id}" was deleted from golden set "${current.id}". Existing ground truth is protected; cases may be added, never removed.`,
        {
          goldenSetId: current.id,
          caseId: existing.id,
          shape: renamedTo ? "renamed" : "deleted",
          ...(renamedTo ? { renamedTo } : {}),
        },
      );
    }

    if (canonicalJson(existing.expected) !== canonicalJson(candidate.expected)) {
      throw new DeniedError(
        "improvement.protected_case_weakened",
        `Case "${existing.id}" in golden set "${current.id}" ${describeChange(existing.expected, candidate.expected)}. Existing expected outcomes are the ground truth of record and are not changed by an automated proposal.`,
        {
          goldenSetId: current.id,
          caseId: existing.id,
          shape: changeShape(existing.expected, candidate.expected),
          from: existing.expected.kind,
          to: candidate.expected.kind,
        },
      );
    }

    if (canonicalJson(existing.input) !== canonicalJson(candidate.input)) {
      throw new DeniedError(
        "improvement.protected_case_weakened",
        `Case "${existing.id}" in golden set "${current.id}" keeps its expected outcome but changes its input, so the expectation no longer describes the same question. That is a weakening with the expectation left in place as cover.`,
        { goldenSetId: current.id, caseId: existing.id, shape: "input_changed" },
      );
    }

    if (
      canonicalJson([...existing.tags].sort()) !== canonicalJson([...candidate.tags].sort()) ||
      canonicalJson(existing.protectedAttributes ?? {}) !==
        canonicalJson(candidate.protectedAttributes ?? {})
    ) {
      // Tags and protected attributes decide which cases are compared against
      // which in the fairness analysis. Retagging silently changes the groups
      // a disparity is computed over.
      throw new DeniedError(
        "improvement.protected_case_weakened",
        `Case "${existing.id}" in golden set "${current.id}" was retagged. Tags and protected attributes decide how results are sliced, so changing them changes what every fairness comparison means.`,
        { goldenSetId: current.id, caseId: existing.id, shape: "retagged" },
      );
    }
  }

  return {
    addedCaseIds: addedCaseIds.sort(),
    unchangedCaseCount: current.cases.length,
  };
}

function sameSubstance(left: GoldenCase, right: GoldenCase): boolean {
  return (
    canonicalJson(left.input) === canonicalJson(right.input) &&
    canonicalJson(left.expected) === canonicalJson(right.expected)
  );
}

function changeShape(from: ExpectedOutcome, to: ExpectedOutcome): string {
  if (STRICTNESS_RANK[to.kind] < STRICTNESS_RANK[from.kind]) return "weakened";
  if (
    from.kind === "contains" &&
    to.kind === "contains" &&
    from.values.some((value) => !to.values.includes(value))
  ) {
    return "weakened";
  }
  return "relabelled";
}

function describeChange(from: ExpectedOutcome, to: ExpectedOutcome): string {
  const shape = changeShape(from, to);
  return shape === "weakened"
    ? `was relaxed from a "${from.kind}" expectation to a "${to.kind}" one`
    : `had its expected outcome relabelled (still "${to.kind}", but not the same one)`;
}

/**
 * Score one answer against one expectation.
 *
 * Deliberately literal. A scorer that used a model to judge whether an answer
 * was "close enough" would put the thing under test in charge of its own
 * grade, and would make the measurement non-deterministic — so the same
 * evidence would not reproduce.
 */
export function scoreExpectation(
  expected: ExpectedOutcome,
  answer: string,
): { readonly outcome: Extract<CaseOutcome, "passed" | "failed">; readonly detail: string } {
  const normalised = normaliseAnswer(answer);

  switch (expected.kind) {
    case "exact": {
      const want = normaliseAnswer(expected.value);
      return normalised === want
        ? { outcome: "passed", detail: "matched the expected answer exactly" }
        : { outcome: "failed", detail: `expected exactly "${truncate(expected.value)}"` };
    }
    case "contains": {
      const missing = expected.values.filter(
        (value) => !normalised.includes(normaliseAnswer(value)),
      );
      return missing.length === 0
        ? {
            outcome: "passed",
            detail: `contained all ${expected.values.length} required phrase(s)`,
          }
        : {
            outcome: "failed",
            detail: `missing required phrase(s): ${missing.map(truncate).join("; ")}`,
          };
    }
    case "refusal": {
      const ground = normaliseAnswer(expected.ground);
      return normalised.includes(ground)
        ? { outcome: "passed", detail: `refused on the expected ground` }
        : {
            outcome: "failed",
            detail: `expected a refusal citing "${truncate(expected.ground)}"; the answer did not`,
          };
    }
    case "any":
      return { outcome: "passed", detail: "case asserts nothing about the answer" };
    default: {
      const unreachable: never = expected;
      throw new InvalidInputError(
        `Unknown expectation: ${JSON.stringify(unreachable)}`,
        "expected",
      );
    }
  }
}

function normaliseAnswer(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function truncate(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export interface RunEvaluationInput {
  readonly roleId: Id<"role">;
  /** The version being measured. Drafts are the usual case: measure, then promote. */
  readonly version: number;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  /** The operating-record run the model calls are charged to. */
  readonly runId: Id<"run">;
  /** Overrides the version's declared evaluation set. Used to test a candidate set. */
  readonly goldenSetId?: string | undefined;
  readonly goldenSetVersion?: number | undefined;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export interface EvaluationHarnessDependencies {
  readonly roles: RoleStore;
  readonly evaluations: EvaluationStore;
  readonly gateway: ModelGateway;
  readonly inventory: ModelInventory;
  readonly templates: PromptTemplateRegistry;
  readonly authorizer: Authorizer;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class EvaluationHarness {
  constructor(private readonly deps: EvaluationHarnessDependencies) {}

  /**
   * Run a role version against a golden set and record what happened.
   *
   * Nothing here asserts quality. It runs the cases, scores them literally,
   * and writes the numbers down — including the failures, including the cost,
   * and including which model and prompt produced them.
   *
   * @throws {DeniedError} for anything that means the platform must stop: a
   *   ceiling passed, a containment switch engaged, the record unreachable.
   *   A case the platform refuses on its merits is recorded as a case outcome
   *   and the run continues.
   */
  async runEvaluation(input: RunEvaluationInput): Promise<EvaluationRun> {
    const role = await this.deps.roles.requireRole(input.roleId);
    const version = await this.deps.roles.requireVersion(input.roleId, input.version);
    const definition = version.definition;

    const goldenSet = await this.deps.evaluations.requireGoldenSet(
      input.goldenSetId ?? definition.evaluationSetId,
      input.goldenSetVersion,
    );

    // Resolve before authorising so a mis-shaped set or an unknown task is
    // refused before anything is recorded, let alone spent.
    const entry = this.deps.inventory.resolve(definition.modelTask);
    const template = this.deps.templates.require(
      definition.promptTemplateId,
      definition.promptTemplateVersion,
    );

    if (goldenSet.task !== definition.modelTask) {
      throw new InvalidInputError(
        `Golden set "${goldenSet.id}" measures task "${goldenSet.task}" but role "${role.name}" v${version.version} runs "${definition.modelTask}". Measuring one task and promoting another proves nothing.`,
        "goldenSetId",
      );
    }
    assertGoldenSet(goldenSet, template.variables);

    await this.deps.authorizer.authorize({
      action: EVALUATE_ROLE_ACTION,
      actor: input.actor,
      mode: input.mode,
      runId: input.runId,
      correlationId: input.correlationId,
      subject: {
        roleId: role.id,
        roleName: role.name,
        roleVersion: String(version.version),
        goldenSetId: goldenSet.id,
      },
      secondsSinceAuthentication: input.secondsSinceAuthentication,
    });

    const startedAt = this.deps.clock.nowIso();
    const results: CaseResult[] = [];

    for (const entryCase of goldenSet.cases) {
      results.push(
        await this.runCase(entryCase, definition.modelTask, input, {
          goldenSetId: goldenSet.id,
        }),
      );
    }

    const passed = results.filter((result) => result.outcome === "passed").length;
    const errored = results.filter((result) => result.outcome === "errored").length;
    const failed = results.length - passed - errored;
    const accuracy = results.length === 0 ? 0 : round(passed / results.length);

    const run: EvaluationRun = {
      id: this.deps.ids.next("evaluation"),
      roleId: role.id,
      roleVersion: version.version,
      definitionDigest: version.definitionDigest,
      goldenSetId: goldenSet.id,
      goldenSetVersion: goldenSet.version,
      goldenSetDigest: goldenSetDigest(goldenSet),
      task: definition.modelTask,
      modelId: entry.modelId,
      modelVersion: entry.modelVersion,
      promptTemplateId: template.id,
      promptTemplateVersion: template.version,
      runId: input.runId,
      evaluatedBy: input.actor,
      startedAt,
      completedAt: this.deps.clock.nowIso(),
      caseCount: results.length,
      passed,
      failed,
      errored,
      accuracy,
      threshold: goldenSet.threshold,
      meetsThreshold: accuracy >= goldenSet.threshold,
      syntheticFixtures: goldenSet.synthetic,
      results,
      totalCostUsd: roundUsd(results.reduce((total, result) => total + result.costUsd, 0)),
    };

    const recorded = await this.deps.evaluations.recordEvaluation(run);

    await this.deps.audit.record(
      auditDecision({
        eventType: "evaluation.completed",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        runId: input.runId,
        correlationId: input.correlationId,
        subject: {
          roleId: role.id,
          roleName: role.name,
          roleVersion: String(version.version),
          evaluationRunId: recorded.id,
          goldenSetId: goldenSet.id,
        },
        inputDigests: {
          definition: version.definitionDigest,
          goldenSet: run.goldenSetDigest,
        },
        decision: {
          cases: run.caseCount,
          passed: run.passed,
          failed: run.failed,
          errored: run.errored,
          accuracy: run.accuracy,
          threshold: run.threshold,
          meetsThreshold: run.meetsThreshold,
          modelId: run.modelId,
          modelVersion: run.modelVersion,
          promptTemplateId: run.promptTemplateId,
          promptTemplateVersion: run.promptTemplateVersion,
          costUsd: run.totalCostUsd,
        },
      }),
    );

    return recorded;
  }

  /**
   * Publish a proposed version of a golden set, through the protection guard.
   *
   * The guard is exported for callers that only want to check, but this is the
   * path that writes — so an automated proposer cannot publish by forgetting to
   * call it. First publication of a set is allowed outright; every later
   * version is compared against the current one and refused if it weakens
   * anything.
   *
   * The governance decision around the proposal — who proposed it, who
   * approved it, what it was for — belongs to the improvement loop and is
   * recorded there. This method's job is that the ground truth cannot get
   * easier on the way in.
   *
   * @throws {DeniedError} `improvement.protected_case_weakened`
   */
  async publishGoldenSet(proposed: GoldenSet): Promise<{
    readonly set: GoldenSet;
    readonly delta: GoldenSetDelta | null;
  }> {
    assertGoldenSet(proposed);

    const current = await this.deps.evaluations.getGoldenSet(proposed.id);
    if (!current) {
      return { set: await this.deps.evaluations.putGoldenSet(proposed), delta: null };
    }

    if (proposed.version <= current.version) {
      throw new DeniedError(
        "improvement.protected_case_weakened",
        `Golden set "${proposed.id}" is at v${current.version}; the proposal arrived as v${proposed.version}. A curated set is immutable once published, so a change is a new version rather than a rewrite of one that results already cite.`,
        { goldenSetId: proposed.id, currentVersion: current.version, proposedVersion: proposed.version },
      );
    }

    const delta = assertGoldenSetNotWeakened(current, proposed);
    return { set: await this.deps.evaluations.putGoldenSet(proposed), delta };
  }

  private async runCase(
    entry: GoldenCase,
    task: string,
    input: RunEvaluationInput,
    context: { readonly goldenSetId: string },
  ): Promise<CaseResult> {
    const base = {
      caseId: entry.id,
      tags: [...entry.tags].sort(),
      protectedAttributes: entry.protectedAttributes,
    };

    try {
      const answer = await this.deps.gateway.invoke(
        task,
        { variables: entry.input },
        {
          runId: input.runId,
          actor: input.actor,
          stepName: `evaluate:${context.goldenSetId}:${entry.id}`,
          correlationId: input.correlationId,
          subject: {
            roleId: input.roleId,
            roleVersion: String(input.version),
            goldenCaseId: entry.id,
          },
          // Stable across a retry of the same case in the same run, so a crash
          // mid-evaluation does not double-charge the cases already measured.
          idempotencyKey: `${input.runId}:eval:${context.goldenSetId}:${entry.id}`,
        },
      );

      const scored = scoreExpectation(entry.expected, answer.text);
      return {
        ...base,
        outcome: scored.outcome,
        detail: scored.detail,
        responseDigest: answer.invocation.responseDigest,
        stepId: answer.stepId,
        latencyMs: answer.invocation.latencyMs,
        costUsd: answer.invocation.costUsd,
      };
    } catch (error) {
      if (error instanceof DeniedError) {
        // A ceiling passed, a containment switch engaged, or an unreachable
        // record means the platform must stop. Scoring one of those as a
        // failing case would report a quality regression when what actually
        // happened is that an operator hit the stop button — so the denial is
        // re-raised and the whole evaluation ends.
        if (abortsEvaluation(error.reason)) throw error;

        // Every other refusal — a screen blocking crafted input, a model
        // declining the content — is a measurement rather than an action. The
        // harness is not performing the case's effect; it is observing what the
        // platform does when asked, and "it refused" is an outcome a curated
        // case can legitimately expect. Nothing proceeds on the strength of
        // this: the outcome is written down and the loop moves on.
        if (entry.expected.kind === "refusal") {
          const scored = scoreExpectation(entry.expected, `${error.reason} ${error.message}`);
          return {
            ...base,
            // Refused, but not on the ground the curator specified. Kept out of
            // the pass count: refusing for the wrong reason is not correctness.
            outcome: scored.outcome === "passed" ? "passed" : "refused",
            detail: scored.detail,
            denialReason: error.reason,
            latencyMs: 0,
            costUsd: 0,
          };
        }
        return {
          ...base,
          outcome: "failed",
          detail: `the platform refused this case: ${error.reason}`,
          denialReason: error.reason,
          latencyMs: 0,
          costUsd: 0,
        };
      }

      // Not a refusal: something broke. Recorded as `errored` and kept out of
      // the pass count, so a broken harness cannot look like a passing role.
      return {
        ...base,
        outcome: "errored",
        detail: error instanceof Error ? truncate(error.message) : String(error),
        latencyMs: 0,
        costUsd: 0,
      };
    }
  }
}

export interface ThresholdOptions {
  /** Overrides the golden set's own threshold. */
  readonly threshold?: number | undefined;
  /** A previous run to compare against, for regression detection. */
  readonly baseline?: EvaluationRun | null | undefined;
  /** How far below the baseline's accuracy the new run may sit. Default 0. */
  readonly tolerance?: number | undefined;
  /** Cases that must pass whatever the aggregate says. */
  readonly mustPassCaseIds?: readonly string[] | undefined;
}

export interface ThresholdReport {
  readonly passed: boolean;
  readonly accuracy: number;
  readonly threshold: number;
  readonly baselineAccuracy?: number | undefined;
  /** Cases that passed in the baseline and do not pass now. */
  readonly regressedCaseIds: readonly string[];
  /** Required cases that did not pass. */
  readonly failedRequiredCaseIds: readonly string[];
  /** Machine-readable failure reasons, empty when `passed`. */
  readonly failures: readonly string[];
  /** Printable lines for a CI log. */
  readonly lines: readonly string[];
}

/**
 * The check a continuous-integration job runs.
 *
 * Reports rather than throws, so a build can print the whole picture before it
 * fails. `assertMeetsThreshold` is the throwing form. Wiring either into the
 * pipeline is a separate job; what this module owes is the function.
 *
 * Three failures are distinguished, because they call for different responses:
 *
 *   below threshold      the role is not good enough yet
 *   below baseline       the role got worse, even if it is still above the bar
 *   a required case fell over    the aggregate looks fine and something that
 *                        must never break has broken
 *
 * The third is why per-case results are kept. An aggregate that stays at 94%
 * while the one case covering a statutory deadline flips from pass to fail is
 * the regression that matters most and the one an average hides.
 */
export function checkThreshold(
  run: EvaluationRun,
  options: ThresholdOptions = {},
): ThresholdReport {
  const threshold = options.threshold ?? run.threshold;
  const tolerance = options.tolerance ?? 0;
  const failures: string[] = [];
  const lines: string[] = [
    `role ${run.roleId} v${run.roleVersion} against ${run.goldenSetId} v${run.goldenSetVersion}`,
    `model ${run.modelId} (${run.modelVersion}), prompt ${run.promptTemplateId} v${run.promptTemplateVersion}`,
    `${run.passed}/${run.caseCount} passed, ${run.failed} failed, ${run.errored} errored`,
    `accuracy ${formatRate(run.accuracy)} against a threshold of ${formatRate(threshold)}`,
  ];

  if (run.accuracy < threshold) {
    failures.push(
      `accuracy ${formatRate(run.accuracy)} is below the threshold of ${formatRate(threshold)}`,
    );
  }
  if (run.errored > 0) {
    // An errored case measured nothing. Treating it as merely "not passed"
    // would let a harness that fell over halfway report a plausible number.
    failures.push(
      `${run.errored} case(s) errored, so the run did not measure what it claims to have measured`,
    );
  }

  const outcomes = new Map(run.results.map((result) => [result.caseId, result.outcome]));

  const regressedCaseIds: string[] = [];
  let baselineAccuracy: number | undefined;
  if (options.baseline) {
    baselineAccuracy = options.baseline.accuracy;
    lines.push(`baseline accuracy ${formatRate(baselineAccuracy)} (run ${options.baseline.id})`);
    if (run.accuracy < baselineAccuracy - tolerance) {
      failures.push(
        `accuracy fell from ${formatRate(baselineAccuracy)} to ${formatRate(run.accuracy)}, past the tolerance of ${formatRate(tolerance)}`,
      );
    }
    for (const previous of options.baseline.results) {
      if (previous.outcome !== "passed") continue;
      const now = outcomes.get(previous.caseId);
      // A case that has vanished counts as a regression: the baseline proved
      // something about it and this run proves nothing.
      if (now !== "passed") regressedCaseIds.push(previous.caseId);
    }
    if (regressedCaseIds.length > 0) {
      failures.push(
        `${regressedCaseIds.length} case(s) that passed in the baseline no longer pass: ${regressedCaseIds.sort().join(", ")}`,
      );
    }
  }

  const failedRequiredCaseIds: string[] = [];
  for (const caseId of options.mustPassCaseIds ?? []) {
    if (outcomes.get(caseId) !== "passed") failedRequiredCaseIds.push(caseId);
  }
  if (failedRequiredCaseIds.length > 0) {
    failures.push(
      `required case(s) did not pass: ${failedRequiredCaseIds.sort().join(", ")}`,
    );
  }

  return {
    passed: failures.length === 0,
    accuracy: run.accuracy,
    threshold,
    baselineAccuracy,
    regressedCaseIds: regressedCaseIds.sort(),
    failedRequiredCaseIds: failedRequiredCaseIds.sort(),
    failures,
    lines: [...lines, ...failures.map((failure) => `FAIL  ${failure}`)],
  };
}

/**
 * The throwing form, for callers that must stop.
 *
 * @throws {DeniedError} `improvement.evaluation_regression`
 */
export function assertMeetsThreshold(run: EvaluationRun, options: ThresholdOptions = {}): void {
  const report = checkThreshold(run, options);
  if (report.passed) return;
  throw new DeniedError(
    "improvement.evaluation_regression",
    `Evaluation run ${run.id} did not clear its bar: ${report.failures.join("; ")}.`,
    {
      evaluationRunId: run.id,
      accuracy: report.accuracy,
      threshold: report.threshold,
      regressions: report.regressedCaseIds.length,
    },
  );
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Five decimal places, matching the `numeric(6, 5)` column accuracy is stored in. */
function round(value: number): number {
  return Number(value.toFixed(5));
}
