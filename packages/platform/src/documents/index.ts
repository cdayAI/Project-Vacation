/**
 * Governed document generation.
 *
 * Vacation ownership runs on documents, and every one of them is something
 * somebody may later have to defend. So generation is an action rather than a
 * formatting call, and the artifacts carry the platform's usual properties.
 *
 * Four rules hold across the module:
 *
 *   - **A template version is immutable once approved.** A change is version
 *     N+1 with its own approvals. Enforced by the store and again by a trigger.
 *   - **Approval is dual control, bound to the body that was read.** Two
 *     distinct approvers for anything an owner will see, and never the author.
 *   - **Substitution is closed and fails on a missing variable.** No expression
 *     evaluation, ever, and never an empty string in place of a deadline.
 *   - **Anything destined for a consumer passes the contact gate**, at
 *     generation and again at delivery. Neither check makes the other
 *     redundant, and the gate is a required dependency so it cannot be
 *     forgotten.
 *
 * PDF and DOCX are a declared, documented seam. See `formats.ts` for what MVW
 * has to confirm before either is built.
 */

export type {
  DocumentFilter,
  GeneratedDocument,
  OutputFormat,
  RenderedDocument,
  Template,
  TemplateApproval,
  TemplateAudience,
  TemplateDraft,
  TemplateFilter,
  TemplateStatus,
  TemplateValues,
} from "./types.js";
export { OUTPUT_FORMATS, TEMPLATE_AUDIENCES } from "./types.js";

export type { DocumentStore } from "./port.js";

export {
  APPROVE_TEMPLATE_ACTION,
  DOCUMENT_ACTIONS,
  GENERATE_INTERNAL_ACTION,
  GENERATE_OWNER_FACING_ACTION,
  REGISTER_TEMPLATE_ACTION,
  RETIRE_TEMPLATE_ACTION,
} from "./actions.js";

export {
  IMPLEMENTED_FORMATS,
  assembleDocument,
  assertFormatRenderable,
  contentTypeFor,
  escapeValue,
  isOutputFormat,
} from "./formats.js";
export type { DocumentMeta } from "./formats.js";

export {
  TemplateRegistry,
  assertDraftWellFormed,
  placeholdersIn,
  renderTemplate,
  substituteTemplate,
} from "./templates.js";
export type { DecideTemplateRequest, RegisterTemplateRequest } from "./templates.js";

export { DocumentGenerator, generationProposalDigest } from "./generate.js";
export type { DocumentDelivery, GenerateRequest, GenerationProposal } from "./generate.js";

export {
  MemoryDocumentStore,
  assertGeneratedDocumentWritable,
  assertTemplateDraftWritable,
  createMemoryDocumentStore,
} from "./store.memory.js";
export { PgDocumentStore } from "./store.pg.js";

export { MIGRATIONS as DOCUMENT_MIGRATIONS } from "./migrations.js";
