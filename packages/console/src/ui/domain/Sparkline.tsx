import { extentOf, linePath, projectX, projectY } from "./chartGeometry";
import "./Sparkline.css";

/**
 * A sparkline: the shape of the last few periods, at the size of a word.
 *
 * It has no axis, no gridline, and no label, because it is not a chart — it is
 * a piece of typography that happens to be a line. Its job on a metric tile is
 * to answer "is this number's movement steady or is it a spike?" in the same
 * glance that reads the number. The moment it needs an axis to be understood it
 * has stopped being a sparkline and should be a `LineChart`.
 *
 * **It still carries its numbers.** The line is `aria-hidden` and the element
 * around it is an image with a name that states the range and the direction,
 * plus the values themselves when there are few enough to be worth hearing.
 * Twenty-four is where a spoken list stops being useful and becomes a wall — a
 * screen-reader user listening to sixty numbers has been given a burden, not
 * an alternative.
 *
 * The final point gets a dot so the eye knows which end is now. It is drawn as
 * a zero-length round-capped segment rather than a `<circle>`: the plot is
 * stretched to its container, and a circle in a stretched coordinate space is
 * an ellipse.
 */

/** Past this many values the description states the shape instead of listing it. */
export const SPARKLINE_SPOKEN_LIMIT = 24;

export interface SparklineProps {
  /** Oldest first. The last value is the one the dot marks. */
  readonly values: readonly number[];
  /** What the line shows, for the accessible name. "First-pass rate, last 12 weeks". */
  readonly label: string;
  readonly formatValue?: (value: number) => string;
  /** Shown when there is not yet enough history to draw a line. */
  readonly emptyLabel?: string;
  readonly className?: string;
}

export function Sparkline({
  values,
  label,
  formatValue = (value) => value.toLocaleString(),
  emptyLabel = "Not enough history yet",
  className,
}: SparklineProps) {
  // One point is a dot with no shape, which tells an operator nothing and looks
  // like a rendering failure. Say so instead.
  if (values.length < 2) {
    return (
      <span className={className === undefined ? "pv-sparkline-empty" : `pv-sparkline-empty ${className}`}>
        {emptyLabel}
      </span>
    );
  }

  const extent = extentOf(values);
  const path = linePath(values, extent);
  const lastX = projectX(values.length - 1, values.length);
  const lastY = projectY(values[values.length - 1] as number, extent);

  return (
    <span
      className={className === undefined ? "pv-sparkline" : `pv-sparkline ${className}`}
      role="img"
      aria-label={describe(label, values, formatValue)}
    >
      <svg
        className="pv-sparkline-canvas"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <path className="pv-sparkline-line" d={path} vectorEffect="non-scaling-stroke" />
        <path
          className="pv-sparkline-point"
          d={`M${lastX} ${lastY} L${lastX} ${lastY}`}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  );
}

function describe(
  label: string,
  values: readonly number[],
  formatValue: (value: number) => string,
): string {
  const first = values[0] as number;
  const last = values[values.length - 1] as number;
  const direction = last > first ? "up" : last < first ? "down" : "level";
  const shape = `${label}. ${values.length} periods, ${formatValue(first)} to ${formatValue(
    last,
  )}, ${direction}. Low ${formatValue(Math.min(...values))}, high ${formatValue(
    Math.max(...values),
  )}.`;

  if (values.length > SPARKLINE_SPOKEN_LIMIT) return shape;
  return `${shape} Values: ${values.map(formatValue).join(", ")}.`;
}
