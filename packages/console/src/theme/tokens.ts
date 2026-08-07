/**
 * The token names, typed.
 *
 * The values live in tokens.css, glass.css, and motion.css and are never
 * duplicated here — a second copy of a colour is a second copy that drifts.
 * What this module carries is the *names*, so that a component writes
 * `cssVar(COLOR_TOKENS.contentSecondary)` instead of a string literal and a
 * renamed or deleted token becomes a compile error rather than a property that
 * silently resolves to nothing at runtime.
 *
 * theme/tokens.test.ts asserts that every name exported here is actually
 * declared in the stylesheets, in both themes where the token is themed. That
 * assertion is the whole reason this file is worth having.
 */

export const COLOR_TOKENS = {
  bgBase: "--pv-bg-base",
  bgSubtle: "--pv-bg-subtle",
  surface: "--pv-surface",
  surfaceRaised: "--pv-surface-raised",

  borderSubtle: "--pv-border-subtle",
  borderStrong: "--pv-border-strong",
  /**
   * The boundary of anything whose border is the only thing identifying it —
   * an input, a chip, an unfilled button. borderSubtle and borderStrong are the
   * specification's hairlines and sit below 3:1 on purpose; this one clears it.
   */
  borderControl: "--pv-border-control",

  contentPrimary: "--pv-content-primary",
  contentSecondary: "--pv-content-secondary",
  contentTertiary: "--pv-content-tertiary",

  /** Placeholder until MVW brand values arrive. See the header of tokens.css. */
  accent: "--pv-accent",
  accentHover: "--pv-accent-hover",
  accentContrast: "--pv-accent-contrast",

  focusRing: "--pv-focus-ring",
  scrim: "--pv-scrim",
} as const;

export type ColorToken = (typeof COLOR_TOKENS)[keyof typeof COLOR_TOKENS];

/**
 * Status tones. Five from the specification plus `denied`, which the platform
 * needs because a refused action is governance working rather than a failure,
 * and painting it the same red as a breach teaches operators to read control as
 * breakage.
 *
 * Every status is paired with an icon or a label at the call site. Colour is
 * never the only carrier of a state.
 */
export const STATUS_TONES = [
  "success",
  "warning",
  "danger",
  "info",
  "neutral",
  "denied",
] as const;

export type StatusTone = (typeof STATUS_TONES)[number];

/** The tone's text colour: `--pv-status-danger`. */
export function statusToken<T extends StatusTone>(tone: T): `--pv-status-${T}` {
  return `--pv-status-${tone}`;
}

/** The tint a tone's text and border sit on: `--pv-status-danger-surface`. */
export function statusSurfaceToken<T extends StatusTone>(tone: T): `--pv-status-${T}-surface` {
  return `--pv-status-${tone}-surface`;
}

/** The tone's boundary, which clears 3:1 on its own tint and on the page. */
export function statusBorderToken<T extends StatusTone>(tone: T): `--pv-status-${T}-border` {
  return `--pv-status-${tone}-border`;
}

/**
 * The elevation ladder. Four levels and no others: e0 flat for page background
 * and table rows, e1 cards at rest, e2 popovers and hovered cards, e3 modals
 * and the command palette.
 */
export const ELEVATION_TOKENS = {
  e0: "--pv-elevation-0",
  e1: "--pv-elevation-1",
  e2: "--pv-elevation-2",
  e3: "--pv-elevation-3",
} as const;

export type ElevationToken = (typeof ELEVATION_TOKENS)[keyof typeof ELEVATION_TOKENS];

/**
 * The nine type steps. No size outside this scale, and each step carries its
 * own line height, weight, and tracking so that using a step is one decision
 * rather than four.
 */
export const TYPE_STEPS = [
  "display",
  "title-lg",
  "title",
  "body-lg",
  "body",
  "body-strong",
  "label",
  "caption",
  "micro",
] as const;

export type TypeStep = (typeof TYPE_STEPS)[number];

export const TYPE_AXES = ["size", "line", "weight", "tracking"] as const;

export type TypeAxis = (typeof TYPE_AXES)[number];

export function typeToken<S extends TypeStep, A extends TypeAxis>(
  step: S,
  axis: A,
): `--pv-type-${S}-${A}` {
  return `--pv-type-${step}-${axis}`;
}

/**
 * Spacing, in the pixel values the scale is defined in. Nothing between these:
 * a gap of 14 is a gap somebody eyeballed, and a screen full of eyeballed gaps
 * is what an interface looks like when it has no rhythm.
 */
export const SPACE_STEPS = [4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96] as const;

export type SpaceStep = (typeof SPACE_STEPS)[number];

export function spaceToken<S extends SpaceStep>(step: S): `--pv-space-${S}` {
  return `--pv-space-${step}`;
}

/** Radius by role rather than by size, so "what a card looks like" is one edit. */
export const RADIUS_TOKENS = {
  control: "--pv-radius-control",
  card: "--pv-radius-card",
  sheet: "--pv-radius-sheet",
  pill: "--pv-radius-pill",
} as const;

export type RadiusToken = (typeof RADIUS_TOKENS)[keyof typeof RADIUS_TOKENS];

export const MOTION_TOKENS = {
  micro: "--pv-motion-micro",
  standard: "--pv-motion-standard",
  surface: "--pv-motion-surface",
  page: "--pv-motion-page",
  exitMultiplier: "--pv-motion-exit-multiplier",
  microExit: "--pv-motion-micro-exit",
  standardExit: "--pv-motion-standard-exit",
  surfaceExit: "--pv-motion-surface-exit",
  pageExit: "--pv-motion-page-exit",
  easeEntry: "--pv-ease-entry",
  easeExit: "--pv-ease-exit",
  reduced: "--pv-motion-reduced",
} as const;

export type MotionToken = (typeof MOTION_TOKENS)[keyof typeof MOTION_TOKENS];

/**
 * Glass. Components should apply the `pv-glass` class rather than assembling
 * these by hand — the class is what the reduced-transparency swap redefines,
 * and a panel that composes the tokens itself will miss the fallback.
 */
export const GLASS_TOKENS = {
  bg: "--pv-glass-bg",
  blur: "--pv-glass-blur",
  borderColor: "--pv-glass-border-color",
  highlight: "--pv-glass-highlight",
  scrim: "--pv-glass-scrim",
} as const;

export type GlassToken = (typeof GLASS_TOKENS)[keyof typeof GLASS_TOKENS];

/** The glass recipe and the scrim text sits on, as class names. */
export const GLASS_CLASS = "pv-glass";
export const GLASS_SCRIM_CLASS = "pv-glass-scrim";

/** App shell metrics (spec §2). */
export const SHELL_TOKENS = {
  topBarHeight: "--pv-shell-top-bar-height",
  railWidth: "--pv-shell-rail-width",
  railWidthCollapsed: "--pv-shell-rail-width-collapsed",
  panelWidth: "--pv-shell-panel-width",
  panelWidthMin: "--pv-shell-panel-width-min",
  panelWidthMax: "--pv-shell-panel-width-max",
  gutter: "--pv-shell-gutter",
  gutterTablet: "--pv-shell-gutter-tablet",
  filterBarHeight: "--pv-shell-filter-bar-height",
  detailHeaderHeight: "--pv-shell-detail-header-height",
  decisionBarHeight: "--pv-shell-decision-bar-height",
  readingMeasure: "--pv-reading-measure",
} as const;

export type ShellToken = (typeof SHELL_TOKENS)[keyof typeof SHELL_TOKENS];

/** Control geometry, focus, and the density-dependent measurements. */
export const CONTROL_TOKENS = {
  heightSm: "--pv-control-height-sm",
  heightMd: "--pv-control-height-md",
  heightLg: "--pv-control-height-lg",
  targetMin: "--pv-target-min",
  focusRingWidth: "--pv-focus-ring-width",
  focusRingOffset: "--pv-focus-ring-offset",
  /** 52px comfortable, 40px compact — driven by the density preference. */
  rowHeight: "--pv-row-height",
  paddingBlock: "--pv-control-padding-block",
  paddingInline: "--pv-control-padding-inline",
} as const;

export type ControlToken = (typeof CONTROL_TOKENS)[keyof typeof CONTROL_TOKENS];

/**
 * The categorical chart palette, in order. Deliberately not derived from the
 * accent: a series colour that moves when the brand changes would rewrite every
 * saved screenshot and every chart in an exported audit pack.
 *
 * Verified in greyscale, because a chart that reads as one colour on a printed
 * regulator export is a chart that says nothing.
 */
export const CHART_TOKENS = [
  "--pv-chart-1",
  "--pv-chart-2",
  "--pv-chart-3",
  "--pv-chart-4",
  "--pv-chart-5",
  "--pv-chart-6",
  "--pv-chart-7",
  "--pv-chart-8",
] as const;

export type ChartToken = (typeof CHART_TOKENS)[number];

/** Single-hue ramp derived from the accent, five steps. */
export const SEQUENTIAL_TOKENS = [
  "--pv-sequential-1",
  "--pv-sequential-2",
  "--pv-sequential-3",
  "--pv-sequential-4",
  "--pv-sequential-5",
] as const;

/** danger → neutral → success, seven steps, centred on the meaningful zero. */
export const DIVERGING_TOKENS = [
  "--pv-diverging-1",
  "--pv-diverging-2",
  "--pv-diverging-3",
  "--pv-diverging-4",
  "--pv-diverging-5",
  "--pv-diverging-6",
  "--pv-diverging-7",
] as const;

/**
 * Layout breakpoints, in px (spec §2).
 *
 * Numbers rather than custom properties because CSS custom properties do not
 * resolve inside a media query — a `@media (max-width: var(--x))` silently
 * never matches. A component that needs one of these in a media query has to
 * write the number, and this is where the number is defined.
 */
export const BREAKPOINTS = {
  /** At and above: the full three-column shell. */
  full: 1440,
  /** Below: the context panel narrows to its minimum. */
  panelNarrow: 1280,
  /** Below: the rail collapses to icons. */
  railCollapse: 1024,
  /** Below: the context panel becomes an overlay sheet, and layouts go read-only. */
  panelOverlay: 900,
} as const;

export type TokenName =
  | ColorToken
  | ElevationToken
  | RadiusToken
  | MotionToken
  | GlassToken
  | ShellToken
  | ControlToken
  | ChartToken
  | `--pv-status-${StatusTone}`
  | `--pv-status-${StatusTone}-surface`
  | `--pv-status-${StatusTone}-border`
  | `--pv-type-${TypeStep}-${TypeAxis}`
  | `--pv-space-${SpaceStep}`
  | (typeof SEQUENTIAL_TOKENS)[number]
  | (typeof DIVERGING_TOKENS)[number];

/** `cssVar(COLOR_TOKENS.accent)` → `"var(--pv-accent)"`. */
export function cssVar<T extends TokenName>(token: T): `var(${T})` {
  return `var(${token})`;
}

/**
 * Every token name this module knows about. Exists so tokens.test.ts can assert
 * the stylesheets declare all of them: a token renamed in CSS and not here
 * (or the reverse) fails the build instead of resolving to nothing on screen.
 */
export const ALL_TOKEN_NAMES: readonly TokenName[] = [
  ...Object.values(COLOR_TOKENS),
  ...Object.values(ELEVATION_TOKENS),
  ...Object.values(RADIUS_TOKENS),
  ...Object.values(MOTION_TOKENS),
  ...Object.values(GLASS_TOKENS),
  ...Object.values(SHELL_TOKENS),
  ...Object.values(CONTROL_TOKENS),
  ...CHART_TOKENS,
  ...SEQUENTIAL_TOKENS,
  ...DIVERGING_TOKENS,
  ...STATUS_TONES.flatMap((tone) => [
    statusToken(tone),
    statusSurfaceToken(tone),
    statusBorderToken(tone),
  ]),
  ...TYPE_STEPS.flatMap((step) => TYPE_AXES.map((axis) => typeToken(step, axis))),
  ...SPACE_STEPS.map((step) => spaceToken(step)),
];
