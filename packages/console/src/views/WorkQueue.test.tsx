import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { workQueueItems } from "../test/fixtures";
import { WorkQueue } from "./WorkQueue";

describe("WorkQueue", () => {
  it("renders every queued item with its identifier and what it is waiting on", () => {
    renderSurface(<WorkQueue items={workQueueItems} total={workQueueItems.length} />);

    expect(
      screen.getByRole("link", {
        name: "Rescission package check — contract CTR-2026-FL-0184423 (FL)",
      }),
    ).toHaveAttribute("href", "/runs/run_01k3m9x2p7");

    expect(screen.getByText(/run_01k3m9x2p7/)).toBeInTheDocument();
    expect(
      screen.getByText("A supervisor to approve sending the corrected disclosure package."),
    ).toBeInTheDocument();
  });

  it("states an SLA breach in words, not only in colour", () => {
    renderSurface(<WorkQueue items={workQueueItems} />);

    // Three fixtures are past due. Each one says so in its own cell.
    expect(screen.getAllByText("Past due")).toHaveLength(3);
    // And the count is stated above the table, so it cannot be missed by
    // someone who does not read every row.
    expect(screen.getByText("3 items are past due")).toBeInTheDocument();
    // Items inside their SLA say that too, rather than saying nothing.
    expect(screen.getAllByText("Within SLA").length).toBeGreaterThan(0);
  });

  it("marks a breached row for sighted scanning as well", () => {
    const { container } = renderSurface(<WorkQueue items={workQueueItems} />);
    expect(container.querySelectorAll("tr.pv-row-breached")).toHaveLength(3);
  });

  it("shows cost, including costs below a cent", () => {
    renderSurface(<WorkQueue items={workQueueItems} />);
    // Rounding a fraction of a cent to $0.00 would read as "free".
    expect(screen.getByText("$0.0037")).toBeInTheDocument();
    expect(screen.getByText("$2.14")).toBeInTheDocument();
  });

  it("filters by status", async () => {
    const user = userEvent.setup();
    renderSurface(<WorkQueue items={workQueueItems} />);

    await user.selectOptions(screen.getByLabelText("Status"), "failed");

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2); // header plus one
    expect(
      screen.getByRole("link", {
        name: "Rescission package check — contract CTR-2026-HI-0166204 (HI)",
      }),
    ).toBeInTheDocument();
  });

  it("filters by operating mode", async () => {
    const user = userEvent.setup();
    renderSurface(<WorkQueue items={workQueueItems} />);

    await user.selectOptions(screen.getByLabelText("Operating mode"), "shadow");

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header plus two
  });

  it("filters to SLA breaches only", async () => {
    const user = userEvent.setup();
    renderSurface(<WorkQueue items={workQueueItems} />);

    await user.click(screen.getByLabelText("Only items past their SLA"));

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4); // header plus three
  });

  it("exposes sort state to assistive technology", async () => {
    const user = userEvent.setup();
    renderSurface(<WorkQueue items={workQueueItems} />);

    const costHeader = screen.getByRole("columnheader", { name: /Cost/ });
    expect(costHeader).toHaveAttribute("aria-sort", "none");

    await user.click(within(costHeader).getByRole("button"));
    expect(costHeader).toHaveAttribute("aria-sort", "ascending");

    await user.click(within(costHeader).getByRole("button"));
    expect(costHeader).toHaveAttribute("aria-sort", "descending");
  });

  it("sorts rows by the chosen column", async () => {
    const user = userEvent.setup();
    renderSurface(<WorkQueue items={workQueueItems} />);

    const costHeader = screen.getByRole("columnheader", { name: /Cost/ });
    await user.click(within(costHeader).getByRole("button"));
    await user.click(within(costHeader).getByRole("button"));

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    // Descending: the most expensive item is first after the header row.
    expect(within(rows[1] as HTMLElement).getByText("$2.14")).toBeInTheDocument();
  });

  it("tells an operator that the queue is empty rather than showing nothing", () => {
    renderSurface(<WorkQueue items={[]} total={0} />);

    expect(
      screen.getByRole("heading", { name: "The work queue is empty" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("distinguishes an empty queue from an over-tight filter", async () => {
    const user = userEvent.setup();
    renderSurface(<WorkQueue items={workQueueItems} />);

    await user.selectOptions(screen.getByLabelText("Status"), "cancelled");

    expect(
      screen.getByRole("heading", { name: "Nothing matches these filters" }),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <WorkQueue items={workQueueItems} total={workQueueItems.length} />,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when empty", async () => {
    const { container } = renderSurface(<WorkQueue items={[]} total={0} />);
    await expectNoAccessibilityViolations(container);
  });
});
