# Service level objectives

**Last reviewed:** 2026-08-06.
**Status:** proposed targets. **None has been validated against measured
production behaviour**, because there is no production. They are starting points
for a conversation with MVW, not commitments.

## The availability trade, stated first

This platform **fails closed** (ADR 0003). When the operating record, the audit
log, or a governance control is unavailable, the platform refuses work rather
than performing it unrecorded.

That is a deliberate trade of availability for accountability, and it has to be
in the SLO conversation from the start rather than discovered during an
incident. An outage here does not produce wrong work or unlogged work — it
produces *no* work, visibly, with every refusal recorded. For a platform whose
purpose is an auditable record, that is the correct failure mode, and MVW should
agree to it explicitly.

## Objectives

| # | Surface | Indicator | Target | Window |
| --- | --- | --- | --- | --- |
| S1 | Console | Successful page loads / attempts | 99.5% | 30 days |
| S2 | API | Non-5xx responses / total, excluding deliberate denials | 99.5% | 30 days |
| S3 | API latency | p95 read latency | < 500 ms | 30 days |
| S4 | Workflow progress | Instances advancing within their step SLA | 99.0% | 30 days |
| S5 | Approvals queue | Approvals surfaced to an approver within 60s of parking | 99.9% | 30 days |
| S6 | Audit durability | Actions with a verifiable audit entry | **100%** | Always |
| S7 | Audit integrity | Daily verification passes | **100%** | Always |
| S8 | Model availability | Model calls succeeding within the fallback chain | 99.0% | 30 days |
| S9 | Statutory timers | Deadline timers firing within 60s of their due time | **100%** | Always |

**S6, S7, and S9 have no error budget.** They are not availability targets, they
are correctness properties. A missing audit entry means an action nobody can
account for. A broken chain means the evidentiary claim fails. A missed
statutory timer means a legal deadline passed unnoticed. Each is an incident at
the first occurrence, not at the hundredth.

## Error budgets

Where a budget exists, it is `(1 - target) × window`. S1 and S2 at 99.5% over 30
days is about 3h 39m.

Budget policy: when more than half is consumed, feature work pauses in favour of
reliability work. When it is exhausted, only reliability and security changes
ship until the window rolls.

## Deliberate exclusions from the indicators

**Denials are not errors.** A refused action is the platform working correctly,
and counting denials against availability would create pressure to weaken
controls. They are tracked separately, because a *spike* in denials is a strong
signal — of a misconfiguration, an outage, or an attack — and it alerts.

**Model quality is not an SLO.** It is measured against golden sets and gated in
CI. Conflating "the model answered" with "the model answered well" would let a
degraded-but-responsive provider look healthy.

## Measurement

Every indicator derives from the operating record and structured logs, so the
numbers come from the same place as the evidence. The dashboards are specified
in `observability.md`.

**Nothing here has been measured.** Load testing at realistic volume has not
been performed, and MVW's seasonal peaks are not sized. Until that work is done
(`load-testing.md`), these targets are estimates and the capacity ceiling is
unknown.
