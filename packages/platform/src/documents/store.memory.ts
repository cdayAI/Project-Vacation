import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { isDigest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc } from "../record/migrations.js";
import type { IsoTimestamp } from "../record/types.js";
import type { MemoryDb } from "../store/db.js";
import type { DocumentStore } from "./port.js";
import { OUTPUT_FORMATS, TEMPLATE_AUDIENCES } from "./types.js";
import type {
  DocumentFilter,
  GeneratedDocument,
  Template,
  TemplateApproval,
  TemplateFilter,
  TemplateStatus,
} from "./types.js";

/**
 * In-memory templates and generated documents.
 *
 * Held to the same contract as the Postgres adapter, including the parts that
 * are inconvenient to fake:
 *
 *   - `putTemplate` assigns the version under a per-name lock, mirroring the
 *     unique index on `(name, version)`. Two concurrent registrations produce
 *     N+1 and N+2, not two rows both claiming N+1.
 *   - `recordTemplateApproval` takes a lock and refuses a second decision from
 *     the same reviewer, mirroring the unique index that makes dual control
 *     unconditional.
 *   - an approved version's body, variables, and formats are never rewritten,
 *     the same transitions the Postgres trigger permits and no others.
 *
 * Everything is cloned in and out. A caller holding a reference to a stored
 * template must not be able to edit the body after it was approved.
 */

const TEMPLATES = "document_template";
const DOCUMENTS = "generated_document";

export class MemoryDocumentStore implements DocumentStore {
  constructor(private readonly db: MemoryDb) {}

  async putTemplate(template: Omit<Template, "version">): Promise<Template> {
    assertTemplateDraftWritable(template);

    return this.db.withLock(`documents:template:${template.name}`, async () => {
      const table = this.db.table<Template>(TEMPLATES);
      if (table.has(template.id)) {
        throw new InvalidInputError(`Template ${template.id} already exists.`, "id");
      }
      // Version assignment happens under the lock. Outside it, two registrations
      // would both read the same highest version and both claim the next one,
      // leaving two bodies with one identity — and every generated document
      // cites a version.
      const highest = [...table.values()]
        .filter((existing) => existing.name === template.name)
        .reduce((max, existing) => Math.max(max, existing.version), 0);

      const stored: Template = { ...template, version: highest + 1 };
      table.set(stored.id, structuredClone(stored));
      return structuredClone(stored);
    });
  }

  async getTemplate(id: Id<"template">): Promise<Template | null> {
    const found = this.db.table<Template>(TEMPLATES).get(id);
    return found ? structuredClone(found) : null;
  }

  async findTemplate(name: string, version: number): Promise<Template | null> {
    for (const template of this.db.rows<Template>(TEMPLATES)) {
      if (template.name === name && template.version === version) return structuredClone(template);
    }
    return null;
  }

  async latestApprovedTemplate(name: string): Promise<Template | null> {
    const candidates = this.db
      .rows<Template>(TEMPLATES)
      .filter((template) => template.name === name && template.status === "approved")
      .sort((left, right) => right.version - left.version);
    const latest = candidates[0];
    return latest ? structuredClone(latest) : null;
  }

  async listTemplates(filter: TemplateFilter = {}): Promise<readonly Template[]> {
    return this.db
      .rows<Template>(TEMPLATES)
      .filter((template) => {
        if (filter.name !== undefined && template.name !== filter.name) return false;
        if (filter.audience !== undefined && template.audience !== filter.audience) return false;
        if (filter.status !== undefined && template.status !== filter.status) return false;
        return true;
      })
      .sort((left, right) =>
        left.name === right.name
          ? left.version - right.version
          : left.name < right.name
            ? -1
            : 1,
      )
      .map((template) => structuredClone(template));
  }

  async recordTemplateApproval(
    id: Id<"template">,
    approval: TemplateApproval,
    nextStatus: TemplateStatus,
    approvedAt?: IsoTimestamp,
  ): Promise<Template> {
    assertIsoUtc("decidedAt", approval.decidedAt);
    if (!isDigest(approval.bodyDigest)) {
      throw new InvalidInputError(
        "A template decision must name the digest of the body that was read.",
        "bodyDigest",
      );
    }

    return this.db.withLock(`documents:template:decide:${id}`, async () => {
      const table = this.db.table<Template>(TEMPLATES);
      const current = table.get(id);
      if (!current) {
        throw new DeniedError("record.unavailable", `Template ${id} does not exist.`, {
          templateId: id,
        });
      }
      if (current.status !== "draft") {
        throw new DeniedError(
          "approval.already_used",
          `Template ${current.name}@${current.version} is ${current.status} and can no longer be decided.`,
          { templateId: id, status: current.status },
        );
      }
      // Dual control means N distinct people. Enforced here atomically, the way
      // the Postgres unique index enforces it there, so one reviewer cannot
      // satisfy a 2-of-N rule by clicking twice.
      if (current.approvals.some((entry) => entry.actor.actorId === approval.actor.actorId)) {
        throw new DeniedError(
          "approval.already_used",
          `${approval.actor.actorId} has already decided on ${current.name}@${current.version}.`,
          { templateId: id, actorId: approval.actor.actorId },
        );
      }

      const next: Template = {
        ...current,
        status: nextStatus,
        approvals: Object.freeze([...current.approvals, approval]),
        approvedAt: nextStatus === "approved" ? (approvedAt ?? approval.decidedAt) : undefined,
      };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async retireTemplate(id: Id<"template">, retiredAt: IsoTimestamp): Promise<Template> {
    assertIsoUtc("retiredAt", retiredAt);
    return this.db.withLock(`documents:template:decide:${id}`, async () => {
      const table = this.db.table<Template>(TEMPLATES);
      const current = table.get(id);
      if (!current) {
        throw new DeniedError("record.unavailable", `Template ${id} does not exist.`, {
          templateId: id,
        });
      }
      if (current.status === "retired") return structuredClone(current);
      if (current.status !== "approved") {
        throw new InvalidInputError(
          `Template ${current.name}@${current.version} is a draft; there is nothing in service to retire. Registering a superseding version is the way to abandon a draft.`,
          "status",
        );
      }
      const next: Template = { ...current, status: "retired", retiredAt };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async putGeneratedDocument(document: GeneratedDocument): Promise<GeneratedDocument> {
    assertGeneratedDocumentWritable(document);
    return this.db.withLock(`documents:generated:${document.id}`, async () => {
      const table = this.db.table<GeneratedDocument>(DOCUMENTS);
      const existing = table.get(document.id);
      // Idempotent on id: a retry after a crash records one document, not two.
      if (existing) return structuredClone(existing);
      table.set(document.id, structuredClone(document));
      return structuredClone(document);
    });
  }

  async attachDocumentReceipt(
    id: Id<"document">,
    receiptId: Id<"auditEntry">,
  ): Promise<GeneratedDocument> {
    return this.db.withLock(`documents:generated:${id}`, async () => {
      const table = this.db.table<GeneratedDocument>(DOCUMENTS);
      const current = table.get(id);
      if (!current) {
        throw new DeniedError("record.unavailable", `Document ${id} does not exist.`, {
          documentId: id,
        });
      }
      if (current.receiptId !== undefined) return structuredClone(current);
      const next: GeneratedDocument = { ...current, receiptId };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async getGeneratedDocument(id: Id<"document">): Promise<GeneratedDocument | null> {
    const found = this.db.table<GeneratedDocument>(DOCUMENTS).get(id);
    return found ? structuredClone(found) : null;
  }

  async listGeneratedDocuments(
    filter: DocumentFilter = {},
  ): Promise<readonly GeneratedDocument[]> {
    const rows = this.db.rows<GeneratedDocument>(DOCUMENTS).filter((document) => {
      if (filter.runId !== undefined && document.runId !== filter.runId) return false;
      if (filter.templateName !== undefined && document.templateName !== filter.templateName) {
        return false;
      }
      if (filter.audience !== undefined && document.audience !== filter.audience) return false;
      if (filter.subjectRef !== undefined && document.subjectRef !== filter.subjectRef) {
        return false;
      }
      return true;
    });
    const ordered = rows.map((document) => structuredClone(document));
    return filter.limit !== undefined ? ordered.slice(0, filter.limit) : ordered;
  }

  async purgeDocumentBody(
    id: Id<"document">,
    purgedAt: IsoTimestamp,
  ): Promise<GeneratedDocument> {
    assertIsoUtc("purgedAt", purgedAt);
    return this.db.withLock(`documents:generated:${id}`, async () => {
      const table = this.db.table<GeneratedDocument>(DOCUMENTS);
      const current = table.get(id);
      if (!current) {
        throw new DeniedError("record.unavailable", `Document ${id} does not exist.`, {
          documentId: id,
        });
      }
      // Purging is idempotent and one-way. The row stays: it is the evidence
      // that the document existed, which is what a retention policy protects,
      // not what it destroys.
      const next: GeneratedDocument = {
        ...current,
        body: null,
        bodyRetained: false,
        bodyPurgedAt: current.bodyPurgedAt ?? purgedAt,
      };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }
}

/** Convenience factory matching the Postgres adapter's shape. */
export function createMemoryDocumentStore(db: MemoryDb): MemoryDocumentStore {
  return new MemoryDocumentStore(db);
}

/**
 * Everything both adapters check before a template is allowed to land.
 *
 * Shared rather than duplicated: the in-memory adapter is meant to be exactly
 * as strict as Postgres, and the cheapest way to guarantee that is for both to
 * run the same function. The CHECK constraints in `migrations.ts` restate the
 * subset a database can express.
 */
export function assertTemplateDraftWritable(template: Omit<Template, "version">): void {
  if (template.status !== "draft") {
    // Approval is a separate, recorded decision. A version written straight to
    // approved would skip the reviewers who are the entire control.
    throw new InvalidInputError(
      `A template version is registered as a draft and becomes approved through recorded decisions; received status "${template.status}".`,
      "status",
    );
  }
  if (template.approvals.length > 0) {
    throw new InvalidInputError(
      "A new draft cannot arrive with approvals already attached.",
      "approvals",
    );
  }
  if (!TEMPLATE_AUDIENCES.includes(template.audience)) {
    throw new InvalidInputError(`Unknown audience "${String(template.audience)}".`, "audience");
  }
  if (typeof template.owner !== "string" || template.owner.trim().length === 0) {
    throw new InvalidInputError("A template needs a named accountable owner.", "owner");
  }
  if (typeof template.body !== "string" || template.body.trim().length === 0) {
    throw new InvalidInputError("A template needs a body.", "body");
  }
  if (!isDigest(template.bodyDigest)) {
    throw new InvalidInputError(
      `Template bodyDigest must be a sha256 digest, received: ${String(template.bodyDigest)}`,
      "bodyDigest",
    );
  }
  if (template.outputFormats.length === 0) {
    throw new InvalidInputError(
      "A template must declare at least one output format.",
      "outputFormats",
    );
  }
  for (const format of template.outputFormats) {
    if (!OUTPUT_FORMATS.includes(format)) {
      throw new InvalidInputError(`Unknown output format "${String(format)}".`, "outputFormats");
    }
  }
  if (!Number.isInteger(template.approvalsRequired) || template.approvalsRequired < 1) {
    throw new InvalidInputError(
      `approvalsRequired must be a whole number of at least 1; received ${String(template.approvalsRequired)}.`,
      "approvalsRequired",
    );
  }
  if (template.audience === "consumer" && template.approvalsRequired < 2) {
    throw new InvalidInputError(
      "A consumer-facing template needs at least two distinct approvers. The first reader is usually the author of the change.",
      "approvalsRequired",
    );
  }
  assertIsoUtc("createdAt", template.createdAt);
}

export function assertGeneratedDocumentWritable(document: GeneratedDocument): void {
  for (const [field, value] of [
    ["templateBodyDigest", document.templateBodyDigest],
    ["dataDigest", document.dataDigest],
    ["outputDigest", document.outputDigest],
  ] as const) {
    if (!isDigest(value)) {
      throw new InvalidInputError(
        `Generated document ${field} must be a sha256 digest, received: ${String(value)}`,
        field,
      );
    }
  }
  if (typeof document.runId !== "string" || document.runId.length === 0) {
    throw new InvalidInputError(
      "A generated document must name the operating-record run it belongs to. A document with no run has no requester, no cost, and no trail leading to why it was produced.",
      "runId",
    );
  }
  if (document.bodyRetained && document.body === null) {
    throw new InvalidInputError(
      "A document that claims to retain its body must carry one.",
      "body",
    );
  }
  if (!document.bodyRetained && document.body !== null) {
    throw new InvalidInputError(
      "A document that does not retain its body must not carry one; the two flags cannot disagree.",
      "body",
    );
  }
  if (document.audience === "consumer" && !document.contactEvidenceDigest) {
    // The structural half of "anything destined for a consumer passes the
    // contact gate": even a caller writing straight to the store cannot record
    // an owner-facing document without the fingerprint of the evaluation that
    // permitted it.
    throw new InvalidInputError(
      "A consumer-facing document must carry the fingerprint of the contact-gate evidence that permitted producing it.",
      "contactEvidenceDigest",
    );
  }
  assertIsoUtc("generatedAt", document.generatedAt);
}
