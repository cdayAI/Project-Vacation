import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { BarChart } from "./BarChart";
import type { ChartSeries } from "./chartGeometry";

const RECOVERY: readonly ChartSeries[] = [
  {
    id: "2025",
    label: "2025",
    points: [
      { x: "Q1", y: 47 },
      { x: "Q2", y: 52 },
    ],
  },
  {
    id: "2026",
    label: "2026",
    points: [
      { x: "Q1", y: 51 },
      { x: "Q2", y: 58 },
    ],
  },
];

describe("BarChart", () => {
  it("starts at zero, and there is no prop to stop it", () => {
    // A bar is read as a length. A truncated baseline does not emphasise a
    // difference, it invents one — in a chart that ends up in a regulator pack.
    const { container } = renderSurface(
      <BarChart question="Is recovery improving year on year?" series={RECOVERY} />,
    );
    const ticks = [...container.querySelectorAll(".pv-chart-axis-y-label")].map(
      (label) => label.textContent,
    );
    expect(ticks).toContain("0");
    expect(container.querySelector(".pv-chart-gridline-zero")).toBeInTheDocument();
  });

  it("puts grouped bars side by side rather than in front of each other", () => {
    const { container } = renderSurface(
      <BarChart question="Is recovery improving year on year?" series={RECOVERY} />,
    );
    const bars = [...container.querySelectorAll("rect.pv-bar")];
    expect(bars).toHaveLength(4);

    const first = Number(bars[0]?.getAttribute("x"));
    const firstWidth = Number(bars[0]?.getAttribute("width"));
    const second = Number(bars[1]?.getAttribute("x"));
    expect(second).toBeGreaterThanOrEqual(first + firstWidth);
  });

  it("draws a negative value downward from the zero line", () => {
    // A recovery chart with a bad month in it should show the bad month.
    const { container } = renderSurface(
      <BarChart
        question="How did net recovery move?"
        series={[
          {
            id: "net",
            label: "Net",
            points: [
              { x: "Q1", y: 20 },
              { x: "Q2", y: -10 },
            ],
          },
        ]}
      />,
    );

    const bars = [...container.querySelectorAll("rect.pv-bar")];
    const positiveBottom = Number(bars[0]?.getAttribute("y")) + Number(bars[0]?.getAttribute("height"));
    const negativeTop = Number(bars[1]?.getAttribute("y"));
    // Both meet the same zero line, one above it and one below.
    expect(negativeTop).toBeCloseTo(positiveBottom, 5);
  });

  it("names each series in a legend, since a bar has no end to write on", () => {
    renderSurface(<BarChart question="Is recovery improving year on year?" series={RECOVERY} />);
    const legend = screen.getAllByRole("listitem");
    expect(legend[0]).toHaveTextContent("2025");
    expect(legend[1]).toHaveTextContent("2026");
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <BarChart
        question="Is recovery improving year on year?"
        caption="Of 1,240 cases"
        series={RECOVERY}
        formatValue={(value) => `${value}%`}
      />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
