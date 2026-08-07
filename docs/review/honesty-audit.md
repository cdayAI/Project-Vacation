# Pass 10 — the honesty audit

**Run:** 2026-08-07, against the tree as it stood after the twenty-six findings
of the verification pass were closed.

Every claim this project makes about itself, checked against the code: the
README, the fifty-three documents under `docs/` including the seventeen ADRs,
the published OpenAPI contract, the demo script's own narration, the CLI's help
text, the external-agent samples, and the code comments that describe behaviour
rather than mechanism.

**Why this pass is weighted more heavily here than it would be elsewhere.** The
entire value proposition of a governance product is that the record is true. A
place where the software says it did something it did not do is therefore not a
documentation defect, it is a product defect in the only feature that matters.
The pass that preceded this one had already found three: a step-up recorded that
nobody observed, an "already done" about writes that never happened, and an
indeterminate effect reported for a call that was never made. The instruction
was to assume there were more.

There were. **Nineteen findings, all fixed.** One of them is the same class as
those three and is the most serious defect this whole review has produced.

---

## The one that matters most

### H-01  `pv audit verify` reported an erased chain as an empty one

**Severity: CRITICAL** — the audit verifier, on a chain from which every entry
had been deleted, printed "Audit chain is empty. Nothing to verify." That is a
governance product telling an operator its evidence is fine at the exact moment
it has none, and the fix for the underlying detection had already landed.

**Where.** `packages/platform/src/audit/chain.ts`, `formatVerificationResult`.

**What happened.** F-09 added a durable high-water mark so that a chain
truncated from the end can be detected: `verifyChain` compares the entries it
was handed against the maximum sequence the chain is recorded as having reached,
and emits a `chain_truncated` break. That works. Confirmed live against
Postgres:

```
[chain_truncated] seq 0: The chain is empty, and it is recorded as having
reached sequence 1. Every entry has been deleted.
```

The renderer never showed it. `formatVerificationResult` opened with
`if (result.entriesChecked === 0) return "Audit chain is empty. Nothing to
verify."` — before it looked at `result.breaks`. A wiped chain has zero entries,
so the total wipe, which is the single case the watermark was built for, was the
one case the operator could not see. The exit code did go to 1, silently, under
a sentence saying nothing was wrong. `pv audit verify` prints this string and
nothing else; the structured result is only reachable behind `--json`.

**Why it survived F-09.** The reproduction for F-09 asserts on
`result.intact`, which was correct all along. Nothing asserted on what a human
reads. That is the gap this pass exists to find: a control that works at the
level a test looks at and fails at the level a person looks at.

**Fixed.** Breaks are reported before emptiness, and the empty-chain case is
reworded so it cannot be read as a pass:

```
Audit chain is empty — nothing was verified.
  An empty chain is what a deployment that has recorded nothing looks like.
  It is not evidence that anything is intact.
```

**Reproduction:** `src/review/pass10-claims.test.ts` — "does not report an
erased chain as an empty one" and "says plainly that an empty chain was not
verified, rather than implying it passed". Both failed before the fix.
Re-verified end to end against a real Postgres deployment: chain populated,
triggers dropped, table emptied, `pv audit verify` now exits 1 and names the
break.

---

## The README, followed literally

Pass 0 recorded that `pnpm audit:verify` after `pnpm demo` printed "Audit chain
is empty. Nothing to verify." and exited zero — exactly the sequence the README
instructs. **It was still true.** Re-run at the start of this pass, verbatim,
and it reproduced.

### H-02  The README instructed a verification that cannot verify anything

**Severity: HIGH.** The README said, after `pnpm demo`: *"Then verify the audit
chain the demo just wrote."* The demonstration builds its own platform with
`PV_STORE: "memory"` and a fresh `MemoryDb`, so its operating record and its
chain exist only for the life of that process. `pnpm audit:verify` starts a
second process, builds a platform against whatever store is configured — the
in-memory default — and finds nothing. Nothing the demo wrote is ever read.

The demonstration was never the problem: it verifies its own chain as its last
act and exits non-zero if that fails. The README was claiming a second,
independent verification that does not happen.

**Fixed at both ends.** The README now states plainly that the demonstration
runs in memory and leaves nothing behind, and moves `pnpm audit:verify` into the
Postgres section where it has a chain to read. The demonstration now ends by
saying where its record went. `docs/handover/engineer-walkthrough.md` had the
same two lines in its fifteen-minute quickstart and now carries the same
correction, with the reason, because a reader who is told only "don't" will do
it anyway.

The residual honesty risk — that a reader runs `audit:verify` regardless and
reads "nothing to verify" as a pass — is what H-01's rewording closes.

### H-03  "`pnpm test` — the whole suite" skips 158 assertions and stays green

**Severity: HIGH**, because it is the false-green class this review exists to
catch, and because it has already hidden a real defect once.

Measured. With `PV_TEST_DATABASE_URL` set: 1,937 tests, all passed. Without it:
1,766 passed, **158 skipped**, and the summary still reads green. What skips is
everything that proves the Postgres adapter behaves like the in-memory fake —
the concurrency cases, the append-only triggers, the store-unavailable refusals.

F-12 was precisely a case where the fake was *more permissive* than the real
store: a spend ceiling answered differently depending on which adapter was
wired. A developer running `pnpm test` on a laptop would not have found it.

**Fixed.** The README and the walkthrough state the count and what it covers.
More usefully, `packages/platform/tools/vitest-global-setup.ts` now announces
once per run which adapters were exercised:

```
  PV_TEST_DATABASE_URL is not set.
  The persistence contract suites will run against the in-memory adapters only;
  every Postgres case is SKIPPED. A green result from this run says nothing about
  the adapter a deployment actually uses.
```

A banner is not a control. It is the difference between a reader who has been
told and one who has not. Recorded as L20 in the not-production-grade list.

### Does the demo run twice in a row identically from a cold start?

**Yes.** Run four times during this pass, twice before any change and twice
after. `stdout` byte-identical; `stderr` byte-identical too, which CI does not
check but which is worth knowing. The head hash is unchanged by every edit made
here: `sha256:5944d3f1…c829b5872` over 34 entries, both times, on both days.

CI's determinism gate does what the README says it does — `pnpm demo` twice,
`diff -u`, fail on any difference — verified by reading `.github/workflows/ci.yml`.

Two things about that determinism are worth stating rather than leaving
implicit, and both are now stated on screen by the demonstration itself:

**H-18.** The demonstration silently ignored its own configuration. It calls
`loadConfig({ PV_ENV: "development", PV_STORE: "memory" })`, which since F-02
sets `requireVerifiedStatutoryRules: true` — and the process logs exactly that
at startup — and then computed four rescission deadlines anyway, because
`computeRescissionDeadline` was called without the option. A demonstration whose
behaviour contradicts its own logged configuration is showing a platform no
deployment has. The override is now explicit in the code with the reason, and
section 3 says on screen that a real deployment refuses all four dates and that
none of them may be acted on. Behaviour is unchanged, deliberately: making the
demo refuse would have changed `refusals` from 2 to 6 and broken an existing
assertion, and turning the demonstration into four refusals is a product
decision, not a review-pass one.

**H-19.** The demonstration verified its chain with `verifyChain(chain)` — no
watermark. That is the weaker check, the one that reports INTACT over an
emptied chain. A demonstration of tamper-evidence that demonstrates the version
the product does not ship is a small lie about the product's best feature. It
now passes the watermark, which is what `pv audit verify` does.

---

## Claims that were true only in theory

### H-04  The subject-rights runbook is a specification written as a procedure

**Severity: HIGH.** `docs/assurance/subject-rights-runbook.md` is the artifact a
privacy officer is handed. It walks through intake, access, deletion,
correction and opt-out in the present tense, with five command lines. **None of
the five commands exists.** `pv subject-rights record`, `export`, `delete`,
`correct` and `pv consent revoke` all exit 2 with "Unknown command". The two
audit events the whole procedure hangs on —
`subject_rights.request_recorded` and `subject_rights.fulfilled` — are declared
in `audit/types.ts` and emitted by nothing. `owner.export_data` and
`owner.delete_data` are registered actions with correct risk tiers and no
caller. Section 7's evidence query used a flag, `--subject-ref`, that the CLI
does not have; the real flag is `--subject <key=value>`.

**Fixed, by marking rather than deleting.** The procedure is right and is what
should be built, so the document is kept in full with an unmissable status block
at the top and a `# NOT BUILT — specified.` line inside every command block.
Section 7's two commands, which *do* exist, are corrected and labelled as
working — along with the caveat that they return nothing today because the event
types have no emitter.

Recorded as **B7**, a blocker rather than a gap: the moment this platform holds
an owner reference under CCPA/CPRA or GDPR, a deletion request creates a
statutory obligation the deployment cannot discharge, on a clock, with no manual
fallback. `docs/assurance/soc2-control-mapping.md` pointed at this runbook as
its privacy mapping and now says what it is pointing at.

The Pass 9 security reviewer independently reached the same answer in
`security-questionnaire.md` rows 3 and 10. Two reviewers finding it separately
is the reason it is stated three times.

### H-05  Sixteen metrics are documented; none is emitted

**Severity: HIGH** for a buyer's SRE, who reads that table as instrumentation.

`docs/ops/observability-and-cost.md` presents a table of sixteen metrics with
types and labels — `authorization_decisions_total`, `approval_age_seconds`,
`audit_verification_status`, and thirteen more, several annotated as the source
of an SLO with no error budget. **Nothing in the repository emits a metric.**
There is no metrics client, no exporter, and no instrumentation; the platform's
runtime dependencies are Fastify, `jose`, `pg`, `pino` and `zod`.

**Fixed by moving it from a description to a stated gap.** The section is
retitled "Metrics — specified, none emitted", says so in the first sentence, and
keeps the table because the list is right and choosing what to measure is most
of the work. It now also names what an operator *does* have instead: six CLI
verbs that each exit non-zero on the condition they check for, which a scheduler
can alert on without a metrics pipeline. Recorded as **S9a**.

Two SOC 2 rows were corrected in consequence. CC7.2 "Monitoring for anomalies"
moved from **Shared** to **Gap** — it cited "structured logs, metrics, traces,
denial-rate alerting", three of which do not exist. CC2.1 moved from
**Platform** to **Shared**, because its evidence included the logs.

### H-13  "Every log line carries a correlation id", and there is almost no log

**Severity: MEDIUM.** `kernel/logger.ts` opened by asserting that every line
carries a correlation id. `correlationId` is optional on `LogContext`, a caller
may pass no context at all, and the platform's own startup lines do exactly
that. `docs/ops/observability-and-cost.md` repeated the claim and drew the
conclusion that "one unit of work is reconstructable across the API, the engine,
and its model calls".

It is not reconstructable through the logs, because there are barely any logs. A
running API writes two lines at startup and one line per *unhandled failure*.
Fastify's own request logging is off — deliberately and correctly, since two
loggers with different redaction rules is how a secret reaches a log — and
nothing replaced it. A request that succeeds, or that is refused with a
`DeniedError`, writes nothing.

**Fixed.** Both the comment and the document now say what is true: the redaction
pass *is* unconditional and enforced inside `write` where no call site can skip
it; the correlation id is stamped when a caller supplies it; and a case is
followed today through the audit chain and the operating record, both of which
carry the caller's correlation id. Recorded as **S9**, together with its
consequence for the SLOs — `docs/ops/slos.md` S1 and S3 have no derivable source
and now say so at the point of the target.

### H-06  "Nothing in this platform calls `fetch` at an external system directly"

**Severity: MEDIUM.** That is the opening sentence of `integrations/egress.ts`,
the file that carries the host allowlist, the credential scoping, the recorded
step and the containment re-check. It has been false since single sign-on
landed: `identity/oidc.ts` calls `fetch` directly twice — the discovery document
and the token endpoint — and `jose`'s `createRemoteJWKSet` fetches the signing
keys on its own. No test asserted the claim, so it drifted without failing
anything.

**Fixed, and pinned.** The header now names the exception, explains why OIDC is
not routed through the client (it requires a `runId` and records a step before
every call; a sign-in has no run), and states what compensates — issuer-host
validation on every discovered endpoint, and `redirect: "manual"` on both calls
so a 307 cannot walk the client secret to an unvetted host.
`pass10-claims.test.ts` now derives the set of direct `fetch` callers from the
source and asserts it is exactly those two files, so a *third* fails the build.
Recorded as **S10**, with the consequence stated for the operator who reads
`PV_EGRESS_ALLOWLIST` as the complete list of hosts a deployment can reach.

### H-07  "Called by the scheduler and by the CLI"

**Severity: MEDIUM.** `ApprovalService.expireDue` carried that docstring. F-01
found it was called by neither and approvals therefore never expired anywhere.
The scheduler now exists — `maintenance.ts` runs it as the `approvals.expire`
pass of `pv worker` — so half the sentence became true. The CLI half never was
and still is not: no verb calls it. Corrected to name the one caller, and to
record that the sentence is why nobody checked.

### H-12  The request path lists a control that never runs on that path

**Severity: MEDIUM.** `docs/architecture.md` §3 draws the chokepoint as eight
checks, one of them "scope: is this actor entitled to this data?". The scope
check only runs when a caller supplies `requiredScopes`, and the console read
routes in `api/server.ts` supply none — they pass an action and an actor and
nothing else. Workflow steps, knowledge ingestion, freshness review and the
external plane do supply them, so the control is live there and inert on the one
path the diagram is drawing.

It is not exploitable: a `Run` carries no scope, so there is no second party's
record to reach for through `/api/runs`, `/api/approvals` or `/api/audit`, which
is why no failing test could be written. It becomes reachable the moment runs
carry a scope — which is exactly when somebody will assume the check has been
running all along. Stated in §3 rather than left implied by the diagram, and
recorded as **S11**.

---

## Claims that were simply out of date

### H-08  The README has not been touched since commit 1 of 40

**Severity: MEDIUM**, and it is the root cause of several of the entries below.
`git log -- README.md` returns exactly one commit: the platform foundation. The
external-agent plane, the console, the design system, the maintenance loop and
this entire review all landed afterwards.

The visible symptom was the module map. It listed nineteen directories and
omitted `external/` — the largest single surface in the platform, an inbound
HTTP API with its own admission chain, credentials, two-phase execution and
published OpenAPI contract — and `store/`. Pass 0's rule is that undocumented
surface area is a defect in its own right; a module missing from the map is a
module a new engineer will not know to look for.

**Fixed.** `external/` and `store/` added with descriptions, along with
`maintenance.ts` and `retention.ts`. `pass10-claims.test.ts` now derives the
module list from `readdirSync` and fails if the map falls behind again.

### H-09  "One chokepoint. Every action passes `guard/authorize.ts`"

**Severity: MEDIUM.** There are two chokepoints. Everything the platform does
itself passes `guard/authorize.ts`; everything an outside agent asks it for
passes `external/admission.ts`, which re-applies the same controls in the same
order against an enrolled agent rather than an employee, and re-runs the whole
chain at commit. That is a good design and ADR 0016 argues it — but "one
chokepoint" is the kind of claim a security reviewer tests, and finding a second
one undocumented costs more credibility than the second one costs in risk.

**Fixed** in the README and in `docs/architecture.md` §3, stating why there are
two: an external agent's request has to be admitted before there is an actor to
authorize.

### H-10  "Their absence is a feature, and each has an ADR"

**Severity: MEDIUM.** Six deliberate absences are listed in the README, with the
same claim repeated in `docs/architecture.md` §7. Three have ADRs: no autonomous
self-modification (0011), no multi-tenancy (0010), no card data (0009). Three do
not: no agent marketplace, no offline reflection subsystem, no plugin
marketplace. The point of the claim is that a future request meets a recorded
decision rather than an oversight — and for half the list, it meets a bullet.

**Fixed** by saying which is which, in both places, and noting that writing the
three missing ADRs is the cheap way to close it.

### H-11  The package declares an entry point no build produces

**Severity: MEDIUM.** `packages/platform/package.json` declared
`"main": "dist/index.js"`, `"types": "dist/index.d.ts"` and
`"exports": { ".": "./dist/index.js" }`. There is no `src/index.ts`, so `tsc`
never emits `dist/index.js`. `pnpm build` succeeds and produces a package whose
declared entry point does not exist; `import "@pv/platform"` fails with
`ERR_MODULE_NOT_FOUND`. Verified by building to a scratch directory: every
module compiles, `dist/cli/main.js` exists and the `bin` resolves, and
`dist/index.*` is absent.

Nothing imports the package as a library today, so nothing is broken — which is
why it went unnoticed for forty commits. `docs/review/inventory.md` cites
`src/index.ts` as the library entry point, which is where the fiction was
believed.

**Fixed** by removing the three fields rather than inventing a public API to
satisfy them. Choosing a library surface is a deliberate act; declaring one that
cannot be built is not.

### H-17  The layering table drifted from the layering test

**Severity: LOW.** `docs/architecture.md` §2 presents the module layering as a
description of an enforced rule. It omitted `review` at layer 9, added during
this pass, and said nothing about `maintenance.ts` and `retention.ts` sitting at
the package root. A reader deciding where to put a new module would have been
misled by it.

**Fixed**, with the reason `review` is declared at all — an undeclared directory
is skipped by the layering check entirely, so leaving it out would have exempted
it — and `pass10-claims.test.ts` now derives the expected module list from the
test's own `LAYERS` map.

### H-14  Six documents point at files that do not exist

**Severity: LOW** individually; collectively it is what makes a reader stop
trusting the cross-references.

| Document | Pointed at | Reality |
| --- | --- | --- |
| `docs/review-method.md` | `docs/design/spec.md`, `docs/architecture/spec.md` | `docs/design/design-spec.md`, `docs/architecture.md` — the method's own two authorities |
| `docs/ops/slos.md` | `observability.md` | `docs/ops/observability-and-cost.md` |
| `docs/ops/slos.md` | `load-testing.md` | Never existed; the gap is B5 |
| `docs/assurance/threat-model.md` | `docs/ops/backup-and-restore.md` | `docs/ops/backup-restore-and-dr.md` |
| `docs/assurance/vulnerability-policy.md` | `docs/assurance/exceptions.md` | Never existed — and the sentence was present tense: "Exceptions live in…" |

All corrected. The vulnerability-policy one was not a typo but a false
present-tense claim about a control — an exception register that has never
existed — and it is now stated as the open decision it is, with the consequence
that today the SLA is the only path.

### H-15  The restore drill opens with a command for a script that does not exist

**Severity: LOW**, but it is a 3am document. `docs/ops/backup-restore-and-dr.md`
§4 opened with a fenced `tools/restore-drill.sh --snapshot <id> --target-env
drill`. The script has never been written — §7 of the same document says so,
seventy lines later. A reader copies the first block, not the seventh section.

**Fixed** by replacing it with the manual sequence, every command of which has
been executed: the census query, `pv db status`, `pv audit verify` with the
watermark comparison against a pre-backup `pv audit head`, the census diff, and
`pv worker` against the restored database — the step that proves work resumes,
without which a drill proves only that rows came back.

### H-16  "No restore drill has been executed"

**Severity: LOW**, and it is the pleasant direction: the document understated
what had been done. B3 said the drill "has never been run, because there is no
deployed infrastructure". Steps 1–4 *were* run during the verification pass
against a local scratch Postgres and passed — `pg_dump` 0.27s, `pg_restore`
0.69s, no pending migrations, chain INTACT over the restored entries, row counts
identical.

**Corrected** to say exactly that, and to say plainly that it is a laptop and
not a drill: no snapshot, no isolated environment, no measured RTO, no recorded
evidence, and step 5 not run at all. An overstated gap is still an inaccurate
gap, and the next reader would have discounted the whole list on finding it.

---

## Benchmarks and measurements

Every number the project states about itself, and whether it is reproducible
today.

| Claim | Where | Reproducible now? |
| --- | --- | --- |
| The demo produces identical output on every run | README, CI | **Yes.** Run four times this pass; stdout and stderr byte-identical, head hash unchanged. CI's gate does what it says. |
| 1,937 tests pass across both store adapters | this pass | **Yes**, with `PV_TEST_DATABASE_URL` exported. 76 files, 0 failures, ~90s. |
| 158 assertions skip without a Postgres URL | H-03 | **Yes.** 1,766 passed / 158 skipped, measured both ways today. |
| Restore: `pg_dump` 0.27s, `pg_restore` 0.69s, chain INTACT, counts match | B3, findings REFUTED | **Yes**, at laptop scale. Now labelled as such. |
| Chain verification detects alteration, mid-chain deletion, and truncation | F-09, H-01 | **Yes.** Re-verified live against Postgres during this pass, including the total wipe. |
| Work queue: 200 cost queries to return 50 rows, now bounded by the page | F-20 | **Yes** — it is a test, `pass2-work-queue-cost.test.ts`. |
| `EXPLAIN` measurements on 200,000 runs (26ms seq scan; 22,645 buffers) | F-34, F-35 | **Not re-run.** The write-ups state the row count, the data distribution, and that the plan flips on distribution — which is the part that matters. Reproducing needs a seeded 200k-row database that is not in the repository. |
| Retrieval scored 0.130 against a 0.15 floor, and 0.689 rephrased | L3 | **Not re-run.** Stated with its method and both figures; the conclusion drawn from it is the right one. |
| SBOM: 356 components committed, 332 regenerated | F-31 | **Yes**, and deliberately not regenerated — `pnpm licenses list` reports this container, and platform-specific optional dependencies would resolve differently on a CI runner. |
| Luhn false-positive rate: 10% of raw 13-digit epoch-ms | F-30 | **Yes** — 2,000 of 20,000 consecutive values, stated with its sample. |
| SLO targets (99.5%, p95 < 500ms, …) | `docs/ops/slos.md` | **No, and the document says so** — "Status: proposed targets. None has been validated against measured production behaviour." Two of the nine now also say they have no derivable *source*, which is a stronger statement than "unmeasured". |
| Cost per case | L8 | **No, and the document says so** — the figures come from the deterministic fake provider's synthetic token counts. |
| RTO 4 hours / RPO 15 minutes | B4 | **No, and the document says so** — never exercised. |

The pattern worth naming: where this project states a number it has not
measured, it has generally said so. The failures were not overstated numbers —
they were **capabilities described in the present tense that do not exist**
(H-04, H-05, H-13), which is a harder thing to notice because there is no figure
to check.

---

## Refuted — claims that survived the check

Recorded so nobody re-derives them.

- **The CLI's help text is honest.** Every verb in `USAGE` dispatches, and every
  dispatched verb is in `USAGE` — compared mechanically. Fifteen verbs, exact
  match, including the four `pv cost report` / `approvals list` /
  `models degradation` / `engine timers` added by F-26 and `worker` added by
  F-01.
- **Every command in every document exists.** All `pv <verb>` and `pnpm
  <script>` invocations across `docs/handover/`, `docs/ops/`, `docs/assurance/`
  and `docs/external-agents/` were extracted and checked against the CLI's
  dispatch and `package.json`. The only failures were the five in the
  subject-rights runbook (H-04), which use an elided form that the existing
  runbook test does not parse.
- **The OpenAPI description is accurate**, including the parts most likely to
  have drifted: `202` meaning "waiting on a human", `indeterminate` meaning "not
  retried and must not be", and the cost-reconciliation rules — the last of which
  was corrected by F-27 during this review and is right.
- **The ADRs describe what was built.** All seventeen read against their
  subjects. No ADR claims a decision the code does not implement.
- **`docs/assurance/slos.md`, `dpa-support.md`, `data-inventory.md`,
  `eu-ai-act-assessment.md` and `nist-ai-rmf-mapping.md`** make no claim this
  pass could falsify. The NIST mapping's several references to "metrics" are to
  golden-set model-quality metrics, which are real, not to runtime
  instrumentation, which is not.
- **`not-production-grade.md` was accurate**, item by item, apart from B3
  understating what had been done. For a document of thirty-odd honest
  admissions written before this review, that is the strongest single signal in
  the repository about how it was built.

---

## Not fixed — for the owner

Four things found in this pass and deliberately left alone.

1. **`docs/review/findings.md` lags its own commits, and lagged twice during
   this pass.** Checked three times over the course of the audit. On the first
   check, fourteen findings read `Status: Asking first` whose fixes were already
   committed. Those were corrected. On the last check — after commit `fb9f18b`,
   whose message states that F-34 and F-35 are fixed and whose diff adds the
   composite index and the bounded count — **both still read `Asking first` and
   `Documented / Asking first`.**

   The consequence is narrow but it is this document's business: the findings
   report is what a reader consults to learn what is outstanding, and it
   currently names two open questions that have been answered in code. Left to
   the pass that owns the file rather than corrected here — it was being edited
   concurrently, and editing it from two directions is how a merge loses a
   finding.

   The general lesson is worth more than the instance. Every other claim
   corrected in this audit drifted the same way: **the code moved and the
   sentence about the code did not**, because nothing fails when a sentence goes
   stale. Six of the eight cases in `pass10-claims.test.ts` exist to make
   specific sentences fail.

2. **Two migrations share the prefix `0018`** — `0018_audit_watermark` and
   `0018_external_parked_committing`, added by two agents in parallel. The ids
   differ as full strings, so the duplicate check passes and ordering is
   deterministic. But `store/registry.ts` states that ids are allocated in
   blocks *specifically* so parallel work cannot collide on a number, and this is
   that collision. Nothing is broken and released migration ids are treated as
   immutable here, so renaming one is worse than the collision. The allocation
   comment should record what actually happened.

3. **`docs/review/inventory.md` cites `src/index.ts`** as the library entry
   point (H-11). Pass 0's document, left to Pass 0's owner.

4. **`docs/assurance/security-questionnaire.md` links
   `docs/review/buyers-gauntlet.md`**, which the Pass 9 agent was writing while
   this ran. Expected to resolve; noted so it is checked rather than assumed.

---

## What changed

**Source (5 files).** `audit/chain.ts` (H-01), `demo/run.ts` (H-02, H-18,
H-19), `integrations/egress.ts` (H-06), `guard/approvals.ts` (H-07),
`kernel/logger.ts` (H-13).

**Manifests and test infrastructure (4).** `packages/platform/package.json`
(H-11, plus a `worker` script), the root `package.json` (`worker`),
`vitest.config.ts` and `tools/vitest-global-setup.ts` (H-03).

**Documents (12).** `README.md`, `docs/architecture.md`,
`docs/handover/not-production-grade.md`,
`docs/handover/engineer-walkthrough.md`,
`docs/assurance/subject-rights-runbook.md`,
`docs/assurance/soc2-control-mapping.md`,
`docs/assurance/vulnerability-policy.md`, `docs/assurance/threat-model.md`,
`docs/ops/observability-and-cost.md`, `docs/ops/slos.md`,
`docs/ops/backup-restore-and-dr.md`, `docs/review-method.md`.

**New tests.** `packages/platform/src/review/pass10-claims.test.ts` — eight
cases, all deriving their expectations from the source rather than restating
them, so none can be satisfied by editing the test:

| Case | What it stops |
| --- | --- |
| does not report an erased chain as an empty one | H-01 returning |
| says plainly that an empty chain was not verified | the reassuring-empty reading |
| names only pnpm scripts that exist | a README instruction for a script nobody wrote |
| names only ADRs that exist | a citation outliving its decision record |
| maps every module directory in the platform source | H-08 — a new module going undocumented |
| has exactly the direct fetch callers the egress client says it has | a third path around the allowlist |
| names the exception in the egress client's own header | H-06 returning as a comment |
| lists every module the layering test enforces | H-17 — the table drifting from the rule |

**Nothing was weakened.** No test deleted, skipped, or relaxed; no assertion
widened; no threshold moved. Two reproductions were written to fail first and
verified to fail against the unfixed code before the fix landed.

---

## Verification

Run from `packages/platform` with
`PV_TEST_DATABASE_URL='postgresql://postgres@/pv_test?host=/var/run/postgresql'`
exported, so both store adapters are exercised.

- **`vitest run` — 76 files, 1,937 tests, 1,937 passed, 0 failed.**
- **`tsc --noEmit` — clean.**
- **`eslint src --max-warnings 0` — clean.**
- `pnpm demo` twice from cold — byte-identical, `stdout` and `stderr`.
- `pv audit verify` against a populated Postgres chain — INTACT, exit 0.
- The same chain erased at the table — `BROKEN … [chain_truncated] … Every entry
  has been deleted`, exit 1.

The suite is green including every reproduction from every pass of this review.
That is a different statement from the one this document opened under, when
thirty-two review tests were deliberately red pending owner decisions, and it is
worth saying explicitly: **the whole platform suite passes, and no test was
weakened to make that true.**

`packages/console/**` was not touched; it is being rebuilt concurrently and its
view tests are not this pass's to report on.

No git commits were created by this pass. Note for the owner: two concurrent
agents' commits — `a659971` and `fb9f18b` — swept this pass's in-progress
working-tree changes into themselves, because both staged the whole tree. The
content is intact and correct and the verification above was run against the
result; what is wrong is the attribution, since neither commit message mentions
any of the nineteen findings here. If the commit history is going to be read as
a record of why each change was made — which is this project's own standard for
everything else — those two commits are the place it does not hold.
