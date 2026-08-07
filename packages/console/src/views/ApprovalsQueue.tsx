import { useState, type ReactNode } from "react";
import { useClient } from "../api/ClientProvider";
import type { ApprovalView, RiskTier } from "../api/contract";
import { useResource } from "../api/useResource";
import { formatCountdown, formatDateTime, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import type { StatusTone } from "../theme/tokens";
import {
  Badge,
  Callout,
  EmptyState,
  IconAlert,
  Table,
  type TableColumn,
  type TableSort,
} from "../ui";
import { useNow } from "../useNow";

/**
 * The approvals queue.
 *
 * A list, not a decision surface. Nothing can be approved from here on purpose:
 * an approval binds to a proposal digest, and a queue row cannot show a
 * proposal in enough detail for anyone to honestly say they read it. The only
 * action on this screen is "open it and read it".
 */

interface RiskPresentation {
  readonly label: string;
  readonly tone: StatusTone;
  /**
   * Left unset where the tone's own mark already says the right thing. It is
   * set for `high_consequence` because that tone's default mark is a cross,
   * which reads as "this failed" rather than "read this carefully" — the
   * triangle is the shape the risk vocabulary has always used for a warning
   * an operator has to weigh.
   */
  readonly icon?: ReactNode;
}

/**
 * The four risk tiers, in words.
 *
 * The label carries the meaning; the tone and the mark are redundant channels
 * on top of it (WCAG 1.4.1). `prohibited` is `denied` rather than `danger`
 * because a tier the platform will not act in is governance working, and
 * painting it the colour of a breach teaches operators to read control as
 * breakage.
 */
const RISK: Readonly<Record<RiskTier, RiskPresentation>> = {
  routine: { label: "Routine", tone: "neutral" },
  sensitive: { label: "Sensitive", tone: "info" },
  high_consequence: { label: "High consequence", tone: "danger", icon: <IconAlert size="sm" /> },
  prohibited: { label: "Prohibited", tone: "denied" },
};

function riskLabel(risk: RiskTier): string {
  return RISK[risk].label;
}

/**
 * The tier, as a badge.
 *
 * Reads "High consequence risk", not "High consequence" — the noun is what
 * makes the badge legible on a row beside six other badges, and the bare label
 * is kept for sorting, where the noun would only pad every key by five
 * characters.
 */
function RiskBadge({ risk }: { readonly risk: RiskTier }) {
  const presentation = RISK[risk];
  return (
    <Badge tone={presentation.tone} icon={presentation.icon}>
      {presentation.label} risk
    </Badge>
  );
}

/** Most urgent first. The queue exists to be worked from the top. */
const INITIAL_SORT: TableSort = { columnKey: "expiresAt", direction: "ascending" };

/**
 * Order the rows the table has been told it is showing.
 *
 * The table sorts for itself only while it owns the sort state, and it starts
 * that state at "unsorted" — which would put this queue in whatever order the
 * server happened to return, with nothing on screen admitting it. Holding the
 * state here instead is what lets the screen open on the expiry column *and*
 * say so in `aria-sort`. The comparison matches the table's own: numbers
 * numerically, everything else with a numeric, case-insensitive collation, and
 * ties broken by original position so the order is stable.
 */
function orderBy<T>(
  rows: readonly T[],
  columns: readonly TableColumn<T>[],
  sort: TableSort | null,
): readonly T[] {
  const sortValue = sort === null ? undefined : columns.find((c) => c.key === sort.columnKey)?.sortValue;
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

export interface ApprovalsQueueProps {
  readonly approvals: readonly ApprovalView[];
  readonly total?: number;
}

export function ApprovalsQueue({ approvals, total }: ApprovalsQueueProps) {
  // Coarse: a queue does not need a second hand, and re-rendering a table
  // every second for a number nobody is staring at is waste.
  const now = useNow(30_000);

  const [sort, setSort] = useState<TableSort | null>(INITIAL_SORT);

  const expiringSoon = approvals.filter((approval) => {
    const countdown = formatCountdown(approval.expiresAt, now);
    return !countdown.expired && countdown.totalMs < 60 * 60 * 1000;
  }).length;

  const columns: readonly TableColumn<ApprovalView>[] = [
    {
      key: "action",
      header: "Action awaiting a decision",
      rowHeader: true,
      alwaysVisible: true,
      width: 320,
      sortValue: (approval) => approval.ask,
      // The ask, in plain language, is the row (design spec §3.2). The action
      // registry's description of the *class* of action goes underneath: it is
      // the same sentence on every row of that kind, so leading with it makes
      // four different decisions look like one repeated four times.
      cell: (approval) => (
        <span className="pv-stack-tight">
          <Link to={`/approvals/${approval.approvalId}`}>{approval.ask}</Link>
          <span className="pv-caption">{approval.actionDescription}</span>
          <span className="pv-meta pv-mono">{approval.action}</span>
        </span>
      ),
    },
    {
      key: "risk",
      header: "Risk",
      width: 180,
      sortValue: (approval) => riskLabel(approval.risk),
      cell: (approval) => <RiskBadge risk={approval.risk} />,
    },
    {
      key: "reversible",
      header: "Reversible",
      width: 200,
      sortValue: (approval) => (approval.reversible ? 1 : 0),
      cell: (approval) =>
        approval.reversible ? <span>Yes</span> : <Badge tone="warning">No — cannot be undone</Badge>,
    },
    {
      key: "progress",
      header: "Approvals",
      width: 120,
      numeric: true,
      sortValue: (approval) => approval.approvalsGranted - approval.approvalsRequired,
      cell: (approval) => (
        <span>
          {approval.approvalsGranted} of {approval.approvalsRequired}
        </span>
      ),
    },
    {
      key: "requestedBy",
      header: "Raised by",
      width: 180,
      sortValue: (approval) => approval.requestedBy.displayName,
      cell: (approval) => (
        <span className="pv-stack-tight">
          <span>{approval.requestedBy.displayName}</span>
          <time className="pv-meta" dateTime={approval.requestedAt}>
            {formatDateTime(approval.requestedAt)}
          </time>
        </span>
      ),
    },
    {
      key: "expiresAt",
      header: "Expires",
      width: 200,
      sortValue: (approval) => approval.expiresAt,
      cell: (approval) => {
        const countdown = formatCountdown(approval.expiresAt, now);
        return (
          <span className="pv-stack-tight">
            {countdown.expired ? <Badge tone="warning">Expired</Badge> : <span>{countdown.text}</span>}
            <time className="pv-meta" dateTime={approval.expiresAt}>
              {formatDateTime(approval.expiresAt)}
            </time>
          </span>
        );
      },
    },
    {
      key: "viewerMayDecide",
      header: "You",
      width: 220,
      sortValue: (approval) => (approval.viewerMayDecide ? 0 : 1),
      cell: (approval) =>
        approval.viewerMayDecide ? (
          <span>May decide</span>
        ) : (
          <span className="pv-meta">
            May not decide
            {approval.viewerMayNotDecideReason === undefined
              ? ""
              : ` — ${approval.viewerMayNotDecideReason}`}
          </span>
        ),
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>Approvals</h1>
        <p className="pv-page-lede">
          Actions the platform has prepared and parked, waiting for a person to decide. Open one
          to read the proposal in full — an approval binds to the proposal it was given for, so
          the queue deliberately does not offer a decision.
        </p>
      </div>

      <p role="status" className="pv-meta">
        {pluralise(approvals.length, "approval is", "approvals are")} awaiting a decision
        {total !== undefined && total !== approvals.length ? ` of ${total} on the server` : ""}.
      </p>

      {expiringSoon > 0 && (
        <Callout
          tone="warning"
          title={`${pluralise(expiringSoon, "approval expires", "approvals expire")} within the hour`}
        >
          <p>
            When an approval expires the parked action does not run and the request has to be
            raised again. The expiry is shown in the Expires column.
          </p>
        </Callout>
      )}

      {approvals.length === 0 ? (
        <EmptyState
          title="No approvals are waiting"
          body="Nothing is parked for a decision. High-consequence actions appear here when the platform prepares one."
          headingLevel={2}
        />
      ) : (
        <Table
          caption={`Approvals awaiting a decision, ${pluralise(approvals.length, "row", "rows")}.`}
          tableId="approvals-queue"
          columns={columns}
          rows={orderBy(approvals, columns, sort)}
          rowKey={(approval) => approval.approvalId}
          rowNoun="approvals"
          // The server's count, not the mounted window's: a virtualized table
          // that reports what it rendered tells an operator the queue is
          // shorter than it is.
          totalRowCount={total}
          sort={sort}
          onSortChange={setSort}
        />
      )}
    </div>
  );
}

/** Route-level container. */
export function ApprovalsQueueRoute() {
  const client = useClient();
  const resource = useResource((signal) => client.approvals({}, { signal }), [client]);

  return (
    <ResourceView resource={resource} attempted="the approvals queue">
      {(page) => <ApprovalsQueue approvals={page.items} total={page.total} />}
    </ResourceView>
  );
}
