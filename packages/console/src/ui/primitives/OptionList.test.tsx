import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import type { ListOption } from "./listbox";
import { OptionList } from "./OptionList";

const OPTIONS: readonly ListOption[] = [
  { value: "open", label: "Open" },
  { value: "parked", label: "Parked", description: "Waiting on an approval" },
  { value: "sealed", label: "Sealed", disabled: true },
];

function render(overrides: Partial<Parameters<typeof OptionList>[0]> = {}) {
  return renderSurface(
    <>
      <span id="owner-label">Status</span>
      <OptionList
        id="list"
        options={OPTIONS}
        activeIndex={0}
        selectedValue="parked"
        optionId={(index) => `list-option-${index}`}
        onPick={() => {}}
        labelledBy="owner-label"
        {...overrides}
      />
    </>,
  );
}

describe("OptionList", () => {
  it("carries no accessibility violations", async () => {
    const { container } = render();
    await expectNoAccessibilityViolations(container);
  });

  it("gives every option the id the input publishes as its active descendant", () => {
    render();
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.id)).toEqual([
      "list-option-0",
      "list-option-1",
      "list-option-2",
    ]);
  });

  it("marks the selected option, and only that one", () => {
    render();
    expect(screen.getByRole("option", { selected: true })).toHaveAccessibleName(/Parked/);
  });

  it("marks an option the operator cannot choose, and refuses the click", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render({ onPick });
    const sealed = screen.getByRole("option", { name: /Sealed/ });
    expect(sealed).toHaveAttribute("aria-disabled", "true");
    await user.click(sealed);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps the pointer from blurring the input before the click lands", () => {
    render();
    const list = screen.getByRole("listbox");
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    list.dispatchEvent(event);
    // Without this the blur closes the list and the click hits nothing — the
    // "my dropdown closes when I click an option" bug, invisible in a
    // keyboard-only test.
    expect(event.defaultPrevented).toBe(true);
  });

  it("reports the option that was picked, with its index", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render({ onPick });
    await user.click(screen.getByRole("option", { name: /Open/ }));
    expect(onPick).toHaveBeenCalledWith(OPTIONS[0], 0);
  });

  it("carries a second line without letting it become the label", () => {
    render();
    expect(screen.getByText("Waiting on an approval")).toBeInTheDocument();
  });
});
