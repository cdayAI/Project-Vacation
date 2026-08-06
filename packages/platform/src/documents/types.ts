import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";

/**
 * Governed document generation: the shapes.
 *
 * Vacation ownership runs on documents. An owner letter, a rescission
 * acknowledgement, a disclosure, an association board pack — each is a thing
 * somebody may later have to defend, sometimes years later, sometimes in front
 * of a regulator. So generation is treated as a governed action rather than
 * string formatting, and the artifacts carry the same properties the rest of
 * the platform's controls do.
 *
 * Four decisions run through every type here.
 *
 * *A template version is an artifact, not a row somebody edits.* It has a named
 * owner, an approval history, and a body digest, and once approved it is
 * immutable. A correction is a new version. That is the only shape in which
 * "which text did we send in March" stays answerable, and it is the same reason
 * the knowledge corpus never edits a document in place.
 *
 * *One body, many formats.* The approved artifact is the template body, and the
 * renderers derive plain text and HTML from that one string. There is no
 * separate HTML body a reviewer did not read. It costs expressiveness — no
 * hand-authored markup in a template — and buys the guarantee that every format
 * of a document says the same words counsel approved.
 *
 * *A generated document records what produced it.* Template version, body
 * digest, a digest of the data merged in, the model if any wrote part of it,
 * the approval that let it happen and who granted it, and the operating-record
 * run it belongs to. Not the inputs themselves — digests — for the same reason
 * the audit log holds fingerprints.
 *
 * *Audience is a property of the template, not of the call site.* A template
 * marked `consumer` cannot be generated without passing the contact gate, and
 * no caller can opt out of that by passing a flag. See `generate.ts`.
 */

/**
 * Who the document is for.
 *
 * The distinction is load-bearing rather than descriptive: it selects the
 * action that is authorized, how many people must approve the template, and
 * whether the contact gate applies at all.
 */
export const TEMPLATE_AUDIENCES = ["internal", "consumer"] as const;
export type TemplateAudience = (typeof TEMPLATE_AUDIENCES)[number];

/**
 * Renderable output formats.
 *
 * `text` and `html` are built. `pdf` and `docx` are declared and deliberately
 * unimplemented — see `formats.ts` for the seam and for what MVW has to confirm
 * before either is built. They are named here rather than omitted so that a
 * template declaring one fails with an explanation instead of an unknown-value
 * error that reads like an oversight.
 */
export const OUTPUT_FORMATS = ["text", "html", "pdf", "docx"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type TemplateStatus = "draft" | "approved" | "retired";

/**
 * One reviewer's decision on one template version.
 *
 * `bodyDigest` binds the decision to the exact text that was read. A reviewer
 * approves *that* body; if the stored body were ever to differ, the approval
 * would not match it and the version could not be used. This is the same
 * digest-binding the guard module applies to action approvals, applied to the
 * artifact rather than to the act.
 */
export interface TemplateApproval {
  readonly actor: ActorRef;
  readonly decision: "approved" | "rejected";
  readonly decidedAt: IsoTimestamp;
  /** The body the reviewer actually read. */
  readonly bodyDigest: Digest;
  readonly note?: string | undefined;
  /** Whether the reviewer had re-authenticated recently enough. */
  readonly steppedUp: boolean;
}

/**
 * One immutable version of one template.
 *
 * Versions are per `name` and monotonic. A template is never edited: a change
 * is version N+1, which starts as a draft and needs its own approvals.
 */
export interface Template {
  readonly id: Id<"template">;
  /** Stable machine name, e.g. `owner.rescission_acknowledgement`. */
  readonly name: string;
  /** 1-based, monotonic within `name`. */
  readonly version: number;
  readonly audience: TemplateAudience;
  /** Accountable team or role. Never a personal email address. */
  readonly owner: string;
  readonly status: TemplateStatus;
  /** One sentence an approver reads before deciding. */
  readonly description: string;
  /**
   * The template text. Plain text with `{{variable}}` placeholders and blank
   * lines between paragraphs. Not markup: see the module header.
   */
  readonly body: string;
  readonly bodyDigest: Digest;
  /**
   * Every variable the body uses, declared explicitly.
   *
   * Checked against the body at registration, both ways: a placeholder that is
   * not declared and a declaration that is not used are both refused. The first
   * would let an undeclared value be merged into a legal document; the second
   * is usually a rename that half happened.
   */
  readonly declaredVariables: readonly string[];
  /** Formats this version may be rendered to. */
  readonly outputFormats: readonly OutputFormat[];
  /** BCP 47 tag for the body's language, e.g. `en`. */
  readonly language: string;
  /** Distinct approvers needed before this version may be used. */
  readonly approvalsRequired: number;
  readonly createdBy: string;
  readonly createdAt: IsoTimestamp;
  /** Every decision, including rejections. Ordered oldest first. */
  readonly approvals: readonly TemplateApproval[];
  readonly approvedAt?: IsoTimestamp | undefined;
  readonly retiredAt?: IsoTimestamp | undefined;
}

/** What a caller supplies to register a new draft version. */
export interface TemplateDraft {
  readonly name: string;
  readonly audience: TemplateAudience;
  readonly owner: string;
  readonly description: string;
  readonly body: string;
  readonly declaredVariables: readonly string[];
  readonly outputFormats: readonly OutputFormat[];
  readonly language?: string | undefined;
  /** Overrides the audience default. May raise the bar, never lower it. */
  readonly approvalsRequired?: number | undefined;
}

/** A rendered document, before it is recorded. */
export interface RenderedDocument {
  readonly format: OutputFormat;
  readonly body: string;
  readonly outputDigest: Digest;
  /** MIME type, for a delivery adapter and for the console. */
  readonly contentType: string;
}

/** Values merged into a template. Primitives only; see `templates.ts`. */
export type TemplateValues = Readonly<Record<string, string | number | boolean>>;

/**
 * One generated document.
 *
 * The metadata row outlives the body: retention deletes the text of an expired
 * document and keeps everything else, so "a letter of this version was
 * generated from this data on this date, approved by these people" stays
 * answerable after the letter itself is gone.
 */
export interface GeneratedDocument {
  readonly id: Id<"document">;
  readonly templateId: Id<"template">;
  readonly templateName: string;
  readonly templateVersion: number;
  /** The body digest of the approved version this came from. */
  readonly templateBodyDigest: Digest;
  /** Fingerprint of the merged values. Never the values. */
  readonly dataDigest: Digest;
  /** Set when a model wrote any part of the data merged in. */
  readonly modelId?: string | undefined;
  readonly audience: TemplateAudience;
  readonly format: OutputFormat;
  readonly outputDigest: Digest;
  /** The rendered text, while retention permits keeping it. */
  readonly body: string | null;
  readonly bodyRetained: boolean;
  /** The operating-record run this document belongs to. Required. */
  readonly runId: Id<"run">;
  readonly correlationId?: string | undefined;
  readonly generatedBy: string;
  readonly generatedAt: IsoTimestamp;
  /** The guard approval consumed, when the action required one. */
  readonly approvalId?: Id<"approval"> | undefined;
  /** Actor ids of the people who granted that approval. */
  readonly approvedBy: readonly string[];
  /** Fingerprint of the contact-gate evidence, for consumer-facing documents. */
  readonly contactEvidenceDigest?: Digest | undefined;
  /** Opaque reference to whom it is about. Never owner personal data. */
  readonly subjectRef?: string | undefined;
  /**
   * The audit entry recording the generation.
   *
   * A document without one is **inert**: its receipt never landed, so it must
   * not be delivered or relied on. The same two-phase shape the knowledge
   * corpus and the contact gate use — an artifact the audit log does not know
   * about must not be able to have an effect.
   */
  readonly receiptId?: Id<"auditEntry"> | undefined;
  readonly bodyPurgedAt?: IsoTimestamp | undefined;
}

export interface TemplateFilter {
  readonly name?: string | undefined;
  readonly audience?: TemplateAudience | undefined;
  readonly status?: TemplateStatus | undefined;
}

export interface DocumentFilter {
  readonly runId?: Id<"run"> | undefined;
  readonly templateName?: string | undefined;
  readonly audience?: TemplateAudience | undefined;
  readonly subjectRef?: string | undefined;
  readonly limit?: number | undefined;
}
