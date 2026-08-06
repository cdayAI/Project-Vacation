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

## EXTERNAL-AGENT-CONTAINED

**What fired.** An external agent moved to `contained` — either automatically,
after a run of denials it earned, or because a person pressed the button.

**What it means.** An agent running outside this platform is being refused
everything until a human releases it. Its work in flight stops at its next
heartbeat. If the containment was automatic, something on the vendor's side is
repeatedly asking for what it may not have — a broken deploy, a stale config, or
an attack.

**What to check.**
```bash
... agents show <agentId>
... audit query --subject externalAgentId:<agentId> --event-type authorization.denied \
  | jq -r '.decision.reason' | sort | uniq -c | sort -rn
```
The reason histogram usually names it in one look. `authorization.action_not_permitted`
clustered on one tool means the vendor is calling something that was never
granted. `approval.digest_mismatch` means requests are changing between park and
commit, which is either a client bug or a substitution attempt.

**What to do.** Contact the agent's enrolled owner — the registry entry names an
accountable person, never a shared mailbox, precisely so this step has somewhere
to go. Do not release until they can say what changed. Releasing also clears the
denial window, so an agent released while still broken will re-contain rather
than run unchecked.

```bash
... agents release <agentId> --reason "<what the owner fixed>"
```

**Escalate.** SEV3 normally. SEV2 if the dominant reason is
`screen.injection_detected` or `approval.digest_mismatch`, both of which look
like somebody trying rather than something broken.

---

## EXTERNAL-ACTION-INDETERMINATE

**What fired.** A parked action is in `indeterminate`.

**What it means.** A worker died between starting an outbound write and
recording its result. **The effect may or may not have landed**, and only the
system of record knows. This is the one state the platform cannot resolve for
you, and it is never retried automatically — an automatic retry could issue a
second payment.

**What to check.**
```bash
... agents parked --status indeterminate
```
The record carries the request digest, the preview a human approved, and the
time the commit began. Take those to the downstream system and look.

**What to do.** Establish in the system of record whether the action landed.
Then say so on the record — do not leave it ambiguous, and do not re-run the
agent's request hoping it is idempotent. If the action did not land and is still
wanted, it goes through the whole two-phase path again, including a fresh human
approval, because the original approval is spent.

**Escalate.** SEV2 if the action moves money or touches a contract. Notify the
agent's enrolled owner either way: their agent is waiting on an answer it cannot
get for itself.

---

## EXTERNAL-CREDENTIAL-EXPIRING

**What fired.** An enrolled agent's credential is inside the expiry horizon, or
has expired.

**What it means.** A vendor's integration is about to start failing
authentication, and the first anybody hears of it will be a support ticket
saying "your platform is down".

**What to check.** The health payload carries this — `... health` or the
console's health view lists every credential nearing expiry with its agent.

**What to do.** Tell the owner, and mint a replacement *before* revoking the
old one. Credentials are individually revocable and rotation is deliberately
not atomic: the agent holds both for the overlap, cuts over on its own
schedule, and the old one is revoked afterwards.

```bash
... agents credential mint <agentId> --kind <kind> --label "<what it is for>"
... agents credential revoke <credentialId> --reason "rotated"
```

A minted bearer token is printed **once**. Nothing in the platform, the console,
or the API can show it again, because only its hash is stored.

**Escalate.** SEV4. It becomes a SEV3 the moment it expires, and whichever
workflow depended on that agent starts failing.

---

## EXTERNAL-PLANE-ENABLED-AND-EMPTY

**What fired.** The external-agent plane is switched on and nothing is enrolled.

**What it means.** The most misleading state this plane can be in. Every
external figure the platform reports is a zero it has not earned — no agents, no
spend, no denials — and a reader reasonably concludes there are no external
agents, when the truth is that nobody has enrolled the ones that exist.

**What to do.** Either enrol the agents MVW actually runs, or switch the plane
off (`PV_EXTERNAL_AGENTS_ENABLED=false`) so the console says "off" rather than
"nothing to report". Both are honest. The current state is not.

**Escalate.** Not a page. It belongs in the weekly review, and it stays on the
health view until one of the two things above happens.

---

## STALE-AUTHORITY

**What fired.** A knowledge corpus is past its review cadence.

**What it means.** Regulated answers grounded in it are refusing, or being
flagged. Statutes change; a stale corpus is a silent correctness risk.

**What to do.** Notify the named corpus owner. Re-ingest current versions and
record the review.

**Escalate.** SEV3; SEV2 if the corpus backs statutory deadlines.
