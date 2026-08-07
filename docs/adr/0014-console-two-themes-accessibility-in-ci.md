# ADR 0014 — Console: two themes, no component framework, accessibility enforced in CI

**Status:** Superseded in part by ADR 0017
**Date:** 2026-08-06

> ADR 0017 withdraws this record's prohibition on glass, blur, and gradient, and
> replaces its single theme preference with three. Everything else here still
> holds: two themes and no third, no component framework, no CSS framework,
> native elements first, and accessibility enforced in CI rather than reviewed.

## Context

The console is where an owner-services agent, a supervisor, a compliance
reviewer, and an auditor do their work. Its exit gate is that an MVW operator
completes a real task unaided and unnarrated.

Two constraints are stated and non-negotiable: exactly two themes, light and
dark, one coherent design system with no third variant and no glass or blur
experiments; and WCAG 2.2 AA with automated checks in CI so it cannot rot. MVW
is a consumer-facing brand with ADA exposure, and an accessibility regression
that ships is a legal problem, not a polish problem.

## Decision

**Two themes, expressed as CSS custom properties.** One token set, two value
sets. `prefers-color-scheme` provides the default and an explicit toggle
overrides it, persisted per user. There is no third theme and no per-surface
variation.

**No component framework and no CSS framework.** Semantic HTML with the native
control for the job, styled through the token set. Native elements bring
keyboard behaviour, focus management, and screen-reader semantics that a custom
component has to re-earn and that we would have to audit either way.

**Accessibility is tested, not reviewed.** Every console view has an automated
axe-core assertion in the test suite, run in CI, failing the build on a
violation. Contrast ratios are verified against the token set directly, both
themes, so a token change cannot quietly break contrast everywhere.

**Density over decoration.** These are working screens read on a laptop in a
conference room: legible type, clear focus rings, generous hit targets, no
animation that conveys meaning.

## Consequences

- Automated checks catch roughly the machine-detectable half of WCAG. They do
  not catch a bad focus order that is technically valid, an unclear label, or a
  live region that announces at the wrong moment. Manual keyboard-only and
  screen-reader passes remain necessary and are recorded as such in the
  handover, not implied to be covered by CI.
- Building without a component library is more up-front work per control and
  materially less dependency surface, less to audit, and less to hand over.
- Two themes means every colour decision is made twice. The token set is the
  only place that happens.
- Brand care: MVW licenses Marriott, Sheraton, Westin, and Hyatt marks. The
  console ships deliberately neutral — no licensed marks, no brand colours —
  until someone with authority signs off. That is a decision, not an omission.

## Alternatives considered

**A component library with accessible primitives.** Sound engineering, and the
better choice for a larger surface. Rejected here because the console is a
modest set of working screens, and the library's theming model would fight the
two-theme constraint while adding a dependency surface we would still need to
audit.

**Server-rendered HTML with minimal JavaScript.** Genuinely attractive for
accessibility and simplicity. Rejected because the work queue, the approvals
queue, and the run detail view all want live updates, and retrofitting those is
worse than starting with a client application.
