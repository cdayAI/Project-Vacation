import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { ChartFrame, seriesColor } from "./ChartFrame";
import { axisFor, categoriesOf, type ChartSeries } from "./chartGeometry";

const SERIES: readonly ChartSeries[] = [
  {
    id: "recovered",
    label: "Recovered",
    points: [
      { x: "Jan", y: 40 },
      { x: "Feb", y: 55 },
      { x: "Mar", y: 61 },
    ],
  },
];

function frame(props: Partial<Parameters<typeof ChartFrame>[0]> = {}) {
  const series = props.series ?? SERIES;
  const categories = categoriesOf(series);
  return (
    <ChartFrame
      question="Is collections recovery improving?"
      series={series}
      categories={categories}
      axis={axisFor(series.flatMap((one) => one.points.map((point) => point.y)))}
      kind="Line chart"
      {...props}
    />
  );
}

describe("ChartFrame", () => {
  it("is named by its question", () => {
    renderSurface(frame());
    expect(
      screen.getByRole("figure", { name: "Is collections recovery improving?" }),
    ).toBeInTheDocument();
  });

  it("carries the denominator beside the question", () => {
    renderSurface(frame({ caption: "Of 1,240 cases · last 6 months" }));
    expect(screen.getByText("Of 1,240 cases · last 6 months")).toBeInTheDocument();
  });

  it("puts every number in a table behind a disclosure", async () => {
    // A chart a screen reader cannot read is a chart half the compliance team
    // cannot use — and this is also what an operator copies into a spreadsheet.
    const user = userEvent.setup();
    renderSurface(frame());

    await user.click(screen.getByText("Show the numbers"));
    const table = screen.getByRole("table", { name: "Is collections recovery improving?" });
    expect(table).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Recovered" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Feb" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "55" })).toBeInTheDocument();
  });

  it("describes the shape of the chart in a sentence", () => {
    const { container } = renderSurface(frame());
    const summary = container.querySelector(".pv-sr-only");
    expect(summary?.textContent).toContain("Line chart");
    expect(summary?.textContent).toContain("40 to 61, up");
  });

  it("hides the marks from assistive technology, because the text says it better", () => {
    const { container } = renderSurface(frame());
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("draws one horizontal gridline set and no vertical one", () => {
    // Spec §3.5. A vertical grid over a categorical axis adds ink and no
    // information.
    const { container } = renderSurface(frame());
    const gridlines = container.querySelectorAll(".pv-chart-gridlines line");
    expect(gridlines.length).toBeGreaterThan(0);
    for (const line of gridlines) {
      expect(line.getAttribute("y1")).toEqual(line.getAttribute("y2"));
      expect(line.getAttribute("x1")).not.toEqual(line.getAttribute("x2"));
    }
  });

  it("marks an intervention with a rule and names it", () => {
    const { container } = renderSurface(
      frame({ annotations: [{ x: "Feb", label: "shadow → assisted, 12 Jun" }] }),
    );
    expect(container.querySelector(".pv-chart-annotation-rule")).toBeInTheDocument();
    expect(screen.getByText("shadow → assisted, 12 Jun")).toBeInTheDocument();
  });

  it("ignores an annotation on a category that is not in the data", () => {
    // Silently drawing it at the origin would put a marker on the wrong month.
    const { container } = renderSurface(frame({ annotations: [{ x: "Dec", label: "Cutover" }] }));
    expect(container.querySelector(".pv-chart-annotation-rule")).toBeNull();
  });

  it("draws six series and tables all of them", async () => {
    const many: ChartSeries[] = Array.from({ length: 8 }, (_unused, index) => ({
      id: `s${index}`,
      label: `Series ${index}`,
      points: [{ x: "Jan", y: index }],
    }));
    const user = userEvent.setup();
    renderSurface(frame({ series: many, legend: true }));

    expect(screen.getByText(/Showing 6 of 8 series/)).toBeInTheDocument();
    await user.click(screen.getByText("Show the numbers"));
    expect(screen.getByRole("columnheader", { name: "Series 7" })).toBeInTheDocument();
  });

  it("labels a legend swatch with the series name", () => {
    // A swatch on its own is colour carrying meaning alone.
    renderSurface(frame({ legend: true }));
    expect(screen.getByRole("listitem")).toHaveTextContent("Recovered");
  });

  it("shows a stated empty state rather than an empty grid", () => {
    renderSurface(frame({ series: [] }));
    expect(screen.getByText("No data in this range.")).toBeInTheDocument();
  });

  it("prefers a failure over a spinner", () => {
    renderSurface(frame({ loading: true, error: "Reference 8f2a41." }));
    expect(screen.queryByText("Loading")).toBeNull();
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("wraps the palette rather than running out of colours", () => {
    expect(seriesColor(0)).toBe("var(--pv-chart-1)");
    expect(seriesColor(8)).toBe("var(--pv-chart-1)");
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      frame({
        caption: "Of 1,240 cases",
        annotations: [{ x: "Feb", label: "shadow → assisted" }],
        legend: true,
        totals: [40, 55, 61],
      }),
    );
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations while it is empty, loading, or failed", async () => {
    // The described-by summary only exists when there is data to summarise, so
    // these three states are where a dangling reference would show up.
    const { container } = renderSurface(
      <>
        {frame({ series: [], question: "Is recovery improving?" })}
        {frame({ loading: true, question: "Is cost per case falling?" })}
        {frame({ error: "Reference 8f2a41.", question: "Is handle time falling?" })}
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
