import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { emptyRun, runSucceeded, runWithRefusedStep } from "../test/fixtures";
import { RunDetail } from "./RunDetail";

describe("RunDetail", () => {
  it("identifies the run and how it was operating", () => {
    renderSurface(<RunDetail run={runWithRefusedStep} />);

    expect(
      screen.getByRole("heading", { level: 1, name: runWithRefusedStep.title }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("run_01k3m6h1c5").length).toBeGreaterThan(0);
    expect(screen.getByText("Supervised")).toBeInTheDocument();
    expect(
      screen.getByText(
        `${runWithRefusedStep.requestedBy.displayName} (${runWithRefusedStep.requestedBy.roles.join(", ")})`,
      ),
    ).toBeInTheDocument();
  });

  it("shows total cost and cost by category", () => {
    renderSurface(<RunDetail run={runWithRefusedStep} />);

    // Three places, and all three are wanted: the run total, the category
    // breakdown, and the step that actually incurred it.
    expect(screen.getAllByText("$0.0184")).toHaveLength(3);
    expect(screen.getByRole("columnheader", { name: /Category/ })).toBeInTheDocument();
    // A grid rather than a table: the row cursor makes it a widget, and the
    // columnheader / rowheader semantics inside it are unchanged.
    const costTable = screen.getByRole("grid");
    // Every category the run reports, not a selection of them: a breakdown
    // that omits a line does not add up to the total above it.
    for (const category of Object.keys(runWithRefusedStep.costByCategory)) {
      expect(within(costTable).getByText(category)).toBeInTheDocument();
    }
  });

  it("renders every step with status, duration, cost, attempt, and digests", () => {
    renderSurface(<RunDetail run={runWithRefusedStep} />);

    expect(screen.getByRole("heading", { name: "Load loan file" })).toBeInTheDocument();
    expect(screen.getByText("2.4 s")).toBeInTheDocument();
    expect(screen.getByText("2 (retried 1×)")).toBeInTheDocument();
    // Every digest the run carries, character for character with its algorithm
    // prefix. A shortened digest cannot be compared against the audit chain,
    // and one stripped of its algorithm cannot be recomputed — which between
    // them are the only two reasons either is on screen.
    const digests = runWithRefusedStep.steps.flatMap((step) =>
      [step.inputDigest, step.outputDigest].filter((digest): digest is string => digest !== undefined),
    );
    expect(digests.length).toBeGreaterThan(0);
    for (const digest of digests) {
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(screen.getByText(digest)).toBeInTheDocument();
    }
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
    const denied = [...container.querySelectorAll('.pv-notice[data-tone="denied"]')];
    expect(denied.length).toBeGreaterThan(0);
    // And it is the refusals that are drawn that way, rather than some other
    // block on the page happening to carry the tone. Counting denied notices
    // alone would still pass if the two refusals were painted as failures and
    // something unrelated was painted as a refusal.
    for (const sentence of ["This run was refused", "This step was refused"]) {
      const notice = screen.getByText(sentence).closest(".pv-notice");
      expect(notice).toHaveAttribute("data-tone", "denied");
    }
  });

  it("renders citations with document, version, and effective date", () => {
    renderSurface(<RunDetail run={runWithRefusedStep} />);

    expect(
      screen.getByRole("heading", { name: "Nevada consumer finance servicing policy" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Version 2025.4")).toBeInTheDocument();
    expect(screen.getAllByText("In effect from").length).toBe(2);
    expect(screen.getAllByText("NV").length).toBeGreaterThan(0);
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
    expect(screen.getAllByText("$0.0912").length).toBeGreaterThan(0);
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
