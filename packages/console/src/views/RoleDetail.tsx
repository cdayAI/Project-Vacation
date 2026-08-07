import { useState, type ReactNode } from "react";
import { useClient } from "../api/ClientProvider";
import type { EvaluationView, RiskTier, RoleView } from "../api/contract";
import { useResource } from "../api/useResource";
import { formatDateTime, formatPercent, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import type { StatusTone } from "../theme/tokens";
import {
  Badge,
  Callout,
  EmptyState,
  IconAlert,
  IconBlocked,
  IconCircle,
  MarkUndo,
  Panel,
  Table,
  type TableColumn,
  type TableSort,
} from "../ui";

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

// ---------------------------------------------------------------------------
// The status vocabulary this screen speaks
// ---------------------------------------------------------------------------

/**
 * A status, in words, with a tone and a mark laid on top of the words rather
 * than in place of them. The label is what survives greyscale and a printed
 * evidence export, so it is the carrier (WCAG 1.4.1).
 *
 * A mark is named explicitly only where the tone's own default would say
 * something different from what the status means. `Badge` keys its default mark
 * by tone alone, so a disabled role and a role that failed would arrive at the
 * same cross — and "stopped on purpose" is not "broken".
 */
interface Presentation {
  readonly label: string;
  readonly tone: StatusTone;
  readonly icon?: ReactNode;
}

/**
 * Role lifecycle status.
 *
 * "Disabled" is deliberately the loudest of the five. A disabled role is not a
 * dormant one — it has been stopped, usually for a reason someone recorded —
 * and a registry that renders it in the same grey as "draft" hides the single
 * most operationally significant thing about it.
 */
const ROLE_STATUS: Readonly<Record<RoleView["status"], Presentation>> = {
  draft: { label: "Draft", tone: "neutral", icon: <IconCircle size="sm" /> },
  proposed: { label: "Proposed", tone: "info" },
  promoted: { label: "In service", tone: "success" },
  disabled: { label: "Disabled", tone: "danger", icon: <IconBlocked size="sm" /> },
  reverted: { label: "Reverted", tone: "warning", icon: <MarkUndo size="sm" /> },
};

function roleStatusLabel(status: RoleView["status"]): string {
  return ROLE_STATUS[status].label;
}

function RoleStatusBadge({ status }: { readonly status: RoleView["status"] }) {
  const presentation = ROLE_STATUS[status];
  return (
    <Badge tone={presentation.tone} icon={presentation.icon}>
      {presentation.label}
    </Badge>
  );
}

const RISK: Readonly<Record<RiskTier, Presentation>> = {
  routine: { label: "Routine", tone: "neutral" },
  sensitive: { label: "Sensitive", tone: "info" },
  high_consequence: { label: "High consequence", tone: "danger", icon: <IconAlert size="sm" /> },
  // Not "danger": a tier nothing may reach is the ceiling working, not a fault.
  prohibited: { label: "Prohibited", tone: "denied" },
};

/** The pill says "Routine risk"; the bare label is for sorting and prose. */
function RiskBadge({ risk }: { readonly risk: RiskTier }) {
  const presentation = RISK[risk];
  return (
    <Badge tone={presentation.tone} icon={presentation.icon}>
      {presentation.label} risk
    </Badge>
  );
}

/**
 * Whether an evaluation cleared the threshold set for it.
 *
 * The threshold is named in the label rather than left to a colour, because
 * "below threshold" and "below threshold against what bar" are different facts
 * and only one of them can be argued with.
 */
function EvaluationBadge({ evaluation }: { readonly evaluation: EvaluationView }) {
  return evaluation.meetsThreshold ? (
    <Badge tone="success">Meets the {(evaluation.threshold * 100).toFixed(0)}% threshold</Badge>
  ) : (
    <Badge tone="danger" icon={<IconAlert size="sm" />}>
      Below the {(evaluation.threshold * 100).toFixed(0)}% threshold
    </Badge>
  );
}

// ---------------------------------------------------------------------------

interface Fact {
  readonly term: string;
  readonly description: ReactNode;
}

/**
 * A real `<dl>`, each pair wrapped in a `<div>` so the grid can lay the two
 * columns out without putting anything between a `<dt>` and its `<dd>`.
 *
 * A grid of plain divs would look identical and announce nothing: a screen
 * reader says "definition list, eight items" here and pairs each term with its
 * description, which is what makes this readable without sight of the columns.
 */
function FactList({ items }: { readonly items: readonly Fact[] }) {
  return (
    <dl className="pv-dl">
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.description}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Newest first. A promotion history is read from the end that happened last. */
const HISTORY_SORT: TableSort = { columnKey: "version", direction: "descending" };

/**
 * Order the rows the table has been told it is showing.
 *
 * The table sorts for itself only while it owns the sort state, and it starts
 * that state at "unsorted" — which would list these versions in whatever order
 * the API returned while `aria-sort` correctly said nothing was sorted. Holding
 * the state here is what lets the screen open newest-first *and* announce that
 * it has. The comparison matches the table's own: numbers numerically,
 * everything else with a numeric case-insensitive collation, ties broken by
 * original position so the order is stable.
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

export interface RoleDetailProps {
  /** Every version of one role. Order does not matter; the view sorts. */
  readonly versions: readonly RoleView[];
}

export function RoleDetail({ versions }: RoleDetailProps) {
  const [historySort, setHistorySort] = useState<TableSort | null>(HISTORY_SORT);

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
          actions={<Link to="/roles">Back to the role registry</Link>}
          headingLevel={2}
        />
      </div>
    );
  }

  const evaluation = current.latestEvaluation;

  const definitionItems: readonly Fact[] = [
    { term: "Role", description: <span className="pv-mono">{current.roleId}</span> },
    { term: "Purpose", description: current.purpose },
    { term: "Version", description: `Version ${current.version}` },
    { term: "Lifecycle status", description: <RoleStatusBadge status={current.status} /> },
    { term: "Risk ceiling", description: <RiskBadge risk={current.riskCeiling} /> },
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

  const historyColumns: readonly TableColumn<RoleView>[] = [
    {
      key: "version",
      header: "Version",
      rowHeader: true,
      alwaysVisible: true,
      numeric: true,
      width: 110,
      sortValue: (version) => version.version,
      cell: (version) => <span>{version.version}</span>,
    },
    {
      key: "status",
      header: "What happened",
      width: 170,
      sortValue: (version) => roleStatusLabel(version.status),
      cell: (version) => <RoleStatusBadge status={version.status} />,
    },
    {
      key: "updatedAt",
      header: "When",
      width: 190,
      sortValue: (version) => version.updatedAt,
      cell: (version) => (
        <time dateTime={version.updatedAt}>{formatDateTime(version.updatedAt)}</time>
      ),
    },
    {
      key: "updatedBy",
      header: "Who",
      width: 220,
      sortValue: (version) => version.updatedBy.displayName,
      cell: (version) => (
        <span className="pv-stack-tight">
          <span>{version.updatedBy.displayName}</span>
          <span className="pv-meta">{version.updatedBy.roles.join(", ")}</span>
        </span>
      ),
    },
    {
      key: "evaluation",
      header: "Evaluation at the time",
      width: 230,
      sortValue: (version) => version.latestEvaluation?.accuracy ?? -1,
      cell: (version) => {
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
              <Badge tone="danger" icon={<IconAlert size="sm" />}>
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
      width: 220,
      sortValue: (version) => version.latestEvaluation?.modelId ?? "",
      cell: (version) =>
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

      <Panel title="What this role is">
        <FactList items={definitionItems} />
      </Panel>

      <Panel title="What it is permitted to do">
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
      </Panel>

      <Panel title="Latest evaluation">
        {evaluation === undefined ? (
          <p className="pv-meta">No evaluation has been recorded for this version.</p>
        ) : (
          <EvaluationDetail evaluation={evaluation} />
        )}
      </Panel>

      <Panel
        title="Promotion history"
        description="Every version of this role, newest first, with who changed it and what the curated set said at the time. A reverted version is one that was promoted and then taken back out."
      >
        {ordered.length === 1 ? (
          <p>
            This role has one version. It has been promoted once and never revised, reverted, or
            disabled since.
          </p>
        ) : (
          <Table
            caption={`Version history for ${current.name}, ${pluralise(ordered.length, "version", "versions")}.`}
            tableId="role-detail-history"
            columns={historyColumns}
            rows={orderBy(ordered, historyColumns, historySort)}
            rowKey={(version) => `${version.roleId}-v${version.version}`}
            rowNoun="versions"
            sort={historySort}
            onSortChange={setHistorySort}
          />
        )}
      </Panel>
    </div>
  );
}

function EvaluationDetail({ evaluation }: { readonly evaluation: EvaluationView }) {
  return (
    <div className="pv-stack">
      <div className="pv-row">
        <EvaluationBadge evaluation={evaluation} />
        <Badge tone="neutral">{formatPercent(evaluation.accuracy)} accurate</Badge>
      </div>

      <FactList
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
