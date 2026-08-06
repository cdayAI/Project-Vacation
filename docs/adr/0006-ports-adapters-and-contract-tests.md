# ADR 0006 — Ports, adapters, and a shared contract-test suite

**Status:** Accepted
**Date:** 2026-08-06

## Context

Two requirements pull in the same direction. Integrations must sit "behind a
narrow, versioned interface with a realistic fake behind it and contract tests
both sides must satisfy". And a new engineer must go clone-to-running in under
fifteen minutes, which is not achievable if every test needs a database and
every demo needs a network.

Both are solved by the same structure, and both are undermined by the same
failure: a fake that is more forgiving than the real thing. A fake that accepts
what Postgres rejects, or that serialises operations Postgres runs
concurrently, turns a green test suite into misinformation.

## Decision

**Every persistence and integration dependency is a port**, defined by the
module that needs it, with two adapters: a real one and a fake one.

**One contract-test suite runs against both.** The suite is written once
against the port and parameterised by adapter. The Postgres half runs when
`PV_TEST_DATABASE_URL` is set — always in CI, optionally for a local engineer.

**The contract tests include concurrency.** This is the part that usually gets
skipped and the part that matters most here, because the platform's guarantees
are concurrency guarantees: audit sequence assignment, step sequence
assignment, and single-use approval consumption. The suite runs concurrent
callers against both adapters and asserts the invariant, so the in-memory
adapter has to implement real mutual exclusion (`MemoryDb.withLock`) rather
than relying on JavaScript's single-threaded execution to hide the problem.

**The fake stores objects, it does not emulate SQL.** A fake that reimplements
query semantics is a second database with its own bugs. `MemoryDb` is maps and
a mutex, and is correct by inspection.

**Ports are owned by the module that needs them**, not centralised. `RunStore`
lives in `record/`, `ApprovalStore` in `guard/`. A module ships its own two
adapters and its own migration. Adding a capability touches one directory.

## Consequences

- Unit and integration tests run with no external service. The fifteen-minute
  gate is met, and CI is fast.
- The in-memory adapter is honest enough to develop against, which means local
  behaviour matches deployed behaviour on the properties that matter.
- Cost: every port is implemented twice and every schema change is written
  twice. That is real ongoing work, accepted because the alternative is either
  a slow test suite everyone skips or a fake nobody trusts.
- The in-memory store is refused in staging and production by
  `kernel/config.ts`. It is not durable, and a deployment that reached for it
  by accident would lose the operating record on restart.

## Alternatives considered

**Testcontainers for everything.** A real Postgres per test run, no fake to
maintain. Rejected as the default because it makes the local loop slow and adds
a Docker requirement to the fifteen-minute path. Postgres is still exercised in
CI and by the same contract suite, which recovers most of the benefit.

**SQLite as the local adapter.** Rejected: it is a third dialect to maintain,
and its concurrency semantics differ from Postgres in exactly the areas the
platform's guarantees depend on — which is the worst possible place for a fake
to diverge.
