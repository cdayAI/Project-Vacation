import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import type { ListOption } from "./listbox";
import { Select } from "./Select";

const STATUSES: readonly ListOption[] = [
  { value: "open", label: "Open" },
  { value: "parked", label: "Parked", description: "Waiting on an approval" },
  { value: "pending", label: "Pending review" },
  { value: "posted", label: "Posted" },
  { value: "closed", label: "Closed" },
];

function Harness({
  initial = null,
  options = STATUSES,
  onChange,
  ...rest
}: {
  readonly initial?: string | null;
  readonly options?: readonly ListOption[];
  readonly onChange?: (value: string) => void;
  readonly required?: boolean;
  readonly readOnly?: boolean;
  readonly error?: string;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <Select
      label="Status"
      options={options}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      {...rest}
    />
  );
}

function trigger() {
  return screen.getByRole("combobox", { name: "Status" });
}

describe("Select", () => {
  it("carries no accessibility violations, closed and open", async () => {
    const user = userEvent.setup();
    const { container } = renderSurface(
      <>
        <Harness />
        <Harness initial="parked" readOnly />
        <Harness error="Choose a status before saving." />
        <Select label="Empty" options={[]} value={null} onChange={() => {}} />
      </>,
    );
    await expectNoAccessibilityViolations(container);

    await user.click(screen.getAllByRole("combobox", { name: "Status" })[0] as HTMLElement);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await expectNoAccessibilityViolations(container);
  });

  it("publishes its expanded state and the option the keyboard is on", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).not.toHaveAttribute("aria-activedescendant");

    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    const active = trigger().getAttribute("aria-activedescendant");
    expect(active).not.toBeNull();
    // The id must point at a rendered option, or assistive technology follows a
    // reference to nothing and announces silence.
    expect(document.getElementById(active ?? "")).toHaveAccessibleName(/Open/);
  });

  it("never moves focus off the trigger, so the list cannot trap it", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.click(trigger());
    expect(trigger()).toHaveFocus();

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(trigger()).toHaveFocus();
  });

  it("wraps when the keyboard arrows past either end", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.click(trigger());

    // Down five times from the first option runs off the end and comes back.
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(activeLabel()).toBe("Closed");
    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Open");
    await user.keyboard("{ArrowUp}");
    expect(activeLabel()).toBe("Closed");
  });

  it("jumps to the first and last option with Home and End", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.click(trigger());
    await user.keyboard("{End}");
    expect(activeLabel()).toBe("Closed");
    await user.keyboard("{Home}");
    expect(activeLabel()).toBe("Open");
  });

  it("commits with Enter and closes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenCalledWith("parked");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveTextContent("Parked");
  });

  it("closes on Escape, keeps the committed value, and keeps the focus", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness initial="open" onChange={onChange} />);
    await user.click(trigger());
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveTextContent("Open");
    expect(trigger()).toHaveFocus();
  });

  it("commits on the way out with Tab, the way a native select does", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.keyboard("{ArrowDown}");
    await user.tab();

    expect(onChange).toHaveBeenCalledWith("parked");
    expect(trigger()).not.toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("decides nothing when focus is lost mid-selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(
      <>
        <Harness onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.click(trigger());
    await user.keyboard("{ArrowDown}{ArrowDown}");
    // Clicking away is not a decision. The list closes and nothing is stored.
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves the active option by type-ahead without committing anything", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness onChange={onChange} />);
    trigger().focus();

    await user.keyboard("c");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(activeLabel()).toBe("Closed");
    // A stray keystroke on a native select silently changes the value. Here
    // nothing is decided until the operator says so.
    expect(onChange).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("closed");
  });

  it("cycles through the options that share a first letter", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    trigger().focus();

    await user.keyboard("p");
    expect(activeLabel()).toBe("Parked");
    await user.keyboard("p");
    expect(activeLabel()).toBe("Pending review");
    await user.keyboard("p");
    expect(activeLabel()).toBe("Posted");
  });

  it("skips an option the operator is not allowed to choose", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(
      <Harness
        options={[
          { value: "open", label: "Open" },
          { value: "sealed", label: "Sealed", disabled: true },
          { value: "closed", label: "Closed" },
        ]}
        onChange={onChange}
      />,
    );
    await user.click(trigger());
    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Closed");

    await user.click(screen.getByRole("option", { name: /Sealed/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("commits a click on an option instead of losing it to the blur", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness onChange={onChange} />);
    await user.click(trigger());
    // The classic failure: pressing the pointer blurs the trigger, the blur
    // closes the list, and the click lands on nothing.
    await user.click(screen.getByRole("option", { name: /Posted/ }));
    expect(onChange).toHaveBeenCalledWith("posted");
  });

  it("opens on the value it already holds, not on the top of the list", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness initial="posted" />);
    await user.click(trigger());
    expect(activeLabel()).toBe("Posted");
  });

  it("marks the chosen option as selected for assistive technology", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness initial="parked" />);
    await user.click(trigger());
    const list = screen.getByRole("listbox");
    expect(within(list).getByRole("option", { selected: true })).toHaveAccessibleName(/Parked/);
  });

  it("states the empty case in the field rather than opening an empty popup", async () => {
    const user = userEvent.setup();
    renderSurface(
      <Select
        label="Reason"
        options={[]}
        value={null}
        onChange={() => {}}
        emptyMessage="No reason codes are configured yet."
      />,
    );
    const control = screen.getByRole("combobox", { name: "Reason" });
    expect(control).toHaveTextContent("No reason codes are configured yet.");
    expect(control).toHaveAttribute("aria-disabled", "true");

    await user.click(control);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(control).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the value as a read-only field with no trigger at all", () => {
    renderSurface(<Harness initial="parked" readOnly />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveValue("Parked");
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });
});

function activeLabel(): string {
  const id = trigger().getAttribute("aria-activedescendant");
  const option = id === null ? null : document.getElementById(id);
  return option?.querySelector(".pv-ui-listbox-label")?.textContent ?? "";
}
