import { useClient } from "../api/ClientProvider";
import type { EvaluationView, RoleView } from "../api/contract";
import { useResource } from "../api/useResource";
import {
  Badge,
  Callout,
  DataTable,
  DefinitionList,
  EmptyState,
  EvaluationPill,
  RiskPill,
  RoleStatusPill,
  roleStatusLabel,
  type Column,
  type DefinitionItem,
} from "../components";
import { formatDateTime, formatPercent, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";

/**
 * One agent role, in full, with its history.
 *
 * The current version is the highest-numbered one in the list the API returns;
 * the rest are the promotion history. Deriving "current" rather than being told
 * it means the two can never disagree, and it keeps the history and the current
 * state on exactly the same fields instead of two shapes that have to be kept
 * in step.
 *
 * Permitted actions and data scopes are listed in full and never truncated
 * behind a "show more". They are the authority this role holds, and a reader
 * who has to expand something to see the rest of it will read the first three
 * and assume.
 */

export interface RoleDetailProps {
  /** Every version of one role. Order does not matter; the view sorts. */
  readonly versions: readonly RoleView[];
}

export function RoleDetail({ versions }: RoleDetailProps) {
  const ordered = [...versions].sort((left, right) => right.version - left.version);
  const current = ordered[0];

  if (current === undefined) {
    return (
      <div className="pv-stack">
        <div className="pv-page-header">
          <p className="pv-meta">
            <Link to="/roles">Agent roles</Link>
          </p>
          <h1>This role has no versions</h1>
        </div>
        <EmptyState
          title="Nothing to show"
          body="The platform holds no version record for this role. Either it was never registered, or the identifier in the address is wrong."
          action={<Link to="/roles">Back to the role registry</Link>}
          headingLevel={2}
        />
      </div>
    );
  }

  const evaluation = current.latestEvaluation;

  const definitionItems: DefinitionItem[] = [
    { term: "Role", description: <span className="pv-mono">{current.roleId}</span> },
    { term: "Purpose", description: current.purpose },
    { term: "Version", description: `Version ${current.version}` },
    { term: "Lifecycle status", description: <RoleStatusPill status={current.status} /> },
    { term: "Risk ceiling", description: <RiskPill risk={current.riskCeiling} /> },
    { term: "Human involvement", description: current.humanInvolvement },
    { term: "Model task", description: <span className="pv-mono">{current.modelTask}</span> },
    {
      term: "Last changed",
      description: (
        <span>
          <time dateTime={current.updatedAt}>{formatDateTime(current.updatedAt)}</time>
          {` by ${current.updatedBy.displayName} (${current.updatedBy.roles.join(", ")})`}
        </span>
      ),
    },
  ];

  const historyColumns: readonly Column<RoleView>[] = [
    {
      key: "version",
      header: "Version",
      rowHeader: true,
      numeric: true,
      sortValue: (version) => version.version,
      render: (version) => <span>{version.version}</span>,
    },
    {
      key: "status",
      header: "What happened",
      sortValue: (version) => roleStatusLabel(version.status),
      render: (version) => <RoleStatusPill status={version.status} />,
    },
    {
      key: "updatedAt",
      header: "When",
      sortValue: (version) => version.updatedAt,
      render: (version) => (
        <time dateTime={version.updatedAt}>{formatDateTime(version.updatedAt)}</time>
      ),
    },
    {
      key: "updatedBy",
      header: "Who",
      sortValue: (version) => version.updatedBy.displayName,
      render: (version) => (
        <span className="pv-stack-tight">
          <span>{version.updatedBy.displayName}</span>
          <span className="pv-meta">{version.updatedBy.roles.join(", ")}</span>
        </span>
      ),
    },
    {
      key: "evaluation",
      header: "Evaluation at the time",
      sortValue: (version) => version.latestEvaluation?.accuracy ?? -1,
      render: (version) => {
        const versionEvaluation = version.latestEvaluation;
        if (versionEvaluation === undefined) {
          return <span className="pv-meta">Not evaluated</span>;
        }
        return (
          <span className="pv-stack-tight">
            <span>
              {formatPercent(versionEvaluation.accuracy)} against{" "}
              {formatPercent(versionEvaluation.threshold, 0)}
            </span>
            {versionEvaluation.meetsThreshold ? (
              <span className="pv-meta">Met threshold</span>
            ) : (
              <Badge tone="danger" glyph="▲">
                Below threshold
              </Badge>
            )}
          </span>
        );
      },
    },
    {
      key: "modelId",
      header: "Model",
      sortValue: (version) => version.latestEvaluation?.modelId ?? "",
      render: (version) =>
        version.latestEvaluation === undefined ? (
          <span className="pv-meta">Not recorded</span>
        ) : (
          <span className="pv-mono">{version.latestEvaluation.modelId}</span>
        ),
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <p className="pv-meta">
          <Link to="/roles">Agent roles</Link>
        </p>
        <h1>{current.name}</h1>
        <p className="pv-page-lede pv-mono">
          {current.roleId} · version {current.version}
        </p>
      </div>

      {current.disabled && (
        <Callout tone="danger" title="This role is disabled and will not run">
          <p>
            Nothing dispatches to this role while it is disabled. Any workflow step that needs it
            stops and is refused rather than proceeding without it. Releasing it is a containment
            decision, not a change to the role.
          </p>
          <p>
            <Link to="/containment">Check the containment controls</Link>
          </p>
        </Callout>
      )}

      {evaluation !== undefined && !evaluation.meetsThreshold && (
        <Callout tone="danger" title="The latest evaluation does not meet its threshold">
          <p>
            This role scored {formatPercent(evaluation.accuracy)} on{" "}
            {pluralise(evaluation.caseCount, "case", "cases")} against a threshold of{" "}
            {formatPercent(evaluation.threshold, 0)}. Being below the threshold does not stop a
            promoted role from running. Whether it should keep running is a decision for its owner,
            and it is a decision somebody has to make rather than one the platform makes quietly.
          </p>
        </Callout>
      )}

      {evaluation === undefined && (
        <Callout tone="warning" title="This role has never been evaluated">
          <p>
            There is no measured accuracy for this role against a curated set. That is not the same
            as scoring badly, and it is not the same as scoring well — it means nobody has checked.
          </p>
        </Callout>
      )}

      <section className="pv-panel" aria-labelledby="role-definition">
        <h2 className="pv-panel-heading" id="role-definition">
          What this role is
        </h2>
        <DefinitionList items={definitionItems} />
      </section>

      <section className="pv-panel" aria-labelledby="role-authority">
        <h2 className="pv-panel-heading" id="role-authority">
          What it is permitted to do
        </h2>

        <h3>Permitted actions</h3>
        <p className="pv-meta">
          Anything not on this list is refused at the authorization chokepoint, whether or not this
          console offers a control for it.
        </p>
        {current.allowedActions.length === 0 ? (
          <p>
            No action is permitted. A role with no permitted actions cannot do anything at all.
          </p>
        ) : (
          <ul className="pv-token-list">
            {current.allowedActions.map((action) => (
              <li className="pv-token" key={action}>
                <span className="pv-mono">{action}</span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="pv-space-above-wide">Data scopes</h3>
        <p className="pv-meta">
          The data this role is entitled to read. Scope is re-checked per request; a scope absent
          here is data this role cannot reach.
        </p>
        {current.dataScopes.length === 0 ? (
          <p>No data scope is granted. This role can reach no records.</p>
        ) : (
          <ul className="pv-token-list">
            {current.dataScopes.map((scope) => (
              <li className="pv-token" key={scope}>
                <span className="pv-mono">{scope}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pv-panel" aria-labelledby="role-evaluation">
        <h2 className="pv-panel-heading" id="role-evaluation">
          Latest evaluation
        </h2>
        {evaluation === undefined ? (
          <p className="pv-meta">No evaluation has been recorded for this version.</p>
        ) : (
          <EvaluationDetail evaluation={evaluation} />
        )}
      </section>

      <section className="pv-panel" aria-labelledby="role-history">
        <h2 className="pv-panel-heading" id="role-history">
          Promotion history
        </h2>
        <p className="pv-meta">
          Every version of this role, newest first, with who changed it and what the curated set
          said at the time. A reverted version is one that was promoted and then taken back out.
        </p>
        {ordered.length === 1 ? (
          <p>
            This role has one version. It has been promoted once and never revised, reverted, or
            disabled since.
          </p>
        ) : (
          <DataTable
            caption={`Version history for ${current.name}, ${pluralise(ordered.length, "version", "versions")}.`}
            columns={historyColumns}
            rows={ordered}
            rowKey={(version) => `${version.roleId}-v${version.version}`}
            defaultSort={{ columnKey: "version", direction: "descending" }}
          />
        )}
      </section>
    </div>
  );
}

function EvaluationDetail({ evaluation }: { readonly evaluation: EvaluationView }) {
  return (
    <div className="pv-stack">
      <div className="pv-row">
        <EvaluationPill evaluation={evaluation} />
        <Badge tone="neutral">{formatPercent(evaluation.accuracy)} accurate</Badge>
      </div>

      <DefinitionList
        items={[
          { term: "Curated set", description: evaluation.goldenSetName },
          {
            term: "Result",
            description: `${evaluation.passed} of ${pluralise(evaluation.caseCount, "case", "cases")} passed — ${formatPercent(evaluation.accuracy)}`,
          },
          {
            term: "Threshold",
            description: `${formatPercent(evaluation.threshold, 0)} — set by the role's owner, not by the platform`,
          },
          {
            term: "Run at",
            description: <time dateTime={evaluation.ranAt}>{formatDateTime(evaluation.ranAt)}</time>,
          },
          { term: "Model", description: <span className="pv-mono">{evaluation.modelId}</span> },
          {
            term: "Prompt version",
            description: <span className="pv-mono">{evaluation.promptVersion}</span>,
          },
          { term: "Evaluation", description: <span className="pv-mono">{evaluation.evaluationId}</span> },
        ]}
      />

      <p className="pv-meta">
        The curated set is maintained by people. The improvement loop may propose cases for it; it
        may never weaken, relabel, or delete one.
      </p>
    </div>
  );
}

/** Route-level container. */
export function RoleDetailRoute({ roleId }: { readonly roleId: string }) {
  const client = useClient();
  const resource = useResource(
    (signal) => client.roleVersions(roleId, { signal }),
    [client, roleId],
  );

  return (
    <ResourceView resource={resource} attempted="this role">
      {(page) => <RoleDetail versions={page.items} />}
    </ResourceView>
  );
}
