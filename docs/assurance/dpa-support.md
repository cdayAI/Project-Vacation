# Data processing agreement — supporting facts

**Last reviewed:** 2026-08-06.

> Legal owns the contract. This document supplies accurate facts for it and
> nothing else. Where a fact is not yet determined, it says so rather than
> offering a plausible placeholder — a DPA schedule populated with guesses is
> worse than one with an open item, because the guess gets signed.

---

## 1. Processing

**Nature and purpose.** Governed automation of vacation-ownership operations:
statutory rescission compliance checking, association reporting, owner-services
support, and document generation — each performed under human oversight with a
tamper-evident record.

**Categories of data subjects.** Vacation ownership owners; exchange members;
association board members; MVW employees (identity records, and — only if the
feature is ever enabled — work-discovery observations).

**Categories of personal data.** See `data-inventory.md`. Summary: staff
identity and directory-derived roles; owner consent and revocation history with
provenance; outbound message records; generated document content where a
workflow requires it; opaque subject references throughout.

**Special-category data.** None processed. The platform does not collect or
infer health, biometric, racial or ethnic, political, religious, trade-union, or
sexual-orientation data. Protected-class attributes appear **only** in synthetic
fixtures used by the bias-testing harness, never from real subjects.

**Card data.** None, ever. Deliberately outside PCI scope (ADR 0009).

**Duration.** For the term of the agreement, subject to the retention periods in
`retention-and-deletion.md`.

---

## 2. Subprocessors

| Subprocessor | Purpose | Data | Location |
| --- | --- | --- | --- |
| Cloud infrastructure provider | Hosting, managed Postgres, object storage | All platform data | **To be determined — see §5** |
| Model provider | Model inference | Screened and redacted task input only | **To be determined** |

The list is short by design. Adding one is a reviewable change with a data-flow
consequence, not a configuration detail.

**Not subprocessors:** MVW's identity provider and MVW's systems of record are
MVW's own systems, not ours.

---

## 3. Technical and organisational measures

**Encryption.** TLS in transit. At rest, provider-managed keys at the database
and object-storage layers; keys are not co-located with backups.

**Access control.** OIDC single sign-on, no local password store; role-based
access from directory groups; step-up re-authentication for high-consequence
actions; individually revocable service accounts. The platform administrator
cannot alter audit entries — no code path, plus a database trigger.

**Data minimisation, enforced in code.** The audit log stores digests and
refuses payload-shaped content. Redaction runs before every log write and every
model call. Integration ports request the narrowest field set required.

**Pseudonymisation.** Subject references are opaque identifiers. Inputs to
decisions are recorded as digests.

**Integrity.** Hash-chained append-only audit log, verifiable from an export
with no access to our systems.

**Resilience.** Fail-closed design; graceful degradation; documented RTO 4 hours
and RPO 15 minutes — **not yet validated by exercise**.

**Testing.** CI runs the full suite against both persistence adapters, secret
scanning over full history, dependency scanning, SBOM generation, a determinism
gate, and a model-quality gate. **No penetration test has been performed.**

---

## 4. Breach notification

**Detection.** Structured logging with correlation ids; alerting on denial-rate
spikes and on audit-verification failure; daily chain verification.

**Assessment.** `docs/ops/incident-process.md`. The blast-radius query returns
every run, document, message, and subject reference associated with a given role,
model, or prompt version — so "who was affected" is a query, not a
reconstruction.

**Notification.** MVW is notified without undue delay upon becoming aware.
**The specific hour figure is a contractual term for legal to set**; the platform
can meet a short one because the affected-subject determination is automated.

**Evidence.** The audit chain provides an independently verifiable record of
what was accessed or produced, and by which actor.

---

## 5. Open items — required before a DPA can be completed

These cannot be answered by engineering:

1. **Deployment cloud and region**, and any data-residency constraint. Determines
   the subprocessor list, transfer analysis, and where every data category
   physically lives.
2. **Model provider identity**, and **written confirmation of zero data
   retention and no training on MVW data.** Until this exists, no production
   model call should be made.
3. **Whether European owners or members are in scope.** Determines GDPR
   applicability, transfer mechanism (SCCs or an adequacy decision), and the EU
   AI Act assessment.
4. **Retention periods confirmed by MVW legal** for the audit chain, consent
   records, and outbound message records. Current figures are engineering
   defaults.
5. **Breach notification window** as a contractual term.
6. **Whether work discovery is ever in scope.** If yes, employee monitoring
   obligations attach and the DPA needs an employee-data schedule.
