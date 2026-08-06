# ADR 0013 — Models are resolved from configuration by logical task name

**Status:** Accepted
**Date:** 2026-08-06

## Context

Model governance is where MVW's risk committee will spend its time. The
questions they will ask are: which model serves which task, at what version,
with what fallback, evaluated how, changed under what control, and with what
contractual data-handling terms.

None of those questions can be answered if a model identifier appears inline in
business logic. A hard-coded model is invisible to inventory, unreviewable as a
change, and impossible to swap under an incident.

## Decision

**Business logic asks for a logical task name. Never a model.**

`models/inventory.ts` resolves a task such as
`rescission.extract_contract_facts` to a concrete provider, model id, version,
parameters, and fallback chain — all from configuration. An unknown task throws
`DeniedError("model.not_in_inventory")`. Concrete model identifiers appear only
in inventory defaults and deployment configuration.

Consequences of that single rule, all of which follow for free:

- **The inventory is the artifact.** `list()` produces the model-inventory
  assurance document rather than someone maintaining a spreadsheet.
- **Change control is real.** Changing which model serves a task is a
  configuration change, reviewable, and it re-runs the affected role's
  evaluation set.
- **Prompts live in version control**, versioned as artifacts, never
  hand-edited in a database.
- **Graceful degradation is centralised.** On timeout, rate limit, or outage,
  the gateway walks the declared fallback chain and records `model.degraded`.
  If every option fails it throws `model.provider_unavailable` rather than
  silently returning a worse answer.
- **Cost is attributable.** Per-token costs live in the inventory entry, so
  cost per case, per workflow, and per department falls out of the operating
  record.
- **Screening comes first.** Untrusted input passes the boundary screen before
  it reaches any provider, at the gateway, once.
- **The audit record holds digests only.** Prompt and response are recorded as
  fingerprints; the text is not written to the audit log.

## Consequences

- One indirection between the caller and the model. Worth it.
- The deployed model identifiers, and whether zero data retention and no
  training on MVW data are contractually in place, must be confirmed with MVW
  and recorded before production use. That is an open question, not an
  assumption, and it is on the confirm-before-building list.
- The fake provider is deterministic and seeded, which is what makes the demo
  reproducible and the evaluation harness testable without a network.

## Alternatives considered

**A model-gateway product in front of everything.** Solves routing and
fallback, but not evaluation gating, not change control tied to golden sets,
and not the audit linkage. It would sit behind this interface rather than
replace it.

**Per-role hard-coded models.** Simpler, and it makes the inventory a
documentation exercise that drifts. Rejected.
