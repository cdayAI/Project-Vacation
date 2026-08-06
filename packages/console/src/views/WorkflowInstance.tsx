import { useClient } from "../api/ClientProvider";
import type { WorkflowInstanceView } from "../api/contract";
import { useResource } from "../api/useResource";
import {
  Badge,
  Callout,
  DefinitionList,
  EmptyState,
  StepStatusPill,
  type DefinitionItem,
} from "../components";
import { NOT_RECORDED, formatDateTime, formatDurationMs, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";

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

  const summaryItems: DefinitionItem[] = [
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
      <section className="pv-panel" aria-labelledby="workflow-status">
        <h2 className="pv-panel-heading" id="workflow-status">
          Where this has got to
        </h2>
        <p className="pv-lede-text">{instance.plainLanguageStatus}</p>
      </section>

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

      <section className="pv-panel" aria-labelledby="workflow-summary">
        <h2 className="pv-panel-heading" id="workflow-summary">
          Summary
        </h2>
        <DefinitionList items={summaryItems} />
      </section>

      <section className="pv-panel" aria-labelledby="workflow-steps">
        <h2 className="pv-panel-heading" id="workflow-steps">
          What happens, in order
        </h2>

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
                <li
                  className={step.slaBreached ? "pv-step pv-step-breached" : "pv-step"}
                  key={`${index}-${step.name}`}
                >
                  <div className="pv-step-heading">
                    <span className="pv-step-seq">Step {index + 1}</span>
                    <h3>{step.name}</h3>
                    <StepStatusPill status={step.status} />
                    {step.slaBreached && (
                      <Badge tone="danger" glyph="▲">
                        Past due
                      </Badge>
                    )}
                  </div>

                  <DefinitionList
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
      </section>
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
