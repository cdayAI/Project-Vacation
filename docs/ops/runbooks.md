# Runbooks

**Last reviewed:** 2026-08-06.

Every alert that pages a human has a runbook here. An alert without one is a
defect: waking someone with no instruction is how incidents get longer.

Format: **what fired**, **what it means**, **what to check**, **what to do**,
**when to escalate**.

---

## AUDIT-CHAIN-BROKEN

**What fired.** Scheduled verification reported one or more chain breaks.

**What it means.** The audit chain's integrity claim does not currently hold.
This is SEV1 and is treated as potential tampering until proven otherwise.

**What to check.**
```bash
pnpm audit:verify > /tmp/verify.txt
```
Read the break kinds: `hash_mismatch` (content altered), `sequence_gap`
(entries deleted), `previous_hash_mismatch` (chain re-linked),
`sequence_duplicate` (fork), `timestamp_regression` (back-dating or clock).

**What to do.** Preserve state; do not restart or remediate. Follow
`incident-process.md` § "Audit chain verification failure". Notify MVW security.
**Do not repair the chain** — a repaired chain is an unverifiable chain.

**Escalate.** Immediately, always.

---

## AUDIT-WRITE-FAILING

**What fired.** Audit appends are failing, so actions are being refused.

**What it means.** The platform is failing closed as designed. Work has stopped
rather than proceeding unrecorded. Users see denials.

**What to check.** Database reachability, connection pool exhaustion, disk
space on the audit tablespace, advisory-lock contention.

**What to do.** Restore database availability. **Do not** work around this by
disabling the audit write — there is no such switch, deliberately. If the
outage will be long, engage the global pause so the failure is one clear
message rather than a stream of denials.

**Escalate.** SEV2 immediately; SEV1 if it lasts beyond one hour.

---

## DENIAL-RATE-SPIKE

**What fired.** Denials are well above baseline.

**What it means.** Ambiguous, and that is why it pages. Candidates: a
misconfiguration after a deploy; a containment switch someone forgot to
release; an integration outage causing fail-closed refusals; a role missing an
entitlement after a directory change; or an attack.

**What to check.**
```bash
... audit query --event-type authorization.denied --after <ISO> | \
  jq -r '.decision.reason' | sort | uniq -c | sort -rn
... containment list
```
The reason histogram usually identifies it in one look.

**What to do.** Depends on the dominant reason. `containment.*` — check whether
the switch is intentional. `ceiling.*` — check for a runaway loop before raising
a limit. `authorization.action_not_permitted` clustered on one actor — check
their directory groups. `screen.injection_detected` clustered — likely a real
attack; preserve and escalate.

**Escalate.** SEV3 normally; SEV2 if the dominant reason is
`screen.injection_detected` or if it followed a deploy.

---

## STATUTORY-TIMER-LATE

**What fired.** A deadline timer did not fire within 60 seconds of its due time.

**What it means.** Potentially a missed legal deadline. S9 has no error budget.

**What to check.**
```bash
... engine timers --overdue
```
Scheduler liveness, database reachability, and whether the timer is late or
never scheduled.

**What to do.** Identify the affected contracts immediately and hand them to a
human for manual handling. Do not wait for the technical fix — the deadline does
not wait for us.

**Escalate.** SEV1 if any affected deadline has passed or is within 24 hours.
Notify MVW legal.

---

## APPROVAL-QUEUE-AGEING

**What fired.** Approvals are approaching or past their expiry unactioned.

**What it means.** Work is parked and will need re-approval if it expires,
producing rework and possibly a missed SLA.

**What to check.** `... approvals list --status pending --ageing`

**What to do.** Notify the eligible approver roles. If nobody eligible is
available, this is a staffing gap — N-of-M requires N people to exist. Raise it
with MVW rather than working around it; there is no bypass and there should not
be one.

**Escalate.** SEV3, or SEV2 if a statutory deadline depends on the parked work.

---

## MODEL-PROVIDER-DEGRADED

**What fired.** Fallback chains are being walked, or `model.degraded` is
elevated.

**What it means.** The primary model is unavailable, slow, or rate-limiting.
The platform is degrading gracefully rather than silently.

**What to check.** Provider status; `... models degradation --since <ISO>`.

**What to do.** Usually nothing — this is the mechanism working. If the whole
chain is failing, calls are being denied rather than degraded, and affected
workflows should be paused so work parks cleanly instead of accumulating
failures.

**Escalate.** SEV3; SEV2 if every fallback is exhausted.

---

## SPEND-CEILING-APPROACHING

**What fired.** Daily spend is above 80% of its ceiling.

**What it means.** Either legitimate volume, or a loop.

**What to check.** `... cost report --since <ISO> --group-by workflow,role`
A single run with anomalous cost is a loop; broad growth is volume.

**What to do.** For a loop: pause that workflow and investigate. For volume:
raise the ceiling deliberately, with the reason recorded. **Do not raise the
ceiling to clear an alert without first knowing which of the two it is.**

**Escalate.** SEV3.

---

## SANDBOX-UNSAFE-MODE

**What fired.** The platform started with `PV_SANDBOX_MODE` set to something
other than `disabled` or `external` in a production-like environment.

**What it means.** `subprocess` constrains accidents, not adversaries. It is not
a security boundary.

**What to do.** Confirm whether it is intentional. If any workflow executes
untrusted input, stop it and set the mode to `external` with a real isolation
service, or to `disabled`.

**Escalate.** SEV2 if untrusted code could reach it.

---

## DISCOVERY-ENABLED

**What fired.** Work discovery is enabled.

**What it means.** Employee observation is active.

**What to do.** Confirm in writing that employee notice and consent, state
electronic-monitoring notice law, works-council and GDPR obligations for non-US
staff, and union constraints are all satisfied. **If that confirmation does not
exist, disable it now** and notify MVW privacy and employment counsel.

**Escalate.** SEV1 if the confirmation does not exist.

---

## STALE-AUTHORITY

**What fired.** A knowledge corpus is past its review cadence.

**What it means.** Regulated answers grounded in it are refusing, or being
flagged. Statutes change; a stale corpus is a silent correctness risk.

**What to do.** Notify the named corpus owner. Re-ingest current versions and
record the review.

**Escalate.** SEV3; SEV2 if the corpus backs statutory deadlines.
