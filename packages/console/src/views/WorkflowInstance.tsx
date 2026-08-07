import type { ReactNode } from "react";
import { useClient } from "../api/ClientProvider";
import type { WorkflowInstanceView } from "../api/contract";
import { useResource } from "../api/useResource";
import { NOT_RECORDED, formatDateTime, formatDurationMs, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import type { StatusTone } from "../theme/tokens";
import { Badge, Callout, EmptyState, IconCircle, IconDash, MarkUndo, Panel } from "../ui";

/**
 * One workflow instance, written for a supervisor.
 *
 * The reader of this screen manages people, not software. They arrive with
 * four questions — where has this got to, why has it stopped, what is it
 * waiting for, and what has it cost — and they should not need an engineer to
 * answer any of them.
 *
 * So `plainLanguageStatus` leads, in full, above everything else. The platform
 * composes that sentence when it records the instance precisely so that this
 * screen does not have to reconstruct it from state names, and reconstructing
 * it here would produce a second, worse version that drifts from the first.
 *
 * Engine vocabulary is kept out of the visible text. Step kinds arrive as
 * dotted identifiers — `model.infer`, `approval.request` — and are shown
 * through STEP_KIND below. An unrecognised kind falls back to the raw value
 * rather than to a guess: a supervisor reading "integration.write" learns
 * little, but a supervisor reading a confident mistranslation is worse off.
 */

const STEP_KIND: Readonly<Record<string, string>> = {
  "approval.request": "Waits for a person to approve",
  "contact.send": "Sends something to an owner",
  "document.generate": "Produces a document",
  "guard.screen": "Safety check on untrusted input",
  "human.task": "A person does the work",
  "integration.read": "Reads a system of record",
  "integration.write": "Writes to a system of record",
  "knowledge.retrieve": "Looks up a governed document",
  "model.infer": "The model does the work",
  "timeline.compute": "Works out a statutory deadline",
};

function stepKindLabel(kind: string): string {
  return STEP_KIND[kind] ?? kind;
}

/**
 * Step status, in words.
 *
 * The label is the carrier; the tone and the mark are redundant channels laid
 * on top of it, so a step that failed still says "Failed" printed in greyscale
 * (WCAG 1.4.1). `denied` is its own tone rather than a shade of `danger` — a
 * step the platform refused to take is governance working.
 *
 * A mark is named only where the tone's default would collapse two statuses
 * onto one shape: `Badge` keys its default mark by tone, so pending and skipped
 * would otherwise be the same dot.
 *
 * Status arrives as a free-form string from the operating record, so an
 * unrecognised value is shown raw in a neutral badge rather than being given a
 * tone the platform never claimed for it.
 */
interface Presentation {
  readonly label: string;
  readonly tone: StatusTone;
  readonly icon?: ReactNode;
}

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

/**
 * Elapsed time between two instants, or from a start that has not ended.
 *
 * Returns undefined rather than a zero when there is nothing to measure, so
 * the caller can say "still running" instead of "0 ms".
 */
function elapsedMs(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return end - start;
}

export interface WorkflowInstanceProps {
  readonly instance: WorkflowInstanceView;
}

export function WorkflowInstance({ instance }: WorkflowInstanceProps) {
  const breachedSteps = instance.steps.filter((step) => step.slaBreached);
  const doneCount = instance.steps.filter((step) => step.status === "succeeded").length;
  const isFinished = instance.endedAt !== undefined;

  const summaryItems: Fact[] = [
    { term: "Process", description: instance.definitionName },
    {
      term: "Process version",
      description: `Version ${instance.definitionVersion} — the version of this process that was in force when the work started`,
    },
    { term: "Reference", description: <span className="pv-mono">{instance.instanceId}</span> },
    {
      term: "Started",
      description: <time dateTime={instance.startedAt}>{formatDateTime(instance.startedAt)}</time>,
    },
    {
      term: "Finished",
      description:
        instance.endedAt === undefined ? (
          <span className="pv-meta">Not finished — this is still in progress</span>
        ) : (
          <time dateTime={instance.endedAt}>{formatDateTime(instance.endedAt)}</time>
        ),
    },
    {
      term: "Where it has got to",
      description:
        instance.currentStepName === undefined ? (
          <span className="pv-meta">
            {isFinished ? "Nothing outstanding" : "No step has started yet"}
          </span>
        ) : (
          instance.currentStepName
        ),
    },
    {
      term: "What it is waiting for",
      description:
        instance.waitingOn === undefined ? (
          <span className="pv-meta">Nothing — it is not blocked on anyone or anything</span>
        ) : (
          instance.waitingOn
        ),
    },
    {
      term: "Spent so far",
      description: (
        <>
          {formatUsd(instance.totalCostUsd)}{" "}
          <span className="pv-meta">
            — what this piece of work has actually cost, not a forecast
          </span>
        </>
      ),
    },
    {
      term: "Progress",
      description: `${doneCount} of ${pluralise(instance.steps.length, "step", "steps")} finished`,
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <p className="pv-meta">
          <Link to="/work">Work queue</Link>
        </p>
        <h1>{instance.definitionName}</h1>
        <p className="pv-page-lede pv-mono">{instance.instanceId}</p>
      </div>

      {/* The one thing a supervisor came for, before anything they have to
          interpret. */}
      <Panel title="Where this has got to">
        <p className="pv-lede-text">{instance.plainLanguageStatus}</p>
      </Panel>

      {instance.waitingOn !== undefined && (
        <Callout tone="warning" title="This is waiting for something">
          <p>{instance.waitingOn}</p>
          <p className="pv-meta">
            It will not move on by itself. Whatever is named above has to happen first.
          </p>
        </Callout>
      )}

      {breachedSteps.length > 0 && (
        <Callout
          tone="danger"
          title={`${pluralise(breachedSteps.length, "step has", "steps have")} passed the time they were meant to take`}
        >
          <p>
            {breachedSteps.map((step) => step.name).join(", ")}. A step past its time is marked
            &ldquo;Past due&rdquo; in the list below.
          </p>
        </Callout>
      )}

      <Panel title="Summary">
        <FactList items={summaryItems} />
      </Panel>

      <Panel title="What happens, in order">
        {instance.steps.length === 0 ? (
          <EmptyState
            title="No steps yet"
            body="This piece of work has not started its first step. Steps appear here as they begin."
          />
        ) : (
          <ol className="pv-steps">
            {instance.steps.map((step, index) => {
              const duration = elapsedMs(step.startedAt, step.endedAt);
              return (
                <li className="pv-step" key={`${index}-${step.name}`}>
                  <div className="pv-step-heading">
                    <span className="pv-step-seq">Step {index + 1}</span>
                    <h3>{step.name}</h3>
                    <StepStatusBadge status={step.status} />
                    {/* The breach is said in words and drawn in the danger tone
                        on the step itself, so a supervisor scanning a long
                        sequence has a second channel that survives greyscale
                        and a supervisor reading it has a first one. */}
                    {step.slaBreached && <Badge tone="danger">Past due</Badge>}
                  </div>

                  <FactList
                    items={[
                      { term: "What this step does", description: stepKindLabel(step.kind) },
                      {
                        term: "Started",
                        description:
                          step.startedAt === undefined ? (
                            <span className="pv-meta">Not started</span>
                          ) : (
                            <time dateTime={step.startedAt}>{formatDateTime(step.startedAt)}</time>
                          ),
                      },
                      {
                        term: "Finished",
                        description:
                          step.endedAt === undefined ? (
                            <span className="pv-meta">
                              {step.startedAt === undefined ? "Not started" : "Still in progress"}
                            </span>
                          ) : (
                            <time dateTime={step.endedAt}>{formatDateTime(step.endedAt)}</time>
                          ),
                      },
                      {
                        term: "Took",
                        description:
                          duration === undefined ? (
                            <span className="pv-meta">{NOT_RECORDED}</span>
                          ) : (
                            formatDurationMs(duration)
                          ),
                      },
                      {
                        term: "Meant to be done by",
                        description:
                          step.dueAt === undefined ? (
                            <span className="pv-meta">No time limit set for this step</span>
                          ) : (
                            <time dateTime={step.dueAt}>{formatDateTime(step.dueAt)}</time>
                          ),
                      },
                    ]}
                  />
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
    </div>
  );
}

/** Route-level container. */
export function WorkflowInstanceRoute({ instanceId }: { readonly instanceId: string }) {
  const client = useClient();
  const resource = useResource(
    (signal) => client.workflowInstance(instanceId, { signal }),
    [client, instanceId],
  );

  return (
    <ResourceView resource={resource} attempted="this piece of work">
      {(instance) => <WorkflowInstance instance={instance} />}
    </ResourceView>
  );
}
