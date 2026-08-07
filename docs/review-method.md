# Project Vacation — verification pass

Stop building. This is a full review of what exists, hunting for what is wrong,
what is missing, what is claimed but not true, and what would stop a buyer.

Run this against the program brief (`docs/program-brief.md`), the design
authority (`docs/design/design-spec.md`), and the architecture authority
(`docs/architecture.md`). Those three define what "correct" means; this
document is only the method for checking it. Where they disagree with your
memory of what you built, they win.

**The premise, and the reason this pass exists:** a green test suite proves the
code does what the tests say. It does **not** prove the feature is reachable,
that the failure paths fail safely, that the compliance claim is true, or that
your own summary is accurate. Every serious defect found in work like this was
invisible to a passing suite and visible to somebody looking for it
deliberately.

Work through the passes in order. Pass 0 first — everything after it depends on
knowing what actually exists.

---

## Rules of engagement

1. **Reproduce before fixing.** Every finding gets a failing test first. If you
   cannot write a test that fails, you have a hypothesis, not a finding — say so
   and move it to the "unverified concerns" list.
2. **Try to refute your own findings.** Before reporting, spend real effort
   arguing the code is actually correct. Report only what survives. Note what
   you refuted, so nobody re-investigates it.
3. **Never weaken a test to make it pass.** Never delete a failing test, relax an
   assertion, add a skip, or widen a threshold to get green. If a test is wrong,
   say why in the report and fix it deliberately with the reasoning recorded.
4. **Fix what is small and certain.** Ask before anything architectural,
   ambiguous, or touching a compliance rule. Batch the questions; do not
   drip-feed.
5. **Verify each fix twice**: the new test passes, then the **whole** suite
   passes. Focused runs hide collisions.
6. **Rank by consequence, not by ease.** A defect that could send a wrong
   rescission notice outranks twenty style issues.
7. **No cosmetic churn.** This pass does not reformat, rename, or refactor for
   taste.

---

## Pass 0 — Ground truth: what actually exists

Before judging quality, establish reality. Produce
`docs/review/inventory.md`:

- **Every capability claimed** anywhere — README, docs, PR descriptions, ADRs,
  the program brief — as a list.
- For each: **the reachable path**. Which UI control, API route, CLI verb,
  workflow step, or agent tool invokes it? Name the file and line.
- **Flag anything with no caller.** A module with tests and no invoker is inert;
  it is the single most common way a feature is "done" but does not exist.
  Verify by grepping for the symbol outside its own tests.
- **Flag anything claimed that is not built**, and anything built that is not
  claimed (undocumented surface area is also a defect).

Report the gap list before continuing. It usually reframes everything else.

---

## Pass 1 — Does it actually work

Walk the real journeys end to end, as a user, in a running system with seeded
data. Not unit tests — the actual product.

For each of: **a case arriving → being worked → an approval → an action → the
audit record**; **an external agent enrolling → screening → reporting → being
revoked**; **a config change → diff → impact → publish → revert**; **a
subject-rights deletion**; **a shadow-mode run**:

- Does every step work?
- Does the record afterwards actually reflect what happened?
- Can a fresh user complete it without you narrating?
- What breaks if you do it twice, do it backwards, refresh mid-flight, lose
  network, or hit Back?

---

## Pass 2 — Adversarial correctness

Hunt these specific classes. Each has cost real programs real money.

**Approval and effect binding**
- Can an approved request be **swapped** for a different one before it executes?
  The commit must verify a digest of exactly what was approved.
- Is an approval **single-use**? Try to spend one twice, in parallel.
- If the approval ledger is bounded, can an **old id resurrect** once it ages
  out? There must be a floor below which everything is refused.
- Does a **terminal state outlive expiry**? A replayed commit on an action that
  already fired must hear "already done," never "expired, submit again" — the
  latter is an instruction to duplicate the effect.
- Does the **kill switch re-bind at commit**? Disable the integration or revoke
  the actor while an approval sits in the queue, then commit. It must refuse.

**Concurrency and state**
- Two processes committing the same action simultaneously — exactly one effect?
- Does a write decided from a **stale read** clobber state another process has
  claimed? Every conditional update needs its condition inside the lock or the
  statement.
- If a worker **dies mid-effect**, what state is left? It must be reported
  indeterminate and never auto-retried.
- Does an error path **leak a reserved slot**, a lock, or a pending row that can
  never be resolved?

**Replay and idempotency**
- Replay a valid signed or authenticated request. Refused?
- Replay it **against a different worker or process**. Still refused? An
  in-memory nonce cache is not replay protection in a multi-worker deployment.
- Is the replay ledger bounded **per actor** rather than globally? A global cap
  lets one busy actor lock everyone else out.
- Every side-effecting step: does a retry produce one effect or two?

**Input handling**
- Are bounds enforced **before** screening, per field? If several fields are
  concatenated and then truncated for scanning, pad one to push another outside
  the window.
- Does an **erroring screen deny**? A screen that cannot answer is not an answer
  of "clean."
- Malformed config, corrupt store, unreadable file — does each **fail closed**?
  Flip every one and watch.

**Boring but lethal**
- Any **float used for money**? Any naive datetime? Any deadline computed
  outside the rule engine?
- **Timezone**: DST transitions, midnight boundaries, a jurisdiction different
  from the server's.
- **Namespace collisions**: a new CLI verb shadowing an existing one, two routes
  matching the same path, duplicate config keys. Only a full-suite run and a
  command-surface listing catch these.
- **N+1 queries**, unbounded result sets, missing indexes on the queue's sort
  and filter columns.
- Migrations: **zero-downtime and reversible**? Test against a copy with data.

---

## Pass 3 — Security

- **Authorization is server-side, on every path.** Try each protected action as
  each role, including via the API directly and via the copilot. The copilot is
  the most likely bypass: an action a user cannot perform in the UI must not
  become possible by asking for it.
- **Object-level authorization**: change an id in a URL or payload to another
  party's record. Refused?
- **The copilot sees only what this user may see** — verify at the retrieval
  layer, not by prompt instruction.
- **Prompt injection**: a poisoned document, an owner message, an uploaded PDF,
  a field in a synced record. Does it change behavior, exfiltrate, or invoke a
  tool?
- **Secrets**: grep the repo, the logs, the audit payloads, and error responses.
  Are credentials resolved by reference at use time rather than stored?
- **PII in audit rows** — the chain should carry identifiers and digests, not
  personal data.
- **Session handling**: expiry, revocation on role change, and logout actually
  invalidating.
- **Dependencies**: known vulnerabilities, an SBOM that regenerates, pinned
  versions.
- **Egress**: can any component reach a host outside the allowlist?

---

## Pass 4 — Compliance and domain correctness

This is where a defect becomes a lawsuit rather than a ticket.

- **Rescission math**, per jurisdiction on file: weekend and holiday starts, DST,
  leap day, exact midnight, business-day counting, tolling, later-of triggers.
  Compare against the statute text, not against the code's own comments. A
  jurisdiction with no rule must **error**, never default.
- **Every deadline records the rule version and citation** it used, and a rule
  change does not retroactively reinterpret a closed case.
- **The contact gate cannot be bypassed** — find every outbound path and prove it
  goes through the single gate. Consent, DNC, quiet hours in the *recipient's*
  timezone, frequency caps, revocation, holds.
- **Evidence is stored with the message**, not merely computed.
- **Fair lending**: if anything prioritizes, scores, or sequences consumers, has
  disparate impact been tested and recorded? Is a human the decision-maker
  wherever the outcome could be adverse?
- **PCI**: confirm no PAN is accepted, stored, logged, or transmitted anywhere,
  including error paths and support tooling.
- **Retention and deletion**: run a subject-rights deletion. Are personal fields
  and artifacts actually gone from every store, including backups policy and
  search indexes? **Does the audit chain still verify afterwards?**
- **Citations**: pick ten model outputs and check each cited passage actually
  says what the answer claims. This is the single highest-value manual check in
  the whole pass.

---

## Pass 5 — Data integrity

- Run the **chain verification** on a populated system. Then corrupt one row and
  confirm it reports the first break and where.
- Are illegal **state transitions** actually rejected by the model layer, or only
  by convention? Try them directly.
- Do the **cost rollups** reconcile — steps sum to case, cases sum to the report?
- Is there any path that writes a consequential record **without** a case
  reference?
- Restore a backup into a scratch environment and confirm the system starts,
  the chain verifies, and the counts match.

---

## Pass 6 — Reliability and operations

- **Kill things.** Stop the database mid-workflow. Stop a worker mid-step. Make
  the model provider time out, rate-limit, and return garbage. Make an
  integration return 500s. For each: does it degrade explicitly, park for a
  human, or refuse — and does it recover cleanly when the dependency returns?
- **Restore drill**, executed, timed, and recorded against the stated RTO/RPO.
- **Every alert has a runbook**, and the runbook actually works when followed by
  someone who did not write it.
- **Containment controls stop in-flight work**, not just new work. Test it.
- Logs have correlation ids that let you follow one case across components.
- The health check tells the truth — force each unhealthy condition and confirm
  it reports.

---

## Pass 7 — Performance

- Load the queue with realistic volume (**at least 3× expected peak**) and
  measure the hot paths against the stated budgets, on a mid-range machine.
- Profile the slowest three endpoints; look for N+1s, missing indexes, and
  serialized calls that could be concurrent.
- Check the table renders 10,000 rows without jank.
- Confirm no layout shift on the hot paths, and that typing is never blocked.

---

## Pass 8 — The quality bar

Against the design spec's definition of done, screen by screen, in **light,
dark, and reduced-transparency**, screenshots captured:

- Purpose clear in five seconds; primary action obvious.
- Every number has a comparison; every chart's title is a question; denominators
  shown.
- Empty, loading, error, permission-denied, and read-only states designed.
- Fully keyboard operable; focus visible; shortcuts documented.
- Contrast verified **against the composite** on every glass surface.
- Then the harder set: does it feel instant, would you screenshot it, would a
  designer you admire wince, is there one thing here no comparable product does,
  and would a skeptical supervisor resent going back to their old tool?

Report each screen as **correct** or **finished** — they are different, and
saying "correct, not finished" is a legitimate and useful answer.

---

## Pass 9 — The buyer's gauntlet

Would someone actually pay for this? Simulate the people who decide.

**The security reviewer.** Fill in a vendor security questionnaire (SIG Lite or
CAIQ shape) **from the code**, not from intentions. Every answer must be
supported by something you can point at. Note every question you cannot answer
truthfully — that list is the real backlog.

**The risk committee.** Write the one-page answer to: who authorized this, what
happens when it is wrong, how do we stop it, what evidence exists afterwards,
and what is the worst case. If any answer is hand-waving, that is a finding.

**The IT operator.** Following only the documentation, deploy to a clean
environment, configure it, create a user, run a case, take a backup, restore it,
and upgrade a version. Every stumble is a defect against the docs.

**The new engineer.** From a clean clone and the README alone, get it running
locally. Time it. Anything over fifteen minutes is a finding.

**The end user.** Sit a real person in front of it for an hour with real work.
Say nothing. Write down every hesitation, every wrong turn, every moment they
looked for something that was not there. Hesitations are defects with owners.

**The procurement question:** what would make MVW say no? Write that list
honestly. It is more valuable than any feature.

---

## Pass 10 — Honesty audit

Read every claim the project makes about itself — README, docs, PR
descriptions, the demo script, any deck — and verify it against the code.

- Delete or correct anything aspirational, out of date, or true-only-in-theory.
- Any benchmark or measurement: is it reproducible right now, and does the
  write-up state plainly what was and was not measured?
- Does the demo run **twice in a row identically from a cold start**?
- Is there any place where the software says it did something it did not do?
  That is the most serious class of defect in a governance product, because the
  entire value proposition is that the record is true.

---

## How to report

Produce `docs/review/findings.md`:

For each finding, in severity order:

```
### F-014  Approved action can execute after the integration is disabled
Severity: HIGH — a governed write bypasses an operator kill switch
Where:    services/execution/commit.py:212
Repro:    tests/review/test_commit_rebinding.py::test_disabled_connector_refuses
          (currently failing — this is the reproduction)
Cause:    The commit path validates the approval and the digest but never
          re-checks the connector allowlist, which is only consulted when the
          action is first proposed.
Fix:      Re-run the full admission chain at commit. A human's approval is
          necessary, not sufficient.
Risk:     Low — the check already exists; this calls it in a second place.
Status:   Fixed / Asking first / Documented (with reason)
```

Then a **state of the build** summary, written for the owner, covering:

1. What is genuinely production-ready.
2. What works but is not ready, and what it needs.
3. What is claimed but not true (fixed or corrected).
4. What is missing that a buyer will ask for.
5. The three things you would fix next, and why those three.

End with an honest verdict on the question that started this pass: **would
someone buy this today, and if not, what specifically is in the way?** Answer it
plainly. A confident "no, because of these four things" is far more useful than
an optimistic yes.

---

## Done means

- Every Pass-0 gap either closed or documented with a reason.
- Every finding reproduced, fixed or explicitly deferred with the owner's
  agreement, and verified by a test that failed before and passes now.
- The whole test suite green, and the new review tests permanently in it.
- No test weakened, skipped, or deleted to achieve green.
- The findings report and the state-of-the-build summary written and honest.
