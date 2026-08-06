# What is not production grade

**Last reviewed:** 2026-08-06.

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

### B3. No restore drill has been executed

**What.** The backup and restore procedure is written and the drill is specified
(`docs/ops/backup-restore-and-dr.md`). It has never been run, because there is
no deployed infrastructure.

**Why it matters.** A backup you have never restored is a hope. For this
platform the drill has an extra step that matters more than the data coming
back: **the restored audit chain must verify.** A restore that returns data but
produces a chain that fails verification is a failed restore.

**What is required.** Execute the drill on real infrastructure, record the
result, and repeat monthly.

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
it. The archival job is not written. **Until it is, leave audit retention at its
default and prune nothing.**

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

### L11. The audit chain grows with read traffic

Every authorization decision is recorded, including grants for routine reads.
That is the stronger compliance position — "who read this owner's record" is a
question an auditor asks — but it means chain length tracks console usage, not
just work done, and verification cost is linear in chain length.

Plan for it: verify a window on demand and the full chain on a schedule. The
consequence and the options are set out in
`docs/ops/observability-and-cost.md`.

### L4. Integration ports are designed against assumptions

We do not know MVW's internal systems. The ports in `integrations/` are narrow
and clearly commented as requiring confirmation. **They are almost certainly
wrong in detail.** Do not treat them as a specification MVW must meet; treat
them as a starting point for a conversation with each system's owner.

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
