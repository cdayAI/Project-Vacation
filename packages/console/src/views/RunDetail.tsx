import { useClient } from "../api/ClientProvider";
import type { CitationView, RunDetailView, StepView } from "../api/contract";
import { useResource } from "../api/useResource";
import {
  Badge,
  Callout,
  DataTable,
  DefinitionList,
  EmptyState,
  ModePill,
  RunStatusPill,
  StepStatusPill,
  type Column,
  type DefinitionItem,
} from "../components";
import { NOT_RECORDED, formatDate, formatDateTime, formatDurationMs, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";

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

export interface RunDetailProps {
  readonly run: RunDetailView;
}

export function RunDetail({ run }: RunDetailProps) {
  const costEntries = Object.entries(run.costByCategory);
  const staleCitations = run.citations.filter((citation) => citation.stale).length;

  const summaryItems: DefinitionItem[] = [
    { term: "Run", description: <span className="pv-mono">{run.runId}</span> },
    { term: "Kind", description: <span className="pv-mono">{run.kind}</span> },
    { term: "Status", description: <RunStatusPill status={run.status} /> },
    { term: "Operating mode", description: <ModePill mode={run.mode} /> },
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
          <span className="pv-mono">{run.workflowInstanceId}</span>
        ),
    },
  ];

  const costColumns: readonly Column<[string, number]>[] = [
    {
      key: "category",
      header: "Category",
      rowHeader: true,
      sortValue: (entry) => entry[0],
      render: (entry) => <span className="pv-mono">{entry[0]}</span>,
    },
    {
      key: "amount",
      header: "Cost",
      numeric: true,
      sortValue: (entry) => entry[1],
      render: (entry) => <span>{formatUsd(entry[1])}</span>,
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

      <section className="pv-panel" aria-labelledby="run-summary">
        <h2 className="pv-panel-heading" id="run-summary">
          Summary
        </h2>
        <DefinitionList items={summaryItems} />
      </section>

      {/* ---------------------------------------------------------------
          Cost
          --------------------------------------------------------------- */}
      <section className="pv-panel" aria-labelledby="run-cost">
        <h2 className="pv-panel-heading" id="run-cost">
          Cost
        </h2>
        <p>
          Total spend on this run: <strong>{formatUsd(run.totalCostUsd)}</strong> across{" "}
          {pluralise(run.steps.length, "step", "steps")}.
        </p>
        {costEntries.length === 0 ? (
          <p className="pv-meta">No cost has been attributed to a category on this run.</p>
        ) : (
          <DataTable
            caption="Cost by category."
            columns={costColumns}
            rows={costEntries}
            rowKey={(entry) => entry[0]}
            defaultSort={{ columnKey: "amount", direction: "descending" }}
          />
        )}
      </section>

      {/* ---------------------------------------------------------------
          Step trail
          --------------------------------------------------------------- */}
      <section className="pv-panel" aria-labelledby="run-steps">
        <h2 className="pv-panel-heading" id="run-steps">
          Step trail
        </h2>
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
      </section>

      {/* ---------------------------------------------------------------
          Citations
          --------------------------------------------------------------- */}
      <section className="pv-panel" aria-labelledby="run-citations">
        <h2 className="pv-panel-heading" id="run-citations">
          Citations
        </h2>

        {staleCitations > 0 && (
          <div style={{ marginBottom: "var(--pv-space-4)" }}>
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
      </section>
    </div>
  );
}

function StepEntry({ step }: { readonly step: StepView }) {
  const wasRefused = step.denialReason !== undefined;

  const items: DefinitionItem[] = [
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
        <StepStatusPill status={step.status} />
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

      <DefinitionList items={items} />
    </li>
  );
}

function CitationEntry({ citation }: { readonly citation: CitationView }) {
  return (
    <li className={citation.stale ? "pv-citation pv-citation-stale" : "pv-citation"}>
      <div className="pv-step-heading">
        <h3>{citation.documentTitle}</h3>
        <Badge tone="neutral">Version {citation.documentVersion}</Badge>
        {citation.stale && (
          <Badge tone="warning" glyph="▲">
            Past review date
          </Badge>
        )}
      </div>

      <DefinitionList
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
