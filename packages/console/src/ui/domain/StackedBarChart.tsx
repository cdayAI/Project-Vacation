import type { ReactNode } from "react";
import { ChartFrame, seriesColor } from "./ChartFrame";
import {
  axisFor,
  bandFor,
  categoriesOf,
  MAX_SERIES,
  projectY,
  stackByCategory,
  stackTotals,
  valuesFor,
  type ChartAnnotation,
  type ChartSeries,
} from "./chartGeometry";
import "./StackedBarChart.css";

/**
 * A stacked bar chart: what a total is made of, category by category.
 *
 * The honest reading of a stack is the total and the bottom segment; every
 * segment above the first has a floating baseline and cannot be compared across
 * categories by eye. This component does not pretend otherwise — it always
 * renders a **Total** column in the numbers table, which is the answer to the
 * question a stack provokes and cannot itself answer.
 *
 * Segments are separated by a hairline in the surface colour rather than by
 * relying on the fills differing. Two adjacent categorical hues can land at the
 * same lightness in greyscale, and the audit pack is printed.
 *
 * Zero is not optional here for the same reason it is not optional on a bar
 * chart: the height of a stack is a quantity.
 */

export interface StackedBarChartProps {
  readonly question: string;
  readonly headingLevel?: 2 | 3 | 4;
  readonly caption?: ReactNode;
  readonly series: readonly ChartSeries[];
  readonly annotations?: readonly ChartAnnotation[];
  readonly formatValue?: (value: number) => string;
  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  readonly className?: string;
}

export function StackedBarChart({
  question,
  headingLevel,
  caption,
  series,
  annotations,
  formatValue,
  loading,
  error,
  empty,
  className,
}: StackedBarChartProps) {
  const drawn = series.slice(0, MAX_SERIES);
  const categories = categoriesOf(drawn);
  const values = drawn.map((one) => valuesFor(one, categories));
  const stacks = stackByCategory(values, categories.length);
  const totals = stackTotals(stacks);
  const axis = axisFor([...totals, 0], { includeZero: true });

  return (
    <ChartFrame
      question={question}
      headingLevel={headingLevel}
      caption={caption}
      series={series}
      categories={categories}
      axis={axis}
      annotations={annotations}
      kind="Stacked bar chart"
      formatValue={formatValue}
      legend
      totals={totals}
      loading={loading}
      error={error}
      empty={empty}
      className={className}
    >
      {categories.map((category, categoryIndex) => {
        const band = bandFor(categoryIndex, categories.length);
        const segments = stacks[categoryIndex] ?? [];
        return (
          <g key={category}>
            {segments.map((segment, seriesIndex) => {
              const top = projectY(segment.to, axis.extent);
              const bottom = projectY(segment.from, axis.extent);
              const one = drawn[seriesIndex];
              if (one === undefined) return null;
              return (
                <rect
                  key={one.id}
                  className="pv-stack-segment"
                  x={band.start}
                  width={band.width}
                  y={Math.min(top, bottom)}
                  height={Math.abs(bottom - top)}
                  fill={seriesColor(seriesIndex)}
                />
              );
            })}
          </g>
        );
      })}
    </ChartFrame>
  );
}
