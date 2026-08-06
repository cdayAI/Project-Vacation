# Incident process

**Last reviewed:** 2026-08-06.

## Severity

| Level | Definition | Response | Comms |
| --- | --- | --- | --- |
| **SEV1** | Owner harm occurring or likely; audit chain broken; a statutory deadline missed; owner data exposed | Immediate page, incident commander, war room | MVW executive within 1 hour |
| **SEV2** | Platform unavailable; a governance control not functioning; a workflow producing systematically wrong output | Page, response within 30 min | MVW stakeholders within 4 hours |
| **SEV3** | Degraded performance; a single workflow failing; elevated denials | Next business hour | Daily summary |
| **SEV4** | Cosmetic or single-case | Backlog | Weekly |

**A broken audit chain is SEV1 regardless of anything else**, because it means
the platform's evidentiary claim is not currently true.

## First moves

1. **Stop the bleeding before diagnosing.** The containment controls exist for
   this and take effect in seconds without a deploy:
   ```bash
   # everything
   pnpm --filter @pv/platform exec tsx src/cli/main.ts containment engage \
     --scope global --reason "SEV1: <what>"
   # one workflow
   ... containment engage --scope workflow --target rescission.verify --reason "..."
   # one role
   ... containment engage --scope role --target rol_xxx --reason "..."
   # one integration
   ... containment engage --scope integration --target contract-records --reason "..."
   ```
   These stop **in-flight** work at its next action boundary, not just new work.
   Compensation steps deliberately still run — leaving a half-completed
   irreversible sequence unrepaired is worse than letting its repair finish.
2. Declare severity and name an incident commander.
3. Open a timeline document. Timestamp everything as you go; reconstructing it
   afterwards produces a worse postmortem.
4. Preserve evidence before remediating. The audit chain, the operating record,
   and the logs are the investigation.

---

## What to do when the AI is wrong

This is the procedure the brief specifically calls for, and it is the one most
likely to be needed. It answers two questions: *what did it touch*, and *who do
we need to make whole*.

### Step 1 — Identify the bad version

Every run records the role version, the model, and the prompt version it used.
Find the boundary:

```bash
... audit query --event-type model.invoked --model <model id> \
    --after <ISO> --before <ISO>
... roles history --role <role id>
```

### Step 2 — Find every action it touched

This is why the operating record and audit chain exist. The blast radius is a
query, not an archaeology project:

```bash
... blast-radius --role-version <role id>@<version> --out incident-<id>-radius.json
```

Returns every run, every step, every generated document, every outbound message,
and every subject reference associated with that role version, model version, or
prompt version. **This is the deliverable the rest of the response depends on.**

### Step 3 — Stop it

Disable the role (containment, above). If the cause is a model or prompt
version, revert it:

```bash
... improvement revert --change <change id> --reason "SEV<n>: <what>"
```

Revert is one action and is recorded as `improvement.reverted`.

### Step 4 — Classify the impact per affected subject

For each subject in the blast radius, determine whether the wrong output:

- **stayed internal** (a draft a human corrected) — record, no notification;
- **reached a consumer** (a letter sent, a deadline communicated) — notification
  and remediation required;
- **affected a legal position** (a rescission deadline miscomputed, a disclosure
  omitted) — **escalate to MVW legal immediately**. Do not decide this alone and
  do not remediate before legal has seen it.

### Step 5 — Notify and remediate

MVW owns consumer notification. The platform supplies the facts: what was wrong,
which subjects, when, what the correct output was, and the evidence trail. Every
remediation action is itself a run, so the fix is as auditable as the fault.

### Step 6 — Feed the loop

The failure becomes structured observations, which become a proposal, which is
evaluated and — if it improves measured quality — offered to a human. Add the
failing case to the golden set so it cannot regress: adding a case is always
permitted, weakening one never is.

---

## Audit chain verification failure

Treat as **SEV1 and as potential tampering until proven otherwise.**

1. Do not remediate. Do not restart anything. Preserve state.
2. Capture the evidence:
   ```bash
   pnpm audit:verify > incident-<id>-verification.txt
   ```
   The verifier reports every break, with kind, sequence, and detail — not just
   the first — so the output is the extent of the damage.
3. Interpret:
   - `hash_mismatch` — an entry's content changed after it was written.
   - `previous_hash_mismatch` — the chain was re-linked.
   - `sequence_gap` — entries were deleted.
   - `sequence_duplicate` — a fork, from a concurrency failure or a replay.
   - `timestamp_regression` — back-dating, or a clock problem.
4. Notify MVW security. A `hash_mismatch` or `sequence_gap` requires database
   access to produce, which narrows the candidate set considerably.
5. Establish the last known-good sequence from an archived export and determine
   what happened after it.
6. **Do not repair the chain.** A repaired chain is an unverifiable chain. Start
   a new segment with a recorded anchor and document the discontinuity.

---

## Postmortems

Blameless, within five business days for SEV1 and SEV2. Required sections:
timeline, impact including subjects affected, root cause, what detected it and
how long that took, what the controls did and did not catch, and actions with
owners and dates.

Two questions every postmortem must answer explicitly:

- **Did any control fail open?** Fail-closed is the platform's central promise.
  A control that permitted an action it should have refused is a higher-priority
  finding than the incident that revealed it.
- **Would the audit record have been sufficient** if a regulator had asked about
  this incident six months later? If not, that is a finding.

## On-call

**Not established.** Rota, paging, and escalation are MVW operational decisions.
Every alert in `runbooks.md` has a runbook, which is the platform's half of the
arrangement. Recorded in the not-production-grade list.
