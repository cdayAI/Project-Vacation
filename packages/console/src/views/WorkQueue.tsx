import { useMemo, useState } from "react";
import { useClient } from "../api/ClientProvider";
import type {
  OperatingMode,
  RunStatus,
  WorkQueueItem,
  WorkQueueOwner,
} from "../api/contract";
import { useResource } from "../api/useResource";
import {
  Badge,
  Callout,
  DataTable,
  EmptyState,
  Field,
  ModePill,
  RunStatusPill,
  modeLabel,
  runStatusLabel,
  type Column,
} from "../components";
import { formatAge, formatDateTime, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import { useNow } from "../useNow";

/**
 * The work queue — the default landing screen (design spec §3.1).
 *
 * Seven columns: status, what, owner, age, value, assignee, next action, with
 * cost as an eighth. Cost is not in the spec's default set and is here anyway,
 * because it is the one number on this screen that nobody else in MVW is
 * currently able to produce per case, and a platform asking to be trusted with
 * spend has to show it where the spend is decided.
 *
 * **Three of these columns the platform cannot source, and that is the shape of
 * the file.** Owner names, case value, and assignment live in systems of record
 * this deployment does not read. Every one of them renders a sentence saying
 * so rather than a blank cell or a plausible zero — see `Absent` below. A
 * supervisor who learns that the value column is decorative stops reading it,
 * and then stops reading the columns beside it.
 *
 * **The age band is computed here, not sent.** The platform sends
 * `slaStartedAt`, `dueAt`, and its own answer to "has this breached"; the
 * threshold at which "still fine" becomes "due soon" is a design decision and
 * lives with the design system. What the platform will not do is send a colour.
 *
 * Breach is carried in four independent channels — the word "Past due" in the
 * age cell, a count in a callout above the table, a tinted row, and a bar down
 * the row's leading edge. The first two survive greyscale, a screen reader, and
 * a colour-vision deficiency (WCAG 1.4.1); the last two are for the person
 * scanning the table from across a room.
 */

const STATUS_OPTIONS: readonly RunStatus[] = [
  "pending",
  "running",
  "awaiting_human",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "denied",
];

const MODE_OPTIONS: readonly OperatingMode[] = [
  "shadow",
  "assisted",
  "supervised",
  "bounded_autonomy",
];

/** Work that has ended. Nobody is waiting on it, so no deadline applies. */
const TERMINAL_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled", "denied"];

/**
 * The fraction of a service-level target after which an item is "due soon".
 *
 * A design decision, not a platform one: it exists so a supervisor has a
 * chance to act before the breach rather than a report of it afterwards.
 */
const DUE_SOON_FRACTION = 0.8;

type AgeBand = "no_target" | "not_waiting" | "within" | "due_soon" | "breached";

const BAND_LABEL: Readonly<Record<AgeBand, string>> = {
  no_target: "No target",
  not_waiting: "Not waiting",
  within: "Within SLA",
  due_soon: "Due soon",
  breached: "Past due",
};

/**
 * Which band an item is in.
 *
 * `slaBreached` is the platform's answer and is never recomputed here — it
 * knows things this screen does not, such as that terminal work cannot breach
 * a deadline nobody is still waiting on. The clock is consulted only to raise
 * the softer warning, so the worst a skewed browser clock can do is warn early.
 */
function ageBand(item: WorkQueueItem, now: Date): AgeBand {
  if (item.slaTargetUnknown !== undefined || item.dueAt === undefined) return "no_target";
  if (item.slaBreached) return "breached";
  if (TERMINAL_STATUSES.includes(item.status)) return "not_waiting";

  const started = Date.parse(item.slaStartedAt ?? item.createdAt);
  const due = Date.parse(item.dueAt);
  if (Number.isNaN(started) || Number.isNaN(due) || due <= started) return "within";

  const elapsed = (now.getTime() - started) / (due - started);
  return elapsed >= DUE_SOON_FRACTION ? "due_soon" : "within";
}

/**
 * A value the platform cannot source, and why.
 *
 * Rendered as a short sentence rather than a dash or an em-space. The reason
 * is available to a screen reader in the same cell, so the gap is legible
 * without hovering something.
 */
function Absent({ reason }: { readonly reason: string }) {
  return (
    <span className="pv-meta pv-absent" title={reason}>
      Not available<span className="pv-sr-only">. {reason}</span>
    </span>
  );
}

function OwnerCell({
  owner,
  ownerUnknown,
}: {
  readonly owner?: WorkQueueOwner;
  readonly ownerUnknown?: string;
}) {
  if (owner === undefined) {
    return <Absent reason={ownerUnknown ?? "This run carries no account reference."} />;
  }
  return (
    <span className="pv-stack-tight">
      {owner.name === undefined ? (
        <Absent
          reason={
            owner.nameUnknown ??
            "No owner system of record is connected, so only the account reference is held."
          }
        />
      ) : (
        <span>{owner.name}</span>
      )}
      <span className="pv-meta pv-mono">{owner.accountRef}</span>
    </span>
  );
}

export interface WorkQueueProps {
  readonly items: readonly WorkQueueItem[];
  /** Total on the server, which can exceed what this page holds. */
  readonly total?: number;
  /**
   * False when the server resolved a filter it cannot push into the store, so
   * `total` counts what it examined rather than what exists. Saying "1,240" of
   * something that might be 4,000 is how a supervisor concludes the queue is
   * shorter than it is.
   */
  readonly totalIsExact?: boolean;
}

export function WorkQueue({ items, total, totalIsExact = true }: WorkQueueProps) {
  // Coarse on purpose: the age column moves in minutes, and re-rendering a
  // table every second for a number nobody is watching tick is waste.
  const now = useNow(30_000);

  const [status, setStatus] = useState<RunStatus | "all">("all");
  const [mode, setMode] = useState<OperatingMode | "all">("all");
  const [breachedOnly, setBreachedOnly] = useState(false);

  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (status !== "all" && item.status !== status) return false;
        if (mode !== "all" && item.mode !== mode) return false;
        if (breachedOnly && !item.slaBreached) return false;
        return true;
      }),
    [items, status, mode, breachedOnly],
  );

  const breachedCount = visible.filter((item) => item.slaBreached).length;
  const totalCost = visible.reduce((sum, item) => sum + item.costUsd, 0);
  const isFiltered = status !== "all" || mode !== "all" || breachedOnly;

  const columns: readonly Column<WorkQueueItem>[] = [
    {
      key: "status",
      header: "Status",
      sortValue: (item) => runStatusLabel(item.status),
      render: (item) => (
        <span className="pv-stack-tight">
          <RunStatusPill status={item.status} />
          <ModePill mode={item.mode} />
        </span>
      ),
    },
    {
      key: "title",
      header: "What",
      rowHeader: true,
      sortValue: (item) => item.title,
      render: (item) => (
        <span className="pv-stack-tight">
          <Link to={`/runs/${item.runId}`}>{item.title}</Link>
          {item.subtitle !== undefined && <span className="pv-caption">{item.subtitle}</span>}
          <span className="pv-meta pv-mono">
            {item.kind} · {item.runId}
          </span>
        </span>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      sortValue: (item) => item.owner?.name ?? item.owner?.accountRef ?? "￿",
      render: (item) => <OwnerCell owner={item.owner} ownerUnknown={item.ownerUnknown} />,
    },
    {
      key: "age",
      header: "Age",
      // Oldest first when ascending: the age column is what a supervisor
      // triages on, and "oldest" is the end of it they care about.
      sortValue: (item) => item.slaStartedAt ?? item.createdAt,
      render: (item) => {
        const band = ageBand(item, now);
        const started = item.slaStartedAt ?? item.createdAt;
        return (
          <span className={`pv-stack-tight pv-age pv-age-${band}`}>
            <time dateTime={started}>{formatAge(started, now)}</time>
            {band === "breached" ? (
              <Badge tone="danger" glyph="▲">
                {BAND_LABEL.breached}
              </Badge>
            ) : band === "due_soon" ? (
              <Badge tone="warning" glyph="▲">
                {BAND_LABEL.due_soon}
              </Badge>
            ) : (
              <span className="pv-meta">{BAND_LABEL[band]}</span>
            )}
            {item.slaTargetUnknown !== undefined ? (
              <span className="pv-sr-only">{item.slaTargetUnknown}</span>
            ) : (
              item.slaPolicy !== undefined && (
                // The policy is named so the deadline is attributable rather
                // than folklore, and it is where the due date is stated in
                // full — the cell above it is a relative age, not an instant.
                <span className="pv-meta" title={item.slaPolicy}>
                  {item.slaPolicy}
                  {item.dueAt !== undefined && (
                    <span className="pv-sr-only">
                      . Due {formatDateTime(item.dueAt)}
                    </span>
                  )}
                </span>
              )
            )}
          </span>
        );
      },
    },
    {
      key: "value",
      header: "Value",
      numeric: true,
      // Unknown sorts last in both directions rather than as zero: an amount
      // the platform cannot read is not evidence that the amount is small.
      sortValue: (item) => item.valueUsd ?? -1,
      render: (item) =>
        item.valueUsd === undefined ? (
          <Absent
            reason={
              item.valueUnknown ??
              "Case value comes from a system of record this deployment does not read."
            }
          />
        ) : (
          <span>
            {new Intl.NumberFormat(undefined, {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 0,
            }).format(item.valueUsd)}
          </span>
        ),
    },
    {
      key: "assignee",
      header: "Assignee",
      sortValue: (item) => item.assignee?.displayName ?? item.assignedRole ?? "￿",
      render: (item) => {
        if (item.assignee !== undefined) {
          return (
            <span className="pv-stack-tight">
              <span>{item.assignee.displayName}</span>
              {item.assignedRole !== undefined && (
                <span className="pv-meta pv-mono">{item.assignedRole}</span>
              )}
            </span>
          );
        }
        if (item.assignment === "not_tracked") {
          // A different statement from "unassigned", and an operator acts
          // differently on each: one is work nobody has picked up, the other
          // is a question this deployment cannot answer at all.
          return (
            <Absent reason="Assignment is not modelled on a run, so this deployment cannot say who holds it." />
          );
        }
        if (item.assignedRole !== undefined) {
          return (
            <span className="pv-stack-tight">
              <span className="pv-meta">Any</span>
              <span className="pv-meta pv-mono">{item.assignedRole}</span>
            </span>
          );
        }
        return <span className="pv-meta">Unassigned</span>;
      },
    },
    {
      key: "nextAction",
      header: "Next",
      sortValue: (item) => item.nextAction,
      render: (item) =>
        item.nextActionApprovalId === undefined ? (
          <span>{item.nextAction}</span>
        ) : (
          <Link to={`/approvals/${item.nextActionApprovalId}`}>
            {item.nextAction}
            <span className="pv-sr-only"> for {item.title}</span>
          </Link>
        ),
    },
    {
      key: "costUsd",
      header: "Cost",
      numeric: true,
      sortValue: (item) => item.costUsd,
      render: (item) => <span>{formatUsd(item.costUsd)}</span>,
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>Work queue</h1>
        <p className="pv-page-lede">
          Everything the platform is working on or waiting on. Cost is what this item has spent so
          far, not an estimate.
        </p>
      </div>

      <div className="pv-toolbar">
        <Field label="Status">
          {(control) => (
            <select
              id={control.id}
              className="pv-select"
              value={status}
              onChange={(event) => setStatus(event.target.value as RunStatus | "all")}
            >
              <option value="all">All statuses</option>
              {STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {runStatusLabel(option)}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Operating mode">
          {(control) => (
            <select
              id={control.id}
              className="pv-select"
              value={mode}
              onChange={(event) => setMode(event.target.value as OperatingMode | "all")}
            >
              <option value="all">All modes</option>
              {MODE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {modeLabel(option)}
                </option>
              ))}
            </select>
          )}
        </Field>

        <div className="pv-checkbox-field">
          <input
            type="checkbox"
            className="pv-checkbox"
            id="work-queue-breached-only"
            checked={breachedOnly}
            onChange={(event) => setBreachedOnly(event.target.checked)}
          />
          <label htmlFor="work-queue-breached-only">Only items past their SLA</label>
        </div>
      </div>

      {/* Announced when the filters change, so the result of a filter is heard
          and not only seen. */}
      <p role="status" className="pv-meta">
        Showing {pluralise(visible.length, "item", "items")}
        {total !== undefined && total !== items.length ? ` of ${total} on the server` : ""}
        {isFiltered ? ", filtered" : ""}. Total cost {formatUsd(totalCost)}.
      </p>

      {!totalIsExact && (
        <Callout tone="warning" title="This count is not the whole queue">
          <p>
            One of the filters in use cannot be applied by the operating record, so the server
            resolved it over a bounded window. More items may match than are counted here. Narrow
            by status or mode to get an exact count.
          </p>
        </Callout>
      )}

      {breachedCount > 0 && (
        <Callout
          tone="danger"
          title={`${pluralise(breachedCount, "item is", "items are")} past due`}
        >
          <p>
            These items have passed the service level they were accepted under. They are marked
            &ldquo;Past due&rdquo; in the Age column below.
          </p>
        </Callout>
      )}

      {visible.length === 0 ? (
        <EmptyState
          title={isFiltered ? "Nothing matches these filters" : "The work queue is empty"}
          body={
            isFiltered
              ? "No item matches the status, mode, and SLA filters currently set. Widen a filter to see more."
              : "Nothing is queued, running, or waiting. Items appear here as workflows start."
          }
          headingLevel={2}
        />
      ) : (
        <DataTable
          caption={`Work queue, ${pluralise(visible.length, "item", "items")}.`}
          columns={columns}
          rows={visible}
          rowKey={(item) => item.runId}
          rowClassName={(item) => (item.slaBreached ? "pv-row-breached" : undefined)}
          defaultSort={{ columnKey: "age", direction: "ascending" }}
        />
      )}
    </div>
  );
}

/** Route-level container: loads the queue and hands it to the view above. */
export function WorkQueueRoute() {
  const client = useClient();
  const resource = useResource((signal) => client.workQueue({}, { signal }), [client]);

  return (
    <ResourceView resource={resource} attempted="the work queue">
      {(page) => (
        <WorkQueue items={page.items} total={page.total} totalIsExact={page.totalIsExact} />
      )}
    </ResourceView>
  );
}
