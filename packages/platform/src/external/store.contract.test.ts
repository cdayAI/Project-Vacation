import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestBytes, digestValue } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { MemoryDb, PgDb, createPool } from "../store/db.js";
import { runMigrations } from "../store/migrate.js";
import { ALL_MIGRATIONS } from "../store/registry.js";
import type {
  CredentialStore,
  EnrollmentStore,
  ExternalRunStore,
  NonceStore,
  ParkedActionStore,
  RateLimitStore,
  SpendStore,
  UsedApprovalLedger,
} from "./port.js";
import {
  MemoryCredentialStore,
  MemoryEnrollmentStore,
  MemoryExternalRunStore,
  MemoryNonceStore,
  MemoryParkedActionStore,
  MemoryRateLimitStore,
  MemorySpendStore,
  MemoryUsedApprovalLedger,
} from "./store.memory.js";
import {
  PgCredentialStore,
  PgEnrollmentStore,
  PgExternalRunStore,
  PgNonceStore,
  PgParkedActionStore,
  PgRateLimitStore,
  PgSpendStore,
  PgUsedApprovalLedger,
} from "./store.pg.js";
import type {
  AgentCredential,
  EnrolledAgent,
  ExternalAgentId,
  ExternalRun,
  ParkedAction,
} from "./types.js";

/**
 * One contract, two adapters, for the external-agent plane.
 *
 * Every assertion below runs against the in-memory adapter and, when
 * `PV_TEST_DATABASE_URL` is set, against Postgres. A fake that is more
 * forgiving than the real store makes the whole suite lie, and in this module
 * what it would lie about is a seat cap, a replay guard, a single-use approval
 * and an exactly-once ingestion — every one of them a control that only exists
 * under concurrency.
 *
 * So the concurrency cases are the ones worth reading. Each of them is written
 * as N callers racing at one row, and each asserts the shape of the answer
 * rather than a count that happens to come out right: exactly one true, exactly
 * one non-null, every loser told the same thing.
 *
 * The nonce cap is set to a small number here. The production default is ten
 * thousand per agent, which is the right bound and an impractical fixture; the
 * behaviour under test is "evict this agent's oldest and nobody else's", and
 * that is the same behaviour at four.
 */

const CONNECTION_STRING = process.env.PV_TEST_DATABASE_URL;

const T0 = "2026-08-06T12:00:00.000Z";
const T0_PLUS_1S = "2026-08-06T12:00:01.000Z";
const T0_PLUS_30S = "2026-08-06T12:00:30.000Z";
const T0_PLUS_2M = "2026-08-06T12:02:00.000Z";
const T1 = "2026-08-06T13:00:00.000Z";
const T2 = "2026-08-07T12:00:00.000Z";
const T_YEAR = "2027-08-06T12:00:00.000Z";

const MINUTE_MS = 60_000;
const NONCE_CAP = 4;

interface Adapters {
  readonly agents: EnrollmentStore;
  readonly spend: SpendStore;
  readonly credentials: CredentialStore;
  readonly nonces: NonceStore;
  readonly ledger: UsedApprovalLedger;
  readonly parked: ParkedActionStore;
  readonly runs: ExternalRunStore;
  readonly limits: RateLimitStore;
  /** A second ledger over the same storage, to prove the floor is persisted. */
  readonly secondLedger: UsedApprovalLedger;
}

interface Harness {
  prepare(): Promise<void>;
  fresh(): Promise<Adapters>;
  close(): Promise<void>;
}

const EXTERNAL_TABLES = `external_rate_denial, external_rate_request, external_report_claim,
  external_run, external_parked_action, external_approval_floor, external_used_approval,
  external_nonce, external_credential, external_spend_meter, external_seat, external_agent`;

function memoryHarness(): Harness {
  const db = new MemoryDb();
  return {
    async prepare() {},
    async fresh() {
      db.reset();
      return {
        agents: new MemoryEnrollmentStore(db),
        spend: new MemorySpendStore(db),
        credentials: new MemoryCredentialStore(db),
        nonces: new MemoryNonceStore(db, NONCE_CAP),
        ledger: new MemoryUsedApprovalLedger(db),
        parked: new MemoryParkedActionStore(db),
        runs: new MemoryExternalRunStore(db),
        limits: new MemoryRateLimitStore(db),
        secondLedger: new MemoryUsedApprovalLedger(db),
      };
    },
    async close() {},
  };
}

function postgresHarness(connectionString: string): Harness {
  // Wide enough that twenty concurrent transactions each hold a connection
  // while waiting on a row or advisory lock held by one of the others.
  const pool = createPool(connectionString, 28);
  const db = new PgDb(pool);
  return {
    async prepare() {
      await runMigrations(db, ALL_MIGRATIONS);
    },
    async fresh() {
      await db.query(`TRUNCATE ${EXTERNAL_TABLES} RESTART IDENTITY CASCADE`);
      return {
        agents: new PgEnrollmentStore(db),
        spend: new PgSpendStore(db),
        credentials: new PgCredentialStore(db),
        nonces: new PgNonceStore(db, NONCE_CAP),
        ledger: new PgUsedApprovalLedger(db),
        parked: new PgParkedActionStore(db),
        runs: new PgExternalRunStore(db),
        limits: new PgRateLimitStore(db),
        secondLedger: new PgUsedApprovalLedger(db),
      };
    },
    async close() {
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------- fixtures

function anAgent(id: string, overrides: Partial<EnrolledAgent> = {}): EnrolledAgent {
  return {
    id: id as ExternalAgentId,
    name: `agent-${id}`,
    owner: "r.okonkwo@example.test",
    department: "owner_services",
    hostPlatform: "vendor-crm",
    purpose: "Chases missing rescission paperwork and drafts the follow-up",
    allowedTools: [{ tool: "crm.search", operatorRisk: "routine" }],
    riskCeiling: "sensitive",
    spendCeilingUsd: 500,
    budgetPeriod: "monthly",
    wallClockCeilingMs: 600_000,
    dataScopes: ["scope:contract.read"],
    expiresAt: T_YEAR,
    status: "active",
    enrolledBy: "act_operator",
    enrolledAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function aBearer(id: string, agentId: string, overrides: Partial<AgentCredential> = {}): AgentCredential {
  return {
    id: id as Id<"credential">,
    agentId: agentId as ExternalAgentId,
    kind: "bearer",
    label: "crm production",
    tokenHash: digestBytes(`token-${id}`),
    createdBy: "act_operator",
    createdAt: T0,
    ...overrides,
  };
}

function anHmac(id: string, agentId: string, overrides: Partial<AgentCredential> = {}): AgentCredential {
  return {
    id: id as Id<"credential">,
    agentId: agentId as ExternalAgentId,
    kind: "hmac",
    label: "crm signing key",
    secretRef: "mvw/crm/hmac-production",
    createdBy: "act_operator",
    createdAt: T0,
    ...overrides,
  };
}

function aParkedAction(id: string, agentId: string, overrides: Partial<ParkedAction> = {}): ParkedAction {
  return {
    id: id as Id<"parkedAction">,
    agentId: agentId as ExternalAgentId,
    integration: "letters",
    mode: "write",
    operation: "send",
    requestDigest: digestValue({ letter: "rescission-acknowledgement", contractId: "ctr_0001" }),
    preview: [{ label: "Recipient", value: "owner of ctr_0001" }],
    status: "pending",
    createdAt: T0,
    expiresAt: T1,
    ...overrides,
  };
}

function anExternalRun(id: string, agentId: string, overrides: Partial<ExternalRun> = {}): ExternalRun {
  return {
    id: id as Id<"externalRun">,
    agentId: agentId as ExternalAgentId,
    runId: `run_${id}` as Id<"run">,
    goal: "Collect outstanding rescission paperwork",
    status: "running",
    startedAt: T0,
    lastHeartbeatAt: T0,
    costUsd: 0,
    ...overrides,
  };
}

/** N callers at once, so a read-then-write has somewhere to go wrong. */
function times<T>(count: number, fn: (index: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: count }, (_, index) => fn(index)));
}

const RACERS = 12;

// ---------------------------------------------------------------------- suite

function runContract(name: string, factory: () => Harness, skip: boolean): void {
  const block = skip ? describe.skip : describe;

  block(name, () => {
    let harness: Harness;
    let store: Adapters;

    beforeAll(async () => {
      harness = factory();
      await harness.prepare();
    });

    afterAll(async () => {
      await harness.close();
    });

    beforeEach(async () => {
      store = await harness.fresh();
    });

    // ---------------------------------------------------------- enrollment

    describe("enrollment", () => {
      it("stores an enrolled agent whole and reads it back", async () => {
        const agent = anAgent("eag_1");
        const created = await store.agents.createAgent(agent);
        expect(created).toEqual(agent);
        expect(await store.agents.getAgent(agent.id)).toEqual(agent);
        expect(await store.agents.countAgents()).toBe(1);
      });

      it("returns null for an agent that is not enrolled", async () => {
        expect(await store.agents.getAgent("eag_missing" as ExternalAgentId)).toBeNull();
        expect(await store.agents.getAgentByName("nobody")).toBeNull();
      });

      it("refuses to reuse an id or a name", async () => {
        await store.agents.createAgent(anAgent("eag_1", { name: "crm-chaser" }));
        await expect(
          store.agents.createAgent(anAgent("eag_1", { name: "something-else" })),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(
          store.agents.createAgent(anAgent("eag_2", { name: "crm-chaser" })),
        ).rejects.toBeInstanceOf(InvalidInputError);
        expect(await store.agents.countAgents()).toBe(1);
      });

      it("matches a name exactly and nothing else", async () => {
        await store.agents.createAgent(anAgent("eag_1", { name: "crm-chaser" }));
        expect((await store.agents.getAgentByName("crm-chaser"))?.id).toBe("eag_1");
        // Case folding here would admit a caller under someone else's grant.
        expect(await store.agents.getAgentByName("CRM-Chaser")).toBeNull();
        expect(await store.agents.getAgentByName("crm-chase")).toBeNull();
        expect(await store.agents.getAgentByName("%")).toBeNull();
      });

      it("lists by name, filters by status and department, and pages", async () => {
        await store.agents.createAgent(anAgent("eag_3", { name: "c-agent" }));
        await store.agents.createAgent(anAgent("eag_1", { name: "a-agent" }));
        await store.agents.createAgent(
          anAgent("eag_2", { name: "b-agent", department: "finance", status: "revoked" }),
        );

        expect((await store.agents.listAgents()).map((agent) => agent.name)).toEqual([
          "a-agent",
          "b-agent",
          "c-agent",
        ]);
        expect(
          (await store.agents.listAgents({ status: ["revoked"] })).map((agent) => agent.id),
        ).toEqual(["eag_2"]);
        expect(
          (await store.agents.listAgents({ department: "finance" })).map((agent) => agent.id),
        ).toEqual(["eag_2"]);
        expect((await store.agents.listAgents({ limit: 2 })).map((agent) => agent.name)).toEqual([
          "a-agent",
          "b-agent",
        ]);
        expect(
          (await store.agents.listAgents({ limit: 2, offset: 2 })).map((agent) => agent.name),
        ).toEqual(["c-agent"]);
        // A count that respected the page size could never say how many pages
        // there are.
        expect(await store.agents.countAgents()).toBe(3);
      });

      it("refuses a risk ceiling of prohibited, a blank owner, and a loose timestamp", async () => {
        await expect(
          store.agents.createAgent(anAgent("eag_1", { riskCeiling: "prohibited" })),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(
          store.agents.createAgent(anAgent("eag_2", { owner: "  " })),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(
          store.agents.createAgent(anAgent("eag_3", { enrolledAt: "2026-08-06T12:00:00Z" })),
        ).rejects.toBeInstanceOf(InvalidInputError);
        expect(await store.agents.countAgents()).toBe(0);
      });

      it("applies a re-enrollment without touching status, enrolment or the meter", async () => {
        const agent = await store.agents.createAgent(anAgent("eag_1"));
        await store.spend.addSpend(agent.id, "2026-08", 42, T0);
        await store.agents.setAgentStatus({
          id: agent.id,
          expectedStatus: "active",
          status: "contained",
          reason: "leaked scope",
          by: "act_operator",
          at: T1,
        });

        const updated = await store.agents.updateAgent(
          agent.id,
          { spendCeilingUsd: 900, riskCeiling: "routine", dataScopes: ["scope:contract.read", "scope:contact.read"] },
          T2,
        );

        expect(updated.spendCeilingUsd).toBe(900);
        expect(updated.riskCeiling).toBe("routine");
        expect(updated.dataScopes).toEqual(["scope:contract.read", "scope:contact.read"]);
        expect(updated.updatedAt).toBe(T2);
        // Re-enrolling must not become the way around either control.
        expect(updated.status).toBe("contained");
        expect(updated.enrolledAt).toBe(T0);
        expect((await store.spend.getMeter(agent.id, "2026-08"))?.spentUsd).toBe(42);
      });

      it("ignores fields a re-enrollment is not allowed to carry", async () => {
        const agent = await store.agents.createAgent(anAgent("eag_1"));
        // A caller passing a whole agent where an update was expected.
        await store.agents.updateAgent(
          agent.id,
          {
            purpose: "revised purpose",
            ...({ status: "active", enrolledAt: T2, id: "eag_other" } as Record<string, unknown>),
          },
          T2,
        );
        const reread = await store.agents.getAgent(agent.id);
        expect(reread?.purpose).toBe("revised purpose");
        expect(reread?.status).toBe("active");
        expect(reread?.enrolledAt).toBe(T0);
      });

      it("refuses a re-enrollment of an agent that is not enrolled", async () => {
        await expect(
          store.agents.updateAgent("eag_missing" as ExternalAgentId, { purpose: "x" }, T0),
        ).rejects.toBeInstanceOf(DeniedError);
      });

      it("changes status only from the status the caller last saw", async () => {
        const agent = await store.agents.createAgent(anAgent("eag_1"));

        const contained = await store.agents.setAgentStatus({
          id: agent.id,
          expectedStatus: "active",
          status: "contained",
          reason: "denial storm",
          by: "act_operator",
          at: T1,
        });
        expect(contained?.status).toBe("contained");
        expect(contained?.statusReason).toBe("denial storm");
        expect(contained?.statusChangedAt).toBe(T1);
        expect(contained?.statusChangedBy).toBe("act_operator");

        // Decided from a stale read. It must not clobber what already landed.
        const stale = await store.agents.setAgentStatus({
          id: agent.id,
          expectedStatus: "active",
          status: "revoked",
          reason: "stale decision",
          by: "act_other",
          at: T2,
        });
        expect(stale).toBeNull();
        expect((await store.agents.getAgent(agent.id))?.status).toBe("contained");
        expect((await store.agents.getAgent(agent.id))?.statusReason).toBe("denial storm");

        expect(
          await store.agents.setAgentStatus({
            id: "eag_missing" as ExternalAgentId,
            expectedStatus: "active",
            status: "revoked",
            reason: "x",
            by: "y",
            at: T1,
          }),
        ).toBeNull();
      });

      it("refuses to move a revoked agent, however the caller asks", async () => {
        const agent = await store.agents.createAgent(anAgent("eag_1"));
        await store.agents.setAgentStatus({
          id: agent.id,
          expectedStatus: "active",
          status: "revoked",
          reason: "vendor offboarding",
          by: "act_operator",
          at: T1,
        });

        // Not a stale read: this caller has read the current status and is
        // asking for exactly the transition the record forbids. Revocation is
        // terminal, so bringing the agent back is a fresh enrollment — another
        // deliberate, approved decision — and never a status flip.
        for (const status of ["active", "contained"] as const) {
          expect(
            await store.agents.setAgentStatus({
              id: agent.id,
              expectedStatus: "revoked",
              status,
              reason: "changed my mind",
              by: "act_operator",
              at: T2,
            }),
          ).toBeNull();
        }

        const stored = await store.agents.getAgent(agent.id);
        expect(stored?.status).toBe("revoked");
        // Nothing was written, not even the reason or the timestamp.
        expect(stored?.statusReason).toBe("vendor offboarding");
        expect(stored?.statusChangedAt).toBe(T1);

        // Containment stays releasable. It is a pause an operator lifts, and
        // treating it as terminal would make release impossible.
        const other = await store.agents.createAgent(anAgent("eag_2"));
        await store.agents.setAgentStatus({
          id: other.id,
          expectedStatus: "active",
          status: "contained",
          reason: "denial storm",
          by: "act_operator",
          at: T1,
        });
        expect(
          (
            await store.agents.setAgentStatus({
              id: other.id,
              expectedStatus: "contained",
              status: "active",
              reason: "investigated and cleared",
              by: "act_operator",
              at: T2,
            })
          )?.status,
        ).toBe("active");
      });

      it(`lets exactly one of ${RACERS} concurrent containment decisions land`, async () => {
        const agent = await store.agents.createAgent(anAgent("eag_1"));
        const results = await times(RACERS, (index) =>
          store.agents.setAgentStatus({
            id: agent.id,
            expectedStatus: "active",
            status: "contained",
            reason: `racer ${index}`,
            by: `act_${index}`,
            at: T1,
          }),
        );

        const winners = results.filter((result) => result !== null);
        expect(winners).toHaveLength(1);
        const stored = await store.agents.getAgent(agent.id);
        expect(stored?.statusReason).toBe(winners[0]?.statusReason);
      });

      it("records last seen, and stays silent about an agent that is gone", async () => {
        const agent = await store.agents.createAgent(anAgent("eag_1"));
        await store.agents.touchLastSeen(agent.id, T1);
        expect((await store.agents.getAgent(agent.id))?.lastSeenAt).toBe(T1);
        // Telemetry on the admission path must never be what refuses a request.
        await expect(
          store.agents.touchLastSeen("eag_missing" as ExternalAgentId, T1),
        ).resolves.toBeUndefined();
      });

      it("hands out seats up to the cap and no further", async () => {
        expect(await store.agents.claimSeat(2)).toBe(true);
        expect(await store.agents.claimSeat(2)).toBe(true);
        expect(await store.agents.claimSeat(2)).toBe(false);

        await store.agents.releaseSeat();
        expect(await store.agents.claimSeat(2)).toBe(true);
      });

      it("hands out nothing against a cap of zero, including the first claim", async () => {
        // The first claim is the one with no row to conflict with, which is
        // exactly where a naive upsert hands out a seat that does not exist.
        expect(await store.agents.claimSeat(0)).toBe(false);
        expect(await store.agents.claimSeat(1)).toBe(true);
      });

      it("never lets a release push the counter below zero", async () => {
        await store.agents.releaseSeat();
        await store.agents.releaseSeat();
        expect(await store.agents.claimSeat(1)).toBe(true);
        expect(await store.agents.claimSeat(1)).toBe(false);
      });

      it(`gives exactly one of ${RACERS} concurrent claims the last seat`, async () => {
        const results = await times(RACERS, () => store.agents.claimSeat(1));
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await store.agents.claimSeat(1)).toBe(false);
      });

      it(`gives exactly three of ${RACERS} concurrent claims a seat when the cap is three`, async () => {
        const results = await times(RACERS, () => store.agents.claimSeat(3));
        expect(results.filter(Boolean)).toHaveLength(3);
      });
    });

    // --------------------------------------------------------------- spend

    describe("spend meters", () => {
      const agentId = "eag_1" as ExternalAgentId;

      it("returns the running total and keeps periods apart", async () => {
        expect(await store.spend.addSpend(agentId, "2026-08", 1.5, T0)).toBeCloseTo(1.5, 10);
        expect(await store.spend.addSpend(agentId, "2026-08", 2.25, T1)).toBeCloseTo(3.75, 10);
        expect(await store.spend.addSpend(agentId, "2026-09", 1, T1)).toBeCloseTo(1, 10);
        expect(await store.spend.addSpend(agentId, "lifetime", 4.75, T1)).toBeCloseTo(4.75, 10);

        const meter = await store.spend.getMeter(agentId, "2026-08");
        expect(meter?.spentUsd).toBeCloseTo(3.75, 10);
        expect(meter?.updatedAt).toBe(T1);
        expect((await store.spend.listMeters(agentId)).map((entry) => entry.periodKey)).toEqual([
          "2026-08",
          "2026-09",
          "lifetime",
        ]);
        expect(await store.spend.getMeter(agentId, "2026-10")).toBeNull();
      });

      it("keeps one agent's meter out of another's", async () => {
        await store.spend.addSpend(agentId, "2026-08", 10, T0);
        await store.spend.addSpend("eag_2" as ExternalAgentId, "2026-08", 3, T0);
        expect((await store.spend.getMeter(agentId, "2026-08"))?.spentUsd).toBe(10);
        expect((await store.spend.getMeter("eag_2" as ExternalAgentId, "2026-08"))?.spentUsd).toBe(3);
      });

      it("refuses a period key that is not lifetime or a calendar month", async () => {
        // A typo would open a fresh meter at zero, which every ceiling check
        // reads as an agent that has spent nothing.
        for (const bad of ["august", "2026-13", "2026-8", "2026", "", "lifetime "]) {
          await expect(store.spend.addSpend(agentId, bad, 1, T0)).rejects.toBeInstanceOf(
            InvalidInputError,
          );
        }
      });

      it("refuses a negative or non-finite report", async () => {
        await expect(store.spend.addSpend(agentId, "2026-08", -5, T0)).rejects.toBeInstanceOf(
          InvalidInputError,
        );
        await expect(
          store.spend.addSpend(agentId, "2026-08", Number.NaN, T0),
        ).rejects.toBeInstanceOf(InvalidInputError);
        expect(await store.spend.getMeter(agentId, "2026-08")).toBeNull();
      });

      it("loses nothing under twenty concurrent reports", async () => {
        const results = await times(20, () => store.spend.addSpend(agentId, "2026-08", 0.25, T0));

        // Every caller saw a different running total, which is only true if
        // every increment landed on top of the one before it.
        expect(new Set(results).size).toBe(20);
        expect(Math.max(...results)).toBeCloseTo(5, 10);
        expect((await store.spend.getMeter(agentId, "2026-08"))?.spentUsd).toBeCloseTo(5, 10);
      });
    });

    // --------------------------------------------------------- credentials

    describe("credentials", () => {
      beforeEach(async () => {
        await store.agents.createAgent(anAgent("eag_1"));
        await store.agents.createAgent(anAgent("eag_2"));
      });

      it("stores a bearer credential as a hash and finds it by that hash", async () => {
        const credential = await store.credentials.createCredential(aBearer("crd_1", "eag_1"));
        expect(credential.tokenHash).toBe(digestBytes("token-crd_1"));
        expect(await store.credentials.getCredential(credential.id)).toEqual(credential);
        expect((await store.credentials.findByTokenHash(digestBytes("token-crd_1")))?.id).toBe(
          "crd_1",
        );
        expect(await store.credentials.findByTokenHash(digestBytes("token-other"))).toBeNull();
      });

      it("refuses anything that is not a digest where a token hash belongs", async () => {
        // The value most likely to fail this check is the token itself.
        await expect(
          store.credentials.createCredential(
            aBearer("crd_1", "eag_1", { tokenHash: "pv_live_9f2c8a71c0" }),
          ),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(store.credentials.findByTokenHash("pv_live_9f2c8a71c0")).rejects.toBeInstanceOf(
          InvalidInputError,
        );
      });

      it("refuses an HMAC credential whose secret reference is not a name", async () => {
        await expect(
          store.credentials.createCredential(
            anHmac("crd_1", "eag_1", { secretRef: "-----BEGIN PRIVATE KEY----- MIIEv..." }),
          ),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it("refuses a credential carrying material belonging to another kind", async () => {
        await expect(
          store.credentials.createCredential(
            aBearer("crd_1", "eag_1", { secretRef: "mvw/crm/hmac" }),
          ),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(
          store.credentials.createCredential(
            anHmac("crd_2", "eag_1", { tokenHash: digestBytes("token") }),
          ),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(
          store.credentials.createCredential({
            ...anHmac("crd_3", "eag_1"),
            kind: "jwt",
            secretRef: undefined,
          }),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it("refuses a credential for an agent that was never enrolled", async () => {
        await expect(
          store.credentials.createCredential(aBearer("crd_1", "eag_missing")),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it("refuses one token hash registered against two principals", async () => {
        await store.credentials.createCredential(aBearer("crd_1", "eag_1"));
        await expect(
          store.credentials.createCredential(
            aBearer("crd_2", "eag_2", { tokenHash: digestBytes("token-crd_1") }),
          ),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it("revokes once and keeps the first revocation's account of why", async () => {
        await store.credentials.createCredential(aBearer("crd_1", "eag_1"));
        const revoked = await store.credentials.revokeCredential(
          "crd_1" as Id<"credential">,
          T1,
          "act_operator",
          "rotated after a laptop was lost",
        );
        expect(revoked?.revokedAt).toBe(T1);
        expect(revoked?.revokedBy).toBe("act_operator");

        expect(
          await store.credentials.revokeCredential(
            "crd_1" as Id<"credential">,
            T2,
            "act_other",
            "second opinion",
          ),
        ).toBeNull();
        expect((await store.credentials.getCredential("crd_1" as Id<"credential">))?.revokedReason)
          .toBe("rotated after a laptop was lost");

        expect(
          await store.credentials.revokeCredential(
            "crd_missing" as Id<"credential">,
            T1,
            "a",
            "b",
          ),
        ).toBeNull();
      });

      it("still returns a revoked credential to the verifier", async () => {
        await store.credentials.createCredential(aBearer("crd_1", "eag_1"));
        await store.credentials.revokeCredential("crd_1" as Id<"credential">, T1, "act_op", "why");
        // "That credential was revoked" is an answer. "No such credential"
        // invites the caller to conclude it used the wrong token and retry.
        const found = await store.credentials.findByTokenHash(digestBytes("token-crd_1"));
        expect(found?.revokedAt).toBe(T1);
      });

      it("records last use", async () => {
        await store.credentials.createCredential(aBearer("crd_1", "eag_1"));
        await store.credentials.touchCredentialUsed("crd_1" as Id<"credential">, T1);
        expect((await store.credentials.getCredential("crd_1" as Id<"credential">))?.lastUsedAt).toBe(
          T1,
        );
        await expect(
          store.credentials.touchCredentialUsed("crd_missing" as Id<"credential">, T1),
        ).resolves.toBeUndefined();
      });

      it("lists an agent's credentials and nobody else's", async () => {
        await store.credentials.createCredential(aBearer("crd_1", "eag_1"));
        await store.credentials.createCredential(anHmac("crd_2", "eag_1"));
        await store.credentials.createCredential(aBearer("crd_3", "eag_2"));
        expect(
          (await store.credentials.listCredentials("eag_1" as ExternalAgentId)).map((c) => c.id),
        ).toEqual(["crd_1", "crd_2"]);
      });

      it("reports a strong credential only while one is live", async () => {
        const agentId = "eag_1" as ExternalAgentId;
        await store.credentials.createCredential(aBearer("crd_1", "eag_1"));
        // A bearer token proves possession of a string, not of a key.
        expect(await store.credentials.hasStrongCredential(agentId, T0)).toBe(false);

        await store.credentials.createCredential(anHmac("crd_2", "eag_1", { expiresAt: T1 }));
        expect(await store.credentials.hasStrongCredential(agentId, T0)).toBe(true);
        // Still usable at the instant it expires, matching every other expiry
        // comparison in the platform.
        expect(await store.credentials.hasStrongCredential(agentId, T1)).toBe(false);
        expect(
          await store.credentials.hasStrongCredential(agentId, "2026-08-06T12:59:59.999Z"),
        ).toBe(true);

        await store.credentials.revokeCredential("crd_2" as Id<"credential">, T0, "act_op", "why");
        expect(await store.credentials.hasStrongCredential(agentId, T0)).toBe(false);
        expect(
          await store.credentials.hasStrongCredential("eag_2" as ExternalAgentId, T0),
        ).toBe(false);
      });

      it("treats every strong kind as strong, leaving no downgrade path", async () => {
        await store.credentials.createCredential(
          anHmac("crd_jwt", "eag_1", {
            kind: "jwt",
            secretRef: undefined,
            issuer: "https://crm.example.test",
            audience: "pv-platform",
            jwksPath: "/etc/pv/crm-jwks.json",
          }),
        );
        expect(
          await store.credentials.hasStrongCredential("eag_1" as ExternalAgentId, T0),
        ).toBe(true);

        await store.credentials.createCredential(
          anHmac("crd_env", "eag_2", {
            kind: "envelope",
            secretRef: undefined,
            publicKey: "-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----",
          }),
        );
        expect(
          await store.credentials.hasStrongCredential("eag_2" as ExternalAgentId, T0),
        ).toBe(true);
      });
    });

    // -------------------------------------------------------------- nonces

    describe("nonce claims", () => {
      const agentId = "eag_1" as ExternalAgentId;
      const other = "eag_2" as ExternalAgentId;

      it("claims a nonce once and refuses the replay", async () => {
        expect(await store.nonces.claimNonce(agentId, "n-1", T1)).toBe(true);
        expect(await store.nonces.claimNonce(agentId, "n-1", T1)).toBe(false);
        expect(await store.nonces.countNonces(agentId)).toBe(1);
      });

      it("keeps one agent's nonce space out of another's", async () => {
        expect(await store.nonces.claimNonce(agentId, "n-1", T1)).toBe(true);
        // The same string from a different agent is a different claim.
        expect(await store.nonces.claimNonce(other, "n-1", T1)).toBe(true);
        expect(await store.nonces.countNonces(agentId)).toBe(1);
        expect(await store.nonces.countNonces(other)).toBe(1);
      });

      it("refuses a blank nonce, which would lock the agent out of its own space", async () => {
        await expect(store.nonces.claimNonce(agentId, "", T1)).rejects.toBeInstanceOf(
          InvalidInputError,
        );
      });

      it(`lets exactly one of ${RACERS} concurrent claims of one nonce through`, async () => {
        const results = await times(RACERS, () => store.nonces.claimNonce(agentId, "replayed", T1));
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await store.nonces.countNonces(agentId)).toBe(1);
      });

      it("evicts only the claiming agent's own oldest when it reaches its bound", async () => {
        await store.nonces.claimNonce(other, "kept", T1);

        for (let index = 1; index <= NONCE_CAP + 1; index += 1) {
          expect(await store.nonces.claimNonce(agentId, `n-${index}`, T1)).toBe(true);
        }

        expect(await store.nonces.countNonces(agentId)).toBe(NONCE_CAP);
        // The oldest of this agent's own claims is the one that went.
        expect(await store.nonces.claimNonce(agentId, "n-1", T1)).toBe(true);
        // Everything inside the bound still refuses a replay.
        expect(await store.nonces.claimNonce(agentId, `n-${NONCE_CAP + 1}`, T1)).toBe(false);

        // And the busy agent evicted nothing belonging to anyone else. A global
        // bound would have made this a denial of service one tenant inflicts on
        // another simply by being ordinary.
        expect(await store.nonces.countNonces(other)).toBe(1);
        expect(await store.nonces.claimNonce(other, "kept", T1)).toBe(false);
      });

      it("purges strictly past expiry and leaves live claims alone", async () => {
        await store.nonces.claimNonce(agentId, "expiring", T1);
        await store.nonces.claimNonce(agentId, "later", T2);

        // Still held at the instant it expires: holding a nonce a moment
        // longer refuses a replay, dropping it early permits one.
        expect(await store.nonces.purgeExpiredNonces(T1)).toBe(0);
        expect(await store.nonces.purgeExpiredNonces("2026-08-06T13:00:00.001Z")).toBe(1);
        expect(await store.nonces.countNonces(agentId)).toBe(1);
        expect(await store.nonces.claimNonce(agentId, "later", T2)).toBe(false);
      });
    });

    // ----------------------------------------------- used-approval ledger

    describe("used-approval ledger", () => {
      it("claims an approval once and refuses it thereafter", async () => {
        expect(await store.ledger.claimApproval("apr_0500" as Id<"approval">, T0)).toBe(true);
        expect(await store.ledger.claimApproval("apr_0500" as Id<"approval">, T0)).toBe(false);
        expect(await store.ledger.isConsumed("apr_0500" as Id<"approval">)).toBe(true);
        expect(await store.ledger.isConsumed("apr_0600" as Id<"approval">)).toBe(false);
      });

      it(`lets exactly one of ${RACERS} concurrent consumers claim an approval`, async () => {
        const results = await times(RACERS, () =>
          store.ledger.claimApproval("apr_0500" as Id<"approval">, T0),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await store.ledger.isConsumed("apr_0500" as Id<"approval">)).toBe(true);
      });

      it("reports nothing evicted before anything has been", async () => {
        expect(await store.ledger.evictBefore(T2)).toBeNull();
      });

      /**
       * The behaviour this whole file exists for.
       *
       * A bounded ledger that simply forgets makes an old approval reusable the
       * moment it ages out. Nothing looks different afterwards: the ledger is
       * smaller, the console is unchanged, and a replayed approval succeeds.
       */
      it("raises a floor on eviction, so an aged-out approval is refused rather than reusable", async () => {
        await store.ledger.claimApproval("apr_0500" as Id<"approval">, T0);
        await store.ledger.claimApproval("apr_0900" as Id<"approval">, T0);
        await store.ledger.claimApproval("apr_9500" as Id<"approval">, T2);

        const floor = await store.ledger.evictBefore(T1);
        expect(floor).toBe("apr_0900");

        // Everything at or below the floor is consumed, whether the ledger
        // still holds it or has forgotten it.
        expect(await store.ledger.isConsumed("apr_0900" as Id<"approval">)).toBe(true);
        expect(await store.ledger.isConsumed("apr_0500" as Id<"approval">)).toBe(true);
        // Including ids that were never claimed. Identifiers are not ordered by
        // time, so the floor over-refuses — which is the direction to be wrong
        // in: a refusal costs a re-request, a permission replays a human
        // decision.
        expect(await store.ledger.isConsumed("apr_0100" as Id<"approval">)).toBe(true);

        // And the claim path agrees with the report. This is the assertion
        // that fails if the floor is consulted by one and not the other.
        expect(await store.ledger.claimApproval("apr_0500" as Id<"approval">, T2)).toBe(false);
        expect(await store.ledger.claimApproval("apr_0100" as Id<"approval">, T2)).toBe(false);

        // The entry that was not old enough to evict is untouched, and still
        // single-use.
        expect(await store.ledger.isConsumed("apr_9500" as Id<"approval">)).toBe(true);
        expect(await store.ledger.claimApproval("apr_9500" as Id<"approval">, T2)).toBe(false);
        // Anything above the floor that was never claimed is still available.
        expect(await store.ledger.claimApproval("apr_9700" as Id<"approval">, T2)).toBe(true);
      });

      it("persists the floor, so a fresh reader of the same store sees it", async () => {
        await store.ledger.claimApproval("apr_0900" as Id<"approval">, T0);
        await store.ledger.evictBefore(T1);

        // A second adapter over the same storage. An in-process floor would
        // pass every assertion above and fail this one — and would fail it in
        // production as soon as a second worker started.
        expect(await store.secondLedger.isConsumed("apr_0500" as Id<"approval">)).toBe(true);
        expect(await store.secondLedger.claimApproval("apr_0900" as Id<"approval">, T2)).toBe(false);
      });

      it("never lowers the floor", async () => {
        await store.ledger.claimApproval("apr_0900" as Id<"approval">, T0);
        expect(await store.ledger.evictBefore(T1)).toBe("apr_0900");

        // An eviction that drops nothing must leave the wall where it is
        // rather than reporting that there is no wall.
        expect(await store.ledger.evictBefore(T1)).toBe("apr_0900");
        expect(await store.ledger.isConsumed("apr_0500" as Id<"approval">)).toBe(true);

        await store.ledger.claimApproval("apr_9500" as Id<"approval">, T2);
        expect(await store.ledger.evictBefore(T_YEAR)).toBe("apr_9500");
        expect(await store.ledger.isConsumed("apr_0900" as Id<"approval">)).toBe(true);
      });

      it("keeps entries at or after the cutoff", async () => {
        await store.ledger.claimApproval("apr_9500" as Id<"approval">, T1);
        // Strictly before the cutoff, matching every other window in the
        // platform.
        expect(await store.ledger.evictBefore(T1)).toBeNull();
        expect(await store.ledger.isConsumed("apr_9500" as Id<"approval">)).toBe(true);
      });
    });

    // ------------------------------------------------------ parked actions

    describe("parked actions", () => {
      it("stores a parked action whole and reads it back", async () => {
        const action = aParkedAction("pac_1", "eag_1", {
          approvalId: "apr_1" as Id<"approval">,
          runId: "run_1" as Id<"run">,
          correlationId: "cor_1",
        });
        const created = await store.parked.createParkedAction(action);
        expect(created).toEqual(action);
        expect(await store.parked.getParkedAction(action.id)).toEqual(action);
        expect(await store.parked.getParkedAction("pac_missing" as Id<"parkedAction">)).toBeNull();
      });

      it("refuses to reuse an id or to store a request digest that is not one", async () => {
        await store.parked.createParkedAction(aParkedAction("pac_1", "eag_1"));
        await expect(
          store.parked.createParkedAction(aParkedAction("pac_1", "eag_1")),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(
          store.parked.createParkedAction(
            aParkedAction("pac_2", "eag_1", { requestDigest: "not-a-digest" }),
          ),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it("lists oldest first, filtered by agent and status", async () => {
        await store.parked.createParkedAction(aParkedAction("pac_1", "eag_1"));
        await store.parked.createParkedAction(
          aParkedAction("pac_2", "eag_2", { createdAt: T1, expiresAt: T2 }),
        );
        await store.parked.createParkedAction(
          aParkedAction("pac_3", "eag_1", { status: "committed" }),
        );

        expect((await store.parked.listParkedActions()).map((a) => a.id)).toEqual([
          "pac_1",
          "pac_3",
          "pac_2",
        ]);
        expect(
          (await store.parked.listParkedActions({ agentId: "eag_1" as ExternalAgentId })).map(
            (a) => a.id,
          ),
        ).toEqual(["pac_1", "pac_3"]);
        expect(
          (await store.parked.listParkedActions({ status: ["pending"] })).map((a) => a.id),
        ).toEqual(["pac_1", "pac_2"]);
        expect((await store.parked.listParkedActions({ limit: 1 })).map((a) => a.id)).toEqual([
          "pac_1",
        ]);
      });

      it("moves an action only from the status the caller decided from", async () => {
        await store.parked.createParkedAction(aParkedAction("pac_1", "eag_1"));

        const approved = await store.parked.transitionParkedAction({
          id: "pac_1" as Id<"parkedAction">,
          expectedStatus: "pending",
          status: "approved",
          at: T1,
        });
        expect(approved?.status).toBe("approved");
        // Only a commit carries a completion time.
        expect(approved?.committedAt).toBeUndefined();

        // The second caller decided from a status that is no longer current.
        expect(
          await store.parked.transitionParkedAction({
            id: "pac_1" as Id<"parkedAction">,
            expectedStatus: "pending",
            status: "rejected",
            at: T1,
          }),
        ).toBeNull();
        expect((await store.parked.getParkedAction("pac_1" as Id<"parkedAction">))?.status).toBe(
          "approved",
        );

        const committed = await store.parked.transitionParkedAction({
          id: "pac_1" as Id<"parkedAction">,
          expectedStatus: "approved",
          status: "committed",
          at: T2,
          resultDigest: digestValue({ letterId: "doc_1" }),
          resultSummary: "letter queued for post",
        });
        expect(committed?.committedAt).toBe(T2);
        expect(committed?.resultSummary).toBe("letter queued for post");

        expect(
          await store.parked.transitionParkedAction({
            id: "pac_missing" as Id<"parkedAction">,
            expectedStatus: "pending",
            status: "voided",
            at: T1,
          }),
        ).toBeNull();
      });

      it("refuses to move an action out of a terminal status, however the caller asks", async () => {
        // Every terminal status, against every status a caller might want to
        // put it back to. The compare-and-set is satisfied in each case — the
        // caller reads first and expects exactly what is there — so this is the
        // rule the compare-and-set does not carry.
        for (const terminal of ["committed", "rejected", "voided", "indeterminate"] as const) {
          const id = `pac_${terminal}` as Id<"parkedAction">;
          await store.parked.createParkedAction(
            aParkedAction(id, "eag_1", { status: terminal, resultSummary: "as settled" }),
          );

          for (const wanted of ["pending", "approved", "committing", "expired"] as const) {
            expect(
              await store.parked.transitionParkedAction({
                id,
                expectedStatus: terminal,
                status: wanted,
                at: T2,
                voidReason: "reopened",
              }),
            ).toBeNull();
          }

          const stored = await store.parked.getParkedAction(id);
          expect(stored?.status).toBe(terminal);
          // Nothing was written at all — not the status, and not the reason
          // the losing caller supplied alongside it.
          expect(stored?.voidReason).toBeUndefined();
        }

        // `committing` is not terminal, and must not become so by accident:
        // every one of these is a transition the commit path itself performs.
        // A commit that could not leave `committing` would strand the effect it
        // just made in a state no sweeper and no operator can settle.
        for (const [index, settled] of (["committed", "pending", "indeterminate"] as const).entries()) {
          const id = `pac_inflight_${index}` as Id<"parkedAction">;
          await store.parked.createParkedAction(
            aParkedAction(id, "eag_1", { status: "committing" }),
          );
          expect(
            (
              await store.parked.transitionParkedAction({
                id,
                expectedStatus: "committing",
                status: settled,
                at: T2,
              })
            )?.status,
          ).toBe(settled);
        }
      });

      it(`lets exactly one of ${RACERS} concurrent commits through`, async () => {
        await store.parked.createParkedAction(
          aParkedAction("pac_1", "eag_1", { status: "approved" }),
        );

        const results = await times(RACERS, (index) =>
          store.parked.transitionParkedAction({
            id: "pac_1" as Id<"parkedAction">,
            expectedStatus: "approved",
            status: "committed",
            at: T2,
            resultSummary: `committed by racer ${index}`,
          }),
        );

        const winners = results.filter((result) => result !== null);
        expect(winners).toHaveLength(1);
        // The losers must not have overwritten the winner's recorded result —
        // that record is what a duplicate commit is replayed from.
        const stored = await store.parked.getParkedAction("pac_1" as Id<"parkedAction">);
        expect(stored?.status).toBe("committed");
        expect(stored?.resultSummary).toBe(winners[0]?.resultSummary);
      });

      it("expires what is still live and leaves settled actions as history", async () => {
        await store.parked.createParkedAction(aParkedAction("pac_pending", "eag_1"));
        await store.parked.createParkedAction(
          aParkedAction("pac_approved", "eag_1", { status: "approved" }),
        );
        await store.parked.createParkedAction(
          aParkedAction("pac_committed", "eag_1", { status: "committed" }),
        );
        await store.parked.createParkedAction(
          aParkedAction("pac_indeterminate", "eag_1", { status: "indeterminate" }),
        );
        await store.parked.createParkedAction(
          aParkedAction("pac_later", "eag_1", { expiresAt: T2 }),
        );

        // Still live at the instant it expires.
        expect(await store.parked.expireParkedActions(T1)).toEqual([]);

        const expired = await store.parked.expireParkedActions("2026-08-06T13:00:00.001Z");
        // An approved action whose window has closed stops being committable:
        // the approver agreed to it now, not whenever the agent gets round to
        // it.
        expect(expired.map((action) => action.id).sort()).toEqual(["pac_approved", "pac_pending"]);
        expect(
          (await store.parked.getParkedAction("pac_committed" as Id<"parkedAction">))?.status,
        ).toBe("committed");
        expect(
          (await store.parked.getParkedAction("pac_indeterminate" as Id<"parkedAction">))?.status,
        ).toBe("indeterminate");
        expect((await store.parked.getParkedAction("pac_later" as Id<"parkedAction">))?.status).toBe(
          "pending",
        );

        // The sweep drains rather than handing the same rows back for ever.
        expect(await store.parked.expireParkedActions("2026-08-06T13:00:00.001Z")).toEqual([]);
      });
    });

    // ----------------------------------------------------------- live runs

    describe("live runs", () => {
      it("stores a run whole and lists newest first", async () => {
        const first = await store.runs.createExternalRun(anExternalRun("xrn_1", "eag_1"));
        const second = await store.runs.createExternalRun(
          anExternalRun("xrn_2", "eag_2", { startedAt: T1, lastHeartbeatAt: T1 }),
        );
        expect(await store.runs.getExternalRun(first.id)).toEqual(first);
        expect((await store.runs.listExternalRuns()).map((run) => run.id)).toEqual([
          second.id,
          first.id,
        ]);
        expect(
          (await store.runs.listExternalRuns({ agentId: "eag_1" as ExternalAgentId })).map(
            (run) => run.id,
          ),
        ).toEqual(["xrn_1"]);
        expect((await store.runs.listExternalRuns({ status: ["finished"] }))).toEqual([]);
        expect((await store.runs.listExternalRuns({ limit: 1 })).map((run) => run.id)).toEqual([
          "xrn_2",
        ]);
      });

      it("refuses to reuse a run id or to account two episodes to one record run", async () => {
        await store.runs.createExternalRun(anExternalRun("xrn_1", "eag_1"));
        await expect(
          store.runs.createExternalRun(anExternalRun("xrn_1", "eag_1")),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(
          store.runs.createExternalRun(
            anExternalRun("xrn_2", "eag_1", { runId: "run_xrn_1" as Id<"run"> }),
          ),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it("accepts a heartbeat only while the run is running", async () => {
        await store.runs.createExternalRun(anExternalRun("xrn_1", "eag_1"));
        const beat = await store.runs.heartbeat("xrn_1" as Id<"externalRun">, T1);
        expect(beat?.lastHeartbeatAt).toBe(T1);

        await store.runs.finishExternalRun({
          id: "xrn_1" as Id<"externalRun">,
          status: "stopped",
          at: T2,
          outcome: "contained mid-flight",
          costUsd: 3.5,
        });

        // A heartbeat must not resurrect a run containment stopped. The null
        // is what makes the caller answer "stop" — the only kill switch there
        // is for an agent running somewhere we cannot reach.
        expect(await store.runs.heartbeat("xrn_1" as Id<"externalRun">, T_YEAR)).toBeNull();
        expect(await store.runs.heartbeat("xrn_missing" as Id<"externalRun">, T1)).toBeNull();
      });

      it("ends a run once", async () => {
        await store.runs.createExternalRun(anExternalRun("xrn_1", "eag_1"));
        const finished = await store.runs.finishExternalRun({
          id: "xrn_1" as Id<"externalRun">,
          status: "finished",
          at: T1,
          outcome: "12 letters drafted",
          costUsd: 1.25,
        });
        expect(finished?.status).toBe("finished");
        expect(finished?.endedAt).toBe(T1);
        expect(finished?.costUsd).toBeCloseTo(1.25, 10);

        // How a run ended is the answer to "what did this agent do". A second
        // writer would rewrite it rather than report it.
        expect(
          await store.runs.finishExternalRun({
            id: "xrn_1" as Id<"externalRun">,
            status: "failed",
            at: T2,
          }),
        ).toBeNull();
        expect((await store.runs.getExternalRun("xrn_1" as Id<"externalRun">))?.outcome).toBe(
          "12 letters drafted",
        );
      });

      it("finds runs that have stopped heartbeating, oldest silence first", async () => {
        await store.runs.createExternalRun(anExternalRun("xrn_late", "eag_1"));
        await store.runs.createExternalRun(
          anExternalRun("xrn_early", "eag_1", { lastHeartbeatAt: "2026-08-06T11:00:00.000Z" }),
        );
        await store.runs.createExternalRun(
          anExternalRun("xrn_live", "eag_1", { lastHeartbeatAt: T1 }),
        );
        await store.runs.createExternalRun(
          anExternalRun("xrn_done", "eag_1", { status: "finished", endedAt: T0 }),
        );

        const stale = await store.runs.findStaleRuns(T0_PLUS_1S, 10);
        expect(stale.map((run) => run.id)).toEqual(["xrn_early", "xrn_late"]);
        expect((await store.runs.findStaleRuns(T0_PLUS_1S, 1)).map((run) => run.id)).toEqual([
          "xrn_early",
        ]);
      });
    });

    // -------------------------------------------------- report ingestion

    describe("report ingestion", () => {
      const agentId = "eag_1" as ExternalAgentId;

      it("claims a key once and replays the original run id afterwards", async () => {
        const first = await store.runs.claimReport(agentId, "batch-14", "run_a" as Id<"run">, T0);
        expect(first).toEqual({ claimed: true, existingRunId: "run_a" });

        // A retried report — and agents retry, that is what a report endpoint
        // is for — must not become a second run and a second charge.
        const retry = await store.runs.claimReport(agentId, "batch-14", "run_b" as Id<"run">, T1);
        expect(retry).toEqual({ claimed: false, existingRunId: "run_a" });
      });

      it("keeps one agent's key space out of another's", async () => {
        await store.runs.claimReport(agentId, "batch-14", "run_a" as Id<"run">, T0);
        // A shared key space would let one agent suppress another's report by
        // claiming its key first, which is a way to make work disappear.
        const other = await store.runs.claimReport(
          "eag_2" as ExternalAgentId,
          "batch-14",
          "run_b" as Id<"run">,
          T0,
        );
        expect(other).toEqual({ claimed: true, existingRunId: "run_b" });
      });

      it("refuses a blank idempotency key", async () => {
        await expect(
          store.runs.claimReport(agentId, "   ", "run_a" as Id<"run">, T0),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it(`gives ${RACERS} concurrent claims one winner and one answer`, async () => {
        const results = await times(RACERS, (index) =>
          store.runs.claimReport(agentId, "batch-14", `run_${index}` as Id<"run">, T0),
        );

        const claimed = results.filter((result) => result.claimed);
        expect(claimed).toHaveLength(1);
        // Every loser is told the same run id, and it is the winner's. A
        // caller that received nothing, or a different id, would ingest the
        // report a second time.
        const ids = new Set(results.map((result) => result.existingRunId));
        expect(ids.size).toBe(1);
        expect([...ids][0]).toBe(claimed[0]?.existingRunId);
      });
    });

    // ------------------------------------------------------ rate limiting

    describe("rate limiting", () => {
      const agentId = "eag_1" as ExternalAgentId;

      it("counts per agent and per operation inside the window", async () => {
        expect(await store.limits.recordRequest(agentId, "screen", T0, MINUTE_MS)).toBe(1);
        expect(await store.limits.recordRequest(agentId, "screen", T0_PLUS_30S, MINUTE_MS)).toBe(2);
        // A different operation is a different budget.
        expect(await store.limits.recordRequest(agentId, "report", T0_PLUS_30S, MINUTE_MS)).toBe(1);
        // So is a different agent.
        expect(
          await store.limits.recordRequest("eag_2" as ExternalAgentId, "screen", T0_PLUS_30S, MINUTE_MS),
        ).toBe(1);
      });

      it("lets requests fall out of the window as it slides", async () => {
        await store.limits.recordRequest(agentId, "screen", T0, MINUTE_MS);
        await store.limits.recordRequest(agentId, "screen", T0_PLUS_30S, MINUTE_MS);
        expect(await store.limits.recordRequest(agentId, "screen", T0_PLUS_2M, MINUTE_MS)).toBe(1);
      });

      it("refuses a window that would count nothing", async () => {
        await expect(
          store.limits.recordRequest(agentId, "screen", T0, 0),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });

      it("counts misbehaviour toward containment and infrastructure toward nothing", async () => {
        expect(await store.limits.recordDenial(agentId, T0, MINUTE_MS, "misbehaviour")).toBe(1);
        // Containing an agent because our own store blinked punishes a
        // well-behaved team for our outage.
        expect(await store.limits.recordDenial(agentId, T0, MINUTE_MS, "infrastructure")).toBe(1);
        expect(await store.limits.recordDenial(agentId, T0_PLUS_1S, MINUTE_MS, "misbehaviour")).toBe(
          2,
        );
        expect(
          await store.limits.recordDenial("eag_2" as ExternalAgentId, T0, MINUTE_MS, "misbehaviour"),
        ).toBe(1);
      });

      it("lets denials fall out of the window, and clears them on demand", async () => {
        await store.limits.recordDenial(agentId, T0, MINUTE_MS, "misbehaviour");
        await store.limits.recordDenial(agentId, T0_PLUS_1S, MINUTE_MS, "misbehaviour");
        expect(await store.limits.recordDenial(agentId, T0_PLUS_2M, MINUTE_MS, "misbehaviour")).toBe(
          1,
        );

        await store.limits.clearDenials(agentId);
        expect(await store.limits.recordDenial(agentId, T0_PLUS_2M, MINUTE_MS, "misbehaviour")).toBe(
          1,
        );
      });

      it(`counts every one of ${RACERS} concurrent requests exactly once`, async () => {
        const counts = await times(RACERS, () =>
          store.limits.recordRequest(agentId, "screen", T0, MINUTE_MS),
        );
        // Without serialisation each caller counts a window that does not yet
        // contain the others, every answer comes back as 1, and an agent can
        // exceed its limit by being fast rather than by being allowed to.
        expect([...counts].sort((left, right) => left - right)).toEqual(
          Array.from({ length: RACERS }, (_, index) => index + 1),
        );
      });
    });
  });
}

runContract("in-memory external-agent adapters", memoryHarness, false);
runContract(
  "postgres external-agent adapters",
  () => postgresHarness(CONNECTION_STRING ?? ""),
  CONNECTION_STRING === undefined || CONNECTION_STRING === "",
);

/**
 * An unreadable store and an empty one must never look the same.
 *
 * One means "this agent has claimed no seats, spent nothing and replayed
 * nothing"; the other means "we do not know". A reader that cannot tell them
 * apart admits an agent it cannot account for, which is the single thing this
 * module exists to prevent.
 */
describe.skipIf(!CONNECTION_STRING)("an external-agent store that cannot answer refuses", () => {
  const absent = (CONNECTION_STRING ?? "").replace(/\/[^/?]*(?=\?|$)/, "/pv_absent_database");

  let pool: ReturnType<typeof createPool>;
  let db: PgDb;

  beforeAll(() => {
    // A real connection string pointed at a database that does not exist, so
    // the failures come from the driver rather than from a mock that might be
    // kinder than the real thing.
    pool = createPool(absent, 2);
    db = new PgDb(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("refuses to report an empty roster it cannot read", async () => {
    const agents = new PgEnrollmentStore(db);
    await expect(agents.listAgents()).rejects.toBeInstanceOf(DeniedError);
    await expect(agents.getAgent("eag_1" as ExternalAgentId)).rejects.toBeInstanceOf(DeniedError);
    await expect(agents.countAgents()).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses to hand out a seat it cannot count", async () => {
    const agents = new PgEnrollmentStore(db);
    await expect(agents.claimSeat(1)).rejects.toBeInstanceOf(DeniedError);
    await expect(agents.createAgent(anAgent("eag_1"))).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses to report spend, which would read as an agent that has spent nothing", async () => {
    const spend = new PgSpendStore(db);
    await expect(
      spend.addSpend("eag_1" as ExternalAgentId, "2026-08", 1, T0),
    ).rejects.toBeInstanceOf(DeniedError);
    await expect(spend.getMeter("eag_1" as ExternalAgentId, "2026-08")).rejects.toBeInstanceOf(
      DeniedError,
    );
  });

  it("refuses to claim a nonce or an approval it cannot record", async () => {
    const nonces = new PgNonceStore(db);
    const ledger = new PgUsedApprovalLedger(db);
    // An unrecordable claim must not come back as "yes, first time".
    await expect(
      nonces.claimNonce("eag_1" as ExternalAgentId, "n-1", T1),
    ).rejects.toBeInstanceOf(DeniedError);
    await expect(ledger.claimApproval("apr_1" as Id<"approval">, T0)).rejects.toBeInstanceOf(
      DeniedError,
    );
    // And an unreadable ledger must not report an approval as unconsumed.
    await expect(ledger.isConsumed("apr_1" as Id<"approval">)).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses parked-action, run and rate-limit work it cannot persist", async () => {
    const parked = new PgParkedActionStore(db);
    const runs = new PgExternalRunStore(db);
    const limits = new PgRateLimitStore(db);

    await expect(parked.listParkedActions()).rejects.toBeInstanceOf(DeniedError);
    await expect(
      parked.transitionParkedAction({
        id: "pac_1" as Id<"parkedAction">,
        expectedStatus: "pending",
        status: "committed",
        at: T0,
      }),
    ).rejects.toBeInstanceOf(DeniedError);
    await expect(runs.heartbeat("xrn_1" as Id<"externalRun">, T0)).rejects.toBeInstanceOf(
      DeniedError,
    );
    await expect(
      runs.claimReport("eag_1" as ExternalAgentId, "k", "run_1" as Id<"run">, T0),
    ).rejects.toBeInstanceOf(DeniedError);
    await expect(
      limits.recordRequest("eag_1" as ExternalAgentId, "screen", T0, MINUTE_MS),
    ).rejects.toBeInstanceOf(DeniedError);
  });
});
