/**
 * Where an anchored surface goes.
 *
 * Popovers and dropdowns are positioned in JavaScript because CSS cannot flip a
 * surface to the other side of its trigger when it would otherwise run off the
 * bottom of the window. A menu that opens downward into the void, so that its
 * last three items are unreachable, is the single most common defect in
 * hand-built dropdowns, and it only shows up on short viewports — which is to
 * say, on the laptop the operator actually uses and not on the monitor it was
 * built on.
 *
 * The arithmetic is pure and lives here rather than inside a layout effect, so
 * the flip and the clamp are testable without a browser and without pretending
 * jsdom has a viewport.
 */

import { useLayoutEffect, useState, type RefObject } from "react";

export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const PLACEMENTS = ["bottom-start", "bottom-end", "top-start", "top-end"] as const;
export type Placement = (typeof PLACEMENTS)[number];

/**
 * The gap between a trigger and its surface, and the minimum distance the
 * surface keeps from the edge of the window.
 *
 * Both mirror the 8 step of the spacing scale. They are numbers here rather
 * than tokens because a position is computed, not declared, and a custom
 * property cannot be read inside arithmetic — anchoredSurface.test.ts asserts
 * they are on the scale so they cannot quietly become 7.
 */
export const ANCHOR_GAP = 8;
export const VIEWPORT_PADDING = 8;

export interface AnchoredPosition {
  readonly top: number;
  readonly left: number;
  /** The placement actually used, which may differ from the one requested. */
  readonly placement: Placement;
}

export interface AnchoredPositionInput {
  readonly anchor: Box;
  readonly surface: Size;
  readonly viewport: Size;
  readonly placement?: Placement;
  readonly gap?: number;
  readonly padding?: number;
}

function verticalSide(placement: Placement): "top" | "bottom" {
  return placement.startsWith("top") ? "top" : "bottom";
}

function alignment(placement: Placement): "start" | "end" {
  return placement.endsWith("end") ? "end" : "start";
}

function compose(side: "top" | "bottom", align: "start" | "end"): Placement {
  return `${side}-${align}` as Placement;
}

/**
 * Positions a surface against its anchor, flipping and then shifting.
 *
 * Flip first, shift second, and never the other way round: shifting a surface
 * that is about to be flipped wastes the shift, and flipping a surface that has
 * already been shifted moves it out from under the trigger it belongs to.
 *
 * The surface is clamped into the viewport even when it does not fit on either
 * side, because a surface that is partly visible and scrollable is recoverable
 * and one positioned off-screen is not.
 */
export function positionAnchoredSurface({
  anchor,
  surface,
  viewport,
  placement = "bottom-start",
  gap = ANCHOR_GAP,
  padding = VIEWPORT_PADDING,
}: AnchoredPositionInput): AnchoredPosition {
  const requestedSide = verticalSide(placement);
  const align = alignment(placement);

  const spaceBelow = viewport.height - (anchor.top + anchor.height) - gap - padding;
  const spaceAbove = anchor.top - gap - padding;

  let side = requestedSide;
  if (requestedSide === "bottom" && surface.height > spaceBelow && spaceAbove > spaceBelow) {
    side = "top";
  } else if (requestedSide === "top" && surface.height > spaceAbove && spaceBelow > spaceAbove) {
    side = "bottom";
  }

  const top =
    side === "bottom" ? anchor.top + anchor.height + gap : anchor.top - surface.height - gap;

  const unshiftedLeft =
    align === "start" ? anchor.left : anchor.left + anchor.width - surface.width;

  const maxLeft = Math.max(padding, viewport.width - surface.width - padding);
  const left = Math.min(maxLeft, Math.max(padding, unshiftedLeft));

  const maxTop = Math.max(padding, viewport.height - surface.height - padding);
  const clampedTop = Math.min(maxTop, Math.max(padding, top));

  return { top: clampedTop, left, placement: compose(side, align) };
}

/**
 * Keeps a surface positioned against its anchor for as long as it is open.
 *
 * Re-measures on scroll and on resize, because an anchored surface is rendered
 * into a portal at the end of the document and therefore does not move with the
 * thing it is attached to. Scroll is listened for in the capture phase so that
 * an ancestor scrolling — a table body, a panel — is heard as well as the
 * window; without capture a popover on a scrolling panel detaches from its
 * trigger and hangs in mid-air.
 *
 * Returns null until the first measurement, which is the signal for the caller
 * to render the surface invisible rather than at the top-left of the screen.
 */
export function useAnchoredPosition({
  open,
  anchorRef,
  surfaceRef,
  placement = "bottom-start",
}: {
  readonly open: boolean;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly surfaceRef: RefObject<HTMLElement | null>;
  readonly placement?: Placement;
}): AnchoredPosition | null {
  const [position, setPosition] = useState<AnchoredPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const measure = (): void => {
      const element = anchorRef.current;
      // No element at all is a caller error — there is nothing to anchor to —
      // and the surface stays unpositioned rather than guessing.
      if (element === null) return;
      // An element with no box means the page is not laid out: a print
      // stylesheet, a collapsed ancestor, an environment with no layout engine.
      // Anchoring to the origin puts the surface somewhere real, which is
      // recoverable; leaving it unpositioned leaves it invisible, which is not.
      const anchor = anchorBox(element) ?? { top: 0, left: 0, width: 0, height: 0 };
      const next = positionAnchoredSurface({
        anchor,
        surface: surfaceSize(surfaceRef.current),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        placement,
      });
      // Compared rather than assigned: this runs on every scroll frame while a
      // popover is open, and a fresh object each time would re-render the
      // surface sixty times a second for a position that has not changed.
      setPosition((current) =>
        current !== null &&
        current.top === next.top &&
        current.left === next.left &&
        current.placement === next.placement
          ? current
          : next,
      );
    };

    measure();

    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, placement, anchorRef, surfaceRef]);

  return position;
}

/** The anchor's box, or null when it is not laid out. */
export function anchorBox(element: Element | null | undefined): Box | null {
  if (element === null || element === undefined) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/**
 * The surface's own size, measured once it is in the document.
 *
 * Zero is a legitimate answer in an environment with no layout engine, and the
 * positioner handles it by treating the surface as fitting anywhere — which is
 * the correct behaviour for a print stylesheet and for a test, and never
 * reached in a browser.
 */
export function surfaceSize(element: Element | null | undefined): Size {
  if (element === null || element === undefined) return { width: 0, height: 0 };
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}
