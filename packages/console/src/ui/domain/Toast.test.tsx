import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Toast, ToastRegion, TOAST_DURATION_MS, UNDO_WINDOW_MS } from "./Toast";

describe("Toast", () => {
  it("never takes focus", async () => {
    // Approvals advance automatically after a decision, so a toast appears
    // while the operator is already reading the next item. Moving focus would
    // cost them their place and their next keystroke.
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    renderSurface(
      <ToastRegion>
        <Toast title="Approved. Letter queued for 3 owners." onDismiss={() => {}} />
      </ToastRegion>,
    );

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("announces politely from a region that was already mounted", () => {
    // A live region created at the same moment as its content announces
    // nothing: assistive technology has to be watching the node first.
    renderSurface(<ToastRegion />);
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "false");
  });

  it("says the tone in words, not only in the tint", () => {
    renderSurface(
      <ToastRegion>
        <Toast tone="success" title="Approved." onDismiss={() => {}} />
      </ToastRegion>,
    );
    expect(screen.getByText("Success:")).toHaveClass("pv-sr-only");
  });

  it("is always dismissible, with a name that distinguishes it", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    renderSurface(
      <ToastRegion>
        <Toast title="Approved. Letter queued." onDismiss={onDismiss} />
      </ToastRegion>,
    );

    await user.click(screen.getByRole("button", { name: "Dismiss: Approved. Letter queued." }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("links to the permanent record, because a toast is a receipt", async () => {
    renderSurface(
      <ToastRegion>
        <Toast
          title="Approved."
          record={{ href: "/approvals/4182" }}
          onDismiss={() => {}}
        />
      </ToastRegion>,
    );
    expect(screen.getByRole("link", { name: "See the record" })).toHaveAttribute(
      "href",
      "/approvals/4182",
    );
  });

  it("undoes and then closes itself", async () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    renderSurface(
      <ToastRegion>
        <Toast title="Approved." undo={{ onUndo }} onDismiss={onDismiss} />
      </ToastRegion>,
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  describe("its own lifetime", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("gives an undo toast exactly the undo window", () => {
      const onDismiss = vi.fn();
      renderSurface(
        <ToastRegion>
          <Toast title="Approved." undo={{ onUndo: () => {} }} onDismiss={onDismiss} />
        </ToastRegion>,
      );

      act(() => {
        vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
      });
      expect(onDismiss).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it("gives a toast with no action long enough to read twice", () => {
      const onDismiss = vi.fn();
      renderSurface(
        <ToastRegion>
          <Toast title="Saved." onDismiss={onDismiss} />
        </ToastRegion>,
      );

      act(() => {
        vi.advanceTimersByTime(UNDO_WINDOW_MS + 100);
      });
      expect(onDismiss).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(TOAST_DURATION_MS);
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it("waits while the operator is reading it", () => {
      // WCAG 2.2.1. Without this the undo button an operator is reaching for
      // disappears under their cursor, which is worse than offering no undo.
      const onDismiss = vi.fn();
      const { container } = renderSurface(
        <ToastRegion>
          <Toast title="Approved." undo={{ onUndo: () => {} }} onDismiss={onDismiss} />
        </ToastRegion>,
      );

      const toast = container.querySelector(".pv-toast") as HTMLElement;
      // mouseOver rather than mouseEnter: React synthesises enter and leave
      // from the bubbling pair, so a dispatched mouseenter reaches nothing.
      fireEvent.mouseOver(toast);
      act(() => {
        vi.advanceTimersByTime(UNDO_WINDOW_MS * 4);
      });
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it("stays until dismissed when the duration is null", () => {
      const onDismiss = vi.fn();
      renderSurface(
        <ToastRegion>
          <Toast title="We could not reach the servicer." durationMs={null} onDismiss={onDismiss} />
        </ToastRegion>,
      );

      act(() => {
        vi.advanceTimersByTime(TOAST_DURATION_MS * 10);
      });
      expect(onDismiss).not.toHaveBeenCalled();
    });
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <ToastRegion>
        <Toast
          tone="success"
          title="Approved. Letter queued for 3 owners."
          description="They will receive it within the hour."
          record={{ href: "/approvals/4182" }}
          undo={{ onUndo: () => {} }}
          durationMs={null}
          onDismiss={() => {}}
        />
        <Toast
          tone="danger"
          title="We could not reach the loan servicing system."
          durationMs={null}
          onDismiss={() => {}}
        />
      </ToastRegion>,
    );

    await expectNoAccessibilityViolations(container);
  });
});
