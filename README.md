# Project Vacation

A governed AI operations platform built for Marriott Vacations Worldwide.

The premise is not that this platform automates work. It is that it automates
work **with a record that survives an audit** — every consequential action
classified, authorised, bounded, and written to a tamper-evident log that a
compliance officer can read unaided and an auditor can verify independently.

Vacation ownership is one of the most heavily regulated consumer businesses
that is not a bank: statutory rescission windows set by state law, consumer
lending disclosure, fair-lending and collections conduct, outbound-contact
consent, and owner-data privacy. Every one of those is a place where an
ungoverned agent creates real liability and a governed one is defensible. That
asymmetry is the product.

---

## Clone to running, in under fifteen minutes

**Prerequisites:** Node 22 or later, and pnpm 10 or later. Nothing else. No
database, no Docker, no network access to a model provider.

```bash
git clone <this-repository> project-vacation
cd project-vacation
pnpm install
cp .env.example .env
pnpm test          # in-memory adapters; see the note below about what this skips
pnpm demo          # the seeded demonstration, end to end
```

`pnpm demo` runs a governed workflow — governed ingestion of an authority
corpus, effective-dated retrieval, statutory deadline computation with its
derivation, a human approval bound to a proposal digest, and a containment
switch stopping a run already in flight — using deterministic fakes. It
produces identical output on every run; CI asserts that by running it twice and
diffing. It verifies its own audit chain as its last act and exits non-zero if
that verification fails.

**The demonstration runs entirely in memory and leaves nothing behind.** Its
operating record and its audit chain exist only for the life of the process.
`pnpm audit:verify` builds a fresh platform and reads whatever store is
configured, so running it after `pnpm demo` finds an empty chain — it is not a
verification of anything the demo did. Set up Postgres below if you want a
chain that outlives the process.

**What `pnpm test` skips.** Without `PV_TEST_DATABASE_URL` set, 158 persistence
contract assertions do not run: everything that proves the Postgres adapter
behaves identically to the in-memory fake, including the concurrency cases, the
append-only triggers, and the store-unavailable refusals. The run still ends
green. It prints which adapters it covered; read that line. A defect where the
fake was quietly more permissive than the real store has already been found
once here, so treat a run without the variable as a partial result.

### Adding Postgres

The in-memory operating record is not durable and is refused in staging and
production. To work on persistence, or to run the contract tests against a real
database:

```bash
createdb vacation
export PV_DATABASE_URL=postgresql://localhost:5432/vacation
export PV_STORE=postgres
pnpm db:migrate

# and to run the persistence contract tests against Postgres as well as the fake:
export PV_TEST_DATABASE_URL=postgresql://localhost:5432/vacation_test
createdb vacation_test
pnpm test
```

With a durable store configured, the audit chain survives the process, and
verifying it is the operator command it was written to be:

```bash
pnpm audit:verify   # exits non-zero on a broken chain, and reports every break
```

### Running the API, the worker, and the console

```bash
pnpm api        # HTTP API on PV_HTTP_PORT (default 8080)
pnpm worker     # maintenance: expiries, sweeps, reclaims, retention
pnpm console    # the operator console, in a third terminal
```

**The worker is not optional.** `pnpm api` serves requests and runs no
scheduled work of any kind. Without a worker process, approvals never expire,
statutory deadline timers never fire, a commit abandoned by a dead worker is
never surfaced to anyone, and no retention period is enforced. It is a separate
process on purpose — see the comment on the `worker` verb in
`packages/platform/src/cli/main.ts` — and exactly one should run.

In development, with no OIDC issuer configured, the platform uses a
development-only identity provider that refuses to start in any other
environment.

---

## What is here

```
packages/platform/src/
  kernel/        ids, clock, canonical JSON, hashing, redaction, config, logging
  store/         the database handle, the migration runner, the migration registry
  record/        the operating record — runs, steps, cost
  audit/         the tamper-evident hash-chained log and its verifier
  guard/         authorization chokepoint, risk tiers, approvals, ceilings,
                 containment switches, boundary screen, execution sandbox
  timeline/      statutory clocks — per-state rescission rules as data
  knowledge/     governed corpora, provenance, effective-dated retrieval, citations
  models/        model inventory, providers, degradation, cost attribution
  identity/      OIDC single sign-on, roles, step-up, service accounts
  integrations/  narrow ports, realistic fakes, contract tests, egress allowlist
  contact/       consent ledger and the single outbound compliance gate
  documents/     versioned templates and governed document generation
  engine/        the durable, resumable workflow engine
  external/      the plane that governs agents running outside this platform —
                 enrollment, credentials, admission, two-phase governed
                 execution, report ingestion (see ADR 0016)
  roles/         role registry, promotion with evidence, evaluation harness
  improve/       the human-gated improvement loop
  discovery/     work discovery — built, shipped disabled (see ADR 0012)
  workflows/     the shipped workflow definitions
  api/           HTTP surface
  cli/           operator commands
  demo/          the seeded demonstration
  maintenance.ts the loop `pv worker` runs — expiries, sweeps, reclaims
  retention.ts   the retention rules the loop enforces
packages/console/  the operator console (React, two themes, WCAG 2.2 AA)
docs/
  context/       the earnings-derived priorities and ranked workflow list
  adr/           architecture decision records
  assurance/     threat model, data inventory, retention, SOC 2 mapping, ...
  ops/           SLOs, runbooks, incident process, cost reporting
  handover/      operator and admin documentation, and what is NOT production grade
```

---

## The eight ideas worth knowing before reading the code

**1. Fail closed.** Missing config, an unreadable store, a broken screen, an
unavailable audit receipt — each *refuses the action* rather than proceeding
unrecorded. Refusal is a distinct type (`DeniedError`) with a machine-readable
reason, so "we did not do it" can never be mistaken for "something went wrong".
See ADR 0003.

**2. One chokepoint per plane, and only two planes.** Everything this platform
does itself passes `guard/authorize.ts`. Everything an outside agent asks it for
passes `external/admission.ts`, which re-applies the same controls — risk tier,
containment, scope, budget, screening, approval — against an enrolled agent
rather than an employee, and re-runs the whole chain again at commit so a
human's approval is necessary and never sufficient. Two, not one, because an
external agent's request has to be admitted before there is an actor to
authorize; both are single functions and there is no third way in. Every action
is registered with an explicit risk tier, and an unregistered action is refused
rather than assumed harmless.

**3. The audit log holds fingerprints, not payloads.** Hash-chained and
append-only, verifiable from an export with no access to our database. It proves
*which input* a decision was made from without becoming a second copy of owner
data. See ADR 0004.

**4. Approvals are bound to a digest of exactly what was proposed**, are
single-use by atomic compare-and-set, enforce segregation of duties, support
N-of-M, and expire. Swapping a proposal after approval fails at consumption.
See ADR 0005.

**5. Containment is checked at every step, not at the start.** A global pause,
a per-workflow, per-role, or per-integration switch stops in-flight work at its
next action boundary — no deploy, seconds to take effect.

**6. Legal deadlines are computed in one module, from data, and refuse when
unsure.** Per-state rules are a typed table with citations and effective dates,
not conditionals. An unknown state produces a refusal, never a default window.
See ADR 0008.

**7. The improvement loop cannot apply anything without a human.** There is no
configuration that disables the gate, no auto-apply, no test bypass. Evaluation
sets are protected against being weakened, so the system cannot learn to move
the goalposts instead of improving. See ADR 0011.

**8. Autonomy is earned on a ladder.** Shadow, assisted, supervised, bounded
autonomy — each a real mode in the product, enforced by the authorization
chokepoint. In shadow mode an action with an external effect is simply not
permitted.

---

## Deliberate absences

Their absence is a decision, not an oversight. Three are argued in an ADR; the
other three are recorded only here, which is weaker and is worth knowing before
you assume a request has already been considered and refused.

- No autonomous self-modification. No system changes its own behaviour, prompts,
  rules, or code without a recorded human decision. Argued in ADR 0011, which
  makes the improvement loop's human gate non-configurable.
- No multi-tenancy. Single customer, with a clean data-scoping seam (ADR 0010).
- No card data, ever. The platform is designed to stay outside PCI scope
  (ADR 0009).
- No agent marketplace or capability catalogue. Few, purposeful roles. **No ADR
  — this line is the whole record of the decision.**
- No offline reflection or "dreaming" subsystem. **No ADR.**
- No plugin or extension marketplace. **No ADR.**

---

## Before this goes near production

Read **[docs/handover/not-production-grade.md](docs/handover/not-production-grade.md)**
first. It is an honest list of what is not production grade, written to be read
by someone deciding whether to deploy.

Two items are load-bearing enough to repeat here:

- **The per-state rescission rules are unverified placeholders.** Every entry in
  `timeline/rules.ts` is marked `verified: false`. They exercise the engine
  correctly; none has been confirmed against current law. MVW's counsel must
  verify each before any production use. The platform now refuses rather than
  answers: `PV_REQUIRE_VERIFIED_STATUTORY_RULES` defaults to on and cannot be
  turned off in staging or production, so **a deployment computes no rescission
  deadline at all until counsel has verified the table**. That is the intended
  behaviour and it is loud. The seeded demonstration overrides the switch so the
  engine can be seen working, and says so on screen.
- **Work discovery is disabled** and must stay disabled until the employment-law
  questions in ADR 0012 are answered in writing.

---

## Common commands

| Command | What it does |
| --- | --- |
| `pnpm test` | Both packages. Skips 158 Postgres cases unless `PV_TEST_DATABASE_URL` is set |
| `pnpm verify` | Typecheck, lint, then the tests |
| `pnpm demo` | The seeded, deterministic demonstration (in memory; leaves nothing behind) |
| `pnpm audit:verify` | Verify the audit hash chain of the configured store, and report every break |
| `pnpm db:migrate` | Apply pending migrations (Postgres) |
| `pnpm sbom` | Generate a CycloneDX SBOM |
| `pnpm api` | Run the HTTP API |
| `pnpm worker` | Run the maintenance loop — required, see above |
| `pnpm console` | Run the operator console |

The operator surface is larger than this table: `pv --help` lists every verb,
including `containment`, `agents`, `approvals`, `cost`, `models`, `engine` and
`evaluate`. `docs/ops/runbooks.md` is where each is used in anger.

Run the **whole** suite before claiming it passes. Focused runs miss namespace
collisions, shadowed commands, and cross-module regressions.
