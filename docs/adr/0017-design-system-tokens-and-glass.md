# ADR 0017 — The design system: one token set, three preferences, and glass

**Status:** Accepted
**Date:** 2026-08-06
**Supersedes in part:** ADR 0014

## Context

`docs/design/design-spec.md` is the design authority for this product. It makes
decisions rather than stating preferences: nine type steps, an eleven-value
spacing scale, a four-level elevation ladder, semantic colour roles in two
themes, a categorical chart palette, a glass recipe with separate light and dark
value sets, and four motion durations with an exit multiplier.

It contradicts ADR 0014 on one point, deliberately. ADR 0014 recorded "no third
variant and no glass or blur experiments" and built a console that is correct,
legible, and visually inert. The specification makes glass the product's
signature on chrome and overlays — the rail, the top bar, the context panel,
popovers, sheets, modals, toasts, summary cards — and requires that the
reduced-transparency alternative be a designed surface rather than a fallback.

The specification also asks for three user preferences where the console had
one, and it asks for the accent to come from MVW's brand guidelines, which
nobody has given us.

The reason 0014 refused glass was sound and has not gone away: an accessibility
regression that ships is a legal problem for a consumer-facing brand with ADA
exposure, and translucency is one of the reliable ways to ship one. What has
changed is that we now know exactly how to test for it.

## Decision

**The specification wins on anything visual, and ADR 0014's prohibition on
glass, blur, and gradient is withdrawn.** Everything else in 0014 stands: two
themes and no third, no component framework, no CSS framework, native elements
first, accessibility enforced in CI rather than reviewed.

**One token set, two value sets, expressed as CSS custom properties, plus a
typed TypeScript module of the token names.** `theme/tokens.ts` carries names
only — never values, because a second copy of a colour is a second copy that
drifts. Components reference `COLOR_TOKENS.contentSecondary` rather than a
string, so a renamed token is a compile error instead of a property that
resolves to nothing on screen. A test asserts every exported name exists in the
stylesheets.

**Three preferences, each persisted per user and each expressed as a data
attribute on the root element:** theme (system / light / dark, default system),
density (comfortable / compact, default comfortable), transparency (system /
reduced, default system). The attribute is the mechanism, not an implementation
detail: CSS responds to a preference change without a component tree
re-rendering, so switching density over a virtualised table is a repaint rather
than a rebuild.

Theme keeps 0014's two-selector arrangement — a `prefers-color-scheme` media
query qualified with `:not([data-theme="light"])`, plus an explicit
`[data-theme="dark"]` rule — because it is what lets an explicit choice win in
both directions without a specificity fight. "System" is the absence of the
attribute, not a third value set.

**Transparency is a floor, not a toggle.** There is no "force transparency on"
value and no `[data-transparency="full"]` selector. An operator may ask for less
transparency than their operating system asks for, never for more. An
application that can override an accessibility preference upward will eventually
do it by accident, to the person least able to work around it.

**Glass is one class with two value sets and a swap.** `.pv-glass` reads five
custom properties; reduced transparency redefines those properties as
`surface-raised` + `border-subtle` + elevation 2. No component needs a variant
class or a conditional, so a screen that only works with transparency on cannot
be built by accident. Dark glass has its own tint, opacity, blur radius,
saturation, and highlight — a test asserts it is not light glass inverted.

**Contrast is a test, not a claim, and the glass composite is the test that
matters.** `theme/tokens.test.ts` parses the shipped stylesheets and computes
real WCAG ratios: every text/surface pair at 4.5:1, every meaningful boundary at
3:1, in both themes; and text on glass measured against the glass tint
composited over `bg-base` and over `surface` rather than against the glass
token. Measuring text against the panel token is the single most common way a
glass interface passes review and fails an audit, and it is the one thing this
file exists to prevent.

**The accent is a neutral placeholder and is structured so the brand decision is
one token change.** MVW licenses the Marriott, Sheraton, Westin, and Hyatt marks
and brand usage needs a named approver. We did not sample, guess, or borrow a
hotel brand colour. `--pv-accent`, `--pv-accent-hover`, and
`--pv-accent-contrast` are a deliberately neutral slate chosen only to clear
every contrast threshold; the sequential chart ramp is derived from
`--pv-accent` with `color-mix()` rather than hand-picked, and no component
references a hue. When the brand values arrive, three declarations change per
theme and the contrast suite says whether they are usable.

**The focus ring is deliberately not derived from the accent.** If the indicator
moved with the brand colour, a brand change could quietly weaken the one thing a
keyboard-only operator depends on.

## Where we departed from the specification, and why

The specification states contrast requirements and a value table that, in five
places, disagree with each other. The contrast requirement wins, because it is
the one with a legal floor under it. Every departure is minimal, keeps the hue,
and is recorded in a comment beside the token:

- **`content-tertiary`, light.** The table gives `#727B8C`, which measures
  3.73:1 on `bg-subtle`. Darkened to `#646C7C` (4.63:1).
- **`content-tertiary`, dark.** The table gives `#7A8496`: 4.06:1 on
  `surface-raised`, and 4.47:1 seen through dark glass. Lightened to `#868FA1`
  (4.71:1).
- **`warning`, light.** The table gives `#B25E02`: 4.09:1 on `bg-subtle`.
  Darkened to `#9E5302` (4.99:1).
- **Chart entry 7.** The table gives `#7A8C3A`, which differs from its
  neighbour `#6E7CE0` by 0.3% relative luminance — indistinguishable in
  greyscale, on a printed audit export, and to a monochromat. §1.4 requires
  verifying the palette in greyscale; entry 7 is lightened to `#8A9E42` to
  satisfy the check the section itself asks for.
- **A third border token.** The specification's two border values are hairlines
  that composite to roughly 1.2:1 and 1.6:1. They draw structure, and raising
  them to boundary strength would turn every dense table into a grid of boxes.
  Anything whose border is the only thing identifying it — an input, a chip, an
  unfilled button — uses `--pv-border-control`, which clears 3:1 on every
  surface in both themes. WCAG 1.4.11 applies to that token, not to the
  hairlines, and the test asserts the hairlines stay below 3:1 so the exemption
  stays a decision rather than becoming an accident.

Two additions the specification does not enumerate but the product needs: a
tint and a boundary for each status tone, so a badge and a callout are token
compositions rather than per-component colour; and a sixth `denied` tone, kept
from the existing console because a refused action is governance working rather
than a failure, and painting it the same red as a breach teaches operators to
read control as breakage (ADR 0003).

## Consequences

- **The three-blurred-surface cap cannot be enforced in CSS.** Rail, top bar,
  and context panel are the three. Every other glass surface — a popover, a
  sheet, a toast — is drawn over one of them and has to be counted by the person
  building the screen. It is written at the top of `glass.css`; it is not
  tested, and saying so is more honest than implying it is.
- **The chart palette is not held to 3:1 against the plot background.** Several
  of the specified hues cannot reach it without becoming different hues. Charts
  therefore carry direct labels and position encoding, never colour alone. The
  test asserts the current worst case so a future palette cannot quietly get
  worse, and says in words that the bar should be raised if a palette ever
  clears it.
- **`base.css` is now element defaults only.** Reset, type, numerals, focus, and
  the screen-reader primitive. Every component and layout class that used to
  live there moves to the component that owns it. That is a better boundary and
  it is also a migration: nothing renders as it did until the component layer
  lands.
- **`color-mix()` is a hard dependency** for the sequential and diverging chart
  ramps. It is widely available and it is what makes the brand accent reach the
  charts without five more hand-picked values that then drift. A browser without
  it gets no ramp, which is a visible failure rather than a wrong colour.
- **Dark is still declared twice.** The two-selector arrangement costs a
  duplicated value set; a test asserts the copies are identical, character for
  character, so they cannot diverge.
- **Density has no system signal**, so unlike theme and transparency its
  attribute is always written. There is nothing for an absent attribute to defer
  to.
- **The console is no longer visually inert**, which was 0014's safest property.
  What replaces it is a contrast suite that fails the build, a reduced-motion
  block that collapses everything to opacity at 80ms, and a
  reduced-transparency variant that is a designed surface. Automated checks
  still catch only the machine-detectable half of WCAG; the manual keyboard and
  screen-reader passes recorded in the handover remain necessary, and every
  screen now needs a third screenshot — light, dark, and transparency off.

## Alternatives considered

**Keep ADR 0014 as written and refuse glass.** The safest thing available, and
we would have been defending it on the grounds that we could not test it. We
can: the composite assertion is forty lines and it is stricter than what a
manual review would have caught. Refusing a specified design decision because it
is hard to verify, when verifying it is tractable, is not caution.

**One preference (theme) and treat density and transparency as build-time
choices.** Rejected. Density is the difference between forty rows and
twenty-six on the queue an approver lives in, and transparency is an
accessibility preference. Neither belongs to us.

**Derive dark glass from light glass by inverting it.** Half the code and a grey
fog with a white rim. Translucency over a dark page needs more blur, less
saturation, a darker tint, and a far weaker highlight; those are four separate
decisions and the specification makes all four.

**Derive the whole palette from a single brand hue once MVW provides it.**
Attractive, and it would collapse the accent question into arithmetic. Rejected
because the status palette must mean the same thing regardless of brand — a
danger colour that shifts hue with a brand refresh is a danger colour operators
have to re-learn — and because a generated ramp would still need every pair
checked against the same thresholds, which is the actual work.

**Generate the tokens from a TypeScript source of truth at build time.**
Rejected: it puts a build step between a designer's value and the stylesheet,
and the test already parses the CSS the application ships, which is the artifact
that matters.

---

## Amendment, 2026-08-07: glass widened from chrome to every container

**Status of the original decision: still in force, with one clause replaced.**

The specification confined glass to chrome and overlays — the rail, the top bar,
the context panel, popovers, sheets, modals, toasts, and summary cards — and
said explicitly: never behind a table, a chart, a form, or long-form reading.
The owner asked for the maximum glass the console can carry. That clause is now
replaced by a different line, drawn between **containers and contents** rather
than between chrome and content:

> Every container is glass. Nothing that repeats is.

Panels, toolbars, callouts, dialogs, metric tiles, step and citation cards, and
the scroll container a table sits in all carry the recipe. Rows, cells, badges,
chips and tokens carry a tint and never a `backdrop-filter`.

**Why the new line is the defensible one.** The original rule was a proxy for
two real constraints, and naming the constraints directly turns out to permit
much more glass than the proxy did.

The first is cost. A `backdrop-filter` is a full-surface repaint. The rule that
mattered was never "not behind a table" — it was "not once per row", because the
work queue renders a row per open case and the audit screen renders one per chain
entry. A blurred *container* is one repaint regardless of how many rows are
inside it. `screens.test.ts` parses the stylesheet and fails if a
`backdrop-filter` reaches a `tr`, `td`, `th`, `li`, `.pv-badge` or a row-state
class, and nested glass drops its own filter rather than blurring twice.

The second is legibility, and it did not move at all. The panel tint went from
72% to 58% in light and 64% to 50% in dark; **the scrim stayed at 92%.** The
scrim is the solid child that text sits on, and it is the reason the measured
contrast number means anything — spending it to make the glass prettier would
have left `tokens.test.ts` passing against a surface nothing is drawn on. Every
composite assertion still passes at the new opacity, still measured as glass
over the page background rather than against the glass token.

**What was added.** A lens: a rim gradient masked into a one-pixel ring, and a
specular band across the upper third. Both are `::before`/`::after` with
`pointer-events: none`, both come off under reduced transparency and under
`@supports not (backdrop-filter)`, and the only motion is a hover opacity
transition inside a `prefers-reduced-motion: no-preference` guard. Nothing
animates on load, on data arrival, or on a timer. A governance console that
shimmers while somebody reads a refusal is a console that makes people distrust
it, and that is the one part of §1.5 no amount of glass gets to override.

**What was rejected.** Adding a third value to the transparency preference — a
`liquid` tier above the default — so the heavier recipe was opt-in. It would
have left the shipped default untested by the composite assertions, which read
the base `:root` block. The heavier recipe *is* the base block now, so the
contrast tests measure exactly what ships. That was the whole point of writing
them against the CSS rather than against a TypeScript source of truth.
