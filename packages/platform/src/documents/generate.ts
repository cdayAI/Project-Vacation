import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { ContactGate } from "../contact/gate.js";
import type {
  ContactChannel,
  ContactEvidence,
  ContactPurpose,
  RecipientRelationship,
} from "../contact/types.js";
import type { ApprovalService } from "../guard/approvals.js";
import type { Authorizer } from "../guard/authorize.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import type { RunStore } from "../record/port.js";
import type { ActorRef, OperatingMode } from "../record/types.js";
import { GENERATE_INTERNAL_ACTION, GENERATE_OWNER_FACING_ACTION } from "./actions.js";
import type { DocumentStore } from "./port.js";
import { TemplateRegistry, renderTemplate } from "./templates.js";
import type {
  DocumentFilter,
  GeneratedDocument,
  OutputFormat,
  RenderedDocument,
  Template,
  TemplateValues,
} from "./types.js";

/**
 * Governed document generation.
 *
 * Generating a document is an action, not a formatting call. It passes the
 * authorization chokepoint like any other effect, and the record it leaves
 * answers the question somebody will eventually ask about a letter: which
 * template version produced it, from what data, with which model involved if
 * any, who approved it, and which unit of work it belonged to.
 *
 * ## Consumer-facing documents pass the contact gate. There is no way round it.
 *
 * The audience is a property of the *template*, decided when the template was
 * approved, and it selects the path here. A template marked `consumer` cannot
 * be generated without a delivery block and a passing contact-gate evaluation,
 * and no argument to this method turns that off. `ContactGate` is a required
 * constructor dependency for the same reason: a deployment cannot end up
 * generating owner letters because nobody wired the gate in.
 *
 * The check has to be dynamic rather than a type constraint, because the
 * audience lives on the stored template and is not known until it is loaded.
 * So it is enforced at the one place every generation passes and covered by a
 * test that a consumer template with no delivery block is refused.
 *
 * *Why check at generation as well as at the send.* Two different failures.
 * Checking here means a letter to an owner who revoked is never produced at
 * all, so it never sits in a queue, an attachment, or a support ticket waiting
 * to leak. Checking again at the send — which `ContactGate.clear()` does — is
 * what catches a revocation that arrives in the minutes between generating a
 * document and delivering it. Neither check makes the other redundant, and the
 * evidence digest recorded on the document is what lets a reviewer see that
 * both happened.
 *
 * ## Order of operations
 *
 * Resolve the template, render, check the gate, then authorize. Rendering is a
 * pure function that can fail for a dozen ordinary reasons — a missing
 * variable, an unsupported format — and authorization consumes an approval,
 * which is destructive. Everything that can refuse for free refuses first,
 * matching the chokepoint's own ordering rule.
 *
 * The document is stored before its audit receipt, and is inert until the
 * receipt is attached. That is the same two-phase shape knowledge ingestion and
 * the contact gate use: writing the audit entry first would leave an entry
 * naming a document that does not exist whenever the store write failed, and a
 * dangling reference in the record is worse than a document that is visibly
 * unfinished. A generated document with no `receiptId` must not be delivered or
 * relied on.
 */

/** Where a consumer-facing document is headed. */
export interface DocumentDelivery {
  readonly subjectRef: string;
  readonly channel: ContactChannel;
  readonly purpose: ContactPurpose;
  readonly relationship: RecipientRelationship;
  /** From `destinationFingerprint()`. This module never sees an address. */
  readonly destinationDigest: string;
  readonly jurisdiction: string;
  /** IANA zone of the recipient. Quiet hours are measured there, not here. */
  readonly recipientTimeZone: string;
}

export interface GenerateRequest {
  readonly templateName: string;
  /** Pin a version. Omitted means the latest approved one. */
  readonly templateVersion?: number | undefined;
  readonly values: TemplateValues;
  readonly format: OutputFormat;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  /** The unit of work this belongs to. Required, and it must exist. */
  readonly runId: Id<"run">;
  readonly correlationId?: string | undefined;
  /** Set when a model wrote any part of the values merged in. */
  readonly modelId?: string | undefined;
  /** Opaque reference to whom the document is about. Never personal data. */
  readonly subjectRef?: string | undefined;
  readonly approvalId?: Id<"approval"> | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
  /**
   * Keep the rendered text. Default true.
   *
   * False produces the metadata row with no body — the same shape retention
   * leaves behind — for a caller that hands the text straight to a delivery
   * adapter and does not want a second copy.
   */
  readonly retainBody?: boolean | undefined;
  /** Required when the template's audience is `consumer`. */
  readonly delivery?: DocumentDelivery | undefined;
}

/** What a generation would produce, without producing it. */
export interface GenerationProposal {
  readonly template: Template;
  readonly rendered: RenderedDocument;
  readonly dataDigest: Digest;
  /** The digest an approval for this generation must be bound to. */
  readonly proposalDigest: Digest;
  /** The action the chokepoint will be asked to authorize. */
  readonly action: string;
}

export class DocumentGenerator {
  constructor(
    private readonly store: DocumentStore,
    private readonly templates: TemplateRegistry,
    private readonly authorizer: Authorizer,
    private readonly approvals: ApprovalService,
    private readonly runs: RunStore,
    /**
     * Required, not optional. An owner-facing document that could be generated
     * because nobody wired a gate in is exactly the failure this module is
     * built to make impossible.
     */
    private readonly contactGate: ContactGate,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Render what would be generated and return the digest an approval binds to.
   *
   * The "proposed" half of propose-then-approve. A caller raises an approval
   * against `proposalDigest`, a human reads the rendered body, and `generate()`
   * recomputes the same digest — so what was approved is what is produced.
   *
   * Performs no authorization and consumes nothing.
   */
  async propose(request: GenerateRequest): Promise<GenerationProposal> {
    const template = await this.templates.requireUsable(
      request.templateName,
      request.templateVersion,
    );
    const rendered = renderTemplate(template, request.values, request.format);
    const dataDigest = digestValue({ values: request.values });
    return {
      template,
      rendered,
      dataDigest,
      proposalDigest: generationProposalDigest(template, dataDigest, request),
      action:
        template.audience === "consumer"
          ? GENERATE_OWNER_FACING_ACTION
          : GENERATE_INTERNAL_ACTION,
    };
  }

  /**
   * Generate one document.
   *
   * @throws {DeniedError} from the contact gate, the chokepoint, the template
   *   registry, or a failed receipt. Every one of them means no document was
   *   produced.
   */
  async generate(request: GenerateRequest): Promise<GeneratedDocument> {
    const { template, rendered, dataDigest, proposalDigest, action } =
      await this.propose(request);

    // The run must exist. A document bound to a run that is not in the
    // operating record is a document with no context: no requester, no cost, no
    // trail leading to why it was produced.
    const run = await this.runs.requireRun(request.runId);

    const documentId = this.ids.next("document");
    let contactEvidence: ContactEvidence | undefined;

    if (template.audience === "consumer") {
      if (!request.delivery) {
        throw new DeniedError(
          "contact.evidence_unavailable",
          `Template ${template.name}@${template.version} is consumer-facing, so generating from it requires the delivery it is destined for — recipient, channel, purpose, jurisdiction, and timezone. Without those the contact gate cannot be asked whether this owner may be contacted, and a document nobody may deliver must not be produced.`,
          { template: template.name, version: template.version },
        );
      }

      // Not `clear()`: generating is not sending, so nothing is recorded
      // against the frequency cap and no approval is consumed here. The send
      // runs the same checks again, and must, because a revocation can arrive
      // in between.
      contactEvidence = await this.contactGate.evaluate({
        subjectRef: request.delivery.subjectRef,
        channel: request.delivery.channel,
        purpose: request.delivery.purpose,
        relationship: request.delivery.relationship,
        destinationDigest: request.delivery.destinationDigest,
        contentDigest: rendered.outputDigest,
        jurisdiction: request.delivery.jurisdiction,
        recipientTimeZone: request.delivery.recipientTimeZone,
        actor: request.actor,
        mode: request.mode,
        runId: request.runId,
        correlationId: request.correlationId,
        templateId: template.id,
        templateVersion: template.version,
        modelId: request.modelId,
        idempotencyKey: `document:${documentId}`,
        secondsSinceAuthentication: request.secondsSinceAuthentication,
      });

      if (!contactEvidence.allowed) {
        const failing = contactEvidence.checks.find((check) => check.outcome !== "pass");
        throw new DeniedError(
          contactEvidence.blockingReason ?? "contact.evidence_unavailable",
          `${template.name}@${template.version} is consumer-facing and the contact gate refused: ${failing?.summary ?? "a required check could not be answered."} No document was produced.`,
          {
            template: template.name,
            version: template.version,
            subjectRef: request.delivery.subjectRef,
            check: failing?.name ?? "unknown",
          },
        );
      }
    }

    const grant = await this.authorizer.authorize({
      action,
      actor: request.actor,
      mode: request.mode,
      runId: request.runId,
      correlationId: request.correlationId,
      subject: {
        template: template.name,
        version: String(template.version),
        audience: template.audience,
        ...(request.subjectRef ? { subjectRef: request.subjectRef } : {}),
      },
      proposalDigest,
      approvalId: request.approvalId,
      secondsSinceAuthentication: request.secondsSinceAuthentication,
    });

    const approvedBy = await this.approversOf(grant.consumedApprovalId);
    const generatedAt = this.clock.nowIso();
    const contactEvidenceDigest = contactEvidence ? digestValue(contactEvidence) : undefined;

    const retainBody = request.retainBody ?? true;
    // Two phases, in this order, for the same reason knowledge ingestion lands
    // a document before activating it and the contact gate stores a clearance
    // before receipting it. The document is written first, without a receipt,
    // and in that state it is inert: nothing may be delivered or relied on
    // until `receiptId` is set. Writing the audit entry first would leave an
    // entry naming a document that does not exist whenever the store write
    // failed — a dangling reference in the one record that is meant to be
    // checkable.
    const stored = await this.store.putGeneratedDocument({
      id: documentId,
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      templateBodyDigest: template.bodyDigest,
      dataDigest,
      modelId: request.modelId,
      audience: template.audience,
      format: rendered.format,
      outputDigest: rendered.outputDigest,
      body: retainBody ? rendered.body : null,
      bodyRetained: retainBody,
      runId: request.runId,
      correlationId: request.correlationId,
      generatedBy: request.actor.actorId,
      generatedAt,
      approvalId: grant.consumedApprovalId,
      approvedBy,
      contactEvidenceDigest,
      subjectRef: request.subjectRef ?? request.delivery?.subjectRef,
    });

    const receipt = await this.audit.record(
      auditDecision({
        eventType: "document.generated",
        actorId: request.actor.actorId,
        actorKind: request.actor.kind,
        actorRoles: request.actor.roles,
        runId: request.runId,
        correlationId: request.correlationId ?? run.correlationId,
        subject: {
          documentId,
          template: template.name,
          version: String(template.version),
          audience: template.audience,
          ...(request.subjectRef ? { subjectRef: request.subjectRef } : {}),
        },
        inputDigests: {
          templateBody: template.bodyDigest,
          // The data, as a fingerprint. The merged values are owner data and
          // belong in the document, not in a seven-year audit record.
          data: dataDigest,
          output: rendered.outputDigest,
          ...(contactEvidenceDigest ? { contactEvidence: contactEvidenceDigest } : {}),
        },
        decision: {
          format: rendered.format,
          bytes: rendered.body.length,
          templateOwner: template.owner,
          ...(request.modelId ? { modelId: request.modelId } : {}),
          ...(grant.consumedApprovalId ? { approvalId: grant.consumedApprovalId } : {}),
          ...(approvedBy.length > 0 ? { approvedBy: approvedBy.join(",") } : {}),
          ...(contactEvidence ? { contactGate: "passed" } : {}),
        },
      }),
    );

    return this.store.attachDocumentReceipt(stored.id, receipt.id);
  }

  get(id: Id<"document">): Promise<GeneratedDocument | null> {
    return this.store.getGeneratedDocument(id);
  }

  list(filter?: DocumentFilter): Promise<readonly GeneratedDocument[]> {
    return this.store.listGeneratedDocuments(filter);
  }

  /**
   * Delete a document's body, keeping everything else.
   *
   * The shape both retention and subject-rights erasure need: the text goes and
   * the record that a disclosure of this version was produced on this date
   * stays. Deleting the row would destroy the evidence that the obligation was
   * met, which is the opposite of what a retention policy is for.
   */
  purgeBody(id: Id<"document">): Promise<GeneratedDocument> {
    return this.store.purgeDocumentBody(id, this.clock.nowIso());
  }

  /** Who granted the approval this generation consumed, if any. */
  private async approversOf(approvalId: Id<"approval"> | undefined): Promise<readonly string[]> {
    if (!approvalId) return Object.freeze([]);
    const approval = await this.approvals.get(approvalId);
    if (!approval) return Object.freeze([]);
    return Object.freeze(
      approval.decisions
        .filter((entry) => entry.decision === "granted")
        .map((entry) => entry.actor.actorId),
    );
  }
}

/**
 * The digest an approval for a generation is bound to.
 *
 * Covers the exact template version, its approved body, the data being merged,
 * the output format, and the subject. Change any of them and the approval no
 * longer matches — which is what stops an approved "send this owner their
 * rescission acknowledgement" being redeemed against a different letter.
 *
 * Deliberately excludes the timestamp and the actor: an approver signs off the
 * document, not the moment it is produced or the operator who clicks the
 * button.
 */
export function generationProposalDigest(
  template: Template,
  dataDigest: Digest,
  request: Pick<GenerateRequest, "format" | "subjectRef" | "modelId" | "delivery">,
): Digest {
  return digestValue({
    action: "document.generate",
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    templateBodyDigest: template.bodyDigest,
    audience: template.audience,
    dataDigest,
    format: request.format,
    modelId: request.modelId ?? null,
    subjectRef: request.subjectRef ?? request.delivery?.subjectRef ?? null,
    deliveryChannel: request.delivery?.channel ?? null,
    deliveryPurpose: request.delivery?.purpose ?? null,
  });
}
