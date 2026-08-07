import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Callout } from "./Callout";

describe("Callout", () => {
  it("states its title without joining the heading outline", () => {
    // A callout drops into the middle of a section. An h3 here would sit
    // between an h2 and its real h3 and corrupt the outline a screen-reader
    // user navigates by — which looks fine to everyone who cannot see it.
    renderSurface(<Callout title="If you approve">Three owners are notified.</Callout>);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("If you approve")).toBeInTheDocument();
  });

  it("gives the tone a word, because the border colour says nothing", () => {
    renderSurface(<Callout tone="danger" title="This breaches policy R-14." />);
    expect(screen.getByText("Error:")).toHaveClass("pv-sr-only");
  });

  it("takes an override for the tone word", () => {
    renderSurface(<Callout tone="warning" toneLabel="Deadline" title="Two days left." />);
    expect(screen.getByText("Deadline:")).toBeInTheDocument();
  });

  it("defaults to the bordered treatment the approval screen uses", () => {
    const { container } = renderSurface(<Callout title="If you approve" />);
    expect(container.querySelector(".pv-notice")).toHaveAttribute("data-emphasis", "outline");
  });

  it("announces politely only when asked", () => {
    const quiet = renderSurface(<Callout title="Present at load" />);
    expect(quiet.container.querySelector("[aria-live]")).toBeNull();

    renderSurface(<Callout title="Arrived mid-flow" live="polite" />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("drops its actions when read-only rather than dimming them", () => {
    // A row of dimmed buttons is an invitation to keep clicking them.
    renderSurface(
      <Callout title="If you approve" readOnly actions={<button type="button">Preview</button>} />,
    );
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });

  it("keeps its actions otherwise", () => {
    renderSurface(
      <Callout title="If you approve" actions={<button type="button">Preview</button>} />,
    );
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
  });

  it("has no accessibility violations in any tone", async () => {
    const { container } = renderSurface(
      <>
        <Callout tone="info" title="Information" />
        <Callout tone="success" title="Within policy" emphasis="tinted" />
        <Callout tone="warning" title="Approaching a limit" emphasis="tinted" />
        <Callout tone="danger" title="Breached" />
        <Callout tone="denied" title="Refused by a ceiling" />
        <Callout tone="neutral" title="Archived">
          <ul>
            <li>One effect</li>
            <li>Another effect</li>
          </ul>
        </Callout>
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
