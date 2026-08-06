# ADR 0003 — Fail closed by default

**Status:** Accepted
**Date:** 2026-08-06

## Context

Every control in this platform can fail for reasons that have nothing to do
with an attacker: the database is unreachable, the containment table cannot be
read, the boundary screen throws on a pathological input, the audit append
times out.

In each case the code has a choice. It can proceed without the control, or it
can refuse the action. The first choice is easier to write, produces better
availability numbers, and is how most systems behave by accident — a `try`
block around a check, a `catch` that logs, and execution continues.

For this platform that default is wrong. The product's claim is that every
consequential action carries a governed, auditable record. An action taken
while the audit log was unavailable is exactly the action nobody can account
for afterwards.

## Decision

**Every control fails closed.** Missing configuration, an unreadable store, a
broken screen, an unavailable audit receipt, an unresolvable containment state
— each refuses the action rather than proceeding unrecorded.

This is enforced structurally rather than by convention:

1. Refusal is a distinct type. `DeniedError` (`kernel/errors.ts`) carries a
   machine-readable `DenialReason`. It is not interchangeable with a generic
   `Error`, so "we did not do it" cannot be confused with "something went
   wrong" by a caller that catches broadly.
2. Controls translate infrastructure failures into denials at their own
   boundary. `AuditLog.record` converts any store failure into
   `record.unavailable`. `ContainmentController` converts an unreadable switch
   into `containment.global_pause` — if we cannot tell whether the platform is
   paused, we behave as though it is.
3. Defaults are the safe setting, never the permissive one. Execution is
   disabled, the egress allowlist is empty, work discovery is off, the store is
   the non-durable one that refuses to run in production.
4. Screening that cannot answer is not an answer of "clean". `guard/screen.ts`
   catches everything and re-raises as a denial; `screenSafely` returns
   `blocked` on failure and never `clean`.

## Consequences

- Availability is deliberately traded for accountability. A database outage
  stops work rather than producing unrecorded work. That is the correct trade
  for this product and it must be stated plainly to MVW rather than discovered
  during an incident: the SLO document reflects it.
- Denials are frequent and expected, so they must be legible. Every denial
  carries a reason code and non-sensitive detail, and the console renders them
  as first-class outcomes rather than errors.
- Tests are written in pairs: one proving the control permits the legitimate
  case, one proving it refuses when its dependency fails. A control with only
  the first test is not considered done.
- There is a real failure mode in the other direction — a control that refuses
  too eagerly becomes a denial-of-service against the business. Mitigated by
  scoping denials as narrowly as the failure warrants, and by alerting on
  denial-rate spikes so an over-refusing control is caught quickly.

## Alternatives considered

**Fail open with alerting.** Higher availability; rejected because the window
between the failure and the human response is precisely the window in which
ungoverned actions accumulate, and afterwards there is no record of what
happened in it.

**Per-control configuration of the posture.** Rejected. A configurable
fail-open switch is a control that will be turned off during the first incident
and never turned back on.
