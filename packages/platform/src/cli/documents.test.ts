import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FixedClock } from "../kernel/clock.js";
import { loadConfig } from "../kernel/config.js";
import { DeniedError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { buildPlatform, type Platform } from "../platform.js";
import type { ActorRef } from "../record/types.js";
import { commandDocuments, type CommandArgs, type DocumentsCommandContext } from "./documents.js";

/**
 * The document factory, driven through the surface an operator actually has.
 *
 * These are not the factory's own tests — those live in
 * `documents/documents.test.ts` and prove the controls in isolation. These
 * prove the wiring: that `buildPlatform` composes the template registry and the
 * generator over one store, sharing the platform's one contact gate, at all;
 * that the CLI reaches the one composed set; and that an owner-facing document
 * is refused at the contact gate for an owner with no consent and produced only
 * with consent and an approval bound to its proposal digest. Before this file
 * the factory had no caller outside its own tests, so every one of these paths
 * was unreachable in the product.
 */

const START = "2026-08-08T12:00:00.000Z";

/** Registers templates; never approves their own. Compliance holds the register role. */
const AUTHOR: ActorRef = { actorId: "cli:author", kind: "human", roles: ["compliance_reviewer"] };
/** A supervisor: approves templates, and generates owner-facing documents. */
const REVIEWER: ActorRef = { actorId: "cli:reviewer", kind: "human", roles: ["supervisor"] };
/** A second, distinct approver for anything an owner will read. */
const SECOND: ActorRef = { actorId: "cli:second", kind: "human", roles: ["platform_admin"] };
/** Generates internal documents; holds no owner-facing role. */
const ASSOCIATION: ActorRef = { actorId: "cli:assoc", kind: "human", roles: ["association_manager"] };

const INTERNAL =
  "documents template register --name association.reserve_summary --audience internal " +
  "--owner association_services --description 'Reserve summary for a board pack' " +
  "--body 'Association {{association}} reserve at {{as_of}} is {{balance}}.' " +
  "--variable association --variable as_of --variable balance --format text --format html";

const OWNER =
  "documents template register --name owner.rescission_acknowledgement --audience consumer " +
  "--owner owner_services --description 'Acknowledgement of a rescission request' " +
  "--body 'Dear {{owner_name}}, we received cancellation for {{contract_ref}}. Your rescission period ends {{deadline}}.' " +
  "--variable owner_name --variable contract_ref --variable deadline --format text --format html";

const OWNER_GENERATE =
  "documents generate --template owner.rescission_acknowledgement " +
  "--value owner_name=Owner --value contract_ref=ctr_owner_1 --value deadline=2026-08-16 " +
  "--format text --subject ctr_owner_1 --channel email --purpose servicing " +
  "--destination owner@example.com --timezone America/New_York --jurisdiction US";

function args(line: string): CommandArgs {
  const tokens = tokenize(line);
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        (flags[token.slice(2)] ??= []).push("true");
      } else {
        (flags[token.slice(2)] ??= []).push(next);
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags, json: flags["json"] !== undefined };
}

/** Split on spaces, but keep a single-quoted run together so a flag can carry a sentence. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  const pattern = /'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) out.push(match[1] ?? match[2] ?? "");
  return out;
}

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly thrown?: unknown;
}

async function capture(platform: Platform, line: string, actor: ActorRef): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (message?: unknown) => out.push(String(message));
  console.error = (message?: unknown) => err.push(String(message));
  const context: DocumentsCommandContext = { platform, actor };
  try {
    const code = await commandDocuments(args(line), context);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } catch (thrown) {
    return { code: 1, stdout: out.join("\n"), stderr: err.join("\n"), thrown };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

async function run(platform: Platform, line: string, actor: ActorRef): Promise<Captured> {
  const result = await capture(platform, line, actor);
  if (result.thrown) throw result.thrown;
  return result;
}

/** Register a template and read back its id and the digest an approval binds to. */
async function register(
  platform: Platform,
  line: string,
): Promise<{ templateId: string; name: string; bodyDigest: string }> {
  const result = await run(platform, `${line} --json`, AUTHOR);
  const parsed = JSON.parse(result.stdout) as {
    templateId: string;
    name: string;
    bodyDigest: string;
  };
  return parsed;
}

/** Approve one draft version as one reviewer, naming the body digest they read. */
async function approve(
  platform: Platform,
  templateId: string,
  bodyDigest: string,
  reviewer: ActorRef,
): Promise<Captured> {
  return await run(
    platform,
    `documents template approve --template ${templateId} --body-digest ${bodyDigest} --reauthenticated`,
    reviewer,
  );
}

/** Record consent for the owner-facing delivery the generation is destined for. */
async function grantConsent(platform: Platform): Promise<void> {
  await platform.consentLedger.record({
    subjectRef: "ctr_owner_1",
    channel: "email",
    purpose: "servicing",
    kind: "granted",
    effectiveAt: platform.clock.nowIso(),
    provenance: {
      source: "signed_document",
      capturedBy: AUTHOR.actorId,
      evidenceDigest: digestValue({ artifact: "signed-consent-form" }),
    },
    actor: REVIEWER,
    mode: "supervised",
  });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe("the composition root wires the document factory", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("documents-cli"),
      logger: createNullLogger(),
    });
  });

  afterEach(async () => {
    await platform.close();
  });

  it("exposes the generator, the template registry, and the store they share", () => {
    expect(platform.documents).toBeDefined();
    expect(platform.documentTemplates).toBeDefined();
    expect(platform.documentStore).toBeDefined();
  });

  it("hands the generator the platform's one contact gate, not a second one", async () => {
    // A consent recorded through the ledger has to be the consent the generator's
    // gate reads. If the generator held its own gate this record would be
    // invisible to it, and an owner-facing generation would refuse consent it
    // had been given — the exact two-instances-over-two-stores failure.
    await grantConsent(platform);
    const state = await platform.consentLedger.stateFor({
      subjectRef: "ctr_owner_1",
      channel: "email",
      purpose: "servicing",
      asOf: platform.clock.nowIso(),
    });
    expect(state.status).toBe("granted");
  });

  it("registers the document actions in the one chokepoint", () => {
    // Without these a register, an approve, and a generation are each refused
    // with an unknown-action error the moment they are reached — which is why
    // the factory had never governed one outside its own tests.
    for (const action of [
      "document.register_template",
      "document.approve_template",
      "document.retire_template",
      "document.generate_internal",
      "document.generate_owner_facing",
    ]) {
      expect(platform.registry.get(action), `${action} must be registered`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The verbs, driven through the CLI
// ---------------------------------------------------------------------------

describe("pv documents, end to end", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("documents-cli"),
      logger: createNullLogger(),
    });
  });

  afterEach(async () => {
    await platform.close();
  });

  it("registers a draft, approves it, and generates an internal document", async () => {
    const { templateId, bodyDigest } = await register(platform, INTERNAL);
    expect(templateId).toMatch(/^tpl_/);

    // The author cannot approve their own work, however senior.
    const selfApproval = await capture(
      platform,
      `documents template approve --template ${templateId} --body-digest ${bodyDigest} --reauthenticated`,
      AUTHOR,
    );
    expect(selfApproval.thrown).toBeInstanceOf(DeniedError);
    expect((selfApproval.thrown as DeniedError).reason).toBe("approval.self_approval");

    const approved = await approve(platform, templateId, bodyDigest, REVIEWER);
    expect(approved.code).toBe(0);
    expect(approved.stderr).toMatch(/APPROVED/);

    const generated = await run(
      platform,
      "documents generate --template association.reserve_summary " +
        "--value association=PalmRidge --value as_of=2026-06-30 --value balance=1204000 " +
        "--format text --model-id drafting-model",
      ASSOCIATION,
    );
    expect(generated.code).toBe(0);
    const documentId = generated.stdout.trim();
    expect(documentId).toMatch(/^doc_/);

    const document = await platform.documents.get(documentId as Id<"document">);
    expect(document?.templateName).toBe("association.reserve_summary");
    expect(document?.templateVersion).toBe(1);
    expect(document?.audience).toBe("internal");
    expect(document?.modelId).toBe("drafting-model");
    expect(document?.receiptId).toBeDefined();
    expect(document?.dataDigest).toBe(
      digestValue({ values: { association: "PalmRidge", as_of: "2026-06-30", balance: "1204000" } }),
    );
  });

  it("refuses to generate from a template that was never approved", async () => {
    await register(platform, INTERNAL);
    const result = await capture(
      platform,
      "documents generate --template association.reserve_summary " +
        "--value association=PalmRidge --value as_of=2026-06-30 --value balance=1204000 --format text",
      ASSOCIATION,
    );
    expect(result.thrown).toBeInstanceOf(DeniedError);
    expect((result.thrown as DeniedError).reason).toBe("config.missing");
    expect(await platform.documents.list()).toHaveLength(0);
  });

  it("prints the proposal digest an approval binds to, and produces nothing", async () => {
    const { templateId, bodyDigest } = await register(platform, OWNER);
    await approve(platform, templateId, bodyDigest, REVIEWER);
    await approve(platform, templateId, bodyDigest, SECOND);

    const proposal = await run(
      platform,
      OWNER_GENERATE.replace("documents generate", "documents propose"),
      REVIEWER,
    );
    expect(proposal.code).toBe(0);
    // The digest is the answer, on stdout; the rendered body is on stderr.
    expect(proposal.stdout.trim()).toMatch(/^sha256:/);
    expect(proposal.stderr).toMatch(/Dear Owner/);
    // A dry run produces nothing.
    expect(await platform.documents.list()).toHaveLength(0);
  });

  it("refuses an owner-facing document at the contact gate when no consent is on record", async () => {
    const { templateId, bodyDigest } = await register(platform, OWNER);
    await approve(platform, templateId, bodyDigest, REVIEWER);
    await approve(platform, templateId, bodyDigest, SECOND);

    // No consent recorded. The gate runs before the chokepoint, so the letter is
    // refused before an approval even matters, and nothing is produced.
    const result = await capture(platform, `${OWNER_GENERATE} --reauthenticated`, REVIEWER);
    expect(result.thrown).toBeInstanceOf(DeniedError);
    expect((result.thrown as DeniedError).reason).toBe("contact.no_consent");
    expect(await platform.documents.list()).toHaveLength(0);
  });

  it("refuses an owner-facing document with consent but without its approval", async () => {
    const { templateId, bodyDigest } = await register(platform, OWNER);
    await approve(platform, templateId, bodyDigest, REVIEWER);
    await approve(platform, templateId, bodyDigest, SECOND);
    await grantConsent(platform);

    // Consent clears the gate; the chokepoint then refuses for want of an
    // approval bound to the proposal digest.
    const result = await capture(platform, `${OWNER_GENERATE} --reauthenticated`, REVIEWER);
    expect(result.thrown).toBeInstanceOf(DeniedError);
    expect((result.thrown as DeniedError).reason).toBe("approval.required");
    expect(await platform.documents.list()).toHaveLength(0);
  });

  it("produces an owner-facing document with consent and a granted approval", async () => {
    const { templateId, bodyDigest } = await register(platform, OWNER);
    await approve(platform, templateId, bodyDigest, REVIEWER);
    await approve(platform, templateId, bodyDigest, SECOND);
    await grantConsent(platform);

    // Raise the approval through the CLI, bound to the proposal digest.
    const raised = await run(platform, `${OWNER_GENERATE} --raise-approval`, REVIEWER);
    expect(raised.code).toBe(0);
    const approvalId = raised.stdout.trim();
    expect(approvalId).toMatch(/^apr_/);

    // Grant it as a different person, with a fresh step-up. The command line's
    // grant path needs a resolvable session, which the in-memory store cannot
    // share across processes, so the grant is made through the service directly —
    // the same call `pv approvals decide` makes over Postgres.
    await platform.approvals.decide({
      approvalId: approvalId as Id<"approval">,
      actor: AUTHOR,
      decision: "granted",
      secondsSinceAuthentication: 10,
      stepUpMaxAgeSeconds: 300,
      requiresStepUp: true,
    });

    // Generate with the granted approval and an asserted re-authentication.
    const produced = await run(platform, `${OWNER_GENERATE} --approval ${approvalId} --reauthenticated`, REVIEWER);
    expect(produced.code).toBe(0);
    const documentId = produced.stdout.trim();
    expect(documentId).toMatch(/^doc_/);

    const document = await platform.documents.get(documentId as Id<"document">);
    expect(document?.audience).toBe("consumer");
    expect(document?.approvalId).toBe(approvalId);
    // Who approved it, by name, on the document itself — and it is not the person
    // who generated it.
    expect(document?.approvedBy).toEqual([AUTHOR.actorId]);
    expect(document?.contactEvidenceDigest).toBeDefined();
    expect(document?.receiptId).toBeDefined();
    expect(document?.subjectRef).toBe("ctr_owner_1");
  });

  it("lists templates and refuses --raise-approval on an internal one", async () => {
    const { templateId, bodyDigest } = await register(platform, INTERNAL);
    await approve(platform, templateId, bodyDigest, REVIEWER);

    const listed = await run(platform, "documents template list --json", AUTHOR);
    const parsed = JSON.parse(listed.stdout) as Array<{ name: string; status: string }>;
    expect(parsed.map((entry) => entry.name)).toContain("association.reserve_summary");
    expect(parsed[0]?.status).toBe("approved");

    // An internal document needs no approval, so raising one is a usage error,
    // not something the command quietly does.
    const raised = await capture(
      platform,
      "documents generate --template association.reserve_summary " +
        "--value association=PalmRidge --value as_of=2026-06-30 --value balance=1204000 --format text --raise-approval",
      ASSOCIATION,
    );
    expect(raised.code).toBe(2);
    expect(raised.thrown).toBeUndefined();
  });

  it("a usage error exits 2, not 1: an unusable command is not a refusal", async () => {
    const result = await capture(
      platform,
      "documents template register --name association.reserve_summary --owner t",
      AUTHOR,
    );
    expect(result.code).toBe(2);
    expect(result.thrown).toBeUndefined();
  });
});
