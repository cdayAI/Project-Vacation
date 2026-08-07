# Pass 9 — The buyer's gauntlet

**Date:** 2026-08-07. **Method:** `docs/review-method.md` Pass 9.

Five people decide whether MVW buys this: a security reviewer, a risk
committee, an IT operator, a new engineer, and whoever signs the contract. This
document is what each of them found, answered **from the code** — running it,
not reading it — against a real Postgres 16 database and a real clean clone.

Nothing here is an intention. Every claim below names the file, the command, or
the transcript that produced it. Where something works, it says so plainly and
in as much detail as where something does not, because a report that only
accuses is as useless as one that only flatters.

**One sentence, if that is all anybody reads.** The governance engine is real,
unusually well built, and would survive a technical assessment; the product
around it cannot be logged into, and so no human can currently perform any of
the ten actions the governance exists to govern.

---

## 0. What was actually run

| # | Exercise | Environment | Result |
| --- | --- | --- | --- |
| 1 | Questionnaire re-check, answer by answer | source + running platform | 13 answers were untrue; corrected in place |
| 2 | Clean clone, README followed literally, timed | fresh clone, warm pnpm store | 120 s to the end of the README; two documented commands misbehave |
| 3 | Deploy to a clean environment | Postgres 16, new database `pv_operator` | migrations apply; no deployment documentation exists |
| 4 | Configure for production | `PV_ENV=production` | starts; three mandatory settings are read by nothing |
| 5 | Create a user | — | **impossible; no mechanism exists** |
| 6 | Run a case | Postgres | **impossible from any operator surface** |
| 7 | Grant an approval | console API, development actor | **refused: `authorization.step_up_required`** |
| 8 | Take a backup, restore it, verify | `pg_dump` / `pg_restore` | works; the documented script does not exist |
| 9 | Tamper with the restored chain | live Postgres | **detected and reported correctly** |
| 10 | Upgrade a version | — | **no procedure documented** |

Transcripts for 2 through 10 were produced in this pass and the exact commands
are quoted throughout.

---

## 1. The security reviewer

**Deliverable:** `docs/assurance/security-questionnaire.md`, corrected.
**Backlog:** its new §G — the fourteen questions that cannot be answered
truthfully today.

The verification pass had already found one bad answer: C.8 answered "yes" to
subject-rights handling and cited a runbook whose four CLI verbs do not exist.
Checking the rest of the document the same way found twelve more.

### 1.1 The thirteen corrections

| Q | What it said | What is true | How that was established |
| --- | --- | --- | --- |
| **B.1** | "OIDC single sign-on … signature, issuer, audience, and expiry are all verified" | The code exists in `identity/oidc.ts` and **nothing outside `identity/` imports it.** No sign-in route. `api/server.ts:179` throws for every request when an issuer is set. | Started the API with a production-shaped config; `GET /api/session` → `409 {"reason":"authorization.action_not_permitted","message":"No authenticated session…"}` |
| **B.2** | "The platform additionally requires step-up re-authentication for high-consequence actions" | The check is correct and **unsatisfiable**. `api/server.ts:175` returns `undefined` by construction; the guard refuses on unknown age. All ten approval-requiring actions are blocked. | `POST /api/approvals/{id}/decisions` → `authorization.step_up_required` |
| **B.3** | "roles derived from directory groups … Data scope is enforced at the persistence boundary" | Roles come from a hard-coded development actor. **No store filters by scope**; the check is in the chokepoint and only fires when a caller declares `requiredScopes`, which no console read does. | `grep requiredScopes` — declared by the engine, knowledge paths, and external admission only; `record/store.pg.ts` has no scope predicate |
| **B.4** | "Directory-group removal removes access" | Untestable — depends on B.1. Service-account revocation, however, **is** real and reachable. | `pv agents credential revoke` exists and runs |
| **B.6** | "the platform provides the role and entitlement report" | **No such report.** No user store, no way to create a user. `pv actions list` prints policy, not entitlements. | Full CLI usage enumerated; no user, identity, or entitlement verb |
| **C.8** | "Yes. `subject-rights-runbook.md`" | **No.** Five documented verbs, none implemented; two declared audit events with no writer; two registered actions with no caller. The runbook now carries a status banner saying so — the capability gap stands, the documentation lie is closed. | `pv subject-rights …` → `Unknown command`; `grep` finds no writer for `subject_rights.*` |
| **D.4** | "SBOM … on every build" | True for CI; the **committed `sbom.json` has drifted** by 24 packages and nothing detects it. | Finding F-31 |
| **E.1** | "including how to find every action a bad model or prompt version touched" | Three of the four prescribed commands do not exist; the fourth **silently ignores its filter**. | See §3.6 — the transcript is the important part |
| **E.2** | restore drill "documented" | The drill's own step 1 cited `tools/restore-drill.sh`, which **does not exist**; §7 disclosed this two sections later. **Corrected during this pass** — §4 now says so in its first line and gives the by-hand steps. | `ls tools/` → two `.mjs` files |
| **E.5** | "metrics, traces, and dashboards" | **None are emitted.** The definitions exist in `observability-and-cost.md`; its own §"Not built" says the export wiring does not. | `grep` for any metrics or OpenTelemetry dependency — none |
| **F.1** | model governance, stated as operating | Real as a control, but **no workflow calls a model.** `ModelGateway` is constructed twice, both in evaluation. | `grep ModelGateway` outside tests |
| **F.6** | "A harness exists and **runs** on synthetic fixtures" | It exists. **Nothing calls it** — `analyseFairness` has no importer outside its own barrel and its own test. | `grep analyseFairness` |
| **F.8** | "citations … that a reviewer can click through to" | Citations are real and well built; retrieval is reached only by the demo, and the console cannot be signed into. | `grep` for knowledge importers — `demo/run.ts` only |

### 1.2 What survived, and deserves to be said out loud

An assessment will confirm these, and the report is worth less if it does not
record them with the same specificity as the failures.

**B.5, the audit immutability claim, is stronger than most vendors can make.**
Verified against a live database, not asserted:

```
$ psql -d pv_drill -c "DELETE FROM audit_entry WHERE seq=2;"
ERROR:  audit_entry is append-only; DELETE is not permitted on this table
HINT:   Correct a mistaken audit entry by appending an entry that supersedes it.
```

And the residual is handled rather than hidden. A database owner *can*
`ALTER TABLE … DISABLE TRIGGER USER` and delete — that path is detected:

```
$ pv audit verify
Audit chain BROKEN — 1 problem found.
  [chain_truncated] seq 1: The chain ends at sequence 1, and it is recorded as
  having reached 2. 1 entry has been deleted from the end.
$ echo $?
1
```

Deleting from the end leaves an internally consistent prefix, so every hash and
link check passes; only a durable high-water mark catches it. It is the cheapest
tampering and the one most products miss.

**E.6, security event logging, holds under adversarial reading.** Every exit
path of `guard/authorize.ts` was traced: there is no early return that skips the
audit write. A grant whose audit write fails becomes a denial. A denial whose
audit write fails still denies. The unlogged case is therefore always "refused
and could not say so", never "permitted and did not say so" — the safe
direction, and clearly deliberate.

**C.4, C.6, D.8, D.9 all verified true.** PAN redaction is Luhn-confirmed so
ordinary long numbers survive; the audit log refuses subject values that look
like credentials, card numbers, or personal contact details; every log payload
passes `redactValue` before reaching a sink; the boundary screen refuses
oversized input rather than truncating it, and a screen that errors denies.

---

## 2. The risk committee

One page. Five questions. An answer that is hand-waving is itself a finding, and
two of these are.

### Who authorised this?

**Today: nobody can.** This is the finding that reframes the others.

Ten actions in the registry are `proposed_then_approved`. All ten also require
step-up re-authentication. The command line **refuses to grant approvals on
purpose** — it cannot verify who is running it, and `docs/ops/runbooks.md:247`
says so — leaving the console as the only granting surface. The console API
cannot authenticate anybody (§1, B.1), and even the development actor is refused
because nothing observes a re-authentication:

```
$ pv agents enroll … --raise-approval
Approval apr_ma7fkznv8d04zzzw93rx2p raised. Somebody other than
cli:unknown-operator must grant it — nobody approves their own proposal.

$ curl -X POST …/api/approvals/apr_…/decisions -d '{"decision":"granted"}'
{"denied":true,"reason":"authorization.step_up_required",
 "message":"Approving \"external_agent.enroll\" requires re-authentication
 within the last 300s, and this platform has not observed one."}
```

The ten blocked actions are: `contact.send_owner_message`,
`document.generate_owner_facing`, `external_agent.enroll`,
`external_agent.revoke`, `identity.issue_service_credential`,
`improvement.apply`, `owner.delete_data`, `owner.export_data`, `role.promote`,
`discovery.enroll_device`.

This is failing closed, and it is the correct failure. It is also a total one.
The committee should understand it as: **the authorisation model is real, and
the product currently authorises nothing.** Note the direction of the defect —
this platform's approval gate errs towards refusing work, not towards permitting
it unrecorded. That is the right sign of error for a governance product, and it
is worth more than it looks.

When the identity wiring lands, the answer becomes: a named human, holding a
role from a directory group, distinct from the proposer, re-authenticated within
300 seconds, approving a specific digest of exactly what will be done. Every
part of that except the identity is already built and tested.

### What happens when it is wrong?

Depends entirely on *which* wrong.

**A model produces a bad output.** Contained by design: no model call reaches a
consequential action without passing the chokepoint, and every consumer-facing
action is human-decided. The model is an evidence-gatherer.

**A statutory deadline is computed wrongly.** This is the one that matters, and
it is not hypothetical: **every rescission rule shipped is unverified placeholder
data**, marked `verified: false`, checked against no statute by anyone. A
deployment can now be configured to refuse rather than compute from them
(F-02, fixed), and that configuration is mandatory in production. If it were
ever relaxed, the platform would tell an owner their rescission window had
closed on the authority of a number somebody typed to exercise a test.

**An operator acts on a false record.** Three defects of this shape were found
in this programme, and the honesty about them is the reassuring part: a commit
reporting `already_done` for work never done (F-07), an approval recording a
step-up that never happened (F-08, fixed), and a refused call recorded as an
effect that may have landed (F-05). Each was found by looking, not by a test
failing. That is a statement about how many remain unfound.

### How do we stop it?

**Genuinely well, and this is the strongest operational answer in the set.**
Four containment scopes — global, per-workflow, per-role, per-integration —
checked *before every action*, not only when work starts, so a run that began
ten minutes ago halts at its next boundary. No deploy, effective in about a
second, reason mandatory and recorded. Demonstrated in the seeded run:

```
run in flight, first action permitted
global pause engaged by demo:priya
next action of the SAME run REFUSED (containment.global_pause)
```

The caveat is honest and small: containment is reachable from the command line,
which attributes every action to `cli:unknown-operator`. You can stop the
platform; the record of who stopped it is a role, not a person.

### What evidence exists afterwards?

**The best-answered question here.** A hash-chained, append-only log, verifiable
from an export with no access to our database, holding fingerprints rather than
payloads — so it proves which input a decision was made from without becoming a
second copy of owner data. Enforced by database triggers, not by convention.
Tamper-evident including deletion from the end.

Three gaps to name rather than discover later:

1. **No HTTP access log** (F-33). A request that succeeds or is cleanly refused
   leaves no line to correlate the chain against.
2. **No blast-radius query.** The evidence exists; the tool that turns it into
   an incident answer does not (§3.6).
3. **CLI attribution is a role, not a person**, until identity is wired.

### What is the worst case?

The method asks for real thought here rather than a reassuring sentence, so:
not the largest imaginable harm, but the most probable serious one.

**It is not a runaway agent.** Autonomy is gated at a chokepoint no action
escapes, ceilings are enforced at consumption, and shadow mode genuinely refuses
external effects. A loop costs one step's overspend, not a budget.

**It is not mass data exfiltration.** The audit chain holds no owner data; the
egress allowlist defaults to empty and refuses everything; there is no card
data; single-tenant by design.

**The worst case is that this platform is believed.**

The product's entire value proposition is that the record is true. Its outputs
are consumed as evidence — by a compliance officer, in a regulatory response,
in litigation, by an operator deciding whether an owner's rescission window has
closed. Every failure mode found in this programme was of one shape: **the
system stating that something happened which did not.** An approval recording a
re-authentication nobody performed. A commit reporting an action already done
that was never done. A chain verifying INTACT over entries deleted from its end.
A verifier exiting zero over an empty chain, immediately after a demonstration
the README says wrote to it.

Concretely, the worst realistic case runs like this. MVW deploys against real
owner data. The statutory rules are marked verified — because a lawyer signed a
memo about three of them and somebody flipped the rest to clear a release gate.
A rescission window is computed wrongly for a class of contracts. The platform
records, with full derivation, a citation, a chain hash, and an approving
actor, that the window closed on a date it did not. Owners are told. Some accept
it. The record is later produced as evidence — of MVW's diligence — and it is
internally consistent, cryptographically verified, and wrong. The tamper-evidence
proves only that nobody altered it after the fact. It cannot prove the input was
true.

**A governance record that is trusted and wrong is worse than no record**,
because it converts an arguable operational error into a documented,
systematised, attributable one across every affected owner simultaneously. The
mitigations are not technical: verified rules gated by counsel and not by an
engineer; shadow mode until measured against human decisions on real work; the
scope of what the record does and does not attest stated in the contract. The
platform's own not-production-grade list already names the first. The committee
should insist on all three.

---

## 3. The IT operator

Following **only** the documentation. Every stumble is a defect against the
docs. Recorded in the order encountered, with what had to be worked out
unaided.

### 3.1 Deploy to a clean environment — **blocked**

**There is no deployment documentation.** No Dockerfile, no container image, no
systemd unit, no infrastructure-as-code, no reverse-proxy or TLS guidance, no
process model, no statement of how many of each process to run.
`backup-restore-and-dr.md` §7 discloses this honestly — *"No
infrastructure-as-code in this repository"* — but no document tells an operator
what to do instead.

What worked, worked out unaided: create a database, set `PV_DATABASE_URL` and
`PV_STORE=postgres`, run `pv db migrate`. That succeeded cleanly and applied 17
migrations.

**Defect O-1 — no deployment guide exists.** An operator cannot get from a
checkout to a running service from the documentation.

**Observation, not a defect:** two migrations share the ordinal `0018`
(`0018_audit_watermark`, `0018_external_parked_committing`), which
`store/registry.ts` says the block-allocation scheme prevents. Ids remain
unique and ordering is deterministic by string sort, so nothing breaks — but the
comment no longer describes the file.

### 3.2 Configure it — **works, with three dead settings**

`admin-guide.md` §2 points at `.env.example`, and that file is now complete: all
39 keys the loader reads are documented, and nothing is documented that the
loader does not read. That is a real improvement (F-21) and it held up under a
mechanical diff.

Configuring for production surfaced the rest:

**Defect O-2 — a mistyped `PV_*` variable is silently ignored.** Setting
`PV_ENVIRONMENT=production` (the plausible typo for `PV_ENV`) produced no
warning and left the platform in development mode, with every development
allowance intact. `config show` reported `environment development`. The single
most consequential setting in the deployment fails open on a typo, in a platform
whose stated principle is that every default is the safe setting. Nothing
validates that a `PV_`-prefixed variable is one the loader knows.

**Defect O-3 — production mandates three settings that nothing reads.**

```
Configuration error: Single sign-on is required in production. Missing:
PV_OIDC_CLIENT_ID, PV_OIDC_CLIENT_SECRET, PV_OIDC_REDIRECT_URI.
```

All three are then read by no code anywhere. An operator obtains a client
secret from their identity team, stores it in a secret manager, and it is never
used — while the platform refuses every request for want of the session handling
that would have used it.

**Defect O-4 — one startup warning describes a control that is not wired.**

```
WARNING  EGRESS: PV_EGRESS_ALLOWLIST is empty, so every outbound integration
call will be refused.
```

`integrations/egress.ts` implements the allowlist correctly and **no composition
root constructs it**; `config.egressAllowlist` has no reader. The refusal the
warning describes would not happen, because the guard that would refuse is not
in the request path. A warning that is wrong is worse than no warning — the
operator either sets a value that does nothing, or believes egress is controlled.

### 3.3 Create a user — **impossible**

**Defect O-5 — there is no way to create a user.** No CLI verb, no API route,
no documented procedure, no user table for humans. `admin-guide.md` §9 says
"Roles come from directory groups", which is the design (§1, B.1) and not a
mechanism anybody can execute today. The journey stops here, and everything
below was completed only by using the development actor or the command line.

### 3.4 Run a case — **impossible from any operator surface**

`pnpm demo` runs and is impressive. It also **writes nothing to the configured
store.** Run with `PV_STORE=postgres` and a valid `PV_DATABASE_URL`:

```
$ pv demo run          # prints "audit entries  34", chain INTACT
$ psql -d pv_operator -tc "SELECT count(*) FROM audit_entry;"
     0
```

The demonstration builds its own in-memory platform. Of the console API's
routes, exactly three accept writes — an approval decision, a step correction,
and a containment switch — and none of them starts work. **The only way to
create a case in a real deployment is to enrol an external agent and have it
report**, which requires an approval nobody can grant (§2).

**Defect O-6 — no operator surface starts a run.**

### 3.5 Take a backup and restore it — **works; the documented script does not exist**

The mechanical path is sound, and the drill's own checks pass:

```
$ pg_dump -Fc -f pv_operator.dump pv_operator     # 0.17 s
$ createdb pv_drill && pg_restore -d pv_drill pv_operator.dump
$ pv db status
17 applied, 0 pending, 0 unrecognised, 0 changed.
$ pv audit verify
Audit chain INTACT.  entries checked : 2
```

Triggers survived the restore. `pv db status` exists and works (F-26).

**Defect O-7 — `tools/restore-drill.sh` does not exist. Closed during this
pass.** `backup-restore-and-dr.md` §4 presented it in a code block as the way to
run the drill; §7, two sections later, said the script was "specified here but
not yet written". An operator following §4 in order hit the failure first — the
same shape as F-25 and F-26, a procedure written against an intended surface.

The document now opens §4 with *"`tools/restore-drill.sh` does not exist"* and
gives the by-hand steps instead, which is the right resolution: the disclosure
moved to where the operator reads it rather than two sections past it. Recorded
here because the class of defect is the finding, not the instance — see §5.3
item 12.

**Defect O-8 — the backup procedure names no command.** §3 says "nightly full
snapshot of the Postgres cluster, plus continuous WAL archiving" and stops.
`pg_dump` versus `pg_basebackup` versus a managed snapshot is left to the
operator, and the choice determines whether the stated 15-minute RPO is
achievable at all.

### 3.6 The incident procedure — **the worst documentation defect found**

Not on the method's operator list, but reached while looking for the
blast-radius tool the risk committee asks for. `docs/ops/incident-process.md`,
"What to do when the AI is wrong" — the procedure the brief specifically calls
for, and the one read at three in the morning — prescribes four commands:

```
$ pv roles history --role r1
Unknown command: roles
$ pv blast-radius --role-version r1@1
Unknown command: blast-radius
$ pv improvement revert --change c1 --reason x
Unknown command: improvement
```

`blast-radius` is described in bold in that document as *"the deliverable the
rest of the response depends on"*.

The fourth command is worse than missing, because it answers.

**Defect O-9 — the CLI silently ignores unrecognised flags, and the incident
procedure depends on one.** `audit query --event-type model.invoked --model <id>`
runs and returns results. `--model` is not a flag `audit query` has. Verified
against a populated database:

```
$ pv audit query --limit 10
  1  …  approval.requested      cli:unknown-operator  action=external_agent.enroll
  2  …  authorization.granted   dev:local             action=record.read_run
2 entries.

$ pv audit query --limit 10 --model bogus --not-a-real-flag zzz
  1  …  approval.requested      cli:unknown-operator  action=external_agent.enroll
  2  …  authorization.granted   dev:local             action=record.read_run
2 entries.
```

Identical output, no warning, no non-zero exit. An incident responder computing
a blast radius from that gets **the entire log back and believes it is the
subset one model touched** — and then classifies impact per affected subject
from a list that is wrong in an unknown direction. Rejecting unknown flags is a
small change and it is the highest-value one in this section.

**Defect O-10 — `incident-process.md` was not covered by the runbook drift
check.** F-26 fixed `runbooks.md` by building the four missing verbs and adding
a test that fails when document and CLI drift apart. `incident-process.md`
contains four more command references and no such test. The fix is to point the
existing check at both files.

### 3.7 Upgrade a version — **no procedure exists**

**Defect O-11.** The only upgrade guidance in the repository is one clause in
`admin-guide.md:180`: migrations are additive and zero-downtime. Nothing states
how to move a deployment from one version to the next, in what order to restart
which process, whether the API and the worker may run different versions
concurrently, how to roll back, or what to do when a migration has applied and
the release is withdrawn. For a product whose evidentiary claim depends on an
unbroken chain across restarts, the rollback question is not cosmetic.

---

## 4. The new engineer

Clean clone, README alone, timed. **Total: 120 seconds** to the end of the
README's "Clone to running" section — comfortably inside fifteen minutes.

**Method and its caveats, stated so the number is not read as better than it
is.** The clone was from a local path, and the pnpm store was already warm:
`pnpm install` completed in **2 seconds** where a genuine first-time engineer
downloads 332 packages. A realistic cold install is minutes, not seconds. The
working tree was overlaid onto the clone so the test reflected the source as it
stands today rather than HEAD. **The 15-minute gate passes on wall-clock and
that is not the interesting result** — what the run produced is.

| Step | Time | Result |
| --- | --- | --- |
| `git clone` | 0 s | fine |
| `pnpm install` | 2 s | fine (warm store) |
| `cp .env.example .env` | 0 s | fine |
| `pnpm test` | 114 s | **exit 1** |
| `pnpm demo` | 2 s | works, and is genuinely good |
| `pnpm audit:verify` | 2 s | **reports an empty chain, exits 0** |

### 4.1 `pnpm audit:verify` after `pnpm demo` verifies nothing — **and exits 0**

The README says, in these words: *"Then verify the audit chain the demo just
wrote."* Run exactly as instructed, immediately after the demo that printed
`audit entries 34` and a head hash:

```
$ pnpm audit:verify
Audit chain is empty. Nothing to verify.
$ echo $?
0
```

The demo builds its own in-memory platform and discards it; the verifier reads
the configured store, which is a different, empty one. Both are behaving
correctly in isolation.

**This is the single most damaging thing in the first five minutes of this
product**, and it is worth being precise about why. It is not that a command
failed. It is that in a product whose entire proposition is *the record is
true*, the verifier said "nothing to verify" and returned success, on the exact
sequence the README prescribes, about a chain a demonstration had just claimed
to write. A new engineer either does not notice — and now believes a verifier
that exits zero over an empty chain is normal — or notices and concludes the
audit story is theatre. Neither is recoverable in the first five minutes.

Carried as Pass 0 gap 2. **This should be fixed before the README is shown to
anybody**, and the fix is small: have the demo write to the configured store, or
have the verifier exit non-zero when asked to verify a chain that does not
exist.

### 4.2 `pnpm test` exits 1

`Test Files 4 failed | 99 passed`, all four in `packages/console/src/views/`.
The console is being rebuilt concurrently and these are that work in progress,
**not a defect of this pass.** The platform suite passed completely: `75 passed
(75)`, `1762 passed | 158 skipped`.

Recorded because a new engineer following the README does not know that. Step 5
of "Clone to running, in under fifteen minutes" ends in a red suite and no
explanation.

### 4.3 158 tests skip silently

The platform suite reports `158 skipped` and says nothing about why. Every
Postgres contract test skips without `PV_TEST_DATABASE_URL`, and the README's
Postgres section is below the fold in a later subsection. A new engineer reads
`1762 passed` as a green suite.

The size of the difference is the point. Run without the variable, as the README
instructs: `1762 passed | 158 skipped`. Run with it, against a real Postgres 16:
**`1937 passed`, nothing skipped.** Roughly one test in twelve — including every
persistence contract test, the pair that proves both adapters agree — does not
run in the configuration the README documents as the default, and the output
gives no hint of it.

**This is the false green the whole verification pass exists to catch**, and it
is one line of output away from being impossible: a notice naming what was
skipped and what to set. The README is honest that the default run uses
in-memory adapters; the test output is not.

### 4.4 What was genuinely good

Prerequisites are accurate — Node 22 and pnpm 10, nothing else, no Docker, no
network to a model provider — and that is rarer than it sounds. `pnpm install`
succeeded with no native-build failures. `pnpm demo` runs cold, first try, and
tells a coherent story: intake, effective-dated retrieval, a refusal that is
explained rather than hidden, a human approval, containment stopping a run
already in flight. **The demo is the best asset in this repository** and it is
undersold by the two commands around it failing.

---

## 5. The procurement question: what would make MVW say no

The method says this list is more valuable than any feature, and that a list
which flatters the build is worthless. So: ordered by how likely each is to end
the conversation, not by how hard each is to fix.

### 5.1 Deal-enders — any one of these ends it on the first technical call

**1. Nobody can log in.** Not "authentication is incomplete" — there is no
sign-in route, and in every environment the platform is permitted to run in,
every console request is refused. A buyer's first request is a demonstration in
their environment. There is nothing to demonstrate but a command line.

**2. No human can approve anything.** All ten approval-requiring actions are
blocked (§2). MVW is buying a governance product; the governance is a gate
nobody can pass through. This is the finding hardest to explain away, because
it is a *correct* refusal caused by an *incomplete* product, and that distinction
will not survive the meeting.

**3. Subject-rights handling does not exist**, and an assurance document said it
did. A privacy reviewer asks for this demonstration on the first call. The
questionnaire has been corrected, and MVW will reasonably ask what else was
written the same way. The honest answer, from this pass, is: twelve other
answers.

**4. Every statutory rescission rule is unverified placeholder data.** The
product's differentiating claim is defensible compliance in a regulated consumer
business, and the compliance table has never been checked against a statute.
This one is disclosed prominently and repeatedly, which is the right handling —
but it means the flagship capability cannot go live without a counsel
engagement MVW has not scoped.

**5. There is no deployment story at all.** No infrastructure-as-code, no
container, no upgrade procedure, no rollback procedure, no capacity number. MVW
Corporate IT cannot size, schedule, or risk-assess a deployment from this
repository.

### 5.2 Serious — survivable with a credible plan, fatal without one

**6. No restore drill, no failover exercise, no load test.** RPO 15 minutes and
RTO 4 hours are proposals. The drill script named in the document does not
exist. For a system of record in a regulated business, "we have never restored a
backup" is a conversation MVW's own auditors will have with them.

**7. Not certified, and not close.** No SOC 2, no ISO 27001, no penetration
test, no build provenance. The SOC 2 mapping is honest that it is a readiness
map. MVW's vendor process may not have a lane for a system of record with none
of these.

**8. Single-tenant by deliberate design.** Defensible (ADR 0010), and it means
every environment is a separate deployment with a separate operational burden —
which multiplies items 5 and 6 rather than adding to them.

**9. The capacity ceiling is unknown**, against a business the DR document
itself notes is absorbing 22% contract-sales growth on flat tour volume, with
pronounced seasonal peaks nobody has measured. A governance layer that becomes
the bottleneck in peak season is worse than no governance layer, because the
pressure will be to route around it.

**10. Concurrency limits are per-process.** The model-call rate window and
ceiling reservations do not survive horizontal scaling. Disclosed, and it means
the first capacity problem is also an architecture change.

**11. Large parts of the product are inert.** The workflow engine, the contact
compliance gate, document generation, integrations, role promotion, the
improvement loop past harvest, and the bias harness each have tests and no
caller. Individually defensible as unfinished wiring; collectively, a buyer
reading the inventory sees a product whose demonstrated surface is much smaller
than its documented one.

### 5.3 Friction — will not end the deal, will cost credibility in the room

**12. Documentation drifts from the command surface, repeatedly.** Four runbook
verbs (fixed by building them), the restore-drill script (fixed by disclosing
it), the subject-rights verbs (disclosed, not built), four incident-process
commands (**still open**). The pattern matters more than any instance:
procedures are written against an intended surface, and nothing checks the two
against each other. F-26 introduced a drift test for `runbooks.md`; three more
documents contain command references and none of them is covered. Until the
check is generalised, this will recur — three of these four were found by
running the commands, not by a test.

**13. The CLI accepts flags it does not understand**, silently, including in an
incident procedure. Small, and it undermines every number the tool produces.

**14. A typo in `PV_ENV` fails open** into development mode with no warning.

**15. The committed SBOM is inaccurate**, and CI cannot detect the drift. It is
one of the first artifacts a supply-chain reviewer opens.

**16. `pnpm audit:verify` after `pnpm demo` verifies nothing and exits zero**,
exactly as the README instructs. In the first five minutes, in front of the
buyer.

### 5.4 What would make MVW say yes

Stated because a list of objections without this is not an assessment, and
because the honest verdict is not "no".

The governance engine is real and it is good. One chokepoint no action escapes.
Digest-bound, single-use, N-of-M approvals with segregation of duties and
expiry. An append-only hash-chained log with database-level enforcement,
independent verifiability, and detection of the one tampering shape most
products miss. Containment that stops work already in flight, at four scopes, in
about a second. A boundary screen that fails closed. Refusal as a typed,
machine-readable, first-class outcome rather than an error. Statutory rules as
effective-dated data with citations rather than conditionals. Ports and adapters
with one contract suite run against both, verified on real Postgres. A seeded
demonstration that is deterministic and honest about what it refuses.

None of that is common, and none of it is what a team builds when it is
optimising for a demonstration.

**The gap is not between this and a well-built product. It is between a
well-built engine and a deployment somebody can log in to.** Items 1, 2 and 3
are the same defect wearing three hats — identity is not wired to the HTTP
surface — and closing it converts the majority of §5.1 from a deal-ender into a
release note. That is the single highest-value piece of work in the repository,
and it should be done before this is shown to a buyer again.

---

## 6. What this pass did not do

- **The end user.** The method asks for a real person, an hour, real work, and
  silence. That requires a person and a working login; neither exists (§3.3).
  Not attempted rather than simulated, because an invented usability finding is
  worth less than an honest absence.
- **A cold-cache install measurement.** The clone ran against a warm pnpm store
  (§4). The 15-minute gate passes; the margin is unmeasured.
- **Console defects.** Four view test files are red under concurrent rebuild
  work and were excluded by instruction.
- **Fixing what it found.** §1 corrected the questionnaire, because a false
  assurance answer is the defect itself. Everything else is reported, not
  patched: O-1 through O-11 are documentation and product-surface decisions that
  belong to the owner, and several are ordering-dependent on identity being
  wired.
