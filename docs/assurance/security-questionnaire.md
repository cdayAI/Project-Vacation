# Security questionnaire — pre-answers

**Shape:** SIG Lite / CAIQ. **Last reviewed:** 2026-08-06.

Pre-written answers to the questions procurement and third-party risk reliably
ask. Where the honest answer is "not yet", it says so — a questionnaire response
that overstates is discovered during the assessment, and costs more than the
delay it avoided.

**`[MVW]`** marks an answer that depends on MVW's deployment environment rather
than on this codebase.

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

**B.1 How is authentication performed?**
OIDC single sign-on against the customer's identity provider, authorization-code
flow with PKCE. **There is no local password store.** ID-token signature,
issuer, audience, and expiry are all verified.

**B.2 Is multi-factor authentication supported?**
Enforced by the customer's identity provider. The platform additionally requires
**step-up re-authentication** for high-consequence actions — approving a role
promotion or an improvement proposal, issuing credentials, exporting owner data.

**B.3 How is authorisation managed?**
Role-based, with roles derived from directory groups. Every action passes one
authorization chokepoint and must be registered with an explicit risk tier;
unregistered actions are refused rather than assumed harmless. Data scope is
enforced at the persistence boundary.

**B.4 How is access revoked?**
Directory-group removal removes access, so it follows the HR lifecycle. Service
accounts are individually revocable and revocation is immediate.

**B.5 Is there a privileged-access model?**
Yes, and with a specific property worth noting: **the platform administrator
cannot alter audit entries.** There is no code path, and a database trigger
blocks UPDATE and DELETE on the audit table. The auditor role sees everything
and can change nothing.

**B.6 Is access reviewed periodically?** `[MVW]` — the platform provides the
role and entitlement report.

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
Yes, and it is enforced by a scheduled job whose runs are recorded in the audit
chain, not by policy alone. `retention-and-deletion.md`.

**C.8 Can data be deleted on request?**
Yes. `subject-rights-runbook.md`. The audit chain does not need to be modified,
because it holds digests and opaque references rather than owner data.

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

**D.4 Is an SBOM produced?** Yes, CycloneDX, on every build, retained 90 days.

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
Yes, with severity levels, containment procedures, and a specific procedure for
**what to do when the AI is wrong**, including how to find every action a bad
model or prompt version touched.

**E.2 Are backups performed and tested?**
Backup procedure and a restore-drill procedure are documented. **The drill has
not been executed**, because there is no deployed infrastructure. This is a
named gate.

**E.3 Is there a disaster recovery plan?**
Documented with RTO 4 hours (1 hour for read-only evidence access) and RPO 15
minutes. **The failover has not been exercised.**

**E.4 Is capacity managed?**
**Load testing has not been performed and the capacity ceiling is unknown.** A
known constraint is documented: the model-call rate window is per-process and
must move to shared storage before horizontal scaling.

**E.5 Is there monitoring and alerting?**
Structured logs with correlation ids, metrics, traces, and dashboards.
**Every alert that pages has a runbook.** `[MVW]` for the backend and the rota.

**E.6 Is there logging of security events?**
Yes — every authorization decision, grant and denial alike, in a hash-chained,
independently verifiable log.

---

## F. AI-specific

Increasingly asked, and where this platform is strongest.

**F.1 Which models are used and how are they governed?**
Resolved from configuration by logical task name; never hard-coded. The model
inventory records version, purpose, fallback chain, cost, and whether the model
may see owner data. Changing a model is a reviewable change that re-runs
evaluation.

**F.2 Is customer data used to train models?**
No. The platform does not train models. Provider terms confirming zero retention
and no training **must be contractually recorded before production use — open.**

**F.3 How is output quality assured?**
Human-curated golden sets with a CI gate; a regression below threshold fails the
build. Golden sets are protected: a change may add cases, never weaken,
relabel, or delete one.

**F.4 Is there human oversight?**
Yes, by risk tier and written down. Autonomy is earned on a ladder — shadow,
assisted, supervised, bounded autonomy — enforced by the authorization
chokepoint rather than by convention. Where an outcome could be adverse to a
consumer, the human is the decision-maker and the system is the
evidence-gatherer.

**F.5 Can the system modify its own behaviour?**
**No.** The improvement loop proposes changes to declarative artifacts only —
never to source — and cannot apply anything without a recorded human decision.
**There is no configuration that disables that gate**, and the tests attempt
every plausible bypass.

**F.6 Is bias tested?**
A harness exists and runs on synthetic fixtures. **Real fairness testing
requires customer compliance engagement before any consumer-affecting workflow
goes live**, and is not claimed to be complete.

**F.7 Is the EU AI Act applicable?**
Assessed in `eu-ai-act-assessment.md`, pending confirmation of whether European
owners are in scope. Two capabilities are potential Annex III high-risk: any
credit-adjacent workflow, and employee work discovery — which ships disabled.

**F.8 Can AI decisions be explained and audited?**
Yes. Every decision is in the hash-chained log with the fingerprints of its
inputs. Statutory deadline computations carry their full derivation. Grounded
answers carry citations with source, version, and effective date that a reviewer
can click through to.
