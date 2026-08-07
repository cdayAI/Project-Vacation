# Data inventory and flow map

**Purpose:** what personal data the platform holds, where it goes, who can see
it, and how long it is kept.
**Audience:** MVW privacy, legal, and security; and whoever answers a
subject-rights request or a DPA schedule.
**Last reviewed:** 2026-08-06.

**Standing design position:** the platform is a *governance* layer, not a
system of record. It holds references and fingerprints wherever it can, and
copies of owner data only where a workflow genuinely requires them. That is why
several rows below say "reference only" — it is a deliberate architectural
choice, not an accident of what has been built so far.

---

## 1. Categories held

| # | Category | Examples | Personal data? | Where | Retention |
| --- | --- | --- | --- | --- | --- |
| D1 | Operating record — runs and steps | run kind, status, timestamps, cost, input/output **digests** | No (references only) | Postgres `runs`, `steps` | Per §3 |
| D2 | Audit chain | decisions, actor ids, subject **references**, input **digests** | Pseudonymous (actor ids) | Postgres `audit_entries` | 7 years (configurable) |
| D3 | Subject references | contract id, association id, membership id | Pseudonymous | Throughout | With their run |
| D4 | Staff identity | actor id, IdP subject, email, display name, group-derived roles | **Yes — employee** | Postgres `actors`, `sessions` | Life of employment + 90 days |
| D5 | Consent and revocation | channel, purpose, grant/revoke events, provenance, timestamps | **Yes — owner** | Postgres `consent_events` | 7 years after relationship ends |
| D6 | Outbound messages | recipient reference, channel, template version, gate evidence digest, send outcome | **Yes — owner** (by reference) | Postgres `outbound_messages` | 7 years |
| D7 | Generated documents | template version, data digest, approver, output digest; body only where the workflow requires it | **Yes where a body is stored** | Postgres `generated_documents` | Per document class, §3 |
| D8 | Knowledge corpora | statutes, HOA governing documents, SOPs, templates, with provenance | Normally no | Postgres `chunks`, `documents` | Until superseded + 7 years |
| D9 | Model invocations | task, resolved model, prompt **digest**, response **digest**, tokens, cost | No | Postgres `model_invocations` | 2 years |
| D10 | Improvement observations | run reference, failure pattern, correction **digest** | Pseudonymous | Postgres `observations` | 2 years |
| D11 | Work-discovery observations | application transitions and timing only | **Yes — employee** | Postgres `discovery_observations` | **Feature disabled.** Hard ceiling if enabled: 30 days |
| D12 | Operational logs | structured logs, correlation ids | Pseudonymous after redaction | Log sink | 90 days |
| D13 | Backups | encrypted snapshots of the above | Inherits | Object storage | 35 days |

**Never held, anywhere:** primary account numbers, expiry dates, CVV, or track
data (ADR 0009). Enforced by the absence of any card field, by Luhn-checked
redaction, and by the audit log refusing PAN-shaped content — as text and as a
JSON number, since a card number written as `4111111111111111` rather than
`"4111111111111111"` is the same card number.

---

## 2. Flows and recipients

| Flow | Data | Recipient | Basis / control |
| --- | --- | --- | --- |
| Staff sign-in | D4 | MVW identity provider | MVW's own system; OIDC, no password store here |
| Systems-of-record reads | D3, and the minimum owner fields a workflow needs | MVW systems | Host allowlist, scoped credentials, recorded step |
| Model invocation | Screened, redacted task input | Model provider (external) | Redaction before egress; models declare whether they may see owner data; **zero-retention and no-training terms must be contractually confirmed and recorded before production use — currently open** |
| Outbound owner contact | D6 | MVW's messaging systems | Single contact gate: consent, revocation, do-not-call, quiet hours, frequency cap — evidence recorded with the message |
| Audit export | D2 | MVW auditors, regulators on request | Digests only; no payloads |
| Backups | D13 | Cloud object storage | Encrypted at rest with managed keys |

**Subprocessors** are listed in `dpa-support.md`. The list is short by design,
and adding one is a reviewable change, not a configuration detail.

---

## 3. Retention

Two of these periods are enforced by a job that runs — D10 and D11 — and the
rest are policy the code does not yet discharge. `retention-and-deletion.md` §2
describes the mechanism and §5 names every row that is not yet enforced and what
each is waiting on. The **Enforced** column below says which is which, so this
table cannot be read as a claim it does not make.

`PV_AUDIT_RETENTION_DAYS` is the deployment's overall period: it clamps every
rule below and can only shorten one, never lengthen it. It does not cause the
audit chain to be pruned — nothing does, and `retention-and-deletion.md` §3
explains why the platform must not.

| Data | Retention | Enforced | Why this figure |
| --- | --- | --- | --- |
| Audit chain (D2) | 7 years, `PV_AUDIT_RETENTION_DAYS` | Kept, never pruned | Aligns with consumer-lending record-keeping norms. **MVW legal must confirm**; this is an engineering default, not legal advice |
| Operating record (D1) | `PV_AUDIT_RETENTION_DAYS` | No — §5 there | Kept with the audit chain so evidence stays coherent |
| Consent (D5) | 7 years after the relationship ends | No — §5 there | Consent evidence must outlive the contact it authorised |
| Outbound messages (D6) | 7 years | No — §5 there | Contact-compliance evidence |
| Model invocations (D9) | 2 years | No — §5 there | Cost and quality analysis; no evidentiary requirement beyond the audit entry |
| Improvement observations (D10) | 2 years | **Yes** | Quality trend analysis |
| Staff identity (D4) | Employment + 90 days | No — §5 there | Investigation window after departure |
| Discovery observations (D11) | 30-day hard ceiling, default 7 | **Yes** | Short by design; the shortest window that supports sequence mining |
| Logs (D12) | 90 days | Sink-side | Operational need only |
| Backups (D13) | 35 days | Sink-side | Covers the documented RPO with margin |

---

## 4. Access

| Role | Sees | Cannot |
| --- | --- | --- |
| `owner_services_agent` | Runs and tasks in their queue; owner data in scope for those | See other queues; approve; change configuration |
| `supervisor` | Their team's queues, workflow instances, costs | Approve high-consequence actions outside their scope |
| `compliance_reviewer` | Audit and evidence views, contact-gate evidence, citations | Change roles, prompts, or configuration |
| `association_manager` | Association data within their assigned scope | Other associations |
| `finance` | Cost reporting, aggregate metrics | Owner personal data |
| `platform_admin` | Configuration, roles, containment controls | **Cannot alter audit entries** — no code path, and a database trigger blocks it |
| `auditor` | **Everything, read-only** | Change anything at all |

Access follows the HR lifecycle through directory-group provisioning: a
departing employee loses access when their group membership is removed. Data
scope is enforced at the port boundary rather than in each caller, so it cannot
be forgotten by a new call site.

---

## 5. Data minimisation, enforced in code

Not aspirational — these are the specific mechanisms:

1. The audit log stores digests. `AuditLog.record` **refuses** a non-digest in
   `inputDigests`, an over-length subject value, a nested payload in
   `decision`, or anything the secret detector recognises.
2. Redaction runs before any log write and before any model call.
3. Subject references are opaque ids, capped in length.
4. Integration ports request the narrowest field set a workflow needs, and the
   port shape is the enforcement.
5. Work-discovery observations structurally cannot hold excluded fields, and a
   runtime validator rejects unexpected keys.

---

## 6. Open questions for MVW

These block a complete inventory and are on the consolidated question list:

1. **Deployment region and any data-residency constraint.** Determines where
   D1–D13 physically live, and whether European owner data may be processed in
   the same deployment.
2. **Whether European owners are in scope**, which determines GDPR
   applicability including subject rights, transfer mechanism, and the EU AI Act
   assessment.
3. **Confirmed retention periods** from MVW legal for D2, D5, and D6.
4. **Which owner fields the first workflow genuinely needs** from each system of
   record. Until that is known, the integration ports are deliberately narrow
   and may be too narrow.
5. **Model provider terms** — zero retention and no training on MVW data,
   in writing.
