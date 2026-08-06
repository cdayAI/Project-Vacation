import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Button } from "./Button";
import { IconCross } from "./icons";

describe("Button", () => {
  it("carries no accessibility violations in any variant or size", async () => {
    const { container } = renderSurface(
      <>
        <Button variant="primary">Approve</Button>
        <Button variant="secondary" size="sm">
          Reject
        </Button>
        <Button variant="ghost" size="lg">
          Skip
        </Button>
        <Button variant="danger">Revoke credentials</Button>
        <Button loading>Approve</Button>
        <Button disabled>Approve</Button>
        <Button unavailable describedBy="why">
          Approve
        </Button>
        <p id="why">A supervisor grants this.</p>
        <Button iconOnly label="Dismiss">
          <IconCross />
        </Button>
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("defaults to type=button so it cannot submit a form by accident", () => {
    renderSurface(<Button>Approve</Button>);
    expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("type", "button");
  });

  it("keeps its label, and therefore its width, while loading", () => {
    renderSurface(<Button loading>Approve</Button>);
    const button = screen.getByRole("button", { name: "Approve" });
    // The label is still in the accessibility tree: opacity, not visibility,
    // and not unmounted. A button that loses its name mid-request is a button
    // a screen reader user cannot find again.
    expect(button).toHaveTextContent("Approve");
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("stays focusable while loading rather than dropping focus to the body", async () => {
    const user = userEvent.setup();
    renderSurface(<Button loading>Approve</Button>);
    const button = screen.getByRole("button", { name: "Approve" });
    await user.tab();
    expect(button).toHaveFocus();
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
  });

  it("refuses a second click while loading", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderSurface(
      <Button loading onClick={onClick}>
        Approve
      </Button>,
    );
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not submit the form it sits in while loading", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    renderSurface(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Save
        </Button>
      </form>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps an unavailable button reachable and explained", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderSurface(
      <>
        <Button unavailable describedBy="reason" onClick={onClick}>
          Approve
        </Button>
        <p id="reason">Only a supervisor can approve above $10,000.</p>
      </>,
    );
    const button = screen.getByRole("button", { name: "Approve" });
    await user.tab();
    expect(button).toHaveFocus();
    expect(button).toHaveAccessibleDescription("Only a supervisor can approve above $10,000.");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("takes a disabled button out of the tab order, as the platform does", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderSurface(
      <Button disabled onClick={onClick}>
        Approve
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Approve" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("names an icon-only button from its required label", () => {
    renderSurface(
      <Button iconOnly label="Dismiss this alert">
        <IconCross />
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Dismiss this alert" })).toBeInTheDocument();
  });

  it("fires normally when it is neither loading nor unavailable", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderSurface(<Button onClick={onClick}>Approve</Button>);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is operable from the keyboard", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderSurface(<Button onClick={onClick}>Approve</Button>);
    await user.tab();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});
