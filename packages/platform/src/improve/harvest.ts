import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { Authorizer } from "../guard/authorize.js";
import type { Clock } from "../kernel/clock.js";
import { InvalidInputError } from "../kernel/errors.js";
import { digestValue, isDigest, type Digest } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import { redactText } from "../kernel/redact.js";
import type { RunStore } from "../record/port.js";
import type { ActorRef, OperatingMode } from "../record/types.js";
import { OBSERVE_ACTION } from "./actions.js";
import type { AppendObservationResult, ObservationStore } from "./port.js";
import {
  OBSERVATION_KINDS,
  type Observation,
  type ObservationFilter,
  type ObservationKind,
} from "./types.js";

/**
 * Stage one: harvest.
 *
 * Every human correction, rejected proposal, approval override, escalation, and
 * shadow-mode disagreement becomes a structured `Observation` tied to the run
 * that produced it. That tie is the point. A correction with no run behind it
 * cannot be checked — there is no way to see what the platform was asked, what
 * it answered, what it cost, or which role and version produced it — and the
 * whole of the rest of the loop reasons from exactly those facts.
 *
 * Three things here are controls rather than plumbing.
 *
 * *The run is read, not taken on trust.* The workflow kind, the role, and the
 * money already spent come out of the operating record, not out of the caller's
 * arguments. A caller that could assert its own cost figure could steer the
 * ranking in stage two by inflating one, and the ranking is what decides whose
 * problem a person looks at first.
 *
 * *Recording is idempotent.* The store deduplicates on `idempotencyKey`, which
 * is derived from the run, the kind, the step, and the fingerprints of the
 * before and after. A console that retries a submission, or two operators
 * recording the same correction, must not double the frequency a cluster
 * reports.
 *
 * *The note is redacted and the payloads are not stored.* What the platform
 * produced and what the human replaced it with are recorded as digests. The
 * texts stay in the systems whose retention rules govern them; this record
 * proves the linkage, and is not a second copy of the work.
 */

/** Signatures are a controlled vocabulary, not free text. See `signature`. */
const SIGNATURE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9][a-z0-9_]*)*$/;

const MAX_SIGNATURE_LENGTH = 96;
const MAX_NOTE_LENGTH = 500;
const MAX_CORRECTION_MINUTES = 24 * 60;

export interface ObserveInput {
  readonly kind: ObservationKind;
  /** The run this disagreement happened on. Required; see the module comment. */
  readonly runId: Id<"run">;
  /**
   * Machine-readable failure signature, e.g. `deadline.wrong_jurisdiction`.
   *
   * A controlled vocabulary the operator maintains rather than free text,
   * because clustering groups on it: a prose summary produces one cluster per
   * typist and nothing recurs.
   */
  readonly signature: string;
  /** One line for the person who will read the cluster. Redacted on the way in. */
  readonly note: string;
  /** Whose disagreement this was. */
  readonly observedBy: ActorRef;
  readonly mode: OperatingMode;
  readonly stepId?: Id<"step"> | undefined;
  readonly roleId?: Id<"role"> | undefined;
  readonly roleVersion?: number | undefined;
  /**
   * What the platform produced, and what the human replaced it with.
   *
   * Fingerprinted here and discarded. Pass the value, not a digest; passing a
   * digest of a digest would make two identical corrections look different.
   */
  readonly before?: unknown;
  readonly after?: unknown;
  /** Minutes of human time the correction cost. Half the ranking signal. */
  readonly correctionMinutes?: number | undefined;
  /** Opaque references. Never owner personal data. */
  readonly subject?: Readonly<Record<string, string>> | undefined;
  /** Overrides the derived key when the caller has a better one. */
  readonly idempotencyKey?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export interface ObservationHarvesterDependencies {
  readonly observations: ObservationStore;
  readonly runs: RunStore;
  readonly authorizer: Authorizer;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class ObservationHarvester {
  constructor(private readonly deps: ObservationHarvesterDependencies) {}

  /**
   * Record one disagreement.
   *
   * @throws {InvalidInputError} on a malformed signature, note, or duration.
   * @throws {DeniedError} when the run is not in the operating record, or when
   *   the chokepoint refuses. An observation the platform cannot tie to a run
   *   is refused rather than recorded unattached.
   */
  async observe(input: ObserveInput): Promise<AppendObservationResult> {
    assertSignature(input.signature);
    const note = assertNote(input.note);
    const correctionMinutes = assertMinutes(input.correctionMinutes ?? 0);
    if (!OBSERVATION_KINDS.includes(input.kind)) {
      throw new InvalidInputError(
        `"${String(input.kind)}" is not an observation kind. The loop learns from: ${OBSERVATION_KINDS.join(", ")}.`,
        "kind",
      );
    }

    // Read the run first. An observation that names a run the operating record
    // does not have is either a typo or an attempt to attribute a correction to
    // work that never happened, and both are refused before anything is written.
    const run = await this.deps.runs.requireRun(input.runId);
    const cost = await this.deps.runs.costForRun(input.runId);

    await this.deps.authorizer.authorize({
      action: OBSERVE_ACTION,
      actor: input.observedBy,
      mode: input.mode,
      runId: input.runId,
      correlationId: input.correlationId,
      subject: {
        runKind: run.kind,
        signature: input.signature,
        observationKind: input.kind,
      },
      secondsSinceAuthentication: input.secondsSinceAuthentication,
    });

    const beforeDigest = fingerprint(input.before);
    const afterDigest = fingerprint(input.after);

    const observation: Observation = {
      id: this.deps.ids.next("observation"),
      kind: input.kind,
      runId: input.runId,
      stepId: input.stepId,
      // Taken from the record rather than the caller: the run knows which role
      // produced it, and a caller that could assert otherwise could point a
      // cluster at the wrong role.
      roleId: input.roleId ?? run.roleId,
      roleVersion: input.roleVersion ?? run.roleVersion,
      workflowKind: run.kind,
      signature: input.signature,
      note,
      observedBy: input.observedBy,
      recordedAt: this.deps.clock.nowIso(),
      beforeDigest,
      afterDigest,
      correctionMinutes,
      costUsd: cost.totalUsd,
      subject: { ...(input.subject ?? {}) },
      idempotencyKey:
        input.idempotencyKey ??
        observationKey({
          runId: input.runId,
          kind: input.kind,
          signature: input.signature,
          stepId: input.stepId,
          beforeDigest,
          afterDigest,
        }),
    };

    const result = await this.deps.observations.appendObservation(observation);

    // Only a first recording goes into the chain. Writing an entry for a
    // deduplicated retry would make the audit log say the correction happened
    // twice, which is the very thing the deduplication exists to stop.
    if (result.recorded) {
      await this.deps.audit.record(
        auditDecision({
          eventType: "improvement.observation_recorded",
          actorId: input.observedBy.actorId,
          actorKind: input.observedBy.kind,
          actorRoles: input.observedBy.roles,
          runId: input.runId,
          correlationId: input.correlationId,
          subject: {
            observationId: result.observation.id,
            signature: input.signature,
            runKind: run.kind,
            ...(result.observation.roleId ? { roleId: result.observation.roleId } : {}),
          },
          inputDigests: {
            ...(beforeDigest ? { before: beforeDigest } : {}),
            ...(afterDigest ? { after: afterDigest } : {}),
          },
          decision: {
            observationKind: input.kind,
            correctionMinutes,
            runCostUsd: cost.totalUsd,
            ...(result.observation.roleVersion !== undefined
              ? { roleVersion: result.observation.roleVersion }
              : {}),
          },
        }),
      );
    }

    return result;
  }

  /** A person changed what the platform produced before it was used. */
  correction(input: Omit<ObserveInput, "kind">): Promise<AppendObservationResult> {
    return this.observe({ ...input, kind: "human_correction" });
  }

  /** An approver refused a parked action outright. */
  rejectedProposal(input: Omit<ObserveInput, "kind">): Promise<AppendObservationResult> {
    return this.observe({ ...input, kind: "proposal_rejected" });
  }

  /** An approver granted the action but altered what it would do. */
  approvalOverride(input: Omit<ObserveInput, "kind">): Promise<AppendObservationResult> {
    return this.observe({ ...input, kind: "approval_override" });
  }

  /** Work that was meant to complete came back to a human instead. */
  escalation(input: Omit<ObserveInput, "kind">): Promise<AppendObservationResult> {
    return this.observe({ ...input, kind: "escalation" });
  }

  /** A shadow-mode run reached a different answer than the human did. */
  shadowDisagreement(input: Omit<ObserveInput, "kind">): Promise<AppendObservationResult> {
    return this.observe({ ...input, kind: "shadow_disagreement" });
  }

  list(filter?: ObservationFilter): Promise<readonly Observation[]> {
    return this.deps.observations.listObservations(filter);
  }

  count(filter?: ObservationFilter): Promise<number> {
    return this.deps.observations.countObservations(filter);
  }
}

/**
 * The deduplication key.
 *
 * Covers what makes two records the same event: the run, the kind, the step,
 * and the fingerprints of what changed. Two genuinely different corrections on
 * the same step differ in their `after`, so they survive as two.
 */
export function observationKey(input: {
  readonly runId: string;
  readonly kind: ObservationKind;
  readonly signature: string;
  readonly stepId?: string | undefined;
  readonly beforeDigest?: Digest | undefined;
  readonly afterDigest?: Digest | undefined;
}): string {
  return digestValue({
    runId: input.runId,
    kind: input.kind,
    signature: input.signature,
    stepId: input.stepId ?? "",
    beforeDigest: input.beforeDigest ?? "",
    afterDigest: input.afterDigest ?? "",
  });
}

function fingerprint(value: unknown): Digest | undefined {
  if (value === undefined || value === null) return undefined;
  // A caller that already hashed the material passes the digest straight
  // through, so a digest of a digest cannot make two identical corrections look
  // like different ones.
  if (typeof value === "string" && isDigest(value)) return value;
  return digestValue(value);
}

export function assertSignature(signature: string): void {
  if (typeof signature !== "string" || signature.length === 0) {
    throw new InvalidInputError(
      "An observation needs a failure signature: the machine-readable name of what went wrong, e.g. \"deadline.wrong_jurisdiction\".",
      "signature",
    );
  }
  if (signature.length > MAX_SIGNATURE_LENGTH) {
    throw new InvalidInputError(
      `Signature is ${signature.length} characters, past the ${MAX_SIGNATURE_LENGTH}-character limit. A signature names a failure; the detail goes in the note.`,
      "signature",
    );
  }
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new InvalidInputError(
      `Signature "${signature}" must be dotted lower_snake_case. Clustering groups on it, so free text produces one cluster per typist and nothing ever recurs.`,
      "signature",
    );
  }
}

function assertNote(note: string): string {
  if (typeof note !== "string" || note.trim().length === 0) {
    throw new InvalidInputError(
      "An observation needs a one-line note. It is what the person triaging the cluster reads.",
      "note",
    );
  }
  if (note.length > MAX_NOTE_LENGTH) {
    throw new InvalidInputError(
      `Note is ${note.length} characters, past the ${MAX_NOTE_LENGTH}-character limit. The note explains the correction; it is not a copy of the work.`,
      "note",
    );
  }
  // Redacted rather than refused. A note is written by a person under time
  // pressure, and refusing it would lose the observation entirely; replacing a
  // secret-shaped fragment keeps the signal and drops the secret.
  return redactText(note).text;
}

function assertMinutes(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new InvalidInputError(
      "Correction minutes must be a non-negative number.",
      "correctionMinutes",
    );
  }
  if (minutes > MAX_CORRECTION_MINUTES) {
    // A single correction costing more than a day of one person's time is a
    // typo or an attempt to force a cluster to the top of the queue. Either
    // way it is refused rather than allowed to steer the ranking.
    throw new InvalidInputError(
      `Correction minutes of ${minutes} exceeds the ${MAX_CORRECTION_MINUTES}-minute ceiling for one correction.`,
      "correctionMinutes",
    );
  }
  return minutes;
}
