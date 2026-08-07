import { useState } from "react";
import { useClient } from "../api/ClientProvider";
import type { ImprovementClusterView, ImprovementProposalView } from "../api/contract";
import { useResource } from "../api/useResource";
import { formatCount, formatDateTime, formatPercentagePoints, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import {
  Badge,
  Callout,
  EmptyState,
  IconAlert,
  Panel,
  Table,
  type TableColumn,
  type TableSort,
} from "../ui";

/**
 * The improvement queue.
 *
 * Two lists, in the order the work actually flows. Clusters first: repeated
 * observations of the same thing going wrong, ranked by how often and how
 * expensively. Then proposals: the changes somebody has drafted in response,
 * each waiting for a human decision.
 *
 * Clusters carry their evidence — the runs the cluster was computed from — as
 * links rather than as a count. A cluster that says "412 occurrences" and gives
 * you nothing to open is an assertion; one you can click into is a finding.
 *
 * The inertness statement is on the page, not in a tooltip. There is no
 * auto-apply anywhere in this platform, and the reason that is worth anything
 * to a risk committee is that it is enforced in code and stated where the
 * people who might assume otherwise will read it (ADR 0011).
 *
 * Both tables bring controls of their own — a sort control per column and a
 * column chooser. They reorder and rearrange what this reader is looking at;
 * neither reaches the platform, so the "no control applies anything" claim
 * above survives them intact.
 */

/**
 * Order the rows a table has been told it is showing.
 *
 * A table sorts for itself only while it owns the sort state, and it starts
 * that state at "unsorted" — which would rank these lists in whatever order the
 * server returned while `aria-sort` said nothing was sorted. Holding the state
 * here is what lets each list open on its ranking *and* announce it. The
 * comparison matches the table's own: numbers numerically, everything else with
 * a numeric case-insensitive collation, ties broken by original position so the
 * order is stable.
 */
function orderBy<T>(
  rows: readonly T[],
  columns: readonly TableColumn<T>[],
  sort: TableSort | null,
): readonly T[] {
  const sortValue =
    sort === null ? undefined : columns.find((column) => column.key === sort.columnKey)?.sortValue;
  if (sort === null || sortValue === undefined) return rows;

  const direction = sort.direction === "ascending" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const a = sortValue(left.row);
      const b = sortValue(right.row);
      const result =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
      return result !== 0 ? result * direction : left.index - right.index;
    })
    .map((entry) => entry.row);
}

/** Most frequent first, and widest reach first. Both lists exist to be ranked. */
const CLUSTER_SORT: TableSort = { columnKey: "occurrences", direction: "descending" };
const PROPOSAL_SORT: TableSort = { columnKey: "blastRadius", direction: "descending" };

export interface ImprovementQueueProps {
  readonly clusters: readonly ImprovementClusterView[];
  readonly proposals: readonly ImprovementProposalView[];
}

export function ImprovementQueue({ clusters, proposals }: ImprovementQueueProps) {
  const totalCost = clusters.reduce((sum, cluster) => sum + cluster.estimatedCostUsd, 0);
  const totalOccurrences = clusters.reduce((sum, cluster) => sum + cluster.occurrences, 0);

  const [clusterSort, setClusterSort] = useState<TableSort | null>(CLUSTER_SORT);
  const [proposalSort, setProposalSort] = useState<TableSort | null>(PROPOSAL_SORT);

  const clusterColumns: readonly TableColumn<ImprovementClusterView>[] = [
    {
      key: "summary",
      header: "What keeps happening",
      rowHeader: true,
      alwaysVisible: true,
      width: 360,
      sortValue: (cluster) => cluster.summary,
      cell: (cluster) => (
        <span className="pv-stack-tight">
          <span>{cluster.summary}</span>
          <span className="pv-meta pv-mono">{cluster.clusterId}</span>
        </span>
      ),
    },
    {
      key: "occurrences",
      header: "Times seen",
      numeric: true,
      width: 130,
      sortValue: (cluster) => cluster.occurrences,
      cell: (cluster) => <span>{formatCount(cluster.occurrences)}</span>,
    },
    {
      key: "ratePercent",
      header: "Share of that role's runs",
      numeric: true,
      width: 200,
      sortValue: (cluster) => cluster.ratePercent,
      cell: (cluster) => <span>{cluster.ratePercent.toFixed(1)}%</span>,
    },
    {
      key: "estimatedCostUsd",
      header: "Estimated cost",
      numeric: true,
      width: 160,
      sortValue: (cluster) => cluster.estimatedCostUsd,
      cell: (cluster) => <span>{formatUsd(cluster.estimatedCostUsd)}</span>,
    },
    {
      key: "roleId",
      header: "Role",
      width: 240,
      sortValue: (cluster) => cluster.roleId ?? "",
      cell: (cluster) =>
        cluster.roleId === undefined ? (
          <span className="pv-meta">Not attributed to one role</span>
        ) : (
          <Link to={`/roles/${cluster.roleId}`}>
            <span className="pv-mono">{cluster.roleId}</span>
          </Link>
        ),
    },
    {
      key: "evidence",
      header: "Evidence",
      width: 260,
      cell: (cluster) =>
        cluster.exampleRunIds.length === 0 ? (
          <span className="pv-meta">No example runs recorded</span>
        ) : (
          <ul className="pv-token-list">
            {cluster.exampleRunIds.map((runId) => (
              <li className="pv-token" key={runId}>
                <Link to={`/runs/${runId}`}>
                  <span className="pv-mono">{runId}</span>
                </Link>
              </li>
            ))}
          </ul>
        ),
    },
  ];

  const proposalColumns: readonly TableColumn<ImprovementProposalView>[] = [
    {
      key: "title",
      header: "Proposed change",
      rowHeader: true,
      alwaysVisible: true,
      width: 360,
      sortValue: (proposal) => proposal.title,
      cell: (proposal) => (
        <span className="pv-stack-tight">
          <Link to={`/improvements/${proposal.proposalId}`}>{proposal.title}</Link>
          <span className="pv-meta pv-mono">
            {proposal.artifactKind} · {proposal.artifactRef}
          </span>
        </span>
      ),
    },
    {
      key: "evaluationDelta",
      header: "Measured change",
      numeric: true,
      width: 200,
      sortValue: (proposal) => proposal.evaluationDelta ?? Number.NEGATIVE_INFINITY,
      cell: (proposal) => {
        if (proposal.evaluationDelta === undefined) {
          return <span className="pv-meta">Not evaluated yet</span>;
        }
        const improved = proposal.evaluationDelta > 0;
        return (
          // The danger tone's own mark is a cross, which reads "this failed".
          // A regression is a measurement, and the thing to do with it is read
          // it carefully — which is the shape this vocabulary has always used.
          <Badge tone={improved ? "success" : "danger"} icon={improved ? undefined : <IconAlert size="sm" />}>
            {formatPercentagePoints(proposal.evaluationDelta)}
          </Badge>
        );
      },
    },
    {
      key: "blastRadius",
      header: "Runs it would have touched",
      numeric: true,
      width: 200,
      sortValue: (proposal) => proposal.blastRadius.runsInLastThirtyDays,
      cell: (proposal) => <span>{formatCount(proposal.blastRadius.runsInLastThirtyDays)}</span>,
    },
    {
      key: "observationCount",
      header: "Observations behind it",
      numeric: true,
      width: 190,
      sortValue: (proposal) => proposal.observationCount,
      cell: (proposal) => <span>{formatCount(proposal.observationCount)}</span>,
    },
    {
      key: "status",
      header: "State",
      width: 180,
      sortValue: (proposal) => proposal.status,
      cell: (proposal) => <Badge tone="neutral">{proposal.status.replace(/_/g, " ")}</Badge>,
    },
    {
      key: "createdAt",
      header: "Raised",
      width: 200,
      sortValue: (proposal) => proposal.createdAt,
      cell: (proposal) => (
        <time dateTime={proposal.createdAt}>{formatDateTime(proposal.createdAt)}</time>
      ),
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>Improvements</h1>
        <p className="pv-page-lede">
          What the platform has noticed going wrong repeatedly, ranked by how often it happens and
          what it costs, and the changes somebody has drafted in response.
        </p>
      </div>

      <Callout tone="info" title="Nothing here changes anything until a person approves it">
        <p>
          A proposal is inert. It is a description of a change, not the change. The platform cannot
          apply one on its own authority: there is no auto-apply, no threshold above which a
          proposal applies itself, and no configuration that turns the human decision off.
        </p>
        <p className="pv-meta">
          Applying a change requires a granted approval that binds to the proposal as it stands.
          Alter the proposal after approval and it stops matching, and the change is refused rather
          than applied.
        </p>
      </Callout>

      <Panel title="What keeps happening">
        <p role="status" className="pv-meta">
          {pluralise(clusters.length, "cluster", "clusters")} covering{" "}
          {formatCount(totalOccurrences)} observations, {formatUsd(totalCost)} of estimated cost.
        </p>

        {clusters.length === 0 ? (
          <EmptyState
            title="Nothing has repeated often enough to cluster"
            body="Observations are grouped when the same thing happens more than once. An empty list means the platform has not seen a pattern, not that it has not been watching."
          />
        ) : (
          <Table
            caption={`Observation clusters, ${pluralise(clusters.length, "cluster", "clusters")}, ranked by how often each occurs.`}
            tableId="improvement-clusters"
            columns={clusterColumns}
            rows={orderBy(clusters, clusterColumns, clusterSort)}
            rowKey={(cluster) => cluster.clusterId}
            rowNoun="clusters"
            sort={clusterSort}
            onSortChange={setClusterSort}
            // Nothing on this screen acts on a set of rows, so there is no set
            // to build. Read-only also drops `X` from the row cursor.
            readOnly
          />
        )}
      </Panel>

      <Panel title="Proposals waiting for a decision">
        {proposals.length === 0 ? (
          <EmptyState
            title="No proposal is waiting"
            body="Nobody has drafted a change in response to the clusters above. A cluster with no proposal is not an oversight; it may simply not be worth changing anything for."
          />
        ) : (
          <Table
            caption={`Improvement proposals, ${pluralise(proposals.length, "proposal", "proposals")}.`}
            tableId="improvement-proposals"
            columns={proposalColumns}
            rows={orderBy(proposals, proposalColumns, proposalSort)}
            rowKey={(proposal) => proposal.proposalId}
            rowNoun="proposals"
            sort={proposalSort}
            onSortChange={setProposalSort}
            readOnly
          />
        )}
      </Panel>
    </div>
  );
}

/**
 * Route-level container.
 *
 * Two resources rather than one composite endpoint: clusters and proposals are
 * produced by different parts of the loop and one being refused or unavailable
 * should not blank the other.
 */
export function ImprovementQueueRoute() {
  const client = useClient();
  const clusters = useResource((signal) => client.improvementClusters({}, { signal }), [client]);
  const proposals = useResource((signal) => client.improvementProposals({}, { signal }), [client]);

  return (
    <ResourceView resource={clusters} attempted="the improvement queue">
      {(clusterPage) => (
        <ResourceView resource={proposals} attempted="the improvement proposals">
          {(proposalPage) => (
            <ImprovementQueue clusters={clusterPage.items} proposals={proposalPage.items} />
          )}
        </ResourceView>
      )}
    </ResourceView>
  );
}
