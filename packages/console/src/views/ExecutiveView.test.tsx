import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { executiveSnapshot, executiveWithoutSavings } from "../test/fixtures";
import { ExecutiveView } from "./ExecutiveView";

describe("ExecutiveView", () => {
  it("renders the figures management named in the earnings release", () => {
    renderSurface(<ExecutiveView executive={executiveSnapshot} />);

    expect(screen.getByText("$545M")).toBeInTheDocument();
    expect(screen.getByText("Up 22% from $445M in Q2 2025")).toBeInTheDocument();
    expect(screen.getByText("$4,477")).toBeInTheDocument();
    expect(screen.getByText("Up 23% from $3,631 in Q2 2025")).toBeInTheDocument();
    expect(screen.getByText("112,721")).toBeInTheDocument();
    expect(screen.getByText("54.3%")).toBeInTheDocument();
    expect(screen.getByText("1,475K")).toBeInTheDocument();
  });

  it("renders a source note on every single tile", () => {
    const { container } = renderSurface(<ExecutiveView executive={executiveSnapshot} />);

    const tiles = container.querySelectorAll("li.pv-metric");
    const expectedTiles =
      executiveSnapshot.businessMetrics.length + executiveSnapshot.platformMetrics.length;
    expect(tiles).toHaveLength(expectedTiles);

    for (const tile of tiles) {
      const source = tile.querySelector(".pv-metric-source");
      expect(source).not.toBeNull();
      expect(source?.textContent ?? "").toContain("Source:");
      expect((source?.textContent ?? "").length).toBeGreaterThan("Source: ".length);
    }
  });

  it("keeps MVW's reported figures apart from what the platform measured", () => {
    renderSurface(<ExecutiveView executive={executiveSnapshot} />);

    const reported = screen.getByRole("region", { name: "What MVW reported" });
    const measured = screen.getByRole("region", { name: "What this platform did" });

    expect(within(reported).getByText("$545M")).toBeInTheDocument();
    expect(within(reported).getAllByText(/Reported by MVW; not measured by this platform/).length)
      .toBeGreaterThan(0);

    expect(within(measured).getByText("11,284")).toBeInTheDocument();
    expect(
      within(measured).getAllByText(/Measured by this platform from its own operating record/)
        .length,
    ).toBeGreaterThan(0);

    // A business figure is never claimed as the platform's doing.
    expect(
      screen.getByText(/Nothing on this page asserts that this platform caused a business result/),
    ).toBeInTheDocument();
  });

  it("does not colour a rise as good when a rise is not good", () => {
    const { container } = renderSurface(<ExecutiveView executive={executiveSnapshot} />);

    const tiles = [...container.querySelectorAll("li.pv-metric")];
    const findTile = (label: string): Element => {
      const found = tiles.find((tile) => tile.querySelector("h3")?.textContent === label);
      expect(found, `no tile labelled ${label}`).toBeDefined();
      return found as Element;
    };

    // The receivable reserve rose, and a rising reserve is not a good thing.
    const reserve = findTile("Notes and contracts receivable reserve, six months");
    expect(reserve.className).toContain("pv-metric-bad");
    expect(reserve.className).not.toContain("pv-metric-good");
    expect(reserve.textContent).toContain("Moving in the direction management does not want");

    // Contract sales rose, and that is what management wants.
    const sales = findTile("Contract sales, Q2 2026");
    expect(sales.className).toContain("pv-metric-good");

    // SLA breaches fell, and falling is the good direction for that one.
    const breaches = findTile("Items that passed their service level");
    expect(breaches.className).toContain("pv-metric-good");
  });

  it("draws no judgement where the view model does not say which direction is good", () => {
    const { container } = renderSurface(<ExecutiveView executive={executiveSnapshot} />);

    const tiles = [...container.querySelectorAll("li.pv-metric")];
    const refusals = tiles.find(
      (tile) => tile.querySelector("h3")?.textContent === "Actions the platform refused",
    );
    expect(refusals?.className).toContain("pv-metric-neutral");
    expect(refusals?.textContent).not.toContain("Moving in the direction");
  });

  it("states the direction in words as well as in an arrow", () => {
    const { container } = renderSurface(<ExecutiveView executive={executiveSnapshot} />);

    const tiles = [...container.querySelectorAll("li.pv-metric")];
    const tours = tiles.find(
      (tile) => tile.querySelector("h3")?.textContent === "Tours, Q2 2026",
    );
    // The written direction is in the markup, so meaning never rests on the
    // glyph or on the tint.
    expect(tours?.textContent).toContain("(Down,");
    expect(tours?.querySelector(".pv-metric-glyph")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders the measurement caveat wherever a saving is shown", () => {
    renderSurface(<ExecutiveView executive={executiveSnapshot} />);

    // Once beside the number, and once as a callout, because a large figure
    // beside measured ones becomes a measured one in the retelling.
    expect(screen.getAllByText(/Hours saved is an estimate, not a measurement/)).toHaveLength(2);
    expect(screen.getByText("How the savings figure should be read")).toBeInTheDocument();
    expect(screen.getByText("an estimate, not a measurement.")).toBeInTheDocument();
  });

  it("claims nothing when no saving is calculated", () => {
    renderSurface(<ExecutiveView executive={executiveWithoutSavings} />);

    expect(screen.getByText(/Not claimed\. No saving is asserted/)).toBeInTheDocument();
    expect(screen.queryByText("How the savings figure should be read")).not.toBeInTheDocument();
    expect(screen.getByText("Not calculated")).toBeInTheDocument();
  });

  it("says so rather than showing an empty grid when no metric is configured", () => {
    renderSurface(
      <ExecutiveView
        executive={{ ...executiveSnapshot, businessMetrics: [], platformMetrics: [] }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "No business metrics are configured" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "No platform metrics are available" }),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<ExecutiveView executive={executiveSnapshot} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations with no metrics", async () => {
    const { container } = renderSurface(
      <ExecutiveView
        executive={{ ...executiveSnapshot, businessMetrics: [], platformMetrics: [] }}
      />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
