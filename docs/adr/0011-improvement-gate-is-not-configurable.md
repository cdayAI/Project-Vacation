# ADR 0011 — The improvement loop's human gate is not configurable

**Status:** Accepted
**Date:** 2026-08-06

## Context

The platform is required to get measurably better over time, and equally
required never to change its own behaviour on its own authority. Those two
requirements are only compatible if there is a human decision in the one place
that matters — between a proposed change and its application.

The pressure to add a bypass is predictable and will not come from bad
intentions. It comes as "auto-apply changes that improve the golden set by more
than 5%", or as a test-only flag, or as a bulk-approve for a backlog of small
prompt tweaks. Each is locally reasonable. Together they are how a governed
system becomes an autonomous one without anyone deciding that it should.

## Decision

**There is no configuration that disables the human gate. None. Not a flag, not
an environment variable, not a test-only bypass.**

`improve/apply.ts` requires an approval id that resolves to a granted,
digest-matching, unconsumed approval. Any attempt to apply without one throws
`DeniedError("improvement.autonomous_application")` and records
`improvement.refused` in the audit log. The tests attempt every plausible
bypass and assert each is refused.

Three supporting boundaries, all enforced rather than documented:

**No self-modifying code.** The loop proposes changes to declarative artifacts
only — prompts, rules, routing, evaluation sets, corpora. An allowlist of
mutable artifact kinds is checked; a proposal targeting platform source is
refused.

**Evaluation sets are protected.** A proposal may *add* cases. It may never
weaken, relabel, or delete an existing expected outcome. Enforced by a guard in
`roles/evaluation.ts` and tested against every mutation shape — deletion,
changed expectation, relaxed assertion, and renaming a case id so the original
is orphaned. Without this, the cheapest way for the loop to improve its score
is to move the goalposts, and it would find that path.

**Golden sets are curated by humans** and are the ground truth of record. The
loop proposes cases; it does not adopt them.

## Consequences

- Improvement throughput is bounded by human review capacity. That is the
  intended constraint, and the queue is designed to make review fast — the
  before and after, the evaluation delta, and the blast radius are computed and
  presented so the decision takes seconds, not an afternoon.
- The claim "no autonomous self-modification" is testable, which is what makes
  it worth anything to a risk committee.
- A future request for auto-apply has to be argued as a change to this ADR and
  to the tests that enforce it, in the open, rather than landing as a
  configuration default.
- Cost: an obviously-good change still waits for a person. Accepted.

## Alternatives considered

**Auto-apply below a risk threshold.** Rejected. The threshold becomes the
control, thresholds drift, and "low risk" is judged by the system proposing the
change.

**Auto-apply with automatic rollback on regression.** Rejected: it detects
regressions the metrics happen to measure, and the failures that matter in a
regulated context are frequently ones the metrics do not capture.
