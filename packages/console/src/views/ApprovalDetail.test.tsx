import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalView } from "../api/contract";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import {
  approvalAwaitingDecision,
  approvalViewerMayNotDecide,
  selfApprovalDenial,
} from "../test/fixtures";
import { ApprovalDetail } from "./ApprovalDetail";

function expiringIn(approval: ApprovalView, milliseconds: number): ApprovalView {
  return { ...approval, expiresAt: new Date(Date.now() + milliseconds).toISOString() };
}

const decidable = expiringIn(approvalAwaitingDecision, 6 * 60 * 60 * 1000);
const notDecidable = expiringIn(approvalViewerMayNotDecide, 6 * 60 * 60 * 1000);
const expired = expiringIn(approvalAwaitingDecision, -60 * 1000);

describe("ApprovalDetail", () => {
  it("renders the proposal field by field, in full", () => {
    renderSurface(<ApprovalDetail approval={decidable} />);

    for (const field of decidable.proposal) {
      expect(screen.getByText(field.label)).toBeInTheDocument();
      expect(screen.getByText(field.value)).toBeInTheDocument();
    }
    // The deadline this decision moves is one of those fields, and it is the
    // reason the screen exists.
    expect(screen.getByText("Deadline if this is sent")).toBeInTheDocument();
    expect(screen.getByText("20 August 2026, 23:59 America/New_York")).toBeInTheDocument();
  });

  it("shows the proposal digest untruncated, and says what it binds", () => {
    renderSurface(<ApprovalDetail approval={decidable} />);

    const digests = screen.getAllByText(decidable.proposalDigest);
    expect(digests.length).toBeGreaterThan(0);
    expect(digests[0]?.textContent).toHaveLength(64);
    expect(
      screen.getByText(/Your decision binds to this digest and to no other proposal/),
    ).toBeInTheDocument();
  });

  it("states the risk tier and whether the action can be undone", () => {
    renderSurface(<ApprovalDetail approval={decidable} />);

    expect(screen.getByText("High consequence risk")).toBeInTheDocument();
    expect(screen.getByText("Irreversible")).toBeInTheDocument();
    expect(
      screen.getByText(/there is no compensating action that returns the world/),
    ).toBeInTheDocument();
  });

  it("warns about step-up re-authentication before the operator commits", () => {
    renderSurface(<ApprovalDetail approval={decidable} />);

    // Present on the page itself, above the decide controls — not sprung on
    // the operator after they press Approve.
    expect(screen.getByText("You will be asked to re-authenticate")).toBeInTheDocument();
    expect(screen.getByText("Re-authentication required")).toBeInTheDocument();
  });

  it("shows N-of-M progress and who has already decided", () => {
    renderSurface(<ApprovalDetail approval={decidable} />);

    expect(screen.getByText(/1 of 2 granted — 1 more is needed/)).toBeInTheDocument();
    expect(screen.getByText("Marcus Oyelaran")).toBeInTheDocument();
    expect(screen.getByText("Granted")).toBeInTheDocument();
    // A second approver has to be able to see that the first one hedged.
    expect(screen.getByText(/the rule is still marked unverified in the corpus/)).toBeInTheDocument();
  });

  it("shows the expiry as a countdown next to the absolute deadline", () => {
    renderSurface(<ApprovalDetail approval={decidable} />);
    expect(screen.getByText(/hours .* remaining|hours remaining/)).toBeInTheDocument();
  });

  it("disables the decide controls with an explanation when the viewer may not decide", () => {
    renderSurface(<ApprovalDetail approval={notDecidable} />);

    const approve = screen.getByRole("button", { name: "Approve this action" });
    expect(approve).toHaveAttribute("aria-disabled", "true");

    // Reachable rather than removed from the tab order, and pointing at the
    // sentence that says why.
    const describedBy = approve.getAttribute("aria-describedby");
    expect(describedBy).toBe("approval-decide-blocked");
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      "You raised this proposal, and nobody may approve their own.",
    );
  });

  it("refuses to act when the decide control is unavailable", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    renderSurface(<ApprovalDetail approval={notDecidable} onDecide={onDecide} />);

    await user.click(screen.getByRole("button", { name: "Approve this action" }));

    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("blocks the decision once the approval has expired, and says so", () => {
    renderSurface(<ApprovalDetail approval={expired} />);

    expect(screen.getByRole("button", { name: "Approve this action" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText(/This approval expired at/)).toBeInTheDocument();
  });

  it("confirms before recording an approval, restating what is being authorised", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    renderSurface(<ApprovalDetail approval={decidable} onDecide={onDecide} />);

    await user.click(screen.getByRole("button", { name: "Approve this action" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Confirm your approval");
    expect(screen.getByText("Re-authentication follows")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Record my approval" }));

    expect(onDecide).toHaveBeenCalledWith("granted", "");
  });

  it("requires a reason before recording a rejection", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    renderSurface(<ApprovalDetail approval={decidable} onDecide={onDecide} />);

    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.click(screen.getByRole("button", { name: "Record my rejection" }));

    expect(onDecide).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Say why you are rejecting this/),
    ).toBeInTheDocument();

    await user.type(
      screen.getByLabelText("Why are you rejecting this?"),
      "The rescission recompute uses an unverified rule.",
    );
    await user.click(screen.getByRole("button", { name: "Record my rejection" }));

    expect(onDecide).toHaveBeenCalledWith(
      "rejected",
      "The rescission recompute uses an unverified rule.",
    );
  });

  it("says plainly that hiding a control is not the security boundary", () => {
    renderSurface(<ApprovalDetail approval={decidable} />);
    expect(
      screen.getByText(/courtesy of this screen, not a security boundary/),
    ).toBeInTheDocument();
  });

  it("renders a refused decision as an outcome rather than an error", () => {
    renderSurface(<ApprovalDetail approval={decidable} decisionDenial={selfApprovalDenial} />);

    expect(screen.getByText("You raised this proposal, so you may not approve it.")).toBeInTheDocument();
    expect(screen.getByText("approval.self_approval")).toBeInTheDocument();
    expect(screen.getByText(/A different eligible approver has to decide this/)).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<ApprovalDetail approval={decidable} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when the viewer may not decide", async () => {
    const { container } = renderSurface(<ApprovalDetail approval={notDecidable} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations with the confirmation dialog open", async () => {
    const user = userEvent.setup();
    const { container } = renderSurface(<ApprovalDetail approval={decidable} />);

    await user.click(screen.getByRole("button", { name: "Approve this action" }));

    await expectNoAccessibilityViolations(container);
  });
});
