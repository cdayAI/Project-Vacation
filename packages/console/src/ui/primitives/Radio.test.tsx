import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Radio, RadioGroup } from "./Radio";

function Harness({
  initial = null,
  onChange,
  ...rest
}: {
  readonly initial?: string | null;
  readonly onChange?: (value: string) => void;
  readonly readOnly?: boolean;
  readonly error?: string;
  readonly required?: boolean;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <RadioGroup
      label="Reason for rejection"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      {...rest}
    >
      <Radio value="policy" label="Outside policy" description="The rule and threshold did not match." />
      <Radio value="evidence" label="Evidence is thin" />
      <Radio value="owner" label="Owner disputes it" />
      <Radio value="sealed" label="Sealed case" disabled />
    </RadioGroup>
  );
}

describe("RadioGroup", () => {
  it("carries no accessibility violations in any of its states", async () => {
    const { container } = renderSurface(
      <>
        <Harness />
        <Harness initial="policy" />
        <Harness required error="Choose a reason before rejecting." />
        <Harness initial="evidence" readOnly />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("makes the question part of every option's announcement", () => {
    renderSurface(<Harness />);
    const group = screen.getByRole("group", { name: "Reason for rejection" });
    expect(group.tagName).toBe("FIELDSET");
    expect(screen.getByRole("radio", { name: /Outside policy/ })).toBeInTheDocument();
  });

  it("shares one name across the options, so only one can be chosen", () => {
    renderSurface(<Harness />);
    const names = screen
      .getAllByRole("radio")
      .map((radio) => (radio as HTMLInputElement).name);
    expect(new Set(names).size).toBe(1);
  });

  it("selects on click and reports the value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "Evidence is thin" }));

    expect(onChange).toHaveBeenCalledWith("evidence");
    expect(screen.getByRole("radio", { name: "Evidence is thin" })).toBeChecked();
  });

  it("describes an option with its consequence", () => {
    renderSurface(<Harness />);
    expect(screen.getByRole("radio", { name: /Outside policy/ })).toHaveAccessibleDescription(
      "The rule and threshold did not match.",
    );
  });

  it("refuses an option the operator is not allowed to choose", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness onChange={onChange} />);
    const sealed = screen.getByRole("radio", { name: "Sealed case" });
    expect(sealed).toBeDisabled();
    await user.click(sealed);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps every option on screen when read-only, and names the chosen one", () => {
    renderSurface(<Harness initial="evidence" readOnly />);
    // A read-only form that shows only the answer hides what the alternatives
    // were, which is exactly what an auditor is reading the record to find out.
    expect(screen.getByText("Outside policy")).toBeInTheDocument();
    expect(screen.getByText("Owner disputes it")).toBeInTheDocument();
    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("describes the group, not each option, with the group's error", () => {
    renderSurface(<Harness error="Choose a reason before rejecting." />);
    expect(screen.getByRole("group", { name: "Reason for rejection" })).toHaveAccessibleDescription(
      "Choose a reason before rejecting.",
    );
  });

  it("refuses to render an option outside its group", () => {
    // A radio that has lost its group silently stops sharing a name, and the
    // operator can then answer one question twice. Failing loudly is the point.
    expect(() => renderSurface(<Radio value="orphan" label="Orphan" />)).toThrow(
      /inside a RadioGroup/,
    );
  });
});
