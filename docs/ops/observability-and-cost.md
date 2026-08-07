# Observability and cost reporting

**Last reviewed:** 2026-08-06.

## Structured logs

Everything is JSON, through `kernel/logger.ts`, and **every payload passes
`redactValue` before it reaches a sink**. That is not a convention someone must
remember — it is applied inside the logger, because "no secrets in logs" cannot
depend on each author's care at each call site.

A line carries `correlationId`, plus `runId` and `actorId`, when its caller
supplies them — the logger stamps whatever context it is given and invents
nothing, and `child()` is how a caller makes that automatic for everything below
it.

**What is actually written today is much less than this section implies.**
Fastify's own request logging is switched off, deliberately (two loggers with
different redaction rules is how a secret reaches a log), and nothing replaced
it. So a running API writes two lines at startup and one line per *unhandled
failure* — that failure line does carry the correlation id, the flattened error
message and the stack. A request that succeeds, or that is refused with a
`DeniedError`, writes nothing at all. One unit of work is reconstructable
through the audit chain and the operating record, both of which carry the
caller's correlation id; it is not reconstructable through the log stream,
because there is almost no log stream. See S9 in
`docs/handover/not-production-grade.md`.

Levels: `error` for something needing a human; `warn` for degraded-but-working;
`info` for state transitions; `debug` and `trace` off in production.

**Denials log at `info`, not `error`.** A refused action is the platform working
correctly. Logging denials as errors would train operators to ignore errors,
which is the opposite of useful. Denial *rate* is what alerts.

## Metrics — specified, none emitted

**Nothing in this repository emits a metric.** There is no metrics client, no
exporter, and no instrumentation: the platform's runtime dependencies are
Fastify, `jose`, `pg`, `pino` and `zod`, and none of the names below appears in
the source. This table used to be presented as a description of the
instrumentation and it is a specification of it — which is a materially
different thing to hand an SRE who is planning a dashboard.

It is kept because it is the right list, derived from the SLOs it serves, and
because deciding what to measure is most of the work. Building it is recorded as
a gap in `docs/handover/not-production-grade.md`. Until then, everything an
operator can actually observe comes from the CLI — `pv health`, `pv cost
report`, `pv approvals list --ageing`, `pv models degradation`, `pv engine
timers`, `pv audit verify` — each of which exits non-zero on the condition it
checks for, which is what makes them schedulable in place of alerts on metrics
that do not exist.

| Metric | Type | Labels | Why |
| --- | --- | --- | --- |
| `runs_started_total` | counter | kind, mode | Volume |
| `runs_completed_total` | counter | kind, mode, status | Success and denial rates |
| `run_duration_seconds` | histogram | kind | S4 |
| `steps_executed_total` | counter | kind, status | Where work fails |
| `authorization_decisions_total` | counter | action, outcome, reason | **Denial-rate alerting** |
| `approvals_pending` | gauge | action | Queue depth |
| `approval_age_seconds` | histogram | action | S5, ageing alert |
| `model_invocations_total` | counter | task, model, outcome | Governance and cost |
| `model_degradations_total` | counter | task, from_model, to_model | Provider health |
| `cost_usd_total` | counter | category, workflow, role, department | **Cost per unit of work** |
| `audit_entries_total` | counter | event_type | Volume |
| `audit_verification_status` | gauge | — | **S7, no error budget** |
| `timers_overdue` | gauge | — | **S9, no error budget** |
| `containment_engaged` | gauge | scope, target | Is anything stopped |
| `corpus_staleness_days` | gauge | corpus | Review cadence |

## Audit volume — a consequence worth planning for

Every authorization decision is recorded, including grants for routine reads.
That is the stronger compliance position — "who read this owner's record" is a
question an auditor will ask — but it has an operational consequence that
should not be a surprise:

**The audit chain grows with read traffic, not only with work.** An operator
browsing the console writes entries. Verification cost is linear in chain
length, so a read-heavy deployment reaches the point where full verification is
a nightly batch job rather than an on-demand one sooner than the volume of
actual work would suggest.

Three things follow, and they should be decided before go-live rather than
discovered:

1. Verify a **window** on demand and the full chain on a schedule. The verifier
   supports an explicit starting anchor for exactly this.
2. Size the audit table for read volume, not for run volume. Monitor
   `audit_entries_total` by event type; if `authorization.granted` dominates by
   an order of magnitude, that is expected rather than a defect.
3. If the volume becomes genuinely unmanageable, the change to consider is
   recording grants for routine reads at a lower fidelity — not dropping them,
   which would remove the access record. That is a decision for MVW compliance,
   not an engineering optimisation, and it needs an ADR.

## Traces

Spans across API, engine step execution, authorization, retrieval, and model
calls, sharing the log correlation id. Trace attributes carry ids and digests
only, never payloads — a tracing backend is a third-party system and must not
become another copy of owner data.

## Dashboards

1. **Operations** — run volume and status by workflow, queue depths, SLO burn.
2. **Governance** — authorization outcomes by reason, approvals ageing,
   containment state, audit verification.
3. **Model** — invocations by task and model, degradation, latency, golden-set
   accuracy trend.
4. **Cost** — spend by workflow, role, and department; cost per completed case.
5. **Executive** — tied to the metrics management named in the Q2 2026 earnings
   release: contract sales, VPG, tours, financing margin, loan-loss provision.
   Sourced from MVW systems, with the platform's contribution shown alongside
   rather than conflated with it.

## Cost per unit of work

MVW will ask what a resolved case costs. The answer comes from the operating
record, not an estimate.

Every model call, integration call, and unit of storage or compute writes a
`CostEntry` against its run and step. Human time is recorded against human
tasks. Because cost is attached to the run, aggregation by workflow, role,
department, or case falls out without a second accounting path.

```bash
pv cost report --since <ISO> --group-by workflow
pv cost report --since <ISO> --group-by role,category --top 20

# Per run, into a spreadsheet. There is no --format flag: --json plus jq is the
# one output convention across every verb, and it composes into anything.
pv cost report --since <ISO> --json \
  | jq -r '.runsByCost[] | [.runId, .kind, .roleId, .totalUsd, .entries] | @csv'
```

The window is applied to when spend was *recorded*, which is the window the
daily ceiling counts, so this report and the meter that raises a ceiling alert
cannot disagree about the same day. The report leads with the largest single run
and its share of the window: one run holding most of a window is a loop, spend
spread across many is volume, and that distinction is the whole reason to run it
during an alert.

**Cost per resolved case is not yet a command.** The figures it needs are all in
the operating record — spend is attached to the run, and a run carries its
workflow, role, and outcome — but nothing divides one by the other today, and
the number that reaches a business-case conversation should not come from a
report nobody has built. Compute it from `--json` until it is.

Budget alerts fire at 80% of the daily ceiling. **The ceiling is enforced at
consumption**, not only pre-flight, so a runaway loop is bounded by one step's
cost rather than by whatever it can spend before someone notices.

## Health check

`GET /health` reports liveness, database reachability, audit-chain head and last
verification, containment state, **sandbox mode with its safety warning**,
**whether work discovery is enabled**, model provider reachability, and the
configuration warnings from startup.

The unsafe settings appear here deliberately. An operator should never have to
read the environment to discover that the sandbox is not containing anything.

## Not built

- Metric export wiring to a specific backend. The metric definitions exist; the
  exporter is deployment-specific and is MVW's choice.
- Log shipping and retention enforcement at the sink.
- The executive dashboard's MVW data sources, which require integrations not yet
  specified.
