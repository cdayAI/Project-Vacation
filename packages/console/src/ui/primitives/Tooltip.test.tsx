import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Button } from "./Button";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  it("carries no accessibility violations, hidden and shown", async () => {
    const user = userEvent.setup();
    const { container } = renderSurface(
      <Tooltip content="Requested 09:41:02 on 12 Jun 2026">
        <Button>2 hours ago</Button>
      </Tooltip>,
    );
    await expectNoAccessibilityViolations(container);

    await user.tab();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await expectNoAccessibilityViolations(container);
  });

  it("describes its trigger whether or not anyone has hovered", () => {
    renderSurface(
      <Tooltip content="Requested 09:41:02 on 12 Jun 2026">
        <Button>2 hours ago</Button>
      </Tooltip>,
    );
    // The bubble is in the DOM from the start, screen-reader-only until it is
    // shown, so the description is not a thing that exists only for mouse
    // users.
    expect(screen.getByRole("button", { name: "2 hours ago" })).toHaveAccessibleDescription(
      "Requested 09:41:02 on 12 Jun 2026",
    );
  });

  it("appears on focus with no delay", async () => {
    const user = userEvent.setup();
    const { container } = renderSurface(
      <Tooltip content="Requested 09:41:02 on 12 Jun 2026">
        <Button>2 hours ago</Button>
      </Tooltip>,
    );
    await user.tab();
    expect(container.querySelector(".pv-ui-tooltip-bubble")).not.toBeNull();
  });

  it("goes away again on blur", async () => {
    const user = userEvent.setup();
    const { container } = renderSurface(
      <>
        <Tooltip content="Requested 09:41:02 on 12 Jun 2026">
          <Button>2 hours ago</Button>
        </Tooltip>
        <Button>Elsewhere</Button>
      </>,
    );
    await user.tab();
    expect(container.querySelector(".pv-ui-tooltip-bubble")).not.toBeNull();
    await user.tab();
    expect(container.querySelector(".pv-ui-tooltip-bubble")).toBeNull();
  });

  it("is dismissible with Escape without moving the pointer or the focus", async () => {
    const user = userEvent.setup();
    const { container } = renderSurface(
      <Tooltip content="Requested 09:41:02 on 12 Jun 2026">
        <Button>2 hours ago</Button>
      </Tooltip>,
    );
    await user.tab();
    expect(container.querySelector(".pv-ui-tooltip-bubble")).not.toBeNull();

    await user.keyboard("{Escape}");
    // WCAG 2.2 1.4.13. The focus stays where it was.
    expect(container.querySelector(".pv-ui-tooltip-bubble")).toBeNull();
    expect(screen.getByRole("button", { name: "2 hours ago" })).toHaveFocus();
  });

  it("waits before appearing on hover, so a pointer crossing the row is quiet", async () => {
    const user = userEvent.setup();
    const { container } = renderSurface(
      <Tooltip content="Requested 09:41:02 on 12 Jun 2026" delayMs={20}>
        <Button>2 hours ago</Button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole("button", { name: "2 hours ago" }));
    expect(container.querySelector(".pv-ui-tooltip-bubble")).toBeNull();
    await waitFor(() =>
      expect(container.querySelector(".pv-ui-tooltip-bubble")).not.toBeNull(),
    );
  });

  it("keeps the trigger's own handlers working", async () => {
    const user = userEvent.setup();
    let clicked = 0;
    renderSurface(
      <Tooltip content="Sends the letter now.">
        <Button onClick={() => (clicked += 1)}>Send</Button>
      </Tooltip>,
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(clicked).toBe(1);
  });

  it("keeps a description the trigger already had", () => {
    renderSurface(
      <>
        <Tooltip content="Requested 09:41:02.">
          <Button describedBy="policy">2 hours ago</Button>
        </Tooltip>
        <p id="policy">Policy R-14.</p>
      </>,
    );
    expect(screen.getByRole("button", { name: "2 hours ago" })).toHaveAccessibleDescription(
      "Policy R-14. Requested 09:41:02.",
    );
  });
});
