import { useClient } from "../api/ClientProvider";
import type { ImprovementClusterView, ImprovementProposalView } from "../api/contract";
import { useResource } from "../api/useResource";
import { Badge, Callout, DataTable, EmptyState, type Column } from "../components";
import { formatCount, formatDateTime, formatPercentagePoints, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";

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
 */

export interface ImprovementQueueProps {
  readonly clusters: readonly ImprovementClusterView[];
  readonly proposals: readonly ImprovementProposalView[];
}

export function ImprovementQueue({ clusters, proposals }: ImprovementQueueProps) {
  const totalCost = clusters.reduce((sum, cluster) => sum + cluster.estimatedCostUsd, 0);
  const totalOccurrences = clusters.reduce((sum, cluster) => sum + cluster.occurrences, 0);

  const clusterColumns: readonly Column<ImprovementClusterView>[] = [
    {
      key: "summary",
      header: "What keeps happening",
      rowHeader: true,
      sortValue: (cluster) => cluster.summary,
      render: (cluster) => (
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
      sortValue: (cluster) => cluster.occurrences,
      render: (cluster) => <span>{formatCount(cluster.occurrences)}</span>,
    },
    {
      key: "ratePercent",
      header: "Share of that role's runs",
      numeric: true,
      sortValue: (cluster) => cluster.ratePercent,
      render: (cluster) => <span>{cluster.ratePercent.toFixed(1)}%</span>,
    },
    {
      key: "estimatedCostUsd",
      header: "Estimated cost",
      numeric: true,
      sortValue: (cluster) => cluster.estimatedCostUsd,
      render: (cluster) => <span>{formatUsd(cluster.estimatedCostUsd)}</span>,
    },
    {
      key: "roleId",
      header: "Role",
      sortValue: (cluster) => cluster.roleId ?? "",
      render: (cluster) =>
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
      render: (cluster) =>
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

  const proposalColumns: readonly Column<ImprovementProposalView>[] = [
    {
      key: "title",
      header: "Proposed change",
      rowHeader: true,
      sortValue: (proposal) => proposal.title,
      render: (proposal) => (
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
      sortValue: (proposal) => proposal.evaluationDelta ?? Number.NEGATIVE_INFINITY,
      render: (proposal) => {
        if (proposal.evaluationDelta === undefined) {
          return <span className="pv-meta">Not evaluated yet</span>;
        }
        const improved = proposal.evaluationDelta > 0;
        return (
          <Badge tone={improved ? "success" : "danger"} glyph={improved ? "✓" : "▲"}>
            {formatPercentagePoints(proposal.evaluationDelta)}
          </Badge>
        );
      },
    },
    {
      key: "blastRadius",
      header: "Runs it would have touched",
      numeric: true,
      sortValue: (proposal) => proposal.blastRadius.runsInLastThirtyDays,
      render: (proposal) => <span>{formatCount(proposal.blastRadius.runsInLastThirtyDays)}</span>,
    },
    {
      key: "observationCount",
      header: "Observations behind it",
      numeric: true,
      sortValue: (proposal) => proposal.observationCount,
      render: (proposal) => <span>{formatCount(proposal.observationCount)}</span>,
    },
    {
      key: "status",
      header: "State",
      sortValue: (proposal) => proposal.status,
      render: (proposal) => <Badge tone="neutral">{proposal.status.replace(/_/g, " ")}</Badge>,
    },
    {
      key: "createdAt",
      header: "Raised",
      sortValue: (proposal) => proposal.createdAt,
      render: (proposal) => (
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

      <section className="pv-panel" aria-labelledby="improvement-clusters">
        <h2 className="pv-panel-heading" id="improvement-clusters">
          What keeps happening
        </h2>

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
          <DataTable
            caption={`Observation clusters, ${pluralise(clusters.length, "cluster", "clusters")}, ranked by how often each occurs.`}
            columns={clusterColumns}
            rows={clusters}
            rowKey={(cluster) => cluster.clusterId}
            defaultSort={{ columnKey: "occurrences", direction: "descending" }}
          />
        )}
      </section>

      <section className="pv-panel" aria-labelledby="improvement-proposals">
        <h2 className="pv-panel-heading" id="improvement-proposals">
          Proposals waiting for a decision
        </h2>

        {proposals.length === 0 ? (
          <EmptyState
            title="No proposal is waiting"
            body="Nobody has drafted a change in response to the clusters above. A cluster with no proposal is not an oversight; it may simply not be worth changing anything for."
          />
        ) : (
          <DataTable
            caption={`Improvement proposals, ${pluralise(proposals.length, "proposal", "proposals")}.`}
            columns={proposalColumns}
            rows={proposals}
            rowKey={(proposal) => proposal.proposalId}
            defaultSort={{ columnKey: "blastRadius", direction: "descending" }}
          />
        )}
      </section>
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
