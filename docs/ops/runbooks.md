# Runbooks

**Last reviewed:** 2026-08-07. Every command below was run against a populated
Postgres deployment on that date, as a responder following the step rather than
as the person who wrote it. Three were followed end to end: STATUTORY-TIMER-LATE,
EXTERNAL-AGENT-CONTAINED, and DENIAL-RATE-SPIKE.

Every alert that pages a human has a runbook here. An alert without one is a
defect: waking someone with no instruction is how incidents get longer. A
runbook step that cannot run is a worse defect than a missing one — it costs the
responder the time to discover it is wrong, at the moment they have none.

Format: **what fired**, **what it means**, **what to check**, **what to do**,
**when to escalate**.

---

## Running these commands

Every command is written as `pv <verb>`. There are three ways to have `pv`, and
they are interchangeable:

```bash
# From a built deployment: `pv` is on PATH (packages/platform declares the bin).
pv health

# From a checkout, without building:
cd packages/platform && npx tsx src/cli/main.ts health

# From the repository root:
pnpm --filter @pv/platform exec tsx src/cli/main.ts health
```

`pv --help` lists every verb. Three conventions hold throughout, and each one
matters during an incident:

- **The answer goes to stdout; everything else goes to stderr.** So
  `pv audit verify > evidence.txt` produces a file an auditor can read, and
  `pv cost report --json | jq` composes.
- **`--json` works everywhere.** A command piped into `jq` needs it — without
  it you get a human-readable table and `jq` fails on the first line. Note that
  list commands emit a JSON *array*, so the filter is `.[].field`, not `.field`.
- **Exit codes mean something.** `0` is "answered, and the condition this checks
  for is absent". Non-zero means the condition is present, so these can be wired
  to a scheduler rather than only read by a person. `2` means the command was
  not usable as written; `78` means this deployment is not configured for it.

**Two processes, not one.** `pv serve` answers requests. `pv worker` runs the
maintenance passes: statutory timers, approval expiry, stale-commit sweeps, run
reclamation, retention. Several of the alerts below fire because nothing is
running the second one. There is deliberately no leader election, so run exactly
one worker.

---

## AUDIT-CHAIN-BROKEN

**What fired.** Scheduled verification reported one or more chain breaks.

**What it means.** The audit chain's integrity claim does not currently hold.
This is SEV1 and is treated as potential tampering until proven otherwise.

**What to check.**
```bash
pv audit verify > /tmp/verify.txt          # exits non-zero when broken
pv audit verify --json | jq -r '.breaks[] | "\(.kind) seq \(.seq): \(.detail)"'
```
Read the break kinds. There are seven, and each says something different about
what was done:

| kind | what it means |
| --- | --- |
| `hash_mismatch` | an entry's content was altered after it was written |
| `previous_hash_mismatch` | the chain was re-linked around something |
| `sequence_gap` | entries in the middle were deleted |
| `sequence_duplicate` | a fork: two entries claim the same position |
| `genesis_mismatch` | the first entry does not link to the genesis constant, so this is not the chain it claims to be, or it is a window read without its anchor |
| `timestamp_regression` | back-dating, or a clock that moved backwards |
| `chain_truncated` | the chain is shorter than it has ever been — the newest entries were deleted, or the table was emptied |

`chain_truncated` is the one to read first. Deleting from the end leaves an
internally consistent prefix behind, so every other check passes; it is caught
only by comparing what is present against a durable high-water mark.

If you verified a *window* (`--from N`), a `genesis_mismatch` may be an artifact
of the window rather than a break — `pv audit verify` anchors a window to the
entry before it and refuses if that entry is missing, so re-run without `--from`
before treating it as tampering.

**What to do.** Preserve state; do not restart or remediate. Follow
`incident-process.md` § "Audit chain verification failure". Notify MVW security.
**Do not repair the chain** — a repaired chain is an unverifiable chain.

**Escalate.** Immediately, always.

---

## AUDIT-WRITE-FAILING

**What fired.** Audit appends are failing, so actions are being refused.

**What it means.** The platform is failing closed as designed. Work has stopped
rather than proceeding unrecorded. Users see denials.

**What to check.**
```bash
pv health                  # names what is unreachable; exits 1 when it cannot serve
pv db status               # is the schema where this build expects it
```
`pv health` reports `status: unavailable` and lists the dependency by name when
a store cannot be read. Then check connection pool exhaustion, disk space on the
audit tablespace, and advisory-lock contention.

**What to do.** Restore database availability. **Do not** work around this by
disabling the audit write — there is no such switch, deliberately. If the
outage will be long, engage the global pause so the failure is one clear message
rather than a stream of denials:

```bash
pv containment engage --scope global --reason "audit store unreachable, INC-1234"
```

The pause reason is free text here and it is read by the next operator, so write
it for them. Maintenance stops under a global pause too, with one exception:
marking an abandoned commit indeterminate still runs, because it records that
nobody knows rather than acting in the world.

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
pv audit query --json --event-type authorization.denied --after <ISO> --limit 500 \
  | jq -r '.[].decision.reason' | sort | uniq -c | sort -rn
pv containment list
```
The reason histogram usually identifies it in one look. Both `--json` and the
`.[]` in the filter are load-bearing: without `--json` the command prints a
table and `jq` fails, and without `.[]` it reads the array itself. `--limit`
defaults to 50, which is far too small for a histogram — raise it.

To attribute a spike to one actor or one subject rather than counting the whole
deployment:

```bash
pv audit query --json --event-type authorization.denied --actor <actorId> --limit 500
pv audit query --json --event-type authorization.denied --subject contractId=<id>
```

**What to do.** Depends on the dominant reason. `containment.*` — check whether
the switch is intentional. `ceiling.*` — check for a runaway loop before raising
a limit, with `pv cost report` (see SPEND-CEILING-APPROACHING). `authorization.action_not_permitted`
clustered on one actor — check their directory groups. `screen.injection_detected`
clustered — likely a real attack; preserve and escalate. `authorization.step_up_required`
clustered — somebody is trying to take a high-consequence action without
re-authenticating; that control refuses rather than recording an unobserved
step-up, so these denials are the control working.

**Escalate.** SEV3 normally; SEV2 if the dominant reason is
`screen.injection_detected` or if it followed a deploy.

---

## STATUTORY-TIMER-LATE

**What fired.** A deadline timer did not fire within 60 seconds of its due time.

**What it means.** Potentially a missed legal deadline. S9 has no error budget.

**What to check.**
```bash
pv engine timers --overdue        # exits 1 when it finds one
pv engine timers --overdue --json | jq -r '.timers[] | "\(.firesAt)  \(.subject.contractId)  \(.workflow)/\(.step)"'
```
Each row carries the case reference the deadline belongs to, how late it is, and
which workflow and step are holding it. `--late-by <seconds>` changes the
threshold; it defaults to the 60 seconds this alert uses.

Then establish whether the timer is late or nothing is firing at all:

```bash
pv worker --once        # runs one round of maintenance; exits 1 if a pass failed
```
This prints every pass with what it did or the error it hit. `engine.sweep` is
the one that fires deadline timers. Read it three ways:

- **`engine.sweep` reports a number and the overdue list shortens** — nothing
  was running the loop. Start a worker.
- **`engine.sweep FAILED — <message>`** — the sweep is reaching the timers and
  cannot advance them. The message names the cause; a definition a running
  instance is pinned to that is absent from this build is the common one, and it
  blocks every instance on that workflow.
- **Overdue rows spanning unrelated workflows** — the scheduler, not the case.

There is no persisted heartbeat for the maintenance loop: `pv worker --once`
above and the worker process's own log (`maintenance loop started`,
`maintenance pass acted`) are the whole of the liveness evidence. Do not go
looking for a "last run" field; there is not one.

**What to do.** Identify the affected contracts immediately and hand them to a
human for manual handling. Do not wait for the technical fix — the deadline does
not wait for us. The `subject` on each row is the reference to take to whoever
handles it.

**Escalate.** SEV1 if any affected deadline has passed or is within 24 hours.
Notify MVW legal.

---

## APPROVAL-QUEUE-AGEING

**What fired.** Approvals are approaching or past their expiry unactioned.

**What it means.** Work is parked and will need re-approval if it expires,
producing rework and possibly a missed SLA.

**What to check.**
```bash
pv approvals list --status pending --ageing
```
`--ageing` keeps the approvals inside `--within` minutes of expiry (default 240)
or already past it, least time left first. Each row carries how far through
N-of-M the request is and which roles may decide it — the two things needed to
know who to wake.

The command **exits 1 when a pending approval has passed its expiry**. That is
two facts at once: the decision is no longer usable, and nothing swept it —
expiry is a maintenance pass, so an expired-but-pending row also means no worker
is running. Check `pv worker --once` before concluding it is a staffing problem.

**What to do.** Notify the eligible approver roles named in the listing. If
nobody eligible is available, this is a staffing gap — N-of-M requires N people
to exist. Raise it with MVW rather than working around it; there is no bypass
and there should not be one.

Deciding an approval is a console action. There is deliberately no CLI verb for
granting one: the command line cannot verify who is running it, and a
high-consequence grant now refuses unless a step-up was actually observed rather
than asserted.

**Escalate.** SEV3, or SEV2 if a statutory deadline depends on the parked work.

---

## MODEL-PROVIDER-DEGRADED

**What fired.** Fallback chains are being walked, or `model.degraded` is
elevated.

**What it means.** The primary model is unavailable, slow, or rate-limiting.
The platform is degrading gracefully rather than silently.

**What to check.** Provider status, and:
```bash
pv models degradation --since <ISO>
```
It reads the same record the alert fires on — the `model.degraded` audit entries
— and reports the walks by task, by which model handed off to which, and by
cause. It **exits 1 when a call exhausted every fallback and was refused**,
which is the SEV2 condition below.

If it reports zero model calls in the window, that is not a clean bill of
health: it says nothing called a model, which is a different fact and usually
means the window is wrong. The command says so rather than printing a reassuring
zero.

**What to do.** Usually nothing — this is the mechanism working. If the whole
chain is failing, calls are being denied rather than degraded, and affected
workflows should be paused so work parks cleanly instead of accumulating
failures:

```bash
pv containment engage --scope workflow --target <workflow> --reason "model chain exhausted, INC-1234"
```

**Escalate.** SEV3; SEV2 if every fallback is exhausted.

---

## SPEND-CEILING-APPROACHING

**What fired.** Daily spend is above 80% of its ceiling.

**What it means.** Either legitimate volume, or a loop.

**What to check.**
```bash
pv cost report --since <ISO> --group-by workflow,role
```
The headline is the same figure the daily ceiling counts — spend by when it was
*recorded*, not by when the run started — so the report and the meter that
raised the alert cannot disagree. Below it: the largest run and its share of the
window, then the breakdown, then the most expensive runs.

One run holding most of the window, with far more cost entries than anything
else, is a loop. Spend spread across many runs is volume. Run with no `--since`
for the ceiling's own 24-hour window; the report says plainly when the window you
asked for is not comparable to the ceiling. It **exits 1 when that default
window is at or above the ceiling**, meaning work is being refused right now.

**What to do.** For a loop: pause that workflow and investigate.

```bash
pv containment engage --scope workflow --target <workflow> --reason "runaway spend on run <runId>, INC-1234"
```

For volume: raise the ceiling deliberately, with the reason recorded. **Do not
raise the ceiling to clear an alert without first knowing which of the two it
is** — the ceiling is the only thing bounding a runaway.

**Escalate.** SEV3.

---

## SANDBOX-UNSAFE-MODE

**What fired.** The platform started with `PV_SANDBOX_MODE` set to something
other than `disabled` or `external` in a production-like environment.

**What it means.** `subprocess` constrains accidents, not adversaries. It is not
a security boundary.

**What to check.**
```bash
pv health | grep -i sandbox      # or: pv health --json | jq '{sandboxMode, sandboxIsContained}'
```

**What to do.** Confirm whether it is intentional. If any workflow executes
untrusted input, stop it and set the mode to `external` with a real isolation
service, or to `disabled`.

**Escalate.** SEV2 if untrusted code could reach it.

---

## DISCOVERY-ENABLED

**What fired.** Work discovery is enabled.

**What it means.** Employee observation is active.

**What to check.**
```bash
pv health --json | jq '.discoveryEnabled'
```

**What to do.** Confirm in writing that employee notice and consent, state
electronic-monitoring notice law, works-council and GDPR obligations for non-US
staff, and union constraints are all satisfied. **If that confirmation does not
exist, disable it now** (`PV_DISCOVERY_ENABLED=false`, then restart) and notify
MVW privacy and employment counsel.

Disabling it does not delete what has already been observed. The retention purge
that does is a maintenance pass, so it only runs while a worker is running.

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
pv agents show <agent>          # the name or the id; the listing shows both
pv audit query --json --subject externalAgentId=<agentId> \
     --event-type authorization.denied --limit 500 \
  | jq -r '.[].decision.reason' | sort | uniq -c | sort -rn
```
`--subject` is what restricts the histogram to *this* agent. Without it the
query returns every denial in the deployment, and another agent's behaviour gets
read as this one's — a wrong answer that looks exactly like a right one.

`pv agents show` states why it was contained, when, and by whom, in the state
line. An empty denial histogram under a contained agent is consistent and
expected when a person pressed the button rather than the agent earning it.

The reason histogram usually names it in one look. `authorization.action_not_permitted`
clustered on one tool means the vendor is calling something that was never
granted. `approval.digest_mismatch` means requests are changing between park and
commit, which is either a client bug or a substitution attempt.

**What to do.** Contact the agent's enrolled owner — `pv agents show` names an
accountable person, never a shared mailbox, precisely so this step has somewhere
to go. Do not release until they can say what changed. Releasing also clears the
denial window, so an agent released while still broken will re-contain rather
than run unchecked.

```bash
pv agents release <agent> --reason fixed_by_owner --note "vendor rolled the deploy back"
```

**`--reason` takes a code, not prose.** Free text is refused. The vocabulary is
`investigated_and_clear`, `fixed_by_owner`, `credential_rotated`,
`change_complete`, `contained_in_error`; run the verb without `--reason` to see
it with the meanings. Put the prose in `--note`, which is recorded alongside the
code and never instead of it. There is deliberately no `other`.

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
pv agents parked --status indeterminate     # exits 1 when it finds one
```
The record carries the request digest, the preview a human approved, and the
time the commit began. Take those to the downstream system and look.

An action only reaches `indeterminate` because a maintenance pass put it there —
`external.sweep_stale_commits`, which runs even under a global pause because it
records rather than acts. If no worker is running, an abandoned commit sits
looking like an ordinary in-flight one and this command reports all clear.
`pv worker --once` settles that.

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

**What fired.** An enrolled agent's credential is inside the expiry horizon (14
days), or has expired.

**What it means.** A vendor's integration is about to start failing
authentication, and the first anybody hears of it will be a support ticket
saying "your platform is down".

**What to check.**
```bash
pv health --json | jq -r '.externalAgents.credentialsNearingExpiry[]
  | "\(.expiresAt)  \(.agentName)  \(.kind) \"\(.label)\"  \(.credentialId)"'
```
`pv health`, `pv agents health`, and the HTTP `/health` payload all carry these
rows and are computed from one function, so they cannot disagree. The console's
health view shows the same list.

**What to do.** Tell the owner, and mint a replacement *before* revoking the
old one. Credentials are individually revocable and rotation is deliberately
not atomic: the agent holds both for the overlap, cuts over on its own
schedule, and the old one is revoked afterwards.

```bash
pv agents credential mint <agent> --kind <bearer|jwt|hmac|envelope> \
    --label "<what it is for>" --reauthenticated [--expires <iso>]
pv agents credential revoke <credentialId> --reason rotated
```

**`--reauthenticated` is required.** Minting is how an agent gets the ability to
act at all, so it is gated on a fresh human re-authentication; without the flag
the command refuses with `authorization.step_up_required`. The command line
cannot verify a re-authentication, so it is asserted — re-authenticate to this
host first, and know that the audit record shows the assertion came from the CLI
for whoever reviews it later.

`--reason` on revoke takes a code: `rotated`, `suspected_compromise`,
`no_longer_needed`, `owner_departed`, `minted_in_error`, `vendor_offboarding`.
Prose goes in `--note`.

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

**What to check.**
```bash
pv health --json | jq '.externalAgents | {planeEnabled, enrolledCount, enabledWithNothingEnrolled}'
```

**What to do.** Either enrol the agents MVW actually runs, or switch the plane
off (`PV_EXTERNAL_AGENTS_ENABLED=false`) so the console says "off" rather than
"nothing to report". Both are honest. The current state is not.

Enrolling needs an approval a different person granted, plus a re-authentication:
raise it with `pv agents enroll ... --raise-approval`, have somebody else decide
it in the console, then re-run the identical command with `--approval <id>
--reauthenticated`.

**Escalate.** Not a page. It belongs in the weekly review, and it stays on the
health view until one of the two things above happens.

---

## STALE-AUTHORITY

**What fired.** A knowledge corpus is past its review cadence.

**What it means.** Regulated answers grounded in it are refusing, or being
flagged. Statutes change; a stale corpus is a silent correctness risk.

**What to do.** Notify the named corpus owner. Re-ingest current versions and
record the review — `knowledge.record_corpus_review` is the action that resets
the cadence, and it requires step-up re-authentication because attesting that a
corpus is current is the only way to silence a staleness refusal.

**Known gap, stated rather than implied.** There is no CLI verb for corpus
review, and the knowledge layer is not composed by the platform's composition
root, so in a deployment built today this alert has nothing to fire from and the
attestation has no operator surface. Treat this runbook as describing the
intended handling, not a path you can walk tonight.

**Escalate.** SEV3; SEV2 if the corpus backs statutory deadlines.
