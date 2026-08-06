import { useMemo, useState } from "react";
import { useClient } from "../api/ClientProvider";
import type { OperatingMode, RunStatus, WorkQueueItem } from "../api/contract";
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
import { NOT_RECORDED, formatDateTime, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";

/**
 * The work queue.
 *
 * The screen an owner-services agent or a supervisor lives on. Three things it
 * has to answer without being asked twice: what is late, what is it waiting
 * on, and what is it costing.
 *
 * SLA breach is carried in four independent channels — a written "Past due" in
 * its own column, a count in a callout above the table, a tinted row, and a
 * bar down the row's leading edge. The first two survive greyscale, a
 * screen reader, and a colour-vision deficiency; the last two are for the
 * person scanning the table across a conference room (WCAG 1.4.1).
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

export interface WorkQueueProps {
  readonly items: readonly WorkQueueItem[];
  /** Total on the server, which can exceed what this page holds. */
  readonly total?: number;
}

export function WorkQueue({ items, total }: WorkQueueProps) {
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
      key: "title",
      header: "Item",
      rowHeader: true,
      sortValue: (item) => item.title,
      render: (item) => (
        <span className="pv-stack-tight">
          <Link to={`/runs/${item.runId}`}>{item.title}</Link>
          <span className="pv-meta pv-mono">
            {item.kind} · {item.runId}
          </span>
        </span>
      ),
    },
    {
      key: "sla",
      header: "SLA",
      sortValue: (item) => (item.slaBreached ? 0 : 1),
      render: (item) =>
        item.slaBreached ? (
          <Badge tone="danger" glyph="▲">
            Past due
          </Badge>
        ) : (
          <span className="pv-meta">Within SLA</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (item) => runStatusLabel(item.status),
      render: (item) => <RunStatusPill status={item.status} />,
    },
    {
      key: "waitingOn",
      header: "Waiting on",
      sortValue: (item) => item.waitingOn ?? "",
      render: (item) =>
        item.waitingOn === undefined ? (
          <span className="pv-meta">Not waiting</span>
        ) : (
          <span>{item.waitingOn}</span>
        ),
    },
    {
      key: "mode",
      header: "Mode",
      sortValue: (item) => modeLabel(item.mode),
      render: (item) => <ModePill mode={item.mode} />,
    },
    {
      key: "assignedRole",
      header: "Assigned to",
      sortValue: (item) => item.assignedRole ?? "",
      render: (item) =>
        item.assignedRole === undefined ? (
          <span className="pv-meta">Unassigned</span>
        ) : (
          <span>{item.assignedRole}</span>
        ),
    },
    {
      key: "dueAt",
      header: "Due",
      sortValue: (item) => item.dueAt ?? "￿",
      render: (item) =>
        item.dueAt === undefined ? (
          <span className="pv-meta">{NOT_RECORDED}</span>
        ) : (
          <time dateTime={item.dueAt}>{formatDateTime(item.dueAt)}</time>
        ),
    },
    {
      key: "createdAt",
      header: "Created",
      sortValue: (item) => item.createdAt,
      render: (item) => <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>,
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
          Everything the platform is working on or waiting on. Cost is what this item has spent
          so far, not an estimate.
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

      {breachedCount > 0 && (
        <Callout tone="danger" title={`${pluralise(breachedCount, "item is", "items are")} past due`}>
          <p>
            These items have passed the service level they were accepted under. They are marked
            &ldquo;Past due&rdquo; in the SLA column below.
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
          defaultSort={{ columnKey: "sla", direction: "ascending" }}
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
      {(page) => <WorkQueue items={page.items} total={page.total} />}
    </ResourceView>
  );
}
