import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { DatePicker } from "./DatePicker";
import { todayIso } from "./dates";

function Harness({
  initial = null,
  onChange,
  ...rest
}: {
  readonly initial?: string | null;
  readonly onChange?: (value: string | null) => void;
  readonly min?: string;
  readonly max?: string;
  readonly readOnly?: boolean;
  readonly referenceDate?: string;
  readonly label?: string;
}) {
  const [value, setValue] = useState<string | null>(initial);
  const { label = "Effective date", ...others } = rest;
  return (
    <DatePicker
      label={label}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      {...others}
    />
  );
}

function field(name = "Effective date") {
  return screen.getByLabelText(name);
}

describe("DatePicker", () => {
  it("carries no accessibility violations, closed and with the calendar open", async () => {
    const user = userEvent.setup();
    const { container } = renderSurface(
      <>
        <Harness initial="2026-06-12" />
        <Harness label="Locked" initial="2026-06-12" readOnly />
      </>,
    );
    await expectNoAccessibilityViolations(container);

    await user.click(screen.getByRole("button", { name: "Choose a date from the calendar" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await expectNoAccessibilityViolations(container);
  });

  it("says which formats it accepts", () => {
    renderSurface(<Harness />);
    expect(field()).toHaveAccessibleDescription(/12 Jun 2026 or 2026-06-12/);
  });

  it("commits a typed date as soon as it reads as one", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness onChange={onChange} referenceDate="2026-01-01" />);
    await user.type(field(), "12 Jun");
    expect(onChange).toHaveBeenLastCalledWith("2026-06-12");
  });

  it("does not complain about a half-written date", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.type(field(), "12 J");
    expect(screen.queryByText(/could not read/i)).not.toBeInTheDocument();
    expect(field()).not.toHaveAttribute("aria-invalid");
  });

  it("normalises what was typed into the one shape the console writes", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness referenceDate="2026-01-01" />);
    await user.type(field(), "jun 12 2026");
    await user.tab();
    expect(field()).toHaveValue("12 Jun 2026");
  });

  it("refuses a slashed date and says what to type instead", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness onChange={onChange} />);
    await user.type(field(), "12/06/2026");
    await user.tab();

    expect(onChange).not.toHaveBeenCalledWith("2026-06-12");
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(field()).toHaveAccessibleDescription(/day-first or month-first/);
  });

  it("refuses a date outside the allowed window and names the window", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness min="2026-06-01" max="2026-06-30" />);
    await user.type(field(), "3 Jul 2026");
    await user.tab();
    expect(field()).toHaveAccessibleDescription(/between 1 Jun 2026 and 30 Jun 2026/);
  });

  it("holds a form submission back when the date will not parse", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    renderSurface(
      <form onSubmit={onSubmit}>
        <Harness />
      </form>,
    );
    await user.type(field(), "sometime next week{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute("aria-invalid", "true");
  });

  it("clears the value when the field is emptied", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness initial="2026-06-12" onChange={onChange} />);
    await user.clear(field());
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("opens the calendar on the value it already holds and moves focus into it", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness initial="2026-06-12" />);
    await user.click(screen.getByRole("button", { name: "Choose a date from the calendar" }));

    const dialog = screen.getByRole("dialog", { name: /Effective date calendar/ });
    expect(within(dialog).getByRole("button", { name: "12 June 2026" })).toHaveFocus();
  });

  it("moves a day, a week, and a month from the keyboard", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness initial="2026-06-12" />);
    await user.click(screen.getByRole("button", { name: "Choose a date from the calendar" }));
    const dialog = screen.getByRole("dialog");

    await user.keyboard("{ArrowRight}");
    expect(within(dialog).getByRole("button", { name: "13 June 2026" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(dialog).getByRole("button", { name: "20 June 2026" })).toHaveFocus();
    await user.keyboard("{PageDown}");
    expect(within(dialog).getByRole("button", { name: "20 July 2026" })).toHaveFocus();
    await user.keyboard("{PageUp}");
    expect(within(dialog).getByRole("button", { name: "20 June 2026" })).toHaveFocus();
    await user.keyboard("{Home}");
    // 20 June 2026 is a Saturday; the week it sits in opens on Sunday 14 June.
    expect(within(dialog).getByRole("button", { name: "14 June 2026" })).toHaveFocus();
  });

  it("commits the focused day with Enter and returns focus to the field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness initial="2026-06-12" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Choose a date from the calendar" }));
    await user.keyboard("{ArrowRight}{Enter}");

    expect(onChange).toHaveBeenLastCalledWith("2026-06-13");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(field()).toHaveValue("13 Jun 2026");
    expect(field()).toHaveFocus();
  });

  it("closes on Escape and hands focus back to the button that opened it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness initial="2026-06-12" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Choose a date from the calendar" });
    await user.click(trigger);
    await user.keyboard("{ArrowRight}{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose a date from the calendar" })).toHaveFocus();
  });

  it("marks today and the chosen day differently", async () => {
    const user = userEvent.setup();
    const today = todayIso();
    renderSurface(<Harness initial={today} />);
    await user.click(screen.getByRole("button", { name: "Choose a date from the calendar" }));

    const day = screen.getByRole("button", { name: /, today$/ });
    expect(day).toHaveAttribute("aria-current", "date");
    expect(day).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps an out-of-range day reachable but refuses it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness initial="2026-06-12" min="2026-06-10" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Choose a date from the calendar" }));

    const blocked = screen.getByRole("button", { name: "9 June 2026" });
    // aria-disabled, not disabled: a natively disabled button cannot be
    // focused, and the roving tabindex would strand the keyboard on it.
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).not.toBeDisabled();
    await user.click(blocked);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not trap focus: tabbing out closes the calendar", async () => {
    const user = userEvent.setup();
    renderSurface(
      <>
        <Harness initial="2026-06-12" />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Choose a date from the calendar" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // The grid is one tab stop, so Tab leaves it for the last control in the
    // calendar rather than walking 42 days.
    await user.tab();
    expect(screen.getByRole("button", { name: /Go to today/ })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers no calendar and no affordance when read-only", () => {
    renderSurface(<Harness label="Recorded" initial="2026-06-12" readOnly />);
    expect(field("Recorded")).toHaveValue("12 Jun 2026");
    expect(field("Recorded")).toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: "Choose a date from the calendar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });
});
