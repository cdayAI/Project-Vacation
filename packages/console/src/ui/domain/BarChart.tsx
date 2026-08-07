import type { ReactNode } from "react";
import { ChartFrame, seriesColor } from "./ChartFrame";
import {
  axisFor,
  bandFor,
  categoriesOf,
  groupedBand,
  MAX_SERIES,
  projectY,
  valuesFor,
  type ChartAnnotation,
  type ChartSeries,
} from "./chartGeometry";
import "./BarChart.css";

/**
 * A bar chart: comparing quantities across categories.
 *
 * **Bars start at zero. There is no prop to turn that off.** A bar is read as a
 * length, so a truncated baseline does not emphasise a difference — it invents
 * one, and this chart ends up in a pack that goes to a regulator. The axis is
 * built with the zero included and the zero gridline is drawn heavier than the
 * rest, because it is the line every bar is measured from.
 *
 * Series sit side by side within a category rather than in front of each other.
 * Overlapping bars save width by making the shorter series unmeasurable, which
 * is not a trade this product makes.
 *
 * Negative values are drawn downward from the zero line. A recovery chart with
 * a bad month in it should show the bad month, not omit it.
 */

export interface BarChartProps {
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

export function BarChart({
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
}: BarChartProps) {
  const drawn = series.slice(0, MAX_SERIES);
  const categories = categoriesOf(drawn);
  const values = drawn.map((one) => valuesFor(one, categories));
  const axis = axisFor(values.flat(), { includeZero: true });
  const zeroY = projectY(0, axis.extent);

  return (
    <ChartFrame
      question={question}
      headingLevel={headingLevel}
      caption={caption}
      series={series}
      categories={categories}
      axis={axis}
      annotations={annotations}
      kind="Bar chart"
      formatValue={formatValue}
      // A bar has no end to write a label beside, so this is the one chart
      // shape that earns a legend — always with the series name in words.
      legend
      loading={loading}
      error={error}
      empty={empty}
      className={className}
    >
      {categories.map((category, categoryIndex) => {
        const band = bandFor(categoryIndex, categories.length);
        return (
          <g key={category}>
            {drawn.map((one, seriesIndex) => {
              const value = values[seriesIndex]?.[categoryIndex] ?? 0;
              const slot = groupedBand(band, seriesIndex, drawn.length);
              const valueY = projectY(value, axis.extent);
              return (
                <rect
                  key={one.id}
                  className="pv-bar"
                  x={slot.start}
                  width={slot.width}
                  y={Math.min(valueY, zeroY)}
                  height={Math.abs(zeroY - valueY)}
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
