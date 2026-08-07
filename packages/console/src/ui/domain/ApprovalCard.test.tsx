import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { ApprovalCard, type ApprovalCardProps } from "./ApprovalCard";

const BASE: ApprovalCardProps = {
  ask: "Send a rescission confirmation to 3 owners in Florida.",
  requestedBy: "Rescission workflow",
  requestKind: "workflow",
  requestedAt: "09:41",
  risk: "high_consequence",
  ifApproved: [
    "Three owners receive the confirmation letter today.",
    "The contract record is marked rescinded.",
  ],
  ifRejected: "The case returns to the queue and nothing is sent.",
  rule: { label: "State rescission notice · high risk · policy R-14", href: "/config/policies/r-14" },
  blastRadius: {
    ownersAffected: "3 owners",
    money: "$0",
    reversible: "Yes, within 24 hours",
    howToReverse: "Void the notice and re-issue from the case",
  },
};

describe("ApprovalCard", () => {
  it("leads with the ask, in plain language", () => {
    renderSurface(<ApprovalCard {...BASE} />);
    expect(
      screen.getByRole("heading", { name: "Send a rescission confirmation to 3 owners in Florida." }),
    ).toBeInTheDocument();
  });

  it("says who asked, what kind of thing it is, when, and how risky", () => {
    renderSurface(<ApprovalCard {...BASE} />);
    expect(screen.getByText("Rescission workflow")).toBeInTheDocument();
    expect(screen.getByText("Workflow")).toBeInTheDocument();
    expect(screen.getByText("09:41")).toBeInTheDocument();
    expect(screen.getByText("High consequence")).toBeInTheDocument();
  });

  it("distinguishes an external agent from a workflow in words", () => {
    // Colour alone would make the most consequential distinction on the screen
    // invisible on a printout.
    renderSurface(<ApprovalCard {...BASE} requestKind="external-agent" />);
    expect(screen.getByText("External agent")).toBeInTheDocument();
  });

  it("states the consequence of yes as bullets and of no as one line", () => {
    renderSurface(<ApprovalCard {...BASE} />);
    expect(screen.getByText("Three owners receive the confirmation letter today.")).toBeInTheDocument();
    expect(screen.getByText("If you reject")).toBeInTheDocument();
    expect(
      screen.getByText("The case returns to the queue and nothing is sent."),
    ).toBeInTheDocument();
  });

  it("previews the exact artifact rather than a paraphrase of it", async () => {
    // A summary of an outbound letter is not the letter, and the difference is
    // where a compliance failure hides.
    const user = userEvent.setup();
    renderSurface(
      <ApprovalCard
        {...BASE}
        artifact={{ label: "the letter", preview: <p>Dear Ms Delgado, your contract…</p> }}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Preview the letter" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Dear Ms Delgado, your contract…")).not.toBeVisible();

    await user.click(toggle);
    expect(screen.getByText("Dear Ms Delgado, your contract…")).toBeVisible();
  });

  it("names the rule that made this need a human", () => {
    renderSurface(<ApprovalCard {...BASE} />);
    expect(
      screen.getByRole("link", { name: "State rescission notice · high risk · policy R-14" }),
    ).toHaveAttribute("href", "/config/policies/r-14");
  });

  it("puts the blast radius in four terms with their values", () => {
    renderSurface(<ApprovalCard {...BASE} />);
    for (const term of ["Owners affected", "Money", "Reversible?", "How to reverse"]) {
      expect(screen.getByText(term)).toBeInTheDocument();
    }
    expect(screen.getByText("Yes, within 24 hours")).toBeInTheDocument();
  });

  describe("the two answers", () => {
    it("gives Approve and Reject the same size and the same full width", () => {
      // Neither may be styled as the easy path. The grid is what enforces it;
      // this asserts the two buttons are peers rather than a button and a link.
      const { container } = renderSurface(
        <ApprovalCard {...BASE} onApprove={vi.fn()} onReject={vi.fn()} />,
      );
      const actions = container.querySelector(".pv-approval-actions") as HTMLElement;
      const [reject, approve] = within(actions).getAllByRole("button");

      expect(reject).toHaveAttribute("data-size", "lg");
      expect(approve).toHaveAttribute("data-size", "lg");
      expect(reject).toHaveAttribute("data-full-width", "true");
      expect(approve).toHaveAttribute("data-full-width", "true");
    });

    it("does not paint Reject as a destructive action", () => {
      // Danger red on Reject tells the operator which answer the system wants,
      // and an approval queue that nudges produces a record worth nothing.
      const { container } = renderSurface(
        <ApprovalCard {...BASE} onApprove={vi.fn()} onReject={vi.fn()} />,
      );
      const reject = screen.getByRole("button", { name: "Reject" });
      expect(reject).toHaveAttribute("data-variant", "secondary");
      expect(container.querySelector('[data-variant="danger"]')).toBeNull();
    });

    it("approves in one press", async () => {
      const onApprove = vi.fn();
      const user = userEvent.setup();
      renderSurface(<ApprovalCard {...BASE} onApprove={onApprove} onReject={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: "Approve" }));
      expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it("asks why, inline, before rejecting", async () => {
      // Never a modal: a modal covers the evidence somebody is rejecting on the
      // basis of.
      const onReject = vi.fn();
      const user = userEvent.setup();
      renderSurface(
        <ApprovalCard
          {...BASE}
          onApprove={vi.fn()}
          onReject={onReject}
          rejectReasons={[
            { id: "wrong-owner", label: "Wrong owner" },
            { id: "outside-window", label: "Outside the rescission window" },
          ]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Reject" }));
      expect(onReject).not.toHaveBeenCalled();
      // A fieldset and legend, which is what the Radio primitive builds: the
      // group's question has to be announced with every option in it.
      expect(screen.getByRole("group", { name: /Why are you rejecting this/ })).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).toBeNull();

      await user.click(screen.getByRole("radio", { name: "Wrong owner" }));
      await user.type(
        screen.getByRole("textbox", { name: /Anything else/ }),
        "Contract is under a different account.",
      );
      await user.click(screen.getByRole("button", { name: "Confirm rejection" }));

      expect(onReject).toHaveBeenCalledWith({
        reasonId: "wrong-owner",
        note: "Contract is under a different account.",
      });
    });

    it("moves focus to the reason the operator just asked for", async () => {
      const user = userEvent.setup();
      renderSurface(
        <ApprovalCard
          {...BASE}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          rejectReasons={[{ id: "wrong-owner", label: "Wrong owner" }]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Reject" }));
      expect(screen.getByRole("radio", { name: "Wrong owner" })).toHaveFocus();
    });

    it("lets the operator back out without deciding", async () => {
      const onReject = vi.fn();
      const user = userEvent.setup();
      renderSurface(
        <ApprovalCard {...BASE} onApprove={vi.fn()} onReject={onReject} />,
      );

      await user.click(screen.getByRole("button", { name: "Reject" }));
      await user.click(screen.getByRole("button", { name: "Keep reviewing" }));

      expect(onReject).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    });

    it("keeps both buttons in place while one of them is working", () => {
      // A bar that reflows the instant Approve is pressed moves Reject under
      // the cursor of an operator six items into a queue of forty.
      renderSurface(<ApprovalCard {...BASE} onApprove={vi.fn()} onReject={vi.fn()} busy="approve" />);
      expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("aria-busy", "true");
    });
  });

  it("shows the record instead of the actions once it is decided", () => {
    renderSurface(
      <ApprovalCard
        {...BASE}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        decision={{ outcome: "approved", by: "Dana Ruiz", at: "09:52" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText(/Dana Ruiz/)).toBeInTheDocument();
  });

  it("offers no decision at all in the auditor's view", () => {
    renderSurface(<ApprovalCard {...BASE} onApprove={vi.fn()} onReject={vi.fn()} readOnly />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByText("3 owners")).toBeInTheDocument();
  });

  it("states a failure rather than offering a decision on stale facts", () => {
    renderSurface(
      <ApprovalCard
        {...BASE}
        onApprove={vi.fn()}
        error="We could not load the case. Reference 8f2a41."
      />,
    );
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("has no accessibility violations in any state", async () => {
    const { container } = renderSurface(
      <>
        <ApprovalCard
          {...BASE}
          artifact={{ label: "the letter", preview: <p>Dear Ms Delgado…</p> }}
          evidence={<p>Evidence goes here.</p>}
          priorDecisions={<p>Five prior decisions.</p>}
          onApprove={() => {}}
          onReject={() => {}}
          rejectReasons={[{ id: "wrong-owner", label: "Wrong owner", description: "Sends it back." }]}
        />
        <ApprovalCard
          {...BASE}
          // A different ask: two approvals on one screen are two named
          // regions, and two regions with the same name are indistinguishable
          // to anyone navigating by landmark.
          ask="Write off $1,240 on account 41823."
          headingLevel={3}
          decision={{ outcome: "rejected", by: "Marc Webb", at: "10:02", reason: "Wrong owner" }}
        />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
