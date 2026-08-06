import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { improvementProposal, improvementProposalRegression } from "../test/fixtures";
import { ImprovementProposal } from "./ImprovementProposal";

describe("ImprovementProposal", () => {
  it("states that the proposal is inert and that there is no auto-apply", () => {
    renderSurface(<ImprovementProposal proposal={improvementProposal} />);

    expect(screen.getByText("This proposal is inert")).toBeInTheDocument();
    expect(
      screen.getByText(/There is no auto-apply and no configuration that removes that step\./),
    ).toBeInTheDocument();
  });

  it("offers no control that would apply the change", () => {
    renderSurface(<ImprovementProposal proposal={improvementProposal} />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(/There is no approve control on this page/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the approvals queue" })).toHaveAttribute(
      "href",
      "/approvals",
    );
  });

  it("shows the before and the after in full, side by side", () => {
    renderSurface(<ImprovementProposal proposal={improvementProposal} />);

    const before = screen.getByRole("region", { name: "Before — what runs today" });
    const after = screen.getByRole("region", { name: "After — what would run if approved" });

    expect(within(before).getByText(improvementProposal.before)).toBeInTheDocument();
    expect(within(after).getByText(improvementProposal.after)).toBeInTheDocument();
  });

  it("states the evaluation delta and both sides of it", () => {
    renderSurface(<ImprovementProposal proposal={improvementProposal} />);

    expect(screen.getByText("+2.92 percentage points")).toBeInTheDocument();
    expect(screen.getByText(/96\.3% before, 99\.2% after/)).toBeInTheDocument();

    const beforeEvaluation = screen.getByRole("region", { name: "Before" });
    const afterEvaluation = screen.getByRole("region", { name: "After" });
    expect(within(beforeEvaluation).getByText("231 of 240 cases")).toBeInTheDocument();
    expect(within(afterEvaluation).getByText("238 of 240 cases")).toBeInTheDocument();
  });

  it("shows the blast radius as runs, roles, and workflows", () => {
    renderSurface(<ImprovementProposal proposal={improvementProposal} />);

    const radius = screen.getByRole("region", { name: "Blast radius" });
    expect(within(radius).getAllByText("2,238").length).toBeGreaterThan(0);
    expect(within(radius).getByRole("link", { name: "role_rescission_assurance" })).toHaveAttribute(
      "href",
      "/roles/role_rescission_assurance",
    );
    expect(within(radius).getByText("Rescission package assurance")).toBeInTheDocument();
  });

  it("says plainly when the change made the measured result worse", () => {
    renderSurface(<ImprovementProposal proposal={improvementProposalRegression} />);

    expect(screen.getByText("This change made the measured result worse")).toBeInTheDocument();
    expect(
      screen.getByText(/The improvement gate refuses a change that regresses measured quality/),
    ).toBeInTheDocument();
  });

  it("says when a change improves the result without making it adequate", () => {
    renderSurface(
      <ImprovementProposal
        proposal={{
          ...improvementProposalRegression,
          evaluationDelta: 1.5,
          evaluationAfter: {
            ...(improvementProposalRegression.evaluationAfter ?? improvementProposal.evaluationAfter)!,
            accuracy: 0.87,
            threshold: 0.9,
            meetsThreshold: false,
          },
        }}
      />,
    );

    expect(
      screen.getByText("Even after the change, the threshold is not met"),
    ).toBeInTheDocument();
  });

  it("says so when the proposal has not been evaluated at all", () => {
    renderSurface(
      <ImprovementProposal
        proposal={{
          ...improvementProposal,
          evaluationBefore: undefined,
          evaluationAfter: undefined,
          evaluationDelta: undefined,
        }}
      />,
    );

    expect(
      screen.getByText(/This proposal has not been evaluated\./),
    ).toBeInTheDocument();
  });

  it("names the artifact it would change and where the proposal came from", () => {
    renderSurface(<ImprovementProposal proposal={improvementProposal} />);

    const provenance = screen.getByRole("region", { name: "Where this came from" });
    expect(within(provenance).getByText("prompt · rescission-check/system")).toBeInTheDocument();
    expect(
      within(provenance).getByText("412 recorded observations of the same problem"),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<ImprovementProposal proposal={improvementProposal} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations for a regressing proposal", async () => {
    const { container } = renderSurface(
      <ImprovementProposal proposal={improvementProposalRegression} />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
