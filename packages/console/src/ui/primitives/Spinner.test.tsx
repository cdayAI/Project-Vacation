import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Spinner } from "./Spinner";

describe("Spinner", () => {
  it("carries no accessibility violations", async () => {
    const { container } = renderSurface(
      <>
        <Spinner />
        <Spinner size="sm" label="Loading approvals" />
        <Spinner size="lg" decorative />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("announces what is being waited for", () => {
    renderSurface(<Spinner label="Loading approvals" />);
    // A picture of activity with no text is silence to a screen reader.
    expect(screen.getByRole("status")).toHaveTextContent("Loading approvals");
  });

  it("says nothing at all when it is decorative", () => {
    const { container } = renderSurface(<Spinner decorative />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // Inside a button that is already aria-busy, a status region would append
    // "Loading" to the button's accessible name on every render.
    expect(container.querySelector(".pv-ui-spinner")).toHaveAttribute("aria-hidden", "true");
  });

  it("carries its size as data rather than as a style", () => {
    const { container } = renderSurface(<Spinner size="lg" />);
    expect(container.querySelector(".pv-ui-spinner")).toHaveAttribute("data-size", "lg");
  });

  it("hides the drawing itself from assistive technology", () => {
    const { container } = renderSurface(<Spinner />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
