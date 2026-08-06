# Operator guide

For the people who use the console daily: owner-services agents, supervisors,
compliance reviewers, and association managers.

You do not need to know how the platform is built to use it well. You do need to
know four things, and this guide is mostly those four.

---

## 1. The platform proposes. You decide what matters.

The platform runs in one of four modes, and the mode tells you what it is
allowed to do without you.

| Mode | What the platform does | What you do |
| --- | --- | --- |
| **Shadow** | Works alongside you and records what it *would* have done. Nothing it produces reaches anyone. | Your normal job. The platform is learning from the comparison. |
| **Assisted** | Drafts the work. | Edit and commit. Your edits are the signal that improves it. |
| **Supervised** | Prepares the action fully. | Approve before the effect lands. |
| **Bounded autonomy** | Acts on its own for low-risk, high-confidence cases within explicit limits. Everything else parks for you. | Handle what parks. |

A workflow moves up this ladder only when there is evidence it should —
golden-set accuracy, shadow disagreement rate, incident history. Not on a date,
and not because someone is impatient.

**Nothing with a consumer-adverse consequence ever runs in bounded autonomy.**
If an outcome could go against an owner, a person decides. The platform gathers
the evidence.

---

## 2. Refusals are the platform working

You will see refusals. They are not errors and not failures.

The platform refuses when it cannot do something safely: an approval is
missing, a spending limit is reached, an operator has paused something, a
document looks like it is trying to give instructions, or — importantly — when a
piece of it cannot reach the information it needs to be sure.

That last one is the one worth internalising. **When the platform is unsure, it
stops rather than guessing.** A refusal that says "no rule found for this state"
means exactly that: it does not know, so it is not going to invent an answer. A
legal deadline is not a thing to guess at.

Every refusal tells you the reason in plain language and what you can do next.
If a refusal is wrong or unclear, that is worth reporting — it becomes an
observation, and observations become improvements.

---

## 3. The screens

### Work queue

Everything waiting on you or your team. Sortable and filterable by status and
mode.

**SLA breaches are called out in text, not just in colour.** If an item has
passed its target, it says so. Do not rely on noticing a colour.

Each row shows what the item is waiting on and what it has cost so far.

### Approvals queue

The most important screen in the product. When you approve something here, you
are authorising **exactly what is shown**, and nothing else.

What to check before you approve:

- **The proposal itself**, field by field. It is rendered in full, not
  summarised.
- **The risk tier and whether it is reversible.** An irreversible action is
  labelled. Read those twice.
- **Who else has approved**, when N-of-M applies.
- **The expiry.** Approvals expire; an expired one means the work has to be
  re-proposed.

Two things the platform enforces so you do not have to remember them:

- **You cannot approve your own request.** If you raised it, the decide controls
  are disabled and say why.
- **What you approved cannot be changed afterwards.** Your approval is bound to
  a fingerprint of the exact proposal. If anything about it changes, execution
  fails rather than proceeding with something you did not see.

Some approvals require you to re-authenticate first. The screen tells you before
you commit, not after.

### Run detail

The full step trail for one piece of work: every step, its status, how long it
took, what it cost, and — where a step was refused — why, in plain language.

Citations appear here. Where the platform relied on a document, you can see the
document, its version, and its effective date, and click through to the passage.
**If a source is out of date, it is flagged.** Do not rely on a stale citation
without checking.

### Workflow instance

For supervisors. Where a piece of multi-step work is, why it is stuck, what it
has cost, and what it is waiting for — written to be read without an engineer.

### Audit and evidence

For compliance reviewers, and usable without help.

Search by event type, actor, run, subject, or date. The chain verification
status is shown at the top: it should say the chain is intact. If it does not,
that is an incident — tell your platform team immediately and do not try to fix
anything yourself.

One thing that surprises people: **the log records fingerprints of the
information a decision used, not the information itself.** It proves that a
particular decision was made from a particular input; to see the input, you go
to the system that holds it, under that system's own access rules. This is
deliberate — it keeps owner data from accumulating a second copy in a
seven-year record. The screen explains it too.

### Executive view

The metrics MVW management named publicly, alongside what the platform
contributed.

**Every tile says where its number came from.** Some come from MVW's own
reporting and some from this platform. That distinction is on the screen on
purpose, so nobody has to guess whether a movement is ours.

---

## 4. When something is wrong

**Stop it first, diagnose second.** If the platform is producing bad output,
tell your supervisor or platform team to pause it. The controls take effect in
seconds and can be as narrow as a single workflow or as broad as everything.
Pausing is cheap; letting bad output continue is not.

**Say what you saw.** Corrections, rejected proposals, and overrides are
captured as evidence. They are how failure patterns get found. A correction you
make silently helps one case; a correction the platform records helps every
future case.

**Escalate immediately, without waiting, if:**

- a statutory deadline may have been missed or miscalculated
- something reached an owner that should not have
- the audit chain verification says the chain is not intact
- you are asked to bypass an approval or a control

None of those are judgement calls. Escalate and let someone senior decide.

---

## 5. Accessibility

The console is built to WCAG 2.2 AA and is fully keyboard operable. Light and
dark themes are both supported; the toggle is in the header and your choice is
remembered.

Automated checks run on every build, but they catch roughly half of what
matters. **If something is hard to use with a keyboard or a screen reader, that
is a defect — please report it.** It will not be found automatically.

---

## 6. Getting help

Escalation path and support contacts: see `support-and-escalation.md`.

If the platform did something you do not understand, the run detail view is the
place to start. It shows every step, in order, with the reason for each outcome.
That is what it is for.
