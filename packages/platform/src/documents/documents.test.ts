import { describe, it, expect } from "vitest";
import { AuditLog } from "../audit/log.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import type { AuditEntry } from "../audit/types.js";
import { CONTACT_ACTIONS } from "../contact/actions.js";
import { ConsentLedger } from "../contact/consent.js";
import { ContactGate, destinationFingerprint } from "../contact/gate.js";
import { MemoryContactStore } from "../contact/store.memory.js";
import { ALL_CHANNELS, ALL_PURPOSES } from "../contact/types.js";
import { ApprovalService } from "../guard/approvals.js";
import { Authorizer } from "../guard/authorize.js";
import { CeilingEnforcer } from "../guard/ceilings.js";
import { ContainmentController } from "../guard/containment.js";
import { ActionRegistry } from "../guard/registry.js";
import { MemoryApprovalStore, MemoryContainmentStore } from "../guard/store.memory.js";
import { FixedClock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import { SeededIdGenerator, type Id } from "../kernel/ids.js";
import { MemoryRunStore } from "../record/store.memory.js";
import type { ActorRef } from "../record/types.js";
import { MemoryDb } from "../store/db.js";
import { PLATFORM_ACTIONS } from "../actions.js";
import { DOCUMENT_ACTIONS, GENERATE_OWNER_FACING_ACTION } from "./actions.js";
import { DocumentGenerator, type DocumentDelivery, type GenerateRequest } from "./generate.js";
import { MemoryDocumentStore } from "./store.memory.js";
import { TemplateRegistry, placeholdersIn, renderTemplate, substituteTemplate } from "./templates.js";
import type { Template, TemplateDraft, TemplateValues } from "./types.js";

/**
 * Governed generation: what it produces, and what it refuses.
 *
 * The refusals are the point of the module. A letter generated from an
 * unapproved template, a disclosure with a silent gap where a deadline should
 * be, or an owner letter produced for someone who opted out are all failures
 * that look like success from inside the code, so each has a test that proves
 * the platform stops rather than proceeds.
 */

const NOW = "2026-08-06T16:00:00.000Z";
const RUN_ID = "run_fixture" as Id<"run">;

/** Registers templates. Never approves their own. */
const AUTHOR: ActorRef = {
  actorId: "act_author",
  kind: "human",
  roles: ["compliance_reviewer"],
};
const REVIEWER: ActorRef = { actorId: "act_reviewer", kind: "human", roles: ["supervisor"] };
const SECOND_REVIEWER: ActorRef = {
  actorId: "act_reviewer_two",
  kind: "human",
  roles: ["platform_admin"],
};
/** Generates internal documents; holds no owner-facing role. */
const ASSOCIATION: ActorRef = {
  actorId: "act_association",
  kind: "human",
  roles: ["association_manager"],
};

const TEST_ACTIONS = [
  ...PLATFORM_ACTIONS,
  ...[...DOCUMENT_ACTIONS, ...CONTACT_ACTIONS].filter(
    (action) => !PLATFORM_ACTIONS.some((existing) => existing.name === action.name),
  ),
];

const EVIDENCE_DIGEST = digestValue({ artifact: "signed-consent-form" });
const DESTINATION = destinationFingerprint("email", "owner@example.com");

const DELIVERY: DocumentDelivery = {
  subjectRef: "ctr_owner_1",
  // Email is declared exempt from quiet hours in the shipped policy, so these
  // tests exercise the audience rule rather than the clock. Quiet hours have
  // their own tests next door.
  channel: "email",
  purpose: "servicing",
  relationship: "owner",
  destinationDigest: DESTINATION,
  jurisdiction: "US",
  recipientTimeZone: "America/New_York",
};

interface Harness {
  readonly clock: FixedClock;
  readonly ids: SeededIdGenerator;
  readonly templates: TemplateRegistry;
  readonly generator: DocumentGenerator;
  readonly ledger: ConsentLedger;
  readonly gate: ContactGate;
  readonly approvals: ApprovalService;
  readonly auditStore: MemoryAuditStore;
  readonly documents: MemoryDocumentStore;
}

async function harness(): Promise<Harness> {
  const clock = new FixedClock(NOW);
  const ids = new SeededIdGenerator("documents-test");
  const db = new MemoryDb();

  const auditStore = new MemoryAuditStore(db);
  const audit = new AuditLog(auditStore, clock, ids);
  const runs = new MemoryRunStore(db, clock, ids);

  const registry = new ActionRegistry(TEST_ACTIONS);
  const containment = new ContainmentController(new MemoryContainmentStore(db), clock, audit);
  const ceilings = new CeilingEnforcer(
    { runSpendUsd: 100, dailySpendUsd: 1000, runWallClockMs: 60_000, modelCallsPerMinute: 100 },
    clock,
    runs,
  );
  const approvals = new ApprovalService(new MemoryApprovalStore(db), clock, ids, audit);
  const authorizer = new Authorizer(registry, containment, ceilings, approvals, audit, clock, 300);

  const contactStore = new MemoryContactStore(db);
  const gate = new ContactGate(contactStore, authorizer, audit, clock, ids);
  const ledger = new ConsentLedger(contactStore, authorizer, audit, clock, ids);

  const documents = new MemoryDocumentStore(db);
  const templates = new TemplateRegistry(documents, authorizer, audit, clock, ids);

  await runs.createRun({
    id: RUN_ID,
    kind: "rescission.acknowledge",
    mode: "supervised",
    requestedBy: REVIEWER,
    subject: { contractId: "ctr_owner_1" },
    correlationId: "cor-1",
  });

  return {
    clock,
    ids,
    templates,
    generator: new DocumentGenerator(
      documents,
      templates,
      authorizer,
      approvals,
      runs,
      gate,
      audit,
      clock,
      ids,
    ),
    ledger,
    gate,
    approvals,
    auditStore,
    documents,
  };
}

const INTERNAL_DRAFT: TemplateDraft = {
  name: "association.reserve_summary",
  audience: "internal",
  owner: "association_services",
  description: "Reserve study summary for an association board pack",
  body: "Association: {{association}}\n\nReserve balance at {{as_of}} is {{balance}}.",
  declaredVariables: ["association", "as_of", "balance"],
  outputFormats: ["text", "html"],
};

const OWNER_DRAFT: TemplateDraft = {
  name: "owner.rescission_acknowledgement",
  audience: "consumer",
  owner: "owner_services",
  description: "Acknowledgement of a rescission request",
  body:
    "Dear {{owner_name}},\n\nWe received your cancellation request for contract {{contract_ref}}.\n" +
    "Your statutory rescission period ends on {{deadline}}.",
  declaredVariables: ["owner_name", "contract_ref", "deadline"],
  outputFormats: ["text", "html"],
};

const OWNER_VALUES: TemplateValues = {
  owner_name: "A. Owner",
  contract_ref: "ctr_owner_1",
  deadline: "2026-08-16",
};

/** Register and fully approve a template, returning the approved version. */
async function approvedTemplate(h: Harness, draft: TemplateDraft): Promise<Template> {
  const registered = await h.templates.register({
    ...draft,
    actor: AUTHOR,
    mode: "supervised",
    secondsSinceAuthentication: 10,
  });

  let current = registered;
  const reviewers = [REVIEWER, SECOND_REVIEWER].slice(0, registered.approvalsRequired);
  for (const reviewer of reviewers) {
    current = await h.templates.decide({
      templateId: registered.id,
      actor: reviewer,
      decision: "approved",
      bodyDigest: registered.bodyDigest,
      mode: "supervised",
      secondsSinceAuthentication: 10,
    });
  }
  return current;
}

async function grantConsent(h: Harness): Promise<void> {
  await h.ledger.record({
    subjectRef: DELIVERY.subjectRef,
    channel: DELIVERY.channel,
    purpose: DELIVERY.purpose,
    kind: "granted",
    effectiveAt: h.clock.nowIso(),
    provenance: {
      source: "signed_document",
      capturedBy: AUTHOR.actorId,
      evidenceDigest: EVIDENCE_DIGEST,
    },
    actor: REVIEWER,
    mode: "supervised",
  });
}

/** Raise and grant the approval an owner-facing generation needs. */
async function approveGeneration(h: Harness, request: GenerateRequest): Promise<Id<"approval">> {
  const proposal = await h.generator.propose(request);
  const approval = await h.approvals.request({
    action: GENERATE_OWNER_FACING_ACTION,
    proposalDigest: proposal.proposalDigest,
    summary: `Generate ${proposal.template.name}@${proposal.template.version}`,
    requestedBy: AUTHOR,
    approvalsRequired: 1,
    eligibleRoles: ["supervisor", "compliance_reviewer"],
  });
  await h.approvals.decide({
    approvalId: approval.id,
    actor: REVIEWER,
    decision: "granted",
    secondsSinceAuthentication: 10,
    stepUpMaxAgeSeconds: 300,
  });
  return approval.id;
}

function ownerRequest(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    templateName: OWNER_DRAFT.name,
    values: OWNER_VALUES,
    format: "text",
    actor: REVIEWER,
    mode: "supervised",
    runId: RUN_ID,
    correlationId: "cor-1",
    subjectRef: "ctr_owner_1",
    secondsSinceAuthentication: 10,
    delivery: DELIVERY,
    ...overrides,
  };
}

function entriesOfType(store: MemoryAuditStore, type: string): Promise<readonly AuditEntry[]> {
  return store.listAuditEntries({ eventType: [type as AuditEntry["eventType"]] });
}

// ---------------------------------------------------------------------------
// The template registry
// ---------------------------------------------------------------------------

describe("template registry", () => {
  it("registers a draft and assigns monotonic versions per name", async () => {
    const h = await harness();
    const first = await h.templates.register({
      ...INTERNAL_DRAFT,
      actor: AUTHOR,
      mode: "supervised",
    });
    const second = await h.templates.register({
      ...INTERNAL_DRAFT,
      body: `${INTERNAL_DRAFT.body}\n\nPrepared by {{preparer}}.`,
      declaredVariables: [...INTERNAL_DRAFT.declaredVariables, "preparer"],
      actor: AUTHOR,
      mode: "supervised",
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(first.status).toBe("draft");
    // A version is never edited: the second registration is a new artifact.
    expect(second.bodyDigest).not.toBe(first.bodyDigest);
  });

  it("assigns distinct versions when two registrations race", async () => {
    const h = await harness();
    const [first, second] = await Promise.all([
      h.templates.register({ ...INTERNAL_DRAFT, actor: AUTHOR, mode: "supervised" }),
      h.templates.register({ ...INTERNAL_DRAFT, actor: AUTHOR, mode: "supervised" }),
    ]);
    // Two bodies sharing one version number would make every citation of
    // "version 2" ambiguous, and a generated document is made of such citations.
    expect(new Set([first.version, second.version]).size).toBe(2);
  });

  it("refuses a body whose placeholders and declarations disagree", async () => {
    const h = await harness();
    const register = (draft: TemplateDraft): Promise<Template> =>
      h.templates.register({ ...draft, actor: AUTHOR, mode: "supervised" });

    await expect(
      register({ ...INTERNAL_DRAFT, declaredVariables: ["association", "as_of"] }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    await expect(
      register({
        ...INTERNAL_DRAFT,
        declaredVariables: [...INTERNAL_DRAFT.declaredVariables, "unused_field"],
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    await expect(
      register({
        ...INTERNAL_DRAFT,
        body: `${INTERNAL_DRAFT.body}\n\nPrepared {{ by-someone }}.`,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("refuses the author's own approval", async () => {
    const h = await harness();
    const draft = await h.templates.register({
      ...INTERNAL_DRAFT,
      actor: AUTHOR,
      mode: "supervised",
    });
    await expect(
      h.templates.decide({
        templateId: draft.id,
        actor: AUTHOR,
        decision: "approved",
        bodyDigest: draft.bodyDigest,
        mode: "supervised",
        secondsSinceAuthentication: 10,
      }),
    ).rejects.toMatchObject({ reason: "approval.self_approval" });
  });

  it("refuses a decision that names a different body than the stored one", async () => {
    const h = await harness();
    const draft = await h.templates.register({
      ...INTERNAL_DRAFT,
      actor: AUTHOR,
      mode: "supervised",
    });
    await expect(
      h.templates.decide({
        templateId: draft.id,
        actor: REVIEWER,
        decision: "approved",
        bodyDigest: digestValue({ body: "some other text entirely" }),
        mode: "supervised",
        secondsSinceAuthentication: 10,
      }),
    ).rejects.toMatchObject({ reason: "approval.digest_mismatch" });
  });

  it("needs two distinct reviewers for anything an owner will read", async () => {
    const h = await harness();
    const draft = await h.templates.register({
      ...OWNER_DRAFT,
      actor: AUTHOR,
      mode: "supervised",
    });
    expect(draft.approvalsRequired).toBe(2);

    const afterFirst = await h.templates.decide({
      templateId: draft.id,
      actor: REVIEWER,
      decision: "approved",
      bodyDigest: draft.bodyDigest,
      mode: "supervised",
      secondsSinceAuthentication: 10,
    });
    expect(afterFirst.status).toBe("draft");

    // The same reviewer again is not a second reviewer.
    await expect(
      h.templates.decide({
        templateId: draft.id,
        actor: REVIEWER,
        decision: "approved",
        bodyDigest: draft.bodyDigest,
        mode: "supervised",
        secondsSinceAuthentication: 10,
      }),
    ).rejects.toMatchObject({ reason: "approval.already_used" });

    const afterSecond = await h.templates.decide({
      templateId: draft.id,
      actor: SECOND_REVIEWER,
      decision: "approved",
      bodyDigest: draft.bodyDigest,
      mode: "supervised",
      secondsSinceAuthentication: 10,
    });
    expect(afterSecond.status).toBe("approved");
    expect(afterSecond.approvals).toHaveLength(2);
  });

  it("counts one reviewer once when their two clicks race", async () => {
    const h = await harness();
    const draft = await h.templates.register({
      ...OWNER_DRAFT,
      actor: AUTHOR,
      mode: "supervised",
    });

    const decide = (): Promise<Template> =>
      h.templates.decide({
        templateId: draft.id,
        actor: REVIEWER,
        decision: "approved",
        bodyDigest: draft.bodyDigest,
        mode: "supervised",
        secondsSinceAuthentication: 10,
      });

    const outcomes = await Promise.allSettled([decide(), decide()]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);

    // The version must still be a draft: one person cannot satisfy a
    // two-reviewer requirement by double-clicking.
    const current = await h.templates.get(draft.id);
    expect(current?.status).toBe("draft");
    expect(current?.approvals).toHaveLength(1);
  });

  it("refuses to lower a consumer template below dual control", async () => {
    const h = await harness();
    const draft = await h.templates.register({
      ...OWNER_DRAFT,
      approvalsRequired: 1,
      actor: AUTHOR,
      mode: "supervised",
    });
    expect(draft.approvalsRequired).toBe(2);
  });

  it("is immutable once approved", async () => {
    const h = await harness();
    const approved = await approvedTemplate(h, INTERNAL_DRAFT);
    // There is no edit path at all; the closest thing is a further decision,
    // and the registry refuses it.
    await expect(
      h.templates.decide({
        templateId: approved.id,
        actor: SECOND_REVIEWER,
        decision: "approved",
        bodyDigest: approved.bodyDigest,
        mode: "supervised",
        secondsSinceAuthentication: 10,
      }),
    ).rejects.toMatchObject({ reason: "approval.already_used" });
  });

  it("refuses to use a draft, and refuses to use a retired version", async () => {
    const h = await harness();
    await h.templates.register({ ...INTERNAL_DRAFT, actor: AUTHOR, mode: "supervised" });
    await expect(h.templates.requireUsable(INTERNAL_DRAFT.name)).rejects.toMatchObject({
      reason: "config.missing",
    });

    const approved = await approvedTemplate(h, {
      ...INTERNAL_DRAFT,
      name: "association.second_summary",
    });
    await h.templates.retire({
      templateId: approved.id,
      actor: REVIEWER,
      mode: "supervised",
      reason: "superseded",
      secondsSinceAuthentication: 10,
    });
    await expect(h.templates.requireUsable("association.second_summary")).rejects.toMatchObject({
      reason: "config.missing",
    });
  });

  it("refuses registration by an actor without the role", async () => {
    const h = await harness();
    const outsider: ActorRef = { actorId: "act_outsider", kind: "human", roles: ["finance"] };
    await expect(
      h.templates.register({ ...INTERNAL_DRAFT, actor: outsider, mode: "supervised" }),
    ).rejects.toMatchObject({ reason: "authorization.action_not_permitted" });
  });
});

// ---------------------------------------------------------------------------
// Substitution and rendering
// ---------------------------------------------------------------------------

describe("substitution", () => {
  const template = {
    name: "t",
    version: 1,
    body: "Hello {{owner_name}}, your deadline is {{deadline}}.",
    declaredVariables: ["owner_name", "deadline"],
  };

  it("merges declared values", () => {
    expect(
      substituteTemplate(template, { owner_name: "A. Owner", deadline: "2026-08-16" }, "text"),
    ).toBe("Hello A. Owner, your deadline is 2026-08-16.");
  });

  it("fails closed on a missing value rather than emitting an empty string", () => {
    // The failure this exists to prevent: a letter that reads "your deadline is
    // ." and looks like it was generated correctly.
    expect(() => substituteTemplate(template, { owner_name: "A. Owner" }, "text")).toThrow(
      InvalidInputError,
    );
    try {
      substituteTemplate(template, { owner_name: "A. Owner" }, "text");
    } catch (error) {
      expect((error as Error).message).toContain("deadline");
    }
  });

  it("refuses values the template does not declare", () => {
    expect(() =>
      substituteTemplate(
        template,
        { owner_name: "A", deadline: "2026-08-16", refund_amount: "1200" },
        "text",
      ),
    ).toThrow(InvalidInputError);
  });

  it("substitutes once, so a value containing a placeholder stays inert", () => {
    const out = substituteTemplate(
      template,
      { owner_name: "{{deadline}}", deadline: "2026-08-16" },
      "text",
    );
    // A second pass would have expanded the injected placeholder. There is no
    // second pass, and this is what proves it.
    expect(out).toBe("Hello {{deadline}}, your deadline is 2026-08-16.");
  });

  it("escapes merged values for HTML but never evaluates them", () => {
    const out = substituteTemplate(
      template,
      { owner_name: '<script>alert("x")</script>', deadline: "2026-08-16" },
      "html",
    );
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });

  it("refuses a non-primitive value", () => {
    expect(() =>
      substituteTemplate(
        template,
        { owner_name: { first: "A" }, deadline: "x" } as unknown as TemplateValues,
        "text",
      ),
    ).toThrow(InvalidInputError);
  });

  it("finds every distinct placeholder in a body", () => {
    expect(placeholdersIn("{{a}} {{ b }} {{a}}")).toEqual(["a", "b"]);
  });
});

describe("formats", () => {
  const template: Template = {
    id: "tpl_x" as Id<"template">,
    name: "t",
    version: 1,
    audience: "internal",
    owner: "team",
    status: "approved",
    description: "A letter",
    body: "Line one.\nLine two.\n\nSecond paragraph for {{who}}.",
    bodyDigest: digestValue({ body: "x" }),
    declaredVariables: ["who"],
    outputFormats: ["text", "html"],
    language: "en",
    approvalsRequired: 1,
    createdBy: "act_author",
    createdAt: NOW,
    approvals: [],
    approvedAt: NOW,
  };

  it("renders plain text deterministically", () => {
    const first = renderTemplate(template, { who: "the board" }, "text");
    const second = renderTemplate(template, { who: "the board" }, "text");
    expect(first.outputDigest).toBe(second.outputDigest);
    expect(first.body).toContain("Second paragraph for the board.");
    expect(first.contentType).toBe("text/plain; charset=utf-8");
  });

  it("renders HTML from the same approved body, with soft breaks preserved", () => {
    const rendered = renderTemplate(template, { who: "the board" }, "html");
    expect(rendered.body).toContain("<p>Line one.<br />");
    expect(rendered.body).toContain('<html lang="en">');
    // Self-contained: no stylesheet, script, or remote image to leak the fact
    // and time of reading.
    expect(rendered.body).not.toMatch(/<(script|link|img)\b/);
  });

  it("gives the two formats different digests", () => {
    expect(renderTemplate(template, { who: "x" }, "text").outputDigest).not.toBe(
      renderTemplate(template, { who: "x" }, "html").outputDigest,
    );
  });

  it("refuses a format the template does not declare", () => {
    expect(() => renderTemplate(template, { who: "x" }, "pdf")).toThrow(DeniedError);
  });

  it("refuses PDF and DOCX with an explanation rather than an unknown-value error", () => {
    const pdfTemplate: Template = { ...template, outputFormats: ["text", "pdf"] };
    try {
      renderTemplate(pdfTemplate, { who: "x" }, "pdf");
      expect.unreachable("PDF rendering must refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(DeniedError);
      expect((error as DeniedError).reason).toBe("config.missing");
      expect((error as Error).message).toContain("confirmed");
    }
  });
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

describe("generation", () => {
  it("records what produced the document and binds it to the run", async () => {
    const h = await harness();
    await approvedTemplate(h, INTERNAL_DRAFT);

    const document = await h.generator.generate({
      templateName: INTERNAL_DRAFT.name,
      values: { association: "Palm Ridge", as_of: "2026-06-30", balance: "$1,204,000" },
      format: "text",
      actor: ASSOCIATION,
      mode: "supervised",
      runId: RUN_ID,
      modelId: "drafting-model",
    });

    expect(document.templateName).toBe(INTERNAL_DRAFT.name);
    expect(document.templateVersion).toBe(1);
    expect(document.runId).toBe(RUN_ID);
    expect(document.modelId).toBe("drafting-model");
    expect(document.dataDigest).toBe(
      digestValue({
        values: { association: "Palm Ridge", as_of: "2026-06-30", balance: "$1,204,000" },
      }),
    );
    expect(document.body).toContain("Palm Ridge");
    expect(document.receiptId).toBeDefined();

    const entries = await entriesOfType(h.auditStore, "document.generated");
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    // Digests, never the merged values: this record is kept for seven years.
    expect(entry?.inputDigests["data"]).toBe(document.dataDigest);
    expect(entry?.inputDigests["output"]).toBe(document.outputDigest);
    expect(entry?.inputDigests["templateBody"]).toBe(document.templateBodyDigest);
    expect(entry?.decision["modelId"]).toBe("drafting-model");
  });

  it("refuses to generate from a template that was never approved", async () => {
    const h = await harness();
    await h.templates.register({ ...INTERNAL_DRAFT, actor: AUTHOR, mode: "supervised" });
    await expect(
      h.generator.generate({
        templateName: INTERNAL_DRAFT.name,
        values: { association: "Palm Ridge", as_of: "2026-06-30", balance: "$1" },
        format: "text",
        actor: ASSOCIATION,
        mode: "supervised",
        runId: RUN_ID,
      }),
    ).rejects.toMatchObject({ reason: "config.missing" });
  });

  it("refuses to bind a document to a run that is not in the operating record", async () => {
    const h = await harness();
    await approvedTemplate(h, INTERNAL_DRAFT);
    await expect(
      h.generator.generate({
        templateName: INTERNAL_DRAFT.name,
        values: { association: "Palm Ridge", as_of: "2026-06-30", balance: "$1" },
        format: "text",
        actor: ASSOCIATION,
        mode: "supervised",
        runId: "run_nonexistent" as Id<"run">,
      }),
    ).rejects.toMatchObject({ reason: "record.unavailable" });
    expect(await h.generator.list()).toHaveLength(0);
  });

  it("refuses generation by an actor without the role", async () => {
    const h = await harness();
    await approvedTemplate(h, INTERNAL_DRAFT);
    const outsider: ActorRef = { actorId: "act_outsider", kind: "human", roles: ["auditor"] };
    await expect(
      h.generator.generate({
        templateName: INTERNAL_DRAFT.name,
        values: { association: "Palm Ridge", as_of: "2026-06-30", balance: "$1" },
        format: "text",
        actor: outsider,
        mode: "supervised",
        runId: RUN_ID,
      }),
    ).rejects.toMatchObject({ reason: "authorization.action_not_permitted" });
  });

  it("keeps the metadata row when a body is purged", async () => {
    const h = await harness();
    await approvedTemplate(h, INTERNAL_DRAFT);
    const document = await h.generator.generate({
      templateName: INTERNAL_DRAFT.name,
      values: { association: "Palm Ridge", as_of: "2026-06-30", balance: "$1" },
      format: "text",
      actor: ASSOCIATION,
      mode: "supervised",
      runId: RUN_ID,
    });

    const purged = await h.generator.purgeBody(document.id);
    expect(purged.body).toBeNull();
    expect(purged.bodyRetained).toBe(false);
    expect(purged.bodyPurgedAt).toBe(NOW);
    // Everything needed to show the obligation was met survives the erasure.
    expect(purged.outputDigest).toBe(document.outputDigest);
    expect(purged.templateVersion).toBe(document.templateVersion);
    expect(purged.approvedBy).toEqual(document.approvedBy);
  });
});

// ---------------------------------------------------------------------------
// Consumer-facing documents and the contact gate
// ---------------------------------------------------------------------------

describe("consumer-facing generation", () => {
  it("refuses a consumer template with no delivery to check against", async () => {
    const h = await harness();
    await approvedTemplate(h, OWNER_DRAFT);
    await grantConsent(h);

    const request = ownerRequest({ delivery: undefined });
    // The check cannot be forgotten: the audience is a property of the approved
    // template, so no call site can opt out of it.
    await expect(h.generator.generate(request)).rejects.toMatchObject({
      reason: "contact.evidence_unavailable",
    });
    expect(await h.generator.list()).toHaveLength(0);
  });

  it("refuses to produce an owner letter for someone who never consented", async () => {
    const h = await harness();
    await approvedTemplate(h, OWNER_DRAFT);

    const request = ownerRequest();
    const approvalId = await approveGeneration(h, request);
    await expect(h.generator.generate({ ...request, approvalId })).rejects.toMatchObject({
      reason: "contact.no_consent",
    });
    // Nothing was produced, so nothing can leak from a queue or an attachment.
    expect(await h.generator.list()).toHaveLength(0);
  });

  it("refuses after a revocation, even with a granted approval in hand", async () => {
    const h = await harness();
    await approvedTemplate(h, OWNER_DRAFT);
    await grantConsent(h);

    const request = ownerRequest();
    const approvalId = await approveGeneration(h, request);

    h.clock.advance(60_000);
    await h.ledger.record({
      subjectRef: DELIVERY.subjectRef,
      channel: ALL_CHANNELS,
      purpose: ALL_PURPOSES,
      kind: "revoked",
      effectiveAt: h.clock.nowIso(),
      provenance: {
        source: "inbound_call",
        capturedBy: AUTHOR.actorId,
        evidenceDigest: EVIDENCE_DIGEST,
      },
      actor: REVIEWER,
      mode: "supervised",
    });

    await expect(h.generator.generate({ ...request, approvalId })).rejects.toMatchObject({
      reason: "contact.revoked",
    });
    expect(await h.generator.list()).toHaveLength(0);
  });

  it("generates and records the contact evidence when everything passes", async () => {
    const h = await harness();
    await approvedTemplate(h, OWNER_DRAFT);
    await grantConsent(h);

    const request = ownerRequest();
    const approvalId = await approveGeneration(h, request);
    const document = await h.generator.generate({ ...request, approvalId });

    expect(document.audience).toBe("consumer");
    expect(document.contactEvidenceDigest).toBeDefined();
    expect(document.approvalId).toBe(approvalId);
    // Who approved it, by name, on the document itself.
    expect(document.approvedBy).toEqual([REVIEWER.actorId]);
    expect(document.body).toContain("2026-08-16");

    const entries = await entriesOfType(h.auditStore, "document.generated");
    expect(entries[0]?.inputDigests["contactEvidence"]).toBe(document.contactEvidenceDigest);
    expect(entries[0]?.decision["contactGate"]).toBe("passed");
  });

  it("requires an approval for an owner-facing document", async () => {
    const h = await harness();
    await approvedTemplate(h, OWNER_DRAFT);
    await grantConsent(h);

    await expect(h.generator.generate(ownerRequest())).rejects.toMatchObject({
      reason: "approval.required",
    });
  });

  it("binds the approval to the data, so changing a value fails", async () => {
    const h = await harness();
    await approvedTemplate(h, OWNER_DRAFT);
    await grantConsent(h);

    const request = ownerRequest();
    const approvalId = await approveGeneration(h, request);

    const altered = {
      ...request,
      approvalId,
      values: { ...OWNER_VALUES, deadline: "2026-09-30" },
    };
    // What was approved is not what would be produced. A rescission deadline
    // moved by six weeks after sign-off is exactly the swap this closes.
    await expect(h.generator.generate(altered)).rejects.toMatchObject({
      reason: "approval.digest_mismatch",
    });
  });

  it("refuses at the store even if a caller assembles a consumer document by hand", async () => {
    const h = await harness();
    const approved = await approvedTemplate(h, OWNER_DRAFT);
    await expect(
      h.documents.putGeneratedDocument({
        id: "doc_handmade" as Id<"document">,
        templateId: approved.id,
        templateName: approved.name,
        templateVersion: approved.version,
        templateBodyDigest: approved.bodyDigest,
        dataDigest: digestValue({ values: OWNER_VALUES }),
        audience: "consumer",
        format: "text",
        outputDigest: digestValue({ body: "letter" }),
        body: "letter",
        bodyRetained: true,
        runId: RUN_ID,
        generatedBy: REVIEWER.actorId,
        generatedAt: NOW,
        approvedBy: [],
        // No contactEvidenceDigest: the structural half of "anything destined
        // for a consumer passes the gate".
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("records one document when a generation is retried under the same id", async () => {
    const h = await harness();
    const approved = await approvedTemplate(h, INTERNAL_DRAFT);
    const document = {
      id: "doc_retry" as Id<"document">,
      templateId: approved.id,
      templateName: approved.name,
      templateVersion: approved.version,
      templateBodyDigest: approved.bodyDigest,
      dataDigest: digestValue({ values: {} }),
      audience: "internal" as const,
      format: "text" as const,
      outputDigest: digestValue({ body: "pack" }),
      body: "pack",
      bodyRetained: true,
      runId: RUN_ID,
      generatedBy: ASSOCIATION.actorId,
      generatedAt: NOW,
      approvedBy: [],
    };
    await h.documents.putGeneratedDocument(document);
    await h.documents.putGeneratedDocument({ ...document, body: "a different pack" });
    const stored = await h.documents.getGeneratedDocument(document.id);
    expect(stored?.body).toBe("pack");
    expect(await h.documents.listGeneratedDocuments()).toHaveLength(1);
  });
});
