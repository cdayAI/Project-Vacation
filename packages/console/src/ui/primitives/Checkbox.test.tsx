import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Checkbox } from "./Checkbox";

describe("Checkbox", () => {
  it("carries no accessibility violations in any of its states", async () => {
    const { container } = renderSurface(
      <>
        <Checkbox label="Suppress the courtesy notice" />
        <Checkbox label="Send a copy to the owner" defaultChecked />
        <Checkbox label="Select all" indeterminate />
        <Checkbox label="With a hint" hint="Applies to every case in this view." />
        <Checkbox label="With an error" error="Choose at least one recipient." />
        <Checkbox label="Unavailable" disabled />
        <Checkbox label="Recorded" defaultChecked readOnly />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("is a real checkbox, with the label bound to it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Checkbox label="Send a copy" onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: "Send a copy" });

    expect(box).not.toBeChecked();
    await user.click(screen.getByText("Send a copy"));
    expect(box).toBeChecked();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("toggles from the keyboard with Space", async () => {
    const user = userEvent.setup();
    renderSurface(<Checkbox label="Send a copy" />);
    const box = screen.getByRole("checkbox", { name: "Send a copy" });
    await user.tab();
    expect(box).toHaveFocus();
    await user.keyboard(" ");
    expect(box).toBeChecked();
  });

  it("sets the indeterminate DOM property, which has no attribute", () => {
    renderSurface(<Checkbox label="Select all" indeterminate />);
    const box = screen.getByRole("checkbox", { name: "Select all" }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    // The platform maps the property to "mixed" in the accessibility tree on
    // its own — which is the reason to use a real input rather than to track a
    // third state in React and hand-write the ARIA for it.
    expect(box).toBePartiallyChecked();
  });

  it("describes itself with its hint and its error", () => {
    renderSurface(
      <Checkbox
        label="Send a copy"
        hint="Goes to the address on the contract."
        error="That address bounced last week."
      />,
    );
    const box = screen.getByRole("checkbox", { name: "Send a copy" });
    expect(box).toHaveAccessibleDescription(
      "Goes to the address on the contract. That address bounced last week.",
    );
    expect(box).toHaveAttribute("aria-invalid", "true");
  });

  it("states read-only in words rather than as a greyed-out box", () => {
    renderSurface(<Checkbox label="Copy sent to the owner" defaultChecked readOnly />);
    // No control at all: nothing to press, nothing to mistake for pressable,
    // and the state written out for a greyscale print of the evidence pack.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("Copy sent to the owner")).toBeInTheDocument();
    expect(screen.getByText("Selected")).toBeInTheDocument();
  });

  it("says 'Not selected' rather than showing an empty box alone", () => {
    renderSurface(<Checkbox label="Copy sent to the owner" readOnly />);
    expect(screen.getByText("Not selected")).toBeInTheDocument();
  });

  it("says 'Partly selected' for an indeterminate read-only box", () => {
    renderSurface(<Checkbox label="Cases included" indeterminate readOnly />);
    expect(screen.getByText("Partly selected")).toBeInTheDocument();
  });

  it("refuses the click when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Checkbox label="Send a copy" disabled onChange={onChange} />);
    await user.click(screen.getByRole("checkbox", { name: "Send a copy" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
