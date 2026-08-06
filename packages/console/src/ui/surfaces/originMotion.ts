/**
 * Motion that preserves identity (spec §1.6).
 *
 * A sheet opens *from* the row that triggered it and collapses back *into* it.
 * A card expanding into a panel keeps its title anchored. That continuity is
 * the difference between an interface that feels like a place and one that
 * feels like a slideshow, and it is the single cheapest thing that makes a
 * queue feel navigable rather than modal.
 *
 * The technique is the standard invert-then-play: the surface is laid out at
 * its final position, measured, and given an inline transform that makes it
 * *look* like the origin. One frame later the transform is removed and the
 * transition carries it home. Nothing is animated by animating layout, so the
 * whole effect is compositor-only and costs nothing on the critical path.
 *
 * The custom properties this module produces are consumed by the closed state
 * in Sheet.css and Modal.css. When it produces nothing — no origin, an
 * unmeasurable environment, or a reduced-motion request — those stylesheets
 * fall back to their own defaults, which is a plain fade or an edge slide.
 */

export interface OriginRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Below this the surface is squashed enough that its text visibly smears for
 * the length of the transition, and the effect stops reading as "this came
 * from that row" and starts reading as a zoom. Continuity is the goal; a
 * literal reproduction of a 52px row scaled to a full-height sheet is not.
 */
const MIN_SCALE = 0.72;

/** Names the stylesheets read. Kept here so the two halves cannot drift apart. */
export const ORIGIN_VARIABLES = {
  offsetX: "--pv-origin-x",
  offsetY: "--pv-origin-y",
  scaleX: "--pv-origin-scale-x",
  scaleY: "--pv-origin-scale-y",
} as const;

/**
 * How a surface says "this element is the same thing as that element".
 *
 * A card's title carries it, and the panel or sheet the card expands into
 * carries the same value on its own title. That is what lets the growing
 * surface anchor on the title the operator was already reading instead of
 * appearing beside it — spec §1.6's "a card expanding into a panel keeps its
 * title anchored" — without either component holding a reference to the other.
 */
export const IDENTITY_ATTRIBUTE = "data-pv-identity";

/** Finds the element currently claiming an identity, if it is on screen. */
export function identityAnchor(
  identity: string | null | undefined,
  root: ParentNode = document,
): Element | null {
  if (identity === null || identity === undefined || identity === "") return null;
  return root.querySelector(`[${IDENTITY_ATTRIBUTE}="${CSS.escape(identity)}"]`);
}

export function captureOriginRect(element: Element | null | undefined): OriginRect | null {
  if (element === null || element === undefined) return null;
  const rect = element.getBoundingClientRect();
  // A zero-area rect means the element is not laid out — detached, display:none,
  // or an environment with no layout engine at all. Animating from a point is
  // indistinguishable from animating from nowhere, so we say "no origin" and
  // let the surface use its own entrance.
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/**
 * The operator's motion preference, read at the moment it matters.
 *
 * motion.css already collapses every *transition* to an 80ms opacity fade, but
 * it cannot rewrite a transform into a fade — a reduced-motion operator would
 * still get the full translation, merely faster, which is precisely the
 * vestibular trigger the preference exists to avoid. So the transform is not
 * produced at all, and the fade motion.css leaves behind is the whole effect.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The inverse transform that makes `target` look like `origin`.
 *
 * Returns an empty record when there is nothing to preserve, which is the
 * signal for the caller to leave the surface's default entrance alone.
 * Assumes `transform-origin: 0 0` on the surface — the stylesheets set it, and
 * without it the translation and the scale fight each other.
 */
export function originTransformVariables(
  origin: OriginRect | null,
  target: OriginRect | null,
  options: { readonly reducedMotion?: boolean } = {},
): Readonly<Record<string, string>> {
  if (options.reducedMotion === true) return {};
  if (origin === null || target === null) return {};
  if (target.width <= 0 || target.height <= 0) return {};

  const scaleX = Math.min(1, Math.max(MIN_SCALE, origin.width / target.width));
  const scaleY = Math.min(1, Math.max(MIN_SCALE, origin.height / target.height));

  return {
    [ORIGIN_VARIABLES.offsetX]: `${round(origin.left - target.left)}px`,
    [ORIGIN_VARIABLES.offsetY]: `${round(origin.top - target.top)}px`,
    [ORIGIN_VARIABLES.scaleX]: `${round(scaleX, 4)}`,
    [ORIGIN_VARIABLES.scaleY]: `${round(scaleY, 4)}`,
  };
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * How long the element's exit actually takes, read from the element.
 *
 * Read rather than hard-coded because the durations are tokens, and a number
 * duplicated in TypeScript is a number that drifts from the stylesheet the
 * moment somebody tunes it — including the reduced-motion override, which is
 * the case where getting it wrong keeps an overlay on screen after the
 * operator dismissed it. An environment that cannot compute styles answers 0,
 * which unmounts immediately: no animation is a correct outcome, a stuck
 * overlay is not.
 */
export function readTransitionDurationMs(element: Element | null): number {
  if (element === null) return 0;
  const view = element.ownerDocument.defaultView;
  if (view === null || typeof view.getComputedStyle !== "function") return 0;

  const declared = view.getComputedStyle(element).transitionDuration;
  if (declared === "" || declared === undefined) return 0;

  // A transition list can name several properties with several durations; the
  // element is gone once the slowest one finishes.
  const durations = declared.split(",").map((entry) => parseDuration(entry.trim()));
  const longest = Math.max(0, ...durations);
  return Number.isFinite(longest) ? longest : 0;
}

function parseDuration(value: string): number {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return 0;
  if (value.endsWith("ms")) return numeric;
  if (value.endsWith("s")) return numeric * 1000;
  return 0;
}
