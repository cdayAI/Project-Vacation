import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Input } from "./Input";

describe("Input", () => {
  it("carries no accessibility violations in any of its states", async () => {
    const { container } = renderSurface(
      <>
        <Input label="Owner name" />
        <Input label="Account" hint="The 8-digit contract number." />
        <Input label="Amount" leading="$" trailing="USD" defaultValue="1,240.00" />
        <Input label="Email" type="email" error="That address has no @ in it." />
        <Input label="Locked" defaultValue="CT-4182" readOnly />
        <Input label="Unavailable" disabled />
        <Input label="Checking" loading defaultValue="sf-quotebot" />
        <Input label="Search" labelHidden type="search" />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("takes typing without blocking or reshaping it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<Input label="Owner name" onChange={onChange} />);
    const field = screen.getByLabelText("Owner name");
    await user.type(field, "Delgado");
    expect(field).toHaveValue("Delgado");
    expect(onChange).toHaveBeenCalledTimes(7);
  });

  it("marks itself invalid and describes the error", () => {
    renderSurface(<Input label="Email" error="That address has no @ in it." />);
    const field = screen.getByLabelText("Email");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("That address has no @ in it.");
  });

  it("stays readable and copyable when read-only, and is not disabled", () => {
    renderSurface(<Input label="Contract" defaultValue="CT-4182" readOnly />);
    const field = screen.getByLabelText("Contract");
    expect(field).toHaveAttribute("readonly");
    // Disabled would take it out of the tab order, so an auditor could not
    // reach it to copy the value.
    expect(field).not.toBeDisabled();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("announces an in-flight check rather than only spinning", () => {
    renderSurface(<Input label="Agent id" loading loadingLabel="Checking availability" />);
    expect(screen.getByLabelText("Agent id")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Checking availability");
  });

  it("hides decorative addons from assistive technology", () => {
    renderSurface(<Input label="Amount" leading="$" trailing="USD" />);
    // The unit belongs in the label or the hint for a screen reader; repeating
    // it as loose text beside the field is noise.
    expect(screen.getByLabelText("Amount")).toHaveAccessibleName("Amount");
  });

  it("keeps a hidden label available", () => {
    renderSurface(<Input label="Search cases" labelHidden type="search" />);
    expect(screen.getByLabelText("Search cases")).toBeInTheDocument();
  });
});
