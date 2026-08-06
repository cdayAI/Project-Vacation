import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { workflowInstanceFinished, workflowInstanceStuck } from "../test/fixtures";
import { WorkflowInstance } from "./WorkflowInstance";

describe("WorkflowInstance", () => {
  it("leads with the plain-language status", () => {
    const { container } = renderSurface(<WorkflowInstance instance={workflowInstanceStuck} />);

    expect(
      screen.getByText(/waiting for a supervisor to approve it/, { exact: false }),
    ).toBeInTheDocument();

    // It is the first section on the page, before the summary or the steps.
    const headings = [...container.querySelectorAll("h2")].map((node) => node.textContent);
    expect(headings[0]).toBe("Where this has got to");
  });

  it("says what it is waiting for, in one place a supervisor cannot miss", () => {
    renderSurface(<WorkflowInstance instance={workflowInstanceStuck} />);

    expect(screen.getByText("This is waiting for something")).toBeInTheDocument();
    expect(
      screen.getAllByText("A supervisor to approve sending the corrected disclosure package."),
    ).not.toHaveLength(0);
  });

  it("shows the step sequence in order with its status", () => {
    const { container } = renderSurface(<WorkflowInstance instance={workflowInstanceStuck} />);

    // An ordered list, because the order is the information.
    const sequence = container.querySelector("ol.pv-steps");
    expect(sequence).not.toBeNull();
    expect(sequence?.querySelectorAll("li")).toHaveLength(7);

    expect(screen.getByRole("heading", { name: "Read the contract package" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Supervisor approval" })).toBeInTheDocument();
    expect(screen.getByText("Step 1")).toBeInTheDocument();
    expect(screen.getByText("Step 7")).toBeInTheDocument();
  });

  it("marks the step that has run past its time, in words", () => {
    const { container } = renderSurface(<WorkflowInstance instance={workflowInstanceStuck} />);

    expect(screen.getByText("Past due")).toBeInTheDocument();
    expect(
      screen.getByText("1 step has passed the time they were meant to take"),
    ).toBeInTheDocument();
    // And a second channel for someone scanning a long sequence.
    expect(container.querySelectorAll("li.pv-step-breached")).toHaveLength(1);
  });

  it("translates engine step kinds into something a supervisor can read", () => {
    renderSurface(<WorkflowInstance instance={workflowInstanceStuck} />);

    expect(screen.getAllByText("Reads a system of record").length).toBeGreaterThan(0);
    expect(screen.getByText("Waits for a person to approve")).toBeInTheDocument();
    expect(screen.getByText("Works out a statutory deadline")).toBeInTheDocument();
    // The raw dotted identifier never reaches the screen for a known kind.
    expect(screen.queryByText("approval.request")).not.toBeInTheDocument();
  });

  it("states the cost as spent rather than forecast", () => {
    renderSurface(<WorkflowInstance instance={workflowInstanceStuck} />);
    expect(screen.getByText(/\$0\.4821/)).toBeInTheDocument();
  });

  it("does not claim a finished instance is waiting for anything", () => {
    renderSurface(<WorkflowInstance instance={workflowInstanceFinished} />);

    expect(screen.queryByText("This is waiting for something")).not.toBeInTheDocument();
    expect(
      screen.getByText("Nothing — it is not blocked on anyone or anything"),
    ).toBeInTheDocument();
    expect(screen.getByText("Nothing outstanding")).toBeInTheDocument();
  });

  it("tells the reader when nothing has started yet rather than showing an empty list", () => {
    renderSurface(
      <WorkflowInstance instance={{ ...workflowInstanceStuck, steps: [], waitingOn: undefined }} />,
    );

    expect(screen.getByRole("heading", { name: "No steps yet" })).toBeInTheDocument();
  });

  it("links back to the work queue", () => {
    renderSurface(<WorkflowInstance instance={workflowInstanceStuck} />);
    expect(screen.getByRole("link", { name: "Work queue" })).toHaveAttribute("href", "/work");
  });

  it("keeps a machine-readable timestamp beside every formatted one", () => {
    const { container } = renderSurface(<WorkflowInstance instance={workflowInstanceStuck} />);
    const times = [...container.querySelectorAll("time")];
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) {
      expect(time).toHaveAttribute("dateTime");
    }
  });

  it("puts the summary facts where a supervisor looks for them", () => {
    renderSurface(<WorkflowInstance instance={workflowInstanceStuck} />);

    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText("Where it has got to")).toBeInTheDocument();
    expect(within(summary).getByText("Supervisor approval")).toBeInTheDocument();
    expect(within(summary).getByText("4 of 7 steps finished")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<WorkflowInstance instance={workflowInstanceStuck} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when the instance has finished", async () => {
    const { container } = renderSurface(<WorkflowInstance instance={workflowInstanceFinished} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations with no steps", async () => {
    const { container } = renderSurface(
      <WorkflowInstance instance={{ ...workflowInstanceStuck, steps: [] }} />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
