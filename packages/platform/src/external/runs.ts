import { decision } from "../audit/log.js";
import type { AuditLog } from "../audit/log.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import type { ContainmentController } from "../guard/containment.js";
import type { RunStore } from "../record/port.js";
import type { ActorRef, IsoTimestamp, OperatingMode, RunStatus } from "../record/types.js";
import {
  assertAdmissible,
  boundedMoney,
  boundedSubject,
  boundedText,
  budgetPeriodKey,
  screenedText,
  stopReasonFor,
} from "./enrollment.js";
import type { EnrollmentStore, ExternalRunStore, SpendStore } from "./port.js";
import { COST_ATTRIBUTION } from "./types.js";
import type { EnrolledAgent, ExternalAgentId, ExternalRun, HeartbeatReply } from "./types.js";

/**
 * Live runs for work happening right now, somewhere else.
 *
 * This is the closest the platform gets to orchestrating an external agent, and
 * it is deliberately not orchestration. Nothing here starts, schedules, or
 * steers anybody's agent. What it does is make external work *visible beside
 * native work from the first moment* — a run on the operating record the
 * instant the agent says it has begun, rather than a report that arrives, or
 * does not, some time after it ended — and give the platform one reliable
 * moment to stop it.
 *
 * **The heartbeat is the kill switch, and it is the only one there is.** An
 * external agent runs inside somebody else's CRM or cloud account. We hold no
 * handle on its process, no route to its host, and no credential that would let
 * us interrupt it. Containment therefore cannot be *pushed* to it. The one
 * instant at which we can reliably stop it is the instant it next asks us
 * something, which is why the heartbeat reply is a directive rather than an
 * acknowledgement, why every stop condition is re-evaluated on every beat
 * rather than cached, and why a run that stops beating is reclaimed rather than
 * assumed healthy. A run that has gone quiet is not a run that is fine.
 *
 * **Reclaiming closes the operating-record run too.** Half a mechanism is worse
 * than none: an external run marked `reclaimed` beside a record run still
 * showing `running` would leave the console reporting live work that nobody is
 * doing, and the first thing an operator does with that display is stop
 * believing it.
 */

/** The kind recorded on the operating record for an external agent's episode. */
export const EXTERNAL_RUN_KIND = "external_agent.episode";

/** The role that marks a principal as running outside this platform. */
export const EXTERNAL_PRINCIPAL_ROLE = "external_agent";

const MAX_GOAL_LENGTH = 2_000;
const MAX_OUTCOME_LENGTH = 4_000;
const MAX_SUBJECT_KEYS = 16;
const MAX_SUBJECT_VALUE_LENGTH = 256;

export interface LiveRunSettings {
  /** Seconds without a heartbeat after which a run is reclaimed. */
  readonly reclaimAfterSeconds: number;
  /** The deployment's operating mode, recorded on every run. */
  readonly operatingMode: OperatingMode;
  /** Largest cost a single run may report, as a shape check on the figure. */
  readonly maxRunCostUsd: number;
}

export interface StartRunInput {
  readonly agentId: ExternalAgentId;
  readonly goal: string;
  readonly subject?: Readonly<Record<string, string>> | undefined;
  readonly correlationId?: string | undefined;
}

export interface FinishRunInput {
  readonly agentId: ExternalAgentId;
  readonly runId: Id<"externalRun">;
  readonly outcome: "succeeded" | "failed";
  readonly summary?: string | undefined;
  readonly costUsd: number;
}

/**
 * Build the operating record's actor for an external agent.
 *
 * `service` rather than `human`, and carrying `external_agent` in its roles, so
 * that every consumer of the operating record — the console, the cost report,
 * the oversight queue — can tell external work from native work without a
 * second table to join and without a parallel report to read.
 */
export function externalPrincipal(agent: EnrolledAgent): ActorRef {
  return {
    actorId: agent.id,
    kind: "service",
    roles: [EXTERNAL_PRINCIPAL_ROLE, `${EXTERNAL_PRINCIPAL_ROLE}:${agent.name}`],
  };
}

/** The subject references that identify external work on the operating record. */
export function externalSubject(
  agent: EnrolledAgent,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...extra,
    principal: "external",
    externalAgentId: agent.id,
    externalAgentName: agent.name,
    department: agent.department,
    hostPlatform: agent.hostPlatform,
  };
}

export class LiveRunService {
  private readonly settings: LiveRunSettings;

  constructor(
    private readonly runs: ExternalRunStore,
    private readonly agents: EnrollmentStore,
    private readonly spend: SpendStore,
    private readonly record: RunStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    settings: LiveRunSettings,
    /**
     * The platform's own containment, separate from the agent's status.
     *
     * The agent's status answers "is this agent stopped". This answers "is the
     * platform stopped", and the two are different levers pulled by different
     * people for different reasons. A global pause means no new work starts
     * anywhere — an operator who engages one during an incident does not mean
     * "except for the vendors".
     *
     * Optional so an embedding that has no containment controller still
     * composes. `buildExternalPlane` always passes one.
     */
    private readonly containment?: ContainmentController,
  ) {
    this.settings = assertSettings(settings);
  }

  /**
   * Why the platform as a whole is refusing, or null when it is not.
   *
   * Reported rather than thrown, because the heartbeat has to turn this into a
   * `stop` directive and `start` has to turn it into a refusal.
   */
  private async platformStopReason(): Promise<string | null> {
    if (!this.containment) return null;
    try {
      await this.containment.assertClear({});
      return null;
    } catch (error) {
      if (error instanceof DeniedError) {
        // allow-swallow: converted into a stop reason immediately below, which
        // is the whole purpose of asking. The caller refuses either way.
        return error.message;
      }
      throw error;
    }
  }

  /**
   * Begin an episode of external work.
   *
   * Creates the operating-record run *and* the external run, in that order, so
   * that an external run always points at a run that exists. If the second
   * write fails the first is closed as failed rather than left open: an
   * orphaned `running` row is indistinguishable in the console from real work
   * in flight, and would eventually be reclaimed as though an agent had gone
   * quiet, which is a false story about somebody else's system.
   *
   * @throws {DeniedError} when the agent is contained, revoked, expired, or not
   *   enrolled. Starting new work is exactly what containment must prevent.
   */
  async start(input: StartRunInput): Promise<ExternalRun> {
    const agent = await this.requireAgent(input.agentId);
    const now = this.clock.nowIso();
    assertAdmissible(agent, now);

    // A paused platform starts nothing. Refusing the registration rather than
    // recording work we have just said must not happen is the honest answer:
    // the agent asked "may I begin", and while a pause is engaged it may not.
    const paused = await this.platformStopReason();
    if (paused) {
      throw new DeniedError("containment.global_pause", paused, { agentId: agent.id });
    }

    const goal = screenedText("goal", input.goal, MAX_GOAL_LENGTH);
    const subject = boundedSubject(
      "subject",
      input.subject,
      MAX_SUBJECT_KEYS,
      MAX_SUBJECT_VALUE_LENGTH,
    );

    const externalRunId = this.ids.next("externalRun");
    const correlationId = input.correlationId
      ? boundedText("correlationId", input.correlationId, 128)
      : externalRunId;

    const run = await this.record.createRun({
      kind: EXTERNAL_RUN_KIND,
      status: "running",
      mode: this.settings.operatingMode,
      requestedBy: externalPrincipal(agent),
      subject: externalSubject(agent, subject),
      correlationId,
      startedAt: now,
      // The goal is the input to this episode, so the record holds its
      // fingerprint rather than its text — the operating record proves which
      // input a run saw without becoming a second copy of it. The readable
      // goal lives on the external run beside it, where the console reads it.
      inputDigest: digestValue({ goal }),
    });

    let externalRun: ExternalRun;
    try {
      externalRun = await this.runs.createExternalRun({
        id: externalRunId,
        agentId: agent.id,
        runId: run.id,
        goal,
        status: "running",
        startedAt: now,
        lastHeartbeatAt: now,
        costUsd: 0,
        correlationId,
      });
    } catch (error) {
      try {
        await this.closeRecordRun(run.id, "failed", now, "external run could not be created");
      } catch {
        // allow-swallow: this is cleanup after a failure that has already
        // happened, and the original error is the one that explains why. A
        // record store that cannot close the run leaves a row an operator can
        // see; replacing the cause with a second store error would leave them
        // guessing at both.
      }
      throw error;
    }

    await this.audit.record(
      decision({
        eventType: "run.started",
        actorId: agent.id,
        actorKind: "service",
        actorRoles: externalPrincipal(agent).roles,
        runId: run.id,
        correlationId,
        subject: externalSubject(agent, { ...subject, externalRunId: externalRun.id }),
        inputDigests: { goal: digestValue({ goal }) },
        decision: {
          external: true,
          live: true,
          reclaimAfterSeconds: this.settings.reclaimAfterSeconds,
        },
      }),
    );

    await this.touchLastSeen(agent.id, now);
    return externalRun;
  }

  /**
   * Answer a heartbeat.
   *
   * Every stop condition is read fresh on every beat. Caching any of them would
   * mean an operator's containment took effect one cache window later, and the
   * whole value of this method is that it is the *only* moment containment can
   * reach an agent at all.
   *
   * Returns `stop` rather than raising for the conditions an agent is expected
   * to encounter — containment, revocation, expiry, reclamation, an operator
   * stopping the run. Raising there would push a well-behaved agent into its
   * own error handling, and an agent's error handling is not somewhere this
   * platform wants its kill switch to live. It raises only when the caller is
   * not who it says it is.
   */
  async heartbeat(agentId: ExternalAgentId, runId: Id<"externalRun">): Promise<HeartbeatReply> {
    const now = this.clock.nowIso();
    const run = await this.requireRun(runId);

    // Ownership before anything else. An agent that could beat — or be told the
    // state of — another agent's run would be reading across a tenant boundary,
    // and a `stop` returned to the wrong caller is a denial of service one
    // agent can inflict on another.
    if (run.agentId !== agentId) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `External run ${runId} does not belong to agent ${agentId}.`,
        { agentId, runId },
      );
    }

    if (run.status !== "running") {
      return this.stopReply(`the run is already recorded as ${run.status}`);
    }

    const agent = await this.requireAgent(agentId);
    // The platform's pause reaches work already in flight through exactly the
    // same channel the agent's own containment does. There is no other channel.
    const blocked = (await this.platformStopReason()) ?? stopReasonFor(agent, now);
    if (blocked) {
      // The agent is being stopped, so the run is closed here rather than left
      // for the reclaim sweep. The agent has just been told to stop and will
      // not beat again; waiting for the sweep would leave the console showing
      // live work for as long as the reclaim window.
      await this.stopRun(agent, run, blocked, now);
      return this.stopReply(blocked);
    }

    const beaten = await this.runs.heartbeat(runId, now);
    if (!beaten) {
      // The sweep reclaimed it between our read and our write. Telling the
      // agent to continue now would revive a run the record has already closed.
      return this.stopReply("the run was reclaimed after its heartbeat lapsed");
    }
    if (beaten.status !== "running") {
      return this.stopReply(`the run is already recorded as ${beaten.status}`);
    }

    await this.touchLastSeen(agentId, now);
    return {
      directive: "continue",
      reclaimAfterSeconds: this.settings.reclaimAfterSeconds,
    };
  }

  /**
   * Record how an episode ended, and what it cost.
   *
   * Accepted whatever the agent's status is now. The work already happened;
   * refusing to write down how it ended because the agent has since been
   * contained would lose the outcome and the spend, leave the run open until
   * the sweep guessed at it, and punish the one thing a misbehaving agent did
   * right. The agent's status at the time is recorded in the audit entry, so an
   * operator reviewing a containment can see what arrived afterwards.
   */
  async finish(input: FinishRunInput): Promise<ExternalRun> {
    const agent = await this.requireAgent(input.agentId);
    const run = await this.requireRun(input.runId);
    const now = this.clock.nowIso();

    if (run.agentId !== input.agentId) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `External run ${input.runId} does not belong to agent ${input.agentId}.`,
        { agentId: input.agentId, runId: input.runId },
      );
    }
    if (run.status !== "running") {
      // The operating-record run is already closed, and a finished run is
      // history. Re-closing it would rewrite an outcome somebody may already
      // have acted on.
      throw new DeniedError(
        "record.unavailable",
        `External run ${input.runId} is already recorded as ${run.status} and cannot be finished again. If it was reclaimed, its outcome is that nobody heard from it.`,
        { runId: input.runId, status: run.status },
      );
    }
    if (input.outcome !== "succeeded" && input.outcome !== "failed") {
      throw new InvalidInputError(
        `"${String(input.outcome)}" is not a run outcome; use "succeeded" or "failed".`,
        "outcome",
      );
    }

    const costUsd = boundedMoney("costUsd", input.costUsd, this.settings.maxRunCostUsd);
    const summary =
      input.summary === undefined
        ? undefined
        : screenedText("summary", input.summary, MAX_OUTCOME_LENGTH);

    const finished = await this.runs.finishExternalRun({
      id: input.runId,
      status: input.outcome === "succeeded" ? "finished" : "failed",
      at: now,
      outcome: summary ?? input.outcome,
      costUsd,
    });
    if (!finished) {
      throw new DeniedError(
        "record.unavailable",
        `External run ${input.runId} could not be closed; it changed underneath this call.`,
        { runId: input.runId },
      );
    }

    // Cost onto the operating record first, then the meter. The record is the
    // source of truth and the meter is derived accounting: a run whose cost has
    // not yet reached the meter is visible and reconcilable from the record,
    // whereas a meter that moved for a run nobody can find is a charge the
    // paying team cannot be shown the basis for.
    if (costUsd > 0) {
      await this.record.recordCost({
        runId: finished.runId,
        category: "compute",
        amountUsd: costUsd,
        recordedAt: now,
        detail: {
          principal: "external",
          externalAgentId: agent.id,
          externalRunId: finished.id,
          // Unattributed by construction, and labelled so rather than left to
          // be inferred from a missing `stepId`. A live run reports one figure
          // when it finishes and no step trail at all — there is nothing here
          // to attribute it to — so the run detail shows the whole amount as
          // unattributed instead of as a header no row accounts for.
          attribution: COST_ATTRIBUTION.unattributed,
        },
      });
      await this.spend.addSpend(
        agent.id,
        budgetPeriodKey(agent.budgetPeriod, now),
        costUsd,
        now,
      );
    }

    await this.closeRecordRun(
      finished.runId,
      input.outcome === "succeeded" ? "succeeded" : "failed",
      now,
      summary ?? input.outcome,
    );

    await this.audit.record(
      decision({
        eventType: "run.ended",
        actorId: agent.id,
        actorKind: "service",
        actorRoles: externalPrincipal(agent).roles,
        runId: finished.runId,
        correlationId: finished.correlationId,
        subject: externalSubject(agent, { externalRunId: finished.id }),
        decision: {
          external: true,
          outcome: input.outcome,
          costUsd,
          agentStatus: agent.status,
        },
      }),
    );

    await this.touchLastSeen(agent.id, now);
    return finished;
  }

  /**
   * Reclaim runs that stopped heartbeating.
   *
   * A run that has gone quiet is not assumed healthy. It is closed on the
   * operating record as cancelled, with an outcome that says plainly that
   * nobody heard from it — which is a different and more honest statement than
   * "failed", because we do not know that it failed. We know only that we
   * stopped being told.
   *
   * Failures propagate rather than being collected: a sweep that could not
   * close a run must not report that it did. The scheduler runs it again.
   */
  async reclaimStale(limit = 100): Promise<readonly ExternalRun[]> {
    const now = this.clock.now();
    const cutoff = new Date(now - this.settings.reclaimAfterSeconds * 1000).toISOString();
    const nowIso = new Date(now).toISOString();

    const stale = await this.runs.findStaleRuns(cutoff, limit);
    const reclaimed: ExternalRun[] = [];

    for (const run of stale) {
      const outcome = `reclaimed: no heartbeat since ${run.lastHeartbeatAt}`;
      const closed = await this.runs.finishExternalRun({
        id: run.id,
        status: "reclaimed",
        at: nowIso,
        outcome,
      });
      // A run somebody else closed between the query and this write is not an
      // error; it is the outcome we wanted, reached by another route.
      if (!closed) continue;

      await this.closeRecordRun(run.runId, "cancelled", nowIso, outcome);

      const agent = await this.agents.getAgent(run.agentId);
      await this.audit.record(
        decision({
          eventType: "run.ended",
          actorId: run.agentId,
          actorKind: "service",
          actorRoles: [EXTERNAL_PRINCIPAL_ROLE],
          runId: run.runId,
          correlationId: run.correlationId,
          subject: agent
            ? externalSubject(agent, { externalRunId: run.id })
            : { principal: "external", externalAgentId: run.agentId, externalRunId: run.id },
          decision: {
            external: true,
            outcome: "reclaimed",
            reclaimed: true,
            lastHeartbeatAt: run.lastHeartbeatAt,
            reclaimAfterSeconds: this.settings.reclaimAfterSeconds,
          },
        }),
      );

      reclaimed.push(closed);
    }

    return reclaimed;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private stopReply(reason: string): HeartbeatReply {
    return {
      directive: "stop",
      reason,
      // Still stated, so an agent that ignores the directive and keeps beating
      // is told the same thing about when it will be reclaimed. A field that
      // vanished on the stop path would be one more branch in somebody else's
      // client to get wrong.
      reclaimAfterSeconds: this.settings.reclaimAfterSeconds,
    };
  }

  /** Close both halves of a run the kill switch has just stopped. */
  private async stopRun(
    agent: EnrolledAgent,
    run: ExternalRun,
    reason: string,
    at: IsoTimestamp,
  ): Promise<void> {
    const closed = await this.runs.finishExternalRun({
      id: run.id,
      status: "stopped",
      at,
      outcome: `stopped: ${reason}`,
    });
    if (!closed) return;

    await this.closeRecordRun(run.runId, "cancelled", at, `stopped: ${reason}`);

    await this.audit.record(
      decision({
        eventType: "run.ended",
        actorId: agent.id,
        actorKind: "service",
        actorRoles: externalPrincipal(agent).roles,
        runId: run.runId,
        correlationId: run.correlationId,
        subject: externalSubject(agent, { externalRunId: run.id }),
        decision: {
          external: true,
          outcome: "stopped",
          directive: "stop",
          agentStatus: agent.status,
          reason,
        },
      }),
    );
  }

  private async closeRecordRun(
    runId: Id<"run">,
    status: RunStatus,
    endedAt: IsoTimestamp,
    outcome: string,
  ): Promise<void> {
    await this.record.patchRun(runId, { status, endedAt, outcome });
  }

  private async requireAgent(id: ExternalAgentId): Promise<EnrolledAgent> {
    const agent = await this.agents.getAgent(id);
    if (!agent) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `No external agent is enrolled under ${id}. Enrollment is the basis of admission, so an unknown caller is refused rather than treated as a new one.`,
        { agentId: id },
      );
    }
    return agent;
  }

  private async requireRun(id: Id<"externalRun">): Promise<ExternalRun> {
    const run = await this.runs.getExternalRun(id);
    if (!run) {
      throw new DeniedError("record.unavailable", `External run ${id} is not in the record.`, {
        runId: id,
      });
    }
    return run;
  }

  /**
   * Record that we heard from this agent.
   *
   * Best-effort, and last. "When did we last hear from this agent" is a useful
   * column in the roster and nothing depends on it, so a failure to write it
   * must not undo a run that was started or an outcome that was recorded.
   */
  private async touchLastSeen(id: ExternalAgentId, at: IsoTimestamp): Promise<void> {
    try {
      await this.agents.touchLastSeen(id, at);
    } catch {
      // allow-swallow: this is a freshness column in the roster, not a control.
      // Raising here would turn a cosmetic write failure into a refused
      // heartbeat, and a refused heartbeat is a stopped agent — a far larger
      // consequence than a stale "last seen" cell.
    }
  }
}

function assertSettings(settings: LiveRunSettings): LiveRunSettings {
  if (!settings || typeof settings !== "object") {
    throw new DeniedError(
      "config.invalid",
      "Live external runs need settings. Without a reclaim window, a run that goes quiet is never reclaimed and the console keeps reporting work nobody is doing.",
      {},
    );
  }
  if (
    typeof settings.reclaimAfterSeconds !== "number" ||
    !Number.isFinite(settings.reclaimAfterSeconds) ||
    settings.reclaimAfterSeconds <= 0
  ) {
    throw new DeniedError(
      "config.invalid",
      `reclaimAfterSeconds must be a positive number, received: ${String(settings.reclaimAfterSeconds)}.`,
      { field: "reclaimAfterSeconds" },
    );
  }
  if (
    typeof settings.maxRunCostUsd !== "number" ||
    !Number.isFinite(settings.maxRunCostUsd) ||
    settings.maxRunCostUsd <= 0
  ) {
    throw new DeniedError(
      "config.invalid",
      `maxRunCostUsd must be a positive number, received: ${String(settings.maxRunCostUsd)}.`,
      { field: "maxRunCostUsd" },
    );
  }
  if (typeof settings.operatingMode !== "string" || settings.operatingMode.length === 0) {
    throw new DeniedError(
      "config.invalid",
      "operatingMode must name the deployment's rung on the rollout ladder; external work is recorded under the same mode as native work.",
      { field: "operatingMode" },
    );
  }
  return settings;
}
