# Support and escalation

**Last reviewed:** 2026-08-06.

## Who to contact

| Situation | Contact | Timeframe |
| --- | --- | --- |
| A refusal you do not understand | Platform team, normal channel | Business hours |
| A workflow producing wrong output | Platform team **and** your supervisor | Immediately |
| A statutory deadline may be wrong or missed | **MVW legal, immediately**, plus the platform team | Immediately, do not wait |
| Something reached an owner that should not have | MVW legal and MVW privacy | Immediately |
| Audit chain verification failure | **MVW security**, plus the platform team | Immediately |
| Owner data exposure | MVW privacy and MVW security | Immediately |
| A suspected vulnerability | MVW security disclosure process — **not a public issue** | Within 1 business day |
| Work discovery found enabled without written authorisation | MVW privacy and employment counsel | Immediately |
| Accessibility defect | Platform team | Business hours, tracked as a defect |

**Named contacts are MVW's to fill in.** The platform team has not been told
who owns security, privacy, and compliance sign-off — that is on the
consolidated question list, and this table is unusable until it is answered.

## Four things that never wait for a triage queue

Escalate these directly, at any hour, without deciding first whether they are
serious. They are:

1. A statutory deadline that may be wrong or may have passed.
2. Anything incorrect that reached an owner.
3. An audit chain that does not verify.
4. Being asked to bypass an approval or a control.

None is a judgement call for the person who notices it. The cost of escalating
one that turns out to be fine is an apology. The cost of not escalating one that
was not is considerably higher.

## Stop first, diagnose second

If the platform is doing something wrong, pausing it is cheap and reversible.
The containment controls are in the console and the CLI, take effect in about a
second, need no deploy, and can be as narrow as one workflow or as broad as
everything. Engaging one requires a typed reason, which goes in the audit log.

Nobody will be criticised for pausing something that turned out to be fine.

## What the platform team needs from you

When reporting a problem, the single most useful thing is **the run id**. From
it, the run detail view shows every step, its inputs and outputs as digests, its
cost, and the reason for every outcome. That is usually the whole diagnosis.

If a specific output was wrong, say what the correct output would have been.
That becomes a golden-set case, and a golden-set case is what stops the same
error recurring — adding a case is always permitted, weakening one never is.

## Severity, and what to expect

Severity levels, response times, and the incident process are in
`docs/ops/incident-process.md`. Two things worth knowing as a user:

- **SEV1 includes a broken audit chain**, even if nothing else is visibly wrong,
  because the platform's evidentiary claim is not currently true.
- **When the AI is wrong, there is a defined procedure** for finding every
  action a bad model or prompt version touched, and for notifying and
  remediating affected owners. You will be asked for the run id; everything else
  comes from the record.

## Escalation path for the platform itself

1. Platform team — first response, containment, diagnosis.
2. MVW engineering leadership — sustained outage, or a change needed beyond the
   platform team's authority.
3. MVW legal, privacy, security — any of the four items above, in parallel with
   the technical response, not after it.
4. MVW executive — SEV1 within one hour, per the incident process.

## Open questions

These block this document being complete, and are on the consolidated list:

1. Who at MVW owns security sign-off, privacy sign-off, and compliance sign-off?
2. What is the security vulnerability disclosure address?
3. Is there an on-call rota, and who staffs it?
4. What is the out-of-hours path for a statutory-deadline escalation?
