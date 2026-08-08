import type { Id } from "../kernel/ids.js";
import type { Platform } from "../platform.js";
import { clusterObservations, comparableRunCounts } from "../improve/cluster.js";
import type { FailureCluster } from "../improve/types.js";

/**
 * The improvement clusters, as the console ranks them.
 *
 * A cluster is a recurring failure pattern — "this role misreads jurisdiction
 * in 12% of cases" — grouped and ranked from the corrections operators recorded
 * with "correct this". It is never stored: `clusterObservations` is a pure,
 * deterministic function over the observation rows, so a cluster the console
 * shows can always be reproduced from the evidence it cites, and it cannot
 * drift from that evidence the way a stored summary would the first time an
 * observation is purged for retention.
 *
 * **The denominator is read, not guessed.** The "% of cases" figure divides the
 * failures by the runs of the same role in the same period, counted from the
 * operating record. A role with no comparable run count gets a rate of zero and
 * is ranked on frequency and cost alone — a percentage computed against a
 * guessed denominator would read as a measurement and be an invention.
 *
 * **The cost shown is spend already made, not a projection.** `estimatedCostUsd`
 * carries the money the operating record shows was spent on the runs that hit
 * this failure. The operator-minutes the corrections cost are a real signal too,
 * but turning minutes into dollars needs a rate MVW sets and this deployment
 * does not know, so no placeholder dollar value is folded in here.
 */

export interface ImprovementClusterView {
  readonly clusterId: string;
  readonly summary: string;
  readonly roleId?: string | undefined;
  readonly occurrences: number;
  readonly ratePercent: number;
  readonly estimatedCostUsd: number;
  readonly exampleRunIds: readonly string[];
}

/** How many example run ids each cluster carries to the console. */
const MAX_EXAMPLE_RUNS = 5;

function clusterView(cluster: FailureCluster): ImprovementClusterView {
  const exampleRunIds = [...new Set(cluster.evidence.map((line) => line.runId))].slice(
    0,
    MAX_EXAMPLE_RUNS,
  );
  return {
    clusterId: cluster.key,
    summary: cluster.summary,
    roleId: cluster.roleId,
    occurrences: cluster.count,
    // Held as a percentage on the wire because the column reads "% of cases";
    // the browser formats, it does not decide the number.
    ratePercent: Number((cluster.rate * 100).toFixed(1)),
    // Real recorded spend on the affected runs, not a projection.
    estimatedCostUsd: cluster.costUsd,
    exampleRunIds,
  };
}

/**
 * Rank the recorded failures and return one page of clusters.
 *
 * The clustering is over the whole observation set — a ranking cannot be
 * computed from a page of itself — and the page is sliced after the ranking, so
 * `total` is the true number of distinct failure patterns rather than the size
 * of a window.
 */
export async function improvementClustersPage(
  platform: Platform,
  limit: number,
  offset: number,
): Promise<{
  readonly items: readonly ImprovementClusterView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}> {
  const observations = await platform.observationStore.listObservations();

  // The denominator behind every rate: how many runs each affected role
  // performed, counted from the operating record so the percentage is one an
  // operator could count themselves.
  const roleIds = [
    ...new Set(
      observations
        .map((observation) => observation.roleId)
        .filter((roleId): roleId is Id<"role"> => roleId !== undefined),
    ),
  ];
  const comparableRuns = await comparableRunCounts(platform.runs, roleIds);

  const clusters = clusterObservations(observations, { comparableRuns });
  const window = clusters.slice(offset, offset + limit);

  return {
    items: window.map(clusterView),
    total: clusters.length,
    limit,
    offset,
  };
}
