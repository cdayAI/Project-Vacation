import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Panel } from "./Panel";

describe("Panel", () => {
  it("names its region with its title", () => {
    renderSurface(<Panel title="Record context">Owner M. Delgado</Panel>);
    expect(screen.getByRole("region", { name: "Record context" })).toBeInTheDocument();
  });

  it("puts a description under the title without turning it into the name", () => {
    renderSurface(
      <Panel title="Record context" description="What the copilot can see right now.">
        Body
      </Panel>,
    );

    expect(screen.getByRole("region", { name: "Record context" })).toBeInTheDocument();
    expect(screen.getByText("What the copilot can see right now.")).toBeInTheDocument();
  });

  describe("collapsing", () => {
    it("exposes the collapse as an expandable control over the whole title", async () => {
      const user = userEvent.setup();
      renderSurface(
        <Panel title="Evidence" collapsible>
          <a href="/evidence/1">FL §721.10</a>
        </Panel>,
      );

      const toggle = screen.getByRole("button", { name: "Evidence", expanded: true });
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    it("hides rather than unmounts, so expanding does not refetch", async () => {
      const user = userEvent.setup();
      const { container } = renderSurface(
        <Panel title="Evidence" collapsible>
          <a href="/evidence/1">FL §721.10</a>
        </Panel>,
      );

      await user.click(screen.getByRole("button", { name: "Evidence" }));

      const body = container.querySelector(".pv-panel-body");
      expect(body).toHaveAttribute("hidden");
      // Still in the DOM, and out of the tab order because of `hidden` — which
      // a max-height collapse notoriously fails to do.
      expect(body?.querySelector("a")).not.toBeNull();
      expect(screen.queryByRole("link", { name: "FL §721.10" })).toBeNull();
    });

    it("starts collapsed when asked", () => {
      renderSurface(
        <Panel title="Evidence" collapsible defaultCollapsed>
          Body
        </Panel>,
      );
      expect(screen.getByRole("button", { name: "Evidence" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("can be driven from outside", async () => {
      const user = userEvent.setup();
      const onCollapsedChange = vi.fn();
      renderSurface(
        <Panel title="Evidence" collapsible collapsed={false} onCollapsedChange={onCollapsedChange}>
          Body
        </Panel>,
      );

      await user.click(screen.getByRole("button", { name: "Evidence" }));
      expect(onCollapsedChange).toHaveBeenCalledWith(true);
      // Controlled: nothing moves until the caller says so.
      expect(screen.getByRole("button", { name: "Evidence" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    it("offers no toggle when it is not collapsible", () => {
      renderSurface(<Panel title="Evidence">Body</Panel>);
      expect(screen.queryByRole("button", { name: "Evidence" })).toBeNull();
    });
  });

  describe("resizing", () => {
    it("offers a keyboard-operable separator", async () => {
      const user = userEvent.setup();
      const onWidthChange = vi.fn();
      renderSurface(
        <Panel
          title="Copilot"
          resize={{
            label: "Context panel width",
            width: 380,
            min: 320,
            max: 520,
            edge: "inline-start",
            onWidthChange,
          }}
        >
          Body
        </Panel>,
      );

      const handle = screen.getByRole("separator", { name: "Context panel width" });
      handle.focus();
      // The panel is on the right, so dragging left widens it — and the arrow
      // keys have to agree with the drag.
      await user.keyboard("{ArrowLeft}");
      expect(onWidthChange).toHaveBeenCalledWith(388);
    });

    it("applies the caller's width rather than remembering one", () => {
      const { container } = renderSurface(
        <Panel
          title="Copilot"
          resize={{ label: "w", width: 420, min: 320, max: 520, onWidthChange: vi.fn() }}
        >
          Body
        </Panel>,
      );

      expect(container.querySelector(".pv-panel")).toHaveStyle({ inlineSize: "420px" });
    });

    it("offers no separator when it is not resizable", () => {
      renderSurface(<Panel title="Copilot">Body</Panel>);
      expect(screen.queryByRole("separator")).toBeNull();
    });
  });

  describe("designed states", () => {
    it("announces loading", () => {
      const { container } = renderSurface(
        <Panel title="Timeline" loading>
          Body
        </Panel>,
      );
      expect(container.querySelector(".pv-surface-loading")).toHaveAttribute("aria-busy", "true");
      expect(screen.getByText("Loading")).toHaveClass("pv-sr-only");
    });

    it("states an error in words", () => {
      renderSurface(
        <Panel title="Timeline" error="We could not reach the loan servicing system.">
          Body
        </Panel>,
      );
      expect(screen.getByText("Error")).toBeInTheDocument();
    });

    it("marks read-only and drops the actions", () => {
      renderSurface(
        <Panel title="Owner record" readOnly actions={<button type="button">Edit</button>}>
          M. Delgado
        </Panel>,
      );
      expect(screen.getByText("Read-only")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    });
  });

  it("only asks for glass when told to", () => {
    const { container } = renderSurface(<Panel title="Plain">Body</Panel>);
    expect(container.querySelector(".pv-panel")).not.toHaveClass("pv-glass");
  });

  it("puts its text on a scrim when it is glass", () => {
    // Text on glass sits on a solid child, or its contrast is whatever
    // happened to scroll underneath it (spec §1.5 rule 1).
    const { container } = renderSurface(
      <Panel title="Copilot" glass>
        Body
      </Panel>,
    );
    expect(container.querySelector(".pv-panel-body")).toHaveClass("pv-glass-scrim");
  });

  it("has no accessibility violations in any state", async () => {
    const { container } = renderSurface(
      <>
        <Panel title="Default" description="Context." footer="Updated 2 minutes ago">
          Body
        </Panel>
        <Panel title="Collapsible" collapsible>
          Body
        </Panel>
        <Panel title="Collapsed" collapsible defaultCollapsed>
          Body
        </Panel>
        <Panel title="Loading" loading>
          Body
        </Panel>
        <Panel title="Error" error="Reference 8f2a41.">
          Body
        </Panel>
        <Panel title="Read-only" readOnly>
          Body
        </Panel>
        <Panel
          title="Resizable"
          resize={{ label: "Panel width", width: 380, min: 320, max: 520, onWidthChange: () => {} }}
        >
          Body
        </Panel>
      </>,
    );

    await expectNoAccessibilityViolations(container);
  });
});
