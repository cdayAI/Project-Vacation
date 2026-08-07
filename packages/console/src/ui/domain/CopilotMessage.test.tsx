import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { CopilotMessage, type CopilotCitation } from "./CopilotMessage";

const CITATIONS: readonly CopilotCitation[] = [
  {
    id: "c1",
    marker: "1",
    source: "Florida Statutes §721.10",
    version: "rev 2025-07-01",
    kind: "retrieved",
    passage: "The purchaser may cancel until midnight of the tenth calendar day.",
  },
  {
    id: "c2",
    marker: "2",
    source: "Window closes 22 Jun",
    kind: "computed",
  },
];

describe("CopilotMessage", () => {
  it("names who is speaking", () => {
    renderSurface(<CopilotMessage author="operator" body="When does the window close?" />);
    expect(screen.getByText("You")).toBeInTheDocument();

    renderSurface(<CopilotMessage author="copilot" body="On 22 June." />);
    expect(screen.getByText("Copilot")).toBeInTheDocument();
  });

  it("holds back the action card while the text is still arriving", async () => {
    // A proposed action that assembles itself mid-stream is a button an
    // operator can press when it says "Send to 3 owners" and before it says
    // "in Florida".
    const { rerender } = renderSurface(
      <CopilotMessage
        author="copilot"
        body="Drafting the confirmation"
        streaming
        action={<button type="button">Send the confirmation</button>}
      />,
    );
    expect(screen.queryByRole("button", { name: "Send the confirmation" })).toBeNull();

    rerender(
      <CopilotMessage
        author="copilot"
        body="Drafting the confirmation"
        action={<button type="button">Send the confirmation</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Send the confirmation" })).toBeInTheDocument();
  });

  it("marks a streaming turn busy without narrating every token", () => {
    // A live region on streaming text announces every partial sentence, which
    // is unusable. One status message, and aria-busy for the rest.
    const { container } = renderSurface(
      <CopilotMessage author="copilot" body="Checking the contract" streaming />,
    );
    const body = container.querySelector(".pv-copilot-body");
    expect(body).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(screen.getByText("Still answering.")).toHaveClass("pv-sr-only");
  });

  it("marks the end of the arriving text without animating anything", () => {
    // The caret does not blink: the four motion durations all describe
    // transitions, and inventing a fifth for a metronome beside prose someone
    // is reading is how a motion system stops being a system.
    const { container } = renderSurface(
      <CopilotMessage author="copilot" body="Checking" streaming />,
    );
    expect(container.querySelector(".pv-copilot-caret")).toHaveAttribute("aria-hidden", "true");

    const settled = renderSurface(<CopilotMessage author="copilot" body="On 22 June." />);
    expect(settled.container.querySelector(".pv-copilot-caret")).toBeNull();
  });

  it("checks a citation in place, with its provenance", async () => {
    const user = userEvent.setup();
    renderSurface(
      <CopilotMessage
        author="copilot"
        body="The window closes on 22 June [1], ten days after signature [2]."
        citations={CITATIONS}
      />,
    );

    expect(screen.getByText("Retrieved")).toBeInTheDocument();
    expect(screen.getByText("Computed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /\[1\] Florida Statutes §721.10/ }));
    expect(
      screen.getByText("The purchaser may cancel until midnight of the tenth calendar day."),
    ).toBeVisible();
  });

  it("always states what the turn cost and how long it took", () => {
    // A copilot whose cost is invisible is a copilot nobody governs.
    renderSurface(
      <CopilotMessage author="copilot" body="On 22 June." cost="$0.011" elapsed="1.4s" />,
    );
    expect(screen.getByText("$0.011")).toBeInTheDocument();
    expect(screen.getByText("1.4s")).toBeInTheDocument();
    expect(screen.getByText("Cost")).toHaveClass("pv-sr-only");
  });

  it("treats not knowing as an answer, and offers a person", async () => {
    const onRouteToHuman = vi.fn();
    const user = userEvent.setup();
    const { container } = renderSurface(
      <CopilotMessage
        author="copilot"
        body="I do not know which servicer holds this contract."
        unknown
        onRouteToHuman={onRouteToHuman}
      />,
    );

    expect(container.querySelector(".pv-copilot")).toHaveAttribute("data-unknown", "true");
    await user.click(screen.getByRole("button", { name: "Ask a person" }));
    expect(onRouteToHuman).toHaveBeenCalledTimes(1);
  });

  it("offers nothing to press while it is still answering", () => {
    renderSurface(
      <CopilotMessage author="copilot" body="Checking" streaming onRouteToHuman={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Ask a person" })).toBeNull();
  });

  it("keeps the transcript and drops the controls when read-only", () => {
    renderSurface(
      <CopilotMessage
        author="copilot"
        body="On 22 June."
        citations={CITATIONS}
        onRouteToHuman={vi.fn()}
        readOnly
      />,
    );
    expect(screen.queryByRole("button", { name: "Ask a person" })).toBeNull();
    expect(screen.getByText("On 22 June.")).toBeInTheDocument();
  });

  it("has no accessibility violations in any state", async () => {
    const { container } = renderSurface(
      <>
        <CopilotMessage author="operator" body="When does the window close?" time="09:40" />
        <CopilotMessage
          author="copilot"
          body="The window closes on 22 June [1]."
          time="09:41"
          citations={CITATIONS}
          cost="$0.011"
          elapsed="1.4s"
          action={<button type="button">Send the confirmation</button>}
        />
        <CopilotMessage author="copilot" body="Checking the contract" streaming />
        <CopilotMessage
          author="copilot"
          body="I do not know which servicer holds this contract."
          unknown
          onRouteToHuman={() => {}}
        />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
