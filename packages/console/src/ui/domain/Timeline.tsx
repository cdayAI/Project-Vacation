import { useId, useState, type ReactNode } from "react";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { IconChevronDown } from "../primitives/icons";
import { SurfaceState } from "../surfaces/SurfaceState";
import { MarkAction, MarkHuman, MarkModel, MarkRetrieval, MarkWait } from "./marks";
import { ProvenanceMark, type ProvenanceKind } from "./ProvenanceMark";
import "./Timeline.css";

/**
 * The spine of a run: what happened, in order, with what it cost.
 *
 * Spec §3.3 makes this the body of the case detail screen, and the reason it is
 * a timeline rather than a log is that an operator reading it is answering one
 * question — *where did this go wrong, or where is it waiting* — and a log
 * makes them read every line to find out.
 *
 * The decisions worth defending:
 *
 * **Each step says what it cost and how long it took, at rest.** Cost and
 * duration are the two numbers that make an autonomous system's behaviour
 * arguable rather than mysterious, and burying them one expansion deep means
 * nobody ever sees them. They are tabular so the column reads down.
 *
 * **A model step shows its provenance without being expanded.** Retrieved,
 * asserted, computed — spec §3.3 — because the difference between "the statute
 * says" and "the model concluded" is the whole basis on which an approver
 * trusts the step, and it must not be one click away.
 *
 * **A failed step shows what followed it.** A failure with no retry and no
 * escalation beside it makes an operator go and find out whether anything
 * happened, which is the exact work this screen exists to remove.
 *
 * **Expansion is per step and remembers nothing.** No accordion behaviour: an
 * operator comparing the inputs of step 3 with the outputs of step 7 needs both
 * open, and a component that closes one to open the other is fighting them.
 */

export type TimelineStepKind = "retrieval" | "model" | "action" | "human" | "wait";

export type TimelineStepState = "done" | "running" | "failed" | "parked" | "skipped";

const KIND_MARKS = {
  retrieval: MarkRetrieval,
  model: MarkModel,
  action: MarkAction,
  human: MarkHuman,
  wait: MarkWait,
} as const;

/** The kind in words, for assistive technology and for a monochrome printout. */
const KIND_WORDS: Readonly<Record<TimelineStepKind, string>> = {
  retrieval: "Retrieval",
  model: "Model",
  action: "Action",
  human: "Human",
  wait: "Wait",
};

const STATE_LABELS: Readonly<Record<TimelineStepState, string>> = {
  done: "Done",
  running: "Running",
  failed: "Failed",
  parked: "Parked",
  skipped: "Skipped",
};

const STATE_TONES = {
  done: "success",
  running: "info",
  failed: "danger",
  parked: "warning",
  skipped: "neutral",
} as const;

export interface TimelineCitation {
  readonly id: string;
  /** "FL §721.10 (rev 2025-07-01)". */
  readonly source: string;
  readonly kind: ProvenanceKind;
}

export interface TimelineStep {
  readonly id: string;
  readonly kind: TimelineStepKind;
  /** What happened, as a verb phrase. "Determined rescission window". */
  readonly title: string;
  /** When, already formatted. "09:41:02". */
  readonly time: string;
  /** How long, already formatted. "1.4s", "120ms". */
  readonly duration?: string;
  /** What it cost, already formatted. "$0.011". */
  readonly cost?: string;
  readonly state?: TimelineStepState;
  /** The second line: "3 documents · 2 cited". */
  readonly detail?: ReactNode;
  /** Who did it. Human steps owe their reader a name. */
  readonly actor?: string;
  /** Sources this step relied on, with their provenance. */
  readonly citations?: readonly TimelineCitation[];
  /** Inputs and outputs. Revealed by the step's own disclosure. */
  readonly details?: ReactNode;
  /** What failed, and the retry or escalation that followed. */
  readonly failure?: { readonly what: string; readonly then: string };
}

export interface TimelineProps {
  /** Names the list. "Run 41823 steps", not "Timeline". */
  readonly label: string;
  readonly steps: readonly TimelineStep[];
  /**
   * Offers "Correct this" on model steps. The correction is captured as
   * improvement signal (spec §3.3), so a screen that cannot accept one should
   * leave this out rather than render a control that does nothing.
   */
  readonly onCorrect?: (stepId: string) => void;
  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  /** Drops the correction control and keeps everything else. */
  readonly readOnly?: boolean;
  readonly className?: string;
}

export function Timeline({
  label,
  steps,
  onCorrect,
  loading = false,
  error,
  empty,
  readOnly = false,
  className,
}: TimelineProps) {
  return (
    <div className={className === undefined ? "pv-timeline" : `pv-timeline ${className}`}>
      <SurfaceState
        loading={loading}
        error={error}
        empty={empty ?? "No steps have run yet."}
        skeletonLines={4}
      >
        {steps.length === 0 ? null : (
          <ol className="pv-timeline-list" aria-label={label}>
            {steps.map((step) => (
              <TimelineRow
                key={step.id}
                step={step}
                onCorrect={onCorrect}
                readOnly={readOnly}
              />
            ))}
          </ol>
        )}
      </SurfaceState>
    </div>
  );
}

function TimelineRow({
  step,
  onCorrect,
  readOnly,
}: {
  readonly step: TimelineStep;
  readonly onCorrect?: (stepId: string) => void;
  readonly readOnly: boolean;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);

  const state = step.state ?? "done";
  const Glyph = KIND_MARKS[step.kind];
  const hasDetails = step.details !== undefined && step.details !== null;
  const canCorrect = !readOnly && step.kind === "model" && onCorrect !== undefined;

  return (
    <li className="pv-timeline-step" data-kind={step.kind} data-state={state}>
      {/* The rail and the marker. Decorative: the kind is in words in the
          step's own heading line, where a screen reader will actually meet it. */}
      <div className="pv-timeline-rail" aria-hidden="true">
        <span className="pv-timeline-marker">
          <Glyph size="sm" />
        </span>
        <span className="pv-timeline-line" />
      </div>

      <div className="pv-timeline-content">
        <p className="pv-timeline-headline">
          <time className="pv-timeline-time" data-numeric>
            {step.time}
          </time>
          <span className="pv-timeline-title">{step.title}</span>
          <span className="pv-sr-only">{KIND_WORDS[step.kind]} step.</span>
          {state === "done" ? null : (
            <Badge tone={STATE_TONES[state]} size="sm">
              {STATE_LABELS[state]}
            </Badge>
          )}
        </p>

        <p className="pv-timeline-meta">
          {step.duration === undefined ? null : (
            <span className="pv-timeline-measure" data-numeric>
              <span className="pv-sr-only">Took </span>
              {step.duration}
            </span>
          )}
          {step.cost === undefined ? null : (
            <span className="pv-timeline-measure" data-numeric>
              <span className="pv-sr-only">Cost </span>
              {step.cost}
            </span>
          )}
          {step.actor === undefined ? null : (
            <span className="pv-timeline-actor">{step.actor}</span>
          )}
        </p>

        {step.detail === undefined ? null : (
          <p className="pv-timeline-detail">{step.detail}</p>
        )}

        {step.citations === undefined || step.citations.length === 0 ? null : (
          <ul className="pv-timeline-citations">
            {step.citations.map((citation) => (
              <li key={citation.id} className="pv-timeline-citation">
                <span className="pv-timeline-citation-source">{citation.source}</span>
                <ProvenanceMark kind={citation.kind} />
              </li>
            ))}
          </ul>
        )}

        {step.failure === undefined ? null : (
          // Not a Callout: a failed step is already inside a bounded row, and a
          // bordered block inside a bordered block is noise. What matters is
          // that "then" is never missing — a failure with no consequence
          // written beside it sends the operator hunting.
          <p className="pv-timeline-failure">
            <span className="pv-timeline-failure-what">{step.failure.what}</span>{" "}
            <span className="pv-timeline-failure-then">{step.failure.then}</span>
          </p>
        )}

        {hasDetails || canCorrect ? (
          <p className="pv-timeline-actions">
            {hasDetails ? (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={() => setExpanded((open) => !open)}
              >
                <IconChevronDown size="sm" className={expanded ? "pv-timeline-chevron-open" : undefined} />
                {expanded ? "Hide" : "Show"} inputs and outputs
                {/* The button's name has to distinguish it from the eleven
                    others on the page, and "Show" repeated eleven times is a
                    screen-reader user's list of identical links. */}
                <span className="pv-sr-only"> for {step.title}</span>
              </Button>
            ) : null}
            {canCorrect ? (
              <Button size="sm" variant="secondary" onClick={() => onCorrect?.(step.id)}>
                Correct this
                <span className="pv-sr-only"> step: {step.title}</span>
              </Button>
            ) : null}
          </p>
        ) : null}

        {hasDetails ? (
          <div className="pv-timeline-details" id={detailsId} hidden={!expanded}>
            {step.details}
          </div>
        ) : null}
      </div>
    </li>
  );
}
