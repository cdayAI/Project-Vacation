import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { SurfaceState } from "./SurfaceState";

describe("SurfaceState", () => {
  it("renders its content when nothing is wrong", () => {
    renderSurface(<SurfaceState>1,240 cases</SurfaceState>);
    expect(screen.getByText("1,240 cases")).toBeInTheDocument();
  });

  it("says the word Error, not only the colour", () => {
    // The audit pack this ends up inside is printed in black and white.
    renderSurface(
      <SurfaceState error="We could not reach the loan servicing system. Reference 8f2a41." />,
    );
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(
      screen.getByText("We could not reach the loan servicing system. Reference 8f2a41."),
    ).toBeInTheDocument();
  });

  it("shows the failure rather than the spinner when both are true", () => {
    // A spinner says "wait", and waiting is the wrong instruction for a
    // request that already failed.
    renderSurface(<SurfaceState loading error="Reference 8f2a41." />);
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.queryByText("Loading")).toBeNull();
  });

  it("makes a skeleton inert to assistive technology and says loading once", () => {
    const { container } = renderSurface(<SurfaceState loading />);

    expect(container.querySelector(".pv-surface-loading")).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByText("Loading")).toHaveLength(1);
    for (const bar of container.querySelectorAll(".pv-surface-skeleton")) {
      expect(bar).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("matches the skeleton to the shape of what is loading", () => {
    const { container } = renderSurface(<SurfaceState loading skeletonLines={6} />);
    expect(container.querySelectorAll(".pv-surface-skeleton")).toHaveLength(6);
  });

  it("draws at least one bar however few are asked for", () => {
    const { container } = renderSurface(<SurfaceState loading skeletonLines={0} />);
    expect(container.querySelectorAll(".pv-surface-skeleton")).toHaveLength(1);
  });

  it("shortens only the last bar, the way a paragraph's last line is short", () => {
    const { container } = renderSurface(<SurfaceState loading skeletonLines={3} />);
    const bars = [...container.querySelectorAll(".pv-surface-skeleton")];
    expect(bars.map((bar) => bar.getAttribute("data-line"))).toEqual(["full", "full", "last"]);
  });

  it("shows the empty state only when there is no content", () => {
    renderSurface(<SurfaceState empty="Nothing needs you right now." />);
    expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
  });

  it("prefers real content over an empty state", () => {
    renderSurface(<SurfaceState empty="Nothing needs you right now.">One case</SurfaceState>);
    expect(screen.getByText("One case")).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs you right now.")).toBeNull();
  });

  it("has no accessibility violations in any state", async () => {
    const { container } = renderSurface(
      <>
        <SurfaceState>Content</SurfaceState>
        <SurfaceState loading />
        <SurfaceState error="Reference 8f2a41." />
        <SurfaceState empty="Nothing yet." />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
