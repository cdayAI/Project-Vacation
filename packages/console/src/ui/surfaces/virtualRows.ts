/**
 * The windowing arithmetic behind the table.
 *
 * Spec §7 asks for 10,000 rows without jank. The only way to get that in a real
 * DOM is to stop rendering rows nobody can see, and the only way to keep *that*
 * honest is to keep the arithmetic separate from the component — a virtualizer
 * whose maths lives inside a scroll handler is a virtualizer whose off-by-one
 * at the bottom of the list is discovered by an operator.
 *
 * Pure functions, fixed row height. Fixed height is a constraint rather than a
 * simplification: variable-height rows require measuring every row to know
 * where any row is, which reintroduces the layout cost virtualization exists to
 * avoid, and the design already fixes row height to the density preference —
 * 52px comfortable, 40px compact — so there is nothing to vary.
 */

export interface VirtualWindow {
  /** First rendered row, inclusive. */
  readonly startIndex: number;
  /** Last rendered row, exclusive. */
  readonly endIndex: number;
  /** Pixels of spacer above the rendered rows. */
  readonly leadingSpace: number;
  /** Pixels of spacer below them. */
  readonly trailingSpace: number;
}

export interface VirtualWindowInput {
  readonly rowCount: number;
  readonly rowHeight: number;
  /** The scroller's inner height. Zero when the environment has no layout. */
  readonly viewportHeight: number;
  readonly scrollTop: number;
  /** Rows rendered beyond each edge so a fast scroll does not show a gap. */
  readonly overscan?: number;
}

/**
 * Rows rendered past each edge of the viewport.
 *
 * Four is enough to cover a wheel flick between two paint frames on a
 * mid-range laptop and small enough that it costs nothing. Larger values buy
 * smoothness that nobody can perceive and pay for it on every scroll frame.
 */
export const DEFAULT_OVERSCAN = 4;

/**
 * What we render when the scroller reports no height.
 *
 * That happens on the very first paint, before a resize observation has landed,
 * and in any environment without a layout engine. Rendering nothing there
 * produces an empty table that fills in a frame later — a layout shift on the
 * hot path, which spec §7 puts at zero. Twelve rows is more than any supported
 * viewport shows above the fold at either density, so the first paint is
 * already full and the measured window only ever trims it.
 */
export const UNMEASURED_VIEWPORT_ROWS = 12;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function computeVirtualWindow({
  rowCount,
  rowHeight,
  viewportHeight,
  scrollTop,
  overscan = DEFAULT_OVERSCAN,
}: VirtualWindowInput): VirtualWindow {
  if (rowCount <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, leadingSpace: 0, trailingSpace: 0 };
  }

  const effectiveViewport =
    viewportHeight > 0 ? viewportHeight : rowHeight * UNMEASURED_VIEWPORT_ROWS;

  // A scrollTop past the end of the list happens while rows are being filtered
  // out from under a scrolled operator. Clamping here rather than trusting the
  // browser to correct it is what stops a filter from briefly rendering an
  // empty table.
  const maxScrollTop = Math.max(0, rowCount * rowHeight - effectiveViewport);
  const safeScrollTop = clamp(scrollTop, 0, maxScrollTop);

  const firstVisible = Math.floor(safeScrollTop / rowHeight);
  // +1 because a viewport that is not an exact multiple of the row height
  // shows a partial row at the bottom, and a partial row is a row.
  const visibleCount = Math.ceil(effectiveViewport / rowHeight) + 1;

  const startIndex = clamp(firstVisible - overscan, 0, rowCount);
  const endIndex = clamp(firstVisible + visibleCount + overscan, startIndex, rowCount);

  return {
    startIndex,
    endIndex,
    leadingSpace: startIndex * rowHeight,
    trailingSpace: (rowCount - endIndex) * rowHeight,
  };
}

/**
 * The scroll position that brings `index` fully into view, or null when it
 * already is.
 *
 * Null rather than the current position so a caller can tell "no scroll needed"
 * from "scroll to here", and therefore avoid writing scrollTop on every
 * keystroke — assigning scrollTop unconditionally cancels the browser's smooth
 * scrolling and fights the operator's own wheel.
 */
export function scrollOffsetForIndex({
  index,
  rowCount,
  rowHeight,
  viewportHeight,
  scrollTop,
}: {
  readonly index: number;
  readonly rowCount: number;
  readonly rowHeight: number;
  readonly viewportHeight: number;
  readonly scrollTop: number;
}): number | null {
  if (index < 0 || index >= rowCount || rowHeight <= 0 || viewportHeight <= 0) return null;

  const rowTop = index * rowHeight;
  const rowBottom = rowTop + rowHeight;

  if (rowTop < scrollTop) return rowTop;
  if (rowBottom > scrollTop + viewportHeight) return rowBottom - viewportHeight;
  return null;
}
