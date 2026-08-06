import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { GlassBudgetProvider, useVirtualScrollerRegistration } from "./glassSurface";
import { Popover, popoverTriggerProps } from "./Popover";

function Harness({ withTable = false }: { readonly withTable?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        type="button"
        ref={anchor}
        onClick={() => setOpen((current) => !current)}
        {...popoverTriggerProps("filters-popover", open)}
      >
        Filters
      </button>
      {withTable ? <FakeVirtualTable /> : null}
      <Popover
        id="filters-popover"
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        title="Filter cases"
      >
        <button type="button">Breaching only</button>
        <button type="button">Unassigned</button>
      </Popover>
    </>
  );
}

function FakeVirtualTable() {
  useVirtualScrollerRegistration();
  return <div data-testid="table" />;
}

describe("Popover", () => {
  it("renders nothing while closed", () => {
    renderSurface(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives the trigger the relationship it owes the surface", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    const trigger = screen.getByRole("button", { name: "Filters" });

    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Nothing to control until it exists: a dangling reference is announced by
    // some screen readers and ignored by others, which is worse than both.
    expect(trigger).not.toHaveAttribute("aria-controls");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", "filters-popover");
  });

  it("names itself with its heading", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.click(screen.getByRole("button", { name: "Filters" }));

    expect(screen.getByRole("dialog", { name: "Filter cases" })).toBeInTheDocument();
  });

  it("is not modal — the page behind stays live", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.click(screen.getByRole("button", { name: "Filters" }));

    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-modal");
  });

  it("moves focus in and returns it to the trigger", async () => {
    // It lives at the end of the document, so without this a keyboard operator
    // tabs out of it and lands nowhere they can explain.
    const user = userEvent.setup();
    renderSurface(<Harness />);
    const trigger = screen.getByRole("button", { name: "Filters" });

    await user.click(trigger);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Breaching only" })).toHaveFocus(),
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps Tab inside while it is open", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.click(screen.getByRole("button", { name: "Filters" }));

    screen.getByRole("button", { name: "Unassigned" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Breaching only" })).toHaveFocus();
  });

  it("closes on a press outside itself", async () => {
    const user = userEvent.setup();
    renderSurface(
      <>
        <Harness />
        <button type="button">Somewhere else</button>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Filters" }));

    await user.click(screen.getByRole("button", { name: "Somewhere else" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("leaves a press on the trigger to the trigger, so it can toggle", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    const trigger = screen.getByRole("button", { name: "Filters" });

    await user.click(trigger);
    await user.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("positions itself against its anchor", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.click(screen.getByRole("button", { name: "Filters" }));

    const surface = screen.getByRole("dialog");
    expect(surface).toHaveAttribute("data-state", "open");
    expect(surface.style.top).not.toBe("");
    expect(surface.style.left).not.toBe("");
  });

  it("stays unpositioned when there is no anchor to position against", () => {
    // Nothing to attach to is a caller error, and guessing a position would
    // hide it. It waits, visibly inert, rather than landing somewhere invented.
    renderSurface(
      <Popover id="p" open onClose={() => {}} anchorRef={{ current: null }} title="Filter cases">
        Body
      </Popover>,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "measuring");
  });

  it("renders solid over a virtualized table, and glass without one", async () => {
    // Spec §1.5: never blur behind a scrolling virtualized list. A popover
    // cannot stop the list underneath it, so it does not blur over one.
    const user = userEvent.setup();
    const { rerender } = renderSurface(
      <GlassBudgetProvider>
        <Harness withTable />
      </GlassBudgetProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("dialog")).toHaveClass("pv-overlay-solid");

    await user.keyboard("{Escape}");
    rerender(
      <GlassBudgetProvider>
        <Harness />
      </GlassBudgetProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("dialog")).toHaveClass("pv-glass");
  });

  describe("designed states", () => {
    it("shows a loading body", () => {
      const anchor = { current: null };
      renderSurface(
        <Popover id="p" open onClose={() => {}} anchorRef={anchor} title="Filter cases" loading />,
      );
      expect(screen.getByText("Loading")).toHaveClass("pv-sr-only");
    });

    it("states an error in words", () => {
      const anchor = { current: null };
      renderSurface(
        <Popover
          id="p"
          open
          onClose={() => {}}
          anchorRef={anchor}
          title="Filter cases"
          error="Reference 8f2a41."
        />,
      );
      expect(screen.getByText("Error")).toBeInTheDocument();
    });

    it("marks read-only", () => {
      const anchor = { current: null };
      renderSurface(
        <Popover id="p" open onClose={() => {}} anchorRef={anchor} title="Saved view" readOnly>
          Body
        </Popover>,
      );
      expect(screen.getByText("Read-only")).toBeInTheDocument();
    });

    it("takes an accessible name without a visible heading", () => {
      const anchor = { current: null };
      renderSurface(
        <Popover id="p" open onClose={() => {}} anchorRef={anchor} label="Column chooser">
          Body
        </Popover>,
      );
      expect(screen.getByRole("dialog", { name: "Column chooser" })).toBeInTheDocument();
    });
  });

  it("has no accessibility violations", async () => {
    const user = userEvent.setup();
    const { baseElement } = renderSurface(<Harness />);
    await user.click(screen.getByRole("button", { name: "Filters" }));

    await expectNoAccessibilityViolations(baseElement);
  });
});
