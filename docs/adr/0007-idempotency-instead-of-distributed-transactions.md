# ADR 0007 — Idempotency keys instead of cross-module transactions

**Status:** Accepted
**Date:** 2026-08-06

## Context

Each module owns its persistence (ADR 0006). That leaves a question: when the
workflow engine advances an instance, appends a step to the operating record,
writes an audit entry, and calls an external system, what happens if the
process dies partway through?

The instinctive answer is a transaction spanning all of it. That works for the
database writes — they share a Postgres connection — but it cannot include the
external call, and the external call is the part whose duplication actually
costs something. A transaction that commits after an external effect has
already landed does not prevent the effect from landing twice on retry; it only
makes the local record consistent about it.

## Decision

**Durability of local state comes from transactions. Correctness of external
effects comes from idempotency keys.**

Every step carries an `idempotencyKey` derived from the instance id, the step
name, and attempt-invariant inputs. Before performing an external effect the
engine calls `RunStore.findStepByIdempotencyKey`. If a step already exists, the
effect already happened and is not repeated — the engine adopts the recorded
outcome and moves on.

Where writes genuinely must be atomic together, they are performed inside one
module and one transaction. The operations with hard atomicity requirements —
audit sequence assignment, step sequence assignment, approval consumption — are
each expressed as a single port method precisely so that no caller has to
orchestrate them.

The audit append is deliberately *not* in the same transaction as the effect it
records. It happens first, and a failure to write it denies the action
(ADR 0003). The ordering is chosen so that the failure mode is a recorded
decision whose effect did not land, rather than an effect that landed with no
record.

## Consequences

- A crash between two writes can leave a step recorded as `running` that never
  completes. Resumption handles this: the engine finds in-flight steps on
  startup and either resumes them idempotently or fails them explicitly. It
  does not guess.
- Idempotency keys must be genuinely attempt-invariant. A key that includes a
  timestamp or a retry counter silently reintroduces duplication, so key
  derivation lives in one place in the engine and is tested directly.
- Integration adapters must accept and honour an idempotency key. Where a real
  MVW system of record cannot, that limitation has to be surfaced when the
  integration is designed — it changes what the workflow can safely retry, and
  it is one of the questions to confirm before building any integration.
- There is no two-phase commit anywhere, and no distributed transaction
  coordinator to operate. That is a deliberate simplification.

## Alternatives considered

**A shared transaction handle threaded through every module.** Rejected: it
couples every module to every other, makes ports impossible to test in
isolation, and still does not solve the external-effect case.

**Transactional outbox for external calls.** A good pattern and a natural next
increment if the integration surface grows — it converts "call and hope" into
"record intent, then deliver at-least-once", which composes well with the
idempotency keys already in place. Not built for this release because the first
workflows read from systems of record rather than writing to them. Recorded in
the not-production-grade list.
