import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { FixedClock } from "../kernel/clock.js";
import { loadConfig } from "../kernel/config.js";
import { digestValue } from "../kernel/hash.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { buildPlatform, type Platform } from "../platform.js";
import { createServer } from "../api/server.js";
import { PLATFORM_ACTIONS } from "../actions.js";
import { ActionRegistry } from "../guard/registry.js";
import { EXTERNAL_AGENT_ACTIONS } from "../external/enrollment.js";
import { IMPROVEMENT_ACTIONS } from "../improve/actions.js";
import type { ActorRef } from "../record/types.js";

/**
 * Step-up re-authentication, end to end.
 *
 * The finding this file exists to stop coming back: every approval on this
 * platform could be rejected and none could be granted. Three things had to be
 * true at once for that, and each of them is asserted below.
 *
 *   The HTTP layer could not report when anybody authenticated. It returned
 *   `undefined` unconditionally, so the approval service — correctly — refused
 *   every grant of an action requiring step-up.
 *
 *   No action declared `requiresStepUp`, so the question of which actions
 *   deserve one had no answer in the file where risk tiers are declared.
 *
 *   Nothing else could grant either. The console posts to the route that
 *   refused, and the command line had no verb at all.
 *
 * The failing-closed half is the half most easily broken by a well-meaning
 * fix, so it is asserted at least as hard as the working half: a caller with
 * no session, an expired session, a forged session, or a session on a
 * deployment that cannot sign anything must still be refused.
 */

const START = "2026-08-07T12:00:00.000Z";
const SESSION_SECRET = "step-up-tests-session-signing-secret-0123456789";
const SUPERVISOR_GROUPS = ["mvw-owner-services-supervisors"];

/** The requester. Distinct from whoever decides: nobody approves their own ask. */
const REQUESTER: ActorRef = {
  actorId: "demo:sam",
  kind: "human",
  roles: ["owner_services_agent"],
};

interface Harness {
  readonly platform: Platform;
  readonly app: FastifyInstance;
  readonly clock: FixedClock;
  close(): Promise<void>;
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const clock = new FixedClock(START);
  const platform = await buildPlatform(
    loadConfig({ PV_ENV: "development", PV_SESSION_SECRET: SESSION_SECRET, ...env }),
    { clock, ids: new SeededIdGenerator("step-up"), logger: createNullLogger() },
  );
  const app = createServer({ platform });
  await app.ready();
  return {
    platform,
    app,
    clock,
    async close() {
      await app.close();
      await platform.close();
    },
  };
}

async function parkAnApproval(platform: Platform): Promise<string> {
  const approval = await platform.approvals.request({
    action: "contact.send_owner_message",
    proposalDigest: digestValue({ letter: "your cancellation window closes on Friday" }),
    summary: "Notify owner of rescission deadline",
    requestedBy: REQUESTER,
    approvalsRequired: 1,
    eligibleRoles: ["supervisor"],
  });
  return approval.id;
}

/** Sign in through the development provider and return the cookie it set. */
async function signIn(
  app: FastifyInstance,
  subject: string,
  groups: readonly string[] = SUPERVISOR_GROUPS,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/session/sign-in",
    payload: { subject, groups },
  });
  expect(response.statusCode, response.body).toBe(200);
  const cookie = response.cookies.find((entry) => entry.name === "pv_session");
  expect(cookie, "sign-in must set the session cookie").toBeDefined();
  return String(cookie?.value);
}

function decide(
  app: FastifyInstance,
  approvalId: string,
  decision: "granted" | "rejected",
  cookie?: string,
): ReturnType<FastifyInstance["inject"]> {
  return app.inject({
    method: "POST",
    url: `/api/approvals/${approvalId}/decisions`,
    payload: { decision, note: "Checked against the cited rule." },
    ...(cookie ? { cookies: { pv_session: cookie } } : {}),
  });
}

describe("which actions require a step-up, declared where the risk tier is", () => {
  /** The catalogue's own entries. The two spliced-in groups declare their tiers in their own modules. */
  const splicedIn = new Set([...EXTERNAL_AGENT_ACTIONS, ...IMPROVEMENT_ACTIONS].map((a) => a.name));
  const catalogue = PLATFORM_ACTIONS.filter((action) => !splicedIn.has(action.name));

  it("states requiresStepUp on every catalogued action that can be performed", () => {
    const unstated = catalogue
      .filter((action) => action.risk !== "prohibited" && action.requiresStepUp === undefined)
      .map((action) => action.name);
    expect(
      unstated,
      "These actions leave requiresStepUp unset, so the tier default in guard/registry.ts decides it and a reviewer reading actions.ts cannot see what was decided. State it beside the risk tier.",
    ).toEqual([]);
  });

  it("says nothing about a step-up for a prohibited action", () => {
    // There is no decision to gate: they are refused unconditionally. `true`
    // would imply a re-authentication makes one possible.
    for (const action of catalogue.filter((entry) => entry.risk === "prohibited")) {
      expect(action.requiresStepUp, action.name).toBeUndefined();
    }
  });

  it("requires a step-up for every action that parks for a human, and for no routine one", () => {
    // Resolved through the registry, so this covers the spliced-in actions
    // too: what matters to an approver is the descriptor the chokepoint reads,
    // however its module chose to express it.
    const registry = new ActionRegistry(PLATFORM_ACTIONS);
    const parks = registry.list().filter((action) => action.approvalsRequired >= 1);

    // The ten actions the finding named — the platform's entire governed
    // surface. Every one is high-consequence, and the grant is the last thing
    // between a proposal and an irreversible effect.
    expect(parks).toHaveLength(10);
    for (const action of parks) {
      expect(action.risk, `${action.name} parks for approval`).toBe("high_consequence");
      expect(action.requiresStepUp, `${action.name} must require a step-up`).toBe(true);
    }

    for (const action of registry.list().filter((entry) => entry.risk === "routine")) {
      // A step-up in front of a read trains people to re-authenticate without
      // reading the prompt, which is how the prompt stops being evidence.
      expect(action.requiresStepUp, `${action.name} is routine`).toBe(false);
    }
  });
});

describe("an approval decided over HTTP", () => {
  it("refuses a grant from a caller nobody authenticated, and accepts the rejection", async () => {
    const h = await harness();
    try {
      const approvalId = await parkAnApproval(h.platform);

      const granted = await decide(h.app, approvalId, "granted");
      expect(granted.statusCode).toBe(409);
      expect(granted.json().reason).toBe("authorization.step_up_required");
      expect((await h.platform.approvals.get(approvalId as never))?.status).toBe("pending");

      // Rejecting is the safe direction and is deliberately not gated: whoever
      // is refusing is still role-checked, and demanding a second proof of
      // identity to say no would leave the work pending.
      const rejected = await decide(h.app, approvalId, "rejected");
      expect(rejected.statusCode).toBe(200);
      expect((await h.platform.approvals.get(approvalId as never))?.status).toBe("rejected");
    } finally {
      await h.close();
    }
  });

  it("grants for a supervisor who has really signed in, and records the step-up as observed", async () => {
    const h = await harness();
    try {
      const approvalId = await parkAnApproval(h.platform);
      const cookie = await signIn(h.app, "dana@mvw.example");

      // The session reports a real age, computed from the instant the provider
      // authenticated — not a number this layer chose.
      const session = await h.app.inject({
        method: "GET",
        url: "/api/session",
        cookies: { pv_session: cookie },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json().secondsSinceAuthentication).toBe(0);
      // The role is held because a directory group says so, not because the
      // request asked for it.
      expect(session.json().actor.roles).toEqual(["supervisor"]);

      const granted = await decide(h.app, approvalId, "granted", cookie);
      expect(granted.statusCode, granted.body).toBe(200);

      const approval = await h.platform.approvals.get(approvalId as never);
      expect(approval?.status).toBe("granted");
      expect(approval?.decisions[0]?.steppedUp).toBe(true);
      expect(approval?.decisions[0]?.actor.actorId).not.toBe(REQUESTER.actorId);

      // The audit entry claims the step-up, and now something observed it.
      const entries = await h.platform.audit.list({ eventType: ["approval.granted"] });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.decision?.["steppedUp"]).toBe(true);
      // And the sign-in that made it true is in the same chain.
      const signIns = await h.platform.audit.list({ eventType: ["identity.session_started"] });
      expect(signIns).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("refuses once the authentication is older than the step-up window, until it is stepped up", async () => {
    const h = await harness();
    try {
      const approvalId = await parkAnApproval(h.platform);
      const cookie = await signIn(h.app, "dana@mvw.example");

      // A session opened this morning is not a step-up this afternoon.
      h.clock.advance((h.platform.config.stepUpMaxAgeSeconds + 1) * 1000);
      const stale = await decide(h.app, approvalId, "granted", cookie);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().reason).toBe("authorization.step_up_required");

      const steppedUp = await h.app.inject({
        method: "POST",
        url: "/api/session/step-up",
        payload: { subject: "dana@mvw.example" },
        cookies: { pv_session: cookie },
      });
      expect(steppedUp.statusCode, steppedUp.body).toBe(200);
      expect(steppedUp.json().secondsSinceAuthentication).toBe(0);

      const granted = await decide(h.app, approvalId, "granted", cookie);
      expect(granted.statusCode, granted.body).toBe(200);
      expect((await h.platform.approvals.get(approvalId as never))?.status).toBe("granted");
    } finally {
      await h.close();
    }
  });

  it("refuses to step up somebody else's session", async () => {
    const h = await harness();
    try {
      const cookie = await signIn(h.app, "dana@mvw.example");
      const response = await h.app.inject({
        method: "POST",
        url: "/api/session/step-up",
        payload: { subject: "someone.else@mvw.example" },
        cookies: { pv_session: cookie },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().detail.check).toBe("step_up_subject_mismatch");
    } finally {
      await h.close();
    }
  });
});

describe("a session this platform cannot vouch for", () => {
  it("refuses a forged cookie rather than falling back to the development actor", async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: "GET",
        url: "/api/session",
        cookies: { pv_session: "v1.bm90LWFuLWFjdHVhbC1zZXNzaW9u.forged" },
      });
      // The development actor holds all six roles. A bad cookie must not be a
      // route to it: that would make forging one *better* than presenting none.
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain("dev:local");
    } finally {
      await h.close();
    }
  });

  it("refuses a revoked session on the next request", async () => {
    const h = await harness();
    try {
      const approvalId = await parkAnApproval(h.platform);
      const cookie = await signIn(h.app, "dana@mvw.example");
      const out = await h.app.inject({
        method: "POST",
        url: "/api/session/sign-out",
        cookies: { pv_session: cookie },
      });
      expect(out.statusCode).toBe(200);

      const granted = await decide(h.app, approvalId, "granted", cookie);
      expect(granted.statusCode).toBe(409);
      expect(granted.json().detail.check).toBe("session_revoked");
    } finally {
      await h.close();
    }
  });

  it("signs nobody in when the directory asserts no group that maps to a role", async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: "POST",
        url: "/api/session/sign-in",
        payload: { subject: "newstarter@mvw.example", groups: ["mvw-a-group-nobody-mapped"] },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().detail.check).toBe("no_entitlements");
    } finally {
      await h.close();
    }
  });

  it("refuses a sign-in whose group claim is absent rather than reading it as no groups", async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: "POST",
        url: "/api/session/sign-in",
        payload: { subject: "dana@mvw.example" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().field).toBe("groups");
    } finally {
      await h.close();
    }
  });
});

describe("a deployment that cannot open a session at all", () => {
  it("says which setting is missing, and still refuses every grant", async () => {
    // No PV_SESSION_SECRET: nothing can be signed, so nothing can be resolved,
    // so no authentication instant is observable. That must read as "no step-up
    // has happened" rather than as "no step-up is needed".
    const h = await harness({ PV_SESSION_SECRET: "" });
    try {
      const approvalId = await parkAnApproval(h.platform);

      const signIn = await h.app.inject({
        method: "POST",
        url: "/api/session/sign-in",
        payload: { subject: "dana@mvw.example", groups: SUPERVISOR_GROUPS },
      });
      expect(signIn.statusCode).toBe(409);
      expect(signIn.json().message).toContain("PV_SESSION_SECRET");

      const session = await h.app.inject({ method: "GET", url: "/api/session" });
      expect(session.json().sessionsUnavailable).toContain("PV_SESSION_SECRET");
      expect(session.json().secondsSinceAuthentication).toBeNull();

      const granted = await decide(h.app, approvalId, "granted");
      expect(granted.statusCode).toBe(409);
      expect(granted.json().reason).toBe("authorization.step_up_required");
    } finally {
      await h.close();
    }
  });
});
