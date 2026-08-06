# Administrator guide

For platform administrators and MVW engineers operating the platform.

The operator guide covers daily use. This covers configuration, governance
changes, containment, and the things that need care.

---

## 1. The three facts to check first, every time

The health view and the startup banner both show these. If you learn nothing
else from this guide, learn to look at them:

1. **Is the sandbox contained?** `disabled` and `external` are safe.
   `subprocess` is **not a security boundary** — it constrains accidents, not
   adversaries. If any workflow executes untrusted input in `subprocess` mode,
   stop it.
2. **Is work discovery enabled?** It should be off. If it is on, written
   confirmation of employee notice, state monitoring-notice law, works-council
   and GDPR obligations for non-US staff, and union constraints must exist. If
   it does not, disable it now and escalate.
3. **Does the audit chain verify?** If not, that is a SEV1 and potentially
   tampering. Follow the incident process; do not remediate first.

---

## 2. Configuration

All configuration is environment variables, documented in `.env.example`. The
loader fails closed: an invalid value stops startup rather than falling back to
something permissive.

**Every default is the safe setting.** Execution disabled, egress allowlist
empty, discovery off, non-durable store. Nothing defaults to permissive, and
that is deliberate — a misconfiguration should produce a platform that refuses,
not one that permits.

Staging and production additionally refuse: the in-memory store, a missing OIDC
configuration, a session secret under 32 characters, and the fake model
provider. Those are hard refusals, not warnings.

**Secrets never go in configuration files.** They come from the deployment's
secret manager. They are never logged and never enter an audit record.

---

## 3. Containment — the stop buttons

Four scopes, all effective within about a second, none requiring a deploy:

```bash
CLI=packages/platform/src/cli/main.ts

# everything
pnpm --filter @pv/platform exec tsx $CLI containment engage --scope global \
  --reason "why"

# one workflow, one role, one integration
... containment engage --scope workflow    --target rescission.verify --reason "why"
... containment engage --scope role        --target rol_xxx           --reason "why"
... containment engage --scope integration --target contract-records  --reason "why"

... containment list
... containment release --scope global --reason "resolved"
```

Two properties worth knowing:

**They stop in-flight work.** Containment is re-checked before every step, not
only when work starts. A pause halts a workflow that began ten minutes ago at
its next action boundary.

**Compensation still runs.** If a workflow is stopped halfway through an
irreversible sequence, the compensating action is allowed to complete. Refusing
it would leave the world in the broken half-state the compensation exists to
repair.

A reason is required. It goes in the audit log.

---

## 4. Changing what the platform does

### Adding an action

Actions live in the action registry in source control, each with an explicit
risk tier. **An unregistered action cannot be performed** — it is refused, not
assumed harmless. Adding one is a code change, reviewed like any other.

The registry refuses at definition time to accept an action that is irreversible
but declares no approval, or that declares a human-involvement level weaker than
its risk tier requires. An action may be stricter than its tier. Never laxer.

### Adding or changing a role

A role is a versioned artifact: name, purpose, permitted actions, risk ceiling,
data scope, model assignment, prompt, evaluation set, and human-in-the-loop
tier.

An administrator can describe a job in plain language and the platform will
draft a role definition. **That draft is a proposal, never a live role.** There
is no path from authoring to acting.

Promotion requires evidence: the role runs against its evaluation set, the
results are recorded, and a human with authority approves. Only then can it act,
and only within its declared ceilings.

Every role change is versioned, diffable, attributable, and revertible. A role
can be disabled instantly through containment.

**Keep roles few and purposeful.** The registry refuses near-duplicates. If two
roles differ only in prompt wording, they are one role.

### Changing a model or a prompt

Business logic never names a model — it names a logical task, resolved from
configuration. Changing which model serves a task is a configuration change that
re-runs the affected evaluation set.

Prompts live in version control. **They are never edited in the database.**

### Approving an improvement

The improvement loop surfaces recurring failures with evidence, drafts a change,
evaluates it against the golden set, and offers it to a human with the before,
the after, the evaluation delta, and the blast radius.

Two things it will never do:

- **Apply anything without a recorded human decision.** There is no
  configuration that disables the gate, no auto-apply, and no test bypass. This
  is deliberate; see ADR 0011.
- **Weaken an evaluation case.** A proposal may add cases. It may never weaken,
  relabel, or delete an existing expected outcome — otherwise the cheapest way
  for the system to improve its score would be to move the goalposts.

Applying takes a snapshot and can be reverted in one action.

---

## 5. Adding a state's rescission rule

**Read this before touching `timeline/rules.ts`.**

Every rule currently shipped is a **placeholder** marked `verified: false`, with
a citation that begins with a placeholder marker and no source URL. None has
been checked against a statute. They exist to exercise the engine.

To make a rule real, counsel must confirm, for that state and effective period:
the window length; whether it counts calendar or business days; what starts the
clock, and whether delivery of the public offering statement or disclosure
documents can start it later than execution; whether the trigger day itself
counts; what happens when the last day is a weekend or a state holiday; which
holidays that state observes for this purpose; the governing timezone; and
whether the rule has changed within the period of contracts still in force.

Only then set `verified: true` **and** supply a real citation and source URL.
The table validator refuses a rule that claims verification without both, and
refuses one that claims verification while its citation still carries the
placeholder marker — the dangerous edit is flipping the flag alone, so that
specific case is blocked.

In production, set the computation to require verified rules. Unverified rules
then deny rather than returning a number somebody acts on.

---

## 6. Database and migrations

```bash
pnpm db:migrate
```

**Released migrations are immutable.** The runner records a checksum and refuses
to run if an applied migration's SQL has changed. Schema changes are additive
and zero-downtime: add a column, backfill, then start reading it — never rename
or drop in a single release.

The audit table carries a trigger that raises on `UPDATE` and `DELETE`. That is
intentional and must not be removed: it is what makes append-only survive
someone with a `psql` prompt and good intentions. **A platform administrator
cannot alter audit entries**, and that property is part of what the assurance
documentation claims.

---

## 7. Verifying the audit chain

```bash
pnpm audit:verify
```

Reports every break it finds, not just the first, so you get the extent of the
damage rather than its starting point. Break kinds: `hash_mismatch` (content
altered), `sequence_gap` (entries deleted), `previous_hash_mismatch` (chain
re-linked), `sequence_duplicate` (a fork), `timestamp_regression` (back-dating
or a clock problem).

Run it daily on a schedule. On failure, follow the incident process — and **do
not repair the chain.** A repaired chain is an unverifiable chain.

---

## 8. Cost

```bash
... cost report --since <ISO> --group-by workflow
... cost per-case --workflow rescission.verify --since <ISO>
```

Ceilings are enforced at consumption, not only pre-flight, so a runaway loop is
bounded by one step's cost. Alerts fire at 80% of the daily ceiling.

**When a ceiling alert fires, find out whether it is volume or a loop before
raising the limit.** Raising a ceiling to clear an alert is how a loop becomes
expensive.

---

## 9. Access

Roles come from directory groups, so access follows the HR lifecycle: remove
someone from the group and they lose access. There is no local password store.

The auditor role sees everything and changes nothing. Use it for reviewers who
need visibility without capability.

Service accounts are scoped and individually revocable. Only a hash of the
credential is stored; revocation is immediate.

---

## 10. Things that will look like bugs and are not

- **Denials are logged at `info`, not `error`.** A refused action is the
  platform working. Logging refusals as errors trains people to ignore errors.
- **The platform refuses to answer some questions.** If retrieval finds nothing
  adequate for a regulated question, it refuses and routes to a human rather
  than improvising. That is the design.
- **Spending can slightly exceed a ceiling.** The consumption check runs after
  the spend, which stops the *next* step. The overshoot is bounded by one step.
- **The in-memory store is refused in production.** It is not durable.
- **The fake model provider is refused in production.** It is a test double.

---

## 11. Before you deploy anything

Read `not-production-grade.md`. Six items are blockers, and one of them —
unconfirmed model provider terms — is enforced in code: the platform will not
start in production with the fake provider, and no real provider should be used
until zero-retention and no-training terms are confirmed in writing.
