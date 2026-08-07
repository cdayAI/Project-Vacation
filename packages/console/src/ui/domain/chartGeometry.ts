/**
 * The arithmetic behind every chart in this product.
 *
 * There is no chart library here and there is not going to be one. What a
 * charting package buys is tooltips, legends, and animation — three things
 * spec §3.5 either forbids or replaces — and what it costs is a dependency
 * that decides the type scale, the palette, and the accessibility story for a
 * product whose whole argument is that it decided those itself. So the marks
 * are hand-drawn SVG and the numbers are here, in pure functions with no React
 * and no DOM, because the part of a chart that is actually hard to get right is
 * the part that can be unit-tested.
 *
 * -----------------------------------------------------------------------------
 * EVERYTHING IS A PERCENTAGE
 *
 * Every position this module returns is 0–100 within the plot, with y measured
 * downward the way SVG measures it. That single decision is what lets the marks
 * be an SVG with `preserveAspectRatio="none"` while the labels are ordinary
 * HTML positioned over it with `inset`: both read the same numbers, and the
 * chart has no intrinsic size to fight with its container.
 *
 * The reason the labels are HTML and not `<text>` is typography. An SVG that
 * scales to its container scales its text with it, so a caption-sized axis
 * label is 9px in a narrow panel and 17px on a wide one — a font size outside
 * the nine-step scale, arrived at by accident, in a product that forbids them.
 * HTML labels stay on the scale at every width, and stay crisp.
 */

export interface Extent {
  readonly min: number;
  readonly max: number;
}

export interface Axis {
  /** The domain actually drawn — always at least as wide as the data. */
  readonly extent: Extent;
  /** Where the horizontal gridlines go. One set, and no vertical set (spec §3.5). */
  readonly ticks: readonly number[];
}

export interface ChartPoint {
  /** The category or period, as it is written on the axis. "Jun", "W23". */
  readonly x: string;
  readonly y: number;
}

export interface ChartSeries {
  readonly id: string;
  /** Written at the end of the line, so the chart needs no legend. */
  readonly label: string;
  readonly points: readonly ChartPoint[];
}

/**
 * A vertical marker naming something that was done to the system.
 *
 * This is the annotation spec §3.5 asks for — "shadow → assisted, 12 Jun" —
 * and it is the difference between a chart that shows a number moving and a
 * chart that explains why. An improvement programme that cannot point at the
 * intervention on the graph cannot claim the intervention worked.
 */
export interface ChartAnnotation {
  /** The x category the marker sits on. Must match a point's `x`. */
  readonly x: string;
  readonly label: string;
}

/** Spec §3.5. Beyond six series a chart is a decoration of a table. */
export const MAX_SERIES = 6;

export function extentOf(
  values: readonly number[],
  options: { readonly includeZero?: boolean } = {},
): Extent {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { min: 0, max: 1 };

  let min = Math.min(...finite);
  let max = Math.max(...finite);

  // Bars and areas are read as lengths from a baseline, so a bar chart that
  // starts at 47 exaggerates every difference on it. Spec §3.5: bars start at
  // zero, and this is where that is not optional.
  if (options.includeZero === true) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }

  if (min === max) {
    // A flat series still has to be drawn somewhere. Centring it in a unit band
    // keeps it off the frame edge without implying a range that is not there.
    return min === 0 ? { min: 0, max: 1 } : { min: min - Math.abs(min) / 2, max: max + Math.abs(max) / 2 };
  }

  return { min, max };
}

/** 1, 2, 2.5, 5, 10 — the steps a reader can do arithmetic on without stopping. */
const STEPS = [1, 2, 2.5, 5, 10] as const;

function niceStep(rough: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = STEPS.find((candidate) => normalized <= candidate) ?? 10;
  return step * magnitude;
}

/**
 * The domain and the gridlines for a set of values.
 *
 * Ticks land on round numbers and the domain is widened to reach them, because
 * an axis labelled 0 · 23.7 · 47.4 is an axis nobody reads. The domain is never
 * narrowed: a gridline set that clips a data point is a chart that lies.
 */
export function axisFor(
  values: readonly number[],
  options: { readonly includeZero?: boolean; readonly tickCount?: number } = {},
): Axis {
  const tickCount = Math.max(2, options.tickCount ?? 4);
  const raw = extentOf(values, options);
  const step = niceStep((raw.max - raw.min) / (tickCount - 1));

  const min = Math.floor(raw.min / step) * step;
  const max = Math.ceil(raw.max / step) * step;

  const ticks: number[] = [];
  // Counted rather than accumulated: repeatedly adding 0.1 arrives at
  // 0.30000000000000004, which is then rendered as an axis label.
  const count = Math.round((max - min) / step);
  for (let index = 0; index <= count; index += 1) {
    ticks.push(roundToStep(min + index * step, step));
  }

  return { extent: { min, max }, ticks };
}

/** Kills the floating-point tail a multiplication leaves on a label. */
function roundToStep(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number.parseFloat(value.toFixed(Math.min(decimals, 10)));
}

/** A value's distance from the top of the plot, 0–100, the way SVG measures y. */
export function projectY(value: number, extent: Extent): number {
  const span = extent.max - extent.min;
  if (span === 0) return 50;
  const ratio = (value - extent.min) / span;
  return clamp((1 - ratio) * 100);
}

/**
 * Where point `index` of `count` sits across the plot, 0–100.
 *
 * Line and area charts put the first point on the leading edge and the last on
 * the trailing one, so a series that ends today ends at the frame — which is
 * what makes the direct label at the line's end land where the eye already is.
 */
export function projectX(index: number, count: number): number {
  if (count <= 1) return 50;
  return clamp((index / (count - 1)) * 100);
}

export interface Band {
  /** Leading edge of the drawn bar, 0–100. */
  readonly start: number;
  readonly width: number;
  /** Centre of the category, where the axis label goes. */
  readonly center: number;
}

/**
 * The slot one category occupies in a bar chart, with a gap either side.
 *
 * Bars are positioned by category rather than by point index because a bar is a
 * region, not a location: putting the first bar's centre on the frame edge
 * clips half of it.
 */
export function bandFor(index: number, count: number, gapRatio = 0.28): Band {
  if (count <= 0) return { start: 0, width: 100, center: 50 };
  const slot = 100 / count;
  const width = slot * (1 - clampRatio(gapRatio));
  const start = index * slot + (slot - width) / 2;
  return { start, width, center: index * slot + slot / 2 };
}

/**
 * One bar's share of a grouped band. Grouped bars sit side by side inside the
 * category so that every series is measured from the same baseline.
 */
export function groupedBand(band: Band, seriesIndex: number, seriesCount: number): Band {
  if (seriesCount <= 1) return band;
  const width = band.width / seriesCount;
  const start = band.start + seriesIndex * width;
  return { start, width, center: start + width / 2 };
}

export interface StackSegment {
  /** The value's own magnitude, for the text alternative. */
  readonly value: number;
  /** Cumulative bottom and top of this segment, in data units. */
  readonly from: number;
  readonly to: number;
}

/**
 * Stacks series values per category.
 *
 * Negative values are stacked downward from zero rather than being added to the
 * positive pile, because a stack that mixes signs into one total is a chart
 * whose bar height means nothing.
 */
export function stackByCategory(
  values: readonly (readonly number[])[],
  categoryCount: number,
): readonly (readonly StackSegment[])[] {
  const stacks: StackSegment[][] = [];
  for (let category = 0; category < categoryCount; category += 1) {
    let positive = 0;
    let negative = 0;
    const segments: StackSegment[] = [];
    for (const series of values) {
      const value = series[category] ?? 0;
      if (value >= 0) {
        segments.push({ value, from: positive, to: positive + value });
        positive += value;
      } else {
        segments.push({ value, from: negative + value, to: negative });
        negative += value;
      }
    }
    stacks.push(segments);
  }
  return stacks;
}

/** The totals a stacked chart's axis has to cover, and its table has to show. */
export function stackTotals(stacks: readonly (readonly StackSegment[])[]): readonly number[] {
  return stacks.map((segments) =>
    segments.reduce((total, segment) => total + Math.max(0, segment.value), 0),
  );
}

/**
 * A polyline through the values, in plot percentages.
 *
 * Straight segments, never a spline. A smoothed line invents values between the
 * points — it will show a dip on a Tuesday that no measurement supports — and
 * this chart sits in an audit pack.
 */
export function linePath(values: readonly number[], extent: Extent): string {
  if (values.length === 0) return "";
  return values
    .map(
      (value, index) =>
        `${index === 0 ? "M" : "L"}${round(projectX(index, values.length))} ${round(projectY(value, extent))}`,
    )
    .join(" ");
}

/** The same line, closed down to a baseline, for an area or a stacked band. */
export function areaPath(
  upper: readonly number[],
  lower: readonly number[],
  extent: Extent,
): string {
  if (upper.length === 0) return "";
  const forward = upper
    .map(
      (value, index) =>
        `${index === 0 ? "M" : "L"}${round(projectX(index, upper.length))} ${round(projectY(value, extent))}`,
    )
    .join(" ");
  const back = [...lower]
    .map((value, index) => ({ value, index }))
    .reverse()
    .map(({ value, index }) => `L${round(projectX(index, lower.length))} ${round(projectY(value, extent))}`)
    .join(" ");
  return `${forward} ${back} Z`;
}

/** Every x category across a set of series, in first-seen order. */
export function categoriesOf(series: readonly ChartSeries[]): readonly string[] {
  const seen: string[] = [];
  for (const one of series) {
    for (const point of one.points) {
      if (!seen.includes(point.x)) seen.push(point.x);
    }
  }
  return seen;
}

/** A series' values aligned to a category list, with gaps as 0. */
export function valuesFor(series: ChartSeries, categories: readonly string[]): readonly number[] {
  return categories.map((category) => series.points.find((point) => point.x === category)?.y ?? 0);
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function clampRatio(value: number): number {
  return Math.min(0.9, Math.max(0, value));
}

/** Two decimals is a tenth of a pixel on a 1000px chart and half the path length. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
