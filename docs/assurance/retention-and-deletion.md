# Retention and deletion policy

**Last reviewed:** 2026-08-06.

A retention policy that exists only as a document is a liability: it creates an
obligation nobody discharges and a discrepancy an auditor will find. This one is
enforced by a scheduled job that reads a single table of rules, and its runs are
recorded in the audit log as `retention.purged`.

Periods below are **engineering defaults**. MVW legal owns the real figures, and
the first review of this document should replace them.

---

## 1. The rules

| Data | Period | Trigger | Action at expiry |
| --- | --- | --- | --- |
| Audit chain | 7 years (`PV_AUDIT_RETENTION_DAYS`) | `recordedAt` | **Archive, then prune from the head backwards.** See §3 |
| Runs and steps | 7 years | run `endedAt` | Delete |
| Cost entries | 7 years | `recordedAt` | Delete with their run |
| Consent events | 7 years after the owner relationship ends | relationship end | Delete |
| Outbound messages | 7 years | `sentAt` | Delete |
| Generated documents | Per document class; default 7 years | generation | Delete body, keep the metadata row |
| Knowledge chunks | Until superseded, then 7 years | supersession | Delete |
| Model invocations | 2 years | `invokedAt` | Delete |
| Improvement observations | 2 years | `observedAt` | Delete |
| Sessions | 30 days after expiry | `expiresAt` | Delete |
| Staff actor records | Employment end + 90 days | deprovisioning | Delete, retaining actor id in audit entries |
| Work-discovery observations | Configured value, **hard-capped at 30 days** | `observedAt` | Delete |
| Logs | 90 days | write | Sink-side expiry |
| Backups | 35 days | snapshot | Sink-side expiry |

---

## 2. How it is enforced

`PurgeJob` runs daily. For each rule it selects rows past their period, deletes
them in bounded batches, and records one `retention.purged` audit entry per rule
per run, carrying the rule name, the cut-off timestamp, and the row count —
never the rows.

Three properties matter and are tested:

**It is idempotent.** A second run in the same window deletes nothing and is not
an error.

**It is bounded.** Batches are capped so a purge cannot lock a table for an
unbounded time. A partial purge resumes on the next run.

**It fails closed.** A purge that cannot write its audit entry does not delete.
Deleting without a record of the deletion is exactly the outcome the audit chain
exists to prevent.

---

## 3. Purging the audit chain without breaking it

This is the one genuinely awkward case. The chain's integrity depends on
contiguity: delete entry 5,000 and verification of 5,001 onward fails.

The procedure:

1. **Archive first.** Entries due for expiry are exported, with their hashes,
   to write-once storage. The export is independently verifiable, because
   `verifyChain` needs only the entries.
2. **Prune a prefix, never a middle.** Only the oldest contiguous run of entries
   is removed. Gaps are never created.
3. **Record the new anchor.** The `previousHash` of the new first entry is
   stored as the chain's expected starting hash. `verifyChain` accepts an
   explicit `expectedFirstPreviousHash` for exactly this purpose, so the live
   chain verifies against the anchor and the archive verifies on its own.
4. **Record the prune** in the chain itself, before it happens.

Result: the live chain stays verifiable, the archive stays verifiable, and the
join between them is a recorded hash rather than an assertion.

---

## 4. Deletion on request

See `subject-rights-runbook.md` for the full procedure. The architectural point
is that the audit chain **does not need to be modified** to honour a deletion
request, because it holds digests and opaque references, not owner data. Owner
data is deleted from the operating record, from generated document bodies, and
from MVW's systems of record. The digest of deleted data remains — a
pseudonymous artifact whose classification is stated in the data inventory for
MVW legal to confirm.

Where a legal hold applies, deletion is suspended and the hold is recorded. A
hold beats a deletion request, and the requester is told so.

---

## 5. What is not built

- Automatic archival to write-once storage. The prune procedure is specified and
  the verifier supports an explicit anchor, but the archival job itself is not
  implemented. Until it is, audit retention should be left at its default and
  nothing pruned. Recorded in the not-production-grade list.
- Per-document-class retention for generated documents. Currently one default
  applies to all; the classes need to come from MVW records management.
