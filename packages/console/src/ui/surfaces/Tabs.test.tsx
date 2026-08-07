import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Tabs, type TabDefinition } from "./Tabs";

const STAGES: readonly TabDefinition[] = [
  { id: "current", label: "Current" },
  { id: "draft", label: "Draft" },
  { id: "diff", label: "Diff", count: 3, countDescription: "changes" },
  { id: "impact", label: "Impact", disabled: true, disabledReason: "run the diff first" },
];

function Harness({
  activation,
  initial = "current",
}: {
  readonly activation?: "manual" | "automatic";
  readonly initial?: string;
}) {
  const [activeId, setActiveId] = useState(initial);
  return (
    <Tabs
      label="Configuration stages"
      tabs={STAGES}
      activeId={activeId}
      onActiveIdChange={setActiveId}
      activation={activation}
    >
      Panel for {activeId}
    </Tabs>
  );
}

describe("Tabs", () => {
  it("names the tab list after what it switches between", () => {
    renderSurface(<Harness />);
    expect(screen.getByRole("tablist", { name: "Configuration stages" })).toBeInTheDocument();
  });

  it("marks the selected tab as selected and ties it to the panel", () => {
    renderSurface(<Harness />);

    const current = screen.getByRole("tab", { name: /Current/ });
    expect(current).toHaveAttribute("aria-selected", "true");

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", current.id);
    expect(current).toHaveAttribute("aria-controls", panel.id);
  });

  it("keeps exactly one tab in the tab order", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);

    await user.tab();
    expect(screen.getByRole("tab", { name: /Current/ })).toHaveFocus();

    // The next Tab leaves the list rather than walking every tab in it.
    await user.tab();
    expect(screen.getByRole("tabpanel")).toHaveFocus();
  });

  describe("manual activation", () => {
    it("moves focus with the arrows without switching panels", async () => {
      // Arrowing through a stage list that fetches would fire three requests
      // the operator did not ask for.
      const user = userEvent.setup();
      renderSurface(<Harness />);

      screen.getByRole("tab", { name: /Current/ }).focus();
      await user.keyboard("{ArrowRight}");

      expect(screen.getByRole("tab", { name: /Draft/ })).toHaveFocus();
      expect(screen.getByRole("tab", { name: /Current/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    it("switches on Enter", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);

      screen.getByRole("tab", { name: /Current/ }).focus();
      await user.keyboard("{ArrowRight}{Enter}");

      expect(screen.getByRole("tab", { name: /Draft/ })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel for draft");
    });

    it("switches on Space", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);

      screen.getByRole("tab", { name: /Current/ }).focus();
      await user.keyboard("{ArrowRight} ");

      expect(screen.getByRole("tab", { name: /Draft/ })).toHaveAttribute("aria-selected", "true");
    });
  });

  describe("automatic activation", () => {
    it("switches as focus moves", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness activation="automatic" />);

      screen.getByRole("tab", { name: /Current/ }).focus();
      await user.keyboard("{ArrowRight}");

      expect(screen.getByRole("tab", { name: /Draft/ })).toHaveAttribute("aria-selected", "true");
    });

    it("still refuses to switch to a disabled tab", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness activation="automatic" initial="diff" />);

      screen.getByRole("tab", { name: /Diff/ }).focus();
      await user.keyboard("{ArrowRight}");

      expect(screen.getByRole("tab", { name: /Impact/ })).toHaveFocus();
      expect(screen.getByRole("tab", { name: /Diff/ })).toHaveAttribute("aria-selected", "true");
    });
  });

  describe("arrow navigation", () => {
    it("wraps at both ends", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);

      screen.getByRole("tab", { name: /Current/ }).focus();
      await user.keyboard("{ArrowLeft}");
      expect(screen.getByRole("tab", { name: /Impact/ })).toHaveFocus();

      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("tab", { name: /Current/ })).toHaveFocus();
    });

    it("jumps to the ends with Home and End", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);

      screen.getByRole("tab", { name: /Current/ }).focus();
      await user.keyboard("{End}");
      expect(screen.getByRole("tab", { name: /Impact/ })).toHaveFocus();

      await user.keyboard("{Home}");
      expect(screen.getByRole("tab", { name: /Current/ })).toHaveFocus();
    });
  });

  describe("a disabled tab", () => {
    it("stays reachable and says why", () => {
      // A tab an operator cannot focus is a tab they cannot find out about.
      renderSurface(<Harness />);

      const tab = screen.getByRole("tab", { name: /Impact/ });
      expect(tab).toHaveAttribute("aria-disabled", "true");
      expect(tab).not.toHaveAttribute("disabled");
      expect(tab).toHaveAccessibleName(/unavailable: run the diff first/);
    });

    it("does nothing when clicked", async () => {
      const user = userEvent.setup();
      const onActiveIdChange = vi.fn();
      renderSurface(
        <Tabs
          label="Configuration stages"
          tabs={STAGES}
          activeId="current"
          onActiveIdChange={onActiveIdChange}
        >
          Body
        </Tabs>,
      );

      await user.click(screen.getByRole("tab", { name: /Impact/ }));
      expect(onActiveIdChange).not.toHaveBeenCalled();
    });
  });

  it("shows a count in tabular figures with a described unit", () => {
    renderSurface(<Harness />);
    const diff = screen.getByRole("tab", { name: /Diff/ });
    expect(diff).toHaveAccessibleName("Diff 3 changes");
    expect(diff.querySelector(".pv-tab-count")).toHaveAttribute("data-numeric");
  });

  it("says once that the whole surface is read-only", () => {
    renderSurface(
      <Tabs
        label="Configuration stages"
        tabs={STAGES}
        activeId="current"
        onActiveIdChange={() => {}}
        readOnly
      >
        Body
      </Tabs>,
    );
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("keeps a usable tab stop when the active id is unknown", () => {
    // A tablist with no valid stop traps Tab.
    renderSurface(
      <Tabs label="Stages" tabs={STAGES} activeId="gone" onActiveIdChange={() => {}}>
        Body
      </Tabs>,
    );
    expect(screen.getByRole("tab", { name: /Current/ })).toHaveAttribute("tabindex", "0");
  });

  it("renders the panel's designed states", () => {
    renderSurface(
      <Tabs label="Stages" tabs={STAGES} activeId="current" onActiveIdChange={() => {}} loading>
        Body
      </Tabs>,
    );
    expect(screen.getByText("Loading")).toHaveClass("pv-sr-only");
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<Harness />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when read-only and erroring", async () => {
    const { container } = renderSurface(
      <Tabs
        label="Stages"
        tabs={STAGES}
        activeId="current"
        onActiveIdChange={() => {}}
        readOnly
        error="Reference 8f2a41."
      >
        Body
      </Tabs>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
