import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("takes its heading level from the caller and its size from the design", () => {
    renderSurface(
      <EmptyState
        title="Nothing needs you right now."
        body="New cases arrive as owners contact us or as workflows escalate."
        headingLevel={2}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "Nothing needs you right now." }),
    ).toHaveClass("pv-empty-state-title");
  });

  it("offers the way out", () => {
    renderSurface(
      <EmptyState
        title="Nothing needs you right now."
        body="A digest lands at 9:00 each morning."
        actions={
          <>
            <button type="button">Change my digest</button>
            <button type="button">See all cases</button>
          </>
        }
      />,
    );
    expect(screen.getByRole("button", { name: "Change my digest" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "See all cases" })).toBeInTheDocument();
  });

  it("says why it is empty when a filter is the reason", () => {
    // "No rows" and "your filter excluded everything" are different situations
    // and lead to different actions. The hint is where that is said.
    renderSurface(
      <EmptyState
        title="No cases match these filters."
        body="Widen the date range or clear a filter to see more."
        hint="3 filters are active"
      />,
    );
    expect(screen.getByText("3 filters are active")).toBeInTheDocument();
  });

  it("centres the block but never the prose", () => {
    const { container } = renderSurface(<EmptyState title="Nothing yet." body="Check back." />);
    expect(container.querySelector(".pv-empty-state")).toHaveAttribute("data-align", "center");
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <EmptyState
        title="Nothing needs you right now."
        body="New cases arrive as owners contact us or as workflows escalate."
        actions={<button type="button">See all cases</button>}
        hint="Updated a moment ago"
      />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
