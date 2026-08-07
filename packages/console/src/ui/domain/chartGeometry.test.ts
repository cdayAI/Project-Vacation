import { describe, expect, it } from "vitest";
import {
  areaPath,
  axisFor,
  bandFor,
  categoriesOf,
  extentOf,
  groupedBand,
  linePath,
  projectX,
  projectY,
  stackByCategory,
  stackTotals,
  valuesFor,
  type ChartSeries,
} from "./chartGeometry";

describe("extentOf", () => {
  it("takes the range of the data", () => {
    expect(extentOf([12, 4, 19])).toEqual({ min: 4, max: 19 });
  });

  it("reaches zero when the caller says the baseline matters", () => {
    // Bars are read as lengths. A bar chart that starts at 47 does not
    // emphasise a difference, it invents one.
    expect(extentOf([47, 52], { includeZero: true })).toEqual({ min: 0, max: 52 });
  });

  it("gives a flat series somewhere to be drawn", () => {
    const extent = extentOf([8, 8, 8]);
    expect(extent.min).toBeLessThan(8);
    expect(extent.max).toBeGreaterThan(8);
  });

  it("survives no data at all", () => {
    expect(extentOf([])).toEqual({ min: 0, max: 1 });
  });

  it("ignores values that are not finite", () => {
    expect(extentOf([1, Number.NaN, 5, Number.POSITIVE_INFINITY])).toEqual({ min: 1, max: 5 });
  });
});

describe("axisFor", () => {
  it("puts gridlines on numbers a reader can do arithmetic with", () => {
    const axis = axisFor([3, 47]);
    expect(axis.ticks).toEqual([0, 20, 40, 60]);
  });

  it("never clips a data point", () => {
    // A gridline set that stops below the maximum is a chart that lies.
    const axis = axisFor([13, 118, 64]);
    expect(axis.extent.min).toBeLessThanOrEqual(13);
    expect(axis.extent.max).toBeGreaterThanOrEqual(118);
  });

  it("leaves no floating-point tail on a label", () => {
    // 0.1 + 0.1 + 0.1 arrives at 0.30000000000000004, and then it is an axis
    // label.
    const axis = axisFor([0, 0.5]);
    for (const tick of axis.ticks) {
      expect(String(tick).length).toBeLessThan(6);
    }
  });

  it("covers a flat series without dividing by zero", () => {
    const axis = axisFor([5, 5, 5]);
    expect(axis.ticks.length).toBeGreaterThan(1);
    expect(Number.isFinite(axis.extent.max)).toBe(true);
  });
});

describe("projection", () => {
  it("measures y downward, the way SVG does", () => {
    const extent = { min: 0, max: 100 };
    expect(projectY(100, extent)).toBe(0);
    expect(projectY(0, extent)).toBe(100);
    expect(projectY(50, extent)).toBe(50);
  });

  it("clamps a value outside the drawn domain rather than escaping the plot", () => {
    expect(projectY(150, { min: 0, max: 100 })).toBe(0);
    expect(projectY(-50, { min: 0, max: 100 })).toBe(100);
  });

  it("puts the first and last points on the edges so a line ends at the frame", () => {
    expect(projectX(0, 4)).toBe(0);
    expect(projectX(3, 4)).toBe(100);
  });

  it("centres a lone point", () => {
    expect(projectX(0, 1)).toBe(50);
  });
});

describe("bands", () => {
  it("keeps a bar inside its category with a gap either side", () => {
    const band = bandFor(0, 4);
    expect(band.start).toBeGreaterThan(0);
    expect(band.start + band.width).toBeLessThan(25);
    expect(band.center).toBe(12.5);
  });

  it("divides a band between grouped series without overlapping them", () => {
    const band = bandFor(1, 3);
    const first = groupedBand(band, 0, 2);
    const second = groupedBand(band, 1, 2);
    expect(first.start + first.width).toBeCloseTo(second.start, 10);
    expect(second.start + second.width).toBeCloseTo(band.start + band.width, 10);
  });

  it("gives a single series the whole band", () => {
    const band = bandFor(0, 2);
    expect(groupedBand(band, 0, 1)).toEqual(band);
  });
});

describe("stacking", () => {
  it("accumulates each category from the baseline up", () => {
    const stacks = stackByCategory(
      [
        [2, 4],
        [3, 1],
      ],
      2,
    );
    expect(stacks[0]).toEqual([
      { value: 2, from: 0, to: 2 },
      { value: 3, from: 2, to: 5 },
    ]);
  });

  it("stacks negatives downward instead of cancelling the positives", () => {
    // A stack that mixes signs into one total is a bar whose height means
    // nothing.
    const stacks = stackByCategory([[5], [-3]], 1);
    expect(stacks[0]?.[1]).toEqual({ value: -3, from: -3, to: 0 });
  });

  it("totals only what adds to the height", () => {
    const stacks = stackByCategory([[5], [-3]], 1);
    expect(stackTotals(stacks)).toEqual([5]);
  });

  it("treats a missing category as nothing rather than as a gap", () => {
    const stacks = stackByCategory([[1]], 2);
    expect(stacks[1]).toEqual([{ value: 0, from: 0, to: 0 }]);
  });
});

describe("paths", () => {
  it("draws straight segments and never a spline", () => {
    // A smoothed line invents values between the measurements — it will show a
    // dip on a Tuesday that nothing supports, in a chart that goes to a
    // regulator.
    const path = linePath([0, 50, 100], { min: 0, max: 100 });
    expect(path).toBe("M0 100 L50 50 L100 0");
    expect(path).not.toContain("C");
    expect(path).not.toContain("Q");
  });

  it("returns nothing for no points rather than a broken path", () => {
    expect(linePath([], { min: 0, max: 1 })).toBe("");
  });

  it("closes an area back along its lower edge", () => {
    const path = areaPath([2, 4], [0, 0], { min: 0, max: 4 });
    expect(path.startsWith("M0 50")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
  });
});

describe("series alignment", () => {
  const series: readonly ChartSeries[] = [
    { id: "a", label: "A", points: [{ x: "Jan", y: 1 }, { x: "Feb", y: 2 }] },
    { id: "b", label: "B", points: [{ x: "Feb", y: 3 }, { x: "Mar", y: 4 }] },
  ];

  it("collects every category in first-seen order", () => {
    expect(categoriesOf(series)).toEqual(["Jan", "Feb", "Mar"]);
  });

  it("aligns a series to the shared categories", () => {
    expect(valuesFor(series[1] as ChartSeries, categoriesOf(series))).toEqual([0, 3, 4]);
  });
});
