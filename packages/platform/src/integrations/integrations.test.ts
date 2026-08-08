import { describe, it, expect } from "vitest";
import { FixedClock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { RecordingLogger } from "../kernel/logger.js";
import { redactValue } from "../kernel/redact.js";
import { AuditLog } from "../audit/log.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { MemoryRunStore } from "../record/store.memory.js";
import type { Run } from "../record/types.js";
import { ContainmentController } from "../guard/containment.js";
import { MemoryContainmentStore } from "../guard/store.memory.js";
import { MemoryDb } from "../store/db.js";
import {
  associationRecordsContract,
  contractRecordsContract,
  formatContractResults,
  runContract,
} from "./contract-tests.js";
import {
  CredentialRevocationService,
  EnvSecretProvider,
  RevocableSecretProvider,
  StaticSecretProvider,
  hostMatches,
  sealCredential,
} from "./credentials.js";
import { DegradationHandler } from "./degrade.js";
import {
  EgressClient,
  IntegrationCallError,
  isRetryableStatus,
  type EgressRequest,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "./egress.js";
import { FakeAssociationRecords, FakeContractRecords } from "./fakes.js";
import { MIGRATIONS } from "./migrations.js";
import {
  MemoryCredentialRevocationStore,
  MemoryIntegrationQueueStore,
} from "./store.memory.js";

/**
 * Integration tests.
 *
 * Three groups, in order of what they protect:
 *
 *   the contract suite, run against both fakes, so the fakes cannot drift into
 *   being more forgiving than a real adapter would be;
 *
 *   the egress client, where most of the assertions are refusals — an
 *   allowlist that is not enforced, a credential that reaches a log, or a
 *   retry without an idempotency key are each a single incident away from
 *   being the whole story;
 *
 *   degradation, where every branch is asserted, including the one that must
 *   never be taken: a governance refusal must not be queued.
 */

const T0 = "2026-08-06T12:00:00.000Z";
const HOST = "contracts.partner.example.com";
const URL_BASE = `https://${HOST}`;

const CREDENTIAL_SECRET = "sk-live-do-not-log-this-value-1234567890";

interface Harness {
  readonly db: MemoryDb;
  readonly clock: FixedClock;
  readonly logger: RecordingLogger;
  readonly audit: AuditLog;
  readonly runs: MemoryRunStore;
  readonly containment: ContainmentController;
  readonly queue: MemoryIntegrationQueueStore;
  readonly revocations: MemoryCredentialRevocationStore;
  run: Run;
}

async function harness(): Promise<Harness> {
  const db = new MemoryDb();
  const clock = new FixedClock(T0);
  const ids = new SeededIdGenerator("integrations-test");
  const logger = new RecordingLogger();
  const audit = new AuditLog(new MemoryAuditStore(db), clock, ids);
  const runs = new MemoryRunStore(db, clock, ids);
  const run = await runs.createRun({
    kind: "rescission.verify",
    mode: "assisted",
    requestedBy: { actorId: "act_agent", kind: "human", roles: ["owner_services_agent"] },
    subject: { contractId: "ctr_fl_recent_complete" },
    correlationId: "cor_1",
  });
  return {
    db,
    clock,
    logger,
    audit,
    runs,
    containment: new ContainmentController(new MemoryContainmentStore(db), clock, audit),
    queue: new MemoryIntegrationQueueStore(db),
    revocations: new MemoryCredentialRevocationStore(db),
    run,
  };
}

/** An HTTP client driven by a script, so nothing reaches the network. */
class ScriptedHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];

  constructor(
    private readonly responses: readonly (HttpResponse | Error)[],
    private readonly onRequest?: (request: HttpRequest, index: number) => void | Promise<void>,
  ) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const index = this.requests.length;
    this.requests.push(request);
    await this.onRequest?.(request, index);
    const next = this.responses[Math.min(index, this.responses.length - 1)];
    if (next instanceof Error) throw next;
    if (!next) throw new Error("script exhausted");
    return next;
  }
}

function secrets(overrides: Partial<Parameters<typeof sealCredential>[0]> = {}) {
  return new StaticSecretProvider([
    sealCredential({
      reference: "contract-records",
      scheme: "bearer",
      value: CREDENTIAL_SECRET,
      allowedHosts: [HOST],
      ...overrides,
    }),
  ]);
}

function egress(
  h: Harness,
  http: HttpClient,
  options: Partial<ConstructorParameters<typeof EgressClient>[0]> = {},
): EgressClient {
  return new EgressClient({
    allowlist: [HOST],
    runs: h.runs,
    clock: h.clock,
    secrets: secrets(),
    http,
    containment: h.containment,
    logger: h.logger,
    // Retries must not make the suite wait, and the backoff must be
    // deterministic so the demo reproduces.
    sleep: async () => {},
    jitter: () => 0,
    ...options,
  });
}

function aRequest(h: Harness, overrides: Partial<EgressRequest> = {}): EgressRequest {
  return {
    integration: "contract-records",
    runId: h.run.id,
    stepName: "fetch_contract",
    method: "GET",
    url: `${URL_BASE}/contracts/ctr_fl_recent_complete`,
    credentialReference: "contract-records",
    correlationId: "cor_1",
    ...overrides,
  };
}

const OK: HttpResponse = { status: 200, body: '{"contractId":"ctr_fl_recent_complete"}' };

// ---------------------------------------------------------------------------
// The shared contract suite, run against the fakes
// ---------------------------------------------------------------------------

describe("contract-records contract", () => {
  const cases = contractRecordsContract({
    window: { from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" },
    unknownContractId: "ctr_does_not_exist" as Id<"contract">,
  });

  for (const testCase of cases) {
    it(`the fake ${testCase.name}`, async () => {
      await testCase.run(new FakeContractRecords(new FixedClock(T0)));
    });
  }

  it("reports every failure at once rather than only the first", async () => {
    // A deliberately broken adapter: an unknown contract yields a fabricated
    // record instead of null, which is the failure the suite exists to catch.
    const broken = new FakeContractRecords(new FixedClock(T0));
    const fabricating = new Proxy(broken, {
      get(target, property, receiver) {
        if (property === "getContract") {
          return async () => ({
            ...(await target.getContract("ctr_fl_recent_complete" as Id<"contract">)),
          });
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const results = await runContract(cases, fabricating);
    const failed = results.filter((result) => !result.passed);
    expect(failed.length).toBeGreaterThan(0);
    expect(formatContractResults("fabricating-adapter", results)).toContain("NOT satisfied");
    // Every case still ran, so an adapter author gets the whole list.
    expect(results.length).toBe(cases.length);
  });
});

describe("association-records contract", () => {
  const cases = associationRecordsContract({
    fiscalYear: 2026,
    unknownAssociationId: "no-such-association",
  });

  for (const testCase of cases) {
    it(`the fake ${testCase.name}`, async () => {
      await testCase.run(new FakeAssociationRecords(new FixedClock(T0)));
    });
  }
});

describe("the seeded fakes", () => {
  it("cover the branches the first workflows have to handle", async () => {
    const contracts = new FakeContractRecords(new FixedClock(T0));
    const all = await contracts.listContractsExecutedBetween(
      "2000-01-01T00:00:00.000Z",
      "2100-01-01T00:00:00.000Z",
      100,
    );
    expect(all.some((record) => record.disclosuresDeliveredAt === undefined)).toBe(true);
    expect(all.some((record) => !record.documentSetComplete)).toBe(true);
    expect(all.some((record) => record.financed)).toBe(true);
    expect(all.some((record) => record.status === "rescinded")).toBe(true);
    expect(all.some((record) => record.status === "pending")).toBe(true);
  });

  it("fails on demand, so the degradation paths are testable", async () => {
    const contracts = new FakeContractRecords(new FixedClock(T0));
    contracts.failNext(1);
    await expect(
      contracts.getContract("ctr_fl_recent_complete" as Id<"contract">),
    ).rejects.toThrow(/did not answer/);
    // One failure, then service resumes.
    await expect(
      contracts.getContract("ctr_fl_recent_complete" as Id<"contract">),
    ).resolves.not.toBeNull();
  });

  it("reports an association with no reserve study rather than inventing one", async () => {
    const associations = new FakeAssociationRecords(new FixedClock(T0));
    const budget = await associations.getBudgetSummary("2087", 2026);
    expect(budget?.reserveStudyDate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe("sealed credentials", () => {
  it("cannot be serialised into a log line", () => {
    const credential = sealCredential({
      reference: "contract-records",
      scheme: "bearer",
      value: CREDENTIAL_SECRET,
      allowedHosts: [HOST],
    });

    expect(credential.value).toBe(CREDENTIAL_SECRET);
    expect(JSON.stringify(credential)).not.toContain(CREDENTIAL_SECRET);
    expect(JSON.stringify({ credential })).not.toContain(CREDENTIAL_SECRET);
    // The kernel's redactor walks enumerable entries, so it cannot reach it.
    expect(JSON.stringify(redactValue({ credential }))).not.toContain(CREDENTIAL_SECRET);
    // Nor can a spread, which is how a secret usually escapes.
    expect(JSON.stringify({ ...credential })).not.toContain(CREDENTIAL_SECRET);
  });

  it("matches hosts exactly, and suffixes only under a leading dot", () => {
    expect(hostMatches("api.mvw.example", "api.mvw.example")).toBe(true);
    expect(hostMatches("API.MVW.EXAMPLE", "api.mvw.example")).toBe(false);
    expect(hostMatches("api.mvw.example.attacker.net", "api.mvw.example")).toBe(false);
    expect(hostMatches("a.partner.example", ".partner.example")).toBe(true);
    expect(hostMatches("partner.example", ".partner.example")).toBe(false);
    expect(hostMatches("evilpartner.example", ".partner.example")).toBe(false);
    expect(hostMatches("anything", "")).toBe(false);
  });

  it("stops answering the moment a credential is revoked", async () => {
    const h = await harness();
    const provider = new RevocableSecretProvider(secrets(), h.revocations);
    expect(await provider.get("contract-records")).not.toBeNull();

    const service = new CredentialRevocationService(h.revocations, h.clock, h.audit);
    await service.revoke({
      reference: "contract-records",
      revokedBy: "act_admin",
      reason: "rotated after a partner incident",
    });

    expect(await provider.get("contract-records")).toBeNull();
  });

  it("records the revocation without recording the credential", async () => {
    const h = await harness();
    const service = new CredentialRevocationService(h.revocations, h.clock, h.audit);
    await service.revoke({
      reference: "contract-records",
      revokedBy: "act_admin",
      reason: "leaked",
    });
    const chain = await h.audit.readChain();
    expect(JSON.stringify(chain)).toContain("contract-records");
    expect(JSON.stringify(chain)).not.toContain(CREDENTIAL_SECRET);
  });

  it("keeps the time a credential stopped being valid, even if revoked twice", async () => {
    const h = await harness();
    const first = await h.revocations.revoke({
      reference: "contract-records",
      revokedAt: T0,
      revokedBy: "act_admin",
      reason: "first",
    });
    h.clock.advance(60_000);
    const second = await h.revocations.revoke({
      reference: "contract-records",
      revokedAt: h.clock.nowIso(),
      revokedBy: "act_other",
      reason: "second",
    });
    expect(second.revokedAt).toBe(first.revokedAt);
  });
});

describe("env-backed credentials", () => {
  it("resolves a credential scoped to the hosts the environment names", async () => {
    const provider = new EnvSecretProvider({
      PV_INTEGRATION_CREDENTIAL_CONTRACT_RECORDS: CREDENTIAL_SECRET,
      PV_INTEGRATION_CREDENTIAL_CONTRACT_RECORDS_HOSTS: `${HOST}, other.partner.example.com`,
    });
    const credential = await provider.get("contract-records");
    expect(credential?.value).toBe(CREDENTIAL_SECRET);
    expect(credential?.scheme).toBe("bearer");
    expect(credential?.allowedHosts).toEqual([HOST, "other.partner.example.com"]);
    // Sealed on the way out, so the value cannot reach a log.
    expect(JSON.stringify(credential)).not.toContain(CREDENTIAL_SECRET);
  });

  it("returns null for a reference with no value, so the egress refusal is credential_missing", async () => {
    const provider = new EnvSecretProvider({});
    expect(await provider.get("contract-records")).toBeNull();
  });

  it("scopes a credential to nothing when its hosts are unset, rather than to everything", async () => {
    // Fail closed: a credential configured without its hosts is refused at every
    // host, not accepted at all of them.
    const provider = new EnvSecretProvider({
      PV_INTEGRATION_CREDENTIAL_CONTRACT_RECORDS: CREDENTIAL_SECRET,
    });
    const credential = await provider.get("contract-records");
    expect(credential?.allowedHosts).toEqual([]);
  });

  it("honours the header scheme with a named header", async () => {
    const provider = new EnvSecretProvider({
      PV_INTEGRATION_CREDENTIAL_ASSOCIATION_RECORDS: CREDENTIAL_SECRET,
      PV_INTEGRATION_CREDENTIAL_ASSOCIATION_RECORDS_HOSTS: HOST,
      PV_INTEGRATION_CREDENTIAL_ASSOCIATION_RECORDS_SCHEME: "header",
      PV_INTEGRATION_CREDENTIAL_ASSOCIATION_RECORDS_HEADER: "x-api-key",
    });
    const credential = await provider.get("association-records");
    expect(credential?.scheme).toBe("header");
    expect(credential?.headerName).toBe("x-api-key");
  });
});

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

describe("egress allowlist", () => {
  it("refuses everything when the allowlist is empty", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]), { allowlist: [] });
    await expect(client.send(aRequest(h))).rejects.toMatchObject({
      reason: "integration.host_not_allowlisted",
    });
  });

  it("refuses a host that is not on the allowlist", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]));
    await expect(
      client.send(aRequest(h, { url: "https://evil.example/exfiltrate" })),
    ).rejects.toMatchObject({ reason: "integration.host_not_allowlisted" });
  });

  it("refuses a lookalike host that merely ends with an allowlisted one", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]));
    await expect(
      client.send(aRequest(h, { url: `https://${HOST}.attacker.net/contracts` })),
    ).rejects.toMatchObject({ reason: "integration.host_not_allowlisted" });
  });

  it("refuses a URL that hides the real host behind userinfo", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]));
    // `https://contracts.partner.example.com@evil.net/` has hostname evil.net.
    await expect(
      client.send(aRequest(h, { url: `https://${HOST}@evil.net/contracts` })),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses plaintext HTTP", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]));
    await expect(
      client.send(aRequest(h, { url: `http://${HOST}/contracts` })),
    ).rejects.toMatchObject({ reason: "integration.host_not_allowlisted" });
  });

  it("makes no HTTP call and records no step when the host is refused", async () => {
    const h = await harness();
    const http = new ScriptedHttp([OK]);
    const client = egress(h, http, { allowlist: [] });
    await expect(client.send(aRequest(h))).rejects.toBeInstanceOf(DeniedError);
    expect(http.requests.length).toBe(0);
    expect((await h.runs.listSteps(h.run.id)).length).toBe(0);
  });
});

describe("egress credentials", () => {
  it("attaches the credential and never puts it in a log, a step, or the audit chain", async () => {
    const h = await harness();
    const http = new ScriptedHttp([OK]);
    const client = egress(h, http);

    const outcome = await client.send(
      aRequest(h, { url: `${URL_BASE}/contracts/x?access_token=leaky&owner=Smith` }),
    );
    expect(outcome.kind).toBe("sent");

    // Presented on the wire, as it must be.
    expect(http.requests[0]?.headers["authorization"]).toBe(`Bearer ${CREDENTIAL_SECRET}`);

    // And nowhere else.
    expect(JSON.stringify(h.logger.lines)).not.toContain(CREDENTIAL_SECRET);
    const steps = await h.runs.listSteps(h.run.id);
    expect(JSON.stringify(steps)).not.toContain(CREDENTIAL_SECRET);
    expect(JSON.stringify(await h.audit.readChain())).not.toContain(CREDENTIAL_SECRET);
  });

  it("records the path but never the query string", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]));
    await client.send(aRequest(h, { url: `${URL_BASE}/contracts/x?access_token=leaky` }));

    const steps = await h.runs.listSteps(h.run.id);
    const step = steps[0];
    expect(step?.detail["path"]).toBe("/contracts/x");
    // Query strings carry tokens, signatures, and owner identifiers.
    expect(JSON.stringify(step)).not.toContain("access_token");
  });

  it("refuses when the credential is missing", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]), {
      secrets: new StaticSecretProvider([]),
    });
    await expect(client.send(aRequest(h))).rejects.toMatchObject({
      reason: "integration.credential_missing",
    });
  });

  it("refuses when the credential is scoped to a different host", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]), {
      secrets: new StaticSecretProvider([
        sealCredential({
          reference: "contract-records",
          scheme: "bearer",
          value: CREDENTIAL_SECRET,
          allowedHosts: ["associations.partner.example.com"],
        }),
      ]),
      allowlist: [HOST, "associations.partner.example.com"],
    });
    await expect(client.send(aRequest(h))).rejects.toMatchObject({
      reason: "integration.credential_missing",
    });
  });

  it("refuses an expired credential", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]), {
      secrets: new StaticSecretProvider([
        sealCredential({
          reference: "contract-records",
          scheme: "bearer",
          value: CREDENTIAL_SECRET,
          allowedHosts: [HOST],
          expiresAt: "2026-08-06T11:00:00.000Z",
        }),
      ]),
    });
    await expect(client.send(aRequest(h))).rejects.toMatchObject({
      reason: "integration.credential_missing",
    });
  });

  it("stops mid-retry when the credential is revoked between attempts", async () => {
    const h = await harness();
    const provider = new RevocableSecretProvider(secrets(), h.revocations);
    const http = new ScriptedHttp([{ status: 503, body: "" }, OK], async () => {
      await h.revocations.revoke({
        reference: "contract-records",
        revokedAt: h.clock.nowIso(),
        revokedBy: "act_admin",
        reason: "leaked mid-flight",
      });
    });
    const client = egress(h, http, { secrets: provider });

    await expect(client.send(aRequest(h))).rejects.toMatchObject({
      reason: "integration.credential_missing",
    });
    // The second attempt never went out.
    expect(http.requests.length).toBe(1);
  });
});

describe("egress retries and idempotency", () => {
  it("retries a 503 and reuses one idempotency key across attempts", async () => {
    const h = await harness();
    const http = new ScriptedHttp([{ status: 503, body: "" }, { status: 503, body: "" }, OK]);
    const client = egress(h, http);

    const outcome = await client.send(
      aRequest(h, { method: "POST", body: "{}", idempotencyKey: "idem-1" }),
    );
    expect(outcome.kind).toBe("sent");
    expect(http.requests.length).toBe(3);
    const keys = new Set(http.requests.map((request) => request.headers["idempotency-key"]));
    expect(keys).toEqual(new Set(["idem-1"]));
  });

  it("does not retry a 403, which would fail identically", async () => {
    const h = await harness();
    const http = new ScriptedHttp([{ status: 403, body: "" }]);
    const client = egress(h, http);
    await expect(client.send(aRequest(h))).rejects.toBeInstanceOf(IntegrationCallError);
    expect(http.requests.length).toBe(1);
  });

  it("classifies which statuses are worth repeating", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it("retries a transport failure and gives up after the attempt ceiling", async () => {
    const h = await harness();
    const http = new ScriptedHttp([new Error("ECONNRESET")]);
    const client = egress(h, http, { defaultMaxAttempts: 3 });
    await expect(client.send(aRequest(h))).rejects.toBeInstanceOf(IntegrationCallError);
    expect(http.requests.length).toBe(3);
  });

  it("backs off exponentially between attempts", async () => {
    const h = await harness();
    const waits: number[] = [];
    const http = new ScriptedHttp([
      { status: 503, body: "" },
      { status: 503, body: "" },
      OK,
    ]);
    const client = egress(h, http, {
      sleep: async (ms) => {
        waits.push(ms);
      },
      baseBackoffMs: 100,
      jitter: () => 0,
    });
    await client.send(aRequest(h));
    expect(waits).toEqual([100, 200]);
  });

  it("refuses an effectful call with no idempotency key", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]));
    await expect(
      client.send(aRequest(h, { method: "POST", body: "{}" })),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("does not repeat an effect whose step already succeeded", async () => {
    const h = await harness();
    const http = new ScriptedHttp([OK]);
    const client = egress(h, http);
    const request = aRequest(h, { method: "POST", body: "{}", idempotencyKey: "idem-once" });

    const first = await client.send(request);
    expect(first.kind).toBe("sent");

    const second = await client.send(request);
    expect(second.kind).toBe("already_performed");
    // One HTTP call, not two. The second caller is told the effect happened
    // rather than being handed an empty success.
    expect(http.requests.length).toBe(1);
  });

  it("repeats a safe read, because a read is not an effect", async () => {
    const h = await harness();
    const http = new ScriptedHttp([OK]);
    const client = egress(h, http);
    await client.send(aRequest(h));
    await client.send(aRequest(h));
    expect(http.requests.length).toBe(2);
  });

  it("refuses an oversized response rather than truncating it", async () => {
    const h = await harness();
    const http = new ScriptedHttp([{ status: 200, body: "x".repeat(2000) }]);
    const client = egress(h, http, { maxResponseBytes: 1000 });
    await expect(client.send(aRequest(h))).rejects.toThrow(/refused rather than truncated/);
  });
});

describe("egress rate limiting", () => {
  it("refuses once a host's per-minute ceiling is reached", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]), { requestsPerMinutePerHost: 2 });
    await client.send(aRequest(h, { stepName: "a" }));
    await client.send(aRequest(h, { stepName: "b" }));
    await expect(client.send(aRequest(h, { stepName: "c" }))).rejects.toMatchObject({
      reason: "ceiling.rate_exceeded",
    });
  });

  it("lets the window slide", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([OK]), { requestsPerMinutePerHost: 1 });
    await client.send(aRequest(h, { stepName: "a" }));
    await expect(client.send(aRequest(h, { stepName: "b" }))).rejects.toBeInstanceOf(DeniedError);
    h.clock.advance(61_000);
    await expect(client.send(aRequest(h, { stepName: "c" }))).resolves.toMatchObject({
      kind: "sent",
    });
  });
});

describe("egress and the operating record", () => {
  it("records the step before the call goes out", async () => {
    const h = await harness();
    let stepsAtCallTime = 0;
    const http = new ScriptedHttp([OK], async () => {
      stepsAtCallTime = (await h.runs.listSteps(h.run.id)).length;
    });
    await egress(h, http).send(aRequest(h));
    expect(stepsAtCallTime).toBe(1);
  });

  it("makes no call at all when the step cannot be recorded", async () => {
    const h = await harness();
    const http = new ScriptedHttp([OK]);
    const unrecordable = new Proxy(h.runs, {
      get(target, property, receiver) {
        if (property === "appendStep") {
          return () => Promise.reject(new Error("operating record unavailable"));
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const client = egress(h, http, { runs: unrecordable });
    await expect(client.send(aRequest(h))).rejects.toThrow(/operating record unavailable/);
    expect(http.requests.length).toBe(0);
  });

  it("closes the step as denied when a control refuses", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([{ status: 503, body: "" }]), {
      requestsPerMinutePerHost: 0,
    });
    await expect(client.send(aRequest(h))).rejects.toBeInstanceOf(DeniedError);
    const step = (await h.runs.listSteps(h.run.id))[0];
    expect(step?.status).toBe("denied");
    expect(step?.denialReason).toBe("ceiling.rate_exceeded");
  });

  it("closes the step as failed when the call fails", async () => {
    const h = await harness();
    const client = egress(h, new ScriptedHttp([{ status: 500, body: "" }]), {
      defaultMaxAttempts: 1,
    });
    await expect(client.send(aRequest(h))).rejects.toBeInstanceOf(IntegrationCallError);
    const step = (await h.runs.listSteps(h.run.id))[0];
    expect(step?.status).toBe("failed");
    expect(step?.detail["attempts"]).toBe(1);
  });
});

describe("egress containment", () => {
  it("refuses when the integration is contained", async () => {
    const h = await harness();
    await h.containment.engage("integration", "contract-records", "act_admin", "partner incident");
    const http = new ScriptedHttp([OK]);
    await expect(egress(h, http).send(aRequest(h))).rejects.toMatchObject({
      reason: "containment.integration_revoked",
    });
    expect(http.requests.length).toBe(0);
  });

  it("stops a retry that would otherwise outrun the kill switch", async () => {
    const h = await harness();
    const http = new ScriptedHttp([{ status: 503, body: "" }, OK], async (_request, index) => {
      if (index === 0) {
        // The operator hits the switch while the first attempt is in flight.
        await h.containment.engage(
          "integration",
          "contract-records",
          "act_admin",
          "stop it now",
        );
      }
    });
    const client = egress(h, http);
    await expect(client.send(aRequest(h))).rejects.toMatchObject({
      reason: "containment.integration_revoked",
    });
    // The second attempt never went out: the switch is re-checked per attempt.
    expect(http.requests.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

const CONTEXT = {
  integration: "contract-records",
  operation: "contract-records.getContract",
  idempotencyKey: "degrade-1",
  subject: { contractId: "ctr_fl_recent_complete" },
  summary: "Read contract metadata for a rescission check.",
};

describe("explicit degradation", () => {
  it("returns the value when the call succeeds", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock);
    const outcome = await handler.run("queue", CONTEXT, async () => "answer");
    expect(outcome).toEqual({ kind: "succeeded", value: "answer" });
    expect(await h.queue.listQueued()).toEqual([]);
  });

  it("queues a failure and reports it as queued, not as success", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock);
    const outcome = await handler.run("queue", CONTEXT, async () => {
      throw new Error("partner timeout");
    });
    expect(outcome.kind).toBe("queued");
    const queued = await h.queue.listQueued();
    expect(queued.length).toBe(1);
    expect(queued[0]?.attempts).toBe(1);
    expect(queued[0]?.nextAttemptAt > h.clock.nowIso()).toBe(true);
  });

  it("keeps one queue entry for one logical call however often it fails", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await handler.run("queue", CONTEXT, async () => {
        throw new Error("partner timeout");
      });
    }
    const queued = await h.queue.listQueued();
    expect(queued.length).toBe(1);
    expect(queued[0]?.attempts).toBe(3);
  });

  it("parks for a human, with enough context to act on", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock);
    const outcome = await handler.run("park_for_human", CONTEXT, async () => {
      throw new Error("partner returned nothing usable");
    });
    expect(outcome.kind).toBe("parked");
    const parked = await handler.listParked();
    expect(parked.length).toBe(1);
    expect(parked[0]?.summary).toBe(CONTEXT.summary);
    expect(parked[0]?.subject["contractId"]).toBe("ctr_fl_recent_complete");
  });

  it("refuses when the caller chose to refuse", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock);
    await expect(
      handler.run("refuse", CONTEXT, async () => {
        throw new Error("partner timeout");
      }),
    ).rejects.toBeInstanceOf(DeniedError);
    expect(await h.queue.listQueued()).toEqual([]);
    expect(await handler.listParked()).toEqual([]);
  });

  it("never degrades a refusal, whatever the policy", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock);
    const refusal = new DeniedError(
      "integration.host_not_allowlisted",
      "evil.example is not on the egress allowlist.",
    );

    for (const policy of ["queue", "park_for_human", "refuse"] as const) {
      await expect(
        handler.run(policy, CONTEXT, () => Promise.reject(refusal)),
      ).rejects.toMatchObject({ reason: "integration.host_not_allowlisted" });
    }
    // A policy decision must not become a retry loop or a person's task.
    expect(await h.queue.listQueued()).toEqual([]);
    expect(await handler.listParked()).toEqual([]);
  });

  it("parks rather than drops when the queue gives up", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock, { maxQueueAttempts: 2 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await handler.run("queue", CONTEXT, async () => {
        throw new Error("partner timeout");
      });
    }
    const final = await handler.run("queue", CONTEXT, async () => {
      throw new Error("partner timeout");
    });
    expect(final.kind).toBe("parked");
    const queued = await h.queue.listQueued();
    expect(queued[0]?.status).toBe("abandoned");
    expect((await handler.listParked()).length).toBe(1);
  });

  it("backs off further with each queued attempt", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock, { baseBackoffMs: 1000 });
    await handler.run("queue", CONTEXT, async () => {
      throw new Error("x");
    });
    const first = (await h.queue.getQueued(CONTEXT.idempotencyKey))?.nextAttemptAt;
    await handler.run("queue", CONTEXT, async () => {
      throw new Error("x");
    });
    const second = (await h.queue.getQueued(CONTEXT.idempotencyKey))?.nextAttemptAt;
    expect(second !== undefined && first !== undefined && second > first).toBe(true);
  });

  it("redacts a failure message before it is stored", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock);
    await handler.run("queue", CONTEXT, async () => {
      throw new Error(`upstream rejected authorization: Bearer ${CREDENTIAL_SECRET}`);
    });
    const queued = await h.queue.getQueued(CONTEXT.idempotencyKey);
    expect(queued?.lastError).not.toContain(CREDENTIAL_SECRET);
  });
});

describe("the degradation queue", () => {
  it("hands each due item to exactly one claimer", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock);
    for (const key of ["a", "b", "c"]) {
      await handler.run("queue", { ...CONTEXT, idempotencyKey: key }, async () => {
        throw new Error("x");
      });
    }
    h.clock.advance(24 * 60 * 60 * 1000);

    const claimed = await Promise.all(
      Array.from({ length: 6 }, () => h.queue.claimDue(h.clock.nowIso(), 3)),
    );
    const keys = claimed.flat().map((item) => item.idempotencyKey);
    expect(keys.length).toBe(3);
    expect(new Set(keys).size).toBe(3);
  });

  it("does not claim work that is not yet due", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock);
    await handler.run("queue", CONTEXT, async () => {
      throw new Error("x");
    });
    expect(await h.queue.claimDue(h.clock.nowIso(), 10)).toEqual([]);
  });

  it("lets exactly one person resolve a parked item", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock);
    await handler.run("park_for_human", CONTEXT, async () => {
      throw new Error("x");
    });

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_value, index) =>
        h.queue.resolveParked(CONTEXT.idempotencyKey, h.clock.nowIso(), `act_${index}`, "handled"),
      ),
    );
    expect(outcomes.filter((entry) => entry !== null).length).toBe(1);
  });

  it("keeps the original parked time when the same work is parked again", async () => {
    const h = await harness();
    const handler = new DegradationHandler(h.queue, h.clock);
    await handler.run("park_for_human", CONTEXT, async () => {
      throw new Error("first");
    });
    const firstParkedAt = (await h.queue.getParked(CONTEXT.idempotencyKey))?.parkedAt;

    h.clock.advance(3_600_000);
    await handler.run("park_for_human", CONTEXT, async () => {
      throw new Error("second");
    });
    const item = await h.queue.getParked(CONTEXT.idempotencyKey);

    // The age of the oldest open item is a real operational number.
    expect(item?.parkedAt).toBe(firstParkedAt);
    expect(item?.reason).toContain("second");
    expect((await handler.listParked()).length).toBe(1);
  });

  it("refuses a queue entry with no idempotency key", async () => {
    const h = await harness();
    await expect(
      h.queue.enqueue({
        idempotencyKey: "",
        integration: "contract-records",
        operation: "x",
        subject: {},
        status: "queued",
        attempts: 1,
        firstFailedAt: T0,
        lastAttemptAt: T0,
        nextAttemptAt: T0,
        lastError: "x",
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("integrations schema", () => {
  it("uses the assigned migration id", () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toEqual(["0009_integrations"]);
  });

  it("caches no integration responses", () => {
    const sql = MIGRATIONS.map((migration) => migration.sql).join("\n").toLowerCase();
    // A cache is how "the integration is down" becomes "here is last week's
    // answer, presented as today's".
    for (const table of ["contract_record", "association_budget", "response_cache"]) {
      expect(sql).not.toContain(table);
    }
  });
});
