import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATUS_TONES } from "../../theme/tokens";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("carries no accessibility violations in any tone", async () => {
    const { container } = renderSurface(
      <>
        {STATUS_TONES.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
        <Badge tone="warning" size="sm">
          Breaching
        </Badge>
        <Badge tone="info" emphasis="outline">
          In progress
        </Badge>
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("carries a mark beside the words in every tone", () => {
    const { container } = renderSurface(
      <>
        {STATUS_TONES.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </>,
    );
    // The second channel, so a status survives greyscale on a printed evidence
    // pack and a reader who cannot separate the hues.
    expect(container.querySelectorAll("svg")).toHaveLength(STATUS_TONES.length);
  });

  it("hides the mark from assistive technology, because the words are the meaning", () => {
    const { container } = renderSurface(<Badge tone="danger">Breached</Badge>);
    const mark = container.querySelector("svg");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Breached")).toBeInTheDocument();
  });

  it("keeps the tone as a data attribute rather than a colour in the markup", () => {
    const { container } = renderSurface(<Badge tone="denied">Refused by policy</Badge>);
    expect(container.querySelector(".pv-ui-badge")).toHaveAttribute("data-tone", "denied");
  });

  it("resolves its tone through the token set rather than a literal colour", () => {
    const { container } = renderSurface(<Badge tone="success">Within policy</Badge>);
    const badge = container.querySelector(".pv-ui-badge") as HTMLElement;
    // Still a var() reference at this point, so the theme swap and the reduced
    // transparency swap both keep working without this component knowing.
    expect(badge.style.getPropertyValue("--pv-tone-text")).toBe("var(--pv-status-success)");
  });

  it("takes a replacement mark", () => {
    const { container } = renderSurface(
      <Badge tone="info" icon={<svg data-testid="custom" />}>
        Running
      </Badge>,
    );
    expect(container.querySelector('[data-testid="custom"]')).not.toBeNull();
  });
});
