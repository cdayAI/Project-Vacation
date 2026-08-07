import { createContext, useContext, useId, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { GLASS_CLASS, GLASS_SCRIM_CLASS } from "../../theme/tokens";
import "./glassSurface.css";

/**
 * The blur budget.
 *
 * Spec §1.5 rule 3 is two sentences that are easy to nod at and impossible to
 * hold in your head while building a screen:
 *
 *   > Cap concurrent blurred surfaces at three. Never blur behind a scrolling
 *   > virtualized list.
 *
 * A rule enforced by remembering it is a rule that survives until the week
 * somebody ships a screen with a glass filter bar, a glass dropdown, a glass
 * context panel, a glass toast and a glass sheet, and the queue starts
 * stuttering on a mid-range laptop with no obvious culprit. Every backdrop
 * filter forces the compositor to re-sample everything behind it on every
 * frame that anything behind it moves; five of them over a list that is
 * repainting rows as it scrolls is the most expensive thing this product can
 * do to itself.
 *
 * So the rule is not documentation here, it is a lease. A surface asks for
 * blur; it gets blur only if the budget has room and nothing virtualized is
 * exposed underneath it. Otherwise it renders the designed solid — which is
 * the same surface reduced transparency produces, so it is a variant that has
 * been drawn and reviewed rather than a degradation nobody has looked at.
 *
 * -----------------------------------------------------------------------------
 * WHY PRIORITY AND NOT ARRIVAL ORDER
 *
 * The shell claims three slots the moment the console loads — rail, top bar,
 * context panel. First-come-first-served would mean no modal in the product
 * ever blurs, which is the exact inversion of what matters. Priority sorts it:
 * a modal outranks a sheet, a sheet outranks an anchored surface, and all of
 * them outrank chrome. When a modal opens, the rail quietly gives up its blur
 * — and since the modal's scrim is covering the rail at that moment, nobody
 * ever sees it happen.
 *
 * -----------------------------------------------------------------------------
 * WHY A VIRTUALIZED LIST VETOES BLUR OUTRIGHT
 *
 * `Table` registers itself here for as long as it is mounted. An anchored
 * surface — a dropdown in a filter bar, a popover on a column header — cannot
 * blur while such a table exists, because it is drawn over content that
 * scrolls underneath it and cannot lock it. A modal or a sheet can, because
 * both make the page behind them inert and unscrollable before they paint;
 * they declare that by asking for a lease with `locksBackdrop`.
 *
 * That is deliberately conservative. A dropdown that could technically have
 * blurred renders solid on the work queue, and solid is fine there. The
 * alternative is a rule that holds until the first screen where it doesn't.
 */

/**
 * Spec §1.5. Three, and the shell's chrome is normally all three of them.
 */
export const GLASS_BUDGET_CAPACITY = 3;

/**
 * The designed solid: identical to what glass.css produces under reduced
 * transparency, so a budget-denied surface and a transparency-reduced surface
 * are the same drawing rather than two near-misses.
 */
export const SOLID_SURFACE_CLASS = "pv-overlay-solid";

/**
 * Who yields to whom when the budget is full.
 *
 * `chrome` is for the shell — rail, top bar, context panel. Everything else is
 * an overlay, and an overlay the operator just opened matters more than
 * furniture that has been there since the console loaded.
 */
export const GLASS_PRIORITY = {
  chrome: 0,
  anchored: 1,
  sheet: 2,
  modal: 3,
} as const;

export type GlassPriority = (typeof GLASS_PRIORITY)[keyof typeof GLASS_PRIORITY];

interface Lease {
  readonly id: string;
  readonly priority: GlassPriority;
  /** Insertion order, so equal priorities resolve oldest-first and stop flickering. */
  readonly sequence: number;
}

class GlassBudget {
  private readonly listeners = new Set<() => void>();
  private leases: Lease[] = [];
  private scrollers = 0;
  private sequence = 0;

  constructor(readonly capacity: number = GLASS_BUDGET_CAPACITY) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  acquire(id: string, priority: GlassPriority): void {
    if (this.leases.some((lease) => lease.id === id)) return;
    this.sequence += 1;
    this.leases = [...this.leases, { id, priority, sequence: this.sequence }];
    this.notify();
  }

  release(id: string): void {
    const remaining = this.leases.filter((lease) => lease.id !== id);
    if (remaining.length === this.leases.length) return;
    this.leases = remaining;
    this.notify();
  }

  registerScroller(): () => void {
    this.scrollers += 1;
    this.notify();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.scrollers -= 1;
      this.notify();
    };
  }

  /** True when this lease is inside the capacity once priority is applied. */
  private holdsSlot(id: string): boolean {
    const ranked = [...this.leases].sort(
      (left, right) => right.priority - left.priority || left.sequence - right.sequence,
    );
    return ranked.slice(0, this.capacity).some((lease) => lease.id === id);
  }

  isBlurred(id: string, options: { readonly wants: boolean; readonly locksBackdrop: boolean }): boolean {
    if (!options.wants) return false;
    if (!this.holdsSlot(id)) return false;
    if (!options.locksBackdrop && this.scrollers > 0) return false;
    return true;
  }

  /** Test and diagnostic reads. Not used to make rendering decisions. */
  get leaseCount(): number {
    return this.leases.length;
  }

  get scrollerCount(): number {
    return this.scrollers;
  }
}

/**
 * The budget in force when nobody has installed a provider.
 *
 * Module scope rather than a required provider because the cap is a property of
 * the application, not of a subtree, and a component that silently loses the
 * cap when someone forgets a wrapper has no cap. Leases are released on
 * unmount, so this returns to empty between tests without any special handling.
 */
const defaultBudget = new GlassBudget();

const GlassBudgetContext = createContext<GlassBudget | null>(null);

/**
 * Narrows or isolates the budget for a subtree.
 *
 * The console does not need this — the module default is the application-wide
 * cap. It exists for two real cases: a test that wants to prove the cap by
 * setting it to one, and an embedded surface (a print view, a preview pane)
 * that should not be spending the host application's blur.
 */
export function GlassBudgetProvider({
  capacity = GLASS_BUDGET_CAPACITY,
  children,
}: {
  readonly capacity?: number;
  readonly children: ReactNode;
}) {
  const budget = useMemo(() => new GlassBudget(capacity), [capacity]);
  return <GlassBudgetContext.Provider value={budget}>{children}</GlassBudgetContext.Provider>;
}

function useBudget(): GlassBudget {
  return useContext(GlassBudgetContext) ?? defaultBudget;
}

export interface GlassSurface {
  /** Whether this surface actually got its blur this frame. */
  readonly blurred: boolean;
  /** Goes on the surface element. Glass, or the designed solid. */
  readonly surfaceClassName: string;
  /**
   * Goes on the solid child that text lives in. Empty when the surface is
   * already solid: a scrim over a solid surface is a second identical fill.
   */
  readonly scrimClassName: string;
}

export interface GlassSurfaceOptions {
  readonly priority: GlassPriority;
  /**
   * False renders solid unconditionally. For a surface that is glass by
   * configuration — a card that is only glass in summary contexts.
   */
  readonly wantsBlur?: boolean;
  /**
   * True only for surfaces that make everything behind them inert and
   * unscrollable before they paint. Claiming it while a virtualized list can
   * still scroll underneath is the exact defect this module exists to prevent.
   */
  readonly locksBackdrop?: boolean;
}

/**
 * Leases blur for the lifetime of the component and reports what it got.
 *
 * The lease is taken in a layout effect so the decision is made before the
 * browser paints: a surface that renders solid for one frame and then turns to
 * glass is a visible flash on every overlay open.
 */
export function useGlassSurface(options: GlassSurfaceOptions): GlassSurface {
  const budget = useBudget();
  const id = useId();
  const wants = options.wantsBlur !== false;
  const locksBackdrop = options.locksBackdrop === true;
  const priority = options.priority;

  useLayoutEffect(() => {
    if (!wants) return;
    budget.acquire(id, priority);
    return () => budget.release(id);
  }, [budget, id, wants, priority]);

  const blurred = useSyncExternalStore(
    budget.subscribe,
    () => budget.isBlurred(id, { wants, locksBackdrop }),
    // Server rendering has no compositor and no preference to read. Solid is
    // the honest answer and also the one that matches the first client paint
    // before the lease resolves.
    () => false,
  );

  return useMemo(
    () => ({
      blurred,
      surfaceClassName: blurred ? GLASS_CLASS : SOLID_SURFACE_CLASS,
      scrimClassName: blurred ? GLASS_SCRIM_CLASS : "",
    }),
    [blurred],
  );
}

/**
 * Declares that this component owns a virtualized scroller.
 *
 * `Table` calls it. Nothing else should need to, and anything that does is
 * telling the budget the truth about why an anchored surface near it must not
 * blur.
 */
export function useVirtualScrollerRegistration(active = true): void {
  const budget = useBudget();
  useLayoutEffect(() => {
    if (!active) return;
    return budget.registerScroller();
  }, [budget, active]);
}

/**
 * Appends the scrim class to a component's own.
 *
 * Text on glass sits on a solid child (spec §1.5 rule 1). On a surface that is
 * already solid the scrim class is empty, and blindly appending it would leave
 * a trailing space in every className in the DOM — which is invisible until
 * somebody writes a selector or a test against the exact attribute.
 */
export function withScrim(base: string, scrim: string): string {
  return scrim === "" ? base : `${base} ${scrim}`;
}

/**
 * Reads the module-level budget. Diagnostics and tests only — a component that
 * makes a rendering decision from this instead of from `useGlassSurface` is
 * reading a value that is correct now and stale one commit later.
 */
export function inspectGlassBudget(): { readonly leases: number; readonly scrollers: number } {
  return { leases: defaultBudget.leaseCount, scrollers: defaultBudget.scrollerCount };
}
