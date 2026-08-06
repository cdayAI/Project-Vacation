# ADR 0001 — Record architecture decisions in this repository

**Status:** Accepted
**Date:** 2026-08-06

## Context

This platform will be handed to MVW's engineers, and reviewed before that by
MVW's risk committee, security team, and procurement. Both audiences will ask
"why is it like this?" about choices whose reasoning is not visible in the code:
why fail-closed everywhere, why an approval is bound to a digest, why there is
no multi-tenancy, why work discovery ships disabled.

Answering those questions from memory does not scale past the first handover
conversation, and answering them inconsistently is worse than not answering.

## Decision

Every consequential decision gets a numbered ADR in `docs/adr/`, written when
the decision is made rather than reconstructed afterwards.

A decision is consequential if it is expensive to reverse, if it constrains
what can be built later, if it is a deliberate refusal to build something, or
if a competent engineer would otherwise reasonably assume the opposite.

Each ADR states the context, the decision, the consequences including the ones
we dislike, and the alternatives rejected. An ADR is superseded rather than
edited: the reasoning that was true at the time stays readable.

## Consequences

- Design review has something concrete to disagree with.
- Handover has a written answer for the predictable questions.
- Deliberate absences — the things in "what not to build" — have a record
  explaining that they were considered and declined, rather than looking like
  oversights.
- There is an ongoing cost: an ADR that nobody updates when the decision
  changes is worse than none, because it is confidently wrong. Superseding is
  therefore part of the process, not an afterthought.

## Alternatives considered

**Design documentation in a wiki.** Rejected: it drifts from the code, and the
handover deliverable is the repository.

**Comments in the code only.** Kept as well — the code carries the *what* and
the local *why* — but a comment cannot hold a rejected alternative or a
cross-cutting posture without bloating the file it lives in.
