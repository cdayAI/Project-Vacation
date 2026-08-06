import type { ReactNode } from "react";
import { ChartFrame, seriesColor, type ChartDirectLabel } from "./ChartFrame";
import {
  axisFor,
  categoriesOf,
  linePath,
  MAX_SERIES,
  projectY,
  valuesFor,
  type ChartAnnotation,
  type ChartSeries,
} from "./chartGeometry";
import "./LineChart.css";

/**
 * A line chart: how something moved over a sequence of periods.
 *
 * Two decisions worth defending.
 *
 * **It does not start at zero, and that is correct here.** A first-pass rate
 * that lives between 92% and 96% is a flat line on a zeroed axis, and a flat
 * line is a lie about a metric that is being managed weekly. Bars are lengths
 * and must start at zero; a line is a *position over time*, and forcing its
 * baseline hides the only thing it is drawn to show. `includeZero` is there for
 * the cases where the zero genuinely matters.
 *
 * **The labels go at the ends of the lines, not in a legend.** A legend makes
 * the reader hold a colour-to-name mapping in their head while they look
 * somewhere else, which is exactly the cost a chart is supposed to remove — and
 * it is unusable to anyone who cannot separate two of the hues. The label sits
 * where the eye already is, in the line's own colour, and says the name.
 */

export interface LineChartProps {
  /** The title, written as a question. */
  readonly question: string;
  readonly headingLevel?: 2 | 3 | 4;
  /** The denominator and the basis. */
  readonly caption?: ReactNode;
  readonly series: readonly ChartSeries[];
  /** Interventions, drawn as vertical markers. "shadow → assisted, 12 Jun". */
  readonly annotations?: readonly ChartAnnotation[];
  readonly formatValue?: (value: number) => string;
  /** Forces the axis through zero, for a quantity where zero is the meaningful floor. */
  readonly includeZero?: boolean;
  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  readonly className?: string;
}

export function LineChart({
  question,
  headingLevel,
  caption,
  series,
  annotations,
  formatValue,
  includeZero = false,
  loading,
  error,
  empty,
  className,
}: LineChartProps) {
  const drawn = series.slice(0, MAX_SERIES);
  const categories = categoriesOf(drawn);
  const values = drawn.map((one) => valuesFor(one, categories));
  const axis = axisFor(values.flat(), { includeZero });

  const directLabels: ChartDirectLabel[] = drawn.flatMap((one, index) => {
    const points = values[index] ?? [];
    const last = points[points.length - 1];
    if (last === undefined) return [];
    return [
      {
        seriesId: one.id,
        label: one.label,
        y: projectY(last, axis.extent),
        colorIndex: index,
      },
    ];
  });

  return (
    <ChartFrame
      question={question}
      headingLevel={headingLevel}
      caption={caption}
      series={series}
      categories={categories}
      axis={axis}
      annotations={annotations}
      kind="Line chart"
      formatValue={formatValue}
      directLabels={directLabels}
      loading={loading}
      error={error}
      empty={empty}
      className={className}
    >
      {drawn.map((one, index) => (
        <path
          key={one.id}
          className="pv-line"
          d={linePath(values[index] ?? [], axis.extent)}
          stroke={seriesColor(index)}
          // Without this the stroke is stretched with the viewBox and a line on
          // a wide chart is a different weight from the same line on a narrow
          // one — the one visual property that must not depend on the container.
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </ChartFrame>
  );
}
