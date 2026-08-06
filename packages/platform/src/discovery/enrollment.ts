import type { AuditLog } from "../audit/log.js";
import { decision } from "../audit/log.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";
import { assertApplicationKey, assertNotBlocked, assertReference } from "./exclusions.js";
import type { DiscoveryStore } from "./port.js";
import { assertRetentionWithinCeiling, type DiscoverySettings } from "./retention.js";
import type {
  ApplicationKey,
  CollectorSession,
  Enrollment,
  ErasureResult,
  SessionEndReason,
} from "./types.js";

/**
 * Enrollment, and the controls that belong to the observed person.
 *
 * The second of the three gates lives here: nothing is observed unless a named
 * person and a named device are enrolled, with a positive allowlist of
 * applications. An empty allowlist is a legal enrollment that observes nothing,
 * which is the state somebody should be able to sit in while they decide.
 *
 * **Only the observed person can act on their own enrollment.** Enrolling,
 * pausing, resuming, stopping, revoking, and erasing all require the acting
 * actor to *be* the subject. There is no administrator override, no support
 * path, and no role that grants it — deliberately, and more strictly than any
 * resolved policy requires, because whether observation is opt-in per person is
 * one of the questions ADR 0012 lists as unanswered. Building the permissive
 * version first and tightening it later means shipping the permissive version
 * if the schedule slips.
 *
 * **Which way the receipt goes.** For most of this platform the audit entry is
 * written before the effect, so an effect that lands is always recorded. Here
 * that rule is inverted for the operations that *protect* the person:
 *
 *   - Enrolling exposes someone to observation, so the receipt is written
 *     first. If the enrollment write then fails, the chain over-records an
 *     enrollment that does not exist, and nothing is observed. Safe direction.
 *   - Revoking and erasing protect someone, so the effect happens first. If the
 *     receipt then fails, the caller still gets a denial and an operator still
 *     gets an incident — but the person's data is already gone. Refusing to
 *     erase because the audit log is unreachable would mean retaining data
 *     somebody asked to have destroyed, in the name of record-keeping. That is
 *     the wrong way round.
 *
 * **What is not audited.** Pause, resume, and stop write nothing to the chain.
 * The audit log is retained for seven years; discovery data for at most thirty
 * days. A durable, queryable record of when an employee paused their own
 * monitoring is itself monitoring, and a more sensitive kind — it is a log of
 * someone exercising a privacy right. The session row carries `endedAt` and
 * `endedReason` for as long as the session exists, which is what an operator
 * needs to see that the control worked.
 */
export interface EnrollRequest {
  readonly subjectRef: string;
  readonly deviceRef: string;
  /** Applications this person agrees to have observed. May be empty. */
  readonly applicationAllowlist: readonly ApplicationKey[];
  /** Reference to the written notice the person was given. */
  readonly noticeReference: string;
  readonly noticeAcknowledgedAt: IsoTimestamp;
  /** Optional shorter retention. Never longer: the ceiling is in code. */
  readonly retentionDays?: number | undefined;
}

/** What one person can see about what is held on them. */
export interface SubjectSummary {
  readonly subjectRef: string;
  readonly enrollments: readonly Enrollment[];
  readonly openSessions: number;
  readonly observations: number;
  readonly retentionDays: number;
}

export class EnrollmentService {
  constructor(
    private readonly store: DiscoveryStore,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly settings: DiscoverySettings,
  ) {}

  /**
   * Enroll oneself, for one device, with a positive application allowlist.
   *
   * @throws {DeniedError} `discovery.feature_disabled` when the feature is off,
   *   `authorization.action_not_permitted` when the actor is not the subject,
   *   `discovery.excluded_field` when the allowlist names a blocked application.
   */
  async enroll(actor: ActorRef, request: EnrollRequest): Promise<Enrollment> {
    this.assertFeatureEnabled();
    assertReference("subjectRef", request.subjectRef);
    assertReference("deviceRef", request.deviceRef);

    if (typeof request.noticeReference !== "string" || request.noticeReference.trim() === "") {
      throw new InvalidInputError(
        "An enrollment must name the written notice the person was given. Without it the record cannot answer 'which notice, given when', which is the first question every electronic-monitoring regime asks.",
        "noticeReference",
      );
    }
    if (typeof request.noticeAcknowledgedAt !== "string") {
      throw new InvalidInputError(
        "An enrollment must record when the person acknowledged the notice.",
        "noticeAcknowledgedAt",
      );
    }

    // Self-enrollment only. See the class comment: nobody enrolls anybody else.
    //
    // A subject reference is pseudonymous, so nothing outside this module can
    // say who it belongs to. The binding is established by the first
    // enrollment — whoever claims a reference owns it — and enforced from then
    // on. That is weaker than a directory lookup would be and strictly
    // stronger than trusting the caller, and it means the only way to reach
    // another person's enrollment is to have been the one who created it.
    await this.assertReferenceUnclaimed(actor, request.subjectRef);

    const allowlist = this.normaliseAllowlist(request.applicationAllowlist);

    const retentionDays = request.retentionDays ?? this.settings.retentionDays;
    assertRetentionWithinCeiling(retentionDays, "enrollment");

    const now = this.clock.nowIso();
    const existing = await this.store.getEnrollment(request.subjectRef, request.deviceRef);

    const enrollment: Enrollment = {
      subjectRef: request.subjectRef,
      subjectActorId: actor.actorId,
      deviceRef: request.deviceRef,
      state: "active",
      applicationAllowlist: allowlist,
      retentionDays,
      noticeReference: request.noticeReference,
      noticeAcknowledgedAt: request.noticeAcknowledgedAt,
      enrolledAt: existing?.enrolledAt ?? now,
      updatedAt: now,
    };

    // Receipt before effect: enrolling exposes someone to observation.
    await this.audit.record(
      decision({
        eventType: "discovery.enrolled",
        actorId: actor.actorId,
        actorKind: actor.kind,
        actorRoles: actor.roles,
        subject: { module: "discovery" },
        // Fingerprints rather than references. The chain is retained for seven
        // years and discovery data for at most thirty days; a chain that named
        // the subject would outlive the erasure it is supposed to evidence and
        // would be a durable list of who was monitored. A holder of the
        // reference can still verify by recomputing the digest.
        inputDigests: {
          subject: digestValue(request.subjectRef),
          device: digestValue(request.deviceRef),
          allowlist: digestValue(allowlist),
          notice: digestValue(request.noticeReference),
        },
        decision: {
          applications: allowlist.length,
          retentionDays,
          renewal: existing !== null,
          observesNothing: allowlist.length === 0,
        },
      }),
    );

    return this.store.putEnrollment(enrollment);
  }

  /** Suspend observation. Resumable by the same person, nobody else. */
  async pause(actor: ActorRef, subjectRef: string, deviceRef: string): Promise<Enrollment> {
    const enrollment = await this.requireOwnEnrollment(actor, subjectRef, deviceRef);
    if (enrollment.state === "revoked") return enrollment;
    // Effect first, and the sessions close before the state changes, so there
    // is no instant in which the enrollment reads "paused" while a collector is
    // still open against it.
    await this.closeOpenSessions(subjectRef, "paused_by_subject");
    return this.store.setEnrollmentState(subjectRef, deviceRef, "paused", this.clock.nowIso());
  }

  /**
   * Resume a paused enrollment.
   *
   * Resuming does not restart collection. The third gate is a deliberately
   * started collector, and coming back from a pause is not that — a person who
   * unpauses and walks away is not consenting to be observed by a collector
   * they never started.
   *
   * @throws {DeniedError} `discovery.not_enrolled` if the enrollment was revoked.
   */
  async resume(actor: ActorRef, subjectRef: string, deviceRef: string): Promise<Enrollment> {
    this.assertFeatureEnabled();
    const enrollment = await this.requireOwnEnrollment(actor, subjectRef, deviceRef);
    if (enrollment.state === "revoked") {
      throw new DeniedError(
        "discovery.not_enrolled",
        "A revoked enrollment cannot be resumed. Opting back in is a fresh enrollment, which is another deliberate act by the same person rather than a state transition somebody could perform on their behalf.",
        { gate: "enrollment", subjectRef, deviceRef, state: enrollment.state },
      );
    }
    return this.store.setEnrollmentState(subjectRef, deviceRef, "active", this.clock.nowIso());
  }

  /**
   * Stop the running collector immediately.
   *
   * The enrollment survives; the collection window does not. Idempotent, so a
   * second press is not an error — somebody pressing stop twice must never be
   * shown a message that suggests the first press did not take.
   */
  async stop(actor: ActorRef, subjectRef: string, deviceRef: string): Promise<number> {
    await this.requireOwnEnrollment(actor, subjectRef, deviceRef);
    return this.closeOpenSessions(subjectRef, "stopped_by_subject");
  }

  /**
   * End the enrollment permanently.
   *
   * Terminal. Observation cannot resume without a fresh enrollment by the same
   * person. Existing observations remain until retention expires — revocation
   * stops collection, erasure destroys what was collected, and they are
   * separate acts because someone may want the first without the second.
   */
  async revoke(actor: ActorRef, subjectRef: string, deviceRef: string): Promise<Enrollment> {
    const enrollment = await this.requireOwnEnrollment(actor, subjectRef, deviceRef);

    // Effect before receipt: revocation protects the person, so an unreachable
    // audit log must not keep the collector running.
    await this.closeOpenSessions(subjectRef, "revoked_by_subject");
    const revoked = await this.store.setEnrollmentState(
      subjectRef,
      deviceRef,
      "revoked",
      this.clock.nowIso(),
    );

    await this.audit.record(
      decision({
        eventType: "discovery.revoked",
        actorId: actor.actorId,
        actorKind: actor.kind,
        actorRoles: actor.roles,
        subject: { module: "discovery" },
        inputDigests: {
          subject: digestValue(subjectRef),
          device: digestValue(deviceRef),
        },
        decision: {
          previousState: enrollment.state,
          bySubject: true,
        },
      }),
    );

    return revoked;
  }

  /**
   * Destroy everything held about this person, now.
   *
   * Observations, sessions, and enrollments, in one store operation. Nothing is
   * tombstoned and nothing is retained "for audit": a tombstone naming the
   * person is a record of the person, which is what was asked to be destroyed.
   * The audit entry records counts and a fingerprint, never the reference.
   */
  async erase(actor: ActorRef, subjectRef: string): Promise<ErasureResult> {
    assertReference("subjectRef", subjectRef);
    const enrollments = await this.store.listEnrollments(subjectRef);
    const owned = enrollments.find((entry) => entry.subjectActorId === actor.actorId);
    if (!owned) {
      // The identity check is the enrollment. With none present there is
      // nothing to erase and no way to establish that the caller is the
      // subject, and inventing an administrator path here would be a way to
      // reach one person's data by naming their reference.
      throw new DeniedError(
        "authorization.action_not_permitted",
        "Erasure is performed by the observed person against their own enrollment. No enrollment for this reference names the calling actor, so there is nothing this actor may erase.",
        { actorId: actor.actorId, subjectRef },
      );
    }

    const result = await this.store.eraseSubject(subjectRef);

    await this.audit.record(
      decision({
        eventType: "discovery.erased",
        actorId: actor.actorId,
        actorKind: actor.kind,
        actorRoles: actor.roles,
        subject: { module: "discovery" },
        inputDigests: { subject: digestValue(subjectRef) },
        decision: {
          observationsErased: result.observationsErased,
          sessionsErased: result.sessionsErased,
          enrollmentsErased: result.enrollmentsErased,
          bySubject: true,
        },
      }),
    );

    return result;
  }

  /** What is held about one person, for that person. */
  async summarise(actor: ActorRef, subjectRef: string): Promise<SubjectSummary> {
    assertReference("subjectRef", subjectRef);
    const enrollments = await this.store.listEnrollments(subjectRef);
    const owned = enrollments.find((entry) => entry.subjectActorId === actor.actorId);
    if (!owned) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        "A work-discovery summary is readable by the observed person alone.",
        { actorId: actor.actorId, subjectRef },
      );
    }

    const openSessions = await this.store.listSessions(subjectRef, true);
    const observations = await this.store.countObservations({ subjectRef });

    return {
      subjectRef,
      enrollments,
      openSessions: openSessions.length,
      observations,
      retentionDays: owned.retentionDays,
    };
  }

  private assertFeatureEnabled(): void {
    if (!this.settings.enabled) {
      throw new DeniedError(
        "discovery.feature_disabled",
        "Work discovery is disabled. It ships disabled and stays disabled until the employment-law questions in docs/adr/0012-work-discovery-default-off.md are answered in writing.",
        { gate: "feature_enabled" },
      );
    }
  }

  /**
   * Refuse if this reference already belongs to somebody else.
   *
   * One reference is one person. Two actors behind one reference would mean
   * either of them could erase the other's data, or read a summary of it.
   */
  private async assertReferenceUnclaimed(actor: ActorRef, subjectRef: string): Promise<void> {
    const existing = await this.store.listEnrollments(subjectRef);
    const foreign = existing.find((entry) => entry.subjectActorId !== actor.actorId);
    if (foreign) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        "This work-discovery subject reference is already enrolled by a different actor. Enrollment is performed by the observed person for themselves; there is no administrator path, deliberately, because whether observation is opt-in per person is an open legal question and the safe answer until it is settled in writing is that only the person can opt in.",
        { actorId: actor.actorId, subjectRef },
      );
    }
  }

  /**
   * Check every application on a proposed allowlist.
   *
   * Normalised names only, the blocklist floor applied, duplicates collapsed,
   * and the result sorted so that two enrollments naming the same applications
   * in different orders produce the same record and the same digest in the
   * audit chain.
   */
  private normaliseAllowlist(
    applications: readonly ApplicationKey[],
  ): readonly ApplicationKey[] {
    if (!Array.isArray(applications)) {
      throw new InvalidInputError(
        "An enrollment allowlist must be an array of normalised application names. It may be empty, which observes nothing.",
        "applicationAllowlist",
      );
    }
    const unique = new Set<ApplicationKey>();
    for (const [index, application] of applications.entries()) {
      assertApplicationKey(`applicationAllowlist[${index}]`, application);
      // The floor beats the allowlist here, at the moment somebody tries to put
      // a blocked application on it, and again at every observation in case an
      // entry was added to the floor after this enrollment was written.
      assertNotBlocked(application);
      unique.add(application);
    }
    return Object.freeze([...unique].sort());
  }

  private async requireOwnEnrollment(
    actor: ActorRef,
    subjectRef: string,
    deviceRef: string,
  ): Promise<Enrollment> {
    assertReference("subjectRef", subjectRef);
    assertReference("deviceRef", deviceRef);
    const enrollment = await this.store.getEnrollment(subjectRef, deviceRef);
    if (!enrollment) {
      throw new DeniedError(
        "discovery.not_enrolled",
        `No work-discovery enrollment exists for device ${deviceRef}.`,
        { gate: "enrollment", subjectRef, deviceRef },
      );
    }
    if (enrollment.subjectActorId !== actor.actorId) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        "Pause, stop, revoke, and erase belong to the observed person. There is no administrator path to another person's enrollment.",
        { actorId: actor.actorId, subjectRef, deviceRef },
      );
    }
    return enrollment;
  }

  /** Close every open collector session for a subject. Returns how many. */
  private async closeOpenSessions(subjectRef: string, reason: SessionEndReason): Promise<number> {
    const open: readonly CollectorSession[] = await this.store.listSessions(subjectRef, true);
    const endedAt = this.clock.nowIso();
    for (const session of open) {
      await this.store.endSession(session.id, endedAt, reason);
    }
    return open.length;
  }
}
