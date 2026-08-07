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
  /**
   * The registered mode of an operation, or null when there is no such
   * operation.
   *
   * On the port rather than only on the router because the commit path needs to
   * know, before it spends a human's approval, whether the call it is about to
   * make can be made at all. Without it, an unregistered operation or a mode
   * mismatch was discovered inside `perform` — after the approval was consumed
   * — and reported as an effect that might have landed.
   */
  modeOf(integration: string, operation: string): "read" | "write" | null;
  /**
   * Perform the call.
   *
   * A `DeniedError` from this method asserts that **nothing was done**. That is
   * part of the contract rather than an implementation detail: the caller uses
   * it to distinguish "the platform declined" from "the call may have crossed
   * the network", and those two get very different answers. An adapter that
   * could refuse *after* a partial effect must raise something else.
   */
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

    // The platform's own containment, checked separately from the agent's.
    // `admit` answers "is this agent stopped"; this answers "is the platform
    // stopped", and a global pause has to reach an external agent's reads too.
    // They are outbound calls made with the platform's credentials against a
    // system of record, which is exactly what an operator engaging a pause
    // during an incident intends to stop.
    await this.containment.assertClear({ integration: request.integration });

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

    // Refuse to raise the approval at all while the platform is paused. A
    // queue that fills with requests during an incident is a queue somebody
    // works through afterwards without knowing which entries arrived while
    // everything was supposed to be stopped.
    await this.containment.assertClear({ integration: request.integration });

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
      // Bound at parking time, not asserted at commit. A read the operator
      // rated high-consequence takes this same path, and a commit that assumed
      // `write` refused it at the last step — spending a human's approval on
      // something that could never happen.
      mode: request.mode,
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

    // 0. Ownership, before the record is read for any other purpose.
    //
    // `runs.ts:291` and `runs.ts:348` already refuse a heartbeat or a finish
    // for another agent's run, and `api/external.ts:471` refuses to say whether
    // another agent's approval exists. This is the same boundary at the one
    // place that produces an effect, and it has to come first for two reasons.
    //
    // The digest comparison below *voids* the record on a mismatch, and rightly
    // so — a caller substituting a payload after sign-off is misbehaviour. But
    // `digestOf` folds `agentId` into the digest, so a commit naming another
    // agent's action can never match, and running that check first turned
    // "somebody else guessed my id" into "this agent tampered with its own
    // request": the victim's approved action was destroyed, the human's
    // decision became unspendable, and the record accused an agent that had
    // submitted nothing. One enrolled agent could cancel every other agent's
    // approved work by naming its id.
    //
    // The refusal is deliberately the same one an unknown id gets, so this
    // endpoint cannot be used to discover which ids exist.
    if (action.agentId !== request.agentId) {
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

    // The operation must still exist and must still be the mode it was approved
    // as. Both are refusals the router would raise anyway — the point of asking
    // here is that this is *before* the approval is consumed. Asking inside
    // `perform` meant a refusal that never touched the network was reported as
    // an effect that might have landed, with the human's decision already spent.
    const registeredMode = this.integration.modeOf(action.integration, action.operation);
    if (registeredMode === null) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `"${action.integration}.${action.operation}" is no longer a governed operation. Nothing was done.`,
        { parkedActionId: action.id, integration: action.integration },
      );
    }
    if (registeredMode !== action.mode) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `"${action.integration}.${action.operation}" was approved as a ${action.mode} and is now registered as a ${registeredMode}. Nothing was done; the approval stands and can be committed once the two agree.`,
        { parkedActionId: action.id, approvedMode: action.mode, registeredMode },
      );
    }

    // 4. One-shot approval, durably.
    if (!action.approvalId) {
      throw new DeniedError(
        "approval.required",
        "That parked action carries no approval.",
        { parkedActionId: action.id },
      );
    }
    if (await this.usedApprovals.isConsumed(action.approvalId)) {
      // The ledger says this approval cannot be spent again. That is a refusal
      // signal and NOT evidence that anything happened — the ledger also
      // over-refuses every id at or below its evicted floor, deliberately, and
      // a worker that dies between claiming the approval and moving the action
      // leaves exactly this state with nothing performed. Answering from the
      // action's real status is the only honest reply.
      return this.answerFromStatus(action.id, "That approval has already been spent.");
    }
    await this.approvals.consume({
      approvalId: action.approvalId,
      expectedProposalDigest: action.requestDigest,
      actor: { actorId: request.agentId, kind: "service", roles: ["external_agent"] },
    });
    const claimed = await this.usedApprovals.claimApproval(action.approvalId, this.clock.nowIso());
    if (!claimed) {
      return this.answerFromStatus(action.id, "That approval was claimed by another commit.");
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
      return this.answerFromStatus(action.id, "That action moved before this commit could start.");
    }

    const run = await this.openRun(request, action.mode);

    try {
      const result = await this.integration.perform({
        integration: action.integration,
        operation: action.operation,
        mode: action.mode,
        request: request.request,
        // Derived from the parked action, so a retry of the same commit reaches
        // the remote system under the same key.
        idempotencyKey: `parked:${action.id}`,
      });

      const settled = await this.parked.transitionParkedAction({
        id: action.id,
        expectedStatus: "committing",
        status: "committed",
        at: this.clock.nowIso(),
        resultDigest: digestBytes(canonicalJson({ result })),
        resultSummary: `Committed ${action.integration}.${action.operation}`,
      });

      if (!settled) {
        // Something moved the row while the call was in flight — the sweeper
        // deciding the worker had died is the only writer that can. The effect
        // DID happen, but the record now says otherwise, and returning
        // "completed" over a record that says "indeterminate" would be two
        // contradictory statements about one action. The record wins and a
        // person reconciles it.
        await this.runs.patchRun(run.id, {
          status: "failed",
          endedAt: this.clock.nowIso(),
          outcome:
            "The action completed but its record had already been moved. Reconcile against the system of record.",
        });
        return {
          kind: "indeterminate",
          parkedActionId: action.id,
          message:
            "This action completed, but its record had already been settled by something else — most likely a sweep that judged the worker dead. It has NOT been retried. Verify in the system of record before acting.",
        };
      }

      await this.runs.patchRun(run.id, {
        status: "succeeded",
        endedAt: this.clock.nowIso(),
        outcome: `Committed ${action.integration}.${action.operation} on behalf of an external agent`,
      });

      return { kind: "completed", result, runId: run.id };
    } catch (error) {
      // A DeniedError from the outbound path asserts that nothing was done —
      // that is the `GovernedIntegration` contract, not an inference. The
      // platform declined, so say so and leave the action where it was rather
      // than terminalising it as an effect that might have landed. Getting this
      // wrong tells an operator to go and check a system of record for a call
      // that was never made.
      if (error instanceof DeniedError) {
        await this.parked.transitionParkedAction({
          id: action.id,
          expectedStatus: "committing",
          status: "pending",
          at: this.clock.nowIso(),
        });
        await this.runs.patchRun(run.id, {
          status: "failed",
          endedAt: this.clock.nowIso(),
          outcome: `Refused before anything was done: ${error.reason}`,
        });
        throw error;
      }

      // Anything else may or may not have landed. We do not know, and neither
      // does anyone else here — only the system of record does. Mark it and say
      // so. Never retry automatically: a retry of an action that succeeded is a
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
   * Answer a commit from the parked action's real status.
   *
   * Three different negative conditions used to be reported as `already_done`
   * without anyone confirming the action had ever reached `committed`: the
   * ledger refusing the approval, a lost claim race, and a lost transition
   * race. None of them means "somebody else committed it", and in a product
   * whose entire value is that the record is true, "This action was already
   * committed" about a write that never happened is the worst sentence the API
   * can say. So the status is re-read and the answer comes from the record.
   */
  private async answerFromStatus(
    id: Id<"parkedAction">,
    context: string,
  ): Promise<ExecuteOutcome> {
    const current = await this.parked.getParkedAction(id);

    if (current?.status === "committed") {
      return {
        kind: "already_done",
        parkedActionId: id,
        resultSummary: current.resultSummary,
      };
    }
    if (current?.status === "committing" || current?.status === "indeterminate") {
      return {
        kind: "indeterminate",
        parkedActionId: id,
        message:
          "This action was started and its outcome was never recorded. It has NOT been retried, because it may already have taken effect. Verify in the system of record before acting.",
      };
    }

    // Everything else — pending, voided, rejected, expired, or gone. Nothing
    // happened, and the caller must not be told otherwise.
    throw new DeniedError(
      "approval.already_used",
      `${context} Nothing was done, and this action cannot be committed again. Its record reads "${current?.status ?? "missing"}"; raise a fresh request if the work is still wanted.`,
      { parkedActionId: id, status: current?.status ?? "missing" },
    );
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
      // Measure from when the commit went in flight, not from when the action
      // was parked. `createdAt` is when a human was *asked*, normally hours
      // earlier, so sweeping on it declares every live commit abandoned the
      // moment it starts. The fallback keeps rows written before the column
      // existed behaving exactly as they do today rather than becoming
      // invisible to the sweep.
      const startedAt = action.committingAt ?? action.createdAt;
      if (startedAt > cutoff) continue;
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
