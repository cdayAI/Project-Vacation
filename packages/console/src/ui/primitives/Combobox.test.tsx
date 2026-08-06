import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Combobox } from "./Combobox";
import type { ListOption } from "./listbox";

const OWNERS: readonly ListOption[] = [
  { value: "o-1", label: "Marisol Delgado", description: "Account 41823" },
  { value: "o-2", label: "Dana Ruiz", description: "Account 22190" },
  { value: "o-3", label: "Marc Webb", description: "Account 78004" },
  { value: "o-4", label: "Priya Raman", description: "Account 55120" },
];

function Harness({
  initial = null,
  options = OWNERS,
  onChange,
  ...rest
}: {
  readonly initial?: string | null;
  readonly options?: readonly ListOption[];
  readonly onChange?: (value: string | null) => void;
  readonly allowCustomValue?: boolean;
  readonly required?: boolean;
  readonly readOnly?: boolean;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <Combobox
      label="Owner"
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

function field() {
  return screen.getByRole("combobox", { name: "Owner" });
}

function activeLabel(): string {
  const id = field().getAttribute("aria-activedescendant");
  const option = id === null ? null : document.getElementById(id);
  return option?.querySelector(".pv-ui-listbox-label")?.textContent ?? "";
}

describe("Combobox", () => {
  it("carries no accessibility violations, closed and open", async () => {
    const user = userEvent.setup();
    const { container } = renderSurface(
      <>
        <Harness />
        <Harness initial="o-2" readOnly />
      </>,
    );
    await expectNoAccessibilityViolations(container);

    await user.click(field());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await expectNoAccessibilityViolations(container);
  });

  it("declares itself a list-autocomplete combobox", () => {
    renderSurface(<Harness />);
    expect(field()).toHaveAttribute("aria-autocomplete", "list");
    expect(field()).toHaveAttribute("aria-expanded", "false");
  });

  it("filters as the operator types, on the label and on the second line", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.type(field(), "mar");

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Marisol Delgado"),
      expect.stringContaining("Marc Webb"),
    ]);

    await user.clear(field());
    await user.type(field(), "78004");
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("wraps when the keyboard arrows past the end of the filtered list", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.type(field(), "mar");
    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Marisol Delgado");
    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Marc Webb");
    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Marisol Delgado");
    await user.keyboard("{ArrowUp}");
    expect(activeLabel()).toBe("Marc Webb");
  });

  it("commits the active option with Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness onChange={onChange} />);
    await user.type(field(), "dana");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenLastCalledWith("o-2");
    expect(field()).toHaveValue("Dana Ruiz");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("commits an exact typed match with Enter even when nothing is highlighted", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness onChange={onChange} />);
    await user.type(field(), "Marc Webb{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("o-3");
  });

  it("closes on Escape and puts the committed value back in the box", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness initial="o-2" />);
    expect(field()).toHaveValue("Dana Ruiz");

    await user.clear(field());
    await user.type(field(), "mari");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // Restored, not cleared: destroying what somebody typed is not a dismissal,
    // and the box must never show a value the record does not hold.
    expect(field()).toHaveValue("Dana Ruiz");
    expect(field()).toHaveFocus();
  });

  it("leaves Home and End to the caret, because this is a text field", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    const input = field() as HTMLInputElement;
    await user.type(input, "Ruiz");
    await user.keyboard("{Home}");
    expect(input.selectionStart).toBe(0);
    await user.keyboard("Dana ");
    expect(input).toHaveValue("Dana Ruiz");
  });

  it("does not commit the highlighted option on the way out with Tab", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(
      <>
        <Harness onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.type(field(), "mar");
    await user.keyboard("{ArrowDown}");
    await user.tab();

    // Tabbing away is not choosing. Anything else puts a value on a record that
    // the operator never picked.
    expect(onChange).not.toHaveBeenCalledWith("o-1");
    expect(field()).toHaveValue("");
  });

  it("undoes an abandoned edit when focus is lost mid-selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(
      <>
        <Harness initial="o-4" onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.clear(field());
    await user.type(field(), "ma");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // Half a name typed and then abandoned means nothing. The field goes back
    // to what it held rather than keeping text that matches no record.
    expect(field()).toHaveValue("Priya Raman");
    expect(onChange).toHaveBeenLastCalledWith("o-4");
  });

  it("treats an emptied box that is left as a clear, not as an abandoned edit", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(
      <>
        <Harness initial="o-4" onChange={onChange} />
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.clear(field());
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));

    expect(field()).toHaveValue("");
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("stops claiming to hold a value the moment the operator types past it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness initial="o-2" onChange={onChange} />);
    await user.type(field(), "x");
    // The box now says "Dana Ruizx", which is nobody. Leaving the old value
    // behind is how a form saves a choice that was never made.
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("says there are no matches instead of opening an empty list", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.type(field(), "zzz");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(field()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("status")).toHaveTextContent(/No matches for “zzz”/);
  });

  it("offers the whole list again when reopened on a committed value", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness initial="o-1" />);
    await user.click(field());
    await user.keyboard("{ArrowDown}");
    // Not filtered down to the one option whose label is already in the box.
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });

  it("clears from the keyboard and hands focus back to the field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness initial="o-1" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Clear Owner" }));

    expect(onChange).toHaveBeenCalledWith(null);
    expect(field()).toHaveValue("");
    expect(field()).toHaveFocus();
  });

  it("offers no clear button on a required field", () => {
    renderSurface(<Harness initial="o-1" required />);
    expect(screen.queryByRole("button", { name: "Clear Owner" })).not.toBeInTheDocument();
  });

  it("accepts a value outside the list only when the caller allows it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness allowCustomValue onChange={onChange} />);
    await user.type(field(), "New owner not yet in the system{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("New owner not yet in the system");
  });

  it("reads as a read-only field with no popup and no clear", () => {
    renderSurface(<Harness initial="o-3" readOnly />);
    expect(screen.getByLabelText("Owner")).toHaveValue("Marc Webb");
    expect(screen.getByLabelText("Owner")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /Clear/ })).not.toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });
});
