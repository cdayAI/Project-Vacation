# Backup, restore, disaster recovery, and capacity

**Last reviewed:** 2026-08-06.

> **Read this line first.** The procedures below are written and scripted. The
> restore drill, the failover exercise, and the load test have **not been
> executed**, because there is no deployed infrastructure to execute them
> against. A backup you have never restored is a hope, and this document does
> not pretend otherwise. Each is a named gate in the not-production-grade list.

---

## 1. What must be recoverable

| Data | Loss tolerance | Why |
| --- | --- | --- |
| Audit chain | **Zero** | It is the evidentiary claim. A gap is indistinguishable from tampering |
| Operating record | 15 minutes | Reconstructable from workflow state with effort |
| Workflow instances | 15 minutes | Longer means manual reconciliation of in-flight work |
| Consent ledger | **Zero** | Losing consent evidence means contact must stop until it is re-established |
| Knowledge corpora | 24 hours | Re-ingestable from source documents |
| Configuration | 24 hours | In version control |

## 2. Targets

**RPO 15 minutes.** Continuous WAL archiving with a 15-minute upper bound on
replay position.

**RTO 4 hours** for full service. **RTO 1 hour** for read-only access to the
audit chain and operating record, because during an incident the ability to
*answer questions about what happened* matters before the ability to do new
work.

Both are proposed. Neither has been validated by exercise, and MVW should
confirm they match the business need.

## 3. Backup

- Nightly full snapshot of the Postgres cluster, plus continuous WAL archiving.
- Encrypted at rest with managed keys; keys are not co-located with the backups.
- 35-day retention (covers the RPO with margin, and the retention policy
  assumes it).
- Backup completion and integrity are monitored; a *silent* backup failure is
  the failure mode that matters, so absence of success alerts rather than only
  presence of error.

## 4. Restore drill

```bash
tools/restore-drill.sh --snapshot <id> --target-env drill
```

The drill is not "did the data come back". It is:

1. Restore to an isolated environment.
2. Run migrations; confirm no pending migration and no checksum mismatch.
3. **Verify the audit chain end to end** — `pnpm audit:verify`. A restored chain
   that does not verify is a failed restore, whatever else came back.
4. Confirm the operating record's row counts against the pre-backup census.
5. Confirm workflow instances resume: start the engine, let timers fire, assert
   in-flight instances continue rather than stall.
6. Record the result — snapshot id, wall-clock duration, verification outcome,
   and the operator — as evidence.

**Cadence once deployed: monthly, plus after any schema change.** The result is
an artifact, not an assertion.

## 5. Disaster recovery

Primary region with streaming replication to a secondary. Failover promotes the
replica, repoints the application, and re-verifies the audit chain before
accepting writes — the verification is part of the failover, not a follow-up,
because accepting writes onto a chain of unknown integrity forks it.

Failback returns to the primary once replication has caught up and verification
passes in both directions.

**The exercise has not been performed.** An untested failover is a plan, not a
capability.

## 6. Capacity and load testing

**Not performed. The capacity ceiling is unknown.**

This matters more here than for a typical application: MVW has a large owner
base and pronounced seasonal peaks, and the Q2 2026 results show contract sales
growing 22% while tours fell 1% — meaning the back office is absorbing a
step-change in transaction volume on a flat front end. Full-year guidance
implies H2 volume above H1. Sizing from real numbers is a prerequisite, not a
nicety.

What must be measured before production:

1. **Sustained throughput** — runs per hour at steady state, until a resource
   saturates. Record which one.
2. **Peak burst** — the seasonal peak shape, which MVW must supply. We do not
   know it and must not guess it.
3. **Workflow instance concurrency** — how many in-flight instances the engine
   sustains before step latency breaches its SLA.
4. **Audit append throughput** — the append lock serialises the chain by design,
   so this is the most likely global bottleneck and should be measured first.
5. **Model call concurrency** against provider rate limits.
6. **Database connection pool** behaviour under saturation, confirming that
   exhaustion produces prompt refusals rather than unbounded queueing.

Record the measured ceiling, plainly, and never publish a figure from a dirty
working tree or without stating what was and was not measured.

**Known scaling constraint:** the model-call rate window and ceiling
reservations are per-process (`guard/ceilings.ts`). A multi-instance deployment
can exceed the intended call rate by roughly the instance count. Spend ceilings
are unaffected, because spend is summed from the shared operating record.
Moving the rate window to shared storage is required before horizontal scaling.

## 7. Not built

- The restore-drill and failover scripts are specified here but not yet written
  against real infrastructure.
- No infrastructure-as-code in this repository. Environments, networking, and
  the managed database are not defined here, and until they are, none of the
  above can be exercised.
