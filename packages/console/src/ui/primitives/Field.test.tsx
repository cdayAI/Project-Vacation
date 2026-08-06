import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Field } from "./Field";

function TestField(props: Partial<Parameters<typeof Field>[0]> = {}) {
  return (
    <Field label="Reason code" {...props}>
      {(control) => (
        <input
          id={control.id}
          aria-describedby={control.describedBy}
          aria-invalid={control.invalid ? true : undefined}
          required={control.required}
          readOnly={control.readOnly}
        />
      )}
    </Field>
  );
}

describe("Field", () => {
  it("carries no accessibility violations in any of its states", async () => {
    const { container } = renderSurface(
      <>
        <TestField />
        <TestField hint="The code the operator picked." />
        <TestField error="Choose a reason before rejecting." />
        <TestField required />
        <TestField readOnly />
        <TestField labelHidden />
        <Field label="Window" group hint="Both ends are inclusive.">
          {() => (
            <>
              <label htmlFor="from">From</label>
              <input id="from" />
              <label htmlFor="to">To</label>
              <input id="to" />
            </>
          )}
        </Field>
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("binds the label to the control", () => {
    renderSurface(<TestField />);
    expect(screen.getByLabelText("Reason code")).toBeInTheDocument();
  });

  it("describes the control with its hint", () => {
    renderSurface(<TestField hint="Pick the closest match." />);
    expect(screen.getByLabelText("Reason code")).toHaveAccessibleDescription(
      "Pick the closest match.",
    );
  });

  it("describes the control with both the hint and the error", () => {
    renderSurface(<TestField hint="Pick the closest match." error="This is required." />);
    const input = screen.getByLabelText("Reason code");
    expect(input).toHaveAccessibleDescription("Pick the closest match. This is required.");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the message region in the DOM so an error is announced when it arrives", () => {
    const { container, rerender } = renderSurface(<TestField />);
    const region = container.querySelector('[aria-live="polite"]');
    // Present before there is anything to say: a live region created and filled
    // in the same paint is silent in most screen readers.
    expect(region).not.toBeNull();
    rerender(<TestField error="Choose a reason before rejecting." />);
    expect(screen.getByText("Choose a reason before rejecting.")).toBeInTheDocument();
  });

  it("writes 'Required' as a word rather than an asterisk", () => {
    renderSurface(<TestField required />);
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.queryByText("*")).not.toBeInTheDocument();
  });

  it("marks read-only with a chip and passes the state to the control", () => {
    renderSurface(<TestField readOnly required />);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByLabelText("Reason code")).toHaveAttribute("readonly");
    // "Required" is meaningless on something that cannot be changed.
    expect(screen.queryByText("Required")).not.toBeInTheDocument();
  });

  it("keeps a hidden label available to assistive technology", () => {
    renderSurface(<TestField labelHidden />);
    expect(screen.getByLabelText("Reason code")).toBeInTheDocument();
  });

  it("names a group with a legend and describes the fieldset itself", () => {
    renderSurface(
      <Field label="Window" group hint="Both ends are inclusive.">
        {(control) => <input aria-label="From" aria-describedby={control.describedBy} />}
      </Field>,
    );
    const group = screen.getByRole("group", { name: "Window" });
    expect(group).toHaveAccessibleDescription("Both ends are inclusive.");
    // Not passed down as well, or the hint is read twice for one question.
    expect(screen.getByLabelText("From")).not.toHaveAccessibleDescription();
  });
});
