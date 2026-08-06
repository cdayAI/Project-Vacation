import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { ROUTES, breadcrumbFor } from "../routes";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { TopBar } from "./TopBar";

/**
 * The bar's two toggles name the regions they control, and in the shell those
 * regions are its siblings. Rendered here as stubs so `aria-controls` points at
 * something real — an id that is not in the document is a broken reference,
 * which is both a real defect and the thing axe would otherwise report.
 */
function Regions() {
  return (
    <>
      <div id="primary-navigation" />
      <div id="context-panel" />
    </>
  );
}

function mount(overrides: Partial<Parameters<typeof TopBar>[0]> = {}) {
  const route = ROUTES.find((entry) => entry.id === "approvals");
  return renderSurface(
    <>
      <Regions />
      <TopBar
      breadcrumb={breadcrumbFor(route ?? null, {})}
      onOpenPalette={() => {}}
      paletteTriggerRef={createRef<HTMLButtonElement>()}
      railCollapsed={false}
      railIsChoice
      onToggleRail={() => {}}
      panelCollapsed={false}
      onTogglePanel={() => {}}
      actorName="Dana Whitfield"
      actorRoles={["owner_services_supervisor"]}
      onShowShortcuts={() => {}}
        surfaceClassName="pv-glass"
        {...overrides}
      />
    </>,
  );
}

describe("the top bar", () => {
  it("is the page's banner", () => {
    mount();
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });

  it("says where you are", () => {
    mount();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Approvals");
  });

  it("carries a command trigger that prints its own shortcut", () => {
    // A button that says what it does, not a search field: this console's
    // search is always the search of a screen, and the palette is how you
    // leave. Printing the keys on it is what teaches the model.
    mount();
    const trigger = screen.getByRole("button", { name: "Search or run a command" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent("Ctrl K");
  });

  it("opens the palette from the trigger", async () => {
    const user = userEvent.setup();
    const onOpenPalette = vi.fn();
    mount({ onOpenPalette });

    await user.click(screen.getByRole("button", { name: "Search or run a command" }));
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it("toggles the rail and says what state it is in", async () => {
    const user = userEvent.setup();
    const onToggleRail = vi.fn();
    mount({ onToggleRail });

    const toggle = screen.getByRole("button", { name: "Collapse navigation" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "primary-navigation");

    await user.click(toggle);
    expect(onToggleRail).toHaveBeenCalledTimes(1);
  });

  it("offers to expand the rail when it is collapsed", () => {
    mount({ railCollapsed: true });
    expect(screen.getByRole("button", { name: "Expand navigation" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("refuses the rail toggle where there is no room, rather than disabling it", async () => {
    // `disabled` takes the control out of the tab order, so an operator tabbing
    // the bar finds a missing button rather than one that explains itself.
    const user = userEvent.setup();
    const onToggleRail = vi.fn();
    mount({ railIsChoice: false, railCollapsed: true, onToggleRail });

    const toggle = screen.getByRole("button", { name: "Expand navigation" });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).not.toBeDisabled();

    await user.click(toggle);
    expect(onToggleRail).not.toHaveBeenCalled();
  });

  it("toggles the context panel", async () => {
    const user = userEvent.setup();
    const onTogglePanel = vi.fn();
    mount({ onTogglePanel });

    const toggle = screen.getByRole("button", { name: "Hide the context panel" });
    expect(toggle).toHaveAttribute("aria-controls", "context-panel");
    await user.click(toggle);
    expect(onTogglePanel).toHaveBeenCalledTimes(1);
  });

  it("carries the bell and the avatar", () => {
    mount();
    expect(screen.getByRole("button", { name: /Notifications/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Signed in as Dana Whitfield/ })).toBeInTheDocument();
  });

  it("passes an auditor's read-only state through to the account panel", async () => {
    const user = userEvent.setup();
    mount({ readOnly: true });
    await user.click(screen.getByRole("button", { name: /Signed in as/ }));
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = mount();
    await expectNoAccessibilityViolations(container);
  });
});
