import { readFileSync } from "node:fs";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { isDigest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef } from "../record/types.js";
import { destinationFingerprint } from "../contact/gate.js";
import {
  CONTACT_CHANNELS,
  CONTACT_PURPOSES,
  RECIPIENT_RELATIONSHIPS,
} from "../contact/types.js";
import type {
  ContactChannel,
  ContactPurpose,
  RecipientRelationship,
} from "../contact/types.js";
import {
  APPROVE_TEMPLATE_ACTION,
  GENERATE_INTERNAL_ACTION,
  GENERATE_OWNER_FACING_ACTION,
} from "../documents/actions.js";
import { isOutputFormat } from "../documents/formats.js";
import type { DocumentDelivery, GenerateRequest } from "../documents/generate.js";
import {
  OUTPUT_FORMATS,
  TEMPLATE_AUDIENCES,
} from "../documents/types.js";
import type {
  OutputFormat,
  Template,
  TemplateAudience,
  TemplateFilter,
  TemplateStatus,
  TemplateValues,
} from "../documents/types.js";
import type { Platform } from "../platform.js";

/**
 * `pv documents` — the governed document factory from a terminal.
 *
 * A generated document is something MVW may have to defend years later, so the
 * subsystem beneath this one treats generation as an action rather than string
 * formatting: a template version is an immutable, approved artifact, and
 * anything an owner will read passes the contact gate. Until this file existed
 * it enforced none of that for anybody — `DocumentGenerator` and
 * `TemplateRegistry` were constructed only inside their own tests, so no
 * operator could register a template, approve one, or generate a document. §9
 * was a proof, not a capability. This is the operator surface that closes that —
 * a capability nothing can reach is not a capability.
 *
 * The house rules apply, each closing a way a command line lies to its operator:
 *
 * **Diagnostics to stderr, the answer to stdout**, so `pv documents template
 * register ... | ...` composes and a generated document's id can be piped into
 * the next verb without a banner in the way. The one thing each verb prints on
 * stdout is its answer: a template id, a proposal digest, a generated document
 * id, a table.
 *
 * **The real services, never a second copy of their rules.** Every verb goes
 * through the composition root's one `TemplateRegistry` and `DocumentGenerator`,
 * over the one store they share. No rule is re-implemented here: a version is
 * still immutable once approved, the author still cannot approve their own work,
 * substitution still fails closed on a missing variable, an unapproved template
 * still cannot be generated from, and an owner-facing document still passes the
 * contact gate and needs an approval bound to its proposal digest. This command
 * cannot weaken any of it because it does not own it.
 *
 * **An owner-facing document is fail-closed by construction.** `documents
 * generate` on a consumer template refuses without consent on record and
 * without an approval, and produces nothing on either path — a document nobody
 * may deliver is never written, so it never waits in a queue to leak. Both
 * refusals raise and exit 1 with their reason.
 *
 * **Exit codes mean something.** Zero means the thing happened (or the read was
 * produced); a refusal exits non-zero with its reason, propagated to the
 * top-level handler in main.ts; a malformed command is a usage error and exits 2.
 */

// ---------------------------------------------------------------------------
// Arguments and output
// ---------------------------------------------------------------------------

/** The shape `parseArgs` in main.ts produces. Structural, so it stays in step. */
export interface CommandArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string[]>>;
  readonly json: boolean;
}

export const DOCUMENTS_USAGE = `
pv documents — register, approve, and generate governed documents

  documents template register --name <dotted_lower_snake> --audience <internal|consumer>
                         --owner <team> --description <text>
                         (--body <text> | --body-file <path>)
                         [--variable <name>]... --format <${OUTPUT_FORMATS.join("|")}> [--format <f>]...
                         [--language <tag>] [--approvals-required <n>]
              Register a new draft version through document.register_template.
              A draft is INERT: nothing may be generated from it until it is
              approved. Prints the template id and its body digest.

  documents template approve --template <id> --body-digest <sha256> --reauthenticated
                         [--note <text>]
              Approve a draft version through document.approve_template. The
              digest binds the decision to the body that was read — run
              "documents template show" to read it and see the digest. The
              author cannot approve their own work, and a consumer-facing
              template needs two distinct approvers. Prints the template id.

  documents template list [--name <n>] [--audience <a>] [--status <draft|approved|retired>]
              Every template version, oldest first within a name.

  documents template show <templateId>
              One version: its owner, status, approvals, body digest, and body.

  documents propose      --template <name> [--template-version <n>]
                         [--value <key=value>]... --format <${OUTPUT_FORMATS.join("|")}>
                         [--subject <ref>] [--model-id <id>]
                         [<owner-facing delivery flags, as for generate>]
              Render what WOULD be produced and print the proposal digest an
              approval binds to. A dry run: it produces nothing.

  documents generate     --template <name> [--template-version <n>]
                         [--value <key=value>]... --format <${OUTPUT_FORMATS.join("|")}>
                         [--subject <ref>] [--model-id <id>]
              Generate an INTERNAL document (document.generate_internal). Prints
              the generated document id and what produced it.

  documents generate     <same flags> --channel <voice|sms|email|postal>
                         --purpose <${CONTACT_PURPOSES.join("|")}>
                         [--relationship <owner|co_owner|authorised_representative|third_party>]
                         (--destination <value> | --destination-digest <sha256>)
                         --timezone <IANA zone> [--jurisdiction <US|FL|...>]
                         --raise-approval
              Raise the approval an OWNER-FACING document needs, bound to the
              proposal digest. Somebody else grants it with "pv approvals
              decide", then:
  documents generate     <same flags> --approval <id> --reauthenticated
              Generate the owner-facing document. It additionally passes the
              contact gate: no consent on record, or a revocation, refuses it and
              nothing is produced.

Global:
  --json      Machine-readable output
  --operator  Name the operator this command is attributed to
  --role      Name the role the operator is acting in (repeatable). Registering
              is a compliance reviewer's, a supervisor's, an association
              manager's, or an admin's; approving is a compliance reviewer's, a
              supervisor's, or an admin's; an internal document is an association
              manager's, a supervisor's, or finance's; an owner-facing one is a
              supervisor's or a compliance reviewer's. Defaults to platform_admin,
              which holds none of them — the chokepoint refuses a role the
              asserted one does not include, so asserting one buys nothing an
              operator was not entitled to.

Approving a template and generating an owner-facing document are step-up
actions: the command line cannot verify a re-authentication, so it is asserted
with --reauthenticated, which the audit record shows came from the CLI. The
approval an owner-facing generation spends is separate, granted by a DIFFERENT
person through "pv approvals decide", where an assertion is not accepted at all.

Exit codes:
  0   the thing happened, or the read was produced
  1   refused (with its reason)
  2   the command was not usable as written
`.trim();

/** stderr, so stdout stays a clean artifact. */
function note(message: string): void {
  console.error(message);
}

function emit(value: unknown, args: CommandArgs): void {
  if (args.json) console.log(JSON.stringify(value, null, 2));
  else console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function first(args: CommandArgs, name: string): string | undefined {
  const value = args.flags[name]?.[0];
  // A flag given with no value parses as the string "true". Treated as absent,
  // so `--owner` with nothing after it is a usage error rather than the literal
  // word "true" being recorded as the accountable owner of a template.
  return value === undefined || value === "true" ? undefined : value;
}

function flagPresent(args: CommandArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}

function many(args: CommandArgs, name: string): readonly string[] {
  return (args.flags[name] ?? []).filter((value) => value !== "true");
}

function requireFlag(args: CommandArgs, name: string): string {
  const value = first(args, name);
  if (value === undefined) throw new InvalidInputError(`--${name} is required`, name);
  return value;
}

function requireInt(args: CommandArgs, name: string): number {
  const raw = requireFlag(args, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidInputError(`--${name} must be a positive integer, received "${raw}"`, name);
  }
  return value;
}

/**
 * Parse repeatable `--value key=value` flags into template values.
 *
 * Every value stays a string; the registry declares its variables and the
 * renderer substitutes what it is given. Refusing a malformed pair here is a
 * usage error, not a refusal the operator has to read a reason code for.
 */
function templateValues(args: CommandArgs): TemplateValues {
  const out: Record<string, string> = {};
  for (const pair of many(args, "value")) {
    const at = pair.indexOf("=");
    if (at <= 0 || at === pair.length - 1) {
      throw new InvalidInputError(
        `--value must be key=value, e.g. --value owner_name='A. Owner'; received "${pair}"`,
        "value",
      );
    }
    out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Domain-flag validation. A bad audience or format is a usage error, caught
// here rather than turned into a refusal deeper in the service.
// ---------------------------------------------------------------------------

function requireAudience(args: CommandArgs): TemplateAudience {
  const value = requireFlag(args, "audience");
  if (!TEMPLATE_AUDIENCES.includes(value as TemplateAudience)) {
    throw new InvalidInputError(
      `--audience must be one of ${TEMPLATE_AUDIENCES.join(", ")}; received "${value}".`,
      "audience",
    );
  }
  return value as TemplateAudience;
}

const TEMPLATE_STATUSES: readonly TemplateStatus[] = ["draft", "approved", "retired"];

function requireStatus(args: CommandArgs): TemplateStatus {
  const value = requireFlag(args, "status");
  if (!TEMPLATE_STATUSES.includes(value as TemplateStatus)) {
    throw new InvalidInputError(
      `--status must be one of ${TEMPLATE_STATUSES.join(", ")}; received "${value}".`,
      "status",
    );
  }
  return value as TemplateStatus;
}

/** A single output format, for the verbs that render one document. */
function requireFormat(args: CommandArgs): OutputFormat {
  const value = requireFlag(args, "format");
  if (!isOutputFormat(value)) {
    throw new InvalidInputError(
      `--format must be one of ${OUTPUT_FORMATS.join(", ")}; received "${value}".`,
      "format",
    );
  }
  return value;
}

/** The output-format list a template version declares. */
function requireOutputFormats(args: CommandArgs): OutputFormat[] {
  const values = many(args, "format");
  if (values.length === 0) {
    throw new InvalidInputError(
      `A template must declare at least one --format (${OUTPUT_FORMATS.join(", ")}).`,
      "format",
    );
  }
  for (const value of values) {
    if (!isOutputFormat(value)) {
      throw new InvalidInputError(
        `--format must be one of ${OUTPUT_FORMATS.join(", ")}; received "${value}".`,
        "format",
      );
    }
  }
  return values as OutputFormat[];
}

/**
 * The template body, from the command line or a file.
 *
 * `--body` is a short body typed inline; `--body-file` reads one from disk. One
 * is required: a template with no body is nothing to approve and nothing to
 * render.
 */
function documentBody(args: CommandArgs): string {
  const inline = first(args, "body");
  if (inline !== undefined) return inline;
  const file = first(args, "body-file");
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      throw new InvalidInputError(
        `Could not read the template body at ${file}: ${error instanceof Error ? error.message : String(error)}`,
        "body-file",
      );
    }
  }
  throw new InvalidInputError(
    "A template needs a body: --body <text> for a short body inline, or --body-file <path> to read one from disk.",
    "body",
  );
}

/**
 * The digest of the body a reviewer approved.
 *
 * The platform binds a template decision to the exact text that was read, the
 * same way it binds an action approval to a proposal digest. So the reviewer
 * names the digest of the body they read — `documents template show` prints it —
 * rather than the registry reading the stored one for them, which would make the
 * binding decorative on exactly the surface a headless install approves from.
 */
function requireBodyDigest(args: CommandArgs): string {
  const value = requireFlag(args, "body-digest");
  if (!isDigest(value)) {
    throw new InvalidInputError(
      `--body-digest must be a sha256 digest of the body you read; received "${value}". "documents template show" prints it.`,
      "body-digest",
    );
  }
  return value;
}

/**
 * The destination fingerprint for an owner-facing delivery.
 *
 * The gate never handles a raw number or address — it matches a suppression
 * list on a fingerprint. `--destination` is fingerprinted on the message's own
 * channel; `--destination-digest` is one already computed.
 */
function requireDestinationDigest(args: CommandArgs, channel: ContactChannel): string {
  const digest = first(args, "destination-digest");
  if (digest !== undefined) {
    if (!isDigest(digest)) {
      throw new InvalidInputError(
        `--destination-digest must be a sha256 fingerprint from destinationFingerprint(); received "${digest}".`,
        "destination-digest",
      );
    }
    return digest;
  }
  const raw = first(args, "destination");
  if (raw !== undefined) return destinationFingerprint(channel, raw);
  throw new InvalidInputError(
    "An owner-facing delivery needs a destination: --destination <value> (fingerprinted on the channel), or --destination-digest <sha256>. The gate never sees a raw number or address.",
    "destination",
  );
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface DocumentsCommandContext {
  readonly platform: Platform;
  /** The operator, as main.ts attributes them. Unverified, and marked `cli:`. */
  readonly actor: ActorRef;
  readonly correlationId?: string | undefined;
}

export async function commandDocuments(
  args: CommandArgs,
  context: DocumentsCommandContext,
): Promise<number> {
  try {
    return await dispatch(args, context);
  } catch (error) {
    // A malformed command is a usage error, not a crash. `DeniedError` is
    // deliberately NOT caught: a refusal is an outcome the operator has to see
    // with its reason code, and it propagates to main.ts's top-level handler.
    if (error instanceof InvalidInputError) {
      note(`${error.message}${error.field ? ` (${error.field})` : ""}`);
      return 2;
    }
    throw error;
  }
}

async function dispatch(args: CommandArgs, context: DocumentsCommandContext): Promise<number> {
  const sub = args.positional[1];
  switch (sub) {
    case "template":
      return await templateVerb(args, context);
    case "propose":
      return await proposeDocument(args, context);
    case "generate":
      return await generateDocument(args, context);
    default:
      note(`Unknown documents subcommand: ${sub ?? "(none)"}\n`);
      note(DOCUMENTS_USAGE);
      return 2;
  }
}

async function templateVerb(args: CommandArgs, context: DocumentsCommandContext): Promise<number> {
  const verb = args.positional[2];
  switch (verb) {
    case "register":
      return await registerTemplate(args, context);
    case "approve":
      return await approveTemplate(args, context);
    case "list":
      return await listTemplates(args, context);
    case "show":
      return await showTemplate(args, context);
    default:
      note(`Unknown template subcommand: ${verb ?? "(none)"}. Try: register, approve, list, show.`);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// template register — the governed draft
// ---------------------------------------------------------------------------

async function registerTemplate(
  args: CommandArgs,
  context: DocumentsCommandContext,
): Promise<number> {
  const { platform } = context;

  // The chokepoint. A refusal — an unauthorised actor, a body whose
  // placeholders and declarations disagree — raises and propagates to main.ts.
  // `document.register_template` is sensitive, which shadow mode does not
  // permit; supervised is the mode a deliberate registration is made in.
  const template = await platform.documentTemplates.register({
    name: requireFlag(args, "name"),
    audience: requireAudience(args),
    owner: requireFlag(args, "owner"),
    description: requireFlag(args, "description"),
    body: documentBody(args),
    declaredVariables: many(args, "variable"),
    outputFormats: requireOutputFormats(args),
    ...(first(args, "language") !== undefined ? { language: requireFlag(args, "language") } : {}),
    ...(flagPresent(args, "approvals-required")
      ? { approvalsRequired: requireInt(args, "approvals-required") }
      : {}),
    actor: context.actor,
    mode: "supervised",
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  });

  note(
    `Registered draft ${template.name}@${template.version} (${template.id}), ${template.audience}, owned by ${template.owner}, needing ${template.approvalsRequired} distinct approver(s). Its body digest is ${template.bodyDigest}. It is INERT: nothing may be generated from it until it is approved. Approve it — a different person — with:\n  pv documents template approve --template ${template.id} --body-digest ${template.bodyDigest} --reauthenticated`,
  );

  if (args.json) {
    emit(
      {
        templateId: template.id,
        name: template.name,
        version: template.version,
        audience: template.audience,
        status: template.status,
        owner: template.owner,
        bodyDigest: template.bodyDigest,
        declaredVariables: template.declaredVariables,
        outputFormats: template.outputFormats,
        approvalsRequired: template.approvalsRequired,
      },
      args,
    );
    return 0;
  }
  // The answer, alone on stdout: the template id the next verb takes.
  console.log(template.id);
  return 0;
}

// ---------------------------------------------------------------------------
// template approve — the governed decision
// ---------------------------------------------------------------------------

/**
 * Refuse to invent a step-up the platform cannot observe.
 *
 * The command line cannot verify who is typing — main.ts says so where it builds
 * the actor. `--reauthenticated` is the reviewer asserting they have just
 * re-authenticated to this host, and it is required rather than assumed:
 * approving a template is the act that lets text reach an owner, and a
 * quietly-satisfied step-up would make the requirement decorative on exactly the
 * path it guards. The audit record shows the attestation came from the CLI.
 */
function reviewerStepUpSeconds(args: CommandArgs): number {
  if (!flagPresent(args, "reauthenticated")) {
    throw new DeniedError(
      "authorization.step_up_required",
      "Approving a template requires a fresh re-authentication. The command line cannot verify one, so it is asserted: re-authenticate to this host and pass --reauthenticated.",
      { action: APPROVE_TEMPLATE_ACTION },
    );
  }
  return 0;
}

async function approveTemplate(
  args: CommandArgs,
  context: DocumentsCommandContext,
): Promise<number> {
  const { platform } = context;
  const templateId = requireFlag(args, "template") as Id<"template">;
  const bodyDigest = requireBodyDigest(args);
  const stepUp = reviewerStepUpSeconds(args);

  // The chokepoint plus the registry's own controls: no self-approval, the
  // digest must match the stored body, and no reviewer decides twice. A refusal
  // raises a DeniedError that propagates to main.ts and exits 1.
  const updated = await platform.documentTemplates.decide({
    templateId,
    actor: context.actor,
    decision: "approved",
    bodyDigest,
    mode: "supervised",
    secondsSinceAuthentication: stepUp,
    ...(first(args, "note") !== undefined ? { note: requireFlag(args, "note") } : {}),
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  });

  const approvals = updated.approvals.filter((entry) => entry.decision === "approved").length;
  note(
    updated.status === "approved"
      ? `APPROVED ${updated.name}@${updated.version} (${updated.id}) — ${approvals} of ${updated.approvalsRequired} approver(s). It is now immutable and usable; generate from it with "pv documents generate --template ${updated.name}".`
      : `Recorded an approval of ${updated.name}@${updated.version} — ${approvals} of ${updated.approvalsRequired}. It stays a draft until ${updated.approvalsRequired - approvals} more distinct approver(s) decide. Nobody approves their own registration, and nobody decides twice.`,
  );

  if (args.json) {
    emit(
      {
        templateId: updated.id,
        name: updated.name,
        version: updated.version,
        status: updated.status,
        approvalsRecorded: approvals,
        approvalsRequired: updated.approvalsRequired,
      },
      args,
    );
    return 0;
  }
  // The answer, alone on stdout: the template id.
  console.log(updated.id);
  return 0;
}

// ---------------------------------------------------------------------------
// template list / show — reading the registry
// ---------------------------------------------------------------------------

function templateLine(template: Template): Record<string, unknown> {
  return {
    templateId: template.id,
    name: template.name,
    version: template.version,
    audience: template.audience,
    status: template.status,
    owner: template.owner,
    approvalsRecorded: template.approvals.filter((entry) => entry.decision === "approved").length,
    approvalsRequired: template.approvalsRequired,
    bodyDigest: template.bodyDigest,
  };
}

async function listTemplates(args: CommandArgs, context: DocumentsCommandContext): Promise<number> {
  const filter: TemplateFilter = {
    ...(first(args, "name") !== undefined ? { name: requireFlag(args, "name") } : {}),
    ...(first(args, "audience") !== undefined ? { audience: requireAudience(args) } : {}),
    ...(first(args, "status") !== undefined ? { status: requireStatus(args) } : {}),
  };
  const templates = await context.platform.documentTemplates.list(filter);

  if (args.json) {
    emit(templates.map(templateLine), args);
    return 0;
  }

  if (templates.length === 0) {
    note(
      "No template matches. `pv documents template register` registers one — as an inert draft that cannot be generated from until it is approved.",
    );
    return 0;
  }

  console.log(
    `${"NAME".padEnd(34)} ${"VER".padEnd(4)} ${"AUDIENCE".padEnd(9)} ${"STATUS".padEnd(9)} ${"APPROVALS".padEnd(10)} ${"OWNER".padEnd(20)} TEMPLATE ID`,
  );
  for (const template of templates) {
    const approvals = template.approvals.filter((entry) => entry.decision === "approved").length;
    console.log(
      `${template.name.padEnd(34)} ${`v${template.version}`.padEnd(4)} ${template.audience.padEnd(9)} ${template.status.padEnd(9)} ${`${approvals}/${template.approvalsRequired}`.padEnd(10)} ${template.owner.padEnd(20)} ${template.id}`,
    );
  }
  const usable = templates.filter((template) => template.status === "approved").length;
  note(
    `${templates.length} version(s), ${usable} approved and usable. A draft or retired version cannot be generated from — that is inert, not broken.`,
  );
  return 0;
}

async function showTemplate(args: CommandArgs, context: DocumentsCommandContext): Promise<number> {
  const id = args.positional[3];
  if (id === undefined || id.startsWith("--")) {
    throw new InvalidInputError(
      "Name the template to show: pv documents template show <templateId>. `pv documents template list` prints the ids.",
      "templateId",
    );
  }

  const template = await context.platform.documentTemplates.get(id as Id<"template">);
  if (!template) {
    throw new DeniedError("record.unavailable", `No template ${id} in the registry.`, {
      templateId: id,
    });
  }

  if (args.json) {
    emit(template, args);
    return 0;
  }

  console.log(`name              ${template.name}`);
  console.log(`id                ${template.id}`);
  console.log(`version           v${template.version}`);
  console.log(`audience          ${template.audience}`);
  console.log(`status            ${template.status}`);
  console.log(`owner             ${template.owner}`);
  console.log(`description       ${template.description}`);
  console.log(`body digest       ${template.bodyDigest}`);
  console.log(`variables         ${template.declaredVariables.join(", ") || "(none)"}`);
  console.log(`formats           ${template.outputFormats.join(", ")}`);
  console.log(`approvals         ${template.approvals.filter((entry) => entry.decision === "approved").length} of ${template.approvalsRequired} required`);
  for (const approval of template.approvals) {
    console.log(
      `  ${approval.decision.padEnd(9)} ${approval.actor.actorId.padEnd(24)} ${approval.decidedAt}${approval.steppedUp ? " (stepped up)" : ""}`,
    );
  }
  console.log("");
  console.log("body:");
  for (const line of template.body.split("\n")) console.log(`  ${line}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Building the generation request the two verbs share
// ---------------------------------------------------------------------------

/**
 * The delivery an owner-facing document is destined for, from the flags.
 *
 * Returns undefined when no `--channel` is given, which is the internal-document
 * case: an internal document has no owner to contact and the generator asks the
 * gate nothing. When a channel is given, the whole delivery is required, because
 * that is what the contact gate needs to answer whether this owner may be
 * contacted at all.
 */
function buildDelivery(args: CommandArgs): DocumentDelivery | undefined {
  if (!flagPresent(args, "channel")) return undefined;

  const channel = first(args, "channel");
  if (channel === undefined || !CONTACT_CHANNELS.includes(channel as ContactChannel)) {
    throw new InvalidInputError(
      `--channel must be one of ${CONTACT_CHANNELS.join(", ")}; received "${channel ?? "(none)"}".`,
      "channel",
    );
  }
  const purpose = requireFlag(args, "purpose");
  if (!CONTACT_PURPOSES.includes(purpose as ContactPurpose)) {
    throw new InvalidInputError(
      `--purpose must be one of ${CONTACT_PURPOSES.join(", ")}; received "${purpose}".`,
      "purpose",
    );
  }
  const relationship = first(args, "relationship") ?? "owner";
  if (!RECIPIENT_RELATIONSHIPS.includes(relationship as RecipientRelationship)) {
    throw new InvalidInputError(
      `--relationship must be one of ${RECIPIENT_RELATIONSHIPS.join(", ")}; received "${relationship}".`,
      "relationship",
    );
  }

  return {
    subjectRef: requireFlag(args, "subject"),
    channel: channel as ContactChannel,
    purpose: purpose as ContactPurpose,
    relationship: relationship as RecipientRelationship,
    destinationDigest: requireDestinationDigest(args, channel as ContactChannel),
    jurisdiction: first(args, "jurisdiction") ?? "US",
    recipientTimeZone: requireFlag(args, "timezone"),
  };
}

/**
 * Assemble a `GenerateRequest` from the flags `propose` and `generate` share.
 *
 * The `runId` is the unit of work the request is made under; the caller creates
 * it. It is deliberately not part of the proposal digest — an approver signs off
 * the document, not the run — so the run created for a propose and the run
 * created for the generate that spends its approval differ without breaking the
 * digest match.
 */
function buildGenerateRequest(
  args: CommandArgs,
  context: DocumentsCommandContext,
  runId: Id<"run">,
): GenerateRequest {
  const subjectRef = first(args, "subject");
  const delivery = buildDelivery(args);
  return {
    templateName: requireFlag(args, "template"),
    ...(flagPresent(args, "template-version")
      ? { templateVersion: requireInt(args, "template-version") }
      : {}),
    values: templateValues(args),
    format: requireFormat(args),
    actor: context.actor,
    mode: "supervised",
    runId,
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    ...(first(args, "model-id") !== undefined ? { modelId: requireFlag(args, "model-id") } : {}),
    ...(subjectRef !== undefined ? { subjectRef } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
  };
}

/** A real unit of work for the generation. Its subject is opaque, never owner data. */
async function createDocumentRun(
  context: DocumentsCommandContext,
  kind: string,
  templateName: string,
  subjectRef: string | undefined,
): Promise<Id<"run">> {
  const run = await context.platform.runs.createRun({
    kind,
    mode: "supervised",
    requestedBy: context.actor,
    subject: { template: templateName, ...(subjectRef !== undefined ? { subjectRef } : {}) },
    correlationId: context.correlationId ?? `${kind}-${templateName}`,
  });
  return run.id;
}

// ---------------------------------------------------------------------------
// propose — the dry run
// ---------------------------------------------------------------------------

async function proposeDocument(
  args: CommandArgs,
  context: DocumentsCommandContext,
): Promise<number> {
  const { platform } = context;
  const templateName = requireFlag(args, "template");
  const runId = await createDocumentRun(context, "document.propose", templateName, first(args, "subject"));
  const request = buildGenerateRequest(args, context, runId);

  // `propose` renders and computes digests and does nothing else. A refusal —
  // an unapproved template, a missing variable — raises a DeniedError or an
  // InvalidInputError; the first propagates to main.ts and exits 1, the second
  // is a usage error caught above. Nothing is produced on any path.
  const proposal = await platform.documents.propose(request);

  // The rendered body and its provenance are the reviewer's material, so they
  // go to stderr; the one answer — the proposal digest an approval binds to —
  // goes to stdout, so it can be piped into raising one.
  note(`template          ${proposal.template.name}@${proposal.template.version} (${proposal.template.audience})`);
  note(`action            ${proposal.action}`);
  note(`format            ${proposal.rendered.format}`);
  note(`data digest       ${proposal.dataDigest}`);
  note(`output digest     ${proposal.rendered.outputDigest}`);
  note("");
  note("rendered body:");
  for (const line of proposal.rendered.body.split("\n")) note(`  ${line}`);
  note("");
  note(
    proposal.action === GENERATE_OWNER_FACING_ACTION
      ? "This is a dry run: nothing was produced. This template is owner-facing, so generating it needs an approval bound to the digest below and passes the contact gate."
      : "This is a dry run: nothing was produced. The digest below is what an approval would bind to.",
  );

  if (args.json) {
    emit(
      {
        template: proposal.template.name,
        version: proposal.template.version,
        audience: proposal.template.audience,
        action: proposal.action,
        format: proposal.rendered.format,
        dataDigest: proposal.dataDigest,
        outputDigest: proposal.rendered.outputDigest,
        proposalDigest: proposal.proposalDigest,
        body: proposal.rendered.body,
      },
      args,
    );
    return 0;
  }
  // The answer, alone on stdout: the proposal digest.
  console.log(proposal.proposalDigest);
  return 0;
}

// ---------------------------------------------------------------------------
// generate — the governed chokepoint
// ---------------------------------------------------------------------------

/**
 * The step-up seconds for an owner-facing generation, asserted lazily.
 *
 * Zero when `--reauthenticated` is present, undefined otherwise — and undefined
 * is deliberately not a refusal here. An owner-facing generation checks the
 * contact gate *before* it authorizes, so a document for an owner with no
 * consent is refused at the gate whatever the operator asserted. Throwing early
 * for a missing `--reauthenticated` would tell the operator to re-authenticate
 * for a document that was never going to be produced. The step-up is enforced
 * where it belongs: the chokepoint refuses the grant when no re-authentication
 * was observed, which for the CLI means `--reauthenticated` was not passed.
 */
function ownerFacingStepUpSeconds(args: CommandArgs): number | undefined {
  return flagPresent(args, "reauthenticated") ? 0 : undefined;
}

async function generateDocument(
  args: CommandArgs,
  context: DocumentsCommandContext,
): Promise<number> {
  const { platform } = context;
  const templateName = requireFlag(args, "template");
  const subjectRef = first(args, "subject");
  const runId = await createDocumentRun(context, "document.generate", templateName, subjectRef);
  const request = buildGenerateRequest(args, context, runId);

  // Probe: render and compute the digest, no effect. This resolves the template
  // and so refuses (config.missing, exit 1) an unapproved one before anything
  // else, and it tells us which action the audience selects.
  const proposal = await platform.documents.propose(request);

  if (flagPresent(args, "raise-approval")) {
    if (proposal.action === GENERATE_INTERNAL_ACTION) {
      note(
        `${proposal.template.name}@${proposal.template.version} is internal. An internal document needs no approval — generate it directly with the same flags, without --raise-approval.`,
      );
      return 2;
    }

    // The approval is bound to the proposal digest — this template version, its
    // approved body, the data being merged, the format and the delivery — so a
    // document altered before it is generated cannot be produced under it.
    // Eligible roles and the approver count come off the registered action, not
    // this file, so they cannot drift from the tier.
    const descriptor = platform.registry.require(proposal.action);
    const approval = await platform.approvals.request({
      action: proposal.action,
      proposalDigest: proposal.proposalDigest,
      summary: `Generate ${proposal.template.name}@${proposal.template.version} for ${request.subjectRef ?? request.delivery?.subjectRef ?? "an owner"}`,
      requestedBy: context.actor,
      approvalsRequired: descriptor.approvalsRequired,
      eligibleRoles: descriptor.allowedRoles,
      runId,
      subject: {
        template: proposal.template.name,
        version: String(proposal.template.version),
        audience: proposal.template.audience,
        ...(request.subjectRef ? { subjectRef: request.subjectRef } : {}),
      },
      ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    });

    note(
      `Approval ${approval.id} raised to generate ${proposal.template.name}@${proposal.template.version} (${descriptor.approvalsRequired} approver(s) from ${descriptor.allowedRoles.join(", ")}). Somebody other than ${context.actor.actorId} must grant it — nobody approves their own request:\n  pv approvals decide ${approval.id} --grant --note "<why>" --session-file <path>\nGranting a high-consequence action needs a session this platform can see the authentication instant of; see "pv approvals". Then:\n  pv documents generate <the same flags> --approval ${approval.id} --reauthenticated`,
    );
    emit(
      args.json
        ? { approvalId: approval.id, action: proposal.action, proposalDigest: proposal.proposalDigest }
        : approval.id,
      args,
    );
    return 0;
  }

  // Produce. For an owner-facing document the approval and step-up are supplied;
  // for an internal one neither is needed and neither is passed. A refusal —
  // the contact gate (no consent, a revocation), a missing or mismatched
  // approval, a failed step-up — raises a DeniedError that propagates to main.ts
  // and exits 1. Nothing is produced on any refusal path.
  const produceRequest: GenerateRequest =
    proposal.template.audience === "consumer"
      ? {
          ...request,
          ...(first(args, "approval") !== undefined
            ? { approvalId: requireFlag(args, "approval") as Id<"approval"> }
            : {}),
          ...(ownerFacingStepUpSeconds(args) !== undefined
            ? { secondsSinceAuthentication: ownerFacingStepUpSeconds(args) }
            : {}),
        }
      : request;

  const document = await platform.documents.generate(produceRequest);

  note(
    `Generated ${document.templateName}@${document.templateVersion} as ${document.id} (${document.audience}, ${document.format}). It records data digest ${document.dataDigest}, run ${document.runId}${document.modelId ? `, model ${document.modelId}` : ""}${
      document.approvedBy.length > 0 ? `, approved by ${document.approvedBy.join(", ")}` : ""
    }. Its audit receipt is ${document.receiptId ?? "(pending)"}.${
      document.audience === "consumer"
        ? " The contact-gate evidence that permitted it is fingerprinted on the document."
        : ""
    }`,
  );

  if (args.json) {
    emit(
      {
        documentId: document.id,
        templateName: document.templateName,
        templateVersion: document.templateVersion,
        templateBodyDigest: document.templateBodyDigest,
        dataDigest: document.dataDigest,
        modelId: document.modelId ?? null,
        audience: document.audience,
        format: document.format,
        outputDigest: document.outputDigest,
        runId: document.runId,
        generatedBy: document.generatedBy,
        approvalId: document.approvalId ?? null,
        approvedBy: document.approvedBy,
        contactEvidenceDigest: document.contactEvidenceDigest ?? null,
        subjectRef: document.subjectRef ?? null,
        receiptId: document.receiptId ?? null,
      },
      args,
    );
    return 0;
  }
  // The answer, alone on stdout: the generated document id.
  console.log(document.id);
  return 0;
}
