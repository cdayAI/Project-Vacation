import { useClient } from "../api/ClientProvider";
import type { ApprovalView } from "../api/contract";
import { useResource } from "../api/useResource";
import {
  Badge,
  Callout,
  DataTable,
  EmptyState,
  RiskPill,
  riskLabel,
  type Column,
} from "../components";
import { formatCountdown, formatDateTime, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import { useNow } from "../useNow";

/**
 * The approvals queue.
 *
 * A list, not a decision surface. Nothing can be approved from here on purpose:
 * an approval binds to a proposal digest, and a queue row cannot show a
 * proposal in enough detail for anyone to honestly say they read it. The only
 * action on this screen is "open it and read it".
 */

export interface ApprovalsQueueProps {
  readonly approvals: readonly ApprovalView[];
  readonly total?: number;
}

export function ApprovalsQueue({ approvals, total }: ApprovalsQueueProps) {
  // Coarse: a queue does not need a second hand, and re-rendering a table
  // every second for a number nobody is staring at is waste.
  const now = useNow(30_000);

  const expiringSoon = approvals.filter((approval) => {
    const countdown = formatCountdown(approval.expiresAt, now);
    return !countdown.expired && countdown.totalMs < 60 * 60 * 1000;
  }).length;

  const columns: readonly Column<ApprovalView>[] = [
    {
      key: "action",
      header: "Action awaiting a decision",
      rowHeader: true,
      sortValue: (approval) => approval.ask,
      // The ask, in plain language, is the row (design spec §3.2). The action
      // registry's description of the *class* of action goes underneath: it is
      // the same sentence on every row of that kind, so leading with it makes
      // four different decisions look like one repeated four times.
      render: (approval) => (
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
      sortValue: (approval) => riskLabel(approval.risk),
      render: (approval) => <RiskPill risk={approval.risk} />,
    },
    {
      key: "reversible",
      header: "Reversible",
      sortValue: (approval) => (approval.reversible ? 1 : 0),
      render: (approval) =>
        approval.reversible ? (
          <span>Yes</span>
        ) : (
          <Badge tone="warning" glyph="▲">
            No — cannot be undone
          </Badge>
        ),
    },
    {
      key: "progress",
      header: "Approvals",
      numeric: true,
      sortValue: (approval) => approval.approvalsGranted - approval.approvalsRequired,
      render: (approval) => (
        <span>
          {approval.approvalsGranted} of {approval.approvalsRequired}
        </span>
      ),
    },
    {
      key: "requestedBy",
      header: "Raised by",
      sortValue: (approval) => approval.requestedBy.displayName,
      render: (approval) => (
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
      sortValue: (approval) => approval.expiresAt,
      render: (approval) => {
        const countdown = formatCountdown(approval.expiresAt, now);
        return (
          <span className="pv-stack-tight">
            {countdown.expired ? (
              <Badge tone="warning" glyph="▲">
                Expired
              </Badge>
            ) : (
              <span>{countdown.text}</span>
            )}
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
      sortValue: (approval) => (approval.viewerMayDecide ? 0 : 1),
      render: (approval) =>
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
        <DataTable
          caption={`Approvals awaiting a decision, ${pluralise(approvals.length, "row", "rows")}.`}
          columns={columns}
          rows={approvals}
          rowKey={(approval) => approval.approvalId}
          defaultSort={{ columnKey: "expiresAt", direction: "ascending" }}
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
