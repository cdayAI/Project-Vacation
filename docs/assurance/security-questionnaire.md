# Security questionnaire — pre-answers

**Shape:** SIG Lite / CAIQ. **Last reviewed:** 2026-08-07.

Pre-written answers to the questions procurement and third-party risk reliably
ask. Where the honest answer is "not yet", it says so — a questionnaire response
that overstates is discovered during the assessment, and costs more than the
delay it avoided.

**`[MVW]`** marks an answer that depends on MVW's deployment environment rather
than on this codebase.

**`[SPECIFIED, NOT WIRED]`** marks an answer where the control is designed,
coded, and unit-tested, but no entry point reaches it, so no deployment gets the
benefit. These are the answers most likely to be discovered during an
assessment, and the marker exists so they are discovered here first. Five
answers below carry it: B.1, B.2, B.4, F.1, F.6.

**Read this before sending any of it.** Every answer was re-checked against the
source on 2026-08-07 — running the platform against a real Postgres 16 database
rather than reading the code — and **thirteen were wrong**. They are corrected
in place. `docs/review/buyers-gauntlet.md` §1 records what each of them used to
say, what was run to disprove it, and what a questionnaire answered from the old
text would have cost during an assessment.

The pattern across all thirteen was the same, and it is worth naming because it
will recur: **each described the design as though the wiring existed.** Nothing
here was invented. Every claim corresponds to real, tested code. What none of
them checked was whether anything calls it.

---

## A. Governance and risk

**A.1 Is there a documented information security programme?**
Partly. The platform ships a threat model, a vulnerability policy with
severity-based SLAs, an incident process, and architecture decision records. The
enterprise security programme is MVW's. `[MVW]`

**A.2 Is there a risk assessment process?**
Yes. `docs/assurance/threat-model.md`, STRIDE per trust boundary, reviewed on
any boundary change, any new integration or model provider, any change to
authorization or approval logic, and at minimum six-monthly.

**A.3 Are third parties assessed?**
The subprocessor list is short and each addition is a reviewable change. Model
provider data-handling terms — zero retention, no training on customer data —
**are not yet contractually confirmed**, and that is an open item.

**A.4 Is there a compliance certification (SOC 2, ISO 27001)?**
**No. The platform is not certified.** `docs/assurance/soc2-control-mapping.md`
maps the design to the Trust Services Criteria and identifies which criteria
depend on MVW's environment. It is a readiness map, not a claim.

---

## B. Access control

**B.1 How is authentication performed?** `[SPECIFIED, NOT WIRED]`
The design is OIDC single sign-on against the customer's identity provider,
authorization-code flow with PKCE, and **there is no local password store** —
that part is structural and true. `identity/oidc.ts` verifies ID-token
signature, issuer, audience, and expiry, and has its own tests.

**It is not connected to the HTTP surface.** No module outside `identity/`
imports it, there is no sign-in route, and `api/server.ts:179` never resolves a
session. The consequence is exact and was reproduced on a running deployment:
with `PV_OIDC_ISSUER` set — which the loader *requires* in staging and
production — every console API request is refused with
`authorization.action_not_permitted` / "No authenticated session". Without it,
staging and production refuse to start at all. So **no human being can sign in
to a deployment of this platform in any environment it is permitted to run in.**
The only working identity is a hard-coded development actor.

`PV_OIDC_CLIENT_ID`, `PV_OIDC_CLIENT_SECRET` and `PV_OIDC_REDIRECT_URI` are
mandatory in production and are read by nothing.

**B.2 Is multi-factor authentication supported?** `[SPECIFIED, NOT WIRED]`
Multi-factor itself is the customer's identity provider's job. `[MVW]`

Step-up re-authentication is a real control in the code and it **fails closed**:
`guard/authorize.ts:139-148` refuses when the age of the last authentication is
unknown, rather than assuming one happened. It is correct, and it is currently
load-bearing in the wrong direction. Nothing on any surface observes a
re-authentication — `api/server.ts:175` returns `undefined` by construction —
so the value is always unknown and the refusal always fires.

**Every one of the ten actions that requires approval also requires step-up, so
all ten are unreachable today.** Reproduced against a running deployment:
raising an enrollment approval succeeds, and granting it returns
`authorization.step_up_required`. The ten are `contact.send_owner_message`,
`document.generate_owner_facing`, `external_agent.enroll`,
`external_agent.revoke`, `identity.issue_service_credential`,
`improvement.apply`, `owner.delete_data`, `owner.export_data`, `role.promote`,
and `discovery.enroll_device`. The command line refuses to grant approvals by
design — it cannot verify who is running it — so the console is the only
granting surface, and it cannot authenticate anybody (B.1).

**B.3 How is authorisation managed?**
Role-based. Every action passes one authorization chokepoint
(`guard/authorize.ts`) and must be registered with an explicit risk tier;
unregistered actions are refused rather than assumed harmless. That part is
true, enforced, and heavily tested — it is the strongest control in the
codebase.

Two corrections to what this answer used to say:

*Roles are not yet derived from directory groups* — see B.1. Roles today come
from the development actor's fixed list.

*Data scope is enforced at the chokepoint, not at the persistence boundary.*
`guard/authorize.ts:122-136` checks `requiredScopes` against the actor's
`scope:` entitlements, and only when the caller declares them. **No store
filters any query by scope**, and no console read route declares a scope at all,
so a reader who reaches the console API reads every run in the deployment. The
declaring callers today are the workflow engine, the knowledge ingestion and
freshness paths, and the external-agent admission chain.

**B.4 How is access revoked?** `[SPECIFIED, NOT WIRED]` for people; **yes** for
service accounts.

Directory-group removal is the intended human path and follows the HR lifecycle,
but it depends on B.1 and is therefore unexercised. **Service-account revocation
is real and reachable**: `pv agents credential revoke` and `pv agents revoke`
both work from the command line today, only a hash of the credential is stored,
and revocation takes effect on the next admission check.

**B.5 Is there a privileged-access model?**
Yes, and it is the answer that survived verification best. **A platform
administrator cannot alter audit entries.** There is no code path — `AuditStore`
has no update or delete operation at all — and three database triggers
(`audit_entry_no_update`, `audit_entry_no_delete`, `audit_entry_no_truncate`)
refuse the statements. Verified against a live Postgres 16 database on
2026-08-07: `DELETE FROM audit_entry` returns *"audit_entry is append-only;
DELETE is not permitted on this table"*. The auditor role sees everything and
can change nothing, and the console draws no write controls for it.

**State the residual plainly, because an assessor will find it.** A trigger is
not a boundary against the database owner: anyone with `ALTER TABLE` can
`DISABLE TRIGGER USER`, delete, and re-enable. That path is *detected, not
prevented* — a durable high-water mark records the greatest sequence the chain
has ever reached, so deleting from the end is caught even though the surviving
prefix is internally consistent. Verified live: after disabling the trigger and
deleting the newest entry, `pv audit verify` reported *"[chain_truncated] seq 1:
The chain ends at sequence 1, and it is recorded as having reached 2. 1 entry
has been deleted from the end"* and exited non-zero. Prevention against a
database superuser requires write-once storage or an external notary; neither is
built, and neither is claimed.

**B.6 Is access reviewed periodically?** **No — the report does not exist.**
`[MVW]` for the review process itself, but the platform does not supply the
input. There is no user store, no way to create a user, and no entitlement
report. `pv actions list` prints the action registry — every action and its risk
tier — which is the *policy*, not who holds what. Until B.1 is wired there is
nobody to report on.

---

## C. Data protection

**C.1 Is data encrypted in transit?** Yes, TLS. `[MVW]` for termination and
cipher policy.

**C.2 Is data encrypted at rest?** `[MVW]` — managed keys at the database and
object-storage layer.

**C.3 Is customer data segregated?**
Single-tenant by design. **Multi-tenancy is deliberately not built** (ADR 0010).
A second customer would be a second deployment.

**C.4 Is cardholder data processed?**
**No, deliberately.** The platform never accepts, stores, transmits, or
processes primary account numbers and is designed to stay outside PCI DSS scope
(ADR 0009). Enforced by the absence of any card field, by Luhn-checked PAN
redaction before logging or egress, and by the audit log refusing PAN-shaped
content. Payment is handed off to the customer's payment systems by reference.

**C.5 What personal data is processed?** See `data-inventory.md`.

**C.6 How is data minimised?**
The audit log stores digests, not payloads, and actively refuses payload-shaped
content. Redaction runs before every log write and every model call. Integration
ports request the narrowest field set a workflow needs.

**C.7 Is there a data retention policy?**
Yes, and it is partly enforced rather than only written down. A job inside `pv
worker` applies two of the fourteen rules — the improvement loop's observations
and work-discovery observations — recording each purge in the audit chain before
it deletes anything. The other twelve are policy the code does not yet
discharge; `retention-and-deletion.md` §5 names every one of them and what each
is waiting on, and §1 marks which is which in a column. The audit chain itself is
never pruned, deliberately: §3.

**C.8 Can data be deleted on request?**
**No. Subject-rights handling is not built.** This answer previously said "yes"
and cited `subject-rights-runbook.md`; the runbook prescribes four commands —
`subject-rights record`, `export`, `delete`, and the opt-out verb — and **none
of the four exists.** There is no `subject-rights` verb in the command line at
all. The two audit event types the runbook says it writes,
`subject_rights.request_recorded` and `subject_rights.fulfilled`, are declared
in `audit/types.ts:73-74` and written nowhere. The two registered actions
`owner.export_data` and `owner.delete_data` have no caller, and both require
step-up, so they would be refused even if one existed (B.2).

What remains true is the *architectural* claim underneath it, and it is worth
keeping because it is what makes the obligation satisfiable at all: the audit
chain does not need to be modified to honour an erasure request, because it
holds digests and opaque references rather than owner data. That is a property
of the design, not a capability of the product.

**This is the first question a privacy reviewer asks and the first
demonstration they request.** It should be built before this document is sent to
anyone.

---

## D. Application security

**D.1 Is there a secure development lifecycle?**
CI runs typecheck, lint, the full test suite against both persistence adapters,
secret scanning over full history, dependency scanning, SBOM generation, a
determinism gate, and a model-quality evaluation gate.

**D.2 Is code reviewed?** `[MVW]` — branch protection is a repository setting.

**D.3 Is dependency scanning performed?**
Yes, on every build. High and critical fail the build; moderate and low are
reported and tracked. Remediation SLAs in `vulnerability-policy.md`.

**D.4 Is an SBOM produced?** Yes, CycloneDX, on every build, retained 90 days
as a build artifact.

**Do not send the `sbom.json` committed at the repository root.** It has drifted
from the lockfile — it lists 24 packages that are not installed — and nothing in
CI compares the two, so the drift is invisible and will recur. The SBOM CI
generates from a clean checkout is the accurate one. See finding F-31.

**D.5 Is secret scanning performed?**
Yes, over full history — a secret removed in the most recent commit is still a
secret.

**D.6 Are builds signed with provenance?**
**Not yet.** Specified in the definition of done and recorded in the
not-production-grade list.

**D.7 Has a penetration test been performed?**
**No.** `pentest-readiness.md` defines scope, test accounts, and known limits.

**D.8 How is injection prevented?**
Parameterised queries only; no string-built SQL. Template substitution is
literal, with no expression evaluation, and fails closed on a missing variable
rather than emitting an empty string into a legal document.

**D.9 How is untrusted input handled?**
Screened before it reaches a model or any instruction surface. **A screen that
errors denies** — it is never treated as clean. Detection is heuristic and is
explicitly not the load-bearing control: a model never holds tool authority its
calling role lacks, and every consequential action passes the chokepoint
regardless of what any model asked for.

---

## E. Operations

**E.1 Is there an incident response process?**
Partly. Severity levels, containment procedures, and the escalation path are
real, and containment genuinely works from the command line today — four scopes,
effective at the next action boundary, verified running.

**The "what to do when the AI is wrong" procedure does not execute as written,
and that is the procedure this answer used to lead with.** Of the four commands
`docs/ops/incident-process.md` prescribes, three do not exist: `roles history`,
`blast-radius` — which the document calls in bold *"the deliverable the rest of
the response depends on"* — and `improvement revert`. Each returns `Unknown
command`.

The fourth is worse than missing. `audit query --event-type model.invoked
--model <id>` runs, but **the command line silently ignores flags it does not
recognise**, and `--model` is one of them. Verified on a live deployment: adding
`--model bogus --not-a-real-flag zzz` to a query returned exactly the same rows
as the unfiltered query, with no warning. An incident responder computing a
blast radius from that output gets the whole log back and believes it is the
subset one model touched.

The underlying data does exist — `model_invocation` records the model and
version, and every step carries them — so this is a missing operator surface
rather than missing evidence. That is the honest distinction, and it does not
help anyone at three in the morning.

**E.2 Are backups performed and tested?**
The backup and restore procedures are documented, and the mechanical path works:
verified on 2026-08-07 by `pg_dump`, restore into a clean database, and then the
drill's own checks — migrations reported `17 applied, 0 pending, 0 unrecognised,
0 changed`, and the audit chain verified INTACT against the restored data.
Triggers survived the restore.

Two qualifications. **The drill has not been executed against real
infrastructure**, because there is none — a named gate. And
`backup-restore-and-dr.md` §4 presents `tools/restore-drill.sh` in a code block
as a runnable command; **that file does not exist**, which §7 discloses two
sections later. Anyone following §4 in order hits the failure before reading the
disclosure.

**E.3 Is there a disaster recovery plan?**
Documented with RTO 4 hours (1 hour for read-only evidence access) and RPO 15
minutes. **The failover has not been exercised.**

**E.4 Is capacity managed?**
**Load testing has not been performed and the capacity ceiling is unknown.** A
known constraint is documented: the model-call rate window is per-process and
must move to shared storage before horizontal scaling.

**E.5 Is there monitoring and alerting?**
Structured logs carry a correlation id on every line. **Every alert that pages
has a runbook, and every command in `docs/ops/runbooks.md` exists** — that was
checked verb by verb and the four that were missing were built rather than
deleted from the document (F-26). A test now fails if the two drift apart again.
The same check has not been applied to `incident-process.md`; see E.1.

Correct two overstatements. **No metrics are exported and no traces are
emitted.** `observability-and-cost.md` defines both, and §"Not built" says
plainly that the export wiring does not exist — but this answer listed "metrics,
traces, and dashboards" as though they did. `[MVW]` supplies the backend, and
the wiring to it is still to be written. And there is **no HTTP access log**:
only requests that throw are logged, so a request that is refused cleanly, or
served successfully, leaves no line to correlate (F-33).

**E.6 Is there logging of security events?**
Yes, and this one is stronger than most products can claim. **Every
authorization decision passes through one function and both outcomes are
written** — `authorization.granted` and `authorization.denied`, in the
hash-chained log, with actor, roles, action, risk tier, mode, correlation id,
and the refusal reason. Verified by reading every exit path of
`guard/authorize.ts`: there is no early return that skips the write.

Two residuals an assessor will ask about, both deliberate:

*A grant fails closed; a denial does not.* If the audit write fails while
granting, the grant becomes a denial — the action does not happen. If it fails
while denying, the failure is swallowed and the denial still propagates. So the
unlogged case is always "we refused and could not record that we refused", never
"we permitted and did not record it". That is the safe direction, and it means
denial logging is best-effort under audit-store failure.

*Command-line actions are attributed to `cli:unknown-operator`.* The command
line cannot verify who is running it, so it says so rather than inventing a
name. The record is honest and it is not attributable to a person — every
CLI-originated entry names the same actor. Attribution for operators depends on
B.1.

---

## F. AI-specific

Increasingly asked, and where this platform is strongest.

**F.1 Which models are used and how are they governed?** `[SPECIFIED, NOT
WIRED]` for the calling path; the governance itself is real.

Resolution is genuine: business logic names a logical task and never a model,
and an unknown task refuses rather than defaulting. The inventory records
version, purpose, fallback chain, cost, and whether the model may see owner
data. Changing a model is a reviewable source change.

State plainly what an assessor will otherwise infer wrongly: **no workflow calls
a model today.** `ModelGateway` is constructed in exactly two places, the
evaluation harness and `pv evaluate`. The seeded demonstration makes no model
call — the README says it does, and that is being corrected. In production terms
the model governance is a control over a path nothing currently takes.

**F.2 Is customer data used to train models?**
No. The platform does not train models. Provider terms confirming zero retention
and no training **must be contractually recorded before production use — open.**

**F.3 How is output quality assured?**
Human-curated golden sets with a CI gate; a regression below threshold fails the
build. Golden sets are protected: a change may add cases, never weaken,
relabel, or delete one.

**F.4 Is there human oversight?**
Yes — currently to the point of total blockage, which is the honest way to put
it. Autonomy is a ladder — shadow, assisted, supervised, bounded autonomy —
enforced by the authorization chokepoint rather than by convention, and shadow
mode really does refuse any action with an external effect rather than merely
labelling it. Where an outcome could be adverse to a consumer, the human is the
decision-maker and the system is the evidence-gatherer; all ten
consumer-affecting or privileged actions are `proposed_then_approved`, with
segregation of duties, digest binding, single use, and expiry.

The oversight gate is real, tested, and closed hard: per B.2, **no human can
currently pass through it**, because the approval surface cannot authenticate
anyone. An assessor should read this as "the control is present and the workflow
around it is unfinished", not as "the control is theoretical".

**F.5 Can the system modify its own behaviour?**
**No.** The improvement loop proposes changes to declarative artifacts only —
never to source — and cannot apply anything without a recorded human decision.
**There is no configuration that disables that gate**, and the tests attempt
every plausible bypass.

**F.6 Is bias tested?** `[SPECIFIED, NOT WIRED]`
A harness exists — `roles/bias.ts`, which computes group disparities and refuses
to run against anything but a synthetic fixture, deliberately, so fairness
analysis can never be pointed at real owner data. It is unit-tested.

**Nothing calls it.** `analyseFairness` has no importer outside its own module's
barrel export and its own test file. `pv evaluate --ci` does not run it, and
neither does the role-promotion path, so no build and no promotion produces a
fairness result. The previous answer's word "runs" was true only of the test
suite.

**Real fairness testing requires customer compliance engagement before any
consumer-affecting workflow goes live**, and is not claimed to be complete. This
is a regulator-facing claim (F.7, and brief §14) and it is the AI-specific
answer most likely to be probed.

**F.7 Is the EU AI Act applicable?**
Assessed in `eu-ai-act-assessment.md`, pending confirmation of whether European
owners are in scope. Two capabilities are potential Annex III high-risk: any
credit-adjacent workflow, and employee work discovery — which ships disabled.

**F.8 Can AI decisions be explained and audited?**
Yes for the audit half, and that half is the strong one: every decision is in
the hash-chained log with the fingerprints of its inputs, independently
verifiable from an export with no access to our database. Statutory deadline
computations carry their full derivation — the rule version, the citation, and
the arithmetic — and keep it after the window closes.

Two precisions on the explanation half. Grounded answers do carry citations with
source, version and effective date, and a claim without a citation is refused
rather than improvised — but retrieval is reached only by the seeded
demonstration, so no deployment produces one. "Click through to" describes a
console affordance; the console cannot be signed in to (B.1).

And the sentence that matters most to a regulator, stated once: **every
statutory rule this platform ships is unverified placeholder data**, marked
`verified: false`, and a deployment can now be configured to refuse rather than
compute from it. The derivation is trustworthy; the table it derives from has
not been checked against any statute by anyone.

---

## G. The backlog — what cannot be answered truthfully today

The method that produced this revision says the list of questions you cannot
answer honestly *is* the real backlog. It is reproduced here rather than in a
separate document, because the person who needs it is the person filling in the
next questionnaire.

Ordered by what blocks the most.

| # | Question | Truthful answer today | What unblocks it |
| --- | --- | --- | --- |
| 1 | **B.1** How do users authenticate? | Nobody can. OIDC is written and not connected; with an issuer set every request refuses, without one the platform will not start outside development. | Wire session resolution into the request path and add a sign-in route. Everything below marked † depends on this. |
| 2 | **B.2** Is step-up enforced? | The check is correct and unsatisfiable. All ten approval-requiring actions are refused. | Have the session supply a real authentication age. † |
| 3 | **C.8** Can data be deleted on request? | No. The four documented commands do not exist. | Build `subject-rights record / export / delete / opt-out`, and write the two declared audit events. |
| 4 | **B.6** Can you produce an entitlement report? | No. There are no users to report on. | † plus a user and role listing. |
| 5 | **E.1** Can you find everything a bad model touched? | No. Three of four commands do not exist and the fourth silently ignores its filter. | Build `blast-radius`; make the CLI reject unknown flags. |
| 6 | **F.6** Is bias tested? | The harness exists; nothing calls it. | Call it from `pv evaluate --ci` and from role promotion. |
| 7 | **F.1** Do models run under governance in production? | No workflow calls a model. | Compose a workflow that does. |
| 8 | **B.3** Is data scope enforced on reads? | Only where a caller declares it; console reads declare nothing. | Push scope into the store, or declare it on every read route. |
| 9 | **A.3 / F.2** Are provider terms confirmed? | Not contractually recorded. | A commercial action, not an engineering one. |
| 10 | **E.2 / E.3** Has the restore drill or failover been exercised? | No, and `tools/restore-drill.sh` does not exist. | Infrastructure, then the drill. Write the script or stop citing it. |
| 11 | **E.4** What is the capacity ceiling? | Unknown. Not load-tested. | Load test; MVW must supply the peak shape. |
| 12 | **D.6** Are builds signed with provenance? | Not yet. | Build-provenance attestation in CI. |
| 13 | **D.7** Has a penetration test been performed? | No. | Schedule one; `pentest-readiness.md` has the scope. |
| 14 | **A.4** Are you certified? | No, and will not be for the foreseeable future. | A SOC 2 Type II programme, measured in quarters. |

**Items 1 through 8 are engineering work inside this repository.** Items 9
through 14 are time, money, or MVW's environment. That split is the useful one
for planning: the first eight are the ones a delivery team can close, and until
at least 1, 2 and 3 are closed this questionnaire cannot be sent to a
third-party risk team without a covering explanation.

**One thing the assessment will get right that this document should not
undersell.** The controls that *are* wired are unusually good for a product at
this stage: one authorization chokepoint no action escapes, an append-only
hash-chained log with database-level enforcement and end-deletion detection,
digest-bound single-use approvals with segregation of duties, containment that
stops work already in flight, a boundary screen that fails closed, and refusal
as a first-class typed outcome. The gap is not between this and a well-built
product. It is between a well-built engine and a deployment somebody can log
in to.
