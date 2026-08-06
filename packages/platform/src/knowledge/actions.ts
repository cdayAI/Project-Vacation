import type { ActionDefinition } from "../guard/registry.js";

/**
 * The effects this module can produce, declared for the action registry.
 *
 * Both of them change what the platform will later assert as authority, which
 * is why neither is `routine`. Ingesting a document decides what a future
 * answer will cite; recording a review decides whether a stale corpus keeps
 * answering regulated questions. Getting either wrong is not visible at the
 * moment it happens — it surfaces later, inside an answer someone acted on.
 *
 * `knowledge.record_corpus_review` requires step-up re-authentication despite
 * being `sensitive` rather than `high_consequence`. It is an attestation: the
 * named steward is asserting that this body of authority is current. It is also
 * the only way to silence a staleness refusal, which makes it the obvious thing
 * to click when the platform is refusing to answer and someone is in a hurry.
 * Re-authentication is a small, deliberate speed bump on exactly that path.
 *
 * Registration happens in the composition root, not here. This module exports
 * the definitions and does not reach into a registry it does not own.
 */
export const KNOWLEDGE_ACTIONS: readonly ActionDefinition[] = [
  {
    name: "knowledge.ingest_document",
    risk: "sensitive",
    description:
      "Screen a source document and add it to a corpus, where it becomes authority the platform will cite in future answers.",
    // Reversible in the sense that matters: a mistaken document is superseded
    // by a corrected version with a new effective window, and the mistake stays
    // visible in the record rather than being erased.
    reversible: true,
    allowedRoles: ["knowledge_steward", "compliance_officer", "system"],
  },
  {
    name: "knowledge.record_corpus_review",
    risk: "sensitive",
    description:
      "Attest that a corpus has been reviewed and its authority is current, resetting its review cadence.",
    reversible: true,
    requiresStepUp: true,
    allowedRoles: ["knowledge_steward", "compliance_officer"],
  },
];

export const INGEST_DOCUMENT_ACTION = "knowledge.ingest_document";
export const RECORD_CORPUS_REVIEW_ACTION = "knowledge.record_corpus_review";
