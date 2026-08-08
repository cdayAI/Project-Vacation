import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { verifyChain } from "../audit/chain.js";
import {
  EXTERNAL_PLANE_DISABLED,
  externalAgentHealth,
  externalHealthPorts,
} from "../external/health.js";
import type { ActorRef } from "../record/types.js";
import type { Platform } from "../platform.js";
import { externalRouteDeps, registerExternalRoutes } from "./external.js";
import { externalAgentDetail, rosterRow } from "./external-roster.js";
import type { ExternalAgentId } from "../external/types.js";
import {
  approvalDetail,
  approvalQueueRow,
  type DecisionContextSources,
} from "./approval-context.js";
import { asRunId, describeRun, parseWorkQueueQuery, workQueuePage } from "./work-queue.js";
import { runTimeline } from "./run-timeline.js";
import { roleRegistryPage, roleVersionsPage } from "./role-registry.js";
import { workflowInstanceView } from "./workflow-instance.js";
import { improvementClustersPage } from "./improvement-clusters.js";
import { improvementProposalsPage, improvementProposalView } from "./improvement-proposals.js";
import { discoveryCandidatesPage } from "./discovery-backlog.js";
import { executiveView } from "./executive.js";
import type { Id } from "../kernel/ids.js";
import { buildIdentityRuntime, type IdentityRuntime } from "../identity/runtime.js";
import { mapDirectoryGroups } from "../identity/roles.js";
import { SESSION_COOKIE_NAME } from "../identity/session.js";
import type { ResolvedSession } from "../identity/session.js";
import { rejectionSignature } from "../guard/approvals.js";

/**
 * The HTTP surface.
 *
 * Three rules shape every handler here.
 *
 * **A denial is a response, not an exception.** The platform refuses often and
 * on purpose, and a refusal carries information the operator needs. Denials
 * come back as HTTP 409 with a structured body the console renders as a
 * first-class outcome. They are deliberately not 500s: a 500 says "we broke",
 * and a denial says "we declined, here is why".
 *
 * **The API maps domain objects to view models.** It never serialises an
 * internal type straight to the wire. That indirection is where data
 * minimisation is applied on the way out — a view model carries what a screen
 * needs and nothing else, so a field that should not reach a browser cannot
 * leak by being present on an object that happened to be returned.
 *
 * **Authorization happens in the platform, not here.** A route handler resolves
 * who is calling and then asks the chokepoint. It never decides for itself. The
 * console's capability list is a rendering hint; this layer re-checks
 * everything, because a hidden button is a courtesy and not a control.
 */

export interface ServerOptions {
  readonly platform: Platform;
  /**
   * Development-only identity.
   *
   * When no OIDC issuer is configured, requests are attributed to this actor so
   * the console is usable locally. `loadConfig` refuses to start without OIDC
   * in staging and production, so this cannot be reached there — but the check
   * is repeated at request time rather than trusted, because a control that
   * depends on startup validation having run is one refactor from being gone.
   */
  readonly developmentActor?: ActorRef;
  /**
   * Where the approval screen's artifact preview and evidence come from.
   *
   * Both are things the operating record deliberately does not hold — it keeps
   * a digest of a proposal rather than its content, and it does not link an
   * approval to the passages behind it. A deployment wires its document store
   * and its corpus here. Unwired, the approval screen says which fields are
   * missing and why, which is the state this repository ships in.
   */
  readonly decisionContext?: DecisionContextSources;
}

const DEV_ACTOR: ActorRef = {
  actorId: "dev:local",
  kind: "human",
  roles: [
    "owner_services_agent",
    "supervisor",
    "compliance_reviewer",
    "association_manager",
    "finance",
    "platform_admin",
  ],
};

/**
 * The `limit`/`offset` a list read is asked for, clamped.
 *
 * A default page of fifty and a ceiling of two hundred, matching the work
 * queue. A non-numeric or negative value falls back rather than refusing: a
 * paste-mangled query on a read should still return the first page rather than
 * a 400, which the operator can do nothing useful with.
 */
function pageParams(query: unknown): { readonly limit: number; readonly offset: number } {
  const record = (query ?? {}) as Record<string, string | string[] | undefined>;
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;
  const rawLimit = Number(first(record.limit) ?? 50);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 200) : 50;
  const rawOffset = Number(first(record.offset) ?? 0);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;
  return { limit, offset };
}

function denialBody(error: DeniedError) {
  return {
    denied: true as const,
    reason: error.reason,
    message: error.message,
    detail: error.detail,
  };
}

/** Per-request identity, resolved once by the hook below and read by both. */
interface RequestIdentity {
  readonly session?: ResolvedSession;
  /** Why the presented cookie was refused. Rethrown when a caller needs a name. */
  readonly failure?: unknown;
}

export function createServer(options: ServerOptions): FastifyInstance {
  const { platform } = options;
  const decisionContext = options.decisionContext ?? {};

  // Identity is composed here, once, rather than reached for per request.
  //
  // Unavailable is a state this server serves in rather than refuses to start
  // in: health, and the reason a sign-in is impossible, are exactly what an
  // operator needs from a deployment that has no session secret. What it must
  // not do is quietly behave as though everyone is authenticated, so an
  // unavailable runtime leaves every request with no session at all — which is
  // the state that refuses a high-consequence grant.
  const identityAvailability = buildIdentityRuntime({
    config: platform.config,
    clock: platform.clock,
    ids: platform.ids,
    audit: platform.audit,
    logger: platform.logger,
    db: platform.db,
  });
  const identity: IdentityRuntime | undefined = identityAvailability.available
    ? identityAvailability.runtime
    : undefined;
  const identityUnavailableReason = identityAvailability.available
    ? undefined
    : identityAvailability.reason;
  if (identityUnavailableReason) {
    platform.logger.warn("sessions are unavailable on this API", {
      reason: identityUnavailableReason,
    });
  }
  const app = Fastify({
    // The platform's own logger already writes structured, redacted lines to
    // stderr. A second logger here would produce a parallel stream with
    // different redaction rules, which is exactly how a secret reaches a log —
    // so Fastify's is switched off entirely rather than configured.
    logger: false,
    bodyLimit: 1_000_000,
  });

  void app.register(cookie);

  // Record every route as it is registered.
  //
  // Fastify's printRoutes renders a tree, which has to be reassembled to get
  // full paths and is easy to reassemble slightly wrong. The contract test
  // between this API and the console needs an exact answer, and a route list
  // that is subtly incomplete would let the drift it exists to catch through.
  // The hook is registered before any route, so it sees all of them.
  const routes = new Set<string>();
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.add(`${method} ${route.url}`);
  });
  app.decorate("registeredRoutes", routes);

  // -------------------------------------------------------------------------
  // Correlation and error translation
  // -------------------------------------------------------------------------

  app.addHook("onRequest", async (request) => {
    const header = request.headers["x-correlation-id"];
    const correlationId =
      typeof header === "string" && header.length > 0 && header.length <= 128
        ? header
        : platform.ids.next("session");
    (request as FastifyRequest & { correlationId: string }).correlationId = correlationId;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DeniedError) {
      // 409 Conflict: the request was understood and refused on policy grounds.
      // Not 403, which implies the caller could never do this; a denial is
      // frequently about state — a pause is engaged, a ceiling is reached, an
      // approval is missing — and may succeed later.
      void reply.status(409).send(denialBody(error));
      return;
    }
    if (error instanceof InvalidInputError) {
      void reply.status(400).send({ error: "invalid_input", message: error.message, field: error.field });
      return;
    }
    // The correlation id is the only key joining this line to the audit
    // entries, the run, and whatever other component handled the same case.
    // Without it the log stream and the chain describe one incident in two
    // vocabularies and have to be reconciled by timestamp.
    //
    // The error is flattened here rather than passed as an object: an `Error`
    // has no enumerable own properties, so a structured logger serialises it to
    // `{}` and the one line written about a failure says nothing about it.
    platform.logger.error("unhandled request failure", {
      path: request.url,
      method: request.method,
      correlationId: (request as FastifyRequest & { correlationId?: string }).correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    void reply.status(500).send({ error: "internal_error" });
  });

  // Resolve the session cookie once per request, before any handler runs.
  //
  // A refusal is *stored* rather than thrown here on purpose. Health is
  // deliberately unauthenticated, and a stale cookie in a browser tab must not
  // be able to stop an operator reading why the platform is unwell. Every route
  // that needs to know who is calling goes through `actorFor`, which rethrows.
  app.addHook("preHandler", async (request) => {
    const cookie = request.cookies?.[SESSION_COOKIE_NAME];
    if (!identity || typeof cookie !== "string" || cookie.length === 0) return;
    const attach = (value: RequestIdentity): void => {
      (request as FastifyRequest & { identity?: RequestIdentity }).identity = value;
    };
    try {
      attach({ session: await identity.sessions.resolve(cookie) });
    } catch (error) {
      // allow-swallow: held and rethrown by `actorFor`. Refusing here would
      // turn "this session expired" into a failure of endpoints that never
      // needed a session.
      attach({ failure: error });
    }
  });

  function identityOf(request: FastifyRequest): RequestIdentity {
    return (request as FastifyRequest & { identity?: RequestIdentity }).identity ?? {};
  }

  /**
   * How long ago this caller authenticated, or undefined when nobody knows.
   *
   * `SessionService.resolve` computes the figure from the session's
   * `authenticatedAt` — which sign-in stamps and a step-up moves forward — and
   * clamps an unparseable stamp to `+Infinity` so it fails closed.
   *
   * Undefined still happens, and still means what it says: no session was
   * presented, or this deployment cannot open one. The approval service reads
   * that as "no step-up has been observed" and refuses a grant that requires
   * one. What has changed is that the other answer is now reachable — before,
   * this returned undefined unconditionally, so no approval could ever be
   * granted on any deployment.
   */
  function secondsSinceAuthenticationFor(request: FastifyRequest): number | undefined {
    return identityOf(request).session?.secondsSinceAuthentication;
  }

  function actorFor(request: FastifyRequest): ActorRef {
    const resolved = identityOf(request);
    // A presented-and-refused cookie is a refusal, never a fall-through to the
    // development actor: otherwise an expired session would silently gain the
    // six roles DEV_ACTOR holds.
    if (resolved.failure !== undefined) throw resolved.failure;
    if (resolved.session) {
      // Entitlements come from the actor record, re-read on every request, so a
      // directory group removed since sign-in is gone by the next click.
      return resolved.session.actorRef;
    }

    if (platform.config.oidcIssuer) {
      // A session resolved above is honoured whatever minted it, so this branch
      // is only reached when there is none. Sign-in against a configured
      // provider is still the OIDC flow's job, and that flow has no route yet —
      // so this refuses rather than falling back to the development actor.
      throw new DeniedError(
        "authorization.action_not_permitted",
        identityUnavailableReason
          ? `No authenticated session, and this deployment cannot open one. ${identityUnavailableReason}`
          : "No authenticated session. Sign in through the identity provider.",
        {},
      );
    }

    if (platform.config.environment !== "development") {
      // Belt and braces. loadConfig already refuses this combination.
      throw new DeniedError(
        "config.missing",
        `No identity provider is configured and the environment is ${platform.config.environment}. Refusing to attribute requests to a development identity.`,
        { environment: platform.config.environment },
      );
    }

    return options.developmentActor ?? DEV_ACTOR;
  }

  /** Authorise a read, then run it. Every read passes the chokepoint too. */
  async function authorized<T>(
    request: FastifyRequest,
    action: string,
    handler: () => Promise<T>,
  ): Promise<T> {
    const actor = actorFor(request);
    await platform.authorizer.authorize({
      action,
      actor,
      mode: "supervised",
      correlationId: (request as FastifyRequest & { correlationId?: string }).correlationId,
    });
    return handler();
  }

  // -------------------------------------------------------------------------
  // Health — deliberately unauthenticated, and deliberately loud
  // -------------------------------------------------------------------------

  // Served at two paths deliberately. `/health` is where an infrastructure
  // probe looks and must stay stable and unprefixed; `/api/health` is where the
  // console's client looks, because everything it calls is under one base URL.
  // One handler, so the two can never disagree.
  const healthHandler = async () => {
    // Every dependency read is allowed to fail without taking the endpoint with
    // it. The handler used to read the audit head first, so an unreachable
    // database escaped as a DeniedError and the error translator answered 409
    // with no health payload at all — during the one outage where an operator
    // most needs this endpoint to say what is wrong. A health check that
    // refuses is not a health check.
    const unreachable: string[] = [];

    const head = await platform.audit.head().catch((error: unknown) => {
      // allow-swallow: an unreadable dependency is the answer this endpoint
      // exists to give, not a reason to withhold it. It is reported below as
      // an unhealthy status naming what could not be read.
      unreachable.push(`audit chain (${error instanceof Error ? error.message : String(error)})`);
      return null;
    });
    const switches = await platform.containment.list().catch((error: unknown) => {
      // allow-swallow: as above.
      unreachable.push(
        `containment switches (${error instanceof Error ? error.message : String(error)})`,
      );
      return [];
    });
    // The four external-agent conditions an operator needs without asking. They
    // ride on the health payload rather than living behind their own endpoint
    // because the whole point of them is to be seen by somebody who did not
    // come looking — see external/health.ts.
    const externalAgents = platform.external.enabled
      ? await externalAgentHealth(
          externalHealthPorts(platform.external.stores),
          platform.clock.nowIso(),
        ).catch((error: unknown) => {
          // allow-swallow: reported as unreachable, not hidden.
          unreachable.push(
            `external agent plane (${error instanceof Error ? error.message : String(error)})`,
          );
          return EXTERNAL_PLANE_DISABLED;
        })
      : EXTERNAL_PLANE_DISABLED;

    const paused = switches.some((entry) => entry.scope === "global" && entry.engaged);

    return {
      /**
       * Derived, not asserted.
       *
       * `status` was the literal "ok" in every state this platform can reach,
       * which meant everything that reads only this field — a probe, a
       * dashboard tile, an uptime check — was told the platform was fine while
       * it refused every request.
       *
       * Two conditions, and the line between them is what a load balancer
       * should do. **Unavailable**: a dependency cannot be read, so this
       * instance cannot serve and should be taken out of rotation.
       * **Degraded**: the platform is deliberately paused by an operator — it
       * is refusing on purpose, and pulling it out of rotation would remove
       * the console the operator needs to un-pause it, which is the opposite
       * of helpful. Configuration warnings are deliberately *not* a condition:
       * a default development start emits three, so treating them as ill
       * health would make "unhealthy" the normal state and train everyone to
       * ignore it.
       */
      status: unreachable.length > 0 ? "unavailable" : paused ? "degraded" : "ok",
      /** What could not be read, named rather than implied. */
      unreachable,
      environment: platform.config.environment,
      store: platform.config.store,
      sandboxMode: platform.sandbox.mode,
      // Surfaced because an operator must never have to read the environment
      // to discover that the sandbox is not containing anything.
      sandboxIsContained: platform.sandbox.isContained,
      discoveryEnabled: platform.config.discoveryEnabled,
      modelProvider: platform.config.modelProvider,
      auditHeadSeq: head?.seq ?? null,
      externalAgents,
      containment: switches.map((entry) => ({
        scope: entry.scope,
        target: entry.target,
        engaged: entry.engaged,
        engagedBy: entry.engagedBy,
        engagedAt: entry.engagedAt,
        reason: entry.reason,
      })),
      warnings: platform.config.warnings,
    };
  };

  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  app.get("/api/session", async (request) => {
    const actor = actorFor(request);
    // Data-scope entitlements ride in the same array as roles
    // (`identity/types.ts:410`), so they are excluded before counting. An
    // auditor entitled to read one association is still an auditor; counting
    // `scope:` strings as second roles would silently un-flag every real
    // auditor the identity provider produces and draw them every write control.
    const heldRoles = actor.roles.filter((role) => !role.startsWith("scope:"));
    const isAuditor = heldRoles.includes("auditor") && heldRoles.length === 1;
    return {
      actor: {
        actorId: actor.actorId,
        displayName: actor.actorId,
        roles: actor.roles,
      },
      secondsSinceAuthentication: secondsSinceAuthenticationFor(request) ?? null,
      // A rendering hint for the console. The server re-checks every action.
      capabilities: platform.registry
        .list()
        .filter((descriptor) =>
          actor.roles.some((role) => descriptor.allowedRoles.includes(role)),
        )
        .map((descriptor) => descriptor.name),
      readOnly: isAuditor,
      /**
       * The window a grant has to happen inside, so a screen can say so before
       * somebody spends a minute reading an approval and then loses it.
       */
      stepUpMaxAgeSeconds: platform.config.stepUpMaxAgeSeconds,
      /** Null when this deployment can open a session; the reason when it cannot. */
      sessionsUnavailable: identityUnavailableReason ?? null,
    };
  });

  /**
   * Sign in, and step up, against the development identity provider.
   *
   * These two routes exist because a step-up requirement nothing can satisfy is
   * not a control, it is a wall: every approval on this platform could be
   * rejected and none could be granted, on every deployment, because nothing
   * had ever opened a session for the HTTP layer to read an authentication
   * instant from.
   *
   * They are the *development* provider's routes and refuse to be anything
   * else. It authenticates nobody — it mints an identity for whatever subject
   * and directory groups the caller asks for — so it is confined to the one
   * environment where that is a stated property rather than a breach, and it is
   * absent the moment an OIDC issuer is configured. Signing in against a real
   * provider is the authorization-code flow in `identity/oidc.ts`, which has no
   * route here yet; until it does, a deployment with an issuer configured can
   * resolve a session it was given and open none.
   *
   * What makes the step-up honest is that nothing here asserts a fact. The
   * session carries the instant the provider authenticated, `resolve` computes
   * the age from it, and a grant passes only while that age is inside
   * `PV_STEP_UP_MAX_AGE_SECONDS`. Nobody signed in an hour ago passes.
   */
  function requireDevelopmentSignIn(): {
    readonly runtime: IdentityRuntime;
    readonly provider: NonNullable<IdentityRuntime["developmentProvider"]>;
  } {
    if (!identity) {
      throw new DeniedError(
        "config.missing",
        `This deployment cannot open a session. ${identityUnavailableReason ?? ""}`.trim(),
        {},
      );
    }
    if (!identity.developmentProvider) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        platform.config.oidcIssuer
          ? "An identity provider is configured, so sign-in is its authorization-code flow rather than this route. That flow is not wired into this API yet."
          : `The development identity provider does not run in ${platform.config.environment}. It performs no authentication.`,
        { environment: platform.config.environment },
      );
    }
    return { runtime: identity, provider: identity.developmentProvider };
  }

  function readSubject(body: unknown): { subject: string; groups: readonly string[] } {
    const input = (body ?? {}) as { subject?: unknown; groups?: unknown };
    if (typeof input.subject !== "string" || input.subject.trim().length === 0) {
      throw new InvalidInputError("A sign-in needs a subject — who is signing in.", "subject");
    }
    // An absent group claim is refused rather than read as "no groups": a
    // provider that stops emitting groups would otherwise deprovision
    // everybody, and `mapDirectoryGroups` is explicit that the two differ.
    if (!Array.isArray(input.groups) || input.groups.some((g) => typeof g !== "string")) {
      throw new InvalidInputError(
        "A sign-in needs the directory groups the provider asserts, as an array of strings. Roles come from group membership and from nowhere else, so an absent claim is refused rather than treated as no groups.",
        "groups",
      );
    }
    return { subject: input.subject.trim(), groups: input.groups as readonly string[] };
  }

  app.post("/api/session/sign-in", async (request, reply) => {
    const { runtime, provider } = requireDevelopmentSignIn();
    const { subject, groups } = readSubject(request.body);

    const issued = await runtime.sessions.start({
      identity: provider.authenticate({ subject, groups }),
      // The same mapping a real sign-in goes through. No role is asserted here:
      // one is held because a directory group says so.
      entitlements: mapDirectoryGroups(groups, runtime.roleMapping),
      correlationId: (request as FastifyRequest & { correlationId?: string }).correlationId,
    });

    void reply.setCookie(SESSION_COOKIE_NAME, issued.cookie, issued.cookieAttributes);
    return {
      actor: {
        actorId: issued.actorRef.actorId,
        displayName: issued.actorRef.actorId,
        roles: issued.actorRef.roles,
      },
      sessionId: issued.session.id,
      authenticatedAt: issued.session.authenticatedAt,
      expiresAt: issued.session.expiresAt,
      authenticationMethods: issued.session.authenticationMethods,
      stepUpMaxAgeSeconds: platform.config.stepUpMaxAgeSeconds,
      // Not decoration: this session was opened by a provider that checked
      // nothing, and the response says so wherever it is read.
      warning:
        "Signed in through the development identity provider, which authenticates nobody. Any caller may claim any subject and any directory group.",
    };
  });

  app.post("/api/session/step-up", async (request) => {
    const { runtime, provider } = requireDevelopmentSignIn();
    const resolved = identityOf(request);
    if (resolved.failure !== undefined) throw resolved.failure;
    if (!resolved.session) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        "There is no session to step up. Sign in first: a step-up moves an existing session's authentication instant forward, it does not create one.",
        {},
      );
    }

    // The subject is presented again rather than read back from the actor
    // record, which holds only a digest of it. `stepUp` recomputes that digest
    // and refuses a mismatch, so one person's re-authentication cannot step up
    // somebody else's session.
    const { subject } = readSubject({ ...(request.body as object), groups: [] });
    const stepped = await runtime.sessions.stepUp({
      sessionId: resolved.session.session.id,
      identity: provider.authenticate({ subject, groups: [] }),
      correlationId: (request as FastifyRequest & { correlationId?: string }).correlationId,
    });

    return {
      actor: {
        actorId: stepped.actorRef.actorId,
        displayName: stepped.actorRef.actorId,
        roles: stepped.actorRef.roles,
      },
      authenticatedAt: stepped.session.authenticatedAt,
      // Observed, not asserted: computed from the stamp that was just written.
      secondsSinceAuthentication: stepped.secondsSinceAuthentication,
      stepUpMaxAgeSeconds: platform.config.stepUpMaxAgeSeconds,
      authenticationMethods: stepped.session.authenticationMethods,
    };
  });

  app.post("/api/session/sign-out", async (request, reply) => {
    const resolved = identityOf(request);
    // A sign-out never refuses on a bad cookie. Whoever is holding one wants it
    // to stop working, and that is the outcome either way.
    if (identity && resolved.session) {
      await identity.sessions.revoke(resolved.session.session.id, "signed_out");
    }
    if (identity) void reply.header("set-cookie", identity.sessions.clearedCookie());
    return { signedOut: true };
  });

  // -------------------------------------------------------------------------
  // Work queue and runs
  // -------------------------------------------------------------------------

  // Every filter the work queue offers is a query parameter, because §3.1 of
  // the design specification requires a filtered view to survive being pasted
  // into a ticket. An unknown value is refused rather than ignored: silently
  // widening a result set answers a different question from the one the URL
  // says was asked, and the reader has no way to notice.
  app.get("/api/runs", async (request) =>
    authorized(request, "record.read_run", async () => {
      const filter = parseWorkQueueQuery(
        request.query as Record<string, string | string[] | undefined>,
      );
      return workQueuePage(platform, filter, actorFor(request));
    }),
  );

  app.get("/api/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    return authorized(request, "record.read_run", async () => {
      const run = await platform.runs.getRun(asRunId(runId));
      if (!run) {
        void reply.status(404);
        return { error: "not_found", message: `No run ${runId}.` };
      }
      const timeline = await runTimeline(platform, run);

      return {
        runId: run.id,
        kind: run.kind,
        title: describeRun(run.kind, run.subject),
        status: run.status,
        mode: run.mode,
        requestedBy: {
          actorId: run.requestedBy.actorId,
          displayName: run.requestedBy.actorId,
          roles: run.requestedBy.roles,
        },
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        elapsedMs: timeline.elapsedMs,
        outcome: run.outcome,
        denialReason: run.denialReason,
        steps: timeline.steps,
        totalCostUsd: timeline.totalCostUsd,
        // Spend recorded against no step, so the screen can account for the
        // header from the rows it is showing rather than presenting a total
        // with no derivation. Non-zero only for external work, which reports
        // its costs after the fact and may attribute only part of them.
        unattributedCostUsd: timeline.unattributedCostUsd,
        costByCategory: timeline.costByCategory,
        workflowInstanceId: run.workflowInstanceId,
        roleId: run.roleId,
        roleVersion: run.roleVersion,
        citations: timeline.citations,
      };
    });
  });

  // -------------------------------------------------------------------------
  // "Correct this" — a step's output, disagreed with by a person
  // -------------------------------------------------------------------------
  //
  // The console's correction control lands here, and this route deliberately
  // reaches exactly one stage of the improvement loop: harvest. A correction
  // becomes an observation tied to the run that produced it, and stops there.
  //
  // Nothing on this path can change the platform's behaviour. Clustering,
  // proposing, evaluating, approving, and applying are separate stages behind
  // a human approval that no configuration removes (ADR 0011), and none of
  // them is reachable from a browser. That separation is why a correction can
  // be a one-click control at all: if this button could alter behaviour, it
  // would need an approval of its own, and nobody would press it.

  app.post("/api/runs/:runId/steps/:stepId/corrections", async (request) => {
    const { runId, stepId } = request.params as { runId: string; stepId: string };
    const body = request.body as
      | {
          signature?: string;
          note?: string;
          correctionMinutes?: number;
          before?: string;
          after?: string;
        }
      | undefined;

    if (!body?.signature) {
      throw new InvalidInputError(
        "A correction needs a failure signature — the machine-readable name of what went wrong, e.g. \"deadline.wrong_jurisdiction\". Clustering groups on it, so free text produces one cluster per typist and nothing ever recurs.",
        "signature",
      );
    }
    if (!body.note) {
      throw new InvalidInputError(
        "A correction needs a one-line note. It is what the person triaging the cluster reads.",
        "note",
      );
    }

    const actor = actorFor(request);
    const header = request.headers["idempotency-key"];
    const result = await platform.observations.correction({
      runId: asRunId(runId),
      stepId: stepId as Id<"step">,
      signature: body.signature,
      note: body.note,
      observedBy: actor,
      mode: "supervised",
      correctionMinutes: body.correctionMinutes,
      before: body.before,
      after: body.after,
      ...(typeof header === "string" && header.length > 0 ? { idempotencyKey: header } : {}),
      correlationId: (request as FastifyRequest & { correlationId?: string }).correlationId,
    });

    return {
      observationId: result.observation.id,
      recorded: result.recorded,
      signature: result.observation.signature,
      recordedAt: result.observation.recordedAt,
      effect: result.recorded
        ? "Recorded against this run as improvement signal. It changes nothing on its own: a change to how the platform behaves needs a proposal, a measured evaluation, and a human approval."
        : "An identical correction was already recorded, so this one was not counted twice. Frequency decides which failure gets attention, and a retry must not inflate it.",
    };
  });

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  app.get("/api/approvals", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return authorized(request, "record.read_run", async () => {
      const actor = actorFor(request);
      const approvals = await platform.approvals.list({
        status: query.status ? (query.status.split(",") as never) : (["pending"] as never),
        limit: 100,
      });

      // Queue rows, not full decision context. The evidence, the artifact
      // preview, and the prior-decision lookback are per-approval reads, and
      // running them for a hundred rows nobody has opened would make the queue
      // slow in exact proportion to how carefully the detail screen was built.
      return {
        items: approvals.map((approval) => approvalQueueRow(approval, actor, platform)),
        total: approvals.length,
        limit: 100,
        offset: 0,
      };
    });
  });

  app.get("/api/approvals/:approvalId", async (request, reply) =>
    authorized(request, "record.read_run", async () => {
      const { approvalId } = request.params as { approvalId: string };
      const approval = await platform.approvals.get(approvalId as Id<"approval">);
      if (!approval) {
        void reply.status(404);
        return { error: "not_found", message: `No approval ${approvalId}.` };
      }
      return approvalDetail(approval, actorFor(request), platform, decisionContext);
    }),
  );

  app.post("/api/approvals/:approvalId/decisions", async (request) => {
    const { approvalId } = request.params as { approvalId: string };
    const body = request.body as { decision?: string; note?: string } | undefined;
    const decision = body?.decision;
    if (decision !== "granted" && decision !== "rejected") {
      throw new InvalidInputError("decision must be 'granted' or 'rejected'", "decision");
    }

    const actor = actorFor(request);
    const approval = await platform.approvals.get(approvalId as Id<"approval">);
    if (!approval) throw new InvalidInputError(`No approval ${approvalId}`, "approvalId");
    const descriptor = platform.registry.get(approval.action);

    const updated = await platform.approvals.decide({
      approvalId: approvalId as Id<"approval">,
      actor,
      decision,
      note: body?.note,
      // Closed when the action is not in the registry at all.
      //
      // Every registered action states this in `actions.ts`, so the fallback is
      // reached only by an approval raised for something the registry does not
      // know about — which is a deployment holding an approval for an effect
      // nobody classified. That is exactly the case to refuse hardest.
      requiresStepUp: descriptor?.requiresStepUp ?? true,
      // Whatever the session actually says, and `undefined` when nothing does.
      //
      // This was the literal `0`, which made `0 <= stepUpMaxAgeSeconds` true on
      // every call: the step-up requirement that `actions.ts` declares for
      // every high-consequence action could not fail on the only approval path
      // a person can reach. The bypass is the smaller half. The larger half is
      // that `steppedUp: true` was then written into the `approval.granted`
      // audit entry and onto the stored decision — the governance record
      // asserting a control was satisfied when nothing had observed it, which
      // in a product whose whole claim is that the record is true is the worst
      // class of defect there is.
      //
      // It then became an unconditional `undefined`, which failed closed and
      // could do nothing else: no session was ever resolved, so no grant of a
      // step-up action could succeed on any deployment. Now it is the age of
      // the session this caller presented — observed, and absent when there is
      // no session to observe.
      secondsSinceAuthentication: secondsSinceAuthenticationFor(request),
      stepUpMaxAgeSeconds: platform.config.stepUpMaxAgeSeconds,
    });

    // A rejection is a disagreement with what the platform proposed, and the
    // improvement loop learns from exactly those. It is recorded on a best
    // effort: the decision has already landed and been audited, and failing
    // the operator's request because a signal could not be filed would undo a
    // decision that was correctly made.
    if (decision === "rejected" && approval.runId) {
      try {
        await platform.observations.rejectedProposal({
          runId: approval.runId,
          signature: rejectionSignature(approval.action),
          note: body?.note ?? `Approval for ${approval.action} was rejected without a note.`,
          observedBy: actor,
          mode: "supervised",
          subject: { approvalId: approval.id, action: approval.action },
        });
      } catch (error) {
        platform.logger.warn("could not record a rejection as improvement signal", {
          approvalId: approval.id,
          error,
        });
      }
    }

    return approvalDetail(updated, actor, platform, decisionContext);
  });

  // -------------------------------------------------------------------------
  // Audit and evidence
  // -------------------------------------------------------------------------

  app.get("/api/audit", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return authorized(request, "audit.read", async () => {
      const limit = Math.min(Number(query.limit ?? 100) || 100, 500);
      // `subject=key:value,key:value` — an evidence view is nearly always
      // scoped to one contract or association, and without this the reviewer
      // has to page through everything and filter by eye.
      const subject: Record<string, string> = {};
      for (const pair of (query.subject ?? "").split(",")) {
        const separator = pair.indexOf(":");
        if (separator <= 0) continue;
        const key = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (key && value) subject[key] = value;
      }

      const entries = await platform.audit.list({
        eventType: query.eventType ? (query.eventType.split(",") as never) : undefined,
        runId: query.runId as never,
        actorId: query.actorId,
        recordedAfter: query.after,
        recordedBefore: query.before,
        subject: Object.keys(subject).length > 0 ? subject : undefined,
        limit,
      });
      return {
        items: entries.map((entry) => ({
          entryId: entry.id,
          seq: entry.seq,
          eventType: entry.eventType,
          recordedAt: entry.recordedAt,
          actor: {
            actorId: entry.actor.actorId,
            displayName: entry.actor.actorId,
            roles: entry.actor.roles,
          },
          runId: entry.runId,
          subject: entry.subject,
          decision: entry.decision,
          inputDigests: entry.inputDigests,
          entryHash: entry.entryHash,
          previousHash: entry.previousHash,
        })),
        total: entries.length,
        limit,
        offset: 0,
      };
    });
  });

  app.get("/api/audit/verification", async (request) => {
    return authorized(request, "audit.read", async () => {
      const chain = await platform.audit.readChain();
      const result = verifyChain(chain, undefined, await platform.audit.watermark());
      return { ...result, verifiedAt: platform.clock.nowIso() };
    });
  });

  // -------------------------------------------------------------------------
  // Containment
  // -------------------------------------------------------------------------

  app.get("/api/containment", async (request) =>
    authorized(request, "record.read_run", async () => {
      const switches = await platform.containment.list();
      return { items: switches, total: switches.length, limit: 100, offset: 0 };
    }),
  );

  app.post("/api/containment", async (request) => {
    const body = request.body as
      | { scope?: string; target?: string; engaged?: boolean; reason?: string }
      | undefined;
    const scope = body?.scope;
    const reason = body?.reason;

    if (!scope || !["global", "workflow", "role", "integration"].includes(scope)) {
      throw new InvalidInputError("scope must be global, workflow, role, or integration", "scope");
    }
    // A reason is mandatory. An unexplained pause is nearly as disruptive to
    // the next operator as the incident that prompted it.
    if (!reason || reason.trim().length < 3) {
      throw new InvalidInputError("A reason is required and is recorded in the audit log", "reason");
    }

    const actor = actorFor(request);
    const engaging = body?.engaged !== false;

    await platform.authorizer.authorize({
      action: engaging ? "containment.engage" : "containment.release",
      actor,
      mode: "supervised",
      subject: { scope, target: body?.target ?? "" },
    });

    const result = engaging
      ? await platform.containment.engage(scope as never, body?.target ?? "", actor.actorId, reason)
      : await platform.containment.release(
          scope as never,
          body?.target ?? "",
          actor.actorId,
          reason,
        );

    return result;
  });

  // -------------------------------------------------------------------------
  // Action registry — the platform's declared capability surface
  // -------------------------------------------------------------------------

  app.get("/api/actions", async (request) =>
    authorized(request, "record.read_run", async () => ({
      items: platform.registry.list(),
      total: platform.registry.list().length,
      limit: 500,
      offset: 0,
    })),
  );

  // -------------------------------------------------------------------------
  // The operator's view of the external-agent plane
  // -------------------------------------------------------------------------
  //
  // Session-authenticated console reads, hyphenated and plural, and
  // deliberately NOT under `/api/external` — that prefix belongs to the agents
  // themselves and carries a different authentication path entirely.
  //
  // The whole roster arrives in one page. It is bounded by the deployment's
  // seat cap, so a filtered count in the console stays honest: "2 contained"
  // means two of everything enrolled, not two of whatever page loaded.

  app.get("/api/external-agents", async (request) =>
    authorized(request, "record.read_run", async () => {
      const query = request.query as Record<string, string | undefined>;
      const limit = Math.min(Number(query.limit ?? 200) || 200, 500);
      const offset = Number(query.offset ?? 0) || 0;
      const now = platform.clock.nowIso();

      const [agents, total] = await Promise.all([
        platform.external.stores.agents.listAgents({ limit, offset }),
        platform.external.stores.agents.countAgents(),
      ]);

      const items = await Promise.all(agents.map((agent) => rosterRow(platform, agent, now)));
      return { items, total, limit, offset };
    }),
  );

  app.get("/api/external-agents/:agentId", async (request, reply) =>
    authorized(request, "record.read_run", async () => {
      const { agentId } = request.params as { agentId: string };
      const detail = await externalAgentDetail(
        platform,
        agentId as ExternalAgentId,
        platform.clock.nowIso(),
      );
      if (!detail) {
        void reply.status(404);
        return { error: "not_found", message: `No external agent is enrolled under ${agentId}.` };
      }
      return detail;
    }),
  );

  // -------------------------------------------------------------------------
  // The role registry — every job the platform has been given
  // -------------------------------------------------------------------------
  //
  // A role is a versioned, attributable, evidenced artifact. These reads let the
  // console show the registry and one role's full history; the authoring and
  // promotion paths are actions of their own, reached through the CLI and gated
  // at the chokepoint, not opened here.

  app.get("/api/roles", async (request) =>
    authorized(request, "record.read_run", async () => {
      const { limit, offset } = pageParams(request.query);
      return roleRegistryPage(platform, limit, offset);
    }),
  );

  app.get("/api/roles/:roleId/versions", async (request, reply) =>
    authorized(request, "record.read_run", async () => {
      const { roleId } = request.params as { roleId: string };
      const page = await roleVersionsPage(platform, roleId as Id<"role">);
      if (!page) {
        void reply.status(404);
        return { error: "not_found", message: `No role ${roleId}.` };
      }
      return page;
    }),
  );

  // -------------------------------------------------------------------------
  // A workflow instance, described so a supervisor can read it unaided
  // -------------------------------------------------------------------------

  app.get("/api/workflows/:instanceId", async (request, reply) =>
    authorized(request, "record.read_run", async () => {
      const { instanceId } = request.params as { instanceId: string };
      const view = await workflowInstanceView(platform, instanceId as Id<"workflowInstance">);
      if (!view) {
        void reply.status(404);
        return { error: "not_found", message: `No workflow instance ${instanceId}.` };
      }
      return view;
    }),
  );

  // -------------------------------------------------------------------------
  // The improvement loop — clusters (real) and proposals (honestly empty)
  // -------------------------------------------------------------------------
  //
  // Clusters are recomputed on demand from the corrections operators recorded;
  // they are real data. Proposals are honestly empty on a fresh deployment,
  // because the stage that drafts one is deliberately not wired to any route
  // (ADR 0011). Both are reads: nothing here changes what the platform does.

  app.get("/api/improvements/clusters", async (request) =>
    authorized(request, "record.read_run", async () => {
      const { limit, offset } = pageParams(request.query);
      return improvementClustersPage(platform, limit, offset);
    }),
  );

  app.get("/api/improvements/proposals", async (request) =>
    authorized(request, "record.read_run", async () => {
      const { limit, offset } = pageParams(request.query);
      return improvementProposalsPage(platform, limit, offset);
    }),
  );

  app.get("/api/improvements/proposals/:proposalId", async (request, reply) =>
    authorized(request, "record.read_run", async () => {
      const { proposalId } = request.params as { proposalId: string };
      const proposal = await platform.proposals.getProposal(proposalId as Id<"proposal">);
      if (!proposal) {
        void reply.status(404);
        return { error: "not_found", message: `No improvement proposal ${proposalId}.` };
      }
      return improvementProposalView(platform, proposal);
    }),
  );

  // -------------------------------------------------------------------------
  // Work discovery — empty when disabled, which is how this ships
  // -------------------------------------------------------------------------
  //
  // The feature ships disabled; the console gates the whole screen on
  // `health.discoveryEnabled`. When off, this serves an empty page honestly
  // rather than inventing employee behaviour nothing observed.

  app.get("/api/discovery/candidates", async (request) =>
    authorized(request, "record.read_run", async () => {
      const { limit, offset } = pageParams(request.query);
      return discoveryCandidatesPage(platform, limit, offset);
    }),
  );

  // -------------------------------------------------------------------------
  // The executive board — the business-value screen
  // -------------------------------------------------------------------------
  //
  // Surfaces spend, so it authorizes through `record.read_cost` rather than
  // `record.read_run`. Business figures are MVW's own reported results and say
  // so; platform figures are measured from this deployment's record and say so.
  // No business movement is credited to the platform, and no unmeasured saving
  // is shown as a number.

  app.get("/api/executive", async (request) =>
    authorized(request, "record.read_cost", async () => executiveView(platform)),
  );

  // -------------------------------------------------------------------------
  // The inbound surface for agents running outside this platform
  // -------------------------------------------------------------------------
  //
  // Registered as an encapsulated plugin under /api/external, with its own
  // authentication, its own body bounds, and its own error handler. Nothing
  // above it applies: these callers are third parties presenting agent
  // credentials, not operators holding a session. See api/external.ts.
  registerExternalRoutes(app, externalRouteDeps(platform));

  return app;
}

export async function startServer(platform: Platform): Promise<FastifyInstance> {
  const app = createServer({ platform });
  await app.listen({ port: platform.config.httpPort, host: "0.0.0.0" });
  platform.logger.info("api listening", { port: platform.config.httpPort });
  return app;
}
