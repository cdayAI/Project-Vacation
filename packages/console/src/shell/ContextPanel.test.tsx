import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { ContextPanel, type ContextPanelProps } from "./ContextPanel";
import { PANEL_WIDTH_DEFAULT, PANEL_WIDTH_MAX, PANEL_WIDTH_MIN } from "./layout";

function mount(overrides: Partial<ContextPanelProps> = {}) {
  return renderSurface(
    <ContextPanel
      title="Case 41823"
      mode="docked"
      collapsed={false}
      width={PANEL_WIDTH_DEFAULT}
      onCollapsedChange={() => {}}
      onWidthChange={() => {}}
      onWidthCommit={() => {}}
      {...overrides}
    />,
  );
}

/** A panel whose collapse the test can drive, the way the shell drives it. */
function Controlled({ children }: { readonly children?: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [focusSignal, setFocusSignal] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setFocusSignal((current) => current + 1)}>
        Focus the copilot
      </button>
      <ContextPanel
        title="Case 41823"
        mode="docked"
        collapsed={collapsed}
        width={PANEL_WIDTH_DEFAULT}
        onCollapsedChange={setCollapsed}
        onWidthChange={() => {}}
        onWidthCommit={() => {}}
        focusSignal={focusSignal}
      >
        {children}
      </ContextPanel>
    </>
  );
}

describe("the context panel", () => {
  it("is the region the top bar's toggle names", () => {
    const { container } = mount();
    expect(container.querySelector("#context-panel")).not.toBeNull();
  });

  it("names what it is showing rather than calling itself Context", () => {
    mount();
    expect(screen.getByRole("heading", { name: /Case 41823/ })).toBeInTheDocument();
  });

  it("holds whatever the route gives it", () => {
    mount({ children: <p>Owner M. Delgado · contract 8841</p> });
    expect(screen.getByText("Owner M. Delgado · contract 8841")).toBeInTheDocument();
  });

  it("draws a designed empty state when a route gives it nothing", () => {
    mount();
    expect(screen.getByText("Nothing is selected.")).toBeInTheDocument();
    expect(screen.getByText(/The copilot answers from whatever this panel can see/)).toBeInTheDocument();
  });

  it("resizes with the keyboard as well as with a drag", async () => {
    // Resizing is the affordance most often shipped pointer-only, and it is the
    // one an operator with no pointer needs most.
    const user = userEvent.setup();
    const onWidthChange = vi.fn();
    const onWidthCommit = vi.fn();
    mount({ onWidthChange, onWidthCommit });

    const separator = screen.getByRole("separator", { name: "Context panel width" });
    expect(separator).toHaveAttribute("aria-valuemin", String(PANEL_WIDTH_MIN));
    expect(separator).toHaveAttribute("aria-valuemax", String(PANEL_WIDTH_MAX));

    separator.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onWidthChange).toHaveBeenCalled();
    // Committed per keypress: an operator who resizes and then navigates away
    // with the keyboard never blurs the handle in a way we would see.
    expect(onWidthCommit).toHaveBeenCalled();
  });

  it("widens when the handle is dragged toward the middle of the screen", async () => {
    const user = userEvent.setup();
    const onWidthChange = vi.fn();
    mount({ onWidthChange });

    const separator = screen.getByRole("separator", { name: "Context panel width" });
    separator.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onWidthChange.mock.calls[0]?.[0]).toBeGreaterThan(PANEL_WIDTH_DEFAULT);
  });

  it("collapses to a strip that still holds the way back", async () => {
    const user = userEvent.setup();
    const onCollapsedChange = vi.fn();
    mount({ collapsed: true, onCollapsedChange });

    const expand = screen.getByRole("button", { name: "Show the context panel" });
    await user.click(expand);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("becomes an overlay sheet below 900, with a way out", async () => {
    const user = userEvent.setup();
    const onCollapsedChange = vi.fn();
    mount({ mode: "overlay", onCollapsedChange });

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
  });

  it("keeps the region in the document while the overlay is closed", () => {
    // Otherwise the top bar's `aria-controls` points at nothing on a small
    // screen, which is a broken reference rather than a missing panel.
    const { container } = mount({ mode: "overlay", collapsed: true });
    expect(container.querySelector("#context-panel")).not.toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("moves focus into the body when the copilot verb is pressed", async () => {
    const user = userEvent.setup();
    renderSurface(
      <Controlled>
        <textarea aria-label="Ask the copilot" />
      </Controlled>,
    );

    await user.click(screen.getByRole("button", { name: "Focus the copilot" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Ask the copilot" })).toHaveFocus(),
    );
  });

  it("does not land on the panel's own collapse button", async () => {
    // The collapse control is the panel's first tabbable element. A "focus the
    // copilot" verb that lands on "collapse the panel" is worse than one that
    // does nothing, because the next keystroke closes the panel.
    const user = userEvent.setup();
    renderSurface(
      <Controlled>
        <textarea aria-label="Ask the copilot" />
      </Controlled>,
    );

    await user.click(screen.getByRole("button", { name: "Focus the copilot" }));
    await waitFor(() =>
      expect(document.activeElement).not.toBe(screen.getByRole("button", { name: /Case 41823/ })),
    );
  });

  it("shows the read-only chip for an auditor", () => {
    mount({ readOnly: true });
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("says the word Error when its content failed to load", () => {
    mount({ error: "We could not reach the record store. Reference 8f2a41." });
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText(/Reference 8f2a41/)).toBeInTheDocument();
  });

  it("announces itself busy while loading", () => {
    const { container } = mount({ loading: true });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("has no accessibility violations", async () => {
    const { container } = mount({ children: <p>Owner M. Delgado</p> });
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations collapsed", async () => {
    const { container } = mount({ collapsed: true });
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations as an overlay", async () => {
    const { baseElement } = mount({ mode: "overlay" });
    await expectNoAccessibilityViolations(baseElement);
  });
});
