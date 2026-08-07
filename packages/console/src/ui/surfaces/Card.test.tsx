import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Card } from "./Card";

describe("Card", () => {
  it("names itself with its title, without becoming a landmark", () => {
    // A named <section> is a region landmark. Twelve summary cards would then
    // be twelve landmarks, which is noise rather than navigation.
    renderSurface(<Card title="Collections recovery">Body</Card>);
    expect(screen.getByRole("article", { name: "Collections recovery" })).toBeInTheDocument();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("takes its heading level from the caller and its size from the design", () => {
    // Level is document structure; the type step is fixed. A card two levels
    // deep in the outline is still a card title.
    renderSurface(<Card title="Blast radius" titleLevel={4} />);
    expect(screen.getByRole("heading", { level: 4, name: "Blast radius" })).toHaveClass(
      "pv-card-title",
    );
  });

  it("renders without a title for a card whose content names itself", () => {
    const { container } = renderSurface(<Card>42 owners</Card>);
    expect(container.querySelector(".pv-card-header")).toBeNull();
  });

  describe("as a trigger", () => {
    it("names the button with the title alone, not the whole card", async () => {
      // An accessible name made of the card's entire text is what an operator
      // hears on every arrow press.
      const onActivate = vi.fn();
      const user = userEvent.setup();
      renderSurface(
        <Card title="Case 41823" onActivate={onActivate}>
          Owner M. Delgado · $12,400 · breaching in 4 hours
        </Card>,
      );

      const trigger = screen.getByRole("button", { name: "Case 41823" });
      await user.click(trigger);
      expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it("is operable from the keyboard", async () => {
      const onActivate = vi.fn();
      const user = userEvent.setup();
      renderSurface(<Card title="Case 41823" onActivate={onActivate} />);

      await user.tab();
      expect(screen.getByRole("button", { name: "Case 41823" })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it("navigates when given an href", () => {
      renderSurface(<Card title="Case 41823" href="/cases/41823" />);
      expect(screen.getByRole("link", { name: "Case 41823" })).toHaveAttribute(
        "href",
        "/cases/41823",
      );
    });

    it("offers nothing to activate when disabled", () => {
      renderSurface(<Card title="Case 41823" onActivate={vi.fn()} disabled />);
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByRole("article", { name: "Case 41823" })).toHaveAttribute(
        "data-disabled",
        "true",
      );
    });
  });

  describe("designed states", () => {
    it("announces loading and shows no fake text to a screen reader", () => {
      const { container } = renderSurface(<Card title="Recovery" loading />);

      expect(screen.getByText("Loading")).toHaveClass("pv-sr-only");
      expect(container.querySelector(".pv-surface-loading")).toHaveAttribute("aria-busy", "true");
      for (const bar of container.querySelectorAll(".pv-surface-skeleton")) {
        expect(bar).toHaveAttribute("aria-hidden", "true");
      }
    });

    it("states an error in words as well as in colour", () => {
      // This block is grey on a monochrome audit printout.
      renderSurface(
        <Card title="Recovery" error="We could not reach the loan servicing system." />,
      );

      expect(screen.getByText("Error")).toBeInTheDocument();
      expect(
        screen.getByText("We could not reach the loan servicing system."),
      ).toBeInTheDocument();
    });

    it("prefers the error over the loading state", () => {
      renderSurface(<Card title="Recovery" loading error="Reference 8f2a41." />);
      expect(screen.queryByText("Loading")).toBeNull();
      expect(screen.getByText("Error")).toBeInTheDocument();
    });

    it("shows an empty state only when there is no content", () => {
      renderSurface(<Card title="Prior decisions" empty="No comparable decisions yet." />);
      expect(screen.getByText("No comparable decisions yet.")).toBeInTheDocument();
    });

    it("marks read-only and drops the actions rather than dimming them", () => {
      // A row of dimmed buttons is an invitation to keep clicking them.
      renderSurface(
        <Card title="Owner record" readOnly actions={<button type="button">Edit</button>}>
          M. Delgado
        </Card>,
      );

      expect(screen.getByText("Read-only")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      expect(screen.getByRole("article", { name: "Owner record" })).toHaveAttribute(
        "data-read-only",
        "true",
      );
    });

    it("keeps its actions when it is not read-only", () => {
      renderSurface(
        <Card title="Owner record" actions={<button type="button">Edit</button>}>
          M. Delgado
        </Card>,
      );
      expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    });
  });

  it("marks selection with data as well as with an accent bar", () => {
    renderSurface(<Card title="Case 41823" selected />);
    expect(screen.getByRole("article", { name: "Case 41823" })).toHaveAttribute(
      "data-selected",
      "true",
    );
  });

  it("stamps an identity on the title so a panel can anchor to it", () => {
    const { container } = renderSurface(<Card title="Case 41823" identity="case-41823" />);
    expect(container.querySelector('[data-pv-identity="case-41823"]')).toHaveTextContent(
      "Case 41823",
    );
  });

  it("spends no blur budget unless it is a summary card", () => {
    const { container } = renderSurface(<Card title="Recovery">Body</Card>);
    expect(container.querySelector(".pv-card")).not.toHaveClass("pv-glass");
  });

  it("has no accessibility violations in any state", async () => {
    const { container } = renderSurface(
      <>
        <Card title="Default" eyebrow="Collections" footer="vs. prior 30 days">
          Body
        </Card>
        <Card title="Interactive" onActivate={() => {}} />
        <Card title="Loading" loading />
        <Card title="Error" error="Reference 8f2a41." />
        <Card title="Empty" empty="Nothing yet." />
        <Card title="Read-only" readOnly>
          M. Delgado
        </Card>
        <Card title="Disabled" onActivate={() => {}} disabled />
        <Card title="Selected" selected />
      </>,
    );

    await expectNoAccessibilityViolations(container);
  });
});
