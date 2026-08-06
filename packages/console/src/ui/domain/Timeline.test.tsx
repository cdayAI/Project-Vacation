import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Timeline, type TimelineStep } from "./Timeline";

const STEPS: readonly TimelineStep[] = [
  {
    id: "s1",
    kind: "retrieval",
    title: "Retrieved owner contract",
    time: "09:41:02",
    duration: "120ms",
    cost: "$0.00",
    detail: "3 documents · 2 cited",
  },
  {
    id: "s2",
    kind: "model",
    title: "Determined rescission window",
    time: "09:41:03",
    duration: "1.4s",
    cost: "$0.011",
    citations: [{ id: "c1", source: "FL §721.10 (rev 2025-07-01)", kind: "retrieved" }],
    details: <p>Inputs and outputs</p>,
  },
  {
    id: "s3",
    kind: "wait",
    title: "Awaiting approval #4182",
    time: "09:41:05",
    state: "parked",
  },
];

describe("Timeline", () => {
  it("is an ordered list with a name of its own", () => {
    const { container } = renderSurface(<Timeline label="Run 41823 steps" steps={STEPS} />);
    expect(screen.getByRole("list", { name: "Run 41823 steps" })).toBeInTheDocument();
    // Counted by class rather than by role: a step's citations are a list of
    // their own, and their items are descendants of this one.
    expect(container.querySelectorAll(".pv-timeline-step")).toHaveLength(3);
  });

  it("shows cost and duration at rest, not one expansion deep", () => {
    // These two numbers are what make an autonomous system's behaviour
    // arguable rather than mysterious. Burying them means nobody sees them.
    renderSurface(<Timeline label="Run 41823 steps" steps={STEPS} />);
    expect(screen.getByText("1.4s")).toBeInTheDocument();
    expect(screen.getByText("$0.011")).toBeInTheDocument();
  });

  it("shows a model step's provenance without being asked", () => {
    renderSurface(<Timeline label="Run 41823 steps" steps={STEPS} />);
    expect(screen.getByText("FL §721.10 (rev 2025-07-01)")).toBeInTheDocument();
    expect(screen.getByText("Retrieved")).toBeInTheDocument();
  });

  it("names the step's kind for a screen reader, which cannot see the marker", () => {
    renderSurface(<Timeline label="Run 41823 steps" steps={STEPS} />);
    expect(screen.getByText("Model step.")).toHaveClass("pv-sr-only");
  });

  it("states a state that is not simply done", () => {
    renderSurface(<Timeline label="Run 41823 steps" steps={STEPS} />);
    expect(screen.getByText("Parked")).toBeInTheDocument();
  });

  it("expands a step to its inputs and outputs, and says which step", async () => {
    const user = userEvent.setup();
    renderSurface(<Timeline label="Run 41823 steps" steps={STEPS} />);

    const toggle = screen.getByRole("button", {
      name: "Show inputs and outputs for Determined rescission window",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(
      screen.getByRole("button", {
        name: "Hide inputs and outputs for Determined rescission window",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Inputs and outputs")).toBeVisible();
  });

  it("keeps two steps open at once", async () => {
    // An operator comparing the inputs of one step with the outputs of another
    // needs both. Accordion behaviour fights them.
    const user = userEvent.setup();
    renderSurface(
      <Timeline
        label="Run 41823 steps"
        steps={[
          { ...(STEPS[1] as TimelineStep), id: "a", details: <p>First details</p> },
          { ...(STEPS[1] as TimelineStep), id: "b", title: "Second step", details: <p>Second details</p> },
        ]}
      />,
    );

    for (const button of screen.getAllByRole("button")) {
      await user.click(button);
    }
    expect(screen.getByText("First details")).toBeVisible();
    expect(screen.getByText("Second details")).toBeVisible();
  });

  it("offers to correct a model step, and only a model step", async () => {
    const onCorrect = vi.fn();
    const user = userEvent.setup();
    renderSurface(<Timeline label="Run 41823 steps" steps={STEPS} onCorrect={onCorrect} />);

    const corrections = screen.getAllByRole("button", { name: /Correct this step/ });
    expect(corrections).toHaveLength(1);

    await user.click(corrections[0] as HTMLElement);
    expect(onCorrect).toHaveBeenCalledWith("s2");
  });

  it("drops the correction control when read-only and keeps the record", () => {
    renderSurface(
      <Timeline label="Run 41823 steps" steps={STEPS} onCorrect={vi.fn()} readOnly />,
    );
    expect(screen.queryByRole("button", { name: /Correct this/ })).toBeNull();
    expect(screen.getByText("Determined rescission window")).toBeInTheDocument();
  });

  it("says what followed a failure", () => {
    // A failure with no consequence written beside it sends the operator
    // hunting for whether anything happened.
    renderSurface(
      <Timeline
        label="Run 41823 steps"
        steps={[
          {
            id: "f1",
            kind: "action",
            title: "Wrote the servicing record",
            time: "09:41:09",
            state: "failed",
            failure: {
              what: "The servicing system refused the write.",
              then: "Retried twice, then escalated to Dana Ruiz.",
            },
          },
        ]}
      />,
    );
    expect(screen.getByText("The servicing system refused the write.")).toBeInTheDocument();
    expect(screen.getByText("Retried twice, then escalated to Dana Ruiz.")).toBeInTheDocument();
  });

  it("says nothing has run rather than showing an empty rail", () => {
    renderSurface(<Timeline label="Run 41823 steps" steps={[]} />);
    expect(screen.getByText("No steps have run yet.")).toBeInTheDocument();
  });

  it("prefers a failure over a spinner", () => {
    renderSurface(
      <Timeline label="Run 41823 steps" steps={[]} loading error="Reference 8f2a41." />,
    );
    expect(screen.queryByText("Loading")).toBeNull();
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("has no accessibility violations in any state", async () => {
    const { container } = renderSurface(
      <Timeline
        label="Run 41823 steps"
        steps={[
          ...STEPS,
          {
            id: "s4",
            kind: "human",
            title: "Approved by Dana Ruiz",
            time: "09:52:11",
            duration: "11m",
            actor: "Dana Ruiz",
          },
          {
            id: "s5",
            kind: "action",
            title: "Sent the confirmation",
            time: "09:52:14",
            state: "failed",
            failure: { what: "The mail gateway timed out.", then: "Retried and delivered." },
          },
        ]}
        onCorrect={() => {}}
      />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
