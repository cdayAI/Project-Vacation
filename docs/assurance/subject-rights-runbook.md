# Subject-rights runbook

**Scope:** access, deletion, correction, and opt-out requests from owners
(CCPA/CPRA and other US state privacy laws; GDPR where European owners are in
scope) and from employees (work-discovery data, and their own identity records).
**Owner:** MVW privacy, executing with platform support.
**Last reviewed:** 2026-08-06.

This platform is rarely the only place an owner's data lives. It is a governance
layer over MVW's systems of record. So the honest framing is: **this runbook
covers the platform's part of a request, and names what must happen elsewhere.**
A response that covers only this platform is incomplete and should not be sent.

---

## 1. Intake

Requests arrive through MVW's existing privacy intake, not through this
platform. The platform's job begins when a verified request is handed to it with
a subject reference.

Record the request first:

```bash
pnpm --filter @pv/platform exec tsx src/cli/main.ts subject-rights record \
  --type access|deletion|correction|opt-out \
  --subject-ref <opaque reference> \
  --received-at <ISO timestamp> \
  --requester <actor id>
```

This writes `subject_rights.request_recorded` to the audit chain and starts the
statutory response clock. **Identity verification is MVW's responsibility and
happens before this step.** The platform does not verify identity and must not
be treated as though it does.

---

## 2. Access

```bash
... subject-rights export --subject-ref <ref> --out <path>
```

Produces a structured export of everything the platform holds for that subject:

- runs and steps referencing it, with status, timestamps, and cost
- consent and revocation history with provenance
- outbound messages, with the gate evidence for each
- generated documents referencing it
- audit entries whose subject references it

**Deliberately excluded from the export:** input and output digests, and the
hashes of the audit chain. They are not personal data, they are not meaningful
to a requester, and explaining them invites confusion about what is held. If a
regulator asks specifically, they are available.

**Also required, and not from this platform:** the corresponding export from
each MVW system of record. The platform holds references; the systems hold the
data.

---

## 3. Deletion

The key architectural fact: **the audit chain does not need to change.** It
holds digests and opaque references, not owner data (ADR 0004). So deletion can
be complete without destroying the evidence trail — which is what makes both
obligations satisfiable at once.

1. **Check for a legal hold.** A hold beats a deletion request. If one applies,
   record it, suspend, and tell the requester the basis.
2. **Check retention obligations.** Consent evidence and contact-compliance
   records may be subject to a retention requirement that overrides erasure.
   This is a legal determination, not an engineering one — escalate, do not
   decide.
3. **Execute:**
   ```bash
   ... subject-rights delete --subject-ref <ref> --confirm
   ```
   Deletes owner data from the operating record, clears generated document
   bodies while retaining their metadata rows, and removes consent and message
   content where retention permits. Requires step-up re-authentication and
   records `subject_rights.fulfilled`.
4. **Propagate.** Deletion in MVW's systems of record is a separate action by
   their owners. The platform cannot do it and must not report a request as
   fulfilled until it is confirmed.
5. **Backups.** Backups are not selectively edited. Deleted data persists in
   backups until they expire (35 days). This is a standard and defensible
   position and should be stated in the response rather than glossed over.

**What remains after deletion:** digests of deleted values, opaque subject
references, and audit entries recording that decisions were made. These are
pseudonymous artifacts. Their classification under GDPR should be confirmed by
MVW legal; the platform's position is stated in the data inventory.

---

## 4. Correction

```bash
... subject-rights correct --subject-ref <ref> --field <name> --value <value>
```

Corrections apply to the platform's own copy and are recorded. **Corrections in
systems of record are made there** — correcting a downstream copy while the
upstream stays wrong produces a discrepancy that resurfaces at the next sync.

Note that a correction does not alter historical audit entries. An entry
recording that a decision was made from a value that later proved wrong is
accurate history, and it is exactly the record needed if the decision has to be
revisited.

---

## 5. Opt-out

Opt-out of contact is a **revocation event** in the consent ledger, not a flag:

```bash
... consent revoke --subject-ref <ref> --channel <channel> --purpose <purpose> \
  --source <how it was received> --received-at <ISO timestamp>
```

Revocation is effective immediately at the contact gate and wins over any later
stale consent read — that ordering is tested. Records `consent.revoked`.

Opt-out of automated decision-making, where it applies, routes the subject's
work to human-only handling. Configure by moving the relevant workflow to
`human_only` involvement for that subject.

---

## 6. Response clocks

| Regime | Deadline | Extension |
| --- | --- | --- |
| CCPA/CPRA | 45 days | +45 with notice |
| GDPR (if in scope) | 1 month | +2 months for complex requests |
| Other state laws | Varies | Varies |

**Confirm with MVW privacy which regimes apply.** The platform records the
received-at timestamp and surfaces ageing requests; it does not compute the
statutory deadline, because that determination depends on facts the platform
does not hold.

---

## 7. Verification and evidence

Every subject-rights action writes to the audit chain. To produce the evidence
of a request's handling:

```bash
... audit query --subject-ref <ref> --event-type subject_rights.request_recorded \
  --event-type subject_rights.fulfilled
pnpm audit:verify
```

The chain verification is what makes the evidence worth producing.

---

## 8. Open questions

1. Are European owners in scope? Determines GDPR applicability throughout.
2. Which retention obligations override erasure, per data class?
3. Does MVW's privacy intake produce a subject reference this platform can
   resolve, or does the mapping need building?
4. Who signs off on a deletion that touches contact-compliance evidence?
