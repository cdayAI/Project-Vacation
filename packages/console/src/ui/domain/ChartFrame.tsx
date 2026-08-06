import { useId, type CSSProperties, type ReactNode } from "react";
import { SurfaceState } from "../surfaces/SurfaceState";
import {
  MAX_SERIES,
  projectY,
  type Axis,
  type ChartAnnotation,
  type ChartSeries,
} from "./chartGeometry";
import "./ChartFrame.css";

/**
 * The chrome every chart in this product shares.
 *
 * Charts differ in their marks and agree on everything else, so everything else
 * lives here: the question, the denominator, one horizontal gridline set, the
 * axis labels, the intervention markers, the series labels, and — the part that
 * is not optional — the numbers in a table.
 *
 * -----------------------------------------------------------------------------
 * A CHART A SCREEN READER CANNOT READ IS HALF A COMPLIANCE TEAM'S CHART
 *
 * Every chart carries two text alternatives, because they answer different
 * questions. A visually hidden sentence gives the shape — how many series, over
 * what, from what to what — which is what somebody skimming wants. A real
 * `<table>` behind a disclosure gives every number, which is what somebody
 * checking wants, and it is also what an operator copies into a spreadsheet and
 * what survives being printed into a regulator pack. The disclosure is closed
 * by default and open to everyone: sighted operators use it constantly, which
 * is the reason it stays correct.
 *
 * -----------------------------------------------------------------------------
 * WHY THE TITLE IS A QUESTION
 *
 * Spec §3.5: one question per chart, written as the title. A chart titled
 * "Collections recovery" invites the reader to work out what they are supposed
 * to take from it; a chart titled "Is collections recovery improving by
 * cohort?" has already told them what it is for, and the marks either answer it
 * or the chart should not be on the page.
 *
 * -----------------------------------------------------------------------------
 * SIX SERIES, AND THE REST GO TO THE TABLE
 *
 * Beyond six lines nobody can follow a chart, so only six are drawn — but the
 * table still carries every series, and a visible note says how many were left
 * out. Silently dropping data would be the worse half of both options.
 *
 * -----------------------------------------------------------------------------
 * THERE IS NO READ-ONLY VARIANT, BECAUSE THERE IS NOTHING ELSE
 *
 * A chart in this product changes nothing, so read-only is its only state and a
 * "Read-only" chip on it would be noise. The one control it has — the
 * disclosure over the numbers — stays available in every context, including the
 * auditor's: the read-only reader is the one who wants the table most.
 */

export interface ChartDirectLabel {
  readonly seriesId: string;
  readonly label: string;
  /** 0–100 down the plot, matching where the series ends. */
  readonly y: number;
  /** Which categorical colour the series was drawn in. */
  readonly colorIndex: number;
}

export interface ChartFrameProps {
  /** The title, written as a question. */
  readonly question: string;
  /** Document structure, not size. */
  readonly headingLevel?: 2 | 3 | 4;
  /** The denominator and the basis. "Of 1,240 cases · last 6 months." */
  readonly caption?: ReactNode;
  /** Every series, including any past the sixth. The table shows all of them. */
  readonly series: readonly ChartSeries[];
  readonly categories: readonly string[];
  readonly axis: Axis;
  readonly annotations?: readonly ChartAnnotation[];
  /** Names the mark type in the text alternative. "Line chart", "Stacked bars". */
  readonly kind: string;
  /** Formats every number: axis labels, the table, the spoken summary. */
  readonly formatValue?: (value: number) => string;
  /** Series labels at the ends of lines. Charts that cannot carry them pass a legend instead. */
  readonly directLabels?: readonly ChartDirectLabel[];
  /** Bars and stacks, which have no line end to write on. */
  readonly legend?: boolean;
  /** A per-category total column in the table. Stacked charts owe their reader this. */
  readonly totals?: readonly number[];
  /** The marks, in plot percentages. Drawn inside the frame's SVG. */
  readonly children?: ReactNode;

  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  readonly className?: string;
}

/** `var(--pv-chart-1)`… wrapping at the palette's length. */
export function seriesColor(index: number): string {
  return `var(--pv-chart-${(index % 8) + 1})`;
}

const DEFAULT_FORMAT = (value: number): string => value.toLocaleString();

export function ChartFrame({
  question,
  headingLevel = 3,
  caption,
  series,
  categories,
  axis,
  annotations = [],
  kind,
  formatValue = DEFAULT_FORMAT,
  directLabels,
  legend = false,
  totals,
  children,
  loading = false,
  error,
  empty,
  className,
}: ChartFrameProps) {
  const baseId = useId();
  const questionId = `${baseId}-question`;
  const summaryId = `${baseId}-summary`;
  const Heading = `h${headingLevel}` as const;

  const drawn = series.slice(0, MAX_SERIES);
  const omitted = series.length - drawn.length;
  // An axis and a gridline set drawn over nothing is a chart pretending to have
  // data. With none, the whole body is handed to SurfaceState's empty state.
  const hasData = drawn.length > 0 && categories.length > 0;

  const annotationX = (annotation: ChartAnnotation): number | null => {
    const index = categories.indexOf(annotation.x);
    if (index < 0) return null;
    return categories.length <= 1 ? 50 : (index / (categories.length - 1)) * 100;
  };

  const body = (
    <>
      <div className="pv-chart-figure">
        {/* Axis labels are HTML, not <text>: SVG text scales with the viewBox
            and would land between the nine type steps at every width. */}
        <div className="pv-chart-axis-y" aria-hidden="true">
          {axis.ticks.map((tick) => (
            <span
              key={tick}
              className="pv-chart-axis-y-label"
              data-numeric
              style={{ "--pv-chart-y": `${projectY(tick, axis.extent)}%` } as CSSProperties}
            >
              {formatValue(tick)}
            </span>
          ))}
        </div>

        <div className="pv-chart-plot">
          <svg
            className="pv-chart-canvas"
            viewBox="0 0 100 100"
            // The plot is a coordinate space, not a picture: stretching it to
            // the container is the point, and every stroke carries
            // vector-effect so nothing thickens or thins with it.
            preserveAspectRatio="none"
            // The marks say nothing the summary and the table do not say
            // better. Exposing them produces a tree full of unnamed paths.
            aria-hidden="true"
            focusable="false"
          >
            <g className="pv-chart-gridlines">
              {axis.ticks.map((tick) => {
                const y = projectY(tick, axis.extent);
                return (
                  <line
                    key={tick}
                    x1="0"
                    x2="100"
                    y1={y}
                    y2={y}
                    // The zero line is the one gridline that carries meaning
                    // rather than structure — it is where a bar starts.
                    className={tick === 0 ? "pv-chart-gridline-zero" : "pv-chart-gridline"}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </g>
            {children}
            {annotations.map((annotation) => {
              const x = annotationX(annotation);
              if (x === null) return null;
              return (
                <line
                  key={`${annotation.x}-${annotation.label}`}
                  className="pv-chart-annotation-rule"
                  x1={x}
                  x2={x}
                  y1="0"
                  y2="100"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>

          {/* Everything with words in it lives here, over the plot, in HTML. */}
          <div className="pv-chart-overlay" aria-hidden="true">
            {annotations.map((annotation) => {
              const x = annotationX(annotation);
              if (x === null) return null;
              return (
                <span
                  key={`${annotation.x}-${annotation.label}`}
                  className="pv-chart-annotation-label"
                  // Past the midpoint the label anchors to its right edge, or
                  // it runs off the plot on the last category.
                  data-side={x > 50 ? "end" : "start"}
                  style={{ "--pv-chart-x": `${x}%` } as CSSProperties}
                >
                  {annotation.label}
                </span>
              );
            })}

            {(directLabels ?? []).map((label) => (
              <span
                key={label.seriesId}
                className="pv-chart-series-label"
                style={
                  {
                    "--pv-chart-y": `${label.y}%`,
                    "--pv-chart-series-color": seriesColor(label.colorIndex),
                  } as CSSProperties
                }
              >
                {label.label}
              </span>
            ))}
          </div>
        </div>

        <div className="pv-chart-axis-x" aria-hidden="true">
          {categories.map((category) => (
            <span key={category} className="pv-chart-axis-x-label">
              {category}
            </span>
          ))}
        </div>
      </div>

      {legend ? (
        <ul className="pv-chart-legend">
          {drawn.map((one, index) => (
            <li key={one.id} className="pv-chart-legend-item">
              {/* The swatch is never alone: the series name is beside it, so
                  the chart still reads with no colour at all. */}
              <span
                className="pv-chart-legend-swatch"
                aria-hidden="true"
                style={{ "--pv-chart-series-color": seriesColor(index) } as CSSProperties}
              />
              {one.label}
            </li>
          ))}
        </ul>
      ) : null}

      {omitted > 0 ? (
        <p className="pv-chart-note">
          Showing {drawn.length} of {series.length} series. More than {MAX_SERIES} lines cannot be
          read at once — every series is in the table below.
        </p>
      ) : null}

      <p className="pv-sr-only" id={summaryId}>
        {summarize(kind, series, categories, annotations, formatValue)}
      </p>

      <details className="pv-chart-data">
        <summary className="pv-chart-data-summary">Show the numbers</summary>
        <div className="pv-chart-data-scroll">
          <table className="pv-chart-table">
            <caption className="pv-sr-only">{question}</caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                {series.map((one) => (
                  <th key={one.id} scope="col" className="pv-chart-table-number">
                    {one.label}
                  </th>
                ))}
                {totals === undefined ? null : (
                  <th scope="col" className="pv-chart-table-number">
                    Total
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {categories.map((category, index) => (
                <tr key={category}>
                  <th scope="row">{category}</th>
                  {series.map((one) => {
                    const point = one.points.find((candidate) => candidate.x === category);
                    return (
                      <td key={one.id} className="pv-chart-table-number">
                        {point === undefined ? "—" : formatValue(point.y)}
                      </td>
                    );
                  })}
                  {totals === undefined ? null : (
                    <td className="pv-chart-table-number">{formatValue(totals[index] ?? 0)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );

  return (
    <figure
      className={className === undefined ? "pv-chart" : `pv-chart ${className}`}
      aria-labelledby={questionId}
      // Only while there is a summary to point at. An aria-describedby whose
      // target does not exist is silently dropped by some assistive technology
      // and read as an empty string by others.
      aria-describedby={hasData ? summaryId : undefined}
    >
      <figcaption className="pv-chart-heading">
        <Heading className="pv-chart-question" id={questionId}>
          {question}
        </Heading>
        {caption === undefined ? null : <p className="pv-chart-caption">{caption}</p>}
      </figcaption>

      <SurfaceState
        loading={loading}
        error={error}
        empty={empty ?? "No data in this range."}
        skeletonLines={4}
      >
        {hasData ? body : null}
      </SurfaceState>
    </figure>
  );
}

/**
 * The chart in a sentence.
 *
 * Shape first — kind, how many series, over what — then each series from its
 * first value to its last with its range, then the interventions. It is
 * deliberately the same information a sighted reader takes from the picture in
 * two seconds, rather than a description of what the picture looks like.
 */
function summarize(
  kind: string,
  series: readonly ChartSeries[],
  categories: readonly string[],
  annotations: readonly ChartAnnotation[],
  formatValue: (value: number) => string,
): string {
  if (series.length === 0 || categories.length === 0) return `${kind} with no data.`;

  const span =
    categories.length === 1
      ? categories[0]
      : `${categories[0]} to ${categories[categories.length - 1]}`;
  const parts = [`${kind}. ${series.length} series, ${categories.length} periods, ${span}.`];

  for (const one of series) {
    const values = one.points.map((point) => point.y);
    if (values.length === 0) {
      parts.push(`${one.label}: no values.`);
      continue;
    }
    const first = values[0] as number;
    const last = values[values.length - 1] as number;
    const direction = last > first ? "up" : last < first ? "down" : "level";
    parts.push(
      `${one.label}: ${formatValue(first)} to ${formatValue(last)}, ${direction}. Low ${formatValue(
        Math.min(...values),
      )}, high ${formatValue(Math.max(...values))}.`,
    );
  }

  for (const annotation of annotations) {
    parts.push(`Marked at ${annotation.x}: ${annotation.label}.`);
  }

  return parts.join(" ");
}
