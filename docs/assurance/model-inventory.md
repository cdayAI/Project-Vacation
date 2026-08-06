# Model inventory

**Last reviewed:** 2026-08-06.

> **The authoritative inventory is the code, not this document.**
> `packages/platform/src/models/inventory.ts` is the source of truth, and
> `pnpm --filter @pv/platform exec tsx src/cli/main.ts actions list` plus the
> console's model view render it live. This document explains the design and
> records the open questions; a hand-maintained copy of the table would drift
> and be worse than none.

---

## 1. How a model is chosen

**Business logic never names a model.** It names a *logical task* —
`rescission.extract_contract_facts`, `knowledge.answer_with_citations` — and
the inventory resolves that task to a concrete provider, model, version,
parameters, and fallback chain from configuration (ADR 0013).

An unknown task is refused with `model.not_in_inventory` rather than defaulting
to something. An architecture test fails the build if a concrete model
identifier appears anywhere outside the inventory and the configuration loader.

Four things follow from that single rule, and they are the reason for it:

- The inventory is a true record rather than documentation that drifts.
- Changing which model serves a task is a reviewable configuration change that
  re-runs the affected role's evaluation set.
- Cost is attributable per task, because the per-token rates live on the entry.
- Graceful degradation is centralised: one fallback walk, one place that records
  `model.degraded`, one place that refuses with `model.provider_unavailable`
  when the whole chain is exhausted.

## 2. Tiers

Three bindings, so that task assignment is a judgement about the work rather
than about a price list:

| Tier | Used for | Notes |
| --- | --- | --- |
| Deep | Extraction and drafting a person will sign | Highest cost, deepest reasoning |
| Balanced | The working default | Near-deep quality, roughly a third of the cost |
| Fast | Classification and short bounded judgements | Cheap, low latency |

Every fallback chain degrades **toward a cheaper, faster model of the same
provider**, never sideways to a different one.

## 3. Two properties that are deliberately uncomfortable

Both are shipped as warnings rather than quietly defaulted, because both are
decisions the customer has to make and neither should be made by an engineer
picking a plausible value.

### 3.1 `dataRetention: "unconfirmed"` on every entry

No entry claims that zero data retention or a no-training commitment is in
place, because none has been confirmed in writing. Every entry raises an
inventory warning that the console and this artifact surface.

**This is a production blocker** (`not-production-grade.md` item B2), and it is
enforced rather than merely documented: the configuration loader refuses to
start in production with the fake provider, so the platform cannot currently run
in production at all until a real provider is configured — and configuring one
without the terms is the decision this warning exists to prevent.

What is needed: written confirmation from the provider that MVW data is not
retained beyond the request and is not used for training, recorded in the
repository and referenced from the entry.

### 3.2 `modelVersion: "unpinned"`

The shipped identifiers are floating aliases. An alias moves to a new revision
with no change on our side — which defeats the entire purpose of an inventory,
because the record would say one thing while the behaviour changed underneath
it.

Before production, every entry must name the **dated snapshot** MVW approved.
Until then the inventory answers "which family serves this task" but not "which
exact model produced this output", and the second is the question an
investigation asks.

## 4. Known limitation: single-provider fallback

Every fallback chain stays within one provider. **A provider-wide outage takes
every task with it**, degrading to a refusal rather than a wrong answer — the
right failure direction, but a full stop.

Adding a second provider is a contracting decision before it is an engineering
one: it means a second set of data-handling terms, a second subprocessor in the
DPA, and a second entry in the data-flow map. Adding one here without those in
place would be worse than the outage it prevents.

The interface supports it whenever MVW wants it: a fallback entry names its own
provider, so a cross-provider chain is a configuration change.

## 5. Change control

A model or prompt change is a reviewable change to version-controlled
artifacts, and:

1. Prompts live in source control and are **never edited in a database**.
2. Changing a task's binding re-runs the affected role's golden set.
3. The evaluation gate fails CI on a regression below threshold.
4. Every invocation records the resolved model and prompt version against the
   run, so "which model produced this output" is answerable from the operating
   record for any past action — which is what makes the incident procedure for
   *when the AI is wrong* executable rather than aspirational.

## 6. What is recorded per invocation

Task, resolved provider and model, prompt version, **prompt digest**,
**response digest**, token counts, cost, latency, and outcome.

Digests only. The prompt and response text are not written to the audit log — a
test asserts that the text cannot be reconstructed from the audit endpoint.

## 7. Open questions for MVW

1. **Approved providers and models**, and whether the tiering above matches
   MVW's procurement position.
2. **Zero retention and no training on MVW data, in writing.** Blocking.
3. **Where the keys live** — which secret manager, and who can rotate them.
4. **Dated model snapshots** to pin each entry to.
5. Whether a **second provider** is wanted for resilience, and if so which.
