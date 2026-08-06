import type { ReactNode } from "react";
import { ChartFrame, seriesColor, type ChartDirectLabel } from "./ChartFrame";
import {
  areaPath,
  axisFor,
  categoriesOf,
  linePath,
  MAX_SERIES,
  projectY,
  stackByCategory,
  stackTotals,
  valuesFor,
  type ChartAnnotation,
  type ChartSeries,
} from "./chartGeometry";
import "./AreaChart.css";

/**
 * An area chart: how a total was made up, period by period.
 *
 * **It stacks, and it does not offer not to.** Overlapping translucent areas
 * are the default in most charting libraries and they are unreadable: the
 * fourth band is a colour nobody has a name for, and the value of the series
 * underneath cannot be recovered by eye at all. Stacking answers the question
 * an area chart is actually asked — what makes up the total, and is the total
 * growing — and the per-series numbers stay available in the table.
 *
 * **The axis always includes zero.** A band's meaning is its thickness, and a
 * thickness measured from an arbitrary floor is not a quantity.
 *
 * Each band carries a line along its top edge as well as a fill, so the
 * boundary between two bands survives a greyscale printout where two adjacent
 * fills may not.
 */

export interface AreaChartProps {
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

export function AreaChart({
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
}: AreaChartProps) {
  const drawn = series.slice(0, MAX_SERIES);
  const categories = categoriesOf(drawn);
  const values = drawn.map((one) => valuesFor(one, categories));
  const stacks = stackByCategory(values, categories.length);
  const totals = stackTotals(stacks);
  const axis = axisFor([...totals, 0], { includeZero: true });

  const directLabels: ChartDirectLabel[] = drawn.flatMap((one, index) => {
    const lastStack = stacks[stacks.length - 1];
    const segment = lastStack?.[index];
    if (segment === undefined) return [];
    return [
      {
        seriesId: one.id,
        label: one.label,
        // Centred on the band's own thickness rather than on its top edge, so
        // two thin bands beside each other do not print their labels on top of
        // one another.
        y: projectY((segment.from + segment.to) / 2, axis.extent),
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
      kind="Stacked area chart"
      formatValue={formatValue}
      directLabels={directLabels}
      totals={totals}
      loading={loading}
      error={error}
      empty={empty}
      className={className}
    >
      {drawn.map((one, index) => {
        const upper = stacks.map((segments) => segments[index]?.to ?? 0);
        const lower = stacks.map((segments) => segments[index]?.from ?? 0);
        return (
          <g key={one.id}>
            <path
              className="pv-area-band"
              d={areaPath(upper, lower, axis.extent)}
              fill={seriesColor(index)}
            />
            <path
              className="pv-area-edge"
              d={linePath(upper, axis.extent)}
              stroke={seriesColor(index)}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </ChartFrame>
  );
}
