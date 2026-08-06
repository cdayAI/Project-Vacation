# ADR 0016 — Agents that run elsewhere are governed here, not orchestrated here

**Status:** Accepted
**Date:** 2026-08-06

## Context

MVW's teams and vendors are already building agents outside this platform —
inside their CRM, inside a cloud provider's agent service, inside products that
were bought rather than written. Each is an unsupervised actor touching owner
data and potentially taking regulated actions. The question "who authorised
that, and where is the record?" is being asked about them now, not after the
first workflow ships here.

Two responses were available and both are wrong.

**Ignore them.** Then the platform's operating record, cost report and audit
chain describe a fraction of the AI activity in the business, while presenting
themselves as the record. That is worse than having no record: a partial report
that looks complete is what an audit finding is made of.

**Absorb them.** Rewrite each agent to run as a workflow here. That is a
multi-year negotiation with every team and every vendor, it discards work
already delivered, and it fails on the ones that cannot move at all — an agent
embedded in a purchased product has no port to move to.

## Decision

**An agent that runs elsewhere cannot be orchestrated here. It can be fully
governed and accounted for here.**

So the platform builds no execution model, no scheduler and no state machine
for somebody else's agent. It builds an admission chain the agent must pass, a
record of everything it did, and — where it wants the platform to take an
action on its behalf — a governed path with a human in it.

This is a first-wave capability, delivered alongside the governance spine and
before the first business workflow. Retrofitting governance onto agents already
in production is far harder than admitting them properly, and every month of
delay adds agents that will have to be retrofitted.

### What that means concretely

**Enrollment is the basis of admission.** An unenrolled caller is refused;
there is no anonymous access and no default-allow. A registry entry carries the
accountable owner, the department, the host platform, the purpose, the
permitted tools, a risk ceiling, a spend ceiling with its budget period, a
wall-clock ceiling, the data scope, and an expiry. Re-enrolling adjusts those.
It never resets a spend meter and never lifts a containment, because either
would make re-enrollment the documented route around a limit.

**The operator's risk rating floors the agent's declaration.** External tool
names are arbitrary strings chosen by whoever built the agent. An agent calling
`issue_refund` may declare it routine, through carelessness or otherwise. The
grant carries the operator's rating and the effective tier is the higher of the
two — a declaration can raise a tier and never lower one.

**Identity is proof, not a shared string.** Four credential kinds: a bearer
token shown once and stored as a hash; a signed JWT assertion verified offline
against a local key file, with the subject claim required to equal the enrolled
agent id and asymmetric algorithms only; an HMAC whose secret is stored as a
*name* resolved from the secret manager at verify time; and a signed envelope
over a pinned public key, domain-separated across identity, timestamp, nonce
and body digest. An agent holding any strong credential is refused plain bearer
authentication, because otherwise the stronger credential is decorative.

**Four inbound operations, and nothing else.** Screen a proposed action before
acting; report a completed run, exactly once, keyed on the agent's idempotency
key; run a live episode whose heartbeat reply is the kill switch; and ask the
platform to perform a governed action. Reads run immediately. Writes are
two-phase and digest-bound: the first call parks an approval carrying a preview
a human can read and a hash of the exact request, and the agent re-sends the
byte-identical request to commit.

**The heartbeat reply is the only kill switch there can be.** We cannot reach
into another company's runtime and stop a process. The one moment an external
agent is reachable is when it next asks us something, so containment,
revocation, expiry and reclamation are all delivered in the answer to a
heartbeat — and a run that stops beating is reclaimed rather than assumed
healthy.

**Repeated denials contain the agent; our own failures do not.** An agent that
keeps asking for things it may not have is broken or hostile, and the only
lever we hold is to stop answering. But if our database is unreachable the
agent sees a denial it did nothing to earn, and counting that would contain a
well-behaved team for our outage. Denials carry a class, and only misbehaviour
reaches the ledger the containment threshold reads.

**One record.** Everything lands in the same operating record, the same
approval queue and the same audit chain as native work, under a principal
marked external. There is no second runs table, no second queue, and no second
cost report. A supervisor sees all the work in one place and a finance report
counts all the spend in one figure.

## Consequences

The plane is composed whether or not it is switched on, so its first exercise
is not the day somebody enables it in production. `PV_EXTERNAL_AGENTS_ENABLED`
decides whether the inbound surface answers, not whether the controls exist —
and with the plane on, an unenrolled caller is still refused, so enabling it
grants no access by itself.

Governed execution needs connectors somebody deliberately exposed. There is no
pass-through and no "call this URL for me": an unregistered operation is
refused rather than attempted, and the registry — not the caller — decides
whether an operation is a read or a write, because a caller that could declare
its own mode could have a write run immediately.

The commit path re-runs the whole admission chain. A human's approval is
necessary and not sufficient: an operator who revokes an agent or disables a
connector while an approval sits in the queue has stopped the commit, not
merely the next request.

A worker that dies between starting an outbound write and recording its result
leaves the action `indeterminate`, and it is never retried automatically. The
effect may or may not have landed and only the system of record knows, so the
operator is told to go and look rather than offered a button that might
duplicate a payment.

## What this does not do

It does not make the platform responsible for what an external agent does
outside these four operations. An agent that calls its own vendor API directly
is invisible here, and no amount of enrollment changes that. What enrollment
buys is that everything the agent asks *us* for is governed and recorded, and
that an operator has a stop button that works — which is the difference between
an actor nobody can account for and one that can be accounted for, contained,
and revoked.
