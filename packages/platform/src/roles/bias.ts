import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { CaseOutcome, CaseResult, EvaluationRun } from "./types.js";

/**
 * Bias and fairness testing, on synthetic fixtures only.
 *
 * Where a role's output affects a consumer, "it scores 94%" is not a complete
 * answer. It matters whether the 6% falls evenly. This module takes an
 * evaluation run whose cases carry protected-class attributes and computes
 * outcome-rate disparities between groups, flagging the ones that pass a
 * threshold.
 *
 * Four statements about what this is and is not. They are here rather than in
 * a document because whoever reads this code next needs them, and because they
 * are also emitted as `caveats` on every report so they travel with the
 * numbers into any console that renders them.
 *
 * **This runs on synthetic fixtures.** The golden sets it reads are curated
 * test data with invented attributes. `analyseFairness` refuses a run that was
 * not marked synthetic, and `assertGoldenSet` refuses protected-class
 * attributes on a set that is not. This platform does not hold protected-class
 * attributes about real people, and a fairness harness that quietly started to
 * would be a larger problem than any disparity it found.
 *
 * **Synthetic fixtures cannot establish real-world fairness.** They can show
 * that a role behaves differently when an attribute changes and nothing else
 * does, which is a useful and cheap signal, and they can catch the crude
 * failure before it ships. They cannot tell you how the system behaves on
 * MVW's actual population, because they are not it. Real fairness testing —
 * on what population, against which measure, at what threshold, with what
 * remediation, and under which of ECOA, the FHA, state UDAP statutes, and
 * MVW's own policy — requires MVW compliance engagement, in writing, **before
 * any consumer-affecting workflow goes live**. Nothing in this file is a
 * substitute for that and nothing in this file should be quoted as if it were.
 *
 * **Where an outcome could be adverse to a consumer, the human is the
 * decision-maker and the system is the evidence-gatherer.** That is the
 * platform's position and it is enforced structurally: any such action is
 * classified `high_consequence` in the action catalogue, so it parks for a
 * person before it lands. This module measures; it does not decide, and it
 * does not gate. A flagged disparity is a finding for a person to act on.
 *
 * **The shipped measure is a proxy.** What is computed is the rate at which
 * each group receives a *favourable case outcome*, which by default means "the
 * role produced the curated expected answer". A disparity there means the role
 * is more often wrong for one group, which is worth knowing. It is not the
 * same as a disparity in the *decision* — approval rates, adverse-action rates
 * — which is what a regulator asks about. Measuring that requires the role's
 * produced decision to be extracted and labelled per case, and the mapping
 * from output to decision has to be defined per workflow with MVW compliance.
 * The `favourableOutcomes` option is the seam for it once that mapping exists.
 */

/** The four-fifths rule: a selection rate below 80% of the highest is the flag. */
const DEFAULT_IMPACT_RATIO_THRESHOLD = 0.8;
/** Absolute gap in percentage points that is worth flagging on its own. */
const DEFAULT_RATE_DIFFERENCE_THRESHOLD = 0.1;
/**
 * Below this, a rate is noise.
 *
 * Three cases in a group produce rates of 0%, 33%, 67%, or 100% and nothing in
 * between, so a "disparity" between two tiny groups is arithmetic rather than
 * evidence. Groups under the floor are reported as `insufficientData` rather
 * than dropped, because "we did not test this group enough to say" is itself a
 * finding about the fixture set.
 */
const DEFAULT_MINIMUM_GROUP_SIZE = 20;

export interface FairnessOptions {
  /** Outcomes counted as favourable. Default: the role produced the expected answer. */
  readonly favourableOutcomes?: readonly CaseOutcome[] | undefined;
  /** Attributes to analyse. Default: every attribute present on the cases. */
  readonly attributes?: readonly string[] | undefined;
  readonly minimumGroupSize?: number | undefined;
  readonly impactRatioThreshold?: number | undefined;
  readonly rateDifferenceThreshold?: number | undefined;
  /** Only consider cases carrying this tag, e.g. one jurisdiction. */
  readonly tag?: string | undefined;
}

export interface GroupOutcome {
  readonly attribute: string;
  readonly group: string;
  readonly size: number;
  readonly favourable: number;
  readonly favourableRate: number;
  /** This group's rate over the highest group's rate. 1 means parity. */
  readonly impactRatio: number;
  /** Highest group's rate minus this group's, in [0, 1]. */
  readonly rateDifference: number;
  readonly flagged: boolean;
  readonly insufficientData: boolean;
  /** Which threshold fired, when one did. */
  readonly flaggedBecause?: string | undefined;
}

export interface AttributeDisparity {
  readonly attribute: string;
  /** The group with the highest favourable rate; everything is compared to it. */
  readonly referenceGroup: string;
  readonly referenceRate: number;
  readonly groups: readonly GroupOutcome[];
  readonly flagged: boolean;
  /** True when no group met the minimum size, so nothing was established. */
  readonly underpowered: boolean;
}

export interface FairnessReport {
  readonly evaluationRunId: Id<"evaluation">;
  readonly roleId: Id<"role">;
  readonly roleVersion: number;
  readonly goldenSetId: string;
  readonly goldenSetVersion: number;
  /** Always true. The analysis refuses to run on anything else. */
  readonly syntheticFixtures: true;
  readonly casesAnalysed: number;
  readonly favourableOutcomes: readonly CaseOutcome[];
  readonly minimumGroupSize: number;
  readonly impactRatioThreshold: number;
  readonly rateDifferenceThreshold: number;
  readonly attributes: readonly AttributeDisparity[];
  /** Every flagged group across every attribute, worst first. */
  readonly flagged: readonly GroupOutcome[];
  /** Travels with the numbers. See the module comment. */
  readonly caveats: readonly string[];
}

export const FAIRNESS_CAVEATS: readonly string[] = [
  "Computed on synthetic test fixtures. These are invented cases with invented attributes; they are not MVW's population and cannot establish real-world fairness.",
  "Real fairness testing requires MVW compliance engagement, in writing, before any consumer-affecting workflow goes live: which population, which measure, which threshold, which remediation, and under which regulations.",
  "Where an outcome could be adverse to a consumer, the human is the decision-maker and this platform is the evidence-gatherer. A flagged disparity is a finding for a person, not a gate the system applies.",
  "The measure here is the rate at which each group receives the curated expected outcome. That is a proxy for, and not the same as, a disparity in the decision itself; mapping a role's output to a decision label must be defined per workflow with MVW compliance.",
];

/**
 * Compute outcome-rate disparities across protected groups.
 *
 * @throws {DeniedError} `authorization.data_scope_violation` when the run was
 *   not measured on synthetic fixtures. Pointing this at real material would
 *   mean the platform holding protected-class attributes about real people,
 *   which it does not do.
 */
export function analyseFairness(
  run: EvaluationRun,
  options: FairnessOptions = {},
): FairnessReport {
  if (!run.syntheticFixtures) {
    throw new DeniedError(
      "authorization.data_scope_violation",
      `Evaluation run ${run.id} was not measured on synthetic fixtures, so fairness analysis was refused. Protected-class attributes are held here only as invented test data; this platform does not hold them about real people.`,
      { evaluationRunId: run.id, roleId: run.roleId },
    );
  }

  const favourableOutcomes = options.favourableOutcomes ?? (["passed"] as const);
  if (favourableOutcomes.length === 0) {
    throw new InvalidInputError(
      "At least one outcome has to count as favourable, or every rate is zero and every group looks identical.",
      "favourableOutcomes",
    );
  }
  const minimumGroupSize = options.minimumGroupSize ?? DEFAULT_MINIMUM_GROUP_SIZE;
  const impactRatioThreshold = options.impactRatioThreshold ?? DEFAULT_IMPACT_RATIO_THRESHOLD;
  const rateDifferenceThreshold =
    options.rateDifferenceThreshold ?? DEFAULT_RATE_DIFFERENCE_THRESHOLD;

  const considered = run.results.filter(
    (result) =>
      hasAttributes(result) && (options.tag === undefined || result.tags.includes(options.tag)),
  );

  const attributeNames = new Set<string>(options.attributes ?? []);
  if (attributeNames.size === 0) {
    for (const result of considered) {
      for (const name of Object.keys(result.protectedAttributes ?? {})) attributeNames.add(name);
    }
  }

  const attributes: AttributeDisparity[] = [];
  const flagged: GroupOutcome[] = [];

  for (const attribute of [...attributeNames].sort()) {
    const byGroup = new Map<string, { size: number; favourable: number }>();
    for (const result of considered) {
      const group = result.protectedAttributes?.[attribute];
      if (group === undefined) continue;
      const bucket = byGroup.get(group) ?? { size: 0, favourable: 0 };
      bucket.size += 1;
      if (favourableOutcomes.includes(result.outcome)) bucket.favourable += 1;
      byGroup.set(group, bucket);
    }
    if (byGroup.size === 0) continue;

    // The reference is the best-performing group of adequate size. Comparing
    // against the overall mean would let one very large, very poorly served
    // group drag the mean down until its own disparity disappeared.
    const eligible = [...byGroup.entries()].filter(([, bucket]) => bucket.size >= minimumGroupSize);
    const underpowered = eligible.length < 2;
    const pool = eligible.length > 0 ? eligible : [...byGroup.entries()];

    let referenceGroup = "";
    let referenceRate = 0;
    for (const [group, bucket] of pool) {
      const rate = bucket.favourable / bucket.size;
      // Ties broken by name so the report is stable across runs.
      if (rate > referenceRate || (rate === referenceRate && referenceGroup === "")) {
        referenceGroup = group;
        referenceRate = rate;
      }
    }

    const groups: GroupOutcome[] = [];
    for (const [group, bucket] of [...byGroup.entries()].sort((left, right) =>
      left[0] < right[0] ? -1 : 1,
    )) {
      const favourableRate = bucket.favourable / bucket.size;
      const impactRatio = referenceRate === 0 ? 1 : favourableRate / referenceRate;
      const rateDifference = Math.max(0, referenceRate - favourableRate);
      const insufficientData = bucket.size < minimumGroupSize;

      let flaggedBecause: string | undefined;
      if (!insufficientData && !underpowered) {
        if (impactRatio < impactRatioThreshold) {
          flaggedBecause = `impact ratio ${round(impactRatio)} against "${referenceGroup}" is below ${impactRatioThreshold}`;
        } else if (rateDifference > rateDifferenceThreshold) {
          flaggedBecause = `outcome rate is ${formatRate(rateDifference)} below "${referenceGroup}", past the ${formatRate(rateDifferenceThreshold)} threshold`;
        }
      }

      const outcome: GroupOutcome = {
        attribute,
        group,
        size: bucket.size,
        favourable: bucket.favourable,
        favourableRate: round(favourableRate),
        impactRatio: round(impactRatio),
        rateDifference: round(rateDifference),
        flagged: flaggedBecause !== undefined,
        insufficientData,
        flaggedBecause,
      };
      groups.push(outcome);
      if (outcome.flagged) flagged.push(outcome);
    }

    attributes.push({
      attribute,
      referenceGroup,
      referenceRate: round(referenceRate),
      groups,
      flagged: groups.some((group) => group.flagged),
      underpowered,
    });
  }

  return {
    evaluationRunId: run.id,
    roleId: run.roleId,
    roleVersion: run.roleVersion,
    goldenSetId: run.goldenSetId,
    goldenSetVersion: run.goldenSetVersion,
    syntheticFixtures: true,
    casesAnalysed: considered.length,
    favourableOutcomes: [...favourableOutcomes],
    minimumGroupSize,
    impactRatioThreshold,
    rateDifferenceThreshold,
    attributes,
    // Worst disparity first: this is what a reviewer reads.
    flagged: flagged.sort((left, right) => left.impactRatio - right.impactRatio),
    caveats: FAIRNESS_CAVEATS,
  };
}

/**
 * Render a report as lines for a console or a CI log.
 *
 * The caveats are printed with the numbers rather than beside them, because a
 * disparity figure quoted without them is a disparity figure that will be
 * quoted without them again.
 */
export function describeFairness(report: FairnessReport): readonly string[] {
  const lines: string[] = [
    `fairness on synthetic fixtures — role ${report.roleId} v${report.roleVersion}, run ${report.evaluationRunId}`,
    `${report.casesAnalysed} case(s) carried protected-class attributes; favourable = ${report.favourableOutcomes.join(", ")}`,
  ];

  if (report.attributes.length === 0) {
    lines.push("no protected-class attributes present, so no disparity was computed");
  }

  for (const attribute of report.attributes) {
    lines.push(
      `${attribute.attribute}: reference "${attribute.referenceGroup}" at ${formatRate(attribute.referenceRate)}${attribute.underpowered ? " (underpowered: fewer than two groups met the minimum size)" : ""}`,
    );
    for (const group of attribute.groups) {
      const marks = [
        group.insufficientData ? "insufficient data" : "",
        group.flaggedBecause ?? "",
      ].filter((mark) => mark !== "");
      lines.push(
        `  ${group.group}: ${group.favourable}/${group.size} = ${formatRate(group.favourableRate)}, impact ratio ${group.impactRatio}${marks.length > 0 ? ` — ${marks.join("; ")}` : ""}`,
      );
    }
  }

  if (report.flagged.length > 0) {
    lines.push(`FLAGGED  ${report.flagged.length} group(s) past a threshold`);
  }
  for (const caveat of report.caveats) lines.push(`NOTE  ${caveat}`);
  return lines;
}

function hasAttributes(result: CaseResult): boolean {
  return (
    result.protectedAttributes !== undefined &&
    Object.keys(result.protectedAttributes).length > 0
  );
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
