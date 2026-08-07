import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ApprovalView } from "../api/contract";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { approvalAwaitingDecision, approvalViewerMayNotDecide } from "../test/fixtures";
import { ApprovalsQueue } from "./ApprovalsQueue";

/**
 * Expiry is relative to the wall clock, so the fixtures are re-dated here
 * rather than pinned in the fixture file. A test that passes only in August
 * 2026 is not a test.
 */
function expiringIn(approval: ApprovalView, milliseconds: number): ApprovalView {
  return { ...approval, expiresAt: new Date(Date.now() + milliseconds).toISOString() };
}

const soon = expiringIn(approvalAwaitingDecision, 20 * 60 * 1000);
const later = expiringIn(approvalViewerMayNotDecide, 20 * 60 * 60 * 1000);

describe("ApprovalsQueue", () => {
  it("lists each approval with its action, risk, and progress", () => {
    renderSurface(<ApprovalsQueue approvals={[soon, later]} total={2} />);

    // The row leads with the ask, in plain language — not with the action
    // registry's description of the class of action, which is identical on
    // every row of that kind.
    expect(
      screen.getByRole("link", { name: soon.ask }),
    ).toHaveAttribute("href", "/approvals/apr_01k3n2f6r4");
    expect(screen.getByText(soon.actionDescription)).toBeInTheDocument();

    expect(screen.getAllByText("High consequence risk").length).toBeGreaterThan(0);
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("says in words when an action cannot be undone", () => {
    renderSurface(<ApprovalsQueue approvals={[soon]} />);
    expect(screen.getByText("No — cannot be undone")).toBeInTheDocument();
  });

  it("shows a countdown alongside the absolute expiry time", () => {
    renderSurface(<ApprovalsQueue approvals={[soon]} />);

    expect(screen.getByText(/remaining$/)).toBeInTheDocument();
    // The absolute deadline is in the markup as a machine-readable instant, so
    // the exact time is available without waiting for a tick.
    expect(screen.getByText(/remaining$/).closest("td")?.querySelector("time")).toHaveAttribute(
      "dateTime",
      soon.expiresAt,
    );
  });

  it("warns when approvals are about to expire", () => {
    renderSurface(<ApprovalsQueue approvals={[soon, later]} />);
    expect(screen.getByText("1 approval expires within the hour")).toBeInTheDocument();
  });

  it("says who may decide, and why not, without hiding the row", () => {
    renderSurface(<ApprovalsQueue approvals={[soon, later]} />);

    expect(screen.getByText("May decide")).toBeInTheDocument();
    // The server's own sentence, rendered verbatim. The console does not
    // paraphrase a refusal reason: two wordings of one rule is how a screen
    // and an API start disagreeing about what the rule is.
    expect(later.viewerMayNotDecideReason).toBeDefined();
    expect(
      screen.getByText(`May not decide — ${later.viewerMayNotDecideReason}`),
    ).toBeInTheDocument();
  });

  it("offers no decide control, because a row cannot show a proposal in full", () => {
    renderSurface(<ApprovalsQueue approvals={[soon, later]} />);

    // `grid`, not `table`: J/K/Enter row navigation is a widget, and the role
    // says so. The rows and the row headers inside it are unchanged.
    const grid = screen.getByRole("grid");
    expect(within(grid).queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();

    // Widened past the grid on purpose. The table now brings its own controls —
    // a sort button per column and a column chooser — and the claim worth
    // holding is not "the grid has no buttons" but "nothing anywhere on this
    // screen decides an approval". Sorting and choosing columns change what
    // this operator is looking at; they change nothing in the platform.
    const deciding = screen
      .getAllByRole("button")
      .filter((button) => /\b(approve|reject|decide)\b/i.test(button.textContent ?? ""));
    expect(deciding).toEqual([]);
  });

  it("opens on the soonest expiry, and says in aria-sort that it did", async () => {
    const user = userEvent.setup();
    // Handed to the view in the wrong order, so a pass cannot be the input
    // order surviving untouched.
    renderSurface(<ApprovalsQueue approvals={[later, soon]} />);

    const expires = screen.getByRole("columnheader", { name: /Expires/ });
    // A queue that is silently sorted is a queue an operator cannot trust the
    // top of. The order and the announcement of it are one guarantee.
    expect(expires).toHaveAttribute("aria-sort", "ascending");
    const rows = within(screen.getByRole("grid")).getAllByRole("row");
    expect(within(rows[1] as HTMLElement).getByRole("link", { name: soon.ask })).toBeInTheDocument();

    await user.click(within(expires).getByRole("button"));

    expect(expires).toHaveAttribute("aria-sort", "descending");
    const reordered = within(screen.getByRole("grid")).getAllByRole("row");
    expect(
      within(reordered[1] as HTMLElement).getByRole("link", { name: later.ask }),
    ).toBeInTheDocument();
  });

  it("tells an operator when nothing is waiting", () => {
    renderSurface(<ApprovalsQueue approvals={[]} total={0} />);
    expect(screen.getByRole("heading", { name: "No approvals are waiting" })).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<ApprovalsQueue approvals={[soon, later]} total={2} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when empty", async () => {
    const { container } = renderSurface(<ApprovalsQueue approvals={[]} total={0} />);
    await expectNoAccessibilityViolations(container);
  });
});
