import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { ORIGIN_VARIABLES } from "./originMotion";
import { Sheet } from "./Sheet";

function Harness({ side }: { readonly side?: "inline-start" | "inline-end" }) {
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button type="button" ref={row} className="test-row" onClick={() => setOpen(true)}>
        Open evidence for evt_01k3m9
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Evidence chain evt_01k3m9"
        description="Inputs, sources, decisions, and the chain verification."
        side={side}
        originRef={row}
        footer={<button type="button">Export CSV</button>}
      >
        <p>Chain verified against the recorded digest.</p>
      </Sheet>
    </>
  );
}

/**
 * jsdom has no layout, so every box is zero and the origin machinery correctly
 * declines to animate. Giving the row and the surface real boxes is what makes
 * the "opens from the row" behaviour testable at all.
 */
function giveEverythingABox(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ): DOMRect {
    const box = this.classList.contains("test-row")
      ? { top: 300, left: 260, width: 900, height: 52 }
      : { top: 0, left: 560, width: 720, height: 900 };
    return { ...box, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Sheet", () => {
  it("renders nothing while closed", () => {
    renderSurface(
      <Sheet open={false} onClose={() => {}} title="Evidence chain">
        Body
      </Sheet>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names itself and describes itself", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.click(screen.getByRole("button", { name: /Open evidence/ }));

    const dialog = screen.getByRole("dialog", { name: "Evidence chain evt_01k3m9" });
    expect(dialog).toHaveAccessibleDescription(
      "Inputs, sources, decisions, and the chain verification.",
    );
  });

  it("puts focus on the title and returns it to the row on close", async () => {
    // The operator must be standing on the same row afterwards. Anything else
    // and a queue of forty stops being navigable.
    const user = userEvent.setup();
    renderSurface(<Harness />);
    const row = screen.getByRole("button", { name: /Open evidence/ });

    await user.click(row);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Evidence chain evt_01k3m9" })).toHaveFocus(),
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(row).toHaveFocus());
  });

  describe("motion that preserves identity", () => {
    it("opens from the row it was triggered by", async () => {
      giveEverythingABox();
      const user = userEvent.setup();
      const { container } = renderSurface(<Harness />);
      await user.click(screen.getByRole("button", { name: /Open evidence/ }));

      const surface = container.ownerDocument.querySelector(".pv-sheet") as HTMLElement;
      // The row is at x=260, the sheet lands at x=560, so the surface starts
      // 300px to the left of where it will finish.
      expect(surface.style.getPropertyValue(ORIGIN_VARIABLES.offsetX)).toBe("-300px");
      expect(surface.style.getPropertyValue(ORIGIN_VARIABLES.offsetY)).toBe("300px");
    });

    it("hands the surface back one frame later", async () => {
      giveEverythingABox();
      const user = userEvent.setup();
      const { container } = renderSurface(<Harness />);
      await user.click(screen.getByRole("button", { name: /Open evidence/ }));

      await waitFor(() => {
        const surface = container.ownerDocument.querySelector(".pv-sheet");
        expect(surface).toHaveAttribute("data-state", "open");
      });
    });

    it("writes no transform when there is no row to come from", async () => {
      // Without an origin the sheet slides in from the edge it is docked to,
      // which Sheet.css supplies. That default is the right answer, not a
      // consolation prize.
      const user = userEvent.setup();
      const { container } = renderSurface(
        <Sheet open onClose={() => {}} title="Evidence chain">
          Body
        </Sheet>,
      );
      await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

      const surface = container.ownerDocument.querySelector(".pv-sheet") as HTMLElement;
      expect(surface.style.getPropertyValue(ORIGIN_VARIABLES.offsetX)).toBe("");
      await user.keyboard("{Escape}");
    });

    it("writes no transform under a reduced-motion request", async () => {
      // motion.css can shorten a transform but cannot turn it into a fade, so
      // the transform has to not exist.
      giveEverythingABox();
      const matchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;

      const user = userEvent.setup();
      const { container } = renderSurface(<Harness />);
      await user.click(screen.getByRole("button", { name: /Open evidence/ }));

      const surface = container.ownerDocument.querySelector(".pv-sheet") as HTMLElement;
      expect(surface.style.getPropertyValue(ORIGIN_VARIABLES.offsetX)).toBe("");

      window.matchMedia = matchMedia;
    });
  });

  it("docks to the side it is told to", async () => {
    const user = userEvent.setup();
    const { container } = renderSurface(<Harness side="inline-start" />);
    await user.click(screen.getByRole("button", { name: /Open evidence/ }));

    expect(container.ownerDocument.querySelector(".pv-sheet-host")).toHaveClass(
      "pv-sheet-host-start",
    );
  });

  it("keeps focus inside while it is open", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.click(screen.getByRole("button", { name: /Open evidence/ }));

    screen.getByRole("button", { name: "Export CSV" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  describe("designed states", () => {
    it("shows a loading body sized for a long chain", () => {
      const { container } = renderSurface(
        <Sheet open onClose={() => {}} title="Evidence chain" loading />,
      );
      expect(container.ownerDocument.querySelectorAll(".pv-surface-skeleton")).toHaveLength(6);
    });

    it("states an error in words", () => {
      renderSurface(
        <Sheet
          open
          onClose={() => {}}
          title="Evidence chain"
          error="We could not verify the chain. Reference 8f2a41."
        />,
      );
      expect(screen.getByText("Error")).toBeInTheDocument();
    });

    it("marks read-only and drops the actions", () => {
      renderSurface(
        <Sheet
          open
          onClose={() => {}}
          title="Evidence chain"
          readOnly
          actions={<button type="button">Correct this</button>}
        >
          Body
        </Sheet>,
      );
      expect(screen.getByText("Read-only")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Correct this" })).toBeNull();
      // The way out is never removed.
      expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    });
  });

  it("has no accessibility violations", async () => {
    const { baseElement } = renderSurface(
      <Sheet
        open
        onClose={() => {}}
        title="Evidence chain evt_01k3m9"
        description="Inputs, sources, decisions, and the chain verification."
        footer={<button type="button">Export CSV</button>}
      >
        <p>Chain verified against the recorded digest.</p>
      </Sheet>,
    );

    await expectNoAccessibilityViolations(baseElement);
  });
});
