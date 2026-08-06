import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../kernel/config.js";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { digestValue } from "../kernel/hash.js";
import { buildPlatform, type Platform } from "../platform.js";
import { createServer } from "./server.js";
import type { ActorRef } from "../record/types.js";
import { PROVENANCE_KEYS } from "./run-timeline.js";
import { HIGH_VALUE_FLOOR_USD } from "./work-queue.js";

/**
 * The three hero screens' data, tested for the things that would make them
 * lie.
 *
 * The happy path is barely interesting here. What matters is the failure mode
 * each field exists to prevent:
 *
 *   - A blast radius that reports a number nobody measured.
 *   - An artifact preview showing something other than what was approved.
 *   - A provenance badge that says "workflow" because somebody reworded a
 *     summary string.
 *   - A prior decision reported as a success when the run it authorised failed.
 *   - A model step whose unsourced output renders as an empty, reassuring
 *     provenance block.
 *   - A "correct this" control that quietly changes behaviour.
 *
 * Each of those has a test that asserts the refusal or the absence, not the
 * presence.
 */

const START = "2026-08-06T12:00:00.000Z";

const REQUESTER: ActorRef = {
  actorId: "usr_priya",
  kind: "human",
  roles: ["owner_services_agent"],
};

const APPROVER: ActorRef = {
  actorId: "usr_dana",
  kind: "human",
  roles: ["supervisor", "compliance_reviewer", "platform_admin"],
};

describe("the approval screen's decision context", () => {
  let platform: Platform;
  let app: FastifyInstance;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("hero"),
      logger: createNullLogger(),
    });
    app = createServer({ platform, developmentActor: APPROVER });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await platform.close();
  });

  async function park(overrides: Partial<Parameters<Platform["approvals"]["request"]>[0]> = {}) {
    return platform.approvals.request({
      action: "contact.send_owner_message",
      proposalDigest: digestValue({ letter: "Your cancellation window closes on 12 August." }),
      summary: "Notify the purchaser that the corrected disclosure restarts their window",
      requestedBy: REQUESTER,
      approvalsRequired: 1,
      eligibleRoles: ["supervisor"],
      subject: { contractId: "ctr_fl_0184423", state: "FL", channel: "letter" },
      ...overrides,
    });
  }

  it("states the ask in plain language, never as a serialised payload", async () => {
    const approval = await park({
      // A proposer that dumped its payload into the summary. The screen must
      // not put this on the line reserved for the question being asked.
      summary: '{"contractId":"ctr_fl_0184423","template":"rescission-notice@2026.1"}',
    });

    const body = (await app.inject({ method: "GET", url: `/api/approvals/${approval.id}` })).json();

    expect(body.ask).not.toContain("{");
    expect(body.ask).toBe("Send a message to an owner — ctr_fl_0184423");
    // The payload is still reachable, field by field, further down the screen.
    expect(body.proposal).toEqual(
      expect.arrayContaining([{ label: "contractId", value: "ctr_fl_0184423" }]),
    );
  });

  it("carries the effects, the rejection line, and the rule that demanded a human", async () => {
    const approval = await park();
    const body = (await app.inject({ method: "GET", url: `/api/approvals/${approval.id}` })).json();

    expect(body.effects.length).toBeGreaterThan(0);
    expect(body.effects.length).toBeLessThanOrEqual(4);
    expect(body.effects.join(" ")).toContain("messaging integration");
    expect(body.ifRejected).toMatch(/Nothing is sent/);

    expect(body.rule.ruleId).toBe("contact.send_owner_message");
    expect(body.rule.registered).toBe(true);
    expect(body.rule.source).toBe("action_registry");
    expect(body.rule.threshold).toBe("high consequence · 1 approver · step-up re-authentication");
  });

  it("reports an unmeasurable blast radius as absent, with the reason", async () => {
    const approval = await park();
    const body = (await app.inject({ method: "GET", url: `/api/approvals/${approval.id}` })).json();

    // The failure this guards: a fabricated number. An approver who learns the
    // blast radius is decorative stops reading it — and then stops reading the
    // fields beside it.
    expect(body.blastRadius.ownersAffected).toBeUndefined();
    expect(body.blastRadius.ownersAffectedUnknown).toMatch(/cannot count them/);
    expect(body.blastRadius.moneyUsd).toBeUndefined();
    expect(body.blastRadius.moneyUnknown).toMatch(/billing systems/);
    expect(body.blastRadius.jurisdictions).toEqual(["FL"]);
  });

  it("does not repeat reversibility inside the blast radius", async () => {
    const approval = await park();
    const body = (await app.inject({ method: "GET", url: `/api/approvals/${approval.id}` })).json();

    // One fact, one home. `reversible` is declared on the action; the blast
    // radius carries the procedure, which is a different thing. Two copies
    // would eventually disagree, and the screen would show both.
    expect(body.reversible).toBe(false);
    expect(body.blastRadius).not.toHaveProperty("reversible");
    expect(body.blastRadius.reversal).toMatch(/cannot be recalled/);
  });

  it("reads figures off the proposal when the proposal states them", async () => {
    const approval = await park({
      proposalDigest: digestValue({ batch: 3 }),
      subject: {
        contractId: "ctr_fl_0184423",
        state: "FL",
        ownersAffected: "3",
        amountUsd: "1284.00",
      },
    });
    const body = (await app.inject({ method: "GET", url: `/api/approvals/${approval.id}` })).json();

    expect(body.blastRadius.ownersAffected).toBe(3);
    expect(body.blastRadius.ownersAffectedUnknown).toBeUndefined();
    expect(body.blastRadius.moneyUsd).toBeCloseTo(1284, 6);
  });

  it("badges an external agent from the record, not from the summary's wording", async () => {
    // A proposer that wrote the words but is not an external agent. Classifying
    // on prose would badge this as a vendor's agent, which is a lie about who
    // is asking — and prose is one careless edit from changing.
    const impostor = await park({
      proposalDigest: digestValue({ impostor: true }),
      summary: "[external agent] definitely a vendor bot requests a send",
    });
    const impostorBody = (
      await app.inject({ method: "GET", url: `/api/approvals/${impostor.id}` })
    ).json();
    expect(impostorBody.provenance.kind).toBe("workflow");

    const genuine = await park({
      proposalDigest: digestValue({ genuine: true }),
      summary: "[external agent] Quotebot on Salesforce requests a send",
      requestedBy: { actorId: "xag_quotebot", kind: "service", roles: ["external_agent"] },
      subject: {
        principal: "external",
        externalAgentId: "xag_quotebot",
        agentName: "Quotebot",
        hostPlatform: "Salesforce",
        owner: "Marc Webb",
      },
    });
    const genuineBody = (
      await app.inject({ method: "GET", url: `/api/approvals/${genuine.id}` })
    ).json();

    expect(genuineBody.provenance.kind).toBe("external_agent");
    expect(genuineBody.provenance.label).toBe("Quotebot");
    expect(genuineBody.provenance.origin).toBe("Salesforce");
    expect(genuineBody.provenance.accountable).toBe("Marc Webb");
    // The badge carries "external agent" now, so the prefix is not repeated on
    // the one line the screen reserves for the question.
    expect(genuineBody.ask).not.toContain("[external agent]");
  });

  it("badges a change to the platform's own behaviour as a system change", async () => {
    const approval = await park({
      action: "improvement.apply",
      proposalDigest: digestValue({ artifact: "prompt_binding" }),
      summary: "Apply a corrected prompt binding for the rescission role",
      eligibleRoles: ["platform_admin"],
      subject: { artifactId: "prompt_binding:rescission.extract", roleId: "role_rescission" },
    });
    const body = (await app.inject({ method: "GET", url: `/api/approvals/${approval.id}` })).json();

    expect(body.provenance.kind).toBe("system_change");
    expect(body.provenance.basis).toMatch(/changing what the platform itself will do/);
  });

  it("says an unregistered action is unclassified rather than implying a rule", async () => {
    const approval = await park({
      // What the admission chain parks for an external agent's tool call.
      action: "external.issue_refund",
      proposalDigest: digestValue({ tool: "refund" }),
      summary: "[external agent] Quotebot on Salesforce requests \"issue_refund\"",
      requestedBy: { actorId: "xag_quotebot", kind: "service", roles: ["external_agent"] },
      subject: {
        principal: "external",
        agentName: "Quotebot",
        hostPlatform: "Salesforce",
        tool: "issue_refund",
        effectiveRisk: "high_consequence",
      },
    });
    const body = (await app.inject({ method: "GET", url: `/api/approvals/${approval.id}` })).json();

    expect(body.rule.registered).toBe(false);
    expect(body.rule.source).toBe("external_admission");
    // The operator's floored rating, read back from the record — not the
    // agent's own declaration, and not a default that flatters it.
    expect(body.risk).toBe("high_consequence");
    expect(body.effects.join(" ")).toMatch(/not a capability this platform has classified/);
  });

  it("offers no artifact preview when the platform holds only a digest", async () => {
    const approval = await park();
    const body = (await app.inject({ method: "GET", url: `/api/approvals/${approval.id}` })).json();

    expect(body.artifact).toBeUndefined();
    expect(body.artifactUnknown).toMatch(/digest of the proposal, not its content/);
  });

  it("previews the record write when the proposal provably is the subject", async () => {
    const subject = { contractId: "ctr_fl_0184423", state: "FL", flag: "compliance_review" };
    const approval = await park({
      action: "contract.flag_for_review",
      proposalDigest: digestValue(subject),
      subject,
    });
    const body = (await app.inject({ method: "GET", url: `/api/approvals/${approval.id}` })).json();

    expect(body.artifact.kind).toBe("record_write");
    expect(body.artifact.matchesProposalDigest).toBe(true);
    expect(body.artifact.body).toContain("ctr_fl_0184423");
  });

  it("marks a supplied artifact that does not re-digest to the approved proposal", async () => {
    const approval = await park();
    // A document store that returned the *current* template when the approval
    // was bound to the previous one. The preview must not silently stand in for
    // the thing being authorised.
    const withStore = createServer({
      platform,
      developmentActor: APPROVER,
      decisionContext: {
        artifact: () =>
          Promise.resolve({
            kind: "letter" as const,
            title: "Rescission deadline notice",
            mediaType: "text/plain",
            body: "Your cancellation window closes on 20 August.",
            digest: "sha256:0",
            matchesProposalDigest: true,
          }),
      },
    });
    await withStore.ready();

    const body = (
      await withStore.inject({ method: "GET", url: `/api/approvals/${approval.id}` })
    ).json();

    expect(body.artifact.matchesProposalDigest).toBe(false);
    expect(body.artifact.digest).not.toBe("sha256:0");
    await withStore.close();
  });

  it("says the evidence is unavailable rather than showing an empty list", async () => {
    const approval = await park();
    const body = (await app.inject({ method: "GET", url: `/api/approvals/${approval.id}` })).json();

    expect(body.evidence).toEqual([]);
    // "No corpus is connected" and "this proposal cites nothing" lead to
    // opposite conclusions, and an empty list alone cannot tell them apart.
    expect(body.evidenceUnknown).toMatch(/No corpus is connected/);
  });

  it("shows prior decisions on the same action, and how each one turned out", async () => {
    const run = await platform.runs.createRun({
      kind: "rescission.package_check",
      mode: "supervised",
      requestedBy: REQUESTER,
      subject: { contractId: "ctr_fl_0000001" },
      correlationId: "corr-prior",
    });

    const granted = await park({ proposalDigest: digestValue({ prior: 1 }) });
    await platform.approvals.decide({
      approvalId: granted.id,
      actor: APPROVER,
      decision: "granted",
      requiresStepUp: false,
    });
    await platform.approvals.consume({
      approvalId: granted.id,
      expectedProposalDigest: granted.proposalDigest,
      runId: run.id,
      actor: APPROVER,
    });
    // The run the approval was spent on then failed. A screen that reported
    // this as a success would be the most misleading field on it.
    await platform.runs.patchRun(run.id, {
      status: "failed",
      outcome: "The messaging integration rejected the address.",
    });

    const rejected = await park({ proposalDigest: digestValue({ prior: 2 }) });
    await platform.approvals.decide({
      approvalId: rejected.id,
      actor: APPROVER,
      decision: "rejected",
      note: "The FL rule in the corpus is still unverified.",
      requiresStepUp: false,
    });

    const current = await park({ proposalDigest: digestValue({ current: true }) });
    const body = (await app.inject({ method: "GET", url: `/api/approvals/${current.id}` })).json();

    expect(body.priorDecisions).toHaveLength(2);
    const outcomes = Object.fromEntries(
      body.priorDecisions.map((entry: { approvalId: string; outcome: string }) => [
        entry.approvalId,
        entry.outcome,
      ]),
    );
    expect(outcomes[granted.id]).toBe("failed");
    expect(outcomes[rejected.id]).toBe("not_carried_out");
    // Never itself.
    expect(outcomes[current.id]).toBeUndefined();
  });

  it("records a rejection as improvement signal without changing any behaviour", async () => {
    const run = await platform.runs.createRun({
      kind: "rescission.package_check",
      mode: "supervised",
      requestedBy: REQUESTER,
      subject: { contractId: "ctr_fl_0184423" },
      correlationId: "corr-reject",
    });
    const approval = await park({ runId: run.id });

    const response = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decisions`,
      payload: { decision: "rejected", note: "The disclosure receipt is still missing." },
    });
    expect(response.statusCode).toBe(200);

    const observations = await platform.observations.list({ runId: run.id });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.kind).toBe("proposal_rejected");
    expect(observations[0]?.signature).toBe("approval.rejected.contact.send_owner_message");
  });

  it("still refuses a self-approval at the API, however complete the screen is", async () => {
    const approval = await park({ requestedBy: APPROVER });
    const response = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decisions`,
      payload: { decision: "granted" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().reason).toBe("approval.self_approval");
  });
});

describe("the shipped action catalogue", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("catalogue"),
      logger: createNullLogger(),
    });
  });

  afterEach(async () => {
    await platform.close();
  });

  it("tells an approver what they are deciding, for every action that parks", () => {
    // The ratchet. An action that will stop in front of a person must be able
    // to say what that person is deciding — otherwise the approval screen has
    // nothing to render but a machine name and a digest, and the ten-second
    // decision this product is built around becomes an investigation.
    const missing = platform.registry
      .list()
      .filter((descriptor) => descriptor.humanInvolvement === "proposed_then_approved")
      .filter((descriptor) => descriptor.approvalGuidance === undefined)
      .map((descriptor) => descriptor.name);

    expect(
      missing,
      `These actions park for human approval and declare no approvalGuidance. Add ask / effects / ifRejected / reversal beside the risk tier in the action's own catalogue: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("registers the improvement loop's observe action, so a correction can be recorded", () => {
    // Without this the chokepoint refuses `improvement.observe` as an
    // unclassified action, and the console's "correct this" control is a
    // button that always fails.
    expect(platform.registry.has("improvement.observe")).toBe(true);
    expect(platform.registry.require("improvement.observe").risk).toBe("routine");
  });
});

describe("the work queue", () => {
  let platform: Platform;
  let app: FastifyInstance;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("queue"),
      logger: createNullLogger(),
    });
    app = createServer({ platform, developmentActor: APPROVER });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await platform.close();
  });

  async function seed(kind: string, status: Parameters<Platform["runs"]["patchRun"]>[1]["status"]) {
    const run = await platform.runs.createRun({
      kind,
      mode: "supervised",
      requestedBy: REQUESTER,
      subject: { contractId: `ctr_${kind}` },
      correlationId: `corr-${kind}`,
    });
    if (status) await platform.runs.patchRun(run.id, { status });
    return run;
  }

  it("sends the SLA target rather than a colour", async () => {
    await seed("rescission.package_check", "awaiting_approval");
    const body = (await app.inject({ method: "GET", url: "/api/runs" })).json();
    const row = body.items[0];

    expect(row.slaStartedAt).toBeDefined();
    expect(row.dueAt).toBe("2026-08-07T12:00:00.000Z");
    expect(row.slaPolicy).toBe("Rescission package check — one business day");
    // The 80%-of-target threshold is a design decision and belongs in the
    // design system, not in a serialiser where two densities could disagree.
    expect(row).not.toHaveProperty("ageBand");
    expect(row).not.toHaveProperty("ageColour");
  });

  it("declares no target rather than borrowing another kind's", async () => {
    await seed("unmapped.kind_nobody_agreed", "running");
    const body = (await app.inject({ method: "GET", url: "/api/runs" })).json();
    const row = body.items.find((item: { kind: string }) => item.kind === "unmapped.kind_nobody_agreed");

    expect(row.dueAt).toBeUndefined();
    expect(row.slaBreached).toBe(false);
    expect(row.slaTargetUnknown).toMatch(/No service-level target is declared/);
  });

  it("does not treat a finished run as breaching a deadline nobody is waiting on", async () => {
    const stale = await platform.runs.createRun({
      kind: "rescission.package_check",
      mode: "supervised",
      requestedBy: REQUESTER,
      subject: { contractId: "ctr_old" },
      correlationId: "corr-old",
    });
    await platform.runs.patchRun(stale.id, { status: "succeeded" });

    const body = (await app.inject({ method: "GET", url: "/api/runs" })).json();
    const row = body.items.find((item: { runId: string }) => item.runId === stale.id);
    expect(row.status).toBe("succeeded");
    expect(row.slaBreached).toBe(false);
  });

  it("distinguishes untracked assignment from nobody having picked it up", async () => {
    await seed("owner_services.response_draft", "pending");
    const body = (await app.inject({ method: "GET", url: "/api/runs" })).json();
    const row = body.items[0];

    // "Nobody has picked this up" is a call to action. "We do not track who
    // picked this up" is a gap in the deployment. An operator does something
    // different about each, so they are not the same value.
    expect(row.assignment).toBe("not_tracked");
    expect(row.assignee).toBeUndefined();
  });

  it("names what it cannot know about the owner and the value", async () => {
    await seed("rescission.package_check", "awaiting_approval");
    const body = (await app.inject({ method: "GET", url: "/api/runs" })).json();
    const row = body.items[0];

    expect(row.owner.accountRef).toBe("ctr_rescission.package_check");
    expect(row.owner.name).toBeUndefined();
    expect(row.owner.nameUnknown).toMatch(/never an owner's name/);
    expect(row.valueUsd).toBeUndefined();
    expect(row.valueUnknown).toMatch(/systems of record/);
  });

  it("gives every row a next action as a verb phrase", async () => {
    await seed("rescission.package_check", "awaiting_approval");
    await seed("loan_file.evidence_pack", "denied");
    const body = (await app.inject({ method: "GET", url: "/api/runs" })).json();

    const byKind = Object.fromEntries(
      body.items.map((item: { kind: string; nextAction: string }) => [item.kind, item.nextAction]),
    );
    expect(byKind["rescission.package_check"]).toBe("Approve or reject the parked action");
    expect(byKind["loan_file.evidence_pack"]).toBe("Read the refusal and take it forward by hand");
  });

  it("encodes every filter as a query parameter", async () => {
    await seed("rescission.package_check", "awaiting_approval");
    await seed("association.board_pack", "awaiting_human");

    const filtered = (
      await app.inject({
        method: "GET",
        url: "/api/runs?status=awaiting_approval&kind=rescission.package_check&sort=due_soonest&view=all_open&limit=10",
      })
    ).json();

    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].kind).toBe("rescission.package_check");
    expect(filtered.sort).toBe("due_soonest");
    expect(filtered.view).toBe("all_open");
    expect(filtered.highValueFloorUsd).toBe(HIGH_VALUE_FLOOR_USD);
  });

  it("refuses an unknown filter value instead of quietly widening the result", async () => {
    // Silently ignoring it would answer a different question from the one the
    // URL says was asked, and the person reading the screen could not tell.
    const response = await app.inject({ method: "GET", url: "/api/runs?status=urgent" });
    expect(response.statusCode).toBe(400);
    expect(response.json().field).toBe("status");

    const badSort = await app.inject({ method: "GET", url: "/api/runs?sort=whatever" });
    expect(badSort.statusCode).toBe(400);
  });

  it("excludes work whose value is unknown from the high-value view", async () => {
    await seed("rescission.package_check", "awaiting_approval");
    const body = (await app.inject({ method: "GET", url: "/api/runs?view=high_value" })).json();
    // An item whose value the platform cannot read is not evidence that the
    // value is high.
    expect(body.items).toEqual([]);
  });

  it("says whether its result count is the whole truth", async () => {
    await seed("rescission.package_check", "awaiting_approval");
    const plain = (await app.inject({ method: "GET", url: "/api/runs" })).json();
    expect(plain.totalIsExact).toBe(true);

    const postFiltered = (
      await app.inject({ method: "GET", url: "/api/runs?breaching=true" })
    ).json();
    expect(postFiltered).toHaveProperty("totalIsExact");
  });
});

describe("the run timeline", () => {
  let platform: Platform;
  let app: FastifyInstance;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("timeline"),
      logger: createNullLogger(),
    });
    app = createServer({ platform, developmentActor: APPROVER });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await platform.close();
  });

  async function seedRun() {
    return platform.runs.createRun({
      kind: "rescission.package_check",
      mode: "supervised",
      requestedBy: REQUESTER,
      subject: { contractId: "ctr_fl_0184423", state: "FL" },
      correlationId: "corr-timeline",
    });
  }

  it("maps thirteen machine kinds onto the five the timeline draws", async () => {
    const run = await seedRun();
    for (const kind of ["retrieval", "model_call", "integration_call", "human_task", "timer"] as const) {
      await platform.runs.appendStep({
        runId: run.id,
        kind,
        name: `step_${kind}`,
        idempotencyKey: `${run.id}:${kind}`,
        detail: {},
      });
    }

    const body = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
    const types = body.steps.map((step: { type: string }) => step.type);
    expect(types).toEqual(["retrieval", "model", "action", "human", "wait"]);
    // The raw kind survives, because an engineer reading a bug report needs it.
    expect(body.steps[2].kind).toBe("integration_call");
  });

  it("marks derived provenance as derived, and recorded provenance as recorded", async () => {
    const run = await seedRun();
    const derived = await platform.runs.appendStep({
      runId: run.id,
      kind: "model_call",
      name: "determine_rescission_window",
      idempotencyKey: `${run.id}:derived`,
      detail: { promptVersion: "rescission-v7" },
    });
    await platform.runs.patchStep(derived.id, { status: "succeeded" });

    const recorded = await platform.runs.appendStep({
      runId: run.id,
      kind: "model_call",
      name: "summarise_finding",
      idempotencyKey: `${run.id}:recorded`,
      detail: {
        [PROVENANCE_KEYS.cited]: "chk_fl_00412,chk_fl_00418",
        [PROVENANCE_KEYS.asserted]: "The purchaser has not yet taken occupancy.",
        [PROVENANCE_KEYS.computed]: "deadline=2026-08-20T23:59:00-04:00",
        [PROVENANCE_KEYS.derivation]: "FL §721.10 — ten calendar days from delivery",
      },
    });
    await platform.runs.patchStep(recorded.id, { status: "succeeded" });

    const body = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
    const [first, second] = body.steps;

    expect(first.provenance.recorded).toBe(false);
    expect(first.provenance.basis).toMatch(/inference about the step/);
    expect(second.provenance.recorded).toBe(true);
    expect(second.provenance.basis).toBe("Recorded by the step itself.");
    expect(second.provenance.retrieved).toHaveLength(2);
    expect(second.provenance.asserted[0].text).toContain("occupancy");
    expect(second.provenance.computed[0].label).toBe("deadline");
    expect(second.provenance.computed[0].derivation).toContain("§721.10");
  });

  it("says an unsourced model step is unsourced instead of showing nothing", async () => {
    const run = await seedRun();
    const step = await platform.runs.appendStep({
      runId: run.id,
      kind: "model_call",
      name: "draft_reply",
      idempotencyKey: `${run.id}:draft`,
      detail: {},
    });
    await platform.runs.patchStep(step.id, { status: "succeeded" });

    const body = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
    // An empty provenance block on a model step reads as "nothing was
    // claimed", and an unsourced claim is precisely what a supervisor most
    // needs to see.
    expect(body.steps[0].provenance.asserted).toHaveLength(1);
    expect(body.steps[0].provenance.asserted[0].text).toMatch(/recorded no citations/);
    expect(body.steps[0].citations).toEqual([]);
  });

  it("reports what followed a failure from the record, not in the abstract", async () => {
    const run = await seedRun();
    const failed = await platform.runs.appendStep({
      runId: run.id,
      kind: "integration_call",
      name: "load_contract",
      idempotencyKey: `${run.id}:load:1`,
      attempt: 1,
      detail: {},
    });
    await platform.runs.patchStep(failed.id, {
      status: "failed",
      error: "The contract records system did not answer within 30 seconds.",
    });
    await platform.runs.appendStep({
      runId: run.id,
      kind: "integration_call",
      name: "load_contract",
      idempotencyKey: `${run.id}:load:2`,
      attempt: 2,
      detail: {},
    });

    const body = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
    expect(body.steps[0].failure.what).toMatch(/did not answer/);
    expect(body.steps[0].failure.followedBy).toBe("Retried as attempt 2.");
  });

  it("does not claim a retry followed when nothing did", async () => {
    const run = await seedRun();
    const step = await platform.runs.appendStep({
      runId: run.id,
      kind: "model_call",
      name: "rank_borrowers",
      idempotencyKey: `${run.id}:rank`,
      detail: {},
    });
    await platform.runs.patchStep(step.id, {
      status: "denied",
      denialReason: "Ranking consumers is not a registered action for this role.",
    });

    const body = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
    expect(body.steps[0].failure.followedBy).toBe("Nothing followed. The run stopped here.");
    // A refusal produced nothing to disagree with, so there is nothing to
    // correct — a "correction" there would be a complaint about the refusal.
    expect(body.steps[0].correctable).toBe(false);
  });

  it("attributes cost per step from the ledger, and agrees with the run total", async () => {
    const run = await seedRun();
    const step = await platform.runs.appendStep({
      runId: run.id,
      kind: "model_call",
      name: "draft",
      idempotencyKey: `${run.id}:draft`,
      detail: {},
    });
    await platform.runs.recordCost({
      runId: run.id,
      stepId: step.id,
      category: "model",
      amountUsd: 0.0912,
      recordedAt: platform.clock.nowIso(),
    });

    const body = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
    expect(body.steps[0].costUsd).toBeCloseTo(0.0912, 6);
    expect(body.totalCostUsd).toBeCloseTo(0.0912, 6);
  });

  it("says who did a human step, or says that nobody recorded it", async () => {
    const run = await seedRun();
    const named = await platform.runs.appendStep({
      runId: run.id,
      kind: "human_task",
      name: "verify_receipt",
      idempotencyKey: `${run.id}:verify`,
      detail: { actorId: "usr_dana" },
    });
    await platform.runs.patchStep(named.id, { status: "succeeded" });
    await platform.runs.appendStep({
      runId: run.id,
      kind: "human_task",
      name: "countersign",
      idempotencyKey: `${run.id}:countersign`,
      detail: {},
    });

    const body = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
    expect(body.steps[0].human.actor.actorId).toBe("usr_dana");
    expect(body.steps[1].human.actor).toBeUndefined();
    expect(body.steps[1].human.actorUnknown).toMatch(/cannot be chased/);
  });
});

describe('"correct this"', () => {
  let platform: Platform;
  let app: FastifyInstance;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("correct"),
      logger: createNullLogger(),
    });
    app = createServer({ platform, developmentActor: APPROVER });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await platform.close();
  });

  async function seedStep() {
    const run = await platform.runs.createRun({
      kind: "rescission.package_check",
      mode: "supervised",
      requestedBy: REQUESTER,
      subject: { contractId: "ctr_fl_0184423" },
      correlationId: "corr-correct",
    });
    const step = await platform.runs.appendStep({
      runId: run.id,
      kind: "model_call",
      name: "determine_rescission_window",
      idempotencyKey: `${run.id}:window`,
      detail: {},
    });
    await platform.runs.patchStep(step.id, { status: "succeeded" });
    return { run, step };
  }

  it("records a correction against the run, into the existing signal path", async () => {
    const { run, step } = await seedStep();

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/steps/${step.id}/corrections`,
      headers: { "idempotency-key": "corr-key-1" },
      payload: {
        signature: "deadline.wrong_jurisdiction",
        note: "It applied the South Carolina clock to a Florida contract.",
        correctionMinutes: 12,
        before: "2026-08-16",
        after: "2026-08-20",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.recorded).toBe(true);
    expect(body.effect).toMatch(/changes nothing on its own/);

    const observations = await platform.observations.list({ runId: run.id });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.kind).toBe("human_correction");
    expect(observations[0]?.stepId).toBe(step.id);
    expect(observations[0]?.correctionMinutes).toBe(12);
    // Fingerprints, not content. The texts stay in the systems whose retention
    // rules govern them; this record proves the linkage.
    expect(observations[0]?.beforeDigest).toMatch(/^sha256:/);
  });

  it("does not count a resubmitted correction twice", async () => {
    const { run, step } = await seedStep();
    const payload = {
      signature: "deadline.wrong_jurisdiction",
      note: "It applied the South Carolina clock to a Florida contract.",
      before: "2026-08-16",
      after: "2026-08-20",
    };

    const first = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/steps/${step.id}/corrections`,
      headers: { "idempotency-key": "corr-key-1" },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/steps/${step.id}/corrections`,
      headers: { "idempotency-key": "corr-key-1" },
      payload,
    });

    expect(first.json().recorded).toBe(true);
    expect(second.json().recorded).toBe(false);
    // Frequency decides which failure gets a person's attention. A retry that
    // inflated it would steer the queue.
    expect(await platform.observations.count({ runId: run.id })).toBe(1);
  });

  it("refuses a correction against a run the operating record does not have", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/runs/run_never_existed/steps/stp_x/corrections",
      payload: { signature: "deadline.wrong_jurisdiction", note: "n/a" },
    });
    // A correction with no run behind it is an anecdote: there is no way to
    // check what the platform was asked, what it answered, or what it cost.
    expect(response.statusCode).toBe(409);
    expect(response.json().denied).toBe(true);
  });

  it("refuses a free-text signature, so clustering keeps working", async () => {
    const { run, step } = await seedStep();
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/steps/${step.id}/corrections`,
      payload: { signature: "The dates were all wrong!", note: "see above" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().field).toBe("signature");
  });

  it("leaves the improvement gate exactly where it was", async () => {
    const { run, step } = await seedStep();
    await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/steps/${step.id}/corrections`,
      payload: { signature: "deadline.wrong_jurisdiction", note: "Wrong state clock." },
    });

    // The correction is evidence, and evidence alone. Applying a behaviour
    // change is still `high_consequence` with an approval, and the action that
    // would skip it is still prohibited outright. ADR 0011.
    expect(platform.registry.require("improvement.apply").humanInvolvement).toBe(
      "proposed_then_approved",
    );
    expect(platform.registry.require("improvement.apply_without_approval").risk).toBe("prohibited");
  });
});
