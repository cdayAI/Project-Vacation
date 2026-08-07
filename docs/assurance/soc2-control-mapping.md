# SOC 2 control mapping

**Last reviewed:** 2026-08-06.

> **This is a readiness map, not a certification claim.** Project Vacation is
> not SOC 2 certified and this document does not assert that it is. It maps the
> platform's design to the Trust Services Criteria, states which criteria the
> platform's design satisfies, and — importantly — which depend on MVW's own
> environment and processes rather than on this code. An auditor would examine
> the combination; neither half is sufficient alone.

**Criteria in scope:** Security (Common Criteria), Availability,
Confidentiality, Processing Integrity. Privacy is mapped separately in
`data-inventory.md` and `subject-rights-runbook.md` — note that the latter is a
specification and not a capability: no subject-rights command exists (B7).

**Legend:**
`Platform` — satisfied by this codebase.
`Shared` — the platform provides the mechanism, MVW operates it.
`MVW` — depends entirely on MVW's environment; the platform contributes nothing.
`Gap` — not satisfied today. Every gap also appears in the not-production-grade list.

---

## Common Criteria

### CC1 — Control environment

| Criterion | Status | Evidence |
| --- | --- | --- |
| CC1.1 Integrity and ethical values | MVW | MVW policy |
| CC1.2 Board oversight | MVW | MVW governance |
| CC1.3 Structure and authority | Shared | Role model matches MVW's functions: owner-services agent, supervisor, compliance reviewer, association manager, finance, platform admin, auditor (`identity/roles.ts`) |
| CC1.4 Competence | MVW | Hiring and training; platform contributes handover documentation |
| CC1.5 Accountability | Platform | Every action attributable to an actor in the audit chain; segregation of duties on approvals |

### CC2 — Communication and information

| Criterion | Status | Evidence |
| --- | --- | --- |
| CC2.1 Quality information | Shared | Operating record and audit chain, both carrying the caller's correlation id. **Not the logs:** there is no HTTP request log and no metrics are emitted (S9, S9a) — a successful request writes no log line at all |
| CC2.2 Internal communication | Shared | Console surfaces queues, breaches, and denials; escalation paths are MVW's |
| CC2.3 External communication | MVW | MVW customer and regulator communication |

### CC3 — Risk assessment

| Criterion | Status | Evidence |
| --- | --- | --- |
| CC3.1 Objectives specified | Platform | SLOs in `docs/ops/slos.md` |
| CC3.2 Risk identification | Platform | `threat-model.md`, reviewed on boundary change and at least six-monthly |
| CC3.3 Fraud risk | Platform | Segregation of duties, digest-bound approvals, replay-resistant single-use consumption (ADR 0005) |
| CC3.4 Change risk | Platform | Role promotion requires evidence; model and prompt changes re-run evaluation; improvement loop cannot apply without human approval (ADR 0011) |

### CC4 — Monitoring

| Criterion | Status | Evidence |
| --- | --- | --- |
| CC4.1 Ongoing evaluation | Platform | Golden-set evaluation gate in CI; post-change quality watched against baseline (`improve/watch.ts`) |
| CC4.2 Deficiency communication | Shared | Alerts page a human with a runbook per alert; MVW operates the rota |

### CC5 — Control activities

| Criterion | Status | Evidence |
| --- | --- | --- |
| CC5.1 Control selection | Platform | Risk tier per action, declared explicitly; unregistered actions refused (`guard/registry.ts`) |
| CC5.2 Technology controls | Platform | One authorization chokepoint every action passes (`guard/authorize.ts`) |
| CC5.3 Policy deployment | Shared | Human-in-the-loop policy by risk tier encoded in the registry; policy values are MVW's |

### CC6 — Logical and physical access

| Criterion | Status | Evidence |
| --- | --- | --- |
| CC6.1 Access security | Shared | OIDC single sign-on, no local password store; MVW's IdP is the authority (`identity/oidc.ts`) |
| CC6.2 Registration and authorisation | Shared | Directory-group provisioning; access follows the HR lifecycle |
| CC6.3 Access modification and removal | Shared | Group removal removes access; service accounts individually revocable |
| CC6.4 Physical access | MVW | Cloud provider and MVW facilities |
| CC6.5 Asset disposal | Shared | Retention job with recorded purges, covering two of the fourteen rules — `retention-and-deletion.md` §1 marks which, §5 says what the rest wait on |
| CC6.6 External threat protection | Shared | Egress allowlist, boundary screen, sandbox defaulting to disabled; network controls are MVW's |
| CC6.7 Transmission restriction | Shared | TLS in transit; redaction before egress; no card data (ADR 0009) |
| CC6.8 Malicious software | **Gap** | No container image scanning yet — see not-production-grade list |

### CC7 — System operations

| Criterion | Status | Evidence |
| --- | --- | --- |
| CC7.1 Vulnerability detection | Platform | Dependency scanning and SBOM in CI; severity-based SLAs (`vulnerability-policy.md`) |
| CC7.2 Monitoring for anomalies | Gap | Metrics, traces, and denial-rate alerting are specified in `docs/ops/observability-and-cost.md` and **none is emitted** (S9, S9a). What exists is a set of CLI checks that exit non-zero on the condition they check for, which a scheduler can alert on |
| CC7.3 Incident evaluation | Platform | `docs/ops/incident-process.md`, including what to do when the AI is wrong |
| CC7.4 Incident response | Shared | Containment controls stop in-flight work in seconds without a deploy |
| CC7.5 Recovery | **Partial** | Backup and restore procedure documented with a drill script; **the drill has not been executed on real infrastructure** |

### CC8 — Change management

| Criterion | Status | Evidence |
| --- | --- | --- |
| CC8.1 Change authorisation and testing | Platform | CI runs typecheck, lint, the full suite against both persistence adapters, the determinism gate, and the evaluation gate. Migrations immutable and checksum-verified |

### CC9 — Risk mitigation

| Criterion | Status | Evidence |
| --- | --- | --- |
| CC9.1 Business disruption mitigation | Shared | Graceful degradation on provider failure; explicit integration degradation policy |
| CC9.2 Vendor management | Shared | Subprocessor list in `dpa-support.md`; **model provider terms not yet confirmed** |

---

## Availability

| Criterion | Status | Evidence |
| --- | --- | --- |
| A1.1 Capacity | **Gap** | Load testing at realistic volume not performed; the measured ceiling is unknown |
| A1.2 Backup and recovery | **Partial** | Procedure and RTO/RPO documented; restore drill not executed |
| A1.3 Recovery testing | **Gap** | DR failover not exercised |

**Note on posture:** the platform fails closed by design (ADR 0003). A
dependency outage stops work rather than producing unrecorded work. That is a
deliberate availability trade and must be reflected in any availability
commitment MVW makes.

---

## Confidentiality

| Criterion | Status | Evidence |
| --- | --- | --- |
| C1.1 Confidential information identified | Platform | `data-inventory.md` |
| C1.2 Disposal | Platform | Retention job with recorded purges; audit chain holds digests, not payloads |

---

## Processing integrity

This is where the platform is strongest, and it is the criterion most relevant
to an AI system.

| Criterion | Status | Evidence |
| --- | --- | --- |
| PI1.1 Processing definitions | Platform | Declarative, versioned workflow definitions; instances pin their version |
| PI1.2 Input completeness and accuracy | Platform | Boundary screen; schema validation; no-grounding-no-answer for regulated questions |
| PI1.3 Processing completeness | Platform | Durable resumable engine; idempotency keys; compensation for irreversible steps |
| PI1.4 Output completeness and accuracy | Platform | Citations with version and effective date; golden-set evaluation; human approval above the risk threshold |
| PI1.5 Storage completeness | Platform | Hash-chained audit log with independent verification |

---

## Summary of gaps

1. Container image scanning (CC6.8)
2. Restore drill not executed on real infrastructure (CC7.5, A1.2)
3. DR failover not exercised (A1.3)
4. Load testing not performed; capacity ceiling unknown (A1.1)
5. Model provider terms not contractually confirmed (CC9.2)
6. Signed builds with provenance not implemented (CC8.1, partially)

All six appear in `docs/handover/not-production-grade.md` with the work each
requires.
