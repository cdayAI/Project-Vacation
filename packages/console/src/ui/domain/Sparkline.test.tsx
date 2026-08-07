import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Sparkline, SPARKLINE_SPOKEN_LIMIT } from "./Sparkline";

describe("Sparkline", () => {
  it("names itself with its shape and its numbers", () => {
    renderSurface(<Sparkline values={[3, 5, 4, 8]} label="First-pass rate, last 4 weeks" />);
    const image = screen.getByRole("img");
    expect(image).toHaveAccessibleName(
      "First-pass rate, last 4 weeks. 4 periods, 3 to 8, up. Low 3, high 8. Values: 3, 5, 4, 8.",
    );
  });

  it("stops listing values once a spoken list becomes a wall", () => {
    // Sixty numbers read aloud is a burden, not an alternative.
    const many = Array.from({ length: SPARKLINE_SPOKEN_LIMIT + 1 }, (_unused, index) => index);
    renderSurface(<Sparkline values={many} label="Cases per day" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).not.toContain("Values:");
  });

  it("says so when there is not enough history to draw a line", () => {
    // One point is a dot with no shape, which reads as a rendering failure.
    renderSurface(<Sparkline values={[4]} label="Cases per day" />);
    expect(screen.getByText("Not enough history yet")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("marks which end is now", () => {
    const { container } = renderSurface(<Sparkline values={[1, 2, 3]} label="Cases per day" />);
    const point = container.querySelector(".pv-sparkline-point");
    // A zero-length round-capped segment stays a dot when the coordinate space
    // is stretched; a circle would become an ellipse.
    expect(point).toHaveAttribute("d", "M100 0 L100 0");
  });

  it("keeps the line inside the plot when the series is flat", () => {
    const { container } = renderSurface(<Sparkline values={[7, 7, 7]} label="Cases per day" />);
    const d = container.querySelector(".pv-sparkline-line")?.getAttribute("d") ?? "";
    expect(d).toContain("50");
    expect(d).not.toContain("NaN");
  });

  it("hides the drawing from assistive technology, which reads the name instead", () => {
    const { container } = renderSurface(<Sparkline values={[1, 2]} label="Cases per day" />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <>
        <Sparkline values={[3, 5, 4, 8]} label="First-pass rate, last 4 weeks" />
        <Sparkline values={[]} label="Cases per day" />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
