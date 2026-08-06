# ADR 0004 — Tamper-evident audit log: hash chain, fingerprints not payloads

**Status:** Accepted
**Date:** 2026-08-06

## Context

The product thesis is not "we automate" but "we automate with a record that
survives an audit." That record has to satisfy two readers with opposite
instincts.

A compliance reviewer or a regulator wants to establish that a specific
decision was made, by whom, when, and on what basis — and wants confidence that
the record has not been edited since.

A privacy officer wants the smallest possible number of copies of owner
personal data, a defensible retention period, and the ability to honour a
deletion request without destroying the evidence trail.

A log that stores full request and response payloads satisfies the first reader
and fails the second badly: it becomes a second, long-retained, hard-to-delete
copy of owner data, and a large one.

## Decision

**Append-only, hash-chained, and it stores fingerprints rather than payloads.**

*Chaining.* Each entry carries `previousHash`, and `entryHash` covers the
sequence number, the previous hash, and every content field. Altering entry N
invalidates N and, transitively, every entry after it. Deletion shows up as a
sequence gap. Back-dating shows up as a timestamp regression. `verifyChain`
reports every break it finds, not just the first, because an operator
responding to a verification failure needs the extent of the damage.

*Fingerprints.* An entry records `inputDigests` — SHA-256 digests of the inputs
a decision was made from — plus opaque subject references and a structured
decision. It does not record the inputs. `AuditLog.record` actively refuses
content that looks like a payload: a non-digest in `inputDigests`, an
over-length subject value, a nested object in `decision`, or anything the
secret detector recognises.

*Verification is independent of storage.* `audit/chain.ts` verifies a chain
from the entries alone. An auditor handed a nightly export can verify it with
no access to our database, which is the only form of "verifiable after the
fact" that is worth anything.

*Enforced at the database.* The Postgres adapter carries a trigger that raises
on `UPDATE` or `DELETE` of the audit table, so append-only survives someone
with a `psql` prompt and good intentions.

## Consequences

- Proving *that* a decision was made from a particular input is fully
  supported. Reconstructing *what* the input was requires fetching it from the
  system of record, under that system's own access controls. This is the
  intended division of responsibility and needs to be explained to auditors
  once, in the evidence view, rather than defended each time.
- A subject-rights deletion can remove owner data from the operating record and
  the systems of record without breaking the audit chain, because the chain
  holds only digests. The digest of deleted data remains, which is a
  pseudonymous artifact, not personal data — that position is stated in the
  data inventory for legal to confirm.
- Verification cost is linear in chain length. A full verification of a
  multi-year chain is a batch operation, not a request-path one. The CLI
  supports verifying a sequence window with an explicit expected starting hash
  for exactly this reason.
- The chain proves *tamper evidence*, not *tamper resistance*. Someone with
  write access to the database and the application could rewrite the entire
  chain consistently. Detecting that requires an external anchor — periodically
  publishing the head hash somewhere we do not control. That is not built; it
  is recorded in the not-production-grade list with the shape of the fix.

## Alternatives considered

**Store full payloads, encrypted.** Rejected: encryption does not reduce the
retention or subject-rights surface, and key management becomes the weakest
link in an evidentiary record.

**Write-once object storage instead of a chain.** Complementary, not
sufficient: it makes deletion hard but does not let a third party verify
integrity from the data itself.

**A managed immutable-ledger service.** Rejected for now — it puts the evidence
of record in a proprietary format and a specific cloud, which is a poor
property for something an auditor may need to read in seven years.
