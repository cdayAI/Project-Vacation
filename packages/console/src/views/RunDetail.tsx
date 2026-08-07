import { useState, type ReactNode } from "react";
import { useClient } from "../api/ClientProvider";
import type { CitationView, OperatingMode, RunDetailView, RunStatus, StepView } from "../api/contract";
import { useResource } from "../api/useResource";
import { NOT_RECORDED, formatDate, formatDateTime, formatDurationMs, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import type { StatusTone } from "../theme/tokens";
import {
  Badge,
  Callout,
  EmptyState,
  IconCircle,
  IconDash,
  MarkHuman,
  MarkUndo,
  MarkWait,
  Panel,
  Table,
  type TableColumn,
  type TableSort,
} from "../ui";

/**
 * The run record.
 *
 * A reviewer or an auditor arrives here asking one of three questions: what
 * did this run actually do, what did it cost, and what was it relying on when
 * it decided. The view answers them in that order and does not editorialise.
 *
 * Two things are shown here that a prettier screen would hide. Input and
 * output digests are rendered in full, because they are how a step's inputs
 * are tied to the audit chain without putting payloads in it (architecture
 * §4.2). And a refused step is shown with its reason in plain language, in the
 * denial tone rather than the failure tone — a refusal is not an error, and a
 * run that was stopped by a control did not malfunction.
 */

// ---------------------------------------------------------------------------
// The status vocabulary this screen speaks
// ---------------------------------------------------------------------------

/**
 * Statuses, in words.
 *
 * The label is the carrier; the tone and the mark are redundant channels laid
 * on top of it, so a run that failed still says "Failed" printed in greyscale
 * (WCAG 1.4.1).
 *
 * A mark is named here only where the tone's own default would collapse two
 * different statuses onto one shape. `Badge` keys its default mark by tone, so
 * the two neutral statuses and the two warning statuses would otherwise be
 * indistinguishable to anyone scanning the marks rather than reading them.
 */
interface Presentation {
  readonly label: string;
  readonly tone: StatusTone;
  readonly icon?: ReactNode;
}

const RUN_STATUS: Readonly<Record<RunStatus, Presentation>> = {
  pending: { label: "Pending", tone: "neutral", icon: <IconCircle size="sm" /> },
  running: { label: "Running", tone: "info" },
  awaiting_human: { label: "Awaiting a person", tone: "warning", icon: <MarkHuman size="sm" /> },
  awaiting_approval: { label: "Awaiting approval", tone: "warning", icon: <MarkWait size="sm" /> },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral", icon: <IconDash size="sm" /> },
  // Not "danger": a refusal is the platform doing its job.
  denied: { label: "Refused", tone: "denied" },
};

function RunStatusBadge({ status }: { readonly status: RunStatus }) {
  const presentation = RUN_STATUS[status];
  return (
    <Badge tone={presentation.tone} icon={presentation.icon}>
      {presentation.label}
    </Badge>
  );
}

const MODE: Readonly<Record<OperatingMode, string>> = {
  shadow: "Shadow",
  assisted: "Assisted",
  supervised: "Supervised",
  bounded_autonomy: "Bounded autonomy",
};

/**
 * Step status arrives as a free-form string from the operating record, so this
 * maps what is known and falls back to showing the raw value rather than
 * inventing a tone for something it does not recognise.
 */
const STEP_STATUS: Readonly<Record<string, Presentation>> = {
  pending: { label: "Pending", tone: "neutral", icon: <IconCircle size="sm" /> },
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  denied: { label: "Refused", tone: "denied" },
  skipped: { label: "Skipped", tone: "neutral", icon: <IconDash size="sm" /> },
  compensated: { label: "Compensated", tone: "warning", icon: <MarkUndo size="sm" /> },
};

function StepStatusBadge({ status }: { readonly status: string }) {
  const presentation = STEP_STATUS[status];
  if (presentation === undefined) return <Badge tone="neutral">{status}</Badge>;
  return (
    <Badge tone={presentation.tone} icon={presentation.icon}>
      {presentation.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------

interface Fact {
  readonly term: string;
  readonly description: ReactNode;
}

/**
 * A real `<dl>`, with each pair wrapped in a `<div>` so the grid can lay it out
 * without breaking the term/description association. Screen readers announce
 * "definition list, N items" and pair each term with its description, which a
 * two-column grid of divs does not.
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

/** Largest line first. A breakdown is read to find where the money went. */
const COST_SORT: TableSort = { columnKey: "amount", direction: "descending" };

/**
 * Order the rows the table has been told it is showing.
 *
 * The table sorts for itself only while it owns the sort state, and it starts
 * that state at "unsorted" — which would open this breakdown in whatever order
 * the record happened to serialise while `aria-sort` said, correctly, that
 * nothing was sorted. Holding the state here is what lets the screen open on
 * the cost column *and* admit that it has. The comparison matches the table's
 * own: numbers numerically, everything else with a numeric, case-insensitive
 * collation, ties broken by original position so the order is stable.
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

export interface RunDetailProps {
  readonly run: RunDetailView;
}

export function RunDetail({ run }: RunDetailProps) {
  const costEntries = Object.entries(run.costByCategory);
  const staleCitations = run.citations.filter((citation) => citation.stale).length;

  const [costSort, setCostSort] = useState<TableSort | null>(COST_SORT);

  const summaryItems: Fact[] = [
    { term: "Run", description: <span className="pv-mono">{run.runId}</span> },
    { term: "Kind", description: <span className="pv-mono">{run.kind}</span> },
    { term: "Status", description: <RunStatusBadge status={run.status} /> },
    { term: "Operating mode", description: <Badge tone="neutral">{MODE[run.mode]}</Badge> },
    {
      term: "Requested by",
      description: `${run.requestedBy.displayName} (${run.requestedBy.roles.join(", ")})`,
    },
    {
      term: "Created",
      description: <time dateTime={run.createdAt}>{formatDateTime(run.createdAt)}</time>,
    },
    {
      term: "Started",
      description:
        run.startedAt === undefined ? (
          <span className="pv-meta">{NOT_RECORDED}</span>
        ) : (
          <time dateTime={run.startedAt}>{formatDateTime(run.startedAt)}</time>
        ),
    },
    {
      term: "Ended",
      description:
        run.endedAt === undefined ? (
          <span className="pv-meta">Still open</span>
        ) : (
          <time dateTime={run.endedAt}>{formatDateTime(run.endedAt)}</time>
        ),
    },
    {
      term: "Agent role",
      description:
        run.roleId === undefined ? (
          <span className="pv-meta">No agent role</span>
        ) : (
          <span className="pv-mono">
            {run.roleId}
            {run.roleVersion === undefined ? "" : ` v${run.roleVersion}`}
          </span>
        ),
    },
    {
      term: "Workflow instance",
      description:
        run.workflowInstanceId === undefined ? (
          <span className="pv-meta">Not part of a workflow</span>
        ) : (
          // Linked so a reviewer can go from one run to the piece of work it
          // belongs to, which is where the plain-language status lives.
          <Link to={`/workflows/${run.workflowInstanceId}`}>
            <span className="pv-mono">{run.workflowInstanceId}</span>
          </Link>
        ),
    },
  ];

  const costColumns: readonly TableColumn<[string, number]>[] = [
    {
      key: "category",
      header: "Category",
      rowHeader: true,
      width: 280,
      sortValue: (entry) => entry[0],
      cell: (entry) => <span className="pv-mono">{entry[0]}</span>,
    },
    {
      key: "amount",
      header: "Cost",
      numeric: true,
      width: 160,
      sortValue: (entry) => entry[1],
      cell: (entry) => <span>{formatUsd(entry[1])}</span>,
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <p className="pv-meta">
          <Link to="/work">Work queue</Link>
        </p>
        <h1>{run.title}</h1>
        <p className="pv-page-lede pv-mono">{run.runId}</p>
      </div>

      {run.denialReason !== undefined && (
        <Callout tone="denied" title="This run was refused">
          <p>{run.denialReason}</p>
          <p className="pv-meta">
            A refusal means the effect did not happen. This is the platform working as designed,
            not a fault to be cleared.
          </p>
        </Callout>
      )}

      {run.outcome !== undefined && run.denialReason === undefined && (
        <Callout tone="info" title="Outcome">
          <p>{run.outcome}</p>
        </Callout>
      )}

      <Panel title="Summary">
        <FactList items={summaryItems} />
      </Panel>

      {/* ---------------------------------------------------------------
          Cost
          --------------------------------------------------------------- */}
      <Panel title="Cost">
        <p>
          Total spend on this run: <strong>{formatUsd(run.totalCostUsd)}</strong> across{" "}
          {pluralise(run.steps.length, "step", "steps")}.
        </p>
        {costEntries.length === 0 ? (
          <p className="pv-meta">No cost has been attributed to a category on this run.</p>
        ) : (
          <Table
            caption="Cost by category."
            tableId="run-cost-by-category"
            columns={costColumns}
            rows={orderBy(costEntries, costColumns, costSort)}
            rowKey={(entry) => entry[0]}
            rowNoun="categories"
            sort={costSort}
            onSortChange={setCostSort}
          />
        )}
      </Panel>

      {/* ---------------------------------------------------------------
          Step trail
          --------------------------------------------------------------- */}
      <Panel title="Step trail">
        {run.steps.length === 0 ? (
          <EmptyState
            title="No steps recorded"
            body="This run has not executed a step yet. Steps appear here as they are appended to the operating record."
          />
        ) : (
          <ol className="pv-steps">
            {run.steps.map((step) => (
              <StepEntry key={step.stepId} step={step} />
            ))}
          </ol>
        )}
      </Panel>

      {/* ---------------------------------------------------------------
          Citations
          --------------------------------------------------------------- */}
      <Panel title="Citations">
        {staleCitations > 0 && (
          <div className="pv-space-below">
            <Callout
              tone="warning"
              title={`${pluralise(staleCitations, "citation is", "citations are")} past review`}
            >
              <p>
                The source behind these citations is past its review cadence. It may still be
                correct — nobody has confirmed that recently. Treat anything relying on it as
                unverified until a knowledge owner reviews and re-dates it.
              </p>
            </Callout>
          </div>
        )}

        {run.citations.length === 0 ? (
          <p className="pv-meta">
            This run cited no source. That is expected for a run that consulted no governed
            document, and worth questioning for one that reached a conclusion about a rule.
          </p>
        ) : (
          <ul className="pv-steps">
            {run.citations.map((citation) => (
              <CitationEntry key={citation.chunkId} citation={citation} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function StepEntry({ step }: { readonly step: StepView }) {
  const wasRefused = step.denialReason !== undefined;

  const items: Fact[] = [
    { term: "Duration", description: formatDurationMs(step.durationMs) },
    { term: "Cost", description: formatUsd(step.costUsd) },
    {
      term: "Attempt",
      description:
        step.attempt === 1 ? "1 (first attempt)" : `${step.attempt} (retried ${step.attempt - 1}×)`,
    },
    {
      term: "Started",
      description: <time dateTime={step.startedAt}>{formatDateTime(step.startedAt)}</time>,
    },
    {
      term: "Ended",
      description:
        step.endedAt === undefined ? (
          <span className="pv-meta">Still running</span>
        ) : (
          <time dateTime={step.endedAt}>{formatDateTime(step.endedAt)}</time>
        ),
    },
    {
      term: "Input digest",
      description:
        step.inputDigest === undefined ? (
          <span className="pv-meta">{NOT_RECORDED}</span>
        ) : (
          // A plain span with nothing inside it. A digest split across elements,
          // or sharing one with a decorative mark, is a digest that cannot be
          // copied out and compared against the audit chain.
          <span className="pv-digest">{step.inputDigest}</span>
        ),
    },
    {
      term: "Output digest",
      description:
        step.outputDigest === undefined ? (
          <span className="pv-meta">{NOT_RECORDED}</span>
        ) : (
          <span className="pv-digest">{step.outputDigest}</span>
        ),
    },
  ];

  for (const [key, value] of Object.entries(step.detail)) {
    items.push({ term: key, description: <span className="pv-mono">{String(value)}</span> });
  }

  return (
    <li className="pv-step">
      <div className="pv-step-heading">
        <span className="pv-step-seq">Step {step.seq}</span>
        <h3>{step.name}</h3>
        <StepStatusBadge status={step.status} />
        <Badge tone="neutral">{step.kind}</Badge>
      </div>

      {wasRefused && (
        <Callout tone="denied" title="This step was refused">
          <p>{step.denialReason}</p>
        </Callout>
      )}

      {step.error !== undefined && !wasRefused && (
        <Callout tone="danger" title="This step failed">
          <p>{step.error}</p>
        </Callout>
      )}

      <FactList items={items} />
    </li>
  );
}

function CitationEntry({ citation }: { readonly citation: CitationView }) {
  return (
    <li className={citation.stale ? "pv-citation pv-citation-stale" : "pv-citation"}>
      <div className="pv-step-heading">
        <h3>{citation.documentTitle}</h3>
        <Badge tone="neutral">Version {citation.documentVersion}</Badge>
        {citation.stale && <Badge tone="warning">Past review date</Badge>}
      </div>

      <FactList
        items={[
          {
            term: "In effect from",
            description: (
              <time dateTime={citation.effectiveFrom}>{formatDate(citation.effectiveFrom)}</time>
            ),
          },
          {
            term: "In effect until",
            description:
              citation.effectiveTo === undefined ? (
                <span className="pv-meta">Still in effect</span>
              ) : (
                <time dateTime={citation.effectiveTo}>{formatDate(citation.effectiveTo)}</time>
              ),
          },
          {
            term: "Jurisdiction",
            description:
              citation.jurisdiction === undefined ? (
                <span className="pv-meta">Not jurisdiction-specific</span>
              ) : (
                citation.jurisdiction
              ),
          },
          { term: "Passage", description: <span className="pv-mono">{citation.chunkId}</span> },
        ]}
      />

      <blockquote className="pv-excerpt">{citation.excerpt}</blockquote>

      {citation.sourceUri !== undefined && (
        <p>
          <a href={citation.sourceUri}>
            Open the source document
            <span className="pv-sr-only"> for {citation.documentTitle}</span>
          </a>
        </p>
      )}
    </li>
  );
}

/** Route-level container. */
export function RunDetailRoute({ runId }: { readonly runId: string }) {
  const client = useClient();
  const resource = useResource((signal) => client.run(runId, { signal }), [client, runId]);

  return (
    <ResourceView resource={resource} attempted="this run">
      {(run) => <RunDetail run={run} />}
    </ResourceView>
  );
}
