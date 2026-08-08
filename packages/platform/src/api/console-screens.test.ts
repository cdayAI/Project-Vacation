import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../kernel/config.js";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { buildPlatform, type Platform } from "../platform.js";
import { createServer } from "./server.js";
import type { ActorRef } from "../record/types.js";
import type { RoleDefinition } from "../roles/types.js";
import { RESCISSION_INTAKE_WORKFLOW_NAME } from "../workflows/rescission-intake.js";

/**
 * The eight console screens, tested for the shape each route must serve and the
 * honesty each screen must keep.
 *
 * These are the routes the console called and the server did not serve — the
 * gap the contract test's ratchet named. What matters here is not the happy
 * path alone but the truthful empty state (proposals with nothing drafted,
 * discovery switched off) and the refusals that keep a missing thing distinct
 * from a refused one (404, not 409, for an absent role, instance, or proposal).
 */

const START = "2026-08-06T12:00:00.000Z";

/** A console operator with the read entitlements these screens need. */
const OPERATOR: ActorRef = {
  actorId: "usr_dana",
  kind: "human",
  roles: ["supervisor", "compliance_reviewer", "finance", "platform_admin", "owner_services_agent"],
};

const AUTHOR: ActorRef = {
  actorId: "usr_admin",
  kind: "human",
  roles: ["platform_admin", "scope:legal"],
};

const INTAKE: RoleDefinition = {
  name: "rescission_intake",
  purpose: "Check an inbound rescission request against effective-dated authority and queue the doubtful.",
  actions: ["contract.check_rescission", "contract.flag_for_review"],
  riskCeiling: "sensitive",
  dataScopes: ["legal"],
  modelTask: "contact.classify_owner_intent",
  promptTemplateId: "contact.classify_owner_intent",
  promptTemplateVersion: 1,
  evaluationSetId: "rescission_intake_cases",
  humanTier: "automatic",
  operatingModes: ["shadow", "assisted", "supervised"],
};

const RESCISSION_CONTEXT = {
  contractId: "ctr_test_0001",
  stateCode: "FL",
  executedAt: "2024-01-10T12:00:00.000Z",
  deliveredAt: "2024-01-10T12:00:00.000Z",
} as const;

describe("the console's eight screens", () => {
  let platform: Platform;
  let app: FastifyInstance;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("console-screens"),
      logger: createNullLogger(),
    });
    app = createServer({ platform, developmentActor: OPERATOR });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await platform.close();
  });

  async function get(url: string) {
    const response = await app.inject({ method: "GET", url });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  }

  // --- roles ---------------------------------------------------------------

  it("serves the role registry as a page of role views", async () => {
    const { role, version } = await platform.roles.createRole({
      definition: INTAKE,
      author: AUTHOR,
      changeNote: "First cut of the rescission intake role.",
    });

    const { status, body } = await get("/api/roles");
    expect(status).toBe(200);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const view = items[0]!;
    expect(view.roleId).toBe(role.id);
    expect(view.name).toBe("rescission_intake");
    expect(view.version).toBe(version.version);
    expect(view.riskCeiling).toBe("sensitive");
    expect(view.humanInvolvement).toBe("automatic");
    expect(view.allowedActions).toEqual(["contract.check_rescission", "contract.flag_for_review"]);
    expect(view.disabled).toBe(false);
    // No evaluation has been run, so the field is absent rather than a zero.
    expect(view.latestEvaluation).toBeUndefined();
    expect(body.total).toBe(1);
  });

  it("serves a role's versions newest-first, and 404s an unknown role", async () => {
    const { role } = await platform.roles.createRole({
      definition: INTAKE,
      author: AUTHOR,
      changeNote: "v1.",
    });
    await platform.roles.createVersion({
      roleId: role.id,
      definition: { ...INTAKE, purpose: "Revised purpose for v2." },
      author: AUTHOR,
      changeNote: "v2 — clearer purpose.",
    });

    const { status, body } = await get(`/api/roles/${role.id}/versions`);
    expect(status).toBe(200);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.version)).toEqual([2, 1]);

    const missing = await get("/api/roles/role_does_not_exist/versions");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_found");
  });

  // --- workflows -----------------------------------------------------------

  it("describes a started workflow instance, and 404s an unknown one", async () => {
    const instance = await platform.engine.start({
      workflow: RESCISSION_INTAKE_WORKFLOW_NAME,
      requestedBy: OPERATOR,
      context: RESCISSION_CONTEXT,
      subject: { contractId: RESCISSION_CONTEXT.contractId },
    });

    const { status, body } = await get(`/api/workflows/${instance.id}`);
    expect(status).toBe(200);
    expect(body.instanceId).toBe(instance.id);
    expect(body.definitionName).toBe(RESCISSION_INTAKE_WORKFLOW_NAME);
    expect(typeof body.plainLanguageStatus).toBe("string");
    expect(Array.isArray(body.steps)).toBe(true);

    const missing = await get("/api/workflows/wfi_does_not_exist");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_found");
  });

  // --- improvement clusters (real) -----------------------------------------

  it("serves improvement clusters computed from real corrections", async () => {
    const { role } = await platform.roles.createRole({
      definition: INTAKE,
      author: AUTHOR,
      changeNote: "v1.",
    });

    const run = await platform.runs.createRun({
      kind: "rescission.verify",
      mode: "supervised",
      requestedBy: OPERATOR,
      subject: { contractId: "ctr_test_0001" },
      correlationId: "console-screens-test",
      roleId: role.id,
      roleVersion: 1,
    });
    await platform.runs.recordCost({
      runId: run.id,
      category: "model",
      amountUsd: 0.02,
      recordedAt: platform.clock.nowIso(),
    });
    await platform.observations.correction({
      runId: run.id,
      signature: "deadline.wrong_jurisdiction",
      note: "Applied the wrong state's rescission window.",
      observedBy: OPERATOR,
      mode: "supervised",
      correctionMinutes: 4,
    });

    const { status, body } = await get("/api/improvements/clusters");
    expect(status).toBe(200);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const cluster = items[0]!;
    expect(cluster.occurrences).toBe(1);
    expect(cluster.roleId).toBe(role.id);
    expect(cluster.exampleRunIds).toContain(run.id);
    // One correction against one comparable run: 100% of cases.
    expect(cluster.ratePercent).toBe(100);
    expect(body.total).toBe(1);
  });

  // --- improvement proposals (honestly empty) ------------------------------

  it("serves an empty proposals page honestly, and 404s an unknown proposal", async () => {
    const { status, body } = await get("/api/improvements/proposals");
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);

    const missing = await get("/api/improvements/proposals/prop_none");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_found");
  });

  // --- discovery (empty when disabled) -------------------------------------

  it("serves an empty discovery page while the feature is disabled", async () => {
    expect(platform.config.discoveryEnabled).toBe(false);
    const { status, body } = await get("/api/discovery/candidates");
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  // --- executive (business vs platform, every tile sourced) ----------------

  it("serves an executive board that never credits the platform for a business movement", async () => {
    const { status, body } = await get("/api/executive");
    expect(status).toBe(200);

    const business = body.businessMetrics as Array<Record<string, string>>;
    const platformMetrics = body.platformMetrics as Array<Record<string, string>>;
    expect(business.length).toBeGreaterThan(0);
    expect(platformMetrics.length).toBeGreaterThan(0);

    // Every business tile is MVW's own figure and says so; none is claimed as an
    // effect of this platform.
    for (const tile of business) {
      expect(tile.sourceNote).toContain("MVW reported");
      expect(tile.sourceNote).toContain("Not attributable to this platform");
    }
    // Every platform tile says the number was measured here.
    for (const tile of platformMetrics) {
      expect(tile.sourceNote).toContain("Measured by this platform");
    }

    // Runs completed is a count from the record; human hours saved is not
    // measured and is omitted with a stated caveat rather than shown as a number.
    expect(typeof body.runsCompleted).toBe("number");
    expect(body.humanHoursSaved).toBeUndefined();
    expect(String(body.measurementCaveat)).toContain("not yet measured");
  });
});
