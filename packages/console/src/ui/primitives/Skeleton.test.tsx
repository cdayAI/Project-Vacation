import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { SKELETON_DELAY_MS, Skeleton } from "./Skeleton";

describe("Skeleton", () => {
  // Real timers here on purpose: axe schedules its own work on the timer queue
  // and never finishes under a fake clock nobody is advancing.
  it("carries no accessibility violations", async () => {
    const { container } = renderSurface(
      <>
        <Skeleton />
        <Skeleton lines={1} width="12rem" delayMs={0} />
        <Skeleton lines={2} radius="card" delayMs={0} label="Loading the approval" />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });
});

describe("Skeleton, on the clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing for the first 300ms, and then the bars", () => {
    const { container } = renderSurface(<Skeleton lines={3} />);
    const root = container.querySelector(".pv-ui-skeleton");

    // Below the threshold a skeleton is a flash, which reads as breakage
    // rather than as loading (spec §7).
    expect(root).not.toHaveAttribute("data-shown");

    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS);
    });
    expect(root).toHaveAttribute("data-shown", "true");
  });

  it("reserves its space from the first frame, so nothing moves when the content lands", () => {
    const { container } = renderSurface(<Skeleton lines={3} />);
    // The box and the bars exist immediately; only their paint waits. Reserving
    // the space is the other half of §7 — cumulative layout shift of zero.
    expect(container.querySelectorAll(".pv-ui-skeleton-bar")).toHaveLength(3);
  });

  it("builds the threshold in, so no caller can forget it", () => {
    expect(SKELETON_DELAY_MS).toBe(300);
  });

  it("is silent to assistive technology unless it is given something to say", () => {
    const { container } = renderSurface(<Skeleton delayMs={0} />);
    expect(container.querySelector(".pv-ui-skeleton")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("announces only once the wait is long enough to be worth announcing", () => {
    renderSurface(<Skeleton label="Loading the approval" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Loading the approval");
  });

  it("ends a multi-line block on a short line, the way a paragraph does", () => {
    const { container } = renderSurface(<Skeleton lines={3} delayMs={0} />);
    const bars = [...container.querySelectorAll<HTMLElement>(".pv-ui-skeleton-bar")];
    expect(bars.at(-1)?.style.width).toBe("60%");
    expect(bars[0]?.style.width).toBe("100%");
  });

  it("draws a single bar at full width, because one line is not a paragraph", () => {
    const { container } = renderSurface(<Skeleton lines={1} delayMs={0} />);
    const bars = [...container.querySelectorAll<HTMLElement>(".pv-ui-skeleton-bar")];
    expect(bars).toHaveLength(1);
    expect(bars[0]?.style.width).toBe("100%");
  });
});
