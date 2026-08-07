import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Modal } from "./Modal";

function Harness({
  tone,
  dismissOnOutsideClick,
}: {
  readonly tone?: "default" | "danger";
  readonly dismissOnOutsideClick?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button type="button" ref={trigger} onClick={() => setOpen(true)}>
        Revoke credentials
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Revoke credentials for sf-quotebot?"
        description="It stops working immediately, including three runs in flight."
        tone={tone}
        originRef={trigger}
        dismissOnOutsideClick={dismissOnOutsideClick}
        actions={
          <>
            <button type="button" onClick={() => setOpen(false)}>
              Keep them
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              Revoke
            </button>
          </>
        }
      >
        <p>You can issue new credentials at any time, but these cannot be restored.</p>
      </Modal>
    </>
  );
}

describe("Modal", () => {
  it("renders nothing at all while it is closed", () => {
    // A closed dialog whose content is still in the document is content a
    // screen reader can wander into.
    renderSurface(
      <Modal open={false} onClose={() => {}} title="Revoke credentials?">
        Body
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names itself with its question and describes itself with the consequence", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.click(screen.getByRole("button", { name: "Revoke credentials" }));

    const dialog = screen.getByRole("dialog", { name: "Revoke credentials for sf-quotebot?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(
      "It stops working immediately, including three runs in flight.",
    );
  });

  it("announces as an alert only when the action cannot be undone", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness tone="danger" />);
    await user.click(screen.getByRole("button", { name: "Revoke credentials" }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("puts focus on the question, not on the button that answers it", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.click(screen.getByRole("button", { name: "Revoke credentials" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Revoke credentials for sf-quotebot?" })).toHaveFocus(),
    );
  });

  it("returns focus to the control that opened it", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    const trigger = screen.getByRole("button", { name: "Revoke credentials" });

    await user.click(trigger);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  describe("focus containment", () => {
    it("wraps forward from the last control back to the first", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);
      await user.click(screen.getByRole("button", { name: "Revoke credentials" }));

      screen.getByRole("button", { name: "Revoke" }).focus();
      await user.tab();

      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });

    it("wraps backward from the first control to the last", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);
      await user.click(screen.getByRole("button", { name: "Revoke credentials" }));

      screen.getByRole("button", { name: "Close" }).focus();
      await user.tab({ shift: true });

      expect(screen.getByRole("button", { name: "Revoke" })).toHaveFocus();
    });
  });

  describe("dismissal", () => {
    it("closes on Escape", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);
      await user.click(screen.getByRole("button", { name: "Revoke credentials" }));

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("closes on a click that starts and ends on the scrim", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);
      await user.click(screen.getByRole("button", { name: "Revoke credentials" }));

      await user.click(screen.getByRole("dialog"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("does not close when a selection drag ends on the scrim", async () => {
      // Losing a half-read consequence because a text selection ran off the
      // edge is the single most disliked thing a modal can do.
      const user = userEvent.setup();
      renderSurface(<Harness />);
      await user.click(screen.getByRole("button", { name: "Revoke credentials" }));

      const dialog = screen.getByRole("dialog");
      const body = screen.getByText(
        "You can issue new credentials at any time, but these cannot be restored.",
      );

      await user.pointer([
        { target: body, keys: "[MouseLeft>]" },
        { target: dialog },
        { keys: "[/MouseLeft]" },
      ]);

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("ignores an outside click when told to", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness dismissOnOutsideClick={false} />);
      await user.click(screen.getByRole("button", { name: "Revoke credentials" }));

      await user.click(screen.getByRole("dialog"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("offers a close control with a name", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      renderSurface(
        <Modal open onClose={onClose} title="Revoke credentials?">
          Body
        </Modal>,
      );

      await user.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("can hide the close control for a dialog that must be answered", () => {
      renderSurface(
        <Modal open onClose={() => {}} title="Revoke credentials?" hideCloseButton>
          Body
        </Modal>,
      );
      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    });
  });

  describe("holding the page still", () => {
    it("locks page scrolling while it is open and gives it back on close", async () => {
      const user = userEvent.setup();
      renderSurface(<Harness />);
      expect(document.documentElement.style.overflow).toBe("");

      await user.click(screen.getByRole("button", { name: "Revoke credentials" }));
      expect(document.documentElement.style.overflow).toBe("hidden");

      await user.keyboard("{Escape}");
      await waitFor(() => expect(document.documentElement.style.overflow).toBe(""));
    });

    it("keeps the page locked while a second overlay is still covering it", async () => {
      // A sheet opening a confirmation is a real flow, and the modal closing
      // must not hand scrolling back to a page the sheet is still over.
      const user = userEvent.setup();
      function Nested() {
        const [inner, setInner] = useState(false);
        return (
          <Modal open onClose={() => {}} title="Preview changes">
            <button type="button" onClick={() => setInner(true)}>
              Confirm
            </button>
            <Modal open={inner} onClose={() => setInner(false)} title="Are you sure?">
              Body
            </Modal>
          </Modal>
        );
      }
      renderSurface(<Nested />);

      await user.click(screen.getByRole("button", { name: "Confirm" }));
      expect(document.documentElement.style.overflow).toBe("hidden");

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
      expect(document.documentElement.style.overflow).toBe("hidden");
    });
  });

  describe("designed states", () => {
    it("shows a loading body", () => {
      renderSurface(
        <Modal open onClose={() => {}} title="Preview changes" loading>
          Body
        </Modal>,
      );
      expect(screen.getByText("Loading")).toHaveClass("pv-sr-only");
    });

    it("states an error in words", () => {
      renderSurface(
        <Modal open onClose={() => {}} title="Preview changes" error="Reference 8f2a41." />,
      );
      expect(screen.getByText("Error")).toBeInTheDocument();
    });

    it("marks read-only", () => {
      renderSurface(
        <Modal open onClose={() => {}} title="Approval record" readOnly>
          Body
        </Modal>,
      );
      expect(screen.getByText("Read-only")).toBeInTheDocument();
    });
  });

  it("has no accessibility violations", async () => {
    const { baseElement } = renderSurface(
      <Modal
        open
        onClose={() => {}}
        title="Revoke credentials for sf-quotebot?"
        description="It stops working immediately."
        actions={
          <>
            <button type="button">Keep them</button>
            <button type="button">Revoke</button>
          </>
        }
      >
        <p>You can issue new credentials at any time.</p>
      </Modal>,
    );

    await expectNoAccessibilityViolations(baseElement);
  });
});
