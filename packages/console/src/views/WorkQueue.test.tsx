import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { workQueueItems } from "../test/fixtures";
import { WorkQueue } from "./WorkQueue";

/**
 * Counts are derived from the fixture rather than written in.
 *
 * A literal `3` here is a test that starts failing the next time somebody adds
 * a realistic row, and the failure says nothing about the behaviour. What is
 * being asserted is that the screen agrees with its own data.
 */
const breached = workQueueItems.filter((item) => item.slaBreached);
const shadow = workQueueItems.filter((item) => item.mode === "shadow");
const failed = workQueueItems.filter((item) => item.status === "failed");

describe("WorkQueue", () => {
  it("renders every queued item with its identifier and what it is waiting on", () => {
    renderSurface(<WorkQueue items={workQueueItems} total={workQueueItems.length} />);

    expect(
      screen.getByRole("link", {
        name: "Rescission package check — contract CTR-2026-FL-0184423",
      }),
    ).toHaveAttribute("href", "/runs/run_01k3m9x2p7");

    expect(screen.getByText(/run_01k3m9x2p7/)).toBeInTheDocument();
    // Every row, not just the first: a queue that renders eight of nine items
    // is worse than one that renders none, because nobody notices.
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(workQueueItems.length + 1);
  });

  it("states an SLA breach in words, not only in colour", () => {
    renderSurface(<WorkQueue items={workQueueItems} />);

    // Each breaching item says so in its own age cell.
    expect(screen.getAllByText("Past due")).toHaveLength(breached.length);
    // And the count is stated above the table, so it cannot be missed by
    // someone who does not read every row.
    expect(
      screen.getByText(`${breached.length} item${breached.length === 1 ? " is" : "s are"} past due`),
    ).toBeInTheDocument();
    // Items inside their SLA say that too, rather than saying nothing.
    expect(screen.getAllByText("Within SLA").length).toBeGreaterThan(0);
  });

  it("marks a breached row for sighted scanning as well", () => {
    const { container } = renderSurface(<WorkQueue items={workQueueItems} />);
    expect(container.querySelectorAll("tr.pv-row-breached")).toHaveLength(breached.length);
  });

  it("does not claim a finished run met a deadline it may have missed", () => {
    renderSurface(<WorkQueue items={workQueueItems} />);

    // The platform reports terminal work as un-breached because nobody is
    // waiting on it — not because it was delivered on time. Rendering that as
    // "Within SLA" would turn a deliberate silence into a claim.
    const finished = workQueueItems.filter(
      (item) =>
        item.status === "succeeded" ||
        item.status === "failed" ||
        item.status === "cancelled" ||
        item.status === "denied",
    );
    expect(finished.length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not waiting")).toHaveLength(finished.length);
  });

  it("says a run has no service-level target rather than inventing a deadline", () => {
    const noTarget = workQueueItems.filter((item) => item.slaTargetUnknown !== undefined);
    expect(noTarget.length).toBeGreaterThan(0);

    renderSurface(<WorkQueue items={workQueueItems} />);

    expect(screen.getAllByText("No target")).toHaveLength(noTarget.length);
    expect(
      screen.getByText(/No service-level target is declared for "inventory.recovery_forecast"/),
    ).toBeInTheDocument();
  });

  it("names the policy behind a deadline, so the number is attributable", () => {
    renderSurface(<WorkQueue items={workQueueItems} />);
    expect(
      screen.getAllByText("Rescission package check — one business day").length,
    ).toBeGreaterThan(0);
  });

  it("shows an owner's name when one is known and says why when it is not", () => {
    renderSurface(<WorkQueue items={workQueueItems} />);

    expect(screen.getByText("M. Delgado")).toBeInTheDocument();
    // The account reference is shown either way — it is what the operating
    // record actually holds.
    expect(screen.getByText("CTR-2026-FL-0184423")).toBeInTheDocument();
    expect(
      screen.getByText(/The operating record holds an opaque account reference, never an owner/),
    ).toBeInTheDocument();
  });

  it("leaves case value absent with a reason rather than showing a zero", () => {
    renderSurface(<WorkQueue items={workQueueItems} />);

    expect(screen.getByText("$1,412,000")).toBeInTheDocument();
    expect(
      screen.getAllByText(
        /Case value comes from the contract and billing systems of record, which are not connected/,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("distinguishes work nobody has picked up from work it cannot track", () => {
    renderSurface(<WorkQueue items={workQueueItems} />);

    expect(screen.getAllByText("Unassigned").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Assignment is not modelled on a run, so this deployment cannot say who/),
    ).toBeInTheDocument();
  });

  it("gives the next action as a verb phrase, linked when it is an approval", () => {
    renderSurface(<WorkQueue items={workQueueItems} />);

    expect(
      screen.getByRole("link", {
        name: /Approve or reject the parked action for Rescission package check — contract CTR-2026-FL-0184423/,
      }),
    ).toHaveAttribute("href", "/approvals/apr_01k3n2f6r4");
    // Not every next action is a link — most are a statement of what happens
    // next, and dressing one up as a control would be a dead end.
    expect(screen.getAllByText("Wait — the platform is working on it").length).toBeGreaterThan(0);
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
    expect(within(table).getAllByRole("row")).toHaveLength(failed.length + 1);
    expect(
      screen.getByRole("link", {
        name: "Rescission package check — contract CTR-2026-HI-0166204",
      }),
    ).toBeInTheDocument();
  });

  it("filters by operating mode", async () => {
    const user = userEvent.setup();
    renderSurface(<WorkQueue items={workQueueItems} />);

    await user.selectOptions(screen.getByLabelText("Operating mode"), "shadow");

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(shadow.length + 1);
  });

  it("filters to SLA breaches only", async () => {
    const user = userEvent.setup();
    renderSurface(<WorkQueue items={workQueueItems} />);

    await user.click(screen.getByLabelText("Only items past their SLA"));

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(breached.length + 1);
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

  it("says when the result count is not the whole queue", () => {
    renderSurface(
      <WorkQueue items={workQueueItems} total={workQueueItems.length} totalIsExact={false} />,
    );

    expect(
      screen.getByText("This count is not the whole queue"),
    ).toBeInTheDocument();
  });

  it("does not warn about the count when the server says it is exact", () => {
    renderSurface(<WorkQueue items={workQueueItems} total={workQueueItems.length} />);
    expect(screen.queryByText("This count is not the whole queue")).not.toBeInTheDocument();
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
