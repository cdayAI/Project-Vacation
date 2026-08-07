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
import type { Id } from "../kernel/ids.js";

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

function denialBody(error: DeniedError) {
  return {
    denied: true as const,
    reason: error.reason,
    message: error.message,
    detail: error.detail,
  };
}

export function createServer(options: ServerOptions): FastifyInstance {
  const { platform } = options;
  const decisionContext = options.decisionContext ?? {};
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

  function actorFor(request: FastifyRequest): ActorRef {
    if (platform.config.oidcIssuer) {
      // Session resolution against the identity provider is handled by the
      // identity module; until a session cookie is present this refuses rather
      // than falling back to the development actor.
      const session = request.cookies?.pv_session;
      if (!session) {
        throw new DeniedError(
          "authorization.action_not_permitted",
          "No authenticated session. Sign in through the identity provider.",
          {},
        );
      }
      throw new DeniedError(
        "authorization.action_not_permitted",
        "Session verification against the configured identity provider is not wired into this route yet.",
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
      secondsSinceAuthentication: 0,
      // A rendering hint for the console. The server re-checks every action.
      capabilities: platform.registry
        .list()
        .filter((descriptor) =>
          actor.roles.some((role) => descriptor.allowedRoles.includes(role)),
        )
        .map((descriptor) => descriptor.name),
      readOnly: isAuditor,
    };
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
      requiresStepUp: descriptor?.requiresStepUp ?? true,
      secondsSinceAuthentication: 0,
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
          signature: signatureForAction(approval.action),
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

/**
 * The failure signature a rejection is filed under.
 *
 * Derived from the action name so it stays inside the controlled vocabulary
 * the harvester enforces — dotted lower_snake_case — and so every rejection of
 * the same action clusters together. A free-text signature would produce one
 * cluster per approver and nothing would ever recur.
 */
function signatureForAction(action: string): string {
  const normalised = action.replace(/[^a-z0-9_.]/gi, "_").toLowerCase();
  return `approval.rejected.${normalised}`.slice(0, 96);
}

export async function startServer(platform: Platform): Promise<FastifyInstance> {
  const app = createServer({ platform });
  await app.listen({ port: platform.config.httpPort, host: "0.0.0.0" });
  platform.logger.info("api listening", { port: platform.config.httpPort });
  return app;
}
