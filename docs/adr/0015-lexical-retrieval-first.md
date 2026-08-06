# ADR 0015 — Lexical retrieval first; a vector index is deferred, not excluded

**Status:** Accepted
**Date:** 2026-08-06

## Context

The knowledge layer serves regulated questions: state rescission rules, HOA
governing documents, disclosure templates, contact and consent policy, internal
SOPs. Its non-negotiable properties are provenance on every chunk, citations in
every answer, effective-dating so the system can answer what a rule said on a
past date, and a refusal when nothing adequate is found.

Retrieval quality matters, but it is second to those properties. An answer that
retrieves the right passage without provenance is unusable in a regulated
context; an answer that retrieves a slightly less apt passage with a citation a
compliance reviewer can click through to is useful.

## Decision

**Start with lexical retrieval (BM25-style scoring) over the curated corpora.
Do not add an embedding service in this release.**

The reasoning is specific to this corpus rather than a general preference:

- The material is statutory and procedural text where the query and the source
  share vocabulary. "Florida rescission period" appears near those words in the
  statute. This is the case where lexical retrieval is strongest and semantic
  search adds least.
- Corpora are curated and modest, not a web-scale index.
- An embedding service is another network dependency in the request path,
  another vendor in the data-flow map and the DPA, and another place owner or
  privileged material could be sent. Each is answerable, but each is a question
  procurement will ask, and the retrieval quality gain here does not obviously
  pay for them.
- Lexical scoring is explainable. When a compliance reviewer asks why a passage
  was retrieved, term overlap is an answer. An embedding distance is not.
- It is deterministic, which the seeded demo requires.

The retrieval interface is a port, and `retrieve.ts` documents where a vector
index slots in. Moving to hybrid retrieval later is a change behind that
interface, not a change to the answer contract.

## Consequences

- Recall is weaker where a question and the authority use different vocabulary
  — a query about "cooling-off period" against a statute that says "right of
  cancellation". Mitigated in the near term by curated synonyms at ingestion
  and by the fact that a miss produces a *refusal and a routing to a human*,
  not a wrong answer. That is the correct failure direction, but it does cost
  operator time and should be measured.
- Retrieval quality belongs in the evaluation harness like everything else, so
  the decision to add embeddings can be made from measured recall on real
  questions rather than from intuition.
- No embedding vendor appears in the data inventory or the subprocessor list
  for this release, which simplifies both.

## Alternatives considered

**Hybrid lexical plus dense retrieval from the start.** Better recall, and the
likely end state. Deferred because it adds a vendor and a dependency before we
have measured whether the recall gap is real for this corpus.

**A managed RAG service.** Rejected: provenance, effective-dating, and the
no-grounding-no-answer rule are the product here, and a service that owns
chunking and retrieval owns exactly the properties we cannot compromise on.
