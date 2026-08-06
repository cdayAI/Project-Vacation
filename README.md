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
pnpm test          # the whole suite, in-memory adapters, no external services
pnpm demo          # the seeded demonstration, end to end
```

`pnpm demo` runs a complete governed workflow — intake, retrieval against
effective-dated authority, a model call, a human approval, a governed action,
and the audit record — using deterministic fakes. It produces identical output
on every run; CI asserts that by running it twice and diffing.

Then verify the audit chain the demo just wrote:

```bash
pnpm audit:verify
```

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

### Running the API and the console

```bash
pnpm api        # HTTP API on PV_HTTP_PORT (default 8080)
pnpm console    # the operator console, in a second terminal
```

In development, with no OIDC issuer configured, the platform uses a
development-only identity provider that refuses to start in any other
environment.

---

## What is here

```
packages/platform/src/
  kernel/        ids, clock, canonical JSON, hashing, redaction, config, logging
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
  roles/         role registry, promotion with evidence, evaluation harness
  improve/       the human-gated improvement loop
  discovery/     work discovery — built, shipped disabled (see ADR 0012)
  workflows/     the shipped workflow definitions
  api/           HTTP surface
  cli/           operator commands
  demo/          the seeded demonstration
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

**2. One chokepoint.** Every action passes `guard/authorize.ts`. Every action is
registered with an explicit risk tier; an unregistered action is refused rather
than assumed harmless.

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

Their absence is a feature, and each has an ADR:

- No autonomous self-modification. No system changes its own behaviour, prompts,
  rules, or code without a recorded human decision.
- No agent marketplace or capability catalogue. Few, purposeful roles.
- No offline reflection or "dreaming" subsystem.
- No plugin or extension marketplace.
- No multi-tenancy. Single customer, with a clean data-scoping seam (ADR 0010).
- No card data, ever. The platform is designed to stay outside PCI scope
  (ADR 0009).

---

## Before this goes near production

Read **[docs/handover/not-production-grade.md](docs/handover/not-production-grade.md)**
first. It is an honest list of what is not production grade, written to be read
by someone deciding whether to deploy.

Two items are load-bearing enough to repeat here:

- **The per-state rescission rules are unverified placeholders.** Every entry in
  `timeline/rules.ts` is marked `verified: false`. They exercise the engine
  correctly; none has been confirmed against current law. MVW's counsel must
  verify each before any production use.
- **Work discovery is disabled** and must stay disabled until the employment-law
  questions in ADR 0012 are answered in writing.

---

## Common commands

| Command | What it does |
| --- | --- |
| `pnpm test` | The whole suite across both packages |
| `pnpm verify` | Typecheck, lint, then the whole suite |
| `pnpm demo` | The seeded, deterministic demonstration |
| `pnpm audit:verify` | Verify the audit hash chain and report every break |
| `pnpm db:migrate` | Apply pending migrations (Postgres) |
| `pnpm sbom` | Generate a CycloneDX SBOM |
| `pnpm api` | Run the HTTP API |
| `pnpm console` | Run the operator console |

Run the **whole** suite before claiming it passes. Focused runs miss namespace
collisions, shadowed commands, and cross-module regressions.
