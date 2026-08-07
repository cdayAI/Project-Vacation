# Retention and deletion policy

**Last reviewed:** 2026-08-07.

A retention policy that exists only as a document is a liability: it creates an
obligation nobody discharges and a discrepancy an auditor will find. Part of
this one is enforced by a job that runs inside `pv worker`, and its runs are
recorded in the audit log as `retention.purged`. The rest is not yet enforced,
and §5 says which rows those are and what each is waiting on. **Read §1 and §5
together** — §1 is the policy, §5 is how much of it the code discharges today.

Periods below are **engineering defaults**. MVW legal owns the real figures, and
the first review of this document should replace them.

---

## 1. The rules

| # | Data | Period | Trigger | Action at expiry | Enforced in code |
| --- | --- | --- | --- | --- | --- |
| R1 | Audit chain | 7 years (`PV_AUDIT_RETENTION_DAYS`) | `recordedAt` | **Nothing. The chain is never pruned by any job.** See §3 | n/a — see §3 |
| R2 | Runs and steps | `PV_AUDIT_RETENTION_DAYS` | run `endedAt` | Delete | No — §5 |
| R3 | Cost entries | With their run | `recordedAt` | Delete with their run | No — §5 |
| R4 | Consent events | 7 years after the owner relationship ends | relationship end | Delete | No — §5 |
| R5 | Outbound messages | 7 years | `sentAt` | Delete | No — §5 |
| R6 | Generated documents | Per document class; default 7 years | generation | Delete body, keep the metadata row | No — §5 |
| R7 | Knowledge chunks | Until superseded, then 7 years | supersession | Delete | No — §5 |
| R8 | Model invocations | 2 years | `invokedAt` | Delete | No — §5 |
| R9 | Improvement observations | 2 years | `recordedAt` | Delete | **Yes** |
| R10 | Work-discovery observations | Configured value, **hard-capped at 30 days** | `observedAt` | Delete | **Yes** |
| R11 | Sessions | 30 days after expiry | `expiresAt` | Delete | No — §5 |
| R12 | Staff actor records | Employment end + 90 days | deprovisioning | Delete, retaining actor id in audit entries | No — §5 |
| R13 | Logs | 90 days | write | Sink-side expiry | Sink, not code |
| R14 | Backups | 35 days | snapshot | Sink-side expiry | Sink, not code |

### What `PV_AUDIT_RETENTION_DAYS` actually controls

It is the deployment's **overall** retention period — the longest this platform
keeps anything — and every rule's period is clamped to it. Setting it to 365
gives a year for R9 as well as for R2, and cannot lengthen a rule that already
has a shorter period of its own: R10 stays capped at thirty days whatever this
value says.

It does **not** cause the audit chain to be pruned. Nothing does. See §3.

---

## 2. How it is enforced

`RetentionPurgeJob` (`packages/platform/src/retention.ts`) runs as the
`retention.purge` pass of the maintenance loop, which means it runs wherever
`pv worker` runs. For each rule it counts the rows past their period, records
one `retention.purged` audit entry carrying the rule name, the data-inventory
category, the cut-off, the period in force and the row count — never the rows —
and then deletes them oldest first.

It does not run while the platform is globally paused. Every other maintenance
pass closes a record or expires a claim; this one deletes, and a deletion cannot
be undone when the incident turns out to be the reason the data was needed.

It is not reachable from any request path. A purge an operator could trigger by
clicking is a deletion an operator can be socially engineered into causing.

Four properties matter, and each has a test in
`packages/platform/src/retention.test.ts`:

**It is idempotent.** A second run in the same window finds nothing past its
cut-off, deletes nothing, writes nothing to the chain, and is not an error. It
records no "nothing was due" entry: once a minute, per rule, that would add
half a million entries a year to a chain that has to stay cheap to verify, and
would bury the entries that record an actual deletion.

**It is bounded.** R9 deletes at most 500 rows per rule per run, oldest first,
so a purge cannot hold locks on a table for an unbounded time; a backlog drains
across runs. R10 is unbounded by row count and deliberately so — it applies a
per-enrollment cut-off on top of the deployment one, which a row cap cannot
express without losing the shorter periods individual people chose, and the
table it purges is bounded at thirty days of a feature that ships disabled.

**It fails closed.** The count is taken, the audit entry is written, and only
then are rows deleted — so a chain that cannot be appended to stops the purge.
Deleting without a record of the deletion is exactly the outcome the audit chain
exists to prevent. The residual, stated rather than hidden: a crash between the
write and the delete leaves the chain claiming a purge that did not finish, and
the next run deletes the remainder and records again. That is over-recording,
which is the safe direction to be wrong in.

**It never deletes an audit entry.** See §3.

---

## 3. The audit chain is not pruned, and this platform must not prune it

An earlier version of this document described, in the present tense, archiving
audit entries and pruning them from the head backwards. **That was wrong, and it
described something the platform must not do.** The correction matters more than
most, because it is the one place where following this document would have
damaged the evidence it exists to protect.

Three reasons, and the second is decisive:

1. **Contiguity.** The chain's integrity depends on it: delete entry 5,000 and
   verification of 5,001 onward fails.
2. **The watermark.** `audit_watermark` records the furthest sequence the chain
   has ever reached, and `AuditLog.verify` compares the live head against it
   precisely so that deletion *from the end* — the one shape plain chain
   verification cannot see — is detected. A retention job that trimmed the chain
   would be indistinguishable from the attack that check was built to catch.
3. **The archival job does not exist.** Pruning before archiving destroys the
   record rather than moving it.

So there is no code path that deletes an audit entry. `AuditStore` exposes no
deletion operation at all, a database trigger blocks `TRUNCATE`, and
`RetentionPurgeJob` refuses at construction to accept a rule targeting the chain
— a deployment configured to prune it fails to start rather than quietly
beginning to trim its own evidence.

If MVW's confirmed retention period ever requires the chain to be reduced, this
is the procedure to build. It is **specified, not implemented**:

1. **Archive first.** Entries due for expiry are exported, with their hashes,
   to write-once storage. The export is independently verifiable, because
   `verifyChain` needs only the entries.
2. **Prune a prefix, never a middle.** Only the oldest contiguous run of entries
   is removed. Gaps are never created.
3. **Record the new anchor.** The `previousHash` of the new first entry is
   stored as the chain's expected starting hash. `verifyChain` accepts an
   explicit `expectedFirstPreviousHash` for exactly this purpose, so the live
   chain verifies against the anchor and the archive verifies on its own.
4. **Reset the watermark deliberately**, as a recorded administrative act, so
   the truncation check keeps meaning what it means.
5. **Record the prune** in the chain itself, before it happens.

Until all five exist, audit retention is a floor: the chain is kept, and the
configured period is the period MVW is undertaking to keep it *for*, not a
period after which anything is removed.

---

## 4. Deletion on request

See `subject-rights-runbook.md` for the full procedure. The architectural point
is that the audit chain **does not need to be modified** to honour a deletion
request, because it holds digests and opaque references, not owner data. Owner
data is deleted from the operating record, from generated document bodies, and
from MVW's systems of record. The digest of deleted data remains — a
pseudonymous artifact whose classification is stated in the data inventory for
MVW legal to confirm.

Work-discovery data is the exception that is fully built: `eraseSubject`
destroys observations, sessions and the enrollment in one operation, with no
tombstone, because a tombstone naming the person is a record of the person.

Where a legal hold applies, deletion is suspended and the hold is recorded. A
hold beats a deletion request, and the requester is told so.

---

## 5. What is not built

Two of the fourteen rules in §1 are enforced by code that runs. This section is
the other twelve, with what each is actually waiting on. It is the honest
version of a claim that used to be made by omission.

**R2, R3 — runs, steps and cost entries.** Blocked on a dependency question, not
on effort. Eight tables across five modules reference `run` with `ON DELETE
RESTRICT` — `run_step`, `run_cost`, `improvement_observation`,
`improvement_application`, `workflow_instance`, `workflow_human_task`,
`model_invocation`, `role_evaluation_run` — and four of those
(`improvement_application`, `workflow_instance`, `workflow_human_task`,
`role_evaluation_run`) have no stated retention period at all. A run cannot be
deleted while any of them still points at it, so the operating record cannot be
purged until every table that references it has a period of its own and a purge
to discharge it. Deleting the references instead, or relaxing them to `ON DELETE
CASCADE`, would silently destroy the evidence chain those constraints exist to
protect.

**R4, R5 — consent events and outbound messages.** The stores exist and hold
real contact-compliance evidence; neither port has a deletion operation, and
adding one to the record that proves a contact was permitted is a change that
should be made with MVW compliance in the room rather than by an engineer.

**R6 — generated document bodies.** `purgeDocumentBody` is implemented and
tested and has no scheduled caller. It is also blocked on the per-class periods,
which have to come from MVW records management: one default applied to all
classes is not the policy this row describes.

**R7 — knowledge chunks.** "Until superseded, then 7 years" needs supersession
to be recorded as an event with a timestamp before a cut-off can be computed
from it.

**R8 — model invocations.** A leaf table with a clear two-year period and no
purge method. The straightforward next one to build.

**R11, R12 — sessions and staff actor records.** `purgeExpiredSessions` and
`purgeExpiredAuthorizationRequests` are implemented in both store adapters and
have no caller — but the identity module is not composed into the running
platform at all yet (`/api/session` refuses on that basis), so nothing writes
these tables in a deployment. They should be wired at the same time as identity,
not before.

**Automatic archival to write-once storage**, and therefore any pruning of the
audit chain. See §3. This is the row that most needs an owner: until it exists,
the chain grows without bound, and "grows without bound" is a capacity problem
rather than a compliance one, which is the right way round.

All of the above is reflected in the not-production-grade list.
