import { useId, type ReactNode } from "react";
import { ReadOnlyChip } from "../surfaces/ReadOnlyChip";
import { SurfaceState } from "../surfaces/SurfaceState";
import { MarkTrendDown, MarkTrendFlat, MarkTrendUp } from "./marks";
import { Sparkline } from "./Sparkline";
import "./MetricTile.css";

/**
 * One number, and what it is doing.
 *
 * **The comparison is a required prop, and that is the entire point of this
 * component.** Spec §3.5: a tile without a comparison is not shipped. A number
 * with nothing beside it is decoration — "1,240 cases" tells an executive
 * nothing they can act on, and the meeting it is shown in ends with somebody
 * asking whether that is good. Making `comparison` optional would mean it gets
 * omitted under deadline on the one dashboard that matters most, so the type
 * refuses the tile instead.
 *
 * The same argument gives us `denominator`. "94.2% first-pass" is a claim;
 * "94.2% first-pass — of 1,240 cases" is a measurement.
 *
 * **The direction of good is declared, not assumed.** Cost per case falling is
 * a success and a rising handle time is not, and a component that paints every
 * upward arrow green will eventually congratulate an operator on a number
 * getting worse.
 *
 * It draws its own frame rather than composing `Card`, because a card fixes its
 * title at the `title` step: on a metric tile the label is the small text and
 * the *value* is the largest thing in the box, and inverting that hierarchy is
 * the difference between a tile you can read across a room and one you cannot.
 * It is deliberately not a link either — a tile that navigates is a decision
 * for the dashboard, which can wrap it.
 */

export interface MetricComparison {
  /** The basis, always shown. "vs. prior 30 days", "vs. same month last year". */
  readonly basis: string;
  /** Signed percentage change. 4.2 renders as +4.2%, −1.5 as −1.5%. */
  readonly changePercent: number;
  /**
   * Which way is good. `down-is-good` for cost, handle time, escalation rate.
   * `neutral` where the direction carries no judgement.
   */
  readonly direction?: "up-is-good" | "down-is-good" | "neutral";
  /** The prior value itself, where knowing it saves the operator arithmetic. */
  readonly priorValue?: string;
}

export interface MetricTileProps {
  /** What the number is. Use the name management uses, not the internal one. */
  readonly label: string;
  /** Pre-formatted: currency, percentage, and locale are the caller's decision. */
  readonly value: string;
  /** The denominator. "of 1,240 cases". Spec §3.5 asks for it every time. */
  readonly denominator?: ReactNode;
  /** Required. A tile without a comparison is not shipped. */
  readonly comparison: MetricComparison;
  /** Oldest first. Drawn as a sparkline under the value. */
  readonly history?: readonly number[];
  /** What the sparkline covers. "Weekly, last 12 weeks." */
  readonly historyLabel?: string;
  /** Document structure, not size. */
  readonly headingLevel?: 2 | 3 | 4;

  readonly loading?: boolean;
  readonly error?: ReactNode;
  /** Says once that this surface cannot be changed. Auditors live in this state. */
  readonly readOnly?: boolean;
  readonly className?: string;
}

const DIRECTION_WORDS = { up: "Up", down: "Down", flat: "No change" } as const;

export function MetricTile({
  label,
  value,
  denominator,
  comparison,
  history,
  historyLabel,
  headingLevel = 3,
  loading = false,
  error,
  readOnly = false,
  className,
}: MetricTileProps) {
  const labelId = useId();
  const Heading = `h${headingLevel}` as const;

  const change = comparison.changePercent;
  const movement = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const direction = comparison.direction ?? "up-is-good";
  const tone =
    direction === "neutral" || movement === "flat"
      ? "neutral"
      : (movement === "up") === (direction === "up-is-good")
        ? "good"
        : "bad";

  const Arrow = movement === "up" ? MarkTrendUp : movement === "down" ? MarkTrendDown : MarkTrendFlat;
  // A true minus sign rather than a hyphen: at the display step a hyphen next to
  // a numeral is visibly the wrong width and reads as a dash.
  const sign = movement === "up" ? "+" : movement === "down" ? "−" : "";
  const magnitude = `${Math.abs(change).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;

  return (
    <section
      className={className === undefined ? "pv-metric-tile" : `pv-metric-tile ${className}`}
      aria-labelledby={labelId}
      data-read-only={readOnly || undefined}
    >
      <div className="pv-metric-tile-header">
        <Heading className="pv-metric-tile-label" id={labelId}>
          {label}
        </Heading>
        {readOnly ? <ReadOnlyChip /> : null}
      </div>

      <SurfaceState loading={loading} error={error} skeletonLines={2}>
        <p className="pv-metric-tile-value" data-numeric>
          {value}
        </p>
        {denominator === undefined ? null : (
          <p className="pv-metric-tile-denominator">{denominator}</p>
        )}

        <p className="pv-metric-tile-trend" data-tone={tone}>
          <Arrow size="sm" />
          {/* The word is what a screen reader gets: the arrow is aria-hidden and
              the colour says nothing at all to it. The sign is hidden from
              assistive technology so the direction is not announced twice. */}
          <span className="pv-sr-only">{DIRECTION_WORDS[movement]} </span>
          <span className="pv-metric-tile-change" data-numeric>
            <span aria-hidden="true">{sign}</span>
            {magnitude}
          </span>
          <span className="pv-metric-tile-basis">
            {comparison.basis}
            {comparison.priorValue === undefined ? null : ` · from ${comparison.priorValue}`}
          </span>
        </p>

        {history === undefined ? null : (
          <div className="pv-metric-tile-history">
            <Sparkline values={history} label={historyLabel ?? `${label}, recent periods`} />
          </div>
        )}
      </SurfaceState>
    </section>
  );
}
