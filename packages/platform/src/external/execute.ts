import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import { canonicalJson } from "../kernel/canonical.js";
import { digestBytes, digestsEqual, type Digest } from "../kernel/hash.js";
import type { IdGenerator, Id } from "../kernel/ids.js";
import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { ApprovalService } from "../guard/approvals.js";
import type { ContainmentController } from "../guard/containment.js";
import type { RunStore } from "../record/port.js";
import type { AdmissionService } from "./admission.js";
import type { ParkedActionStore, UsedApprovalLedger, EnrollmentStore } from "./port.js";
import type { RateLimiterLike } from "./ratelimit-port.js";
import type {
  ExecuteOutcome,
  ExecuteRequest,
  ExternalAgentId,
  ParkedAction,
} from "./types.js";

/**
 * Governed execution on behalf of an external agent.
 *
 * The distinction that makes this worth building: pre-authorising an agent and
 * letting it act is a promise; performing the action here is a receipt. When
 * the agent asks the platform to do the thing, the action itself passes the
 * chokepoint, lands in the operating record, and produces an audit entry — and
 * the agent cannot decline to tell us how it went, because it did not do it.
 *
 * Reads run immediately once admitted. Writes are two-phase and digest-bound:
 *
 *   1. The agent submits the write. The platform parks an approval carrying a
 *      preview a human can read and a hash of the exact request.
 *   2. A human approves.
 *   3. The agent re-sends the **byte-identical** request to commit.
 *
 * Everything below exists because of a specific way this goes wrong.
 */

/** How long a commit may be in flight before the sweeper calls it indeterminate. */
const DEFAULT_COMMIT_STALE_MS = 5 * 60 * 1000;

/**
 * Performs the actual outbound call.
 *
 * Narrow by design: this module governs the action, it does not know how to
 * make one. The composition root supplies an adapter over the integrations
 * module, which owns the host allowlist, credentials, retries, and idempotency
 * keys.
 */
export interface GovernedIntegration {
  /** True when this connector is currently enabled. Re-checked at commit. */
  isEnabled(integration: string): Promise<boolean>;
  perform(input: {
    readonly integration: string;
    readonly operation: string;
    readonly mode: "read" | "write";
    readonly request: Record<string, unknown>;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface ExecutionOptions {
  readonly parkedActionTtlMs?: number;
  readonly commitStaleMs?: number;
}

export class ExecutionService {
  private readonly parkedTtlMs: number;
  private readonly commitStaleMs: number;

  constructor(
    private readonly admission: AdmissionService,
    private readonly parked: ParkedActionStore,
    private readonly usedApprovals: UsedApprovalLedger,
    private readonly approvals: ApprovalService,
    private readonly enrollment: EnrollmentStore,
    private readonly integration: GovernedIntegration,
    private readonly containment: ContainmentController,
    private readonly runs: RunStore,
    private readonly rateLimiter: RateLimiterLike,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    options: ExecutionOptions = {},
  ) {
    this.parkedTtlMs = options.parkedActionTtlMs ?? 24 * 60 * 60 * 1000;
    this.commitStaleMs = options.commitStaleMs ?? DEFAULT_COMMIT_STALE_MS;
  }

  /**
   * Canonical digest of a request.
   *
   * Through canonical JSON, so key order cannot change the digest and an agent
   * re-serialising the same logical request still commits successfully. That is
   * a deliberate choice: binding to raw bytes would make the protocol depend on
   * the caller's JSON library, and a legitimate agent would fail to commit its
   * own approved request.
   */
  private digestOf(request: ExecuteRequest): Digest {
    return digestBytes(
      canonicalJson({
        agentId: request.agentId,
        integration: request.integration,
        operation: request.operation,
        request: request.request,
      }),
    );
  }

  async execute(request: ExecuteRequest): Promise<ExecuteOutcome> {
    if (request.parkedActionId) return this.commit(request);
    return request.mode === "read" ? this.executeRead(request) : this.park(request);
  }

  // -------------------------------------------------------------------------

  private async executeRead(request: ExecuteRequest): Promise<ExecuteOutcome> {
    const decision = await this.admission.admit(
      {
        agentId: request.agentId,
        operation: "execute.read",
        tool: `${request.integration}.${request.operation}`,
        declaredRisk: "routine",
        correlationId: request.correlationId,
      },
      { deferApproval: true },
    );

    if (decision.outcome === "denied") {
      throw new DeniedError(
        (decision.reason ?? "authorization.action_not_permitted") as never,
        decision.message ?? "Refused.",
        { externalAgentId: request.agentId },
      );
    }
    if (decision.outcome === "approval_required") {
      // A read the operator rated high enough to need approval is not a read we
      // perform on the spot; it takes the same two-phase path a write does.
      return this.park(request, { alreadyAdmitted: true });
    }

    const run = await this.openRun(request, "read");
    const idempotencyKey = `${run.id}:${request.integration}.${request.operation}`;
    const result = await this.integration.perform({
      integration: request.integration,
      operation: request.operation,
      mode: "read",
      request: request.request,
      idempotencyKey,
    });

    await this.runs.patchRun(run.id, {
      status: "succeeded",
      endedAt: this.clock.nowIso(),
      outcome: `Read ${request.integration}.${request.operation} for external agent`,
    });

    return { kind: "completed", result, runId: run.id };
  }

  /**
   * Phase one: park the write behind a human decision.
   *
   * The slot-release detail matters. The parked record is created first so the
   * request digest exists before anything else, and the approval is created
   * second. If the approval fails to create, the parked record is voided
   * immediately — otherwise it sits pending forever with no approval to
   * consume, uncommittable and invisible, and the agent retries into a new one
   * every time.
   */
  private async park(
    request: ExecuteRequest,
    options: { readonly alreadyAdmitted?: boolean } = {},
  ): Promise<ExecuteOutcome> {
    const requestDigest = this.digestOf(request);

    if (!options.alreadyAdmitted) {
      const decision = await this.admission.admit(
        {
          agentId: request.agentId,
          operation: "execute.write",
          tool: `${request.integration}.${request.operation}`,
          // A write performed on an agent's behalf is high-consequence by
          // construction: the platform's credentials are the ones that touch
          // the system of record.
          declaredRisk: "high_consequence",
          correlationId: request.correlationId,
        },
        // The approval is raised below, after the slot exists, so that a
        // failure to raise it can hand the slot back.
        { deferApproval: true, proposalDigest: requestDigest },
      );

      if (decision.outcome === "denied") {
        throw new DeniedError(
          (decision.reason ?? "authorization.action_not_permitted") as never,
          decision.message ?? "Refused.",
          { externalAgentId: request.agentId },
        );
      }
    }

    const now = this.clock.now();

    // Read once, and use it for both the preview and the approval summary. The
    // approver needs to know which agent, on whose platform, is asking — the
    // request body alone cannot tell them.
    const agent = await this.enrollment.getAgent(request.agentId);

    const action: ParkedAction = {
      id: this.ids.next("parkedAction"),
      agentId: request.agentId,
      integration: request.integration,
      operation: request.operation,
      requestDigest,
      preview: previewOf(request.request, {
        action: `${request.integration}.${request.operation}`,
        agent: agent ? `${agent.name} (${agent.department}, owner ${agent.owner})` : request.agentId,
        ...(agent ? { hostPlatform: agent.hostPlatform } : {}),
      }),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.parkedTtlMs).toISOString(),
      correlationId: request.correlationId,
    };

    const created = await this.parked.createParkedAction(action);

    let approvalId: Id<"approval">;
    try {
      {
        const approval = await this.approvals.request({
          action: "external.execute_write",
          // The approval binds to the digest of the exact request, so a human's
          // yes covers this payload and no other.
          proposalDigest: requestDigest,
          summary: `[external agent] ${agent?.name ?? request.agentId} on ${agent?.hostPlatform ?? "an external platform"} requests ${request.integration}.${request.operation}`,
          requestedBy: { actorId: request.agentId, kind: "service", roles: ["external_agent"] },
          approvalsRequired: 1,
          eligibleRoles: ["supervisor", "compliance_reviewer"],
          correlationId: request.correlationId,
          subject: {
            externalAgentId: request.agentId,
            integration: request.integration,
            operation: request.operation,
            parkedActionId: created.id,
          },
          ttlMs: this.parkedTtlMs,
        });
        approvalId = approval.id;
      }
    } catch (error) {
      // Hand the slot back. A pending record with no approval can never be
      // committed and would accumulate silently.
      await this.parked.transitionParkedAction({
        id: created.id,
        expectedStatus: "pending",
        status: "voided",
        at: this.clock.nowIso(),
        voidReason: "The approval could not be created, so the parked action was released.",
      });
      throw error;
    }

    // Bind the approval to the record. The action stays `pending` — the human
    // decision lives on the approval, and the parked action does not move until
    // a commit arrives.
    const bound = await this.parked.bindApproval(created.id, approvalId, this.clock.nowIso());
    if (!bound) {
      // The record went somewhere else between creation and binding. Release
      // the approval rather than leaving a granted approval nothing can spend.
      await this.parked.transitionParkedAction({
        id: created.id,
        expectedStatus: "pending",
        status: "voided",
        at: this.clock.nowIso(),
        voidReason: "The parked action could not be bound to its approval.",
      });
      throw new DeniedError(
        "record.unavailable",
        "The action could not be parked. Nothing was done; resubmit it.",
        { parkedActionId: created.id },
      );
    }

    return {
      kind: "approval_required",
      parkedActionId: created.id,
      approvalId,
      preview: created.preview,
    };
  }

  /**
   * Phase two: commit the previously approved write.
   *
   * The order of checks here is the whole point, and every one of them is a
   * defect somewhere else:
   *
   *   1. **Terminal status before expiry.** A replayed commit on an action that
   *      already fired must hear "already done". Telling it "expired, submit it
   *      again" is an instruction to duplicate the effect through a second
   *      approval, which is the worst possible answer.
   *   2. **Digest binding.** Any difference between what was approved and what
   *      is being committed voids the action and counts as misbehaviour.
   *   3. **Re-run the admission chain.** A human's yes is necessary, not
   *      sufficient: if the agent was revoked or the connector disabled while
   *      the approval sat in the queue, the commit is refused.
   *   4. **One-shot approval, with a floor.** The ledger refuses anything at or
   *      below the highest id it ever evicted, so an old approval does not
   *      become reusable by ageing out.
   *   5. **Conditional transition.** Two concurrent commits: exactly one moves
   *      the record, the other is told it is already done.
   */
  private async commit(request: ExecuteRequest): Promise<ExecuteOutcome> {
    const id = request.parkedActionId;
    if (!id) throw new DeniedError("approval.required", "No parked action was named.", {});

    const action = await this.parked.getParkedAction(id);
    if (!action) {
      throw new DeniedError("approval.required", `No parked action ${id}.`, {
        parkedActionId: id,
      });
    }

    // 1. Terminal status outlives expiry.
    if (action.status === "committed") {
      return {
        kind: "already_done",
        parkedActionId: action.id,
        resultSummary: action.resultSummary,
      };
    }
    if (action.status === "indeterminate" || action.status === "committing") {
      return {
        kind: "indeterminate",
        parkedActionId: action.id,
        message:
          "This action was started and its outcome was never recorded. It has NOT been retried, because it may already have taken effect. Verify in the system of record before acting.",
      };
    }
    if (action.status === "voided" || action.status === "rejected") {
      throw new DeniedError(
        "approval.required",
        `That action was ${action.status}${action.voidReason ? `: ${action.voidReason}` : "."}`,
        { parkedActionId: action.id },
      );
    }

    // 2. Digest binding, before expiry — a mismatched payload is misbehaviour
    //    whatever the clock says, and should be reported as such.
    const presented = this.digestOf(request);
    if (!digestsEqual(presented, action.requestDigest)) {
      await this.parked.transitionParkedAction({
        id: action.id,
        expectedStatus: action.status,
        status: "voided",
        at: this.clock.nowIso(),
        voidReason:
          "The committed request did not match the approved request. What a human approved is not what was about to be done.",
      });
      await this.rateLimiter.recordDenial(request.agentId, "misbehaviour");
      await this.audit.record(
        auditDecision({
          eventType: "authorization.denied",
          actorId: request.agentId,
          actorKind: "service",
          actorRoles: ["external_agent"],
          correlationId: request.correlationId,
          subject: {
            externalAgentId: request.agentId,
            parkedActionId: action.id,
            integration: action.integration,
          },
          decision: { reason: "approval.digest_mismatch", voided: true, external: true },
        }),
      );
      throw new DeniedError(
        "approval.digest_mismatch",
        "The request being committed differs from the request that was approved. The parked action has been voided; nothing was done.",
        { parkedActionId: action.id },
      );
    }

    if (this.clock.nowIso() > action.expiresAt) {
      throw new DeniedError(
        "approval.expired",
        `That parked action expired at ${action.expiresAt}. Submit a new one.`,
        { parkedActionId: action.id },
      );
    }

    // 3. Re-run the whole admission chain. The kill switch re-binds here.
    const decision = await this.admission.admit(
      {
        agentId: request.agentId,
        operation: "execute.commit",
        tool: `${action.integration}.${action.operation}`,
        declaredRisk: "high_consequence",
        correlationId: request.correlationId,
      },
      { isCommit: true, proposalDigest: action.requestDigest },
    );
    if (decision.outcome === "denied") {
      throw new DeniedError(
        (decision.reason ?? "authorization.action_not_permitted") as never,
        `${decision.message ?? "Refused."} A human's approval does not survive the agent being stopped.`,
        { parkedActionId: action.id },
      );
    }

    // The connector may have been disabled since the approval was given.
    if (!(await this.integration.isEnabled(action.integration))) {
      throw new DeniedError(
        "containment.integration_revoked",
        `Integration "${action.integration}" has been disabled since this action was approved. Nothing was done.`,
        { parkedActionId: action.id, integration: action.integration },
      );
    }
    await this.containment.assertClear({ integration: action.integration });

    // 4. One-shot approval, durably.
    if (!action.approvalId) {
      throw new DeniedError(
        "approval.required",
        "That parked action carries no approval.",
        { parkedActionId: action.id },
      );
    }
    if (await this.usedApprovals.isConsumed(action.approvalId)) {
      return {
        kind: "already_done",
        parkedActionId: action.id,
        resultSummary: action.resultSummary,
      };
    }
    await this.approvals.consume({
      approvalId: action.approvalId,
      expectedProposalDigest: action.requestDigest,
      actor: { actorId: request.agentId, kind: "service", roles: ["external_agent"] },
    });
    const claimed = await this.usedApprovals.claimApproval(action.approvalId, this.clock.nowIso());
    if (!claimed) {
      return {
        kind: "already_done",
        parkedActionId: action.id,
        resultSummary: action.resultSummary,
      };
    }

    // 5. Conditional transition into the in-flight state. Whichever concurrent
    //    caller loses gets null and is told the action is already under way.
    const inFlight = await this.parked.transitionParkedAction({
      id: action.id,
      expectedStatus: action.status,
      status: "committing",
      at: this.clock.nowIso(),
    });
    if (!inFlight) {
      return {
        kind: "already_done",
        parkedActionId: action.id,
        resultSummary: action.resultSummary,
      };
    }

    const run = await this.openRun(request, "write");

    try {
      const result = await this.integration.perform({
        integration: action.integration,
        operation: action.operation,
        mode: "write",
        request: request.request,
        // Derived from the parked action, so a retry of the same commit reaches
        // the remote system under the same key.
        idempotencyKey: `parked:${action.id}`,
      });

      await this.parked.transitionParkedAction({
        id: action.id,
        expectedStatus: "committing",
        status: "committed",
        at: this.clock.nowIso(),
        resultDigest: digestBytes(canonicalJson({ result })),
        resultSummary: `Committed ${action.integration}.${action.operation}`,
      });

      await this.runs.patchRun(run.id, {
        status: "succeeded",
        endedAt: this.clock.nowIso(),
        outcome: `Committed ${action.integration}.${action.operation} on behalf of an external agent`,
      });

      return { kind: "completed", result, runId: run.id };
    } catch (error) {
      // The effect may or may not have landed. We do not know, and neither does
      // anyone else here — only the system of record does. Mark it and say so.
      // Never retry automatically: a retry of an action that succeeded is a
      // duplicate consumer-facing effect.
      await this.parked.transitionParkedAction({
        id: action.id,
        expectedStatus: "committing",
        status: "indeterminate",
        at: this.clock.nowIso(),
        voidReason: error instanceof Error ? error.message.slice(0, 480) : String(error),
      });
      await this.runs.patchRun(run.id, {
        status: "failed",
        endedAt: this.clock.nowIso(),
        outcome: "Indeterminate: the outcome was never recorded. Verify in the system of record.",
      });

      return {
        kind: "indeterminate",
        parkedActionId: action.id,
        message:
          "The action was started and its outcome was not recorded. It has NOT been retried, because it may already have taken effect. Verify in the system of record before acting.",
      };
    }
  }

  /**
   * Sweep commits that were left in flight by a worker that died.
   *
   * Marks them indeterminate — never retries them. There is no safe automatic
   * recovery: retrying may duplicate a consumer-facing effect, and abandoning
   * may leave a half-finished one. A person has to look.
   */
  async sweepStaleCommits(): Promise<readonly ParkedAction[]> {
    const cutoff = new Date(this.clock.now() - this.commitStaleMs).toISOString();
    const inFlight = await this.parked.listParkedActions({ status: ["committing"], limit: 200 });
    const stranded: ParkedAction[] = [];

    for (const action of inFlight) {
      if (action.createdAt > cutoff) continue;
      const marked = await this.parked.transitionParkedAction({
        id: action.id,
        expectedStatus: "committing",
        status: "indeterminate",
        at: this.clock.nowIso(),
        voidReason:
          "A worker stopped while this action was in flight. The outcome is unknown and it has not been retried.",
      });
      if (marked) stranded.push(marked);
    }

    return stranded;
  }

  private async openRun(request: ExecuteRequest, mode: "read" | "write") {
    return this.runs.createRun({
      kind: `external.execute_${mode}`,
      mode: "supervised",
      // Marked external so this lands beside native work in one record rather
      // than in a parallel system.
      requestedBy: {
        actorId: request.agentId as ExternalAgentId,
        kind: "service",
        roles: ["external_agent"],
      },
      subject: { integration: request.integration, operation: request.operation },
      correlationId: request.correlationId ?? `external-${request.agentId}`,
    });
  }
}

/**
 * A human-readable rendering of the request.
 *
 * The approver is authorising a payload they did not write, produced by an
 * agent they may not have met, on a platform they do not administer. A raw JSON
 * blob is not a decision aid — the preview is what makes the approval mean
 * something.
 */
export function previewOf(
  request: Record<string, unknown>,
  /**
   * What is being done, and by whom.
   *
   * First rows deliberately, because a list of field values answers "with what"
   * and never "what". An approver who has to infer the operation from the shape
   * of the payload is being asked to guess.
   */
  context?: {
    readonly action?: string;
    readonly agent?: string;
    readonly hostPlatform?: string;
  },
): readonly { readonly label: string; readonly value: string }[] {
  const preview: { label: string; value: string }[] = [];
  if (context?.action) preview.push({ label: "Action", value: context.action });
  if (context?.agent) preview.push({ label: "Requested by", value: context.agent });
  if (context?.hostPlatform) preview.push({ label: "Running on", value: context.hostPlatform });
  for (const [key, value] of Object.entries(request).slice(0, 32)) {
    let rendered: string;
    if (value === null || value === undefined) rendered = "(none)";
    else if (typeof value === "object") rendered = canonicalJson(value).slice(0, 240);
    else rendered = String(value).slice(0, 240);
    preview.push({ label: key, value: rendered });
  }
  return preview;
}
