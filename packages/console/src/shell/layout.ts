import { useEffect, useState } from "react";
import { BREAKPOINTS } from "../theme/tokens";

/**
 * What the shell looks like at a given width.
 *
 * Specification §2 gives four breakpoints and the CSS in AppShell.css enforces
 * most of them on its own. This module exists for the parts CSS cannot decide:
 * whether the context panel is a docked column or an overlay sheet — two
 * different components, not two stylings of one — and whether the operator's
 * stored rail preference is still theirs to hold, because below 1024 it is not.
 *
 * Kept as a pure function of a number so every rung of the ladder can be
 * asserted without a browser. A layout rule that can only be checked by resizing
 * a window is a layout rule that gets broken by the next person.
 */

export type RailMode = "expanded" | "icons";
/** `docked` is the 380px column, `narrow` its 320px minimum, `overlay` a sheet. */
export type PanelMode = "docked" | "narrow" | "overlay";

export interface ShellLayout {
  readonly rail: RailMode;
  /**
   * False below 1024, where the rail is icon-only because there is no room
   * rather than because the operator asked. The toggle says so rather than
   * silently doing nothing.
   */
  readonly railIsChoice: boolean;
  readonly panel: PanelMode;
  /** The panel's width in pixels, already clamped to its bounds. */
  readonly panelWidth: number;
  /**
   * False below 900. Specification §2: "below 900 read-only layouts only — no
   * data entry designed for phones unless the owner asks." A screen reads this
   * to choose its read-only variant, which is a designed state rather than a
   * disabled one.
   */
  readonly dataEntry: boolean;
}

/**
 * The panel's bounds, in pixels.
 *
 * The same three numbers are declared as `--pv-shell-panel-width*` in
 * tokens.css. They are repeated here for the same reason BREAKPOINTS is a
 * number rather than a custom property: this side of the system does arithmetic
 * on a drag distance, and `calc()` on a custom property is not available to a
 * pointer handler. shell/shellPreferences.test.ts asserts the two agree.
 */
export const PANEL_WIDTH_DEFAULT = 380;
export const PANEL_WIDTH_MIN = 320;
export const PANEL_WIDTH_MAX = 520;

export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_WIDTH_DEFAULT;
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(width)));
}

export interface LayoutInput {
  /** The operator's stored choice. Honoured only where there is room to honour it. */
  readonly railCollapsed: boolean;
  readonly panelWidth: number;
}

export function resolveShellLayout(viewportWidth: number, input: LayoutInput): ShellLayout {
  const width = Number.isFinite(viewportWidth) ? viewportWidth : BREAKPOINTS.full;

  const railIsChoice = width >= BREAKPOINTS.railCollapse;
  const rail: RailMode = railIsChoice && !input.railCollapsed ? "expanded" : "icons";

  let panel: PanelMode = "docked";
  if (width < BREAKPOINTS.panelOverlay) panel = "overlay";
  else if (width < BREAKPOINTS.panelNarrow) panel = "narrow";

  const panelWidth =
    panel === "narrow" ? PANEL_WIDTH_MIN : clampPanelWidth(input.panelWidth);

  return {
    rail,
    railIsChoice,
    panel,
    panelWidth,
    dataEntry: width >= BREAKPOINTS.panelOverlay,
  };
}

/**
 * The viewport width, as React state.
 *
 * `innerWidth` rather than a matchMedia listener per breakpoint: four listeners
 * that each answer half a question are harder to reason about than one number,
 * and the resolution above is where the thresholds belong. The listener is
 * passive and the value only ever changes on a resize, which is not a hot path.
 *
 * jsdom reports 1024, which lands the tests on the full docked shell with an
 * expanded rail — the layout most assertions are about. A test that wants
 * another rung sets `window.innerWidth` and dispatches a resize.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(() =>
    typeof window === "undefined" ? BREAKPOINTS.full : window.innerWidth,
  );

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize, { passive: true });
    // Read once on mount as well: the first render may have happened before
    // the window settled, and a stale width means an overlay panel drawn as a
    // column across the content.
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return width;
}
