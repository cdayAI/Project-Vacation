import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type {
  DocumentFilter,
  GeneratedDocument,
  Template,
  TemplateApproval,
  TemplateFilter,
  TemplateStatus,
} from "./types.js";

/**
 * Persistence port for templates and generated documents.
 *
 * Three operations carry requirements a read-then-write in the caller cannot
 * meet, so they are single operations here and implemented as such in both
 * adapters.
 *
 *   - `putTemplate` assigns the version number. Two concurrent registrations of
 *     the same template name must produce versions N+1 and N+2, not two rows
 *     both claiming N+1 — which would leave two different bodies with one
 *     identity, and every citation of "version 4" ambiguous.
 *
 *   - `recordTemplateApproval` appends a decision atomically and rejects a
 *     second decision from the same actor. Dual control means N *distinct*
 *     people; a read-modify-write lets one reviewer satisfy a 2-of-N rule by
 *     clicking twice.
 *
 *   - `putGeneratedDocument` is idempotent on the document id, so a retry after
 *     a crash records one document rather than two.
 *
 * There is no update path for an approved template's body, its declared
 * variables, or its output formats — not in this interface, not in either
 * adapter, and not in the Postgres schema, which refuses the write with a
 * trigger. The only status transitions are draft → approved and
 * approved → retired.
 */
export interface DocumentStore {
  /**
   * Store a new draft version.
   *
   * The store assigns `version` as one past the highest existing version of
   * that name, under a lock, and returns the stored template.
   */
  putTemplate(template: Omit<Template, "version">): Promise<Template>;

  getTemplate(id: Id<"template">): Promise<Template | null>;
  findTemplate(name: string, version: number): Promise<Template | null>;
  /** The highest approved, unretired version of a name. */
  latestApprovedTemplate(name: string): Promise<Template | null>;
  listTemplates(filter?: TemplateFilter): Promise<readonly Template[]>;

  /**
   * Atomically append one reviewer's decision.
   *
   * @throws when the reviewer has already decided on this version, or when the
   *   version is no longer a draft.
   */
  recordTemplateApproval(
    id: Id<"template">,
    approval: TemplateApproval,
    nextStatus: TemplateStatus,
    approvedAt?: IsoTimestamp,
  ): Promise<Template>;

  /** Retire an approved version so nothing new may be generated from it. */
  retireTemplate(id: Id<"template">, retiredAt: IsoTimestamp): Promise<Template>;

  /** Store a generated document. Idempotent on id. */
  putGeneratedDocument(document: GeneratedDocument): Promise<GeneratedDocument>;
  /** Attach the audit receipt, once. */
  attachDocumentReceipt(
    id: Id<"document">,
    receiptId: Id<"auditEntry">,
  ): Promise<GeneratedDocument>;
  getGeneratedDocument(id: Id<"document">): Promise<GeneratedDocument | null>;
  listGeneratedDocuments(filter?: DocumentFilter): Promise<readonly GeneratedDocument[]>;

  /**
   * Delete a document's body, keeping every other field.
   *
   * Retention and subject-rights deletion both need this shape: the text goes,
   * the record that it existed and what produced it stays. Deleting the row
   * instead would destroy evidence that a disclosure was sent, which is the
   * opposite of what a retention policy is for.
   */
  purgeDocumentBody(id: Id<"document">, purgedAt: IsoTimestamp): Promise<GeneratedDocument>;
}
