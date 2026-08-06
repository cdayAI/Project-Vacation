import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { ErrorState } from "./ErrorState";

const FAILURE = {
  title: "We could not reach the loan servicing system.",
  meaning: "Your work is saved.",
  guidance: "You can retry now, or continue and we will sync when it is back.",
  reference: "8f2a41",
} as const;

describe("ErrorState", () => {
  it("names what happened, what it means, and what to do", () => {
    renderSurface(<ErrorState {...FAILURE} />);
    expect(screen.getByText(FAILURE.title)).toBeInTheDocument();
    expect(screen.getByText(FAILURE.meaning)).toBeInTheDocument();
    expect(screen.getByText(FAILURE.guidance)).toBeInTheDocument();
  });

  it("carries the reference an operator reads down the phone", () => {
    renderSurface(<ErrorState {...FAILURE} />);
    expect(screen.getByText("8f2a41")).toBeInTheDocument();
  });

  it("says the word as well as showing the colour", () => {
    // This block is screenshotted into tickets and printed into audit packs,
    // and both of those are monochrome.
    renderSurface(<ErrorState {...FAILURE} />);
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("distinguishes a degraded state from a failure in words", () => {
    renderSurface(
      <ErrorState
        title="Showing figures from 09:00."
        meaning="The live feed is behind."
        reference="c41b09"
        tone="warning"
      />,
    );
    expect(screen.getByText("Degraded")).toBeInTheDocument();
  });

  it("offers the controls that resolve it", () => {
    renderSurface(
      <ErrorState
        {...FAILURE}
        actions={
          <>
            <button type="button">Retry</button>
            <button type="button">Continue offline</button>
          </>
        }
      />,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue offline" })).toBeInTheDocument();
  });

  it("announces politely when it arrives mid-flow, and not otherwise", () => {
    // Assertive would cut across an operator mid-sentence in a rejection
    // reason. The failure is not going anywhere.
    const quiet = renderSurface(<ErrorState {...FAILURE} />);
    expect(quiet.container.querySelector("[aria-live]")).toBeNull();

    renderSurface(<ErrorState {...FAILURE} live />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the title in the reading colour rather than in the tone", () => {
    // A wall of red text is hardest to read at the moment it matters most.
    const { container } = renderSurface(<ErrorState {...FAILURE} />);
    expect(container.querySelector(".pv-error-state-title")).toBeInTheDocument();
    expect(container.querySelector(".pv-error-state-title")).not.toHaveClass(
      "pv-error-state-eyebrow",
    );
  });

  it("has no accessibility violations in either tone", async () => {
    const { container } = renderSurface(
      <>
        <ErrorState {...FAILURE} actions={<button type="button">Retry</button>} />
        <ErrorState
          title="Showing figures from 09:00."
          reference="c41b09"
          tone="warning"
          align="center"
        />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
