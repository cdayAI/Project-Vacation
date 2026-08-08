# What is not production grade

**Last reviewed:** 2026-08-07, in the verification pass's honesty audit
(`docs/review/honesty-audit.md`). Six items were added from it — B7, S9, S10,
S11, and L17 through L20 — and B3 was corrected: a partial restore drill *has*
now been run, against a laptop, which is not the drill this document was asking
for.

Read this before deciding to deploy anything.

This is an honest list of what is incomplete, unverified, or knowingly weak. It
exists because the alternative — discovering these during an assessment, an
incident, or an audit — is worse for everyone. Nothing here is hidden in a
footnote elsewhere; each item is repeated in the assurance document it affects.

Items are ordered by how much they should worry you, not by how hard they are to
fix.

---

## Blockers — must be resolved before any production use

### B1. The statutory rescission rules are unverified placeholders

**What.** Every rule in `packages/platform/src/timeline/rules.ts` is marked
`verified: false`. Window lengths, trigger events, business-day treatment,
holiday handling, and citations are structural placeholders that exercise the
engine correctly. **None has been confirmed against current law.**

**Why it matters.** This is the highest-consequence computation in the platform.
A wrong rescission deadline voids a contract.

**What is required.** MVW's counsel verifies each state's rule and citation. A
test already fails if a rule is marked `verified: true` without a citation and a
source URL, so the verification cannot be recorded carelessly.

**Interim mitigation.** The module refuses on unknown states and refuses when no
rule is effective for a trigger date. It never guesses a window. But a rule that
is present and wrong is far more dangerous than one that is absent, and only
verification fixes that.

### B2. Model provider terms are not contractually confirmed

**What.** Zero data retention and no training on MVW data have not been
confirmed in writing.

**Why it matters.** Owner-derived content, however minimised and redacted, would
be sent to a third party under unknown terms.

**What is required.** Written confirmation from the provider, recorded in the
repository, before any production model call. Until then, run with
`PV_MODEL_PROVIDER=fake` — and note that the configuration loader already
refuses `fake` in staging and production, which means **the platform cannot
currently be run in production at all** until this is resolved. That is
deliberate.

### B3. No restore drill has been executed on real infrastructure

**What.** The backup and restore procedure is written and the drill is specified
(`docs/ops/backup-restore-and-dr.md`). Steps 1–4 of it were run by hand during
the verification pass against a local scratch Postgres and passed — `pg_dump`
0.27s, `pg_restore` 0.69s, no pending migrations, the restored chain verified
INTACT, row counts identical to the pre-backup census. **That is a laptop, not a
drill.** No snapshot, no isolated environment, no measured RTO, no recorded
evidence, and step 5 — confirming work resumes — was not run at all.

**Why it matters.** A backup you have never restored is a hope. For this
platform the drill has an extra step that matters more than the data coming
back: **the restored audit chain must verify.** A restore that returns data but
produces a chain that fails verification is a failed restore.

**What is required.** Execute the drill on real infrastructure, time it against
the stated RTO, record the result, and repeat monthly. `tools/restore-drill.sh`
is named in the ops document as the thing that would automate it and has never
been written; §4 there now walks the manual sequence instead.

### B4. No disaster-recovery exercise

**What.** RTO 4 hours and RPO 15 minutes are documented. Failover has never been
performed.

**What is required.** Exercise it, including the audit-chain verification that
must complete *before* the promoted replica accepts writes.

### B5. No load testing; the capacity ceiling is unknown

**What.** No throughput, concurrency, or saturation testing has been performed.
MVW's seasonal peak shape is unknown to us and must not be guessed.

**Why it matters here specifically.** Q2 2026 showed contract sales up 22% on
tours down 1% — the back office is absorbing a step change in volume — and
full-year guidance implies H2 above H1. Sizing from real numbers is a
prerequisite.

**Where we expect the first bottleneck.** The audit append lock serialises the
chain by design. Measure that first.

### B6. Work discovery must stay disabled

**What.** The feature is built and ships off. The employment-law questions in
ADR 0012 are unanswered.

**What is required, in writing.** Employee notice and consent, and whether it is
opt-in per person; state electronic-monitoring notice law for every state whose
staff would be observed; works-council consultation and GDPR obligations for
European or other non-US staff; union and collective-agreement constraints; and
whether contact-centre staff already recorded for QA are treated differently.
Additionally, this is a strong EU AI Act Annex III high-risk candidate — see
`eu-ai-act-assessment.md`.

### B7. A subject-rights request cannot be executed against this platform

**What.** Access, deletion, correction and opt-out are specified end to end in
`docs/assurance/subject-rights-runbook.md` and none of it is built. There is no
`subject-rights` verb and no `consent` verb in the command line;
`owner.export_data` and `owner.delete_data` are registered actions with correct
risk tiers and no caller; `subject_rights.request_recorded` and
`subject_rights.fulfilled` are declared audit event types that nothing emits.

**Why it is a blocker rather than a gap.** The moment this platform holds an
owner reference under CCPA/CPRA — or GDPR, if European owners are in scope — a
deletion request creates a statutory obligation the deployment cannot discharge,
on a clock. There is no manual fallback either: no operator surface exists to
purge a document body or to record a revocation by hand.

**Related, and worth knowing while it is open.** The architectural claim that
makes this cheap when it is built — the audit chain holds digests and opaque
references, so deletion does not touch the evidence — is now enforced rather
than asserted: `AuditLog.record` refuses direct identifiers, and the retention
pass is structurally unable to delete an audit entry. So the hard half is done
and the missing half is ordinary work.

**What is required.** Build the four verbs and the two events, then run a
deletion end to end and confirm the chain still verifies afterwards. That last
check has never been performed, because there is nothing to perform it with.

---

## Significant gaps — needed before a security assessment will pass

### S1. The audit chain is tamper-evident, not tamper-resistant

**What.** An actor with write access to **both** the database and the
application can rewrite the whole chain consistently, and verification would
pass. The chain defends against targeted edits, deletions, and back-dating — the
realistic insider actions — not against total control.

**The fix, not built.** Periodically publish the head hash to a location outside
the deployment's control: an append-only external store, or a countersignature
from a separate trust domain. Verification then anchors to a value the attacker
cannot rewrite. `verifyChain` already accepts an explicit expected starting hash,
so the verifier side is ready.

### S2. No penetration test

Scope, test accounts, and known limits are prepared in `pentest-readiness.md`,
including a request that testers report on the eight specific claims rather than
only on findings. The test has not been commissioned.

### S3. No signed builds with provenance

Specified in the definition of done. Not implemented. Needs SLSA-style build
attestation in the release pipeline.

### S3a. The SBOM records inventory, not the dependency graph

`tools/generate-sbom.mjs` emits a valid CycloneDX 1.5 document listing every
installed package with its version and licence, deterministically ordered so
two builds of the same tree produce an identical file.

It does **not** yet emit the dependency graph (which package pulled in which)
or per-package integrity hashes. Both are recoverable from
`pnpm-lock.yaml` and are worth adding before an assessment that asks for full
supply-chain provenance — "which of our dependencies introduced this
transitive package" is a question the current document cannot answer.

Written rather than taken off the shelf because `@cyclonedx/cyclonedx-npm`
shells out to `npm ls`, which cannot read a pnpm workspace. A command that
fails is worse than thirty lines that work.

### S4. No container image scanning

There is no container build in this repository yet. Scanning belongs in the same
pipeline when it lands.

### S5. Rate limiting and ceiling reservations are per-process

**What.** The model-call rate window and the ceiling reservations live in process
memory (`guard/ceilings.ts`). A multi-instance deployment can exceed the
intended call rate by roughly the instance count.

**Not affected.** Spend ceilings, because spend is summed from the shared
operating record.

**Required before horizontal scaling.** Move the rate window and reservations to
shared storage.

### S6. No infrastructure as code

Environments, networking, the managed database, secret management, and
deployment are not defined in this repository. Until they are, none of B3, B4,
or B5 can be exercised, and "separate environments" and "one-command rollback"
are unimplemented.

### S7. Audit archival is specified but not built

The prune-a-prefix-and-anchor procedure is documented and the verifier supports
it. The archival job is not written, and **nothing in the platform prunes the
chain** — there is no deletion operation on the audit store, and the retention
job refuses at construction to accept a rule targeting the chain. The chain
therefore grows without bound, which is a capacity problem rather than a
compliance one. `PV_AUDIT_RETENTION_DAYS` is the period MVW is undertaking to
keep it *for*; it does not cause anything to be removed from it.

### S8. Twelve of the fourteen retention rules are policy, not code

`retention-and-deletion.md` §1 lists fourteen rules and marks the two the
platform enforces today: the improvement loop's observations, and work-discovery
observations. §5 names the other twelve and what each is waiting on — mostly a
period MVW has not confirmed, or a `run` reference that cannot be deleted while
four tables that point at it have no period of their own.

Two consequences an operator should know. The rules that *are* enforced are
applied by the `retention.purge` pass of the maintenance loop, so **a deployment
that never runs `pv worker` enforces no retention at all**. And the purge does
not run while the platform is globally paused — deliberately, since a deletion
cannot be undone when the incident turns out to be the reason the data was
needed — so a long containment window defers retention until it is released.

### S9. There is no HTTP request log, so two SLO indicators have no source

**What.** `api/server.ts` sets `logger: false` — deliberately, because two
loggers with different redaction rules is how a secret reaches a log — and
nothing replaced it. The platform's own logger writes two lines for the lifetime
of the process, plus one per unhandled failure. There is no per-request line at
all.

**Why it matters.** Any request that does not throw leaves no trace outside the
audit chain and the operating record, so a case cannot be followed across
components through the log stream. `docs/ops/slos.md` S1 (successful page loads
over attempts) and S3 (p95 read latency) are not derivable from anything that
exists, which makes them aspirations rather than objectives.

**What is required.** An `onResponse` hook writing method, path, status,
duration and correlation id through the platform's own logger. The correlation
id is already minted per request and already reaches the audit chain and the run
row, so the join is one field away. Confirm the redaction rules cover the URL
before turning it on.

### S9a. No metrics are emitted; the metric list is a specification

`docs/ops/observability-and-cost.md` specifies sixteen metrics with types and
labels, derived from the SLOs they serve. **None of them is emitted.** There is
no metrics client, no exporter, and no instrumentation anywhere in the platform;
its runtime dependencies are Fastify, `jose`, `pg`, `pino` and `zod`.

The list is right and worth building. What an operator has instead today is the
CLI: `pv health`, `pv cost report`, `pv approvals list --ageing`, `pv models
degradation`, `pv engine timers` and `pv audit verify` each exit non-zero on the
condition they check for, so a scheduler can alert on them without a metrics
pipeline. That covers the alerts; it does not cover dashboards, trends, or
anything an SRE would call observability.

### S10. Single sign-on does not pass through the egress allowlist

**What.** `PV_EGRESS_ALLOWLIST` bounds every call to a system of record, because
every one goes through `integrations/egress.ts`. `identity/oidc.ts` does not: it
calls `fetch` directly for the discovery document and the token endpoint, and
`jose` fetches the signing keys on its own. So an operator who reads the
allowlist as "the complete list of hosts this deployment can reach" is wrong
about the identity provider.

**What compensates.** The discovery document is validated so every endpoint must
be HTTPS on the issuer's own host, and both calls now set `redirect: "manual"`
so a 307 cannot walk the client secret to an unvetted host. Those are real
controls and they are narrower than the seven the egress client carries.

**Why it is not simply fixed.** `EgressClient` requires a `runId` and records a
step before every call, and a sign-in has no run. Routing OIDC through it means
deciding what the operating record says about an authentication, which is a
design question rather than a patch. A test now fails if a *third* direct
`fetch` caller appears, so the exception cannot quietly become a pattern.

### S11. The data-scope check is inert on every console read

**What.** `authorize()` compares an actor's scope entitlements against
`ActionRequest.requiredScopes`, and the console read routes supply none — they
pass an action and an actor and nothing else. Workflow steps, knowledge
ingestion, freshness review and the external plane do supply them, so the
control works where it is used.

**Why it is not exploitable today.** A `Run` carries no scope, so there is no
second party's record to reach for through `/api/runs`, `/api/approvals` or
`/api/audit` — the check has nothing to compare against, which is why no failing
test could be written for it. It becomes reachable the moment runs carry a
scope, and that is exactly when somebody will assume the check has been running
all along.

---

## Known limits — understood, accepted for now, worth knowing

### L1. Prompt-injection screening is heuristic

`guard/screen.ts` catches known shapes and will miss novel phrasing and
determined obfuscation. It is deliberately not the load-bearing control: the
architecture bounds the blast radius (a model never holds tool authority its
calling role lacks; every consequential action passes the chokepoint). The
screen reduces the rate. Neither alone is sufficient and neither is claimed to
be.

### L2. Bias testing runs on synthetic fixtures only

The harness exists and works. Real fairness testing requires MVW compliance
engagement and realistic data before any consumer-affecting workflow goes live.
Do not represent the current state as fairness-tested.

### L3. Retrieval is lexical only, and phrasing matters at the margin

No embeddings (ADR 0015). Recall is weaker where a question and the authority
use different vocabulary. A miss produces a refusal and a routing to a human,
not a wrong answer — the right failure direction, but it costs operator time.

**Observed while building the demonstration**, and worth knowing before an
operator meets it: a loosely-phrased question about the Florida rule scored
0.130 against a 0.15 relevance floor and was refused, while a tighter phrasing
of the same question scored 0.689 and returned the correct effective-dated
document. Both behaviours are correct — the floor is doing its job — but it
means an operator can be refused for phrasing rather than for absence of
authority, and will not be able to tell the two apart from the message.

Three things follow:
- Retrieval quality belongs in the evaluation harness so the floor is set from
  measured recall on real questions rather than from intuition.
- The refusal message should eventually distinguish "nothing relevant exists"
  from "nothing cleared the floor", because the operator's next action differs.
- This is the strongest single argument for adding hybrid retrieval, and the
  evidence for that decision should be measured rather than assumed.

### L4. Integration ports are designed against assumptions

We do not know MVW's internal systems. The ports in `integrations/` are narrow
and clearly commented as requiring confirmation. **They are almost certainly
wrong in detail.** Do not treat them as a specification MVW must meet; treat
them as a starting point for a conversation with each system's owner.

### L4b. The screens have not been migrated onto the design system

The design system in `packages/console/src/ui/` — primitives, surfaces, domain
components, the command palette — was built to `docs/design/design-spec.md`
from scratch, is demonstrated at `/design`, and is exercised by that gallery
and its tests. **The seventeen screens an operator actually reaches do not use
it.** They use the older `src/components/` set and are styled by
`src/screens.css`, which takes its values from the same tokens and therefore
gets theme, density, and transparency right, but is a second implementation of
button, badge, callout, field, dialog, and table.

Two consequences worth knowing before planning the work:

- The two layers share one CSS namespace. Three names had already collided
  (`pv-table`, `pv-table-numeric`, `pv-table-sort`) and, with both stylesheets
  loaded, `display: flex` from the library's virtualised grid was landing on
  the shipped tables' `<table>` elements. The shipped table was renamed to
  `pv-dt-*`. Nothing enforces that the next collision gets caught, and a
  collision presents as a broken layout rather than as a failure.
- Screen behaviour is well covered by tests and screen *appearance* is not.
  What `screens.test.ts` checks is that the stylesheet obeys its own rules —
  tokens only, no blur on a repeating element, decorative layers removed under
  reduced transparency. Nothing asserts that a panel looks like the panel in
  the specification. There are no visual-regression snapshots.

Migrating view by view is the work, and it is the largest single item on this
list. Doing it removes `src/components/` and `src/screens.css` entirely.

### L4c. Filter state is not in the URL

`docs/design/design-spec.md` §3.1 requires that every filter state encode into
the URL, so a view can be pasted into a ticket. The server side is built for
it — `parseWorkQueueQuery` reads every filter, saved view, and sort from the
query string and refuses unknown values rather than ignoring them. The console
does not use it: the work queue's filters are component state, so a filtered
view cannot be shared and the browser's back button does not undo a filter.

### L4d. Five of the six performance budgets are not measured

`docs/design/design-spec.md` §7 asks for six budgets "enforced in CI": route
change under 100ms, interaction-to-next-paint under 200ms at p95, zero
cumulative layout shift on the hot paths, skeletons only past 300ms, typing
never blocked past 120ms, and ten thousand rows without jank.

**One is enforced.** `tools/check-bundle-budget.mjs` holds the console's
transfer size to 190KB of gzipped JavaScript and 24KB of CSS, and fails the
build over either. It currently measures 159.4KB and 17.7KB. That number bounds
the other five from below and substitutes for none of them.

The other five need a running browser under a throttled network, and there is
no harness for that. Two things are worth knowing before building one:

- **The shipped table does not virtualise.** `components/DataTable` renders one
  `<tr>` per row, so the ten-thousand-row budget is not met — it is not close.
  The virtualised grid exists in `ui/surfaces/Table` and is the one the design
  gallery demonstrates; this is the same L4b migration seen from the
  performance side rather than the appearance side.
- **The design gallery ships in the operator's bundle.** `routes.tsx` imports
  `DesignGallery` statically, and it is the single largest module in the build.
  It is a developer surface an operator never opens. A `React.lazy` boundary
  around that one route is the cheapest performance win available here and is
  not taken in this change because it touches routing, which is well covered by
  tests that would need reading first rather than adjusting.

### L5. Accessibility automation covers about half of WCAG

Automated axe assertions run on every console view and fail CI. They do not
catch a valid-but-confusing focus order, an unclear label, or a live region that
announces at the wrong time. Manual keyboard-only and screen-reader passes are
still required and have not been performed.

### L6. No on-call rota

Every alert has a runbook — the platform's half of the arrangement. The rota,
paging, and escalation are MVW operational decisions and are not established.

### L7. Document output formats are text and HTML only

PDF and DOCX have a commented seam and no implementation, because the formats
MVW actually uses for owner letters, disclosures, board packs, and association
reporting have not been confirmed. Guessing would mean building the wrong thing
and adding dependencies for it.

### L8. Cost figures are from the fake provider

Cost accounting is real and correct in mechanism. The numbers currently come
from the deterministic fake provider's synthetic token counts. Cost per case is
not yet a real measurement.

### L9. Spanish support is not built

Whether owner-facing or staff-facing surfaces need Spanish is an open question.
Nothing in the console is internationalised, and retrofitting is cheaper than
guessing wrong now — but it is not free, and the answer should come early.

### L10. No transactional outbox

External effects rely on idempotency keys rather than a record-then-deliver
outbox (ADR 0007). Adequate for the first workflows, which read from systems of
record rather than write to them. Revisit before any workflow writes to a system
of record.

### L11. Every connector an external agent can reach is a fake

The governed-execution path is real: admission, digest binding, the human
approval, the two-phase commit, the indeterminate state. What sits behind it is
the same seeded fake the rest of the platform uses, because nobody on this
project has seen MVW's systems of record. Registering a real connector is a
small amount of code and a large amount of confirmation — the operation names,
the request shapes, whether the downstream system honours an idempotency key —
and until that happens, the "platform performs the action on the agent's behalf"
capability is exercised against a stand-in.

### L12. The connector switchboard is per-process

An operator disabling a connector disables it on the worker that served the
request. In a multi-process deployment the others find out at their next
restart. The interface exists so the deployment can back it with the operating
record and have the switch take effect everywhere; that has not been done, and
until it is, "connector disabled" is a single-process guarantee. Note that the
per-agent controls do *not* share this limit — containment, revocation, and the
spend meters are all in the database and take effect immediately across workers.

### L13. An external agent between heartbeats is not yet stopped

The kill switch is the heartbeat reply, because an agent running on somebody
else's infrastructure cannot be reached any other way. That means the time
between a containment and the agent's next beat is time in which it is still
working. The reclaim window bounds it and is configurable, but it cannot be
reduced to zero, and it is worth stating plainly to anyone who reads "instant"
into the word *stop*. What *is* immediate is that everything the agent asks for
*through the admission chain* is refused — including the commit of a write a
human had already approved. The two calls that do not pass through it are named
in L13a.

### L13a. Revocation takes effect at the agent's next contact, and two calls stay open to a revoked agent

The revocation approval used to be described to the human approving it as
stopping the agent "immediately, including any runs in flight, which are
reclaimed rather than left open," with its "credentials stop verifying at the
next admission check." Two of those three claims were false, and the guidance
(`external_agent.revoke` in `packages/platform/src/external/enrollment.ts`) has
been corrected to the bound the platform actually holds.

**What.** `EnrollmentService.revoke` holds no run store, so it cannot touch a run
already in flight. The moment after a revocation returns, the external run and
its operating-record twin are both still `running`. If the agent keeps
heartbeating, the next beat returns `stop` and both halves close; if it never
beats again, the run stays open until the `external.reclaim_stale_runs`
maintenance pass closes it — roughly the reclaim window plus a loop interval, and
only when a separate `pv worker` process is deployed (`pv serve` alone never
reclaims). Separately, credential verification never consults enrollment status,
and `POST /api/external/runs/:id/finish` runs no admission check, so a revoked
agent can still authenticate and close its already-open run as `succeeded` with a
self-declared cost — moving its spend meter after revocation — and can still poll
its own approvals. New work is refused: every admission-chain call after
revocation is denied, and a new run cannot be started.

**Why it matters.** An agent runs on the vendor's infrastructure, which this
platform cannot reach into; "stop in flight" for such an agent has a floor it
cannot go below. The honest description is that revocation is *terminal* — the
seat returns, the enrollment never revives, new work is refused — and takes
effect at the agent's next contact, not that it reaches out and halts a running
process.

**Decision taken.** The smaller, correct fix: the overstated approval guidance
was corrected and this residual recorded, rather than wiring a run store,
credential revocation and a synchronous reclaim into `revoke` — a cross-cutting
change that still could not stop a remote process between beats. Closing the two
carve-outs (an admission check on run-finish; enrollment status consulted by
credential verification) is a bounded follow-up that would make "refused after
revocation" total rather than near-total.

### L14. Seats are counted, not attributed

The seat cap is enforced atomically at enrollment, which is the property that
matters commercially. But seats are a counter rather than a column on the agent
row, so the count and the roster are two facts that could in principle disagree
after a partial failure. Nothing observed this, and the enrollment service
returns a seat on every failure path — but a counter that can drift is worth
knowing about before somebody reconciles a bill against it.

### L16. Governed execution does not move the agent's spend meter

An agent's spend meter is fed by the reports it files. Actions the platform
performs on its behalf are recorded on the operating record, but they add
nothing to the meter, because no connector reports what a call cost and the
platform will not invent a figure. The consequence is bounded rather than open:
an agent already at its ceiling is refused everything, execution included, so
the ceiling still stops it — it just is not moved *by* execution.

Closing this needs a decision that is MVW's, not ours: whether a governed call
should be charged at a per-operation rate, at whatever the downstream system
reports, or not at all because the cost lives in a contract somebody else
signed. Until that is answered, an operator reading a cost figure should know
it covers what agents reported, plus native work, and not the platform's own
outbound calls.

### L15. The audit chain grows with read traffic

Every authorization decision is recorded, including grants for routine reads.
That is the stronger compliance position — "who read this owner's record" is a
question an auditor asks — but it means chain length tracks console usage, not
just work done, and verification cost is linear in chain length.

Plan for it: verify a window on demand and the full chain on a schedule. The
consequence and the options are set out in
`docs/ops/observability-and-cost.md`.

### L17. Explicit integration degradation is built and never invoked

`integrations/degrade.ts` documents "queue, park for a human, or refuse" as the
policy for an integration that is failing, and `DegradationHandler` is
constructed nowhere outside its own tests. What actually happens when a system of
record returns 500 is that the egress client throws and the caller propagates —
an explicit failure, which is the right direction, but not the queueing or
parking the module describes. Wiring it means each call site choosing its policy,
which is a decision per integration rather than one change.

### L18. `EST` and `Etc/GMT+5` are still accepted as recipient timezones

Quiet hours are measured on the recipient's clock, and a bare offset (`-05:00`)
is now refused because it is wrong twice a year. `EST` and `Etc/GMT+5` are the
same fault wearing an IANA-shaped name: `EST` reads 11:00 when New York is at
12:00, which is the direction that permits a call inside the quiet window. They
are still accepted, because every clean predicate that rejects them (require a
`/`; reject `Etc/*`) also rejects legitimate single-part zones like `Singapore`,
`Japan` and `Iceland`. A curated deny-list of the abbreviation aliases would
work and is a data decision. No shipped policy row uses one.

### L19. A truncated model answer is recorded as a complete one

The provider parses `stop_reason` and acts only on `"refusal"`. A response cut
off at `max_tokens` returns its partial text, and `invoke` records a succeeded
step and hands that text back. For a product that drafts consumer notices, a
silently truncated answer is meaningful. The same applies to a well-formed
response with an empty `content` array, which yields `text: ""` recorded as a
success. What it should do instead — refuse, or flag on the record — is a
product decision, which is why it is here rather than fixed.

### L20. A green test run does not mean both store adapters were exercised

The persistence contract suites are gated on `PV_TEST_DATABASE_URL`. Without it,
158 assertions are skipped — every concurrency case, the append-only triggers,
the store-unavailable refusals — and the run still ends green. CI always sets it;
a developer's laptop often does not. The run now prints which adapters it
covered, but the summary line still says "passed". A defect where the in-memory
fake was quietly *more permissive* than Postgres has already been found once
here, so a local green is a partial result and should be described as one.

Separately: two full-suite runs sharing one `PV_TEST_DATABASE_URL` destroy each
other, because both contract suites `TRUNCATE` shared tables to isolate. The
failures are numerous and convincing, which is how a real failure gets
misclassified as infrastructure. Run one suite at a time against a given
database.

---

## How to use this list

- **Nothing ships to production while any B item is open.** B2 is enforced in
  code: the configuration loader refuses the fake model provider outside
  development.
- S items are what a security assessment will find. Closing them before the
  assessment is cheaper than closing them after.
- L items are conscious trade-offs. Each has a documented reason, and each
  should be revisited when its assumption changes.
- When an item is closed, update it here with the date and the evidence — not
  by deleting the line, but by recording what was done. A list that only ever
  shrinks loses the history of what was considered.
