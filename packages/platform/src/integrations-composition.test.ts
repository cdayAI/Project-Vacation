import { describe, it, expect } from "vitest";
import { FixedClock } from "./kernel/clock.js";
import { SeededIdGenerator } from "./kernel/ids.js";
import { createNullLogger } from "./kernel/logger.js";
import { DeniedError } from "./kernel/errors.js";
import { loadConfig } from "./kernel/config.js";
import { buildPlatform, type Platform } from "./platform.js";
import { StaticSecretProvider, sealCredential } from "./integrations/credentials.js";
import {
  IntegrationCallError,
  type EgressRequest,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "./integrations/egress.js";
import type { Id } from "./kernel/ids.js";

/**
 * The integrations layer, composed.
 *
 * The finding this file answers (T-13): the layer was built and inert. The
 * egress client was constructed nowhere, the degradation handler had no
 * production caller, and the ports were implemented only by fakes built inside
 * tests — so no system of record was reached from the composed platform, and
 * `PV_EGRESS_ALLOWLIST` bounded nothing. These cases assert the opposite through
 * `buildPlatform`: the ports read seeded records, the egress client is bounded
 * by the configured allowlist, and the degradation handler runs over the queue
 * store the migrations create — the same governed path the CLI and the API now
 * reach.
 *
 * The transport and the credentials are injected so the whole path is exercised
 * with no network and no environment, which is the seam `BuildOptions` exists
 * for.
 */

const START = "2026-08-08T00:00:00.000Z";
const HOST = "contracts.partner.example.com";
const SECRET = "sk-live-do-not-log-this-1234567890";

/** An HTTP client driven by a script, so nothing reaches the network. */
class ScriptedHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly response: HttpResponse | Error) {}
  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

async function compose(
  overrides: {
    readonly allowlist?: string;
    readonly http?: HttpClient;
  } = {},
): Promise<Platform> {
  return buildPlatform(
    loadConfig({
      PV_ENV: "development",
      PV_STORE: "memory",
      PV_EGRESS_ALLOWLIST: overrides.allowlist ?? HOST,
    }),
    {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("integrations-composition"),
      logger: createNullLogger(),
      integrationSecrets: new StaticSecretProvider([
        sealCredential({
          reference: "contract-records",
          scheme: "bearer",
          value: SECRET,
          allowedHosts: [HOST],
        }),
      ]),
      ...(overrides.http ? { integrationHttp: overrides.http } : {}),
    },
  );
}

async function probeRun(platform: Platform): Promise<Id<"run">> {
  const run = await platform.runs.createRun({
    kind: "integration.probe",
    mode: "assisted",
    requestedBy: { actorId: "cli:test", kind: "human", roles: ["platform_admin"] },
    subject: { integration: "contract-records" },
    correlationId: "cor_compose",
  });
  return run.id;
}

function aRequest(runId: Id<"run">, overrides: Partial<EgressRequest> = {}): EgressRequest {
  return {
    integration: "contract-records",
    runId,
    stepName: "probe",
    method: "GET",
    url: `https://${HOST}/contracts/ctr_fl_recent_complete`,
    credentialReference: "contract-records",
    correlationId: "cor_compose",
    maxAttempts: 1,
    ...overrides,
  };
}

describe("the composed integrations layer", () => {
  it("exposes the ports, the egress client, and the degradation handler on the platform", async () => {
    const platform = await compose();
    try {
      expect(platform.contractRecords).toBeDefined();
      expect(platform.associationRecords).toBeDefined();
      expect(platform.egress).toBeDefined();
      expect(platform.degradation).toBeDefined();
      expect(platform.integrationQueue).toBeDefined();
      // The two ports, as registered systems of record.
      expect(platform.systemsOfRecord.map((s) => s.describe().name).sort()).toEqual([
        "association-records",
        "contract-records",
      ]);
    } finally {
      await platform.close();
    }
  });

  it("reads a seeded contract record through the ContractRecordsPort", async () => {
    const platform = await compose();
    try {
      const record = await platform.contractRecords.getContract(
        "ctr_fl_recent_complete" as Id<"contract">,
      );
      expect(record?.jurisdiction).toBe("FL");
      expect(record?.status).toBe("executed");
      // A contract the system of record does not hold is null, not a fabrication.
      expect(await platform.contractRecords.getContract("ctr_nope" as Id<"contract">)).toBeNull();
    } finally {
      await platform.close();
    }
  });

  it("reads a seeded association and its budget through the AssociationRecordsPort", async () => {
    const platform = await compose();
    try {
      const associations = await platform.associationRecords.listAssociations();
      expect(associations.map((a) => a.associationId)).toContain("1042");
      const budget = await platform.associationRecords.getBudgetSummary("1042", 2026);
      expect(budget?.reserveBalanceCents).toBe(122_450_00);
      // The association with no reserve study reports the absence rather than zero.
      const noStudy = await platform.associationRecords.getBudgetSummary("2087", 2026);
      expect(noStudy?.reserveStudyDate).toBeUndefined();
    } finally {
      await platform.close();
    }
  });

  it("refuses a call to a host the configured allowlist does not name", async () => {
    // The allowlist finally bounds a composed client: the refusal happens before
    // anything leaves the process, which is the whole point of the finding.
    const http = new ScriptedHttp({ status: 200, body: "{}" });
    const platform = await compose({ http });
    try {
      const runId = await probeRun(platform);
      await expect(
        platform.egress.send(aRequest(runId, { url: "https://evil.example/exfiltrate" })),
      ).rejects.toMatchObject({ reason: "integration.host_not_allowlisted" });
      // Nothing went out.
      expect(http.requests.length).toBe(0);
    } finally {
      await platform.close();
    }
  });

  it("refuses every call when the configured allowlist is empty", async () => {
    const http = new ScriptedHttp({ status: 200, body: "{}" });
    const platform = await compose({ allowlist: "", http });
    try {
      const runId = await probeRun(platform);
      await expect(platform.egress.send(aRequest(runId))).rejects.toMatchObject({
        reason: "integration.host_not_allowlisted",
      });
      expect(http.requests.length).toBe(0);
    } finally {
      await platform.close();
    }
  });

  it("sends to an allowlisted host and records the step in the operating record", async () => {
    const http = new ScriptedHttp({ status: 200, body: '{"contractId":"ctr_fl_recent_complete"}' });
    const platform = await compose({ http });
    try {
      const runId = await probeRun(platform);
      const outcome = await platform.egress.send(aRequest(runId));
      expect(outcome.kind).toBe("sent");
      // The credential was presented on the wire and nowhere else.
      expect(http.requests[0]?.headers["authorization"]).toBe(`Bearer ${SECRET}`);
      const steps = await platform.runs.listSteps(runId);
      expect(steps.length).toBe(1);
      expect(steps[0]?.status).toBe("succeeded");
      expect(JSON.stringify(steps)).not.toContain(SECRET);
    } finally {
      await platform.close();
    }
  });

  it("queues a failing call under the queue policy, over the composed queue store", async () => {
    // A genuine failure — a 503 from an allowlisted host — is degraded, not
    // refused. The degradation handler runs over the same queue store the
    // integration migrations create, which is what makes the retry durable.
    const http = new ScriptedHttp({ status: 503, body: "" });
    const platform = await compose({ http });
    try {
      const runId = await probeRun(platform);
      const outcome = await platform.degradation.run(
        "queue",
        {
          integration: "contract-records",
          operation: "egress.GET",
          idempotencyKey: "compose-queue-1",
          subject: { host: HOST },
          runId,
          summary: "probe",
        },
        () => platform.egress.send(aRequest(runId)),
      );
      expect(outcome.kind).toBe("queued");
      const queued = await platform.integrationQueue.listQueued();
      expect(queued.length).toBe(1);
      expect(queued[0]?.idempotencyKey).toBe("compose-queue-1");
      expect(queued[0]?.attempts).toBe(1);
    } finally {
      await platform.close();
    }
  });

  it("never degrades a governance refusal, even under the queue policy", async () => {
    // A DeniedError is a policy decision, not a transient fault. Queueing one
    // would retry a refusal forever. The composed handler re-raises it and
    // queues nothing.
    const http = new ScriptedHttp({ status: 200, body: "{}" });
    const platform = await compose({ http });
    try {
      const runId = await probeRun(platform);
      await expect(
        platform.degradation.run(
          "queue",
          {
            integration: "contract-records",
            operation: "egress.GET",
            idempotencyKey: "compose-denied-1",
            summary: "probe",
          },
          () => platform.egress.send(aRequest(runId, { url: "https://evil.example/x" })),
        ),
      ).rejects.toBeInstanceOf(DeniedError);
      expect(await platform.integrationQueue.listQueued()).toEqual([]);
    } finally {
      await platform.close();
    }
  });

  it("surfaces a permitted call that then fails as an IntegrationCallError, not a refusal", async () => {
    const http = new ScriptedHttp(new Error("ECONNRESET"));
    const platform = await compose({ http });
    try {
      const runId = await probeRun(platform);
      await expect(platform.egress.send(aRequest(runId))).rejects.toBeInstanceOf(IntegrationCallError);
    } finally {
      await platform.close();
    }
  });
});
