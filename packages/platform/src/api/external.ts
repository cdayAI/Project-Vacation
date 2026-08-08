import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DeniedError, InvalidInputError, type DenialReason } from "../kernel/errors.js";
import { digestBytes, type Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { Logger } from "../kernel/logger.js";
import type { ApprovalService } from "../guard/approvals.js";
import type { ExternalPlane } from "../external/plane.js";
import type { RateLimiterLike } from "../external/ratelimit-port.js";
import type {
  AdmissionDecision,
  AdmissionOperation,
  ExternalAgentId,
  PresentedCredential,
  VerifiedIdentity,
} from "../external/types.js";
import type { Platform } from "../platform.js";

/**
 * The inbound surface for agents MVW runs somewhere else.
 *
 * This is the only door into the governance plane from outside, and it is a
 * published contract a vendor reads (docs/external-agents/openapi.yaml). Five
 * rules shape every handler below, and each one closes a specific failure.
 *
 * **There is no anonymous access.** Every route authenticates first, through
 * `CredentialService.verify`, and the agent identity used from that point is
 * the *verified* one. A body may carry `agentId`, and if it disagrees with the
 * verified identity the request is refused rather than quietly corrected —
 * silently preferring the credential would hide a client bug that is
 * indistinguishable from an impersonation attempt.
 *
 * **Bound before screening, and refuse rather than truncate.** The body limit,
 * the string lengths, the array counts, and the depth and key count of the
 * free-form execute payload are all enforced here, before anything is screened
 * or stored. One unbounded field is enough: an attacker pads it until the part
 * that matters sits past whatever window a downstream scan looks at, and the
 * scan reports clean on text it never read. Oversized bodies are rejected with
 * 413, never trimmed, for the same reason.
 *
 * **A denial is an answer, not a failure.** Refusals reach the client as HTTP
 * 409 with a structured body, matching the rest of the API. They are not 500s:
 * a 500 says "we broke" and invites a retry, and a denial says "we declined,
 * here is why".
 *
 * **The reply says what to do next, in the status code as well as the body.**
 * `approval_required` comes back as 202 rather than 200, because a vendor's
 * HTTP client that checks only `response.ok` would otherwise treat "a human has
 * to decide this first" as permission to proceed. An `indeterminate` execution
 * comes back as 200 rather than a 5xx for the mirror-image reason: every proxy
 * and client library in existence retries a 5xx, and retrying an action that
 * may already have taken effect is a duplicate consumer-facing effect.
 *
 * **What comes back is minimised.** These callers are third parties. The
 * operator-facing detail on a denial — which check failed, whether an agent
 * exists, whether a credential is expired or merely wrong — stays in the audit
 * record. Returning it would turn this endpoint into an oracle for enumerating
 * enrolled agents and probing credential state.
 *
 * Where the admission chain runs, and where it deliberately does not, is set
 * out at each route.
 */

// ---------------------------------------------------------------------------
// What the composition root supplies
// ---------------------------------------------------------------------------

/**
 * What this surface reads from the composition root.
 *
 * Structural rather than `Platform` itself, so the routes can be exercised
 * against a hand-built plane in a test without standing up a whole platform —
 * and so that this module cannot quietly grow a dependency on something else
 * `Platform` happens to carry.
 */
export interface ExternalRouteDeps {
  /** The assembled plane. Always present; `enabled` decides whether it answers. */
  readonly external: ExternalPlane;
  /** Read-only here: an agent polls an approval, it never decides one. */
  readonly approvals: ApprovalService;
  readonly logger?: Logger | undefined;
}

export interface ExternalRouteOptions {
  /** Defaults to `/api/external`. */
  readonly prefix?: string;
}

/** `Platform` satisfies the dependencies structurally; this states it. */
export function externalRouteDeps(platform: Platform): ExternalRouteDeps {
  return {
    external: platform.external,
    approvals: platform.approvals,
    logger: platform.logger,
  };
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Every bound this surface applies, in one table.
 *
 * Each is at or below the bound the service behind it applies, so the API
 * refuses first with a message naming the field. The services still bound
 * independently: a limit enforced only at the HTTP edge is a limit the CLI and
 * every future entry point walk straight past.
 */
const MAX = {
  /** The whole request body. Sized for the largest legitimate payload — a
   *  500-step run report — and nothing beyond it. */
  bodyBytes: 256 * 1024,
  tool: 128,
  untrustedInput: 20_000,
  subjectKeys: 16,
  subjectKeyLength: 64,
  subjectValue: 256,
  scopes: 16,
  scopeLength: 64,
  correlationId: 128,
  goal: 2_000,
  summary: 4_000,
  steps: 500,
  stepName: 200,
  idempotencyKey: 200,
  detailKeys: 24,
  detailKeyLength: 64,
  detailValue: 512,
  costUsd: 10_000,
  identifier: 128,
  timestamp: 64,
  /** The free-form execute payload: size, breadth, and depth all bounded. */
  requestBytes: 32 * 1024,
  requestKeys: 128,
  requestDepth: 8,
  requestArrayItems: 256,
  requestStringLength: 8_192,
} as const;

/** Bounds on headers, applied before a header is read for any purpose. */
const HEADER_MAX = {
  authorization: 8_256,
  token: 8_192,
  agentId: 128,
  timestamp: 64,
  nonce: 128,
  signature: 4_096,
  digest: 128,
  kind: 16,
} as const;

/**
 * Detail keys safe to hand back to a third party.
 *
 * An allowlist rather than a denylist. A denylist silently starts leaking the
 * first time a service adds a field to a denial's detail, and nobody reviewing
 * that change would think to come and look here.
 */
const RETURNABLE_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "externalAgentId",
  "agentId",
  "approvalId",
  "parkedActionId",
  "runId",
  "integration",
  "operation",
  "status",
  "field",
  "used",
  "limit",
  "contained",
  "denialsInWindow",
  "scope",
]);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CONNECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const toolName = z
  .string()
  .min(1)
  .max(MAX.tool)
  .regex(TOOL_PATTERN, "A tool name is letters, digits, dot, underscore, colon, slash, or hyphen.");

const riskTier = z.enum(["routine", "sensitive", "high_consequence", "prohibited"]);

const money = (max: number) => z.number().finite().nonnegative().max(max);

const timestamp = z.string().min(1).max(MAX.timestamp);

const identifier = z.string().min(1).max(MAX.identifier);

const correlationId = z.string().min(1).max(MAX.correlationId);

/**
 * Opaque references saying what a piece of work was about.
 *
 * Key count and value length are both bounded: bounding only the values leaves
 * the count carrying the payload instead, and ten thousand legal keys is a
 * megabyte assembled entirely out of fields that individually pass.
 */
const subjectMap = z
  .record(z.string().min(1).max(MAX.subjectKeyLength), z.string().max(MAX.subjectValue))
  .refine((value) => Object.keys(value).length <= MAX.subjectKeys, {
    message: `subject may carry at most ${MAX.subjectKeys} keys.`,
  });

const detailMap = z
  .record(
    z.string().min(1).max(MAX.detailKeyLength),
    z.union([z.string().max(MAX.detailValue), z.number().finite(), z.boolean()]),
  )
  .refine((value) => Object.keys(value).length <= MAX.detailKeys, {
    message: `detail may carry at most ${MAX.detailKeys} keys.`,
  });

/**
 * `.strict()` on every body.
 *
 * An unrecognised field is either a client that has drifted from the contract
 * or an attempt to smuggle something past a schema that shrugs. Both deserve a
 * 400 that names the field rather than a silent drop.
 */
const screenBody = z
  .object({
    agentId: identifier.optional(),
    tool: toolName,
    declaredRisk: riskTier.default("routine"),
    estimatedCostUsd: money(MAX.costUsd).optional(),
    untrustedInput: z.string().max(MAX.untrustedInput).optional(),
    subject: subjectMap.optional(),
    requiredScopes: z.array(z.string().min(1).max(MAX.scopeLength)).max(MAX.scopes).optional(),
    correlationId: correlationId.optional(),
  })
  .strict();

const reportedStep = z
  .object({
    name: z.string().min(1).max(MAX.stepName),
    tool: toolName.optional(),
    startedAt: timestamp,
    endedAt: timestamp.optional(),
    outcome: z.enum(["succeeded", "failed", "skipped"]),
    costUsd: money(MAX.costUsd).optional(),
    detail: detailMap.optional(),
  })
  .strict();

const reportBody = z
  .object({
    agentId: identifier.optional(),
    tool: toolName,
    idempotencyKey: z.string().min(1).max(MAX.idempotencyKey),
    goal: z.string().min(1).max(MAX.goal),
    startedAt: timestamp,
    endedAt: timestamp,
    outcome: z.enum(["succeeded", "failed", "denied"]),
    summary: z.string().max(MAX.summary).optional(),
    steps: z.array(reportedStep).max(MAX.steps),
    costUsd: money(MAX.costUsd),
    subject: subjectMap.optional(),
    correlationId: correlationId.optional(),
  })
  .strict();

const startRunBody = z
  .object({
    agentId: identifier.optional(),
    tool: toolName,
    declaredRisk: riskTier.default("routine"),
    goal: z.string().min(1).max(MAX.goal),
    estimatedCostUsd: money(MAX.costUsd).optional(),
    subject: subjectMap.optional(),
    correlationId: correlationId.optional(),
  })
  .strict();

const heartbeatBody = z
  .object({ agentId: identifier.optional() })
  .strict()
  .default({});

const finishRunBody = z
  .object({
    agentId: identifier.optional(),
    outcome: z.enum(["succeeded", "failed"]),
    summary: z.string().max(MAX.summary).optional(),
    costUsd: money(MAX.costUsd),
  })
  .strict();

const executeBody = z
  .object({
    agentId: identifier.optional(),
    integration: z.string().min(1).max(MAX.identifier).regex(CONNECTOR_PATTERN),
    operation: z.string().min(1).max(MAX.identifier).regex(CONNECTOR_PATTERN),
    mode: z.enum(["read", "write"]),
    request: z.record(z.string().max(MAX.identifier), z.unknown()),
    parkedActionId: identifier.optional(),
    correlationId: correlationId.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Mount the external-agent surface.
 *
 * Registered as an encapsulated Fastify plugin so its content-type parser and
 * its error handler apply here and nowhere else. The parser keeps the raw body
 * — a signed request's signature covers a digest of exactly the bytes that
 * arrived, and re-serialising a parsed object would sign different ones.
 */
export function registerExternalRoutes(
  app: FastifyInstance,
  deps: ExternalRouteDeps,
  options: ExternalRouteOptions = {},
): void {
  const plane = deps.external;

  void app.register(
    async (scope: FastifyInstance) => {
      const rawBodies = new WeakMap<FastifyRequest, string>();

      /**
       * Refuse everything when the plane is switched off.
       *
       * The routes are registered either way, and refuse with a reason rather
       * than 404ing. A deployment that has not turned this on should be told
       * so plainly: a 404 reads as a typo in the URL, and the vendor's next
       * move is to try three more spellings before anybody asks an operator.
       *
       * It runs before authentication, because when the plane is off there is
       * nothing to authenticate against and no reason to touch the credential
       * store on an unauthenticated request.
       */
      scope.addHook("onRequest", async () => {
        if (!plane.enabled) {
          throw new DeniedError(
            "config.missing",
            "The external-agent plane is not enabled in this deployment. Nothing was done.",
            {},
          );
        }
      });

      scope.addContentTypeParser(
        "application/json",
        { parseAs: "string", bodyLimit: MAX.bodyBytes },
        (request: FastifyRequest, body: string | Buffer, done) => {
          const raw = typeof body === "string" ? body : body.toString("utf8");
          rawBodies.set(request, raw);
          if (raw.trim().length === 0) {
            // An empty body is an empty object, not a parse error. The
            // heartbeat carries nothing, and a client that sends no body should
            // not have to send `{}` to satisfy a parser.
            done(null, {});
            return;
          }
          try {
            done(null, JSON.parse(raw) as unknown);
          } catch (error) {
            done(
              new InvalidInputError(
                `The request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
                "body",
              ),
            );
          }
        },
      );

      scope.setErrorHandler((error, request, reply) => {
        if (error instanceof DeniedError) {
          void reply.status(409).send(denialBody(error));
          return;
        }
        if (error instanceof InvalidInputError) {
          void reply.status(400).send({
            error: "invalid_input",
            message: error.message,
            field: error.field,
          });
          return;
        }
        if (error instanceof z.ZodError) {
          void reply.status(400).send(schemaFailureBody(error));
          return;
        }

        const status = statusCodeOf(error);
        if (status === 413) {
          // Refused whole, never trimmed: a trimmed payload is screened only in
          // part, and the part that was cut is the part the sender chose.
          void reply.status(413).send({
            error: "payload_too_large",
            message: `The request body is larger than the ${MAX.bodyBytes}-byte limit. It is refused rather than truncated, because a truncated payload is screened only in part.`,
          });
          return;
        }
        if (status >= 400 && status < 500) {
          void reply.status(status).send({
            error: "invalid_request",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        deps.logger?.error("external agent request failed", {
          path: request.url,
          method: request.method,
          error,
        });
        void reply.status(500).send({ error: "internal_error" });
      });

      /** Authenticate, and return the identity the credential actually proves. */
      async function authenticate(request: FastifyRequest): Promise<VerifiedIdentity> {
        // Digest what arrived, not what a header claims arrived. Trusting a
        // client-supplied digest would let a captured signature be replayed
        // over a substituted body.
        const bodyDigest = digestBytes(rawBodies.get(request) ?? "");
        return plane.credentials.verify(presentedCredential(request, bodyDigest));
      }

      // -----------------------------------------------------------------------
      // 1. Screen — "may I do this?", asked BEFORE acting
      // -----------------------------------------------------------------------

      scope.post("/screen", async (request, reply) => {
        const identity = await authenticate(request);
        const body = parse(screenBody, request.body);
        assertBodyAgentMatches(body.agentId, identity);

        // The full admission chain: enrolled, not revoked, not contained, not
        // expired, tool granted, operator's risk rating applied as a floor,
        // data scopes held, budget available, accompanying text screened, and
        // — above the threshold — a real approval parked for a human.
        const decision = await plane.admission.admit({
          agentId: identity.agentId,
          operation: "screen",
          tool: body.tool,
          declaredRisk: body.declaredRisk,
          estimatedCostUsd: body.estimatedCostUsd,
          untrustedInput: body.untrustedInput,
          subject: body.subject,
          requiredScopes: body.requiredScopes,
          correlationId: correlationOf(request, body.correlationId),
        });

        return respondToDecision(reply, decision, options.prefix ?? DEFAULT_PREFIX);
      });

      /**
       * Poll a parked approval.
       *
       * What comes back is deliberately thin: the status, the counts, and the
       * digest the decision binds to. Not who approved it, not their note, not
       * the subject references. The agent needs to know whether it may proceed;
       * a vendor's agent learning which employee signed off, and when, is a
       * disclosure nobody asked for and nobody would notice.
       */
      scope.get("/approvals/:approvalId", async (request, reply) => {
        const identity = await authenticate(request);
        const { approvalId } = parse(
          z.object({ approvalId: identifier }).strict(),
          request.params,
        );

        const approval = await deps.approvals.get(approvalId as Id<"approval">);

        // One answer for "no such approval" and for "not yours". Distinguishing
        // them would let an agent walk the id space and learn what other agents
        // are waiting on.
        if (!approval || approval.requestedBy.actorId !== identity.agentId) {
          void reply.status(404);
          return {
            error: "not_found",
            message: `No approval ${approvalId} is outstanding for this agent.`,
          };
        }

        return {
          approvalId: approval.id,
          action: approval.action,
          status: approval.status,
          decided: approval.status !== "pending",
          approvalsRequired: approval.approvalsRequired,
          approvalsGranted: approval.decisions.filter((entry) => entry.decision === "granted")
            .length,
          requestedAt: approval.requestedAt,
          expiresAt: approval.expiresAt,
          proposalDigest: approval.proposalDigest,
        };
      });

      // -----------------------------------------------------------------------
      // 2. Report — a COMPLETED run, ingested onto the operating record
      // -----------------------------------------------------------------------

      scope.post("/report", async (request, reply) => {
        const identity = await authenticate(request);
        const body = parse(reportBody, request.body);
        assertBodyAgentMatches(body.agentId, identity);

        const correlation = correlationOf(request, body.correlationId);

        // Admission runs on the tool the episode was performed under. An agent
        // reporting work it was never granted the tool for is refused, and the
        // refusal counts toward containment — which is the only way a report
        // that describes ungoverned work is ever noticed.
        //
        // No `estimatedCostUsd` is passed, deliberately. The chain still
        // refuses an agent that has already spent past its ceiling, but this
        // report describes money that is *already gone*: charging the estimate
        // against the ceiling here would make the report refusable precisely
        // when spend is highest, and a meter that stops counting near the limit
        // is worse than no meter.
        //
        // `deferApproval` because a report is a record of work that ALREADY
        // happened. The operator's rating floors the declaration in the chain,
        // so a report under a high-rated tool comes back `approval_required` —
        // but there is nothing to approve before-the-fact about something that
        // is already done. Left to raise, the floor parks an `external.report`
        // approval nobody can act on and refuses the report, so completed work
        // under a high-rated tool could never reach the operating record — the
        // exact opposite of the one-record promise. Deferring keeps the floor
        // from parking anything; the enrollment, revocation, containment, tool
        // grant, ceiling and scope checks all still gate the report.
        const decision = await plane.admission.admit(
          {
            agentId: identity.agentId,
            operation: "report",
            tool: body.tool,
            declaredRisk: "routine",
            subject: body.subject,
            correlationId: correlation,
          },
          { deferApproval: true },
        );
        // Only a genuine refusal stops a report. An `approval_required` here
        // means "high-rated, and already done", which lands like any other.
        if (decision.outcome === "denied") {
          assertAdmitted(decision, "report");
        }

        const ingested = await plane.reports.ingest({
          agentId: identity.agentId,
          idempotencyKey: body.idempotencyKey,
          goal: body.goal,
          startedAt: body.startedAt,
          endedAt: body.endedAt,
          outcome: body.outcome,
          summary: body.summary,
          steps: body.steps,
          costUsd: body.costUsd,
          subject: body.subject,
          correlationId: correlation,
        });

        // 200 for a replay, 201 for the first ingestion. The body says which,
        // because that is the field a client should branch on; the status code
        // is there so a log or a dashboard can see the difference without
        // parsing anything.
        void reply.status(ingested.duplicate ? 200 : 201);
        return {
          runId: ingested.runId,
          duplicate: ingested.duplicate,
          costUsd: ingested.costUsd,
          message: ingested.duplicate
            ? "This episode was already recorded under that idempotency key. The original record is returned and nothing was counted twice."
            : "Recorded on the operating record beside native work.",
        };
      });

      // -----------------------------------------------------------------------
      // 3. Live runs — and the heartbeat, which is the kill switch
      // -----------------------------------------------------------------------

      scope.post("/runs", async (request, reply) => {
        const identity = await authenticate(request);
        const body = parse(startRunBody, request.body);
        assertBodyAgentMatches(body.agentId, identity);

        const correlation = correlationOf(request, body.correlationId);

        const decision = await plane.admission.admit({
          agentId: identity.agentId,
          operation: "run.start",
          tool: body.tool,
          declaredRisk: body.declaredRisk,
          estimatedCostUsd: body.estimatedCostUsd,
          // The goal is text somebody else's system chose the contents of, and
          // it is rendered to an operator in the console. Bounded above, then
          // screened by the chain.
          untrustedInput: body.goal,
          subject: body.subject,
          correlationId: correlation,
        });

        // A run above the approval threshold is parked, not started. Starting
        // it and asking afterwards would be the approval arriving after the
        // work.
        if (decision.outcome === "approval_required") {
          return respondToDecision(reply, decision, options.prefix ?? DEFAULT_PREFIX);
        }
        assertAdmitted(decision, "run.start");

        const run = await plane.liveRuns.start({
          agentId: identity.agentId,
          goal: body.goal,
          subject: body.subject,
          correlationId: correlation,
        });

        void reply.status(201);
        return {
          externalRunId: run.id,
          runId: run.runId,
          status: run.status,
          startedAt: run.startedAt,
          heartbeat: `${options.prefix ?? DEFAULT_PREFIX}/runs/${run.id}/heartbeat`,
          message:
            "Heartbeat on the interval in the reply. The heartbeat reply is how this platform stops you; a run that goes quiet is reclaimed rather than assumed healthy.",
        };
      });

      /**
       * The kill switch.
       *
       * An external agent runs inside somebody else's CRM or cloud account. We
       * hold no handle on its process and no route to its host, so containment
       * cannot be *pushed* to it — the one instant we can reliably stop it is
       * the instant it next asks us something. That is this route, and it is
       * why the reply is a directive rather than an acknowledgement.
       *
       * `LiveRunService.heartbeat` is the authority here, not the admission
       * chain, and that is deliberate. The chain answers a containment by
       * *denying*, which on this route would deliver the stop as an HTTP error
       * into a vendor's exception handler — the one place this platform least
       * wants its kill switch to live. The service answers the same containment
       * with `directive: "stop"`, in the reply the agent is already reading, on
       * its ordinary control-flow path. The chain also cannot run here at all:
       * it checks the requested tool against the grant list, and a heartbeat
       * exercises no tool.
       *
       * The rate limit still applies, so an agent looping on this route is
       * bounded like any other caller.
       */
      scope.post("/runs/:externalRunId/heartbeat", async (request) => {
        const identity = await authenticate(request);
        const { externalRunId } = parse(
          z.object({ externalRunId: identifier }).strict(),
          request.params,
        );
        assertBodyAgentMatches(parse(heartbeatBody, request.body ?? {}).agentId, identity);

        await assertWithinRate(plane.rateLimiter, identity.agentId, "run.heartbeat");

        // Every stop condition is re-read on this call: containment,
        // revocation, expiry, an operator stopping the run, and reclamation
        // after a lapse. Nothing is cached, because a cached answer means an
        // operator's stop takes effect one cache window later.
        return plane.liveRuns.heartbeat(
          identity.agentId,
          externalRunId as Id<"externalRun">,
        );
      });

      /**
       * Close an episode and record what it cost.
       *
       * Accepted whatever the agent's status is now, which is why the admission
       * chain does not gate it. The work already happened; refusing to write
       * down how it ended because the agent has since been contained would lose
       * the outcome and the spend, leave the run open until the reclaim sweep
       * guessed at it, and punish the one thing a misbehaving agent did right.
       * The agent's status at the time is recorded in the audit entry, so an
       * operator reviewing a containment can see what arrived afterwards.
       */
      scope.post("/runs/:externalRunId/finish", async (request) => {
        const identity = await authenticate(request);
        const { externalRunId } = parse(
          z.object({ externalRunId: identifier }).strict(),
          request.params,
        );
        const body = parse(finishRunBody, request.body);
        assertBodyAgentMatches(body.agentId, identity);

        await assertWithinRate(plane.rateLimiter, identity.agentId, "run.finish");

        const finished = await plane.liveRuns.finish({
          agentId: identity.agentId,
          runId: externalRunId as Id<"externalRun">,
          outcome: body.outcome,
          summary: body.summary,
          costUsd: body.costUsd,
        });

        return {
          externalRunId: finished.id,
          runId: finished.runId,
          status: finished.status,
          endedAt: finished.endedAt,
          costUsd: finished.costUsd,
        };
      });

      // -----------------------------------------------------------------------
      // 4. Execute — the platform performs the action, so it is receipted
      // -----------------------------------------------------------------------

      /**
       * Perform an outbound action on the agent's behalf, through a governed
       * integration.
       *
       * The distinction worth the extra round trip: pre-authorising an agent
       * and letting it act is a promise, and performing the action here is a
       * receipt. The action itself passes the chokepoint, lands in the
       * operating record, and produces an audit entry — and the agent cannot
       * decline to say how it went, because it did not do it.
       *
       * Admission runs inside `ExecutionService`, not here, and that is not an
       * omission. The service runs the same chain with the operation that
       * actually applies — `execute.read`, `execute.write`, or
       * `execute.commit` — and with approval deferred so the parked record
       * exists before the approval is raised against its digest. Running the
       * chain here as well would park a second approval for every write: an
       * approver would see the same action twice with no way to tell which one
       * mattered, and would spend a decision on the one that could never be
       * committed.
       */
      scope.post("/execute", async (request, reply) => {
        const identity = await authenticate(request);
        const body = parse(executeBody, request.body);
        assertBodyAgentMatches(body.agentId, identity);

        // The one free-form field on this surface. Bounded for size, breadth,
        // and depth before it goes anywhere near a digest or a preview.
        assertBoundedPayload("request", body.request);

        const outcome = await plane.execution.execute({
          agentId: identity.agentId,
          integration: body.integration,
          operation: body.operation,
          mode: body.mode,
          request: body.request,
          parkedActionId: body.parkedActionId as Id<"parkedAction"> | undefined,
          correlationId: correlationOf(request, body.correlationId),
        });

        switch (outcome.kind) {
          case "completed":
            return { outcome: "completed", result: outcome.result, runId: outcome.runId };

          case "approval_required":
            // 202: something was created and nothing has happened yet. A client
            // checking only `response.ok` still sees a code it did not expect.
            void reply.status(202);
            return {
              outcome: "approval_required",
              parkedActionId: outcome.parkedActionId,
              approvalId: outcome.approvalId,
              preview: outcome.preview,
              poll: `${options.prefix ?? DEFAULT_PREFIX}/approvals/${outcome.approvalId}`,
              message:
                "A human must approve this write. Once the approval is granted, re-send the byte-identical request with parkedActionId to commit it. Any difference between what was approved and what is committed voids the action.",
            };

          case "already_done":
            return {
              outcome: "already_done",
              parkedActionId: outcome.parkedActionId,
              resultSummary: outcome.resultSummary,
              message:
                "This action was already committed. The original outcome is returned; it was not performed a second time.",
            };

          case "indeterminate":
            // Deliberately 200 and not a 5xx. Every HTTP client and proxy in
            // existence retries a 5xx, and a retry of an action that may
            // already have taken effect is a duplicate consumer-facing effect.
            // The instruction not to retry has to reach a human, so it is said
            // in a body a person reads rather than in a status a library
            // handles.
            return {
              outcome: "indeterminate",
              parkedActionId: outcome.parkedActionId,
              message: outcome.message,
              retryable: false,
            };

          default: {
            const exhaustive: never = outcome;
            throw new DeniedError(
              "record.unavailable",
              `The execution service returned an outcome this surface does not understand: ${JSON.stringify(exhaustive)}`,
              {},
            );
          }
        }
      });
    },
    { prefix: options.prefix ?? DEFAULT_PREFIX },
  );
}

const DEFAULT_PREFIX = "/api/external";

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * A JWT is three base64url segments separated by dots.
 *
 * Platform bearer tokens are `pvx_` followed by base64url of random bytes and
 * contain no dot, so the two are told apart without a header the caller could
 * get wrong — and, more to the point, without a header the caller could use to
 * pick which verifier runs.
 */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Read the credential a request presents.
 *
 * Two schemes. `Authorization: Bearer` carries either a platform bearer token
 * or a signed assertion. The `X-PV-*` headers carry an HMAC-signed request or a
 * signed envelope, whose signature covers a digest of the exact body that
 * arrived.
 */
function presentedCredential(request: FastifyRequest, bodyDigest: Digest): PresentedCredential {
  const authorization = header(request, "authorization", HEADER_MAX.authorization);
  if (authorization) {
    const match = /^Bearer[ \t]+(\S+)$/i.exec(authorization.trim());
    const token = match?.[1];
    if (!token) throw refuse("The Authorization header is not a Bearer credential.");
    if (token.length > HEADER_MAX.token) {
      throw refuse(`A token of ${token.length} characters was presented.`);
    }
    return JWT_SHAPE.test(token) ? { kind: "jwt", token } : { kind: "bearer", token };
  }

  const agentId = header(request, "x-pv-agent", HEADER_MAX.agentId);
  const timestampHeader = header(request, "x-pv-timestamp", HEADER_MAX.timestamp);
  const nonce = header(request, "x-pv-nonce", HEADER_MAX.nonce);
  const signature = header(request, "x-pv-signature", HEADER_MAX.signature);

  if (!agentId || !timestampHeader || !nonce || !signature) {
    // Said plainly, and it is the one authentication failure that is. A caller
    // who presented nothing has named no agent and guessed no secret, so there
    // is nothing here for an enumeration attempt to learn — and the alternative
    // is a vendor spending an afternoon on "could not be verified" when the
    // answer is that their client never attached the header.
    throw new DeniedError(
      "integration.credential_missing",
      "No credential was presented. Every route on this surface authenticates, and there is no anonymous access to it.",
      {},
    );
  }

  const kind = header(request, "x-pv-signature-kind", HEADER_MAX.kind);
  if (kind !== "hmac" && kind !== "envelope") {
    throw refuse("X-PV-Signature-Kind must be 'hmac' or 'envelope'.");
  }

  // Optional, and checked rather than trusted. A client that sends a digest of
  // something other than what it sent is told so plainly, which turns an
  // afternoon of "the signature does not verify" into one line.
  const claimedDigest = header(request, "x-pv-body-digest", HEADER_MAX.digest);
  if (claimedDigest && claimedDigest !== bodyDigest) {
    throw refuse("X-PV-Body-Digest does not match the body that arrived.");
  }

  return { kind, agentId, timestamp: timestampHeader, nonce, signature, bodyDigest };
}

function header(request: FastifyRequest, name: string, max: number): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) return undefined;
  // Bounded before it is parsed, compared, or logged — a header is input like
  // any other, and this one is read before the caller is known.
  if (value.length > max) {
    throw refuse(`The ${name} header is ${value.length} characters, past the ${max} limit.`);
  }
  return value;
}

/**
 * One refusal for every authentication failure.
 *
 * Uniform on purpose, and mirroring `CredentialService`. Distinguishing "no
 * such agent" from "wrong signature" from "expired credential" turns this
 * endpoint into an oracle for enumerating enrolled agents. The specific reason
 * goes to the audit record and to the operator; it does not go to the caller.
 */
function refuse(operatorDetail: string): DeniedError {
  return new DeniedError(
    "integration.credential_missing",
    "The presented credential could not be verified.",
    { detail: operatorDetail },
  );
}

/**
 * Refuse a body whose `agentId` disagrees with the verified credential.
 *
 * Preferring the credential silently would be defensible and is wrong: the two
 * disagreeing is either a client bug worth telling somebody about or an
 * impersonation attempt worth refusing, and from here they look identical.
 */
function assertBodyAgentMatches(claimed: string | undefined, identity: VerifiedIdentity): void {
  if (claimed !== undefined && claimed !== identity.agentId) {
    throw new DeniedError(
      "authorization.action_not_permitted",
      "The agentId in the body is not the agent this credential authenticates. Nothing was done.",
      { externalAgentId: identity.agentId },
    );
  }
}

// ---------------------------------------------------------------------------
// Admission plumbing
// ---------------------------------------------------------------------------

/**
 * Turn a refusal from the chain into a thrown denial.
 *
 * The chain *returns* a denial rather than throwing, because it has to record
 * the refusal against the agent's misbehaviour counter first. By the time it
 * gets here that has happened, and the refusal has to become an exception so
 * that no handler can carry on past it by forgetting to check a field.
 */
function assertAdmitted(decision: AdmissionDecision, operation: AdmissionOperation): void {
  if (decision.outcome === "denied") {
    throw new DeniedError(
      denialReason(decision.reason),
      decision.message ?? `The ${operation} request was refused.`,
      {},
    );
  }
  if (decision.outcome === "approval_required") {
    throw new DeniedError(
      "approval.required",
      decision.message ??
        `This ${operation} needs a human decision before it can proceed. Screen it first.`,
      decision.approvalId ? { approvalId: decision.approvalId } : {},
    );
  }
}

function respondToDecision(
  reply: FastifyReply,
  decision: AdmissionDecision,
  prefix: string,
): Record<string, unknown> {
  if (decision.outcome === "denied") {
    throw new DeniedError(
      denialReason(decision.reason),
      decision.message ?? "Refused.",
      {},
    );
  }

  if (decision.outcome === "approval_required") {
    // 202 rather than 200. A client that branches on `response.ok` alone would
    // otherwise read "a human has to decide this" as "go ahead".
    void reply.status(202);
    return {
      outcome: "approval_required",
      effectiveRisk: decision.effectiveRisk,
      approvalId: decision.approvalId,
      remainingBudgetUsd: decision.remainingBudgetUsd,
      poll: decision.approvalId ? `${prefix}/approvals/${decision.approvalId}` : undefined,
      message: decision.message,
    };
  }

  return {
    outcome: "allowed",
    effectiveRisk: decision.effectiveRisk,
    remainingBudgetUsd: decision.remainingBudgetUsd,
  };
}

/**
 * The chain's reason string, as a denial reason.
 *
 * Every value the chain produces is drawn from `DenialReason`, but it travels
 * as a plain string on the decision. Narrowing here rather than at each call
 * site means an unrecognised value lands on the least specific reason instead
 * of on whatever the caller happened to write.
 */
function denialReason(reason: string | undefined): DenialReason {
  return (reason ?? "authorization.action_not_permitted") as DenialReason;
}

/**
 * Count a request that does not run the full chain.
 *
 * The heartbeat and the finish both bypass admission for reasons set out at
 * each route, and neither may therefore go uncounted: an agent looping on
 * either would be an unbounded caller inside a plane whose whole premise is
 * that external callers are bounded.
 */
async function assertWithinRate(
  rateLimiter: RateLimiterLike,
  agentId: ExternalAgentId,
  operation: AdmissionOperation,
): Promise<void> {
  const reading = await rateLimiter.check(agentId, operation);
  if (!reading.allowed) {
    throw new DeniedError(
      "ceiling.rate_exceeded",
      `Rate ceiling reached for ${operation}: ${reading.count} requests in the window.`,
      { externalAgentId: agentId, operation, used: reading.count },
    );
  }
}

// ---------------------------------------------------------------------------
// Bounds and parsing
// ---------------------------------------------------------------------------

/**
 * Parse a body against its schema, or throw.
 *
 * Generic over the schema rather than over the parsed type, so that a schema
 * carrying a `.default()` — where the input and output types differ — infers
 * its *output*. Written the other way round, `declaredRisk` would arrive typed
 * as possibly undefined despite having a default, and the fix would be a cast
 * at the call site rather than here.
 */
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw result.error;
  return result.data;
}

function schemaFailureBody(error: z.ZodError) {
  const first = error.issues[0];
  return {
    error: "invalid_input",
    message: first
      ? `${first.path.join(".") || "body"}: ${first.message}`
      : "The request body did not match the published contract.",
    field: first ? first.path.join(".") : "body",
    // Bounded: a body with a hundred bad fields must not produce a hundred-line
    // response, which would make this endpoint an amplifier.
    issues: error.issues.slice(0, 10).map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    })),
  };
}

/**
 * Bound the one free-form payload on this surface.
 *
 * Size, breadth, and depth, all three. Size alone is not enough: a payload
 * within the byte limit can still be nested thousands deep, and the recursion
 * that later walks it — canonicalising it for a digest, rendering it into a
 * preview a human reads — is where that lands. Breadth alone is not enough
 * either, for the same reason in the other direction.
 */
function assertBoundedPayload(field: string, value: Record<string, unknown>): void {
  let serialised: string;
  try {
    serialised = JSON.stringify(value) ?? "";
  } catch (error) {
    throw new InvalidInputError(
      `${field} could not be serialised: ${error instanceof Error ? error.message : String(error)}`,
      field,
    );
  }
  if (serialised.length > MAX.requestBytes) {
    throw new InvalidInputError(
      `${field} is ${serialised.length} bytes, past the ${MAX.requestBytes}-byte limit. It is refused whole rather than trimmed, because a trimmed request would be approved in part and committed in full.`,
      field,
    );
  }

  let keys = 0;
  const walk = (node: unknown, depth: number, path: string): void => {
    if (depth > MAX.requestDepth) {
      throw new InvalidInputError(
        `${path} nests deeper than the ${MAX.requestDepth}-level limit.`,
        field,
      );
    }
    if (Array.isArray(node)) {
      if (node.length > MAX.requestArrayItems) {
        throw new InvalidInputError(
          `${path} has ${node.length} items, past the ${MAX.requestArrayItems} limit.`,
          field,
        );
      }
      for (const [index, item] of node.entries()) walk(item, depth + 1, `${path}[${index}]`);
      return;
    }
    if (node !== null && typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>);
      keys += entries.length;
      if (keys > MAX.requestKeys) {
        throw new InvalidInputError(
          `${field} carries more than ${MAX.requestKeys} keys in total.`,
          field,
        );
      }
      for (const [key, entry] of entries) {
        if (key.length > MAX.identifier) {
          throw new InvalidInputError(
            `${path}: a key of ${key.length} characters is past the ${MAX.identifier} limit.`,
            field,
          );
        }
        walk(entry, depth + 1, `${path}.${key}`);
      }
      return;
    }
    if (typeof node === "string" && node.length > MAX.requestStringLength) {
      throw new InvalidInputError(
        `${path} is ${node.length} characters, past the ${MAX.requestStringLength} limit.`,
        field,
      );
    }
    if (typeof node === "number" && !Number.isFinite(node)) {
      throw new InvalidInputError(`${path} is not a finite number.`, field);
    }
  };

  walk(value, 1, field);
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * The denial body, minimised for a third party.
 *
 * Same shape as the console-facing API — `denied`, `reason`, `message`,
 * `detail` — so one client can read both. The difference is the contents of
 * `detail`: operator-facing notes explaining *which* check failed are dropped,
 * because on this surface they would enumerate the registry.
 */
function denialBody(error: DeniedError) {
  const detail: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(error.detail)) {
    if (RETURNABLE_DETAIL_KEYS.has(key)) detail[key] = value;
  }
  return {
    denied: true as const,
    reason: error.reason,
    message: error.message,
    detail,
  };
}

/** Fastify's own errors carry a status code; anything else is ours to own. */
function statusCodeOf(error: unknown): number {
  if (error && typeof error === "object" && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    if (typeof code === "number" && Number.isInteger(code)) return code;
  }
  return 500;
}

function correlationOf(request: FastifyRequest, fromBody: string | undefined): string | undefined {
  if (fromBody) return fromBody;
  const carried = (request as FastifyRequest & { correlationId?: string }).correlationId;
  return typeof carried === "string" && carried.length > 0 ? carried : undefined;
}
