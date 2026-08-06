import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { emptyRun, runSucceeded, runWithRefusedStep } from "../test/fixtures";
import { RunDetail } from "./RunDetail";

describe("RunDetail", () => {
  it("identifies the run and how it was operating", () => {
    renderSurface(<RunDetail run={runWithRefusedStep} />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Delinquency evidence pack — loan LN-2024-NV-0930881 (NV)",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("run_01k3m6h1c5").length).toBeGreaterThan(0);
    expect(screen.getByText("Supervised")).toBeInTheDocument();
    expect(screen.getByText("Priya Raghunathan (owner_services_agent)")).toBeInTheDocument();
  });

  it("shows total cost and cost by category", () => {
    renderSurface(<RunDetail run={runWithRefusedStep} />);

    expect(screen.getByText("$0.0184")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Category/ })).toBeInTheDocument();
    expect(screen.getByText("knowledge.retrieve")).toBeInTheDocument();
  });

  it("renders every step with status, duration, cost, attempt, and digests", () => {
    renderSurface(<RunDetail run={runWithRefusedStep} />);

    expect(screen.getByRole("heading", { name: "Load loan file" })).toBeInTheDocument();
    expect(screen.getByText("2.4 s")).toBeInTheDocument();
    expect(screen.getByText("2 (retried 1×)")).toBeInTheDocument();
    // The digest is shown in full: a shortened one cannot be compared against
    // the audit chain, which is the reason it is on screen.
    expect(
      screen.getByText("44b1c07e9f2a5d8360cb14e7a09f5b2d3c81746ee0af9b25d3708c1a6e5f2093"),
    ).toBeInTheDocument();
  });

  it("renders a refused step as a refusal, in plain language, not as a failure", () => {
    renderSurface(<RunDetail run={runWithRefusedStep} />);

    expect(screen.getByText("This step was refused")).toBeInTheDocument();
    expect(
      screen.getByText(/Ranking or sequencing consumers is not a registered action for this role/),
    ).toBeInTheDocument();
    expect(screen.getByText("This run was refused")).toBeInTheDocument();
    expect(
      screen.getByText(/This is the platform working as designed, not a fault to be cleared/),
    ).toBeInTheDocument();
  });

  it("uses the denial tone rather than the failure tone for a refusal", () => {
    const { container } = renderSurface(<RunDetail run={runWithRefusedStep} />);
    expect(container.querySelectorAll(".pv-callout-denied").length).toBeGreaterThan(0);
  });

  it("renders citations with document, version, and effective date", () => {
    renderSurface(<RunDetail run={runWithRefusedStep} />);

    expect(
      screen.getByRole("heading", { name: "Nevada consumer finance servicing policy" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Version 2025.4")).toBeInTheDocument();
    expect(screen.getAllByText("In effect from").length).toBe(2);
    expect(screen.getByText("NV")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open the source document/ }),
    ).toHaveAttribute("href", "https://example.invalid/corpus/nv-consumer-finance/2025.4#00412");
  });

  it("warns when an authority is past its review date", () => {
    renderSurface(<RunDetail run={runWithRefusedStep} />);

    expect(screen.getByText("1 citation is past review")).toBeInTheDocument();
    expect(screen.getByText("Past review date")).toBeInTheDocument();
    expect(
      screen.getByText(/It may still be correct — nobody has confirmed that recently/),
    ).toBeInTheDocument();
  });

  it("reports a successful run without inventing a refusal", () => {
    renderSurface(<RunDetail run={runSucceeded} />);

    expect(screen.getByText("Outcome")).toBeInTheDocument();
    expect(screen.queryByText("This run was refused")).not.toBeInTheDocument();
    expect(screen.getByText("$0.0912")).toBeInTheDocument();
  });

  it("handles a run with no steps and no citations", () => {
    renderSurface(<RunDetail run={emptyRun} />);

    expect(screen.getByRole("heading", { name: "No steps recorded" })).toBeInTheDocument();
    expect(screen.getByText(/This run cited no source/)).toBeInTheDocument();
    expect(
      screen.getByText(/No cost has been attributed to a category on this run/),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<RunDetail run={runWithRefusedStep} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations for an empty run", async () => {
    const { container } = renderSurface(<RunDetail run={emptyRun} />);
    await expectNoAccessibilityViolations(container);
  });
});
