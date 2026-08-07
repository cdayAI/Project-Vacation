import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import type { ChartSeries } from "./chartGeometry";
import { StackedBarChart } from "./StackedBarChart";

const OUTCOMES: readonly ChartSeries[] = [
  {
    id: "approved",
    label: "Approved",
    points: [
      { x: "Jun", y: 120 },
      { x: "Jul", y: 140 },
    ],
  },
  {
    id: "rejected",
    label: "Rejected",
    points: [
      { x: "Jun", y: 30 },
      { x: "Jul", y: 20 },
    ],
  },
];

describe("StackedBarChart", () => {
  it("always tables the total, which is the question a stack provokes", async () => {
    // Only the total and the bottom segment can be compared across categories
    // by eye. The component does not pretend otherwise.
    const user = userEvent.setup();
    renderSurface(<StackedBarChart question="How are approvals resolving?" series={OUTCOMES} />);

    await user.click(screen.getByText("Show the numbers"));
    expect(screen.getByRole("columnheader", { name: "Total" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "150" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "160" })).toBeInTheDocument();
  });

  it("stacks each segment on the one below it", () => {
    const { container } = renderSurface(
      <StackedBarChart question="How are approvals resolving?" series={OUTCOMES} />,
    );
    const segments = [...container.querySelectorAll("rect.pv-stack-segment")];
    expect(segments).toHaveLength(4);

    const [first, second] = segments;
    // The second segment of the first category sits directly on top of the
    // first: its bottom edge is the other's top edge.
    const secondBottom = Number(second?.getAttribute("y")) + Number(second?.getAttribute("height"));
    expect(secondBottom).toBeCloseTo(Number(first?.getAttribute("y")), 5);
  });

  it("shares the category band rather than splitting it", () => {
    const { container } = renderSurface(
      <StackedBarChart question="How are approvals resolving?" series={OUTCOMES} />,
    );
    const segments = [...container.querySelectorAll("rect.pv-stack-segment")];
    expect(segments[0]?.getAttribute("x")).toEqual(segments[1]?.getAttribute("x"));
    expect(segments[0]?.getAttribute("width")).toEqual(segments[1]?.getAttribute("width"));
  });

  it("starts at zero", () => {
    const { container } = renderSurface(
      <StackedBarChart question="How are approvals resolving?" series={OUTCOMES} />,
    );
    expect(container.querySelector(".pv-chart-gridline-zero")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <StackedBarChart
        question="How are approvals resolving?"
        caption="Of 1,240 cases"
        series={OUTCOMES}
      />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
