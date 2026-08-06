import type { EvaluationView, OperatingMode, RiskTier, RoleView, RunStatus } from "../api/contract";
import { Badge, type Tone } from "./Badge";

/**
 * The console's status vocabulary, in one place.
 *
 * Every pill carries a written label. Colour and glyph are redundant channels
 * layered on top of it, never the carrier — a run that failed says "Failed",
 * and it would still say "Failed" printed in greyscale (WCAG 1.4.1).
 */

interface Presentation {
  readonly label: string;
  readonly tone: Tone;
  readonly glyph: string;
}

const RUN_STATUS: Readonly<Record<RunStatus, Presentation>> = {
  pending: { label: "Pending", tone: "neutral", glyph: "○" },
  running: { label: "Running", tone: "info", glyph: "◐" },
  awaiting_human: { label: "Awaiting a person", tone: "warning", glyph: "▲" },
  awaiting_approval: { label: "Awaiting approval", tone: "warning", glyph: "▲" },
  succeeded: { label: "Succeeded", tone: "success", glyph: "✓" },
  failed: { label: "Failed", tone: "danger", glyph: "✕" },
  cancelled: { label: "Cancelled", tone: "neutral", glyph: "⊘" },
  // Not "danger": a refusal is the platform doing its job.
  denied: { label: "Refused", tone: "denied", glyph: "⊟" },
};

export function runStatusLabel(status: RunStatus): string {
  return RUN_STATUS[status].label;
}

export function RunStatusPill({ status }: { readonly status: RunStatus }) {
  const presentation = RUN_STATUS[status];
  return (
    <Badge tone={presentation.tone} glyph={presentation.glyph}>
      {presentation.label}
    </Badge>
  );
}

const RISK: Readonly<Record<RiskTier, Presentation>> = {
  routine: { label: "Routine", tone: "neutral", glyph: "·" },
  sensitive: { label: "Sensitive", tone: "info", glyph: "◆" },
  high_consequence: { label: "High consequence", tone: "danger", glyph: "▲" },
  prohibited: { label: "Prohibited", tone: "denied", glyph: "⊟" },
};

export function riskLabel(risk: RiskTier): string {
  return RISK[risk].label;
}

export function RiskPill({ risk }: { readonly risk: RiskTier }) {
  const presentation = RISK[risk];
  return (
    <Badge tone={presentation.tone} glyph={presentation.glyph}>
      {presentation.label} risk
    </Badge>
  );
}

const MODE: Readonly<Record<OperatingMode, string>> = {
  shadow: "Shadow",
  assisted: "Assisted",
  supervised: "Supervised",
  bounded_autonomy: "Bounded autonomy",
};

export function modeLabel(mode: OperatingMode): string {
  return MODE[mode];
}

export function ModePill({ mode }: { readonly mode: OperatingMode }) {
  return <Badge tone="neutral">{MODE[mode]}</Badge>;
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
  draft: { label: "Draft", tone: "neutral", glyph: "○" },
  proposed: { label: "Proposed", tone: "info", glyph: "◆" },
  promoted: { label: "In service", tone: "success", glyph: "✓" },
  disabled: { label: "Disabled", tone: "danger", glyph: "⊘" },
  reverted: { label: "Reverted", tone: "warning", glyph: "↩" },
};

export function roleStatusLabel(status: RoleView["status"]): string {
  return ROLE_STATUS[status].label;
}

export function RoleStatusPill({ status }: { readonly status: RoleView["status"] }) {
  const presentation = ROLE_STATUS[status];
  return (
    <Badge tone={presentation.tone} glyph={presentation.glyph}>
      {presentation.label}
    </Badge>
  );
}

/**
 * Whether an evaluation cleared the threshold set for it.
 *
 * The threshold is named in the label rather than left to a colour, because
 * "below threshold" and "below threshold by how much" are different facts and
 * only one of them is actionable.
 */
export function EvaluationPill({ evaluation }: { readonly evaluation: EvaluationView }) {
  return evaluation.meetsThreshold ? (
    <Badge tone="success" glyph="✓">
      Meets the {(evaluation.threshold * 100).toFixed(0)}% threshold
    </Badge>
  ) : (
    <Badge tone="danger" glyph="▲">
      Below the {(evaluation.threshold * 100).toFixed(0)}% threshold
    </Badge>
  );
}

/**
 * Step status arrives as a free-form string from the operating record, so this
 * maps what is known and falls back to showing the raw value rather than
 * inventing a tone for something it does not recognise.
 */
const STEP_STATUS: Readonly<Record<string, Presentation>> = {
  pending: { label: "Pending", tone: "neutral", glyph: "○" },
  running: { label: "Running", tone: "info", glyph: "◐" },
  succeeded: { label: "Succeeded", tone: "success", glyph: "✓" },
  failed: { label: "Failed", tone: "danger", glyph: "✕" },
  denied: { label: "Refused", tone: "denied", glyph: "⊟" },
  skipped: { label: "Skipped", tone: "neutral", glyph: "⊘" },
  compensated: { label: "Compensated", tone: "warning", glyph: "↩" },
};

export function StepStatusPill({ status }: { readonly status: string }) {
  const presentation = STEP_STATUS[status];
  if (presentation === undefined) {
    return <Badge tone="neutral">{status}</Badge>;
  }
  return (
    <Badge tone={presentation.tone} glyph={presentation.glyph}>
      {presentation.label}
    </Badge>
  );
}
