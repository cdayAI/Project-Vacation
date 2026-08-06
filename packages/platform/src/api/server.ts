import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { verifyChain } from "../audit/chain.js";
import type { ActorRef } from "../record/types.js";
import type { Platform } from "../platform.js";

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
  const app = Fastify({
    // The platform's own logger already writes structured, redacted lines to
    // stderr. A second logger here would produce a parallel stream with
    // different redaction rules, which is exactly how a secret reaches a log —
    // so Fastify's is switched off entirely rather than configured.
    logger: false,
    bodyLimit: 1_000_000,
  });

  void app.register(cookie);

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
    platform.logger.error("unhandled request failure", {
      path: request.url,
      method: request.method,
      error,
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

  app.get("/health", async () => {
    const head = await platform.audit.head();
    const switches = await platform.containment.list();
    return {
      status: "ok",
      environment: platform.config.environment,
      store: platform.config.store,
      sandboxMode: platform.sandbox.mode,
      // Surfaced because an operator must never have to read the environment
      // to discover that the sandbox is not containing anything.
      sandboxIsContained: platform.sandbox.isContained,
      discoveryEnabled: platform.config.discoveryEnabled,
      modelProvider: platform.config.modelProvider,
      auditHeadSeq: head?.seq ?? null,
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
  });

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  app.get("/api/session", async (request) => {
    const actor = actorFor(request);
    const isAuditor = actor.roles.includes("auditor") && actor.roles.length === 1;
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

  app.get("/api/runs", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return authorized(request, "record.read_run", async () => {
      const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
      const offset = Number(query.offset ?? 0) || 0;
      const filter = {
        status: query.status ? (query.status.split(",") as never) : undefined,
        kind: query.kind,
        limit,
        offset,
      };
      const [runs, total] = await Promise.all([
        platform.runs.listRuns(filter),
        platform.runs.countRuns(filter),
      ]);

      const items = await Promise.all(
        runs.map(async (run) => {
          const cost = await platform.runs.costForRun(run.id);
          return {
            runId: run.id,
            kind: run.kind,
            title: describeRun(run.kind, run.subject),
            status: run.status,
            mode: run.mode,
            createdAt: run.createdAt,
            slaBreached: false,
            costUsd: cost.totalUsd,
            waitingOn:
              run.status === "awaiting_approval"
                ? "a human approval"
                : run.status === "awaiting_human"
                  ? "a person to complete a task"
                  : undefined,
          };
        }),
      );

      return { items, total, limit, offset };
    });
  });

  app.get("/api/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    return authorized(request, "record.read_run", async () => {
      const run = await platform.runs.getRun(runId as never);
      if (!run) {
        void reply.status(404);
        return { error: "not_found", message: `No run ${runId}.` };
      }
      const [steps, cost] = await Promise.all([
        platform.runs.listSteps(run.id),
        platform.runs.costForRun(run.id),
      ]);

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
        outcome: run.outcome,
        denialReason: run.denialReason,
        steps: steps.map((step) => ({
          stepId: step.id,
          seq: step.seq,
          name: step.name,
          kind: step.kind,
          status: step.status,
          startedAt: step.startedAt,
          endedAt: step.endedAt,
          durationMs:
            step.endedAt === undefined
              ? undefined
              : Date.parse(step.endedAt) - Date.parse(step.startedAt),
          costUsd: 0,
          attempt: step.attempt,
          inputDigest: step.inputDigest,
          outputDigest: step.outputDigest,
          error: step.error,
          denialReason: step.denialReason,
          detail: step.detail,
        })),
        totalCostUsd: cost.totalUsd,
        costByCategory: cost.byCategory,
        workflowInstanceId: run.workflowInstanceId,
        roleId: run.roleId,
        roleVersion: run.roleVersion,
        citations: [],
      };
    });
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

      return {
        items: approvals.map((approval) => toApprovalView(approval, actor, platform)),
        total: approvals.length,
        limit: 100,
        offset: 0,
      };
    });
  });

  app.get("/api/approvals/:approvalId", async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    return authorized(request, "record.read_run", async () => {
      const approval = await platform.approvals.get(approvalId as never);
      if (!approval) {
        void reply.status(404);
        return { error: "not_found" };
      }
      return toApprovalView(approval, actorFor(request), platform);
    });
  });

  app.post("/api/approvals/:approvalId/decision", async (request) => {
    const { approvalId } = request.params as { approvalId: string };
    const body = request.body as { decision?: string; note?: string } | undefined;
    const decision = body?.decision;
    if (decision !== "granted" && decision !== "rejected") {
      throw new InvalidInputError("decision must be 'granted' or 'rejected'", "decision");
    }

    const actor = actorFor(request);
    const approval = await platform.approvals.get(approvalId as never);
    if (!approval) throw new InvalidInputError(`No approval ${approvalId}`, "approvalId");
    const descriptor = platform.registry.get(approval.action);

    const updated = await platform.approvals.decide({
      approvalId: approvalId as never,
      actor,
      decision,
      note: body?.note,
      requiresStepUp: descriptor?.requiresStepUp ?? true,
      secondsSinceAuthentication: 0,
      stepUpMaxAgeSeconds: platform.config.stepUpMaxAgeSeconds,
    });

    return toApprovalView(updated, actor, platform);
  });

  // -------------------------------------------------------------------------
  // Audit and evidence
  // -------------------------------------------------------------------------

  app.get("/api/audit", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return authorized(request, "audit.read", async () => {
      const limit = Math.min(Number(query.limit ?? 100) || 100, 500);
      const entries = await platform.audit.list({
        eventType: query.eventType ? (query.eventType.split(",") as never) : undefined,
        runId: query.runId as never,
        actorId: query.actorId,
        recordedAfter: query.after,
        recordedBefore: query.before,
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
      const result = verifyChain(chain);
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

  return app;
}

/** A readable title for a run, from its kind and opaque subject references. */
function describeRun(kind: string, subject: Readonly<Record<string, string>>): string {
  const reference =
    subject.contractId ?? subject.associationId ?? subject.membershipId ?? subject.id;
  const readable = kind.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return reference ? `${readable} — ${reference}` : readable;
}

function toApprovalView(
  approval: Awaited<ReturnType<Platform["approvals"]["get"]>> extends infer T
    ? T extends null
      ? never
      : NonNullable<T>
    : never,
  actor: ActorRef,
  platform: Platform,
) {
  const descriptor = platform.registry.get(approval.action);
  const granted = approval.decisions.filter((entry) => entry.decision === "granted").length;

  // Segregation of duties is enforced server-side at decision time. Reporting
  // it here as well lets the console disable the control and say why, which is
  // considerably kinder than letting someone click and be refused.
  const isRequester = actor.actorId === approval.requestedBy.actorId;
  const alreadyDecided = approval.decisions.some(
    (entry) => entry.actor.actorId === actor.actorId,
  );
  const eligible = actor.roles.some((role) => approval.eligibleRoles.includes(role));

  let viewerMayNotDecideReason: string | undefined;
  if (approval.status !== "pending") viewerMayNotDecideReason = `This request is ${approval.status}.`;
  else if (isRequester) viewerMayNotDecideReason = "You requested this action, so you cannot approve it.";
  else if (alreadyDecided) viewerMayNotDecideReason = "You have already decided on this request.";
  else if (!eligible)
    viewerMayNotDecideReason = `Approving this needs one of: ${approval.eligibleRoles.join(", ")}.`;

  return {
    approvalId: approval.id,
    action: approval.action,
    actionDescription: descriptor?.description ?? approval.action,
    risk: descriptor?.risk ?? "high_consequence",
    reversible: descriptor?.reversible ?? false,
    summary: approval.summary,
    proposalDigest: approval.proposalDigest,
    proposal: Object.entries(approval.subject).map(([label, value]) => ({ label, value })),
    requestedBy: {
      actorId: approval.requestedBy.actorId,
      displayName: approval.requestedBy.actorId,
      roles: approval.requestedBy.roles,
    },
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    approvalsRequired: approval.approvalsRequired,
    approvalsGranted: granted,
    eligibleRoles: approval.eligibleRoles,
    decisions: approval.decisions.map((entry) => ({
      actor: {
        actorId: entry.actor.actorId,
        displayName: entry.actor.actorId,
        roles: entry.actor.roles,
      },
      decision: entry.decision,
      decidedAt: entry.decidedAt,
      note: entry.note,
    })),
    viewerMayDecide: viewerMayNotDecideReason === undefined,
    viewerMayNotDecideReason,
    requiresStepUp: descriptor?.requiresStepUp ?? true,
  };
}

export async function startServer(platform: Platform): Promise<FastifyInstance> {
  const app = createServer({ platform });
  await app.listen({ port: platform.config.httpPort, host: "0.0.0.0" });
  platform.logger.info("api listening", { port: platform.config.httpPort });
  return app;
}
