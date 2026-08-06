import type { Id } from "../kernel/ids.js";
import type { RunStore } from "../record/port.js";
import type { IsoTimestamp } from "../record/types.js";
import type { ClusterEvidence, FailureCluster, Observation } from "./types.js";

/**
 * Stage two: cluster.
 *
 * Recurring failure patterns, grouped and ranked, with the evidence attached,
 * so an operator sees "this role misreads jurisdiction in 12% of cases" rather
 * than a list of four hundred corrections.
 *
 * Everything in here is a pure function of the observations it is given.
 * Two properties follow, and both are tested:
 *
 *   *Deterministic.* The same observations produce the same clusters, in the
 *   same order, with the same keys — whatever order they arrive in. An
 *   operator's link to a cluster still resolves tomorrow, and the seeded demo
 *   reproduces byte for byte.
 *
 *   *Never stored.* A cluster is a view over observations, recomputed on
 *   demand. A stored cluster drifts from its evidence the first time an
 *   observation is purged for a retention reason, and then the summary an
 *   operator reads cites a count nobody can reproduce.
 *
 * The ranking mixes two things that are not the same unit — how often a failure
 * happens and what it costs — so the exchange rate between them is a **declared
 * input with a placeholder default**, not a fact this module knows.
 * `humanMinuteUsd` is what MVW says an operator minute is worth; the default of
 * one dollar is a placeholder that makes the arithmetic run, and it is stated
 * here rather than buried so that nobody mistakes it for a finding. The two
 * costs are also reported separately on every cluster, so a reviewer can apply
 * their own judgement to the ranking they are shown.
 */

export interface ClusterWeights {
  /** Weight on raw frequency: how many times this happened. */
  readonly frequency: number;
  /** Weight on the share of comparable runs affected, in percentage points. */
  readonly rate: number;
  /** Weight on money: model spend plus operator time at `humanMinuteUsd`. */
  readonly cost: number;
  /**
   * What one operator minute is worth, in USD.
   *
   * A placeholder. MVW sets this; the default exists so the ranking runs, not
   * because this module knows the answer.
   */
  readonly humanMinuteUsd: number;
}

export const DEFAULT_CLUSTER_WEIGHTS: ClusterWeights = {
  frequency: 1,
  rate: 0.5,
  cost: 1,
  humanMinuteUsd: 1,
};

export interface ClusterOptions {
  /**
   * Runs of each role in the same window: the denominator behind the rate.
   *
   * Keyed by role id. A role absent from this map gets a rate of 0 and is
   * ranked on frequency and cost alone — a rate computed against a guessed
   * denominator would read as a measurement and be an invention.
   */
  readonly comparableRuns?: Readonly<Record<string, number>> | undefined;
  /** Evidence lines carried on each cluster. Default 5. */
  readonly maxEvidence?: number | undefined;
  /** Clusters below this many observations are dropped. Default 1. */
  readonly minimumCount?: number | undefined;
  readonly weights?: Partial<ClusterWeights> | undefined;
}

/** Where a cluster with no attributable role is filed. */
const UNATTRIBUTED = "unattributed";

/** Group observations into ranked failure patterns. */
export function clusterObservations(
  observations: readonly Observation[],
  options: ClusterOptions = {},
): readonly FailureCluster[] {
  const weights = { ...DEFAULT_CLUSTER_WEIGHTS, ...(options.weights ?? {}) };
  const maxEvidence = options.maxEvidence ?? 5;
  const minimumCount = options.minimumCount ?? 1;
  const denominators = options.comparableRuns ?? {};

  // Sorted before grouping, so the evidence order and the "first seen" figure
  // do not depend on the order the caller happened to read rows in.
  const ordered = [...observations].sort(compareObservations);

  const groups = new Map<string, Observation[]>();
  for (const observation of ordered) {
    const key = clusterKey(observation.roleId, observation.signature);
    const bucket = groups.get(key);
    if (bucket) bucket.push(observation);
    else groups.set(key, [observation]);
  }

  const clusters: FailureCluster[] = [];
  for (const [key, members] of groups) {
    if (members.length < minimumCount) continue;

    const first = members[0];
    const last = members[members.length - 1];
    // Non-null by construction: a group only exists because something was put
    // in it, and empty groups are impossible above.
    if (!first || !last) continue;

    const roleId = first.roleId;
    const comparableRuns = roleId === undefined ? 0 : Math.max(0, denominators[roleId] ?? 0);
    const humanMinutes = round5(
      members.reduce((total, entry) => total + entry.correctionMinutes, 0),
    );
    const costUsd = round5(members.reduce((total, entry) => total + entry.costUsd, 0));
    // Capped at 1: more corrections than runs means the same run was corrected
    // more than once, and a rate above 100% of cases is not a sentence anyone
    // can act on.
    const rate = comparableRuns === 0 ? 0 : round5(Math.min(1, members.length / comparableRuns));

    const score = round5(
      weights.frequency * members.length +
        weights.rate * rate * 100 +
        weights.cost * (costUsd + humanMinutes * weights.humanMinuteUsd),
    );

    clusters.push({
      key,
      signature: first.signature,
      roleId,
      kinds: distinct(members.map((entry) => entry.kind)),
      workflowKinds: distinct(
        members.map((entry) => entry.workflowKind).filter((kind): kind is string => !!kind),
      ),
      count: members.length,
      comparableRuns,
      rate,
      humanMinutes,
      costUsd,
      firstSeenAt: first.recordedAt,
      lastSeenAt: last.recordedAt,
      score,
      // Replaced below, once the whole list is ordered.
      rank: 0,
      evidence: members.slice(0, maxEvidence).map(toEvidence),
      summary: summarise({
        signature: first.signature,
        roleId,
        count: members.length,
        comparableRuns,
        rate,
        humanMinutes,
        costUsd,
      }),
    });
  }

  // Score first, then frequency, then the key — so two clusters that genuinely
  // tie still come out in the same order on every run and in both adapters.
  clusters.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.count !== right.count) return right.count - left.count;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });

  return clusters.map((cluster, index) => ({ ...cluster, rank: index + 1 }));
}

/** The stable identity of a cluster: which role, and which failure. */
export function clusterKey(roleId: string | undefined, signature: string): string {
  return `${roleId ?? UNATTRIBUTED}::${signature}`;
}

/**
 * Total ordering over observations.
 *
 * Time first, then id. Under a fixed clock — the test suite, the seeded demo —
 * every observation shares a timestamp, so without the id tiebreak the output
 * order would depend on sort stability rather than on anything real.
 */
export function compareObservations(left: Observation, right: Observation): number {
  if (left.recordedAt !== right.recordedAt) return left.recordedAt < right.recordedAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Count the runs each role performed in a window.
 *
 * The denominator behind "12% of cases". Read from the operating record, so the
 * percentage an operator is shown is one they could count themselves.
 */
export async function comparableRunCounts(
  runs: RunStore,
  roleIds: readonly Id<"role">[],
  window: { readonly after?: IsoTimestamp; readonly before?: IsoTimestamp } = {},
): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const roleId of distinct(roleIds)) {
    counts[roleId] = await runs.countRuns({
      roleId,
      createdAfter: window.after,
      createdBefore: window.before,
    });
  }
  return counts;
}

function toEvidence(observation: Observation): ClusterEvidence {
  return {
    observationId: observation.id,
    runId: observation.runId,
    kind: observation.kind,
    recordedAt: observation.recordedAt,
    note: observation.note,
    beforeDigest: observation.beforeDigest,
    afterDigest: observation.afterDigest,
  };
}

function summarise(input: {
  readonly signature: string;
  readonly roleId: string | undefined;
  readonly count: number;
  readonly comparableRuns: number;
  readonly rate: number;
  readonly humanMinutes: number;
  readonly costUsd: number;
}): string {
  const who = input.roleId ? `Role ${input.roleId}` : "Work with no role attributed";
  const howOften =
    input.comparableRuns > 0
      ? `${(input.rate * 100).toFixed(1)}% of cases (${input.count} of ${input.comparableRuns} runs)`
      : `${input.count} time${input.count === 1 ? "" : "s"} (no comparable run count available)`;
  return (
    `${who} hit "${input.signature}" in ${howOften}, ` +
    `costing ${input.humanMinutes} operator minute${input.humanMinutes === 1 ? "" : "s"} ` +
    `and $${input.costUsd.toFixed(4)} of spend already made.`
  );
}

function distinct<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort();
}

/** Five decimal places, so the same inputs produce the same displayed number. */
function round5(value: number): number {
  return Number(value.toFixed(5));
}
