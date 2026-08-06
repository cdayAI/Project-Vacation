import type { ActionDefinition } from "../guard/registry.js";

/**
 * Action names this module performs, and the one descriptor the platform
 * catalogue does not yet carry.
 *
 * The canonical catalogue is `src/actions.ts`: one flat, readable list of
 * everything the platform can do, which is what lets a risk reviewer read the
 * whole capability surface at once. This module deliberately does not keep a
 * second copy of it — two catalogues would eventually disagree about a risk
 * tier, and the registry would reject the duplicate at startup.
 *
 * What is here:
 *
 *   - The two action *names*, as constants, so the services below reference
 *     them rather than repeating string literals that a rename would miss.
 *   - `KNOWLEDGE_ACTIONS`, holding only descriptors the catalogue is missing.
 *     It should shrink to empty: the entry belongs in `src/actions.ts` beside
 *     the others, and this array exists so the capability is not silently
 *     unregisterable while that move happens.
 */

/** Screen a document and add it to a corpus. Declared in the platform catalogue. */
export const INGEST_DOCUMENT_ACTION = "knowledge.ingest_document";

/** Attest that a corpus is current, resetting its review cadence. */
export const RECORD_CORPUS_REVIEW_ACTION = "knowledge.record_corpus_review";

/**
 * Descriptors this module needs that the platform catalogue does not declare.
 *
 * `knowledge.record_corpus_review` requires step-up re-authentication despite
 * being `sensitive` rather than `high_consequence`. It is an attestation: the
 * named reviewer is asserting that a body of authority is current. It is also
 * the only way to silence a staleness refusal, which makes it the obvious thing
 * to click when the platform is refusing to answer and someone is in a hurry.
 * Re-authentication is a small, deliberate speed bump on exactly that path.
 */
export const KNOWLEDGE_ACTIONS: readonly ActionDefinition[] = [
  {
    name: RECORD_CORPUS_REVIEW_ACTION,
    risk: "sensitive",
    description:
      "Attest that a corpus has been reviewed and its authority is current, resetting its review cadence.",
    // Reversible in the sense that matters: the previous review date is
    // recoverable from the audit trail, and a mistaken attestation is corrected
    // by a real review rather than by editing a timestamp.
    reversible: true,
    requiresStepUp: true,
    allowedRoles: ["compliance_reviewer", "platform_admin"],
  },
];
