import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERSCAN,
  UNMEASURED_VIEWPORT_ROWS,
  computeVirtualWindow,
  scrollOffsetForIndex,
} from "./virtualRows";

const ROW = 52;

describe("computeVirtualWindow", () => {
  it("renders only what is near the viewport out of ten thousand rows", () => {
    const window = computeVirtualWindow({
      rowCount: 10_000,
      rowHeight: ROW,
      viewportHeight: 800,
      scrollTop: 0,
    });

    const rendered = window.endIndex - window.startIndex;
    expect(rendered).toBeLessThan(40);
    expect(window.leadingSpace).toBe(0);
    expect(window.trailingSpace).toBe((10_000 - window.endIndex) * ROW);
  });

  it("keeps the total scrollable height constant as it scrolls", () => {
    // The spacers plus the rendered rows must always add up to the full list,
    // or the scrollbar changes size while the operator is dragging it.
    for (const scrollTop of [0, 1_000, 100_000, 519_000]) {
      const window = computeVirtualWindow({
        rowCount: 10_000,
        rowHeight: ROW,
        viewportHeight: 800,
        scrollTop,
      });
      const rendered = (window.endIndex - window.startIndex) * ROW;
      expect(window.leadingSpace + rendered + window.trailingSpace).toBe(10_000 * ROW);
    }
  });

  it("overscans on both sides so a fast scroll shows no gap", () => {
    const window = computeVirtualWindow({
      rowCount: 10_000,
      rowHeight: ROW,
      viewportHeight: 520,
      scrollTop: 52_000,
    });

    expect(window.startIndex).toBe(1000 - DEFAULT_OVERSCAN);
    expect(window.endIndex).toBeGreaterThan(1000 + 10);
  });

  it("stops exactly at the last row", () => {
    const window = computeVirtualWindow({
      rowCount: 40,
      rowHeight: ROW,
      viewportHeight: 800,
      scrollTop: 10_000,
    });

    expect(window.endIndex).toBe(40);
    expect(window.trailingSpace).toBe(0);
  });

  it("renders a full first page before anything has been measured", () => {
    // Zero height is the first paint, before a resize observation lands.
    // Rendering nothing there is a layout shift on the hot path, and spec §7
    // puts cumulative layout shift at zero.
    const window = computeVirtualWindow({
      rowCount: 500,
      rowHeight: ROW,
      viewportHeight: 0,
      scrollTop: 0,
    });

    expect(window.endIndex).toBeGreaterThanOrEqual(UNMEASURED_VIEWPORT_ROWS);
    expect(window.startIndex).toBe(0);
  });

  it("handles an empty table without producing phantom spacers", () => {
    expect(
      computeVirtualWindow({ rowCount: 0, rowHeight: ROW, viewportHeight: 800, scrollTop: 0 }),
    ).toEqual({ startIndex: 0, endIndex: 0, leadingSpace: 0, trailingSpace: 0 });
  });

  it("clamps a scroll position left over from a longer list", () => {
    // Filtering 10,000 rows down to 12 while the operator is scrolled to the
    // bottom would otherwise render an empty window.
    const window = computeVirtualWindow({
      rowCount: 12,
      rowHeight: ROW,
      viewportHeight: 400,
      scrollTop: 400_000,
    });

    expect(window.startIndex).toBe(0);
    expect(window.endIndex).toBe(12);
  });

  it("treats a zero row height as nothing to render rather than dividing by it", () => {
    expect(
      computeVirtualWindow({ rowCount: 10, rowHeight: 0, viewportHeight: 400, scrollTop: 0 }),
    ).toEqual({ startIndex: 0, endIndex: 0, leadingSpace: 0, trailingSpace: 0 });
  });
});

describe("scrollOffsetForIndex", () => {
  const base = { rowCount: 1000, rowHeight: ROW, viewportHeight: 520 };

  it("says nothing is needed when the row is already visible", () => {
    // Writing scrollTop on every keystroke fights the operator's own wheel.
    expect(scrollOffsetForIndex({ ...base, index: 5, scrollTop: 0 })).toBeNull();
  });

  it("scrolls up to bring a row above the viewport into view", () => {
    expect(scrollOffsetForIndex({ ...base, index: 10, scrollTop: 1000 })).toBe(520);
  });

  it("scrolls down by exactly one row when stepping past the bottom edge", () => {
    // J at the last visible row must move one row, not jump a page.
    const scrollTop = 0;
    const lastFullyVisible = Math.floor(base.viewportHeight / ROW) - 1;
    const next = scrollOffsetForIndex({ ...base, index: lastFullyVisible + 1, scrollTop });
    expect(next).toBe((lastFullyVisible + 2) * ROW - base.viewportHeight);
  });

  it("refuses an index outside the list", () => {
    expect(scrollOffsetForIndex({ ...base, index: -1, scrollTop: 0 })).toBeNull();
    expect(scrollOffsetForIndex({ ...base, index: 1000, scrollTop: 0 })).toBeNull();
  });

  it("declines when there is no measured viewport to scroll within", () => {
    expect(
      scrollOffsetForIndex({ ...base, viewportHeight: 0, index: 500, scrollTop: 0 }),
    ).toBeNull();
  });
});
