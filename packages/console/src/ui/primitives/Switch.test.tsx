import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Switch } from "./Switch";

function Harness({
  initial = false,
  onChange,
  ...rest
}: {
  readonly initial?: boolean;
  readonly onChange?: (next: boolean) => void;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly hint?: string;
}) {
  const [checked, setChecked] = useState(initial);
  return (
    <Switch
      label="Work discovery"
      checked={checked}
      onChange={(next) => {
        setChecked(next);
        onChange?.(next);
      }}
      {...rest}
    />
  );
}

describe("Switch", () => {
  it("carries no accessibility violations in any of its states", async () => {
    const { container } = renderSurface(
      <>
        <Harness />
        <Harness initial hint="Takes effect immediately, with no save step." />
        <Harness disabled />
        <Harness initial readOnly />
        <Switch
          label="Containment"
          checked={false}
          onChange={() => {}}
          error="Only a supervisor can change containment."
        />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("is announced as on or off rather than as checked", () => {
    renderSurface(<Harness initial />);
    const control = screen.getByRole("switch", { name: "Work discovery" });
    expect(control).toHaveAttribute("aria-checked", "true");
  });

  it("flips on click and from the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "Work discovery" });

    await user.click(control);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(control).toHaveAttribute("aria-checked", "true");

    control.focus();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("writes the state as a word beside the track", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    expect(screen.getByText("Off")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Work discovery" }));
    expect(screen.getByText("On")).toBeInTheDocument();
  });

  it("keeps the visible word out of the accessible name, which aria-checked already carries", () => {
    renderSurface(<Harness initial />);
    // "Work discovery, switch, on" — not "Work discovery On, switch, on".
    expect(screen.getByRole("switch")).toHaveAccessibleName("Work discovery");
  });

  it("describes itself with its hint", () => {
    renderSurface(<Harness hint="Takes effect immediately." />);
    expect(screen.getByRole("switch", { name: "Work discovery" })).toHaveAccessibleDescription(
      "Takes effect immediately.",
    );
  });

  it("refuses the click when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Harness disabled onChange={onChange} />);
    await user.click(screen.getByRole("switch", { name: "Work discovery" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("has no switch at all when read-only, and states the value in words", () => {
    renderSurface(<Harness initial readOnly />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    // The word is now the only carrier of the state, so it stops being hidden.
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText("Work discovery")).toBeInTheDocument();
  });
});
