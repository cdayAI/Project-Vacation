import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { MetricTile } from "./MetricTile";

describe("MetricTile", () => {
  it("always shows what the number is being compared with", () => {
    // Spec §3.5: a tile without a comparison is not shipped. The prop is
    // required by the type, so the only way to omit the basis is not to
    // compile — this asserts the value reaches the screen.
    renderSurface(
      <MetricTile
        label="First-pass resolution"
        value="94.2%"
        comparison={{ basis: "vs. prior 30 days", changePercent: 4.2 }}
      />,
    );
    expect(screen.getByText(/vs\. prior 30 days/)).toBeInTheDocument();
  });

  it("shows the denominator beside the claim", () => {
    renderSurface(
      <MetricTile
        label="First-pass resolution"
        value="94.2%"
        denominator="of 1,240 cases"
        comparison={{ basis: "vs. prior 30 days", changePercent: 4.2 }}
      />,
    );
    expect(screen.getByText("of 1,240 cases")).toBeInTheDocument();
  });

  it("gives the movement a word, not only an arrow and a colour", () => {
    renderSurface(
      <MetricTile
        label="First-pass resolution"
        value="94.2%"
        comparison={{ basis: "vs. prior 30 days", changePercent: 4.2 }}
      />,
    );
    expect(screen.getByText("Up")).toHaveClass("pv-sr-only");
    expect(screen.getByText("4.2%")).toBeInTheDocument();
  });

  it("knows that a falling cost is good news", () => {
    // A component that paints every upward arrow green will eventually
    // congratulate an operator on a number getting worse.
    const { container } = renderSurface(
      <MetricTile
        label="Cost per case"
        value="$0.41"
        comparison={{ basis: "vs. prior 30 days", changePercent: -12, direction: "down-is-good" }}
      />,
    );
    expect(container.querySelector(".pv-metric-tile-trend")).toHaveAttribute("data-tone", "good");
    expect(screen.getByText("Down")).toBeInTheDocument();
  });

  it("marks a rise in a metric that should fall as bad news", () => {
    const { container } = renderSurface(
      <MetricTile
        label="Handle time"
        value="6m 12s"
        comparison={{ basis: "vs. prior 30 days", changePercent: 9, direction: "down-is-good" }}
      />,
    );
    expect(container.querySelector(".pv-metric-tile-trend")).toHaveAttribute("data-tone", "bad");
  });

  it("claims nothing when nothing moved", () => {
    const { container } = renderSurface(
      <MetricTile
        label="Escalations"
        value="12"
        comparison={{ basis: "vs. prior 30 days", changePercent: 0 }}
      />,
    );
    expect(container.querySelector(".pv-metric-tile-trend")).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByText("No change")).toBeInTheDocument();
  });

  it("carries the prior value when it saves the reader arithmetic", () => {
    renderSurface(
      <MetricTile
        label="Cases resolved"
        value="1,240"
        comparison={{ basis: "vs. prior 30 days", changePercent: 5, priorValue: "1,180" }}
      />,
    );
    expect(screen.getByText(/from 1,180/)).toBeInTheDocument();
  });

  it("asks for tabular figures on every number", () => {
    // Proportional digits make a dashboard jitter every time a value lands.
    const { container } = renderSurface(
      <MetricTile
        label="Cases resolved"
        value="1,240"
        comparison={{ basis: "vs. prior 30 days", changePercent: 5 }}
      />,
    );
    expect(container.querySelector(".pv-metric-tile-value")).toHaveAttribute("data-numeric");
    expect(container.querySelector(".pv-metric-tile-change")).toHaveAttribute("data-numeric");
  });

  it("draws a sparkline that reads its own numbers out", () => {
    renderSurface(
      <MetricTile
        label="First-pass resolution"
        value="94.2%"
        comparison={{ basis: "vs. prior 30 days", changePercent: 4.2 }}
        history={[90, 92, 94]}
        historyLabel="First-pass rate, last 3 weeks"
      />,
    );
    expect(screen.getByRole("img")).toHaveAccessibleName(/First-pass rate, last 3 weeks/);
  });

  it("keeps the label visible while the value is loading", () => {
    // The label is what reserves the tile's place on the grid. Losing it to a
    // skeleton is a layout shift on every dashboard refresh.
    renderSurface(
      <MetricTile
        label="First-pass resolution"
        value="94.2%"
        comparison={{ basis: "vs. prior 30 days", changePercent: 4.2 }}
        loading
      />,
    );
    expect(screen.getByRole("heading", { name: "First-pass resolution" })).toBeInTheDocument();
    expect(screen.getByText("Loading")).toHaveClass("pv-sr-only");
  });

  it("states a failure instead of showing a stale number", () => {
    renderSurface(
      <MetricTile
        label="First-pass resolution"
        value="94.2%"
        comparison={{ basis: "vs. prior 30 days", changePercent: 4.2 }}
        error="We could not reach the metrics service. Reference 8f2a41."
      />,
    );
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.queryByText("94.2%")).toBeNull();
  });

  it("says once that it is read-only", () => {
    renderSurface(
      <MetricTile
        label="First-pass resolution"
        value="94.2%"
        comparison={{ basis: "vs. prior 30 days", changePercent: 4.2 }}
        readOnly
      />,
    );
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("has no accessibility violations in any state", async () => {
    const { container } = renderSurface(
      <>
        <MetricTile
          label="First-pass resolution"
          value="94.2%"
          denominator="of 1,240 cases"
          comparison={{ basis: "vs. prior 30 days", changePercent: 4.2 }}
          history={[90, 92, 94]}
        />
        <MetricTile
          label="Cost per case"
          value="$0.41"
          comparison={{ basis: "vs. prior 30 days", changePercent: -12, direction: "down-is-good" }}
          readOnly
        />
        <MetricTile
          label="Escalations"
          value="12"
          comparison={{ basis: "vs. prior 30 days", changePercent: 0, direction: "neutral" }}
          loading
        />
        <MetricTile
          label="Recovered"
          value="$1.2m"
          comparison={{ basis: "vs. prior quarter", changePercent: 3 }}
          error="Reference 8f2a41."
        />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
