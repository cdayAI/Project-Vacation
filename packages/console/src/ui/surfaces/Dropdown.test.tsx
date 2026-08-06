import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Dropdown, dropdownTriggerProps, type DropdownItem } from "./Dropdown";

function makeItems(onSelect: () => void): readonly DropdownItem[] {
  return [
    { id: "open", label: "Open case", shortcut: "Enter", onSelect },
    { id: "assign", label: "Assign to me", onSelect },
    {
      id: "escalate",
      label: "Escalate",
      description: "Sends this to a supervisor now.",
      onSelect,
    },
    {
      id: "hold",
      label: "Place on hold",
      disabled: true,
      disabledReason: "the statutory clock is running",
      onSelect,
    },
    {
      id: "revoke",
      label: "Revoke credentials",
      destructive: true,
      separatorBefore: true,
      onSelect,
    },
  ];
}

function Harness({ onSelect = () => {} }: { readonly onSelect?: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        type="button"
        ref={anchor}
        onClick={() => setOpen((current) => !current)}
        {...dropdownTriggerProps("row-actions", open)}
      >
        Row actions
      </button>
      <Dropdown
        id="row-actions"
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        label="Row actions"
        items={makeItems(onSelect)}
      />
    </>
  );
}

/** An always-open menu with a real, laid-out anchor. */
function AnchoredMenu({
  items,
  onClose = () => {},
}: {
  readonly items: readonly DropdownItem[];
  readonly onClose?: () => void;
}) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button type="button" ref={anchor}>
        Row actions
      </button>
      <Dropdown
        id="row-actions"
        open
        onClose={onClose}
        anchorRef={anchor}
        label="Row actions"
        items={items}
      />
    </>
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Row actions" }));
  await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
}

describe("Dropdown", () => {
  it("renders nothing while closed", () => {
    renderSurface(<Harness />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("gives the trigger the relationship it owes the menu", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    const trigger = screen.getByRole("button", { name: "Row actions" });

    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await openMenu(user);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", "row-actions");
  });

  it("names the menu after what it acts on", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await openMenu(user);
    expect(screen.getByRole("menu", { name: "Row actions" })).toBeInTheDocument();
  });

  it("focuses the first item immediately", async () => {
    // A menu you have to arrow into once before the arrows do anything is a
    // menu that feels broken.
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await openMenu(user);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Open case/ })).toHaveFocus());
  });

  describe("keyboard", () => {
    it("moves with the arrows and wraps", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);
      await openMenu(user);

      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("menuitem", { name: "Assign to me" })).toHaveFocus();

      await user.keyboard("{ArrowUp}{ArrowUp}");
      expect(screen.getByRole("menuitem", { name: /Revoke credentials/ })).toHaveFocus();
    });

    it("jumps to the ends with Home and End", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);
      await openMenu(user);

      await user.keyboard("{End}");
      expect(screen.getByRole("menuitem", { name: /Revoke credentials/ })).toHaveFocus();

      await user.keyboard("{Home}");
      expect(screen.getByRole("menuitem", { name: /Open case/ })).toHaveFocus();
    });

    it("jumps to an item by typing its first letters", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);
      await openMenu(user);

      await user.keyboard("es");
      expect(screen.getByRole("menuitem", { name: /Escalate/ })).toHaveFocus();
    });

    it("chooses with Enter", async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      renderSurface(<Harness onSelect={onSelect} />);
      await openMenu(user);

      await user.keyboard("{ArrowDown}{Enter}");
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("closes on Escape and returns focus to the trigger", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);
      const trigger = screen.getByRole("button", { name: "Row actions" });
      await openMenu(user);

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(trigger).toHaveFocus();
    });

    it("closes on Tab rather than walking into the end of the document", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);
      const trigger = screen.getByRole("button", { name: "Row actions" });
      await openMenu(user);

      await user.tab();
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(trigger).toHaveFocus();
    });
  });

  describe("choosing", () => {
    it("closes before it runs the action", async () => {
      // An action that opens a sheet must not fight the menu for focus.
      const user = userEvent.setup();
      const order: string[] = [];
      renderSurface(
        <AnchoredMenu
          onClose={() => order.push("close")}
          items={[{ id: "a", label: "Open case", onSelect: () => order.push("select") }]}
        />,
      );

      await user.click(screen.getByRole("menuitem", { name: "Open case" }));
      expect(order).toEqual(["close", "select"]);
    });

    it("does nothing for a disabled item", async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      renderSurface(<Harness onSelect={onSelect} />);
      await openMenu(user);

      await user.click(screen.getByRole("menuitem", { name: /Place on hold/ }));
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  it("keeps a disabled item reachable and says why it is disabled", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await openMenu(user);

    const item = screen.getByRole("menuitem", { name: /Place on hold/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleName(/unavailable: the statutory clock is running/);
  });

  it("says a destructive item is destructive, rather than only colouring it", async () => {
    // The audit pack this ends up in is printed in black and white.
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await openMenu(user);

    const item = screen.getByRole("menuitem", { name: /Revoke credentials/ });
    expect(item).toHaveAttribute("data-destructive", "true");
    expect(item).toHaveAccessibleName(/destructive/);
  });

  it("separates a destructive tail with a rule", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await openMenu(user);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("shows a shortcut hint without claiming to bind it", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await openMenu(user);
    expect(screen.getByRole("menuitem", { name: /Open case/ })).toHaveTextContent("Enter");
  });

  it("closes on a press outside itself", async () => {
    const user = userEvent.setup();
    renderSurface(
      <>
        <Harness />
        <button type="button">Somewhere else</button>
      </>,
    );
    await openMenu(user);

    await user.click(screen.getByRole("button", { name: "Somewhere else" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  describe("designed states", () => {
    it("says why there is nothing to do rather than showing an empty box", () => {
      renderSurface(
        <Dropdown
          id="m"
          open
          onClose={() => {}}
          anchorRef={{ current: null }}
          label="Row actions"
          items={[]}
          empty="You cannot act on a closed case."
        />,
      );
      expect(screen.getByText("You cannot act on a closed case.")).toBeInTheDocument();
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("has a default for an empty menu, so it is never a blank rectangle", () => {
      renderSurface(
        <Dropdown
          id="m"
          open
          onClose={() => {}}
          anchorRef={{ current: null }}
          label="Row actions"
          items={[]}
        />,
      );
      expect(screen.getByText("No actions available.")).toBeInTheDocument();
    });

    it("shows a loading state", () => {
      renderSurface(
        <Dropdown
          id="m"
          open
          onClose={() => {}}
          anchorRef={{ current: null }}
          label="Row actions"
          items={[]}
          loading
        />,
      );
      expect(screen.getByText("Loading")).toHaveClass("pv-sr-only");
    });

    it("states an error in words", () => {
      renderSurface(
        <Dropdown
          id="m"
          open
          onClose={() => {}}
          anchorRef={{ current: null }}
          label="Row actions"
          items={[]}
          error="We could not load the actions for this row. Reference 8f2a41."
        />,
      );
      expect(screen.getByText("Error")).toBeInTheDocument();
    });
  });

  it("has no accessibility violations", async () => {
    // Scoped to the surface, which renders into a portal at the end of the
    // document. axe's "region" best-practice rule flags anything outside a
    // landmark and exempts dialogs but not menus; the menu is reached through
    // its trigger, and the trigger is inside the landmark.
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await openMenu(user);

    const surface = document.getElementById("row-actions");
    if (surface === null) throw new Error("the menu did not render");
    await expectNoAccessibilityViolations(surface);
  });
});
