# Engineer walkthrough

For MVW engineers taking this over. The goal is that you can clone, run,
understand, extend, and operate this without us — and specifically that you can
deploy a small change to a non-production environment on your own.

Work through it in order. It takes about half a day, and most of that is the
reading in step 3.

---

## Step 1 — Running it (15 minutes)

```bash
git clone <repository> project-vacation
cd project-vacation
pnpm install
cp .env.example .env
pnpm test
pnpm demo
pnpm audit:verify
```

You need Node 22 and pnpm 10. No database, no Docker, no model-provider
network access. If any of that was not true, the fifteen-minute gate has been
missed and we want to know.

`pnpm demo` runs a complete governed workflow with deterministic fakes.
`pnpm audit:verify` verifies the chain the demo just wrote.

**Check your understanding.** Run `pnpm demo` twice and diff the output. It
should be byte-identical. CI asserts this. If you can explain *why* it is
identical, you have understood the clock and id injection, which is the design
decision most likely to trip you up later.

---

## Step 2 — Adding Postgres (15 minutes)

```bash
createdb vacation && createdb vacation_test
export PV_DATABASE_URL=postgresql://localhost:5432/vacation
export PV_STORE=postgres
pnpm db:migrate

export PV_TEST_DATABASE_URL=postgresql://localhost:5432/vacation_test
pnpm test
```

The second run of `pnpm test` executes the persistence contract suite against
the real database as well as the in-memory one. Compare the test counts: the
difference is the Postgres half, and it includes the concurrency tests.

**Check your understanding.** Open `packages/platform/src/store/db.ts` and find
`MemoryDb.withLock`. Then answer: why does an in-memory fake need a mutex when
JavaScript is single-threaded? If the answer is not obvious, read the comment
above it — that reasoning underpins several of the platform's guarantees.

---

## Step 3 — Reading, in this order (3 hours)

Do not start at the top of the directory listing. This order is chosen so each
file makes sense when you reach it.

1. **`docs/architecture.md`** — the shape of the system and the seven ideas that
   carry it. Twenty minutes, and it makes everything else faster.
2. **`packages/platform/src/kernel/`** — canonical JSON, hashing, clock, ids,
   redaction, config, errors. Small, and everything depends on it. Read
   `canonical.ts` properly; two separate guarantees depend on it being exactly
   right.
3. **`packages/platform/src/audit/chain.ts` and `chain.test.ts`** — the
   evidentiary claim and the tests that prove it. Read the test called
   "catches a competent attacker who re-seals the entry they altered". That
   test is the reason the log is chained rather than checksummed.
4. **`packages/platform/src/guard/authorize.ts`** — the chokepoint. Note the
   order of the checks and read the comment explaining why approval is consumed
   last.
5. **`packages/platform/src/guard/guard.test.ts`** — the adversarial tests. This
   is the fastest way to learn what the controls actually promise, because each
   test names an attack.
6. **`packages/platform/src/timeline/rules.ts`** — the statutory rules, and the
   header explaining why every one ships unverified.
7. **`packages/platform/src/engine/`** — the workflow engine.
8. **`docs/adr/`** — skim all of them, read 0003 (fail closed), 0005
   (approvals), and 0011 (the improvement gate) in full.

**Check your understanding.** Answer these without looking:

- Why does a denial log at `info` rather than `error`?
- Why is a spend ceiling checked *after* the money is spent as well as before?
- Why can a compensation step run while the platform is globally paused?
- What happens if the audit store is unreachable when an action is attempted?
- Why can't the improvement loop apply a change that improves the golden set by
  40% without a human?

If any of those surprise you, the answer is in `docs/architecture.md` §6,
"Things that will look wrong until you know why".

---

## Step 4 — Making a change (1 hour)

A deliberately small, real change: **add a new state's rescission rule.**

1. Open `packages/platform/src/timeline/rules.ts`.
2. Add an entry for a state not currently covered, following the shape of the
   existing ones. Leave `verified: false` — you are adding structure, not law.
3. Run `pnpm test`. The rule-table validator will tell you if the entry is
   malformed.
4. Add a test in `compute.test.ts` asserting the deadline your rule produces for
   a specific contract date, including one that lands on a weekend.
5. Run the whole suite, not just your file.

**Then try to break the rules deliberately**, so you meet the guardrails while
they are cheap:

- Set `verified: true` without a citation. The validator should refuse it.
- Set `verified: true`, add a citation, but leave the placeholder marker in it.
  It should still refuse — that is the dangerous edit, flipping the flag alone.
- Add `const now = Date.now()` anywhere in `src/`. The architecture test should
  fail.
- Import `models` from inside `discovery`. The architecture test should fail.

Each of those failures should tell you clearly what is wrong and why. If one is
cryptic, that is a defect worth reporting.

---

## Step 5 — Adding a capability (1 hour)

The second change: **add an action the platform can take.**

1. Register it in the action registry with an explicit risk tier. Try omitting
   the tier, or declaring an irreversible action as `automatic` — both should be
   refused at definition time.
2. Call it through `Authorizer.authorize`. Observe that an unregistered action
   is refused rather than assumed harmless.
3. Look at the audit entries your action produced.

**Check your understanding.** Why is there no way to perform an action without
going through the chokepoint? What stops someone adding one?

(The answer is in `architecture.test.ts` — the layering rule. `guard` sits below
everything that acts, so nothing can route around it without an upward import,
which fails the build.)

---

## Step 6 — Deploying to a non-production environment

**This is where the handover is currently incomplete, and you should know that
before you start.**

There is no infrastructure-as-code in this repository. Environments,
networking, the managed database, secret management, and the deployment
pipeline are not defined here. See `not-production-grade.md` item S6.

What you *can* do today:

```bash
PV_ENV=staging \
PV_STORE=postgres \
PV_DATABASE_URL=... \
PV_OIDC_ISSUER=... PV_OIDC_CLIENT_ID=... PV_OIDC_CLIENT_SECRET=... \
PV_OIDC_REDIRECT_URI=... PV_SESSION_SECRET=... \
PV_MODEL_PROVIDER=... \
pnpm build && pnpm db:migrate && pnpm api
```

Notice what happens if you omit any of the identity variables, or leave
`PV_STORE=memory`, or leave `PV_MODEL_PROVIDER=fake`. The platform refuses to
start. That is deliberate: staging and production reject the development
defaults rather than running with them.

**What you need to build for a real deployment**, in the order we would do it:

1. Infrastructure as code for the database, secrets, and runtime.
2. A container build, with image scanning in the same pipeline.
3. The restore drill, executed and recorded (`docs/ops/backup-restore-and-dr.md`).
4. A DR failover exercise.
5. Load testing, to establish the capacity ceiling nobody currently knows.

---

## Step 7 — Operating it

Read `admin-guide.md` and `docs/ops/runbooks.md`. Then practise the two things
you will need under pressure:

**Engage and release containment.** Do it on the demo. Notice that engaging a
pause stops a run that is already in flight, not just new work.

**Verify the audit chain and read a failure.** Corrupt a row in a scratch
database, run `pnpm audit:verify`, and read what it tells you. Then read
`docs/ops/incident-process.md` § "Audit chain verification failure" and note
the instruction not to repair the chain.

---

## Step 8 — What to be careful about

The five places where a well-intentioned change does real damage:

1. **Never catch a `DeniedError` and continue.** A refusal is not an error to
   recover from; it means the effect did not happen. The architecture test
   catches the obvious shape of this, but not every shape.
2. **Never read the wall clock directly.** Inject a `Clock`. It breaks the
   demo's reproducibility, statutory timer testing, and eventually a deadline.
3. **Never add a bypass to the improvement gate.** Not a flag, not a test
   helper. It is the single claim the risk committee will lean on hardest.
4. **Never weaken a golden-set case.** Adding cases is always fine. If a case is
   genuinely wrong, that is a human decision with a record, not a code change.
5. **Never edit a released migration.** The runner checksums them and will
   refuse. Add a new one.

---

## Step 9 — Before you deploy anything to production

Read `not-production-grade.md` end to end. Six items are blockers. Two of them
have no engineering fix and need MVW to act:

- The statutory rules are unverified placeholders until counsel confirms them.
- The model provider's data-handling terms are not contractually confirmed.

The second is enforced in code: the platform refuses to start in production with
the fake provider, so it cannot currently run in production at all until that is
resolved. That is intentional.

---

## Handover completion

We consider the handover done when an MVW engineer has, unaided:

- gone clone-to-running in under fifteen minutes;
- added a rescission rule with a test and seen the guardrails refuse the bad
  versions;
- added an action and seen it refused before registration;
- engaged and released containment on a running instance;
- read an audit verification failure and known not to repair it;
- deployed a change to a non-production environment.

The last one is currently blocked on infrastructure that does not exist yet.
That is stated here rather than glossed over, because the gate is real and we
have not met it.
