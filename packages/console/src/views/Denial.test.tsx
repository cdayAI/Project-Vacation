import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { selfApprovalDenial, spendCeilingDenial } from "../test/fixtures";
import { Denial } from "./Denial";

describe("Denial", () => {
  it("says what was refused, why, and what the operator can do", () => {
    renderSurface(<Denial denial={spendCeilingDenial} attempted="the work queue" headingLevel={1} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Refused: the work queue" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/past its configured spend ceiling for the day/)).toBeInTheDocument();
    expect(screen.getByText(/A configured limit on spend, rate, or elapsed time was reached/))
      .toBeInTheDocument();
  });

  it("shows the reason code for escalation and for the audit record", () => {
    renderSurface(<Denial denial={spendCeilingDenial} headingLevel={1} />);
    expect(screen.getByText("ceiling.spend_exceeded")).toBeInTheDocument();
  });

  it("shows the detail recorded with the refusal", () => {
    renderSurface(<Denial denial={spendCeilingDenial} headingLevel={1} />);

    expect(screen.getByText("ceilingUsd")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("spentUsd")).toBeInTheDocument();
    expect(screen.getByText("24.86")).toBeInTheDocument();
  });

  it("gives specific guidance where the next step genuinely differs", () => {
    renderSurface(<Denial denial={selfApprovalDenial} headingLevel={1} />);
    expect(
      screen.getByText(/A different eligible approver has to decide this/),
    ).toBeInTheDocument();
  });

  it("does not present the refusal as a fault", () => {
    const { container } = renderSurface(<Denial denial={spendCeilingDenial} headingLevel={1} />);

    expect(
      screen.getByText(/It is not a fault, and there is nothing to fix in the console/),
    ).toBeInTheDocument();
    // The denial tone is its own colour, not the failure colour.
    expect(container.querySelector(".pv-denial")).not.toBeNull();
    expect(container.querySelector(".pv-callout-danger")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("falls back to honest generic guidance for an unfamiliar reason", () => {
    renderSurface(
      <Denial
        denial={{
          denied: true,
          reason: "something.unheard_of",
          message: "The platform refused.",
          detail: {},
        }}
        headingLevel={1}
      />,
    );

    expect(
      screen.getByText(/Note the reason code above and pass it to whoever administers this platform/),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <Denial denial={spendCeilingDenial} attempted="the work queue" headingLevel={1} />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
