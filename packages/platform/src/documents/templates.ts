import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { Authorizer } from "../guard/authorize.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import type { ActorRef, OperatingMode } from "../record/types.js";
import {
  APPROVE_TEMPLATE_ACTION,
  REGISTER_TEMPLATE_ACTION,
  RETIRE_TEMPLATE_ACTION,
} from "./actions.js";
import { assembleDocument, escapeValue, isOutputFormat } from "./formats.js";
import type { DocumentStore } from "./port.js";
import { TEMPLATE_AUDIENCES } from "./types.js";
import type {
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

/**
 * The template registry.
 *
 * A template version is a governed artifact: named owner, approval history,
 * immutable once approved. The registry enforces four things that would
 * otherwise depend on everyone remembering them.
 *
 * *Versions are immutable once approved.* There is no edit. A correction is
 * version N+1 with its own approvals, which is the only shape that keeps "which
 * text did the owner actually receive last March" answerable. The store refuses
 * the write and the Postgres trigger refuses it again.
 *
 * *Approval is dual control, natively.* A consumer-facing template needs two
 * distinct approvers by default, the person who registered it cannot approve
 * it, and the store rejects a second decision from the same reviewer
 * atomically. Note what is deliberately *not* here: approving a template does
 * not itself go through the guard's approval machinery. That would be an
 * approval requiring an approval — the template approval **is** the human
 * decision, and expressing it twice would mean two records of one act. What the
 * chokepoint does contribute is the role check and step-up re-authentication.
 *
 * *An approval is bound to the body that was read.* `TemplateApproval` carries
 * the body digest, the same way a guard approval is bound to a proposal digest.
 * A reviewer approves that text and no other.
 *
 * *Substitution is closed and fails on a missing value.* See
 * {@link substituteTemplate}, which is where the interesting failure modes are.
 */

/**
 * The one placeholder form. Lower snake case, nothing else.
 *
 * Deliberately narrow. A permissive placeholder grammar is how a template
 * language grows an expression evaluator, and an expression evaluator running
 * over data merged from a system of record is a remote code execution surface
 * inside a letter generator.
 */
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** A single merged value longer than this is a payload, not a field. */
const MAX_VALUE_CHARS = 4_000;

const DEFAULT_APPROVALS: Readonly<Record<TemplateAudience, number>> = {
  internal: 1,
  // Two people read anything an owner will read. The second reader is the whole
  // control: the first is usually the author of the change.
  consumer: 2,
};

export interface RegisterTemplateRequest extends TemplateDraft {
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export interface DecideTemplateRequest {
  readonly templateId: Id<"template">;
  readonly actor: ActorRef;
  readonly decision: "approved" | "rejected";
  /** The digest of the body the reviewer read. Bound, like any approval. */
  readonly bodyDigest: Digest;
  readonly note?: string | undefined;
  readonly mode: OperatingMode;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export class TemplateRegistry {
  constructor(
    private readonly store: DocumentStore,
    private readonly authorizer: Authorizer,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly stepUpMaxAgeSeconds = 300,
  ) {}

  /**
   * Register a new draft version.
   *
   * Always a new version, never an edit. Registering a draft has no effect
   * outside this module — nothing can be generated from it — which is why it is
   * a `sensitive` action rather than a gated one.
   */
  async register(request: RegisterTemplateRequest): Promise<Template> {
    assertDraftWellFormed(request);

    await this.authorizer.authorize({
      action: REGISTER_TEMPLATE_ACTION,
      actor: request.actor,
      mode: request.mode,
      runId: request.runId,
      correlationId: request.correlationId,
      subject: { template: request.name, audience: request.audience },
      secondsSinceAuthentication: request.secondsSinceAuthentication,
    });

    const bodyDigest = digestValue({ body: request.body });
    const required = Math.max(
      request.approvalsRequired ?? DEFAULT_APPROVALS[request.audience],
      // A caller may raise the bar for a particular template. It may not lower
      // it below the audience's floor, and asking to is a mistake worth
      // silently correcting rather than honouring.
      DEFAULT_APPROVALS[request.audience],
    );

    const stored = await this.store.putTemplate({
      id: this.ids.next("template"),
      name: request.name,
      audience: request.audience,
      owner: request.owner,
      status: "draft",
      description: request.description,
      body: request.body,
      bodyDigest,
      declaredVariables: Object.freeze([...request.declaredVariables].sort()),
      outputFormats: Object.freeze([...request.outputFormats]),
      language: request.language ?? "en",
      approvalsRequired: required,
      createdBy: request.actor.actorId,
      createdAt: this.clock.nowIso(),
      approvals: Object.freeze([]),
    });

    // `workflow.definition_published` is the audit taxonomy's event for "a
    // versioned declarative artifact entered the record", which is what a
    // template version is. It is reused here rather than approximated with
    // something closer in name and further in meaning; the `artifact` and
    // `lifecycle` fields keep the entries distinguishable. When audit/types.ts
    // is next revised it should gain document.template_published,
    // .template_approved, and .template_retired, and these three call sites
    // move over unchanged.
    await this.audit.record(
      auditDecision({
        eventType: "workflow.definition_published",
        actorId: request.actor.actorId,
        actorKind: request.actor.kind,
        actorRoles: request.actor.roles,
        runId: request.runId,
        correlationId: request.correlationId,
        subject: {
          templateId: stored.id,
          template: stored.name,
          version: String(stored.version),
        },
        inputDigests: { body: bodyDigest },
        decision: {
          artifact: "document_template",
          lifecycle: "registered",
          status: stored.status,
          audience: stored.audience,
          owner: stored.owner,
          approvalsRequired: stored.approvalsRequired,
          variables: stored.declaredVariables.join(","),
          formats: stored.outputFormats.join(","),
        },
      }),
    );

    return stored;
  }

  /**
   * Record one reviewer's decision on a draft version.
   *
   * @throws {DeniedError} on self-approval, a digest mismatch, a repeat
   *   decision, or a version that is no longer a draft.
   */
  async decide(request: DecideTemplateRequest): Promise<Template> {
    const template = await this.requireTemplate(request.templateId);

    if (template.status !== "draft") {
      throw new DeniedError(
        "approval.already_used",
        `Template ${template.name}@${template.version} is ${template.status} and can no longer be decided. An approved version is immutable; a change is a new version.`,
        { templateId: template.id, status: template.status },
      );
    }

    // Bound to the text that was read. If the stored body differed from what
    // the reviewer saw, this is the check that notices — the same property the
    // guard module's proposal digests provide, applied to the artifact.
    if (request.bodyDigest !== template.bodyDigest) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `The decision on ${template.name}@${template.version} names a different body than the one stored. What was read is not what would be used.`,
        { templateId: template.id },
      );
    }

    // Segregation of duties. Whoever wrote the text is not the second pair of
    // eyes on it, however senior they are.
    if (request.actor.actorId === template.createdBy) {
      throw new DeniedError(
        "approval.self_approval",
        `${request.actor.actorId} registered ${template.name}@${template.version} and cannot also approve it.`,
        { templateId: template.id, actorId: request.actor.actorId },
      );
    }

    await this.authorizer.authorize({
      action: APPROVE_TEMPLATE_ACTION,
      actor: request.actor,
      mode: request.mode,
      runId: request.runId,
      correlationId: request.correlationId,
      subject: {
        templateId: template.id,
        template: template.name,
        version: String(template.version),
      },
      secondsSinceAuthentication: request.secondsSinceAuthentication,
    });

    const steppedUp =
      request.secondsSinceAuthentication !== undefined &&
      request.secondsSinceAuthentication <= this.stepUpMaxAgeSeconds;

    const approval: TemplateApproval = {
      actor: request.actor,
      decision: request.decision,
      decidedAt: this.clock.nowIso(),
      bodyDigest: request.bodyDigest,
      note: request.note,
      steppedUp,
    };

    // One rejection is decisive; approvals accumulate to the threshold. A
    // rejected draft stays a draft — the fix is a new version, and leaving it
    // in draft keeps the rejection visible on the version it was about.
    const approvalsAfter =
      template.approvals.filter((entry) => entry.decision === "approved").length +
      (request.decision === "approved" ? 1 : 0);
    const nextStatus: TemplateStatus =
      request.decision === "approved" && approvalsAfter >= template.approvalsRequired
        ? "approved"
        : "draft";

    // The store enforces "one decision per reviewer" atomically; a duplicate
    // arriving concurrently is rejected there, not here.
    const updated = await this.store.recordTemplateApproval(
      template.id,
      approval,
      nextStatus,
      nextStatus === "approved" ? approval.decidedAt : undefined,
    );

    await this.audit.record(
      auditDecision({
        eventType: request.decision === "approved" ? "approval.granted" : "approval.rejected",
        actorId: request.actor.actorId,
        actorKind: request.actor.kind,
        actorRoles: request.actor.roles,
        runId: request.runId,
        correlationId: request.correlationId,
        subject: {
          templateId: template.id,
          template: template.name,
          version: String(template.version),
        },
        inputDigests: { body: template.bodyDigest },
        decision: {
          artifact: "document_template",
          decision: request.decision,
          approvals: approvalsAfter,
          required: template.approvalsRequired,
          status: updated.status,
          steppedUp,
          ...(request.note ? { note: request.note.slice(0, 512) } : {}),
        },
      }),
    );

    return updated;
  }

  /** Take an approved version out of service. Nothing new generates from it. */
  async retire(request: {
    readonly templateId: Id<"template">;
    readonly actor: ActorRef;
    readonly mode: OperatingMode;
    readonly reason: string;
    readonly runId?: Id<"run"> | undefined;
    readonly correlationId?: string | undefined;
    readonly secondsSinceAuthentication?: number | undefined;
  }): Promise<Template> {
    const template = await this.requireTemplate(request.templateId);

    await this.authorizer.authorize({
      action: RETIRE_TEMPLATE_ACTION,
      actor: request.actor,
      mode: request.mode,
      runId: request.runId,
      correlationId: request.correlationId,
      subject: {
        templateId: template.id,
        template: template.name,
        version: String(template.version),
      },
      secondsSinceAuthentication: request.secondsSinceAuthentication,
    });

    const retired = await this.store.retireTemplate(template.id, this.clock.nowIso());

    await this.audit.record(
      auditDecision({
        eventType: "workflow.definition_published",
        actorId: request.actor.actorId,
        actorKind: request.actor.kind,
        actorRoles: request.actor.roles,
        runId: request.runId,
        correlationId: request.correlationId,
        subject: {
          templateId: retired.id,
          template: retired.name,
          version: String(retired.version),
        },
        decision: {
          artifact: "document_template",
          lifecycle: "retired",
          status: retired.status,
          reason: request.reason.slice(0, 512),
        },
      }),
    );

    return retired;
  }

  /**
   * The version that may be used right now.
   *
   * @throws {DeniedError} when nothing approved exists. A caller asking for a
   *   template that has never been approved gets a refusal, never a draft:
   *   generating from unapproved text is the failure this module exists to
   *   prevent, and it is one silent fallback away.
   */
  async requireUsable(name: string, version?: number): Promise<Template> {
    const template =
      version === undefined
        ? await this.store.latestApprovedTemplate(name)
        : await this.store.findTemplate(name, version);

    if (!template) {
      throw new DeniedError(
        "config.missing",
        version === undefined
          ? `No approved version of template "${name}" exists. Nothing may be generated from a draft.`
          : `Template "${name}" has no version ${version}.`,
        { template: name },
      );
    }
    if (template.status !== "approved") {
      throw new DeniedError(
        "config.missing",
        `Template ${name}@${template.version} is ${template.status}. Only an approved, unretired version may be used.`,
        { template: name, version: template.version, status: template.status },
      );
    }
    return template;
  }

  get(id: Id<"template">): Promise<Template | null> {
    return this.store.getTemplate(id);
  }

  list(filter?: TemplateFilter): Promise<readonly Template[]> {
    return this.store.listTemplates(filter);
  }

  private async requireTemplate(id: Id<"template">): Promise<Template> {
    const template = await this.store.getTemplate(id);
    if (!template) {
      throw new DeniedError("record.unavailable", `Template ${id} does not exist.`, {
        templateId: id,
      });
    }
    return template;
  }
}

/** Every distinct placeholder in a body, in order of first appearance. */
export function placeholdersIn(body: string): readonly string[] {
  const found: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Merge values into a template body.
 *
 * Three properties, each closing a specific failure:
 *
 * *Single pass.* Substitution happens once, so a value that itself contains
 * `{{something}}` is inert text rather than a placeholder to expand. A loop
 * that ran until stable would let data merged from a system of record — or
 * written by a model — inject a field the template never declared.
 *
 * *No expression evaluation of any kind.* The placeholder grammar admits a
 * lower-snake-case name and nothing else. There is no filter syntax, no dotted
 * path, no default value, and there must never be one: a template language with
 * an evaluator, running over data the platform did not author, is a code
 * execution surface inside a letter generator.
 *
 * *Fails closed on a missing value.* A placeholder with no value is refused,
 * never blanked and never left as literal `{{...}}`. Both alternatives put a
 * defective legal document in front of an owner: one silently drops the
 * rescission deadline, the other prints the word "deadline" in braces. Refusing
 * costs a caller one clear error.
 *
 * Values are escaped for the target format as they are substituted, so the
 * escaping cannot be confused with the template's own structure.
 */
export function substituteTemplate(
  template: Pick<Template, "body" | "declaredVariables" | "name" | "version">,
  values: TemplateValues,
  format: OutputFormat,
): string {
  const declared = new Set(template.declaredVariables);
  const supplied = Object.keys(values);

  const undeclared = supplied.filter((key) => !declared.has(key));
  if (undeclared.length > 0) {
    // Usually a rename that half happened, or a caller merging a field into the
    // wrong template. Either way the document would be missing something.
    throw new InvalidInputError(
      `Values supplied for variables ${template.name}@${template.version} does not declare: ${undeclared.join(", ")}.`,
      "values",
    );
  }

  for (const [key, value] of Object.entries(values)) {
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new InvalidInputError(
        `Value "${key}" is a ${type}. Template values are primitives: an object merged into a document renders as "[object Object]" in front of an owner.`,
        `values.${key}`,
      );
    }
    if (type === "string" && (value as string).length > MAX_VALUE_CHARS) {
      throw new InvalidInputError(
        `Value "${key}" is ${(value as string).length} characters, past the ${MAX_VALUE_CHARS} limit for a merged field. A value this long is a payload, and it belongs in its own template rather than in a field.`,
        `values.${key}`,
      );
    }
  }

  const missing: string[] = [];
  const substituted = template.body.replace(PLACEHOLDER, (_match, rawName: string) => {
    const name = rawName;
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      missing.push(name);
      return "";
    }
    const value = values[name];
    return escapeValue(format, typeof value === "string" ? value : String(value));
  });

  if (missing.length > 0) {
    throw new InvalidInputError(
      `No value supplied for ${missing.join(", ")} in ${template.name}@${template.version}. A missing variable is refused rather than emitted as an empty string: a legal document with a silent gap where a deadline should be is worse than no document.`,
      "values",
    );
  }

  return substituted;
}

/** Substitute and assemble in one step. */
export function renderTemplate(
  template: Template,
  values: TemplateValues,
  format: OutputFormat,
): RenderedDocument {
  if (!template.outputFormats.includes(format)) {
    throw new DeniedError(
      "config.missing",
      `Template ${template.name}@${template.version} declares formats ${template.outputFormats.join(", ")}; "${format}" is not among them. Which formats a document class is delivered in is part of what was approved.`,
      { template: template.name, version: template.version, format },
    );
  }
  const substituted = substituteTemplate(template, values, format);
  return assembleDocument(format, substituted, {
    title: template.description,
    language: template.language,
  });
}

/** Everything checked before a draft is allowed to exist. */
export function assertDraftWellFormed(draft: TemplateDraft): void {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(draft.name)) {
    throw new InvalidInputError(
      `Template name "${draft.name}" must be dotted lower_snake_case, e.g. "owner.rescission_acknowledgement".`,
      "name",
    );
  }
  if (!TEMPLATE_AUDIENCES.includes(draft.audience)) {
    throw new InvalidInputError(
      `Unknown template audience "${String(draft.audience)}".`,
      "audience",
    );
  }
  if (typeof draft.owner !== "string" || draft.owner.trim().length === 0) {
    throw new InvalidInputError(
      "A template needs a named accountable owner. A document nobody owns is a document nobody reviews.",
      "owner",
    );
  }
  if (typeof draft.description !== "string" || draft.description.trim().length === 0) {
    throw new InvalidInputError(
      "A template needs a one-line description; it is what an approver reads before deciding.",
      "description",
    );
  }
  if (typeof draft.body !== "string" || draft.body.trim().length === 0) {
    throw new InvalidInputError("A template needs a body.", "body");
  }
  if (draft.outputFormats.length === 0) {
    throw new InvalidInputError(
      "A template must declare at least one output format.",
      "outputFormats",
    );
  }
  for (const format of draft.outputFormats) {
    if (!isOutputFormat(format)) {
      throw new InvalidInputError(`Unknown output format "${String(format)}".`, "outputFormats");
    }
  }

  // The declaration and the body must agree, both ways. An undeclared
  // placeholder means a value nobody reviewed can be merged into an approved
  // document; a declared variable the body never uses is usually half of a
  // rename, and the other half is a placeholder still reading the old name.
  const used = new Set(placeholdersIn(draft.body));
  const declared = new Set(draft.declaredVariables);
  const undeclared = [...used].filter((name) => !declared.has(name));
  const unused = [...declared].filter((name) => !used.has(name));
  if (undeclared.length > 0) {
    throw new InvalidInputError(
      `Template body uses undeclared variable(s): ${undeclared.join(", ")}.`,
      "declaredVariables",
    );
  }
  if (unused.length > 0) {
    throw new InvalidInputError(
      `Template declares variable(s) the body never uses: ${unused.join(", ")}. This is usually half of a rename.`,
      "declaredVariables",
    );
  }

  // A stray single brace is almost always a typo for a placeholder, and a typo
  // for a placeholder is a field that silently never gets filled in.
  const stray = draft.body.replace(PLACEHOLDER, "").match(/\{\{|\}\}/);
  if (stray) {
    throw new InvalidInputError(
      `Template body contains "${stray[0]}" that is not a well-formed {{variable}} placeholder. Placeholders are lower_snake_case names and nothing else.`,
      "body",
    );
  }
}
