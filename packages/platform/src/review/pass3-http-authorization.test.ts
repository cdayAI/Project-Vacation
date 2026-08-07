import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../kernel/config.js";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { digestValue } from "../kernel/hash.js";
import { buildPlatform, type Platform } from "../platform.js";
import { createServer } from "../api/server.js";
import type { ActorRef } from "../record/types.js";

/**
 * Pass 3 — authorization on the HTTP surface, tried as each role.
 *
 * The console is a rendering hint. Everything here goes at the API directly,
 * as an attacker with a session cookie and `curl` would, and asks whether the
 * server re-checks what the console decided not to show.
 *
 * Two of these pass and are kept deliberately: the refutations are as valuable
 * as the findings, and a control nobody exercises from the outside is one
 * refactor from being gone.
 */

const START = "2026-08-06T12:00:00.000Z";

/** A read-only auditor, as the identity module would produce one. */
const AUDITOR: ActorRef = { actorId: "dev:auditor", kind: "human", roles: ["auditor"] };

/**
 * The same auditor with one data-scope entitlement.
 *
 * `identity/types.ts:410` merges an actor's scopes into `roles` as `scope:*`
 * strings, so this is what a real auditor looks like the moment identity is
 * wired — not a contrived shape.
 */
const SCOPED_AUDITOR: ActorRef = {
  actorId: "dev:auditor",
  kind: "human",
  roles: ["auditor", "scope:legal"],
};

const SUPERVISOR: ActorRef = {
  actorId: "dev:supervisor",
  kind: "human",
  roles: ["supervisor"],
};

async function platformFor(): Promise<Platform> {
  return buildPlatform(loadConfig({ PV_ENV: "development" }), {
    clock: new FixedClock(START),
    ids: new SeededIdGenerator("pass3-http"),
    logger: createNullLogger(),
  });
}

describe("a read-only auditor going at the API directly", () => {
  let platform: Platform;
  let app: FastifyInstance;

  beforeEach(async () => {
    platform = await platformFor();
    app = createServer({ platform, developmentActor: AUDITOR });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await platform.close();
  });

  it("is refused the containment switch the console would not offer", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/containment",
      payload: { scope: "global", engaged: true, reason: "trying it as an auditor" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().reason).toBe("authorization.action_not_permitted");
    expect(await platform.containment.list()).toEqual([]);
  });

  it("is refused a correction, which is a write to the improvement loop", async () => {
    // `improvement.observe` lists no auditor and no finance role
    // (improve/actions.ts:59-67), and the route reaches the chokepoint through
    // the harvester rather than through `authorized()` — so this proves the
    // indirect path checks too.
    const run = await platform.runs.createRun({
      kind: "rescission_check",
      mode: "supervised",
      requestedBy: AUDITOR,
      subject: { contractId: "ctr_0001" },
    });
    const step = await platform.runs.appendStep({
      runId: run.id,
      kind: "computation",
      name: "compute_deadline",
      idempotencyKey: `pass3:${run.id}:compute_deadline`,
      status: "succeeded",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${run.id}/steps/${step.id}/corrections`,
      payload: { signature: "deadline.wrong_jurisdiction", note: "auditor tried to correct this" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().reason).toBe("authorization.action_not_permitted");
  });
});

describe("the read-only flag the session endpoint reports", () => {
  let platform: Platform;
  let app: FastifyInstance;

  beforeEach(async () => {
    platform = await platformFor();
    app = createServer({ platform, developmentActor: SCOPED_AUDITOR });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await platform.close();
  });

  it("still says read-only when the auditor also holds a data scope", async () => {
    // `api/server.ts:257` decides read-only with `roles.length === 1`, and
    // `identity/types.ts:410` puts scope entitlements in that same array. An
    // auditor entitled to read one association therefore stops being read-only,
    // and the console draws every write control for them.
    const response = await app.inject({ method: "GET", url: "/api/session" });
    expect(response.statusCode).toBe(200);
    expect(response.json().readOnly).toBe(true);
  });
});

describe("approving a step-up action through the HTTP API", () => {
  let platform: Platform;
  let app: FastifyInstance;

  beforeEach(async () => {
    platform = await platformFor();
    app = createServer({ platform, developmentActor: SUPERVISOR });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await platform.close();
  });

  it("does not record a re-authentication the platform never observed", async () => {
    // `contact.send_owner_message` is high_consequence, so `requiresStepUp` is
    // true and `ApprovalService.decide` refuses without a recent
    // re-authentication. The route at `api/server.ts:456` supplies the literal
    // `secondsSinceAuthentication: 0`, so the check passes unconditionally and
    // the decision is stamped `steppedUp: true`.
    //
    // The assertion is deliberately about the *record*, not about the refusal.
    // Whether the route should refuse or should carry a real age from the
    // session is an open design question; writing "this person re-proved who
    // they were" into a hash-chained governance log when nobody did is not.
    const descriptor = platform.registry.require("contact.send_owner_message");
    expect(descriptor.requiresStepUp).toBe(true);

    const approval = await platform.approvals.request({
      action: "contact.send_owner_message",
      proposalDigest: digestValue({ letter: "rescission acknowledgement" }),
      summary: "Send the rescission acknowledgement",
      requestedBy: { actorId: "dev:agent", kind: "human", roles: ["owner_services_agent"] },
      approvalsRequired: 1,
      eligibleRoles: ["supervisor"],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decisions`,
      payload: { decision: "granted", note: "looks right" },
    });
    expect(response.statusCode).toBe(200);

    const entries = await platform.audit.list({ eventType: ["approval.granted"] as never });
    expect(entries).toHaveLength(1);
    expect(
      entries[0]?.decision?.["steppedUp"],
      "the audit chain claims a step-up re-authentication that never happened",
    ).not.toBe(true);
  });
});
