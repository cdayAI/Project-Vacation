# ADR 0002 — Technology stack

**Status:** Accepted
**Date:** 2026-08-06

## Context

The stack has to satisfy an unusual pair of constraints. It must be boring and
well-supported enough that MVW's engineers can maintain it after handover
without specialist knowledge, and it must be capable enough for a governed AI
operations platform: a durable workflow engine, model invocation, an evaluation
harness, and an accessible web console.

The stated exit gate for the foundation is that a new engineer goes
clone-to-running locally in under fifteen minutes on the README alone. That
rules out anything with a heavy local dependency graph or a bespoke build.

## Decision

**Language: TypeScript on Node 22 LTS**, one language across the API, the
platform, and the console.

**Repository: a pnpm workspace** with two packages — `@pv/platform` (the whole
backend) and `@pv/console` (the web application).

**Database: PostgreSQL 16.** Relational, transactional, universally understood,
and available as a managed service on every cloud MVW might deploy to.

**HTTP: Fastify.** Small, fast, well-maintained, schema-first.

**Console: React 19 with Vite**, plain CSS with custom properties for theming,
no component framework.

**Validation: zod.** One schema definition serving runtime validation and
static types.

**Tests: Vitest.** One runner for both packages.

**Deliberately absent:** an ORM, a state-management library, a CSS framework, a
component library, a monorepo build orchestrator.

## Rationale

*One language.* The alternative worth taking seriously was Python for the
platform and TypeScript for the console. Python has the deeper ecosystem for
evaluation and model tooling. We chose one language anyway because the dominant
cost here is not model tooling — it is the governance spine, the workflow
engine, and the console, all of which are ordinary application code. Two
languages means two toolchains, two dependency scanners, two SBOMs, two test
runners, and a typed contract that has to be maintained by hand across the
boundary. For a platform whose success condition is that someone else can
maintain it, one language is worth more than a marginally better library.

*No ORM.* Migrations must be immutable and additive, and schema changes must be
zero-downtime. Hand-written SQL makes both properties visible in review. An ORM
that generates migrations makes them a side effect of editing a model class,
which is exactly where zero-downtime discipline gets lost.

*No CSS or component framework.* The requirement is two themes, one coherent
design system, and WCAG 2.2 AA. A component library brings accessibility
behaviour we would have to audit anyway, plus a large dependency surface, plus
its own theming model to fight. Custom properties and semantic HTML are less
code, fewer dependencies, and a smaller thing to hand over.

*Postgres, with an in-memory adapter behind the same ports.* The fake exists so
that tests and the seeded demo run with no external service, which is most of
how the fifteen-minute gate is met. A shared contract-test suite runs against
both adapters so the fake cannot become more permissive than the real database.

## Consequences

- A new engineer needs Node and pnpm to run the tests and the demo, and adds
  Postgres only when working on persistence. That is the fifteen-minute path.
- We accept a thinner model-evaluation ecosystem than Python offers. The
  evaluation harness is therefore ours to write, which is a real cost, paid
  once.
- Hand-written SQL means more code than an ORM and more opportunity for a
  hand-rolled query bug. Mitigated by the contract tests running against the
  real database.
- Node's single-threaded execution model means CPU-bound work must not run in
  the request path. Nothing in the current design is CPU-bound; if that changes,
  it belongs in a worker rather than in the API process.

## Alternatives considered

**Python (FastAPI + SQLAlchemy + Alembic).** Better model-tooling ecosystem;
rejected for the two-language cost described above.

**Java or .NET.** Plausibly closest to what MVW already runs in the enterprise,
and the most likely long-term home if this platform is absorbed into an existing
estate. Rejected for this build because iteration speed matters more at this
stage and the ecosystem fit for AI tooling is weaker. If MVW's platform standard
turns out to be one of these, that is a question worth raising early — it is a
rewrite, not a port, and it is much cheaper to know now.

**A managed workflow engine (Temporal, Step Functions).** Genuinely tempting:
durable execution is hard and they solve it well. Rejected because the workflow
engine here is not only an execution substrate — it is where approval gates,
containment re-checks, statutory timers, and the audit trail are enforced. Those
would have to be layered on top of a foreign execution model, and the seam is
where governance bugs live. Revisit if instance volume outgrows a single
Postgres-backed scheduler; the engine's port boundary keeps that possible.
