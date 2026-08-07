import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import type { ChartSeries } from "./chartGeometry";
import { LineChart } from "./LineChart";

const RATES: readonly ChartSeries[] = [
  {
    id: "first-pass",
    label: "First pass",
    points: [
      { x: "Wk 1", y: 92 },
      { x: "Wk 2", y: 94 },
      { x: "Wk 3", y: 96 },
    ],
  },
  {
    id: "assisted",
    label: "Assisted",
    points: [
      { x: "Wk 1", y: 71 },
      { x: "Wk 2", y: 76 },
      { x: "Wk 3", y: 74 },
    ],
  },
];

describe("LineChart", () => {
  it("labels each line at its end instead of in a legend", () => {
    // A legend makes the reader hold a colour-to-name mapping in their head
    // while looking somewhere else, and is unusable to anyone who cannot
    // separate two of the hues.
    const { container } = renderSurface(
      <LineChart question="Is the first-pass rate improving?" series={RATES} />,
    );

    const labels = container.querySelectorAll(".pv-chart-series-label");
    expect(labels).toHaveLength(2);
    expect(labels[0]).toHaveTextContent("First pass");
    expect(container.querySelector(".pv-chart-legend")).toBeNull();
  });

  it("does not zero the axis, because a rate is a position and not a length", () => {
    // 92–96% on a zeroed axis is a flat line, and a flat line is a lie about a
    // metric being managed weekly.
    const { container } = renderSurface(
      <LineChart question="Is the first-pass rate improving?" series={[RATES[0] as ChartSeries]} />,
    );
    const ticks = [...container.querySelectorAll(".pv-chart-axis-y-label")].map(
      (label) => label.textContent,
    );
    expect(ticks).not.toContain("0");
  });

  it("zeroes the axis when the caller says zero is the floor", () => {
    const { container } = renderSurface(
      <LineChart question="How many cases arrived?" series={RATES} includeZero />,
    );
    const ticks = [...container.querySelectorAll(".pv-chart-axis-y-label")].map(
      (label) => label.textContent,
    );
    expect(ticks).toContain("0");
  });

  it("draws one path per series with no fill", () => {
    const { container } = renderSurface(
      <LineChart question="Is the first-pass rate improving?" series={RATES} />,
    );
    const lines = container.querySelectorAll("path.pv-line");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      // Without this the stroke stretches with the viewBox and the same line is
      // a different weight on a wide chart than on a narrow one.
      expect(line).toHaveAttribute("vector-effect", "non-scaling-stroke");
    }
  });

  it("passes an intervention marker through to the frame", () => {
    renderSurface(
      <LineChart
        question="Is the first-pass rate improving?"
        series={RATES}
        annotations={[{ x: "Wk 2", label: "shadow → assisted, 12 Jun" }]}
      />,
    );
    expect(screen.getByText("shadow → assisted, 12 Jun")).toBeInTheDocument();
  });

  it("states an empty range rather than drawing an empty grid", () => {
    renderSurface(<LineChart question="Is the first-pass rate improving?" series={[]} />);
    expect(screen.getByText("No data in this range.")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <LineChart
        question="Is the first-pass rate improving?"
        caption="Of 1,240 cases"
        series={RATES}
        annotations={[{ x: "Wk 2", label: "shadow → assisted" }]}
        formatValue={(value) => `${value}%`}
      />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
