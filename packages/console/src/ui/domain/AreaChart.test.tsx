import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { AreaChart } from "./AreaChart";
import type { ChartSeries } from "./chartGeometry";

const MIX: readonly ChartSeries[] = [
  {
    id: "auto",
    label: "Resolved automatically",
    points: [
      { x: "Apr", y: 300 },
      { x: "May", y: 420 },
    ],
  },
  {
    id: "assisted",
    label: "Assisted",
    points: [
      { x: "Apr", y: 200 },
      { x: "May", y: 180 },
    ],
  },
];

describe("AreaChart", () => {
  it("stacks rather than overlapping translucent fills", async () => {
    // Overlapping areas hide the series underneath. The stack answers the
    // question an area chart is actually asked: what makes up the total.
    const user = userEvent.setup();
    renderSurface(<AreaChart question="What is resolving cases?" series={MIX} />);

    await user.click(screen.getByText("Show the numbers"));
    expect(screen.getByRole("columnheader", { name: "Total" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "600" })).toBeInTheDocument();
  });

  it("always includes zero, because a band's meaning is its thickness", () => {
    const { container } = renderSurface(
      <AreaChart question="What is resolving cases?" series={MIX} />,
    );
    const ticks = [...container.querySelectorAll(".pv-chart-axis-y-label")].map(
      (label) => label.textContent,
    );
    expect(ticks).toContain("0");
  });

  it("draws an edge line over every band", () => {
    // Two adjacent fills can land at the same lightness in greyscale; the edge
    // is what keeps the boundary visible on a printed pack.
    const { container } = renderSurface(
      <AreaChart question="What is resolving cases?" series={MIX} />,
    );
    expect(container.querySelectorAll("path.pv-area-band")).toHaveLength(2);
    expect(container.querySelectorAll("path.pv-area-edge")).toHaveLength(2);
  });

  it("labels each band at its end", () => {
    const { container } = renderSurface(
      <AreaChart question="What is resolving cases?" series={MIX} />,
    );
    expect(container.querySelectorAll(".pv-chart-series-label")).toHaveLength(2);
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <AreaChart question="What is resolving cases?" caption="Of 1,240 cases" series={MIX} />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
