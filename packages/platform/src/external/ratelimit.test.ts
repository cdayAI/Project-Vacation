import { describe, it, expect } from "vitest";
import { AuditLog } from "../audit/log.js";
import { verifyChain } from "../audit/chain.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { FixedClock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { MemoryDb } from "../store/db.js";
import { RateLimiter } from "./ratelimit.js";
import type { EnrollmentStore, RateLimitStore } from "./port.js";
import type {
  DenialClass,
  EnrolledAgent,
  EnrollmentUpdate,
  ExternalAgentId,
  RateLimitPolicy,
} from "./types.js";

/**
 * Tests for per-agent rate limiting and automatic containment.
 *
 * The distinction these exist to protect: misbehaviour contains an agent, and
 * our own infrastructure failing never does. Both halves are asserted, and the
 * mixed case is asserted too — infrastructure denials interleaved with
 * misbehaviour must not shorten the fuse.
 */

const START = "2026-08-06T12:00:00.000Z";
const AGENT = "eag_test_agent" as ExternalAgentId;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeRateLimitStore implements RateLimitStore {
  readonly requests = new Map<string, string[]>();
  readonly denials = new Map<string, string[]>();
  readonly denialClasses: DenialClass[] = [];
  failRequests = false;
  failDenials = false;
  clears = 0;

  async recordRequest(
    agentId: ExternalAgentId,
    operation: string,
    at: string,
    windowMs: number,
  ): Promise<number> {
    if (this.failRequests) throw new Error("rate ledger unreachable");
    const key = `${agentId}:${operation}`;
    const kept = inWindow(this.requests.get(key), at, windowMs);
    kept.push(at);
    this.requests.set(key, kept);
    return kept.length;
  }

  async recordDenial(
    agentId: ExternalAgentId,
    at: string,
    windowMs: number,
    denialClass: DenialClass,
  ): Promise<number> {
    if (this.failDenials) throw new Error("denial ledger unreachable");
    this.denialClasses.push(denialClass);
    const kept = inWindow(this.denials.get(agentId), at, windowMs);
    kept.push(at);
    this.denials.set(agentId, kept);
    return kept.length;
  }

  async clearDenials(agentId: ExternalAgentId): Promise<void> {
    this.clears += 1;
    this.denials.delete(agentId);
  }
}

function inWindow(entries: string[] | undefined, at: string, windowMs: number): string[] {
  const now = Date.parse(at);
  return (entries ?? []).filter((entry) => now - Date.parse(entry) < windowMs);
}

/** Just enough of the registry for the limiter to contain something. */
class FakeEnrollmentStore implements EnrollmentStore {
  readonly rows = new Map<string, EnrolledAgent>();

  constructor(status: EnrolledAgent["status"] = "active") {
    this.rows.set(AGENT, {
      id: AGENT,
      name: "crm-renewal-assistant",
      owner: "dana.reyes@mvw.example",
      department: "owner-services",
      hostPlatform: "vendor-crm",
      purpose: "Drafts renewal follow-ups.",
      allowedTools: [],
      riskCeiling: "sensitive",
      spendCeilingUsd: 100,
      budgetPeriod: "monthly",
      wallClockCeilingMs: 60_000,
      dataScopes: [],
      expiresAt: "2026-12-01T00:00:00.000Z",
      status,
      enrolledBy: "admin@mvw.example",
      enrolledAt: START,
      updatedAt: START,
    });
  }

  async createAgent(agent: EnrolledAgent): Promise<EnrolledAgent> {
    this.rows.set(agent.id, agent);
    return agent;
  }
  async getAgent(id: ExternalAgentId): Promise<EnrolledAgent | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async getAgentByName(): Promise<EnrolledAgent | null> {
    return null;
  }
  async listAgents(): Promise<readonly EnrolledAgent[]> {
    return [...this.rows.values()];
  }
  async countAgents(): Promise<number> {
    return this.rows.size;
  }
  async updateAgent(id: ExternalAgentId, update: EnrollmentUpdate): Promise<EnrolledAgent> {
    const current = this.rows.get(id);
    if (!current) throw new Error("no agent");
    const next = { ...current, ...update } as EnrolledAgent;
    this.rows.set(id, next);
    return next;
  }
  async setAgentStatus(input: {
    readonly id: ExternalAgentId;
    readonly expectedStatus: EnrolledAgent["status"];
    readonly status: EnrolledAgent["status"];
    readonly reason: string;
    readonly by: string;
    readonly at: string;
  }): Promise<EnrolledAgent | null> {
    const current = this.rows.get(input.id);
    if (!current || current.status !== input.expectedStatus) return null;
    const next: EnrolledAgent = {
      ...current,
      status: input.status,
      statusReason: input.reason,
      statusChangedAt: input.at,
      statusChangedBy: input.by,
      updatedAt: input.at,
    };
    this.rows.set(input.id, next);
    return { ...next };
  }
  async touchLastSeen(): Promise<void> {}
  async claimSeat(): Promise<boolean> {
    return true;
  }
  async releaseSeat(): Promise<void> {}
}

interface Harness {
  clock: FixedClock;
  limits: FakeRateLimitStore;
  agents: FakeEnrollmentStore;
  audit: AuditLog;
  limiter: RateLimiter;
}

function build(
  policy: Partial<RateLimitPolicy> = {},
  status: EnrolledAgent["status"] = "active",
): Harness {
  const clock = new FixedClock(START);
  const ids = new SeededIdGenerator("external-ratelimit");
  const db = new MemoryDb();
  const audit = new AuditLog(new MemoryAuditStore(db), clock, ids);
  const limits = new FakeRateLimitStore();
  const agents = new FakeEnrollmentStore(status);
  const limiter = new RateLimiter(limits, agents, audit, clock, {
    perOperationPerMinute: 3,
    denialsBeforeContainment: 3,
    denialWindowMs: 60_000,
    ...policy,
  });
  return { clock, limits, agents, audit, limiter };
}

async function status(harness: Harness): Promise<EnrolledAgent["status"]> {
  const agent = await harness.agents.getAgent(AGENT);
  return agent?.status ?? "revoked";
}

// ---------------------------------------------------------------------------

describe("request limits", () => {
  it("allows requests under the limit and reports the headroom", async () => {
    const harness = build();
    const first = await harness.limiter.admit(AGENT, "run.heartbeat");
    expect(first).toMatchObject({ used: 1, limit: 3, remaining: 2 });
    await harness.limiter.admit(AGENT, "run.heartbeat");
    expect(await harness.limiter.admit(AGENT, "run.heartbeat")).toMatchObject({
      used: 3,
      remaining: 0,
    });
  });

  it("refuses past the limit", async () => {
    const harness = build();
    for (let i = 0; i < 3; i += 1) await harness.limiter.admit(AGENT, "run.heartbeat");

    await expect(harness.limiter.admit(AGENT, "run.heartbeat")).rejects.toMatchObject({
      name: "DeniedError",
      reason: "ceiling.rate_exceeded",
    });
  });

  it("counts the request it is about to refuse", async () => {
    const harness = build();
    for (let i = 0; i < 5; i += 1) {
      await harness.limiter.admit(AGENT, "run.heartbeat").catch(() => undefined);
    }
    // Five requests arrived; five are in the window. An agent whose flooding
    // stopped being measured the moment it exceeded the limit would be able to
    // flood indefinitely at a constant recorded rate.
    expect(harness.limits.requests.get(`${AGENT}:run.heartbeat`)).toHaveLength(5);
  });

  it("keeps operations apart, so a noisy loop cannot lock out the work that matters", async () => {
    const harness = build();
    for (let i = 0; i < 3; i += 1) await harness.limiter.admit(AGENT, "run.heartbeat");
    await expect(harness.limiter.admit(AGENT, "run.heartbeat")).rejects.toBeInstanceOf(DeniedError);

    await expect(harness.limiter.admit(AGENT, "execute.commit")).resolves.toMatchObject({
      used: 1,
    });
  });

  it("forgets requests that have aged out of the rolling window", async () => {
    const harness = build();
    for (let i = 0; i < 3; i += 1) await harness.limiter.admit(AGENT, "run.heartbeat");
    harness.clock.advance(61_000);
    await expect(harness.limiter.admit(AGENT, "run.heartbeat")).resolves.toMatchObject({ used: 1 });
  });

  it("fails closed when the ledger cannot be read", async () => {
    const harness = build();
    harness.limits.failRequests = true;

    await expect(harness.limiter.admit(AGENT, "run.heartbeat")).rejects.toMatchObject({
      name: "DeniedError",
      reason: "record.unavailable",
    });
    // Our outage, so nothing is held against the agent.
    expect(harness.limits.denialClasses).toEqual([]);
    expect(await status(harness)).toBe("active");
  });

  it("refuses a policy that is missing or nonsensical", () => {
    const harness = build();
    expect(
      () =>
        new RateLimiter(
          harness.limits,
          harness.agents,
          harness.audit,
          harness.clock,
          undefined as never,
        ),
    ).toThrow(DeniedError);
    expect(
      () =>
        new RateLimiter(harness.limits, harness.agents, harness.audit, harness.clock, {
          perOperationPerMinute: 0,
          denialsBeforeContainment: 3,
          denialWindowMs: 1000,
        }),
    ).toThrow(DeniedError);
  });
});

// ---------------------------------------------------------------------------

describe("automatic containment", () => {
  it("contains an agent after repeated misbehaviour inside the window", async () => {
    const harness = build();

    const first = await harness.limiter.noteDenial(AGENT, {
      denialClass: "misbehaviour",
      reason: "tool not granted",
    });
    expect(first).toMatchObject({ counted: true, denialsInWindow: 1, contained: false });
    await harness.limiter.noteDenial(AGENT, {
      denialClass: "misbehaviour",
      reason: "tool not granted",
    });
    const third = await harness.limiter.noteDenial(AGENT, {
      denialClass: "misbehaviour",
      reason: "tool not granted",
    });

    expect(third.contained).toBe(true);
    expect(await status(harness)).toBe("contained");
  });

  it("records the containment as automatic, by the system, in the audit chain", async () => {
    const harness = build({ denialsBeforeContainment: 1 });
    await harness.limiter.noteDenial(AGENT, {
      denialClass: "misbehaviour",
      reason: "risk tier above its ceiling",
    });

    const entries = await harness.audit.list({ eventType: ["containment.engaged"] });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.actor.kind).toBe("system");
    expect(entry?.subject["externalAgentId"]).toBe(AGENT);
    expect(entry?.subject["principal"]).toBe("external");
    expect(entry?.decision["automatic"]).toBe(true);
    expect(entry?.decision["scope"]).toBe("external_agent");
    expect(verifyChain(await harness.audit.readChain()).intact).toBe(true);
  });

  it("clears the window when it contains, so a human's release is not undone at once", async () => {
    const harness = build({ denialsBeforeContainment: 2 });
    await harness.limiter.noteDenial(AGENT, { denialClass: "misbehaviour", reason: "x" });
    await harness.limiter.noteDenial(AGENT, { denialClass: "misbehaviour", reason: "x" });

    expect(harness.limits.clears).toBe(1);
    expect(harness.limits.denials.get(AGENT)).toBeUndefined();
  });

  it("contains through the rate limit itself, and says so in the denial", async () => {
    const harness = build({ perOperationPerMinute: 1, denialsBeforeContainment: 2 });
    await harness.limiter.admit(AGENT, "report");
    await harness.limiter.admit(AGENT, "report").catch(() => undefined);

    await expect(harness.limiter.admit(AGENT, "report")).rejects.toMatchObject({
      reason: "ceiling.rate_exceeded",
      detail: { contained: true },
    });
    expect(await status(harness)).toBe("contained");
  });

  it("leaves a revoked agent revoked rather than walking it back to contained", async () => {
    const harness = build({ denialsBeforeContainment: 1 }, "revoked");
    const outcome = await harness.limiter.noteDenial(AGENT, {
      denialClass: "misbehaviour",
      reason: "still calling after revocation",
    });
    expect(outcome.contained).toBe(false);
    expect(await status(harness)).toBe("revoked");
    expect(await harness.audit.count({ eventType: ["containment.engaged"] })).toBe(0);
  });

  it("fails closed when the denial cannot be recorded", async () => {
    const harness = build();
    harness.limits.failDenials = true;
    await expect(
      harness.limiter.noteDenial(AGENT, { denialClass: "misbehaviour", reason: "x" }),
    ).rejects.toMatchObject({ name: "DeniedError", reason: "record.unavailable" });
  });
});

// ---------------------------------------------------------------------------

describe("our own failures never contain a team", () => {
  it("never counts an infrastructure denial, however many arrive", async () => {
    const harness = build({ denialsBeforeContainment: 3 });

    for (let i = 0; i < 20; i += 1) {
      const outcome = await harness.limiter.noteDenial(AGENT, {
        denialClass: "infrastructure",
        reason: "operating record unreachable",
      });
      expect(outcome).toMatchObject({ counted: false, contained: false, denialsInWindow: 0 });
    }

    expect(await status(harness)).toBe("active");
    // Not merely uncounted: never written. The ledger's only reader is the
    // containment threshold, so a row that must not contribute to it does not
    // belong in it at all.
    expect(harness.limits.denialClasses).toEqual([]);
    expect(harness.limits.denials.get(AGENT)).toBeUndefined();
    expect(await harness.audit.count({ eventType: ["containment.engaged"] })).toBe(0);
  });

  it("does not let infrastructure denials shorten the fuse for misbehaviour", async () => {
    const harness = build({ denialsBeforeContainment: 3 });

    await harness.limiter.noteDenial(AGENT, { denialClass: "misbehaviour", reason: "a" });
    for (let i = 0; i < 10; i += 1) {
      await harness.limiter.noteDenial(AGENT, { denialClass: "infrastructure", reason: "b" });
    }
    const second = await harness.limiter.noteDenial(AGENT, {
      denialClass: "misbehaviour",
      reason: "a",
    });

    // Twelve denials have been seen; two of them were the agent's fault, and
    // the threshold of three counts only those.
    expect(second).toMatchObject({ denialsInWindow: 2, contained: false });
    expect(await status(harness)).toBe("active");

    const third = await harness.limiter.noteDenial(AGENT, {
      denialClass: "misbehaviour",
      reason: "a",
    });
    expect(third.contained).toBe(true);
  });

  it("clears a denial history on request, for the release path", async () => {
    const harness = build({ denialsBeforeContainment: 5 });
    await harness.limiter.noteDenial(AGENT, { denialClass: "misbehaviour", reason: "a" });
    await harness.limiter.clearDenials(AGENT);
    expect(harness.limits.denials.get(AGENT)).toBeUndefined();
  });
});
