# ADR 0005 — Approvals are bound to a proposal digest, single-use, and N-of-M

**Status:** Accepted
**Date:** 2026-08-06

## Context

"Requires human approval" is the control MVW's risk committee will lean on
hardest, and it is the control most often implemented in a way that does not
survive contact with an adversary or a race condition.

The naive implementation stores an approval flag against a request id. Four
things go wrong with it, and all four are ordinary rather than exotic:

1. **Swap after approval.** A human approves "write off $200"; the underlying
   proposal is then edited to "$200,000" before execution. The flag still says
   approved.
2. **Self-approval.** The person who requested the action approves it. The
   control now certifies only that someone clicked twice.
3. **Replay.** The same approval is redeemed by two concurrent executions. Both
   read `granted`, both proceed.
4. **Staleness.** An approval granted weeks ago authorises an action taken
   today under circumstances the approver never saw.

## Decision

An approval is a first-class record with four binding properties, implemented
in `guard/approvals.ts` and `guard/port.ts`.

**Bound to a digest.** Every approval carries `proposalDigest`, a SHA-256 over
the canonical JSON of exactly what is proposed. Consumption recomputes and
compares. If the proposal changed, consumption fails with
`approval.digest_mismatch` — and that check runs *before* the status check, so
a swapped proposal is reported as a swap rather than as an incidental
already-used error. Canonical JSON (`kernel/canonical.ts`) exists so that the
same logical proposal always produces the same digest.

**Segregation of duties.** A requester cannot approve their own request. Checked
by actor identity, not by role.

**N-of-M, atomically.** N distinct approvers drawn from M eligible roles. The
store's `recordApprovalDecision` rejects a second decision from the same actor
as a single atomic operation, so one person cannot satisfy a 2-of-M requirement
by racing two requests.

**Single-use, by compare-and-set.** `consumeApproval` is
`UPDATE ... WHERE status = 'granted' RETURNING *`. Exactly one of N concurrent
callers gets the row; the others get null and are denied as replays. Read-then-
write would not be enough and is explicitly called out in the port contract.

**Expiring.** Checked on decision and again on consumption, because time passes
between them.

Two supporting decisions in `guard/authorize.ts`:

- Approval is consumed **last**, after every free check has passed. Consuming
  an approval is destructive; burning a human's decision and then failing a
  role check would force them to approve again for no reason.
- The consumed approval's `action` must match the action being performed. A
  granted approval for a cheap action must not be redeemable against an
  expensive one.

## Consequences

- Callers must compute a proposal digest before requesting approval and present
  the identical proposal at execution. That is a real constraint on how
  workflows are written, and it is the point.
- An approver's decision is auditable against a specific artifact, which is what
  makes the approvals queue evidence rather than a log of clicks.
- 2-of-M configurations need at least two eligible humans available, which is
  an operational commitment MVW must staff. The approvals queue surfaces ageing
  requests so that commitment is visible rather than discovered at a deadline.
- Expired approvals produce rework. The default 24-hour window is configurable
  per request; the right value is a policy question for MVW, not an engineering
  one.

## Alternatives considered

**Approval as a boolean on the request row.** Rejected — it is exactly the
naive implementation whose four failure modes are listed above.

**Cryptographic signature by the approver over the proposal.** Stronger: it
would resist a compromised application server, which digest binding does not.
Rejected for this release because it requires per-user signing keys and a key
lifecycle that MVW's identity provider does not obviously supply. Recorded in
the not-production-grade list as the next increment for the highest-consequence
actions.
