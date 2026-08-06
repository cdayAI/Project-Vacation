import { DeniedError, InvalidInputError, InvariantError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc } from "../record/migrations.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";
import { storeUnavailable, type Db } from "../store/db.js";
import type { DocumentStore } from "./port.js";
import {
  assertGeneratedDocumentWritable,
  assertTemplateDraftWritable,
} from "./store.memory.js";
import type {
  DocumentFilter,
  GeneratedDocument,
  OutputFormat,
  Template,
  TemplateApproval,
  TemplateAudience,
  TemplateFilter,
  TemplateStatus,
} from "./types.js";

/**
 * Postgres templates and generated documents.
 *
 * Three operations do their work in the database rather than in the
 * application, because each is a rule about concurrent writers:
 *
 *   - `putTemplate` computes the next version inside a transaction that takes
 *     an advisory lock on the template name. The unique index on
 *     `(name, version)` is the unconditional backstop: if the lock were ever
 *     wrong, the second writer fails its INSERT instead of quietly creating a
 *     second body under one version number.
 *
 *   - `recordTemplateApproval` inserts the decision first, so the unique index
 *     over `(template_id, actor_id)` decides who wins between two simultaneous
 *     clicks from one reviewer, and only then updates the status. Doing it the
 *     other way round would let a duplicate decision flip the status before the
 *     index rejected it.
 *
 *   - `putGeneratedDocument` uses `ON CONFLICT (id) DO NOTHING`, so a retry
 *     after a crash records one document.
 *
 * Approvals live in their own table and are read back with the template, rather
 * than being an array column. Appending to an array column is a
 * read-modify-write of the whole template, which is the shape that loses a
 * decision under concurrency.
 */

type TemplateRow = {
  id: string;
  name: string;
  version: number;
  audience: string;
  owner: string;
  status: string;
  description: string;
  body: string;
  body_digest: string;
  declared_variables: string[];
  output_formats: string[];
  language: string;
  approvals_required: number;
  created_by: string;
  created_at: string;
  approved_at: string | null;
  retired_at: string | null;
};

type ApprovalRow = {
  template_id: string;
  actor: ActorRef;
  decision: string;
  decided_at: string;
  body_digest: string;
  note: string | null;
  stepped_up: boolean;
};

type DocumentRow = {
  id: string;
  template_id: string;
  template_name: string;
  template_version: number;
  template_body_digest: string;
  data_digest: string;
  model_id: string | null;
  audience: string;
  format: string;
  output_digest: string;
  body: string | null;
  body_retained: boolean;
  run_id: string;
  correlation_id: string | null;
  generated_by: string;
  generated_at: string;
  approval_id: string | null;
  approved_by: string[];
  contact_evidence_digest: string | null;
  subject_ref: string | null;
  receipt_id: string | null;
  body_purged_at: string | null;
};

const TEMPLATE_COLUMNS = `id, name, version, audience, owner, status, description, body,
  body_digest, declared_variables, output_formats, language, approvals_required, created_by,
  created_at, approved_at, retired_at`;

const APPROVAL_COLUMNS = `template_id, actor, decision, decided_at, body_digest, note, stepped_up`;

const DOCUMENT_COLUMNS = `id, template_id, template_name, template_version, template_body_digest,
  data_digest, model_id, audience, format, output_digest, body, body_retained, run_id,
  correlation_id, generated_by, generated_at, approval_id, approved_by, contact_evidence_digest,
  subject_ref, receipt_id, body_purged_at`;

/**
 * Stable 63-bit key for a template name, for `pg_advisory_xact_lock`.
 *
 * Version assignment has to serialise per name, and there is no row to lock
 * before the first version of a name exists. An advisory lock keyed on the name
 * covers that case; the unique index covers the case where this is wrong.
 */
function nameLockKey(name: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const codeUnit of name) {
    hash ^= BigInt(codeUnit.codePointAt(0) ?? 0);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  // Fold into the signed 64-bit range Postgres accepts.
  return BigInt.asIntN(64, hash);
}

export class PgDocumentStore implements DocumentStore {
  constructor(private readonly db: Db) {}

  async putTemplate(template: Omit<Template, "version">): Promise<Template> {
    assertTemplateDraftWritable(template);

    return this.guard("putTemplate", () =>
      this.db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock($1)", [nameLockKey(template.name).toString()]);

        const highest = (
          await tx.query<{ version: number | null }>(
            "SELECT max(version) AS version FROM document_template WHERE name = $1",
            [template.name],
          )
        )[0];
        const version = Number(highest?.version ?? 0) + 1;

        const inserted = (
          await tx.query<TemplateRow>(
            `INSERT INTO document_template (${TEMPLATE_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NULL,NULL)
             RETURNING ${TEMPLATE_COLUMNS}`,
            [
              template.id,
              template.name,
              version,
              template.audience,
              template.owner,
              template.status,
              template.description,
              template.body,
              template.bodyDigest,
              JSON.stringify([...template.declaredVariables]),
              JSON.stringify([...template.outputFormats]),
              template.language,
              template.approvalsRequired,
              template.createdBy,
              template.createdAt,
            ],
          )
        )[0];
        if (!inserted) throw new InvariantError(`Template ${template.id} was not written.`);
        return toTemplate(inserted, []);
      }),
    );
  }

  async getTemplate(id: Id<"template">): Promise<Template | null> {
    return this.guard("getTemplate", async () => {
      const row = (
        await this.db.query<TemplateRow>(
          `SELECT ${TEMPLATE_COLUMNS} FROM document_template WHERE id = $1`,
          [id],
        )
      )[0];
      if (!row) return null;
      return toTemplate(row, await this.approvalsFor(row.id));
    });
  }

  async findTemplate(name: string, version: number): Promise<Template | null> {
    return this.guard("findTemplate", async () => {
      const row = (
        await this.db.query<TemplateRow>(
          `SELECT ${TEMPLATE_COLUMNS} FROM document_template WHERE name = $1 AND version = $2`,
          [name, version],
        )
      )[0];
      if (!row) return null;
      return toTemplate(row, await this.approvalsFor(row.id));
    });
  }

  async latestApprovedTemplate(name: string): Promise<Template | null> {
    return this.guard("latestApprovedTemplate", async () => {
      const row = (
        await this.db.query<TemplateRow>(
          `SELECT ${TEMPLATE_COLUMNS} FROM document_template
           WHERE name = $1 AND status = 'approved'
           ORDER BY version DESC LIMIT 1`,
          [name],
        )
      )[0];
      if (!row) return null;
      return toTemplate(row, await this.approvalsFor(row.id));
    });
  }

  async listTemplates(filter: TemplateFilter = {}): Promise<readonly Template[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    const add = (clause: (placeholder: string) => string, value: unknown): void => {
      values.push(value);
      clauses.push(clause(`$${values.length}`));
    };
    if (filter.name !== undefined) add((p) => `name = ${p}`, filter.name);
    if (filter.audience !== undefined) add((p) => `audience = ${p}`, filter.audience);
    if (filter.status !== undefined) add((p) => `status = ${p}`, filter.status);

    return this.guard("listTemplates", async () => {
      const rows = await this.db.query<TemplateRow>(
        `SELECT ${TEMPLATE_COLUMNS} FROM document_template
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY name ASC, version ASC`,
        values,
      );
      const out: Template[] = [];
      for (const row of rows) out.push(toTemplate(row, await this.approvalsFor(row.id)));
      return out;
    });
  }

  async recordTemplateApproval(
    id: Id<"template">,
    approval: TemplateApproval,
    nextStatus: TemplateStatus,
    approvedAt?: IsoTimestamp,
  ): Promise<Template> {
    assertIsoUtc("decidedAt", approval.decidedAt);

    return this.guard("recordTemplateApproval", () =>
      this.db.transaction(async (tx) => {
        const current = (
          await tx.query<TemplateRow>(
            `SELECT ${TEMPLATE_COLUMNS} FROM document_template WHERE id = $1 FOR UPDATE`,
            [id],
          )
        )[0];
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

        // The decision lands first, so the unique index over
        // (template_id, actor_id) is what decides between two simultaneous
        // clicks from one reviewer. Flipping the status first would let a
        // duplicate approve the version before the index rejected it.
        const written = await tx.query<{ template_id: string }>(
          `INSERT INTO document_template_approval (${APPROVAL_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (template_id, actor_id) DO NOTHING
           RETURNING template_id`,
          [
            id,
            approval.actor,
            approval.decision,
            approval.decidedAt,
            approval.bodyDigest,
            approval.note ?? null,
            approval.steppedUp,
          ],
        );
        if (written.length === 0) {
          throw new DeniedError(
            "approval.already_used",
            `${approval.actor.actorId} has already decided on ${current.name}@${current.version}.`,
            { templateId: id, actorId: approval.actor.actorId },
          );
        }

        const updated = (
          await tx.query<TemplateRow>(
            `UPDATE document_template SET status = $2, approved_at = $3
             WHERE id = $1 RETURNING ${TEMPLATE_COLUMNS}`,
            [id, nextStatus, nextStatus === "approved" ? (approvedAt ?? approval.decidedAt) : null],
          )
        )[0];
        if (!updated) throw new InvariantError(`Template ${id} status was not updated.`);

        const approvals = await tx.query<ApprovalRow>(
          `SELECT ${APPROVAL_COLUMNS} FROM document_template_approval
           WHERE template_id = $1 ORDER BY ordinal ASC`,
          [id],
        );
        return toTemplate(updated, approvals.map(toApproval));
      }),
    );
  }

  async retireTemplate(id: Id<"template">, retiredAt: IsoTimestamp): Promise<Template> {
    assertIsoUtc("retiredAt", retiredAt);
    return this.guard("retireTemplate", () =>
      this.db.transaction(async (tx) => {
        const current = (
          await tx.query<TemplateRow>(
            `SELECT ${TEMPLATE_COLUMNS} FROM document_template WHERE id = $1 FOR UPDATE`,
            [id],
          )
        )[0];
        if (!current) {
          throw new DeniedError("record.unavailable", `Template ${id} does not exist.`, {
            templateId: id,
          });
        }
        if (current.status === "retired") {
          return toTemplate(current, await this.approvalsFor(id, tx));
        }
        if (current.status !== "approved") {
          throw new InvalidInputError(
            `Template ${current.name}@${current.version} is a draft; there is nothing in service to retire.`,
            "status",
          );
        }
        const updated = (
          await tx.query<TemplateRow>(
            `UPDATE document_template SET status = 'retired', retired_at = $2
             WHERE id = $1 AND status = 'approved' RETURNING ${TEMPLATE_COLUMNS}`,
            [id, retiredAt],
          )
        )[0];
        if (!updated) throw new InvariantError(`Template ${id} was not retired.`);
        return toTemplate(updated, await this.approvalsFor(id, tx));
      }),
    );
  }

  async putGeneratedDocument(document: GeneratedDocument): Promise<GeneratedDocument> {
    assertGeneratedDocumentWritable(document);

    return this.guard("putGeneratedDocument", async () => {
      const inserted = (
        await this.db.query<DocumentRow>(
          `INSERT INTO generated_document (${DOCUMENT_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
           ON CONFLICT (id) DO NOTHING
           RETURNING ${DOCUMENT_COLUMNS}`,
          [
            document.id,
            document.templateId,
            document.templateName,
            document.templateVersion,
            document.templateBodyDigest,
            document.dataDigest,
            document.modelId ?? null,
            document.audience,
            document.format,
            document.outputDigest,
            document.body,
            document.bodyRetained,
            document.runId,
            document.correlationId ?? null,
            document.generatedBy,
            document.generatedAt,
            document.approvalId ?? null,
            JSON.stringify([...document.approvedBy]),
            document.contactEvidenceDigest ?? null,
            document.subjectRef ?? null,
            document.receiptId ?? null,
            document.bodyPurgedAt ?? null,
          ],
        )
      )[0];
      if (inserted) return toDocument(inserted);

      // A retry of a generation that already landed.
      const existing = (
        await this.db.query<DocumentRow>(
          `SELECT ${DOCUMENT_COLUMNS} FROM generated_document WHERE id = $1`,
          [document.id],
        )
      )[0];
      if (!existing) {
        throw new InvariantError(`Document ${document.id} was neither inserted nor found.`);
      }
      return toDocument(existing);
    });
  }

  async attachDocumentReceipt(
    id: Id<"document">,
    receiptId: Id<"auditEntry">,
  ): Promise<GeneratedDocument> {
    return this.guard("attachDocumentReceipt", async () => {
      const updated = (
        await this.db.query<DocumentRow>(
          `UPDATE generated_document SET receipt_id = $2
           WHERE id = $1 AND receipt_id IS NULL RETURNING ${DOCUMENT_COLUMNS}`,
          [id, receiptId],
        )
      )[0];
      if (updated) return toDocument(updated);

      const current = (
        await this.db.query<DocumentRow>(
          `SELECT ${DOCUMENT_COLUMNS} FROM generated_document WHERE id = $1`,
          [id],
        )
      )[0];
      if (!current) {
        throw new DeniedError("record.unavailable", `Document ${id} does not exist.`, {
          documentId: id,
        });
      }
      return toDocument(current);
    });
  }

  async getGeneratedDocument(id: Id<"document">): Promise<GeneratedDocument | null> {
    const rows = await this.guard("getGeneratedDocument", () =>
      this.db.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS} FROM generated_document WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toDocument(row) : null;
  }

  async listGeneratedDocuments(
    filter: DocumentFilter = {},
  ): Promise<readonly GeneratedDocument[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    const add = (clause: (placeholder: string) => string, value: unknown): void => {
      values.push(value);
      clauses.push(clause(`$${values.length}`));
    };
    if (filter.runId !== undefined) add((p) => `run_id = ${p}`, filter.runId);
    if (filter.templateName !== undefined) add((p) => `template_name = ${p}`, filter.templateName);
    if (filter.audience !== undefined) add((p) => `audience = ${p}`, filter.audience);
    if (filter.subjectRef !== undefined) add((p) => `subject_ref = ${p}`, filter.subjectRef);

    let sql = `SELECT ${DOCUMENT_COLUMNS} FROM generated_document
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY ordinal ASC`;
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      sql += ` LIMIT $${values.length}`;
    }

    const rows = await this.guard("listGeneratedDocuments", () =>
      this.db.query<DocumentRow>(sql, values),
    );
    return rows.map(toDocument);
  }

  async purgeDocumentBody(
    id: Id<"document">,
    purgedAt: IsoTimestamp,
  ): Promise<GeneratedDocument> {
    assertIsoUtc("purgedAt", purgedAt);
    return this.guard("purgeDocumentBody", async () => {
      // One-way and idempotent: `COALESCE` keeps the first purge time, so a
      // second sweep does not rewrite when the text went. The row itself is
      // never deleted — it is the evidence the document existed.
      const updated = (
        await this.db.query<DocumentRow>(
          `UPDATE generated_document
           SET body = NULL, body_retained = false, body_purged_at = COALESCE(body_purged_at, $2)
           WHERE id = $1 RETURNING ${DOCUMENT_COLUMNS}`,
          [id, purgedAt],
        )
      )[0];
      if (!updated) {
        throw new DeniedError("record.unavailable", `Document ${id} does not exist.`, {
          documentId: id,
        });
      }
      return toDocument(updated);
    });
  }

  private async approvalsFor(
    templateId: string,
    tx?: Db,
  ): Promise<readonly TemplateApproval[]> {
    const executor = tx ?? this.db;
    const rows = await executor.query<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM document_template_approval
       WHERE template_id = $1 ORDER BY ordinal ASC`,
      [templateId],
    );
    return rows.map(toApproval);
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof DeniedError ||
        error instanceof InvalidInputError ||
        error instanceof InvariantError
      ) {
        throw error;
      }
      throw storeUnavailable(operation, error);
    }
  }
}

function toTemplate(row: TemplateRow, approvals: readonly TemplateApproval[]): Template {
  return {
    id: row.id as Id<"template">,
    name: row.name,
    version: Number(row.version),
    audience: row.audience as TemplateAudience,
    owner: row.owner,
    status: row.status as TemplateStatus,
    description: row.description,
    body: row.body,
    bodyDigest: row.body_digest as Digest,
    declaredVariables: Object.freeze([...row.declared_variables]),
    outputFormats: Object.freeze([...row.output_formats] as OutputFormat[]),
    language: row.language,
    approvalsRequired: Number(row.approvals_required),
    createdBy: row.created_by,
    createdAt: row.created_at,
    approvals: Object.freeze([...approvals]),
    approvedAt: row.approved_at ?? undefined,
    retiredAt: row.retired_at ?? undefined,
  };
}

function toApproval(row: ApprovalRow): TemplateApproval {
  return {
    actor: row.actor,
    decision: row.decision === "rejected" ? "rejected" : "approved",
    decidedAt: row.decided_at,
    bodyDigest: row.body_digest as Digest,
    note: row.note ?? undefined,
    steppedUp: row.stepped_up,
  };
}

function toDocument(row: DocumentRow): GeneratedDocument {
  return {
    id: row.id as Id<"document">,
    templateId: row.template_id as Id<"template">,
    templateName: row.template_name,
    templateVersion: Number(row.template_version),
    templateBodyDigest: row.template_body_digest as Digest,
    dataDigest: row.data_digest as Digest,
    modelId: row.model_id ?? undefined,
    audience: row.audience as TemplateAudience,
    format: row.format as OutputFormat,
    outputDigest: row.output_digest as Digest,
    // NULL means the text is gone — purged, or never retained. It stays null
    // rather than becoming undefined: "no body" is a fact about this document,
    // not an absent field.
    body: row.body,
    bodyRetained: row.body_retained,
    runId: row.run_id as Id<"run">,
    correlationId: row.correlation_id ?? undefined,
    generatedBy: row.generated_by,
    generatedAt: row.generated_at,
    approvalId: row.approval_id === null ? undefined : (row.approval_id as Id<"approval">),
    approvedBy: Object.freeze([...row.approved_by]),
    contactEvidenceDigest:
      row.contact_evidence_digest === null
        ? undefined
        : (row.contact_evidence_digest as Digest),
    subjectRef: row.subject_ref ?? undefined,
    receiptId: row.receipt_id === null ? undefined : (row.receipt_id as Id<"auditEntry">),
    bodyPurgedAt: row.body_purged_at ?? undefined,
  };
}
