# Subject-rights runbook

**Scope:** access, deletion, correction, and opt-out requests from owners
(CCPA/CPRA and other US state privacy laws; GDPR where European owners are in
scope) and from employees (work-discovery data, and their own identity records).
**Owner:** MVW privacy, executing with platform support.
**Last reviewed:** 2026-08-07.

> ## ⚠ STATUS: THIS IS A SPECIFICATION, NOT A PROCEDURE
>
> **The platform half of this runbook is not built.** None of the five commands
> below exists. `pv subject-rights record`, `export`, `delete` and `correct`
> and `pv consent revoke` all exit 2 with "Unknown command". The two audit
> events the procedure depends on — `subject_rights.request_recorded` and
> `subject_rights.fulfilled` — are declared in `audit/types.ts` and emitted by
> nothing. `owner.export_data` and `owner.delete_data` are registered actions
> with correct risk tiers and no caller.
>
> Until they are built, **a subject-rights request cannot be executed against
> this platform**, and nobody should answer a privacy questionnaire as though
> it can. `security-questionnaire.md` row 3 records the same answer.
>
> This document is kept, in full, because the procedure it specifies is right
> and is what should be built — the shape of the export, the hold-before-delete
> ordering, the backup position, and what survives a deletion are all decisions
> worth keeping. Every command block below is marked **NOT BUILT** so that no
> reader mistakes a specification for a capability again.
>
> **What does work today**, and is genuinely useful in a request: `pv audit
> query --subject <key=value>` will find every audit entry naming a subject
> reference, and `pv audit verify` will prove the chain around them is intact.
> That is evidence about decisions, not an export of personal data.

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
# NOT BUILT — specified. This verb does not exist; the CLI exits 2.
pv subject-rights record \
  --type access|deletion|correction|opt-out \
  --subject-ref <opaque reference> \
  --received-at <ISO timestamp> \
  --requester <actor id>
```

This would write `subject_rights.request_recorded` to the audit chain and start
the statutory response clock. The event type is declared and nothing emits it,
so today the clock is started and tracked outside this platform or not at
all. **Identity verification is MVW's responsibility and
happens before this step.** The platform does not verify identity and must not
be treated as though it does.

---

## 2. Access

```bash
# NOT BUILT — specified. This verb does not exist; the CLI exits 2.
pv subject-rights export --subject-ref <ref> --out <path>
```

It would produce a structured export of everything the platform holds for that
subject:

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
   # NOT BUILT — specified. This verb does not exist; the CLI exits 2.
   pv subject-rights delete --subject-ref <ref> --confirm
   ```
   It would delete owner data from the operating record, clear generated
   document bodies while retaining their metadata rows, and remove consent and
   message content where retention permits — requiring step-up
   re-authentication and recording `subject_rights.fulfilled`. The document
   port already carries the body-purge shape this needs
   (`documents/port.ts`); the rest of it, and the verb, are unwritten. **The
   consequence to state to a requester today is that the platform cannot
   execute a deletion**, so an MVW-wide deletion currently leaves this
   platform's copy in place.
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
# NOT BUILT — specified. This verb does not exist; the CLI exits 2.
pv subject-rights correct --subject-ref <ref> --field <name> --value <value>
```

Corrections would apply to the platform's own copy and be recorded. **Corrections in
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
# NOT BUILT — specified. There is no `consent` verb in the CLI.
pv consent revoke --subject-ref <ref> --channel <channel> --purpose <purpose> \
  --source <how it was received> --received-at <ISO timestamp>
```

The *mechanism* behind this one is real and tested, unlike the verb: a
revocation is effective immediately at the contact gate, beats a later stale
consent read, and beats a grant back-dated before it — all asserted in
`contact/contact.test.ts` and re-verified in the review pass. What is missing is
an operator surface to record one. Until there is, a revocation reaches the
ledger only through a workflow that writes it, and there is no way for a privacy
officer to enter one by hand.

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
pv audit query --subject subjectRef=<ref> \
  --event-type subject_rights.request_recorded \
  --event-type subject_rights.fulfilled
pv audit verify
```

**Both of these commands exist and work.** The flag is `--subject <key=value>`,
repeatable, and all supplied pairs must match — there is no `--subject-ref`.
The chain verification is what makes the evidence worth producing.

The caveat that matters: the two event types filtered for above are emitted by
nothing, so this query returns an empty result on every deployment today. It is
the right query for the day the verbs exist. To find what the platform *does*
hold about a subject right now, drop the `--event-type` filters and query on the
subject reference alone.

---

## 8. Open questions

1. Are European owners in scope? Determines GDPR applicability throughout.
2. Which retention obligations override erasure, per data class?
3. Does MVW's privacy intake produce a subject reference this platform can
   resolve, or does the mapping need building?
4. Who signs off on a deletion that touches contact-compliance evidence?
