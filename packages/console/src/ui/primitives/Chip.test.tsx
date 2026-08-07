import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Chip } from "./Chip";
import { IconLock } from "./icons";

describe("Chip", () => {
  it("carries no accessibility violations in any of its shapes", async () => {
    const { container } = renderSurface(
      <>
        <Chip>All open</Chip>
        <Chip size="sm" tone="warning">
          Breaching
        </Chip>
        <Chip icon={<IconLock size="sm" />}>Read-only</Chip>
        <Chip selected onSelect={() => {}} count={1240}>
          Mine
        </Chip>
        <Chip onSelect={() => {}} count={42}>
          Unassigned
        </Chip>
        <Chip onRemove={() => {}}>Florida</Chip>
        <Chip onSelect={() => {}} onRemove={() => {}} selected={false}>
          High value
        </Chip>
        <Chip disabled onSelect={() => {}}>
          Archived
        </Chip>
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("is inert text with no handlers", () => {
    renderSurface(<Chip>All open</Chip>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("All open")).toBeInTheDocument();
  });

  it("announces a filter toggle's state through aria-pressed", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderSurface(
      <Chip selected onSelect={onSelect}>
        Mine
      </Chip>,
    );
    const chip = screen.getByRole("button", { name: /Mine/ });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await user.click(chip);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("marks a selected chip with a check as well as a fill", () => {
    const { container } = renderSurface(
      <Chip selected onSelect={() => {}}>
        Mine
      </Chip>,
    );
    // Tint alone fails in greyscale and for a monochromat, and a filter bar is
    // where being wrong about state changes the answer silently.
    expect(container.querySelector(".pv-ui-chip-check")).not.toBeNull();
  });

  it("names the remove button after what it removes", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    renderSurface(<Chip onRemove={onRemove}>Florida</Chip>);
    await user.click(screen.getByRole("button", { name: "Remove Florida" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("takes an explicit remove label when the content is not a plain string", () => {
    renderSurface(
      <Chip onRemove={() => {}} removeLabel="Remove the Florida filter">
        <strong>Florida</strong>
      </Chip>,
    );
    expect(screen.getByRole("button", { name: "Remove the Florida filter" })).toBeInTheDocument();
  });

  it("keeps the toggle and the remove as two separate controls", () => {
    renderSurface(
      <Chip onSelect={() => {}} onRemove={() => {}} selected={false}>
        High value
      </Chip>,
    );
    // Nesting one button inside another is invalid, and the inner one stops
    // being reachable from the keyboard in some engines.
    expect(screen.getByRole("button", { name: "High value" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove High value" })).toBeInTheDocument();
  });

  it("renders a count in a form that will not shift width as it updates", () => {
    renderSurface(<Chip count={1240}>All open</Chip>);
    expect(screen.getByText("1,240")).toBeInTheDocument();
  });

  it("refuses interaction when disabled", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderSurface(
      <Chip disabled onSelect={onSelect}>
        Archived
      </Chip>,
    );
    await user.click(screen.getByRole("button", { name: /Archived/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
