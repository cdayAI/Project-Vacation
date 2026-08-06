# ADR 0008 — Statutory clocks are data, computed in one module, and refuse when unsure

**Status:** Accepted
**Date:** 2026-08-06

## Context

Vacation ownership contracts carry a statutory rescission period set by state
law. The window length, what event starts it, whether it counts calendar or
business days, what happens when it lands on a weekend or a state holiday, and
which timezone governs all vary by state. Getting it wrong voids the contract.

This is the single highest-consequence deterministic computation in the
platform, and it is the one most likely to be got wrong by ordinary means: a
`+ 5 * 24 * 60 * 60 * 1000` somewhere, a UTC date arithmetic that silently
becomes 71 hours across a daylight-saving transition, or a rule hard-coded in a
conditional that nobody can review against the statute.

## Decision

**Rules are data, not code.** `timeline/rules.ts` holds a typed, per-state
table: window length, day-counting basis, trigger event, weekend and holiday
extension behaviour, governing IANA timezone, effective dates, citation, and
source URL. Adding or amending a state is a data change reviewable by someone
who reads statutes rather than TypeScript.

**One module computes deadlines.** Nothing else in the platform performs date
arithmetic on a legal deadline. `computeRescissionDeadline` returns a
`DeadlineComputation` containing not just the answer but the full derivation —
the rule version applied, its citation, and every intermediate step in readable
form — so the output is audit evidence rather than a bare timestamp.

**Timezones are explicit.** Computation uses `Intl.DateTimeFormat` with an IANA
zone. Daylight-saving transitions are tested in both directions, because a
three-day window must be three local days, not 72 fixed hours.

**Rules are effective-dated.** The rule selected is the one in force on the
trigger date, so the system answers "what did the rule say on the date of that
contract" rather than "what does it say today".

**Unknown means refuse.** An unrecognised state, a trigger date outside every
rule's effective range, or a missing required input throws
`DeniedError("knowledge.no_grounding")`. There is no default window. The system
never improvises a legal deadline.

**Rules ship unverified and say so.** Every entry in the shipped table is
marked `verified: false` with a review note, and the module says plainly that
no rule has been confirmed against current law — they are structural
placeholders that exercise the engine correctly. A test fails if any rule is
marked verified without a citation and a source URL.

## Consequences

- The table is useless for production until MVW's counsel verifies each entry.
  That is the honest position, and stating it in the code is better than
  shipping plausible-looking citations that someone later relies on. It is the
  first item on the pre-production checklist.
- Rule maintenance is an ongoing obligation with a named owner and a review
  cadence, tracked like any other corpus. Statutes change; a stale rule is a
  silent defect.
- Every deadline the platform produces is explainable to a regulator without
  reading source code, because the derivation travels with the answer.
- Refusing on unknown states means the platform is unhelpful in exactly the
  cases where it does not know enough to be safe. That is the intended
  behaviour and it routes to a human.

## Alternatives considered

**A commercial legal-calendaring service.** Worth evaluating if one covers
timeshare rescission specifically. Rejected as the primary mechanism for now
because it puts the highest-consequence computation behind a dependency we
cannot audit, and because the derivation would not be ours to show. The module
boundary keeps a hybrid possible: use the service as a cross-check and alert on
disagreement.

**Rules encoded as code with a test per state.** Rejected: it makes the
reviewer a programmer, which is the wrong reviewer for a statutory question.
