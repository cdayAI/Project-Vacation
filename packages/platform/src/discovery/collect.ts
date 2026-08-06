import type { Clock } from "../kernel/clock.js";
import { MINUTE } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import { assertNotBlocked, assertObservationInput, assertReference } from "./exclusions.js";
import type { DiscoveryStore } from "./port.js";
import { effectiveRetentionDays, retentionCutoff, type DiscoverySettings } from "./retention.js";
import type { CollectorSession, Enrollment, Observation, ObservationInput } from "./types.js";

/**
 * The collector: three gates, then a transition and its timing.
 *
 * Every one of these must hold before anything is observed, and each refuses
 * separately so an operator is told which one stopped them:
 *
 *   1. **The feature is enabled in configuration.** Defaults to false, ships
 *      false, and is checked first — with it off, a submitted observation is
 *      not even examined.
 *   2. **A named person and device are enrolled**, the enrollment is active,
 *      and the application is on its positive allowlist. An empty allowlist is
 *      a valid enrollment that observes nothing.
 *   3. **A collector was started deliberately**, by the observed person, and is
 *      still open.
 *
 * Beneath all three sits the blocklist floor, re-checked here on every
 * observation rather than trusted from enrollment time. An enrollment written
 * last month cannot keep observing an application that was added to the floor
 * last week.
 *
 * Two decisions in here are worth stating plainly.
 *
 * **Nothing is cached.** The enrollment and the session are read on every
 * observation. Caching either would be an obvious optimisation and would make
 * the stop button a suggestion: a person hits stop, the console says stopped,
 * and a collector holding a cached enrollment keeps writing until its entry
 * expires. The cost is a read per transition, on a feature that is disabled.
 *
 * **No observation is audited.** The audit chain is retained for seven years;
 * observations for at most thirty days. Writing one audit entry per transition
 * would build exactly the durable, queryable record of an employee's day that
 * the retention ceiling exists to prevent — and it would survive the person's
 * erasure. Enrollment, revocation, and erasure are audited, because those are
 * governance decisions about whether observation happens at all. What was
 * observed is not.
 */

/**
 * Tolerance for a device clock running ahead of the platform's.
 *
 * An observation timestamped in the future would sit past every retention
 * cut-off and never be purged, so future timestamps are refused — but refusing
 * a device that is thirty seconds fast would make the collector useless. Five
 * minutes is the compromise, and it is bounded rather than open.
 */
export const MAX_CLOCK_SKEW_MS = 5 * MINUTE;

export class DiscoveryCollector {
  constructor(
    private readonly store: DiscoveryStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly settings: DiscoverySettings,
  ) {}

  /**
   * Start a collection window. The third gate, and a deliberate act.
   *
   * @throws {DeniedError} `discovery.feature_disabled`, `discovery.not_enrolled`,
   *   or `authorization.action_not_permitted` when the starter is not the
   *   person who would be observed.
   */
  async start(
    actor: { readonly actorId: string },
    subjectRef: string,
    deviceRef: string,
  ): Promise<CollectorSession> {
    this.assertFeatureEnabled();
    assertReference("subjectRef", subjectRef);
    assertReference("deviceRef", deviceRef);

    const enrollment = await this.requireActiveEnrollment(subjectRef, deviceRef);
    if (enrollment.subjectActorId !== actor.actorId) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        "A work-discovery collector is started by the person who would be observed. Nobody starts a collector on somebody else's behalf.",
        { actorId: actor.actorId, subjectRef, deviceRef },
      );
    }

    const session: CollectorSession = {
      id: this.ids.next("session"),
      subjectRef,
      deviceRef,
      startedBy: actor.actorId,
      startedAt: this.clock.nowIso(),
      observationCount: 0,
    };
    return this.store.startSession(session);
  }

  /**
   * Record one application transition.
   *
   * `input` is `unknown` deliberately. Observations arrive from a device agent
   * across a process boundary, and typing this parameter would let a caller
   * assert its way past `assertObservationInput` — the one function standing
   * between this module and a screenshot.
   *
   * @throws {DeniedError} `discovery.feature_disabled`, `discovery.not_enrolled`
   *   (with `detail.gate` naming which gate refused), or
   *   `discovery.excluded_field` for anything outside the permitted shape.
   */
  async observe(
    actor: { readonly actorId: string },
    sessionId: Id<"session">,
    input: unknown,
  ): Promise<Observation> {
    // Gate 1 first, before the input is even examined. With the feature off the
    // honest answer is that nothing was looked at, not that the submission was
    // malformed.
    this.assertFeatureEnabled();

    assertObservationInput(input);
    const observation: ObservationInput = input;

    const session = await this.requireOpenSession(sessionId);
    if (session.startedBy !== actor.actorId) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        "Observations may only be submitted by the process the observed person started. A session id is not an authorisation to write into somebody else's stream.",
        { actorId: actor.actorId, sessionId },
      );
    }
    if (
      observation.subjectRef !== session.subjectRef ||
      observation.deviceRef !== session.deviceRef
    ) {
      throw new DeniedError(
        "discovery.not_enrolled",
        "The observation names a different person or device from the session it was submitted to.",
        { gate: "collector", sessionId },
      );
    }

    // Read fresh, every time. See the class comment: a cached enrollment turns
    // pause and revoke into suggestions.
    const enrollment = await this.requireActiveEnrollment(
      session.subjectRef,
      session.deviceRef,
    );

    this.assertObservable(enrollment, observation.fromApplication);
    this.assertObservable(enrollment, observation.toApplication);
    this.assertObservedAtWithinWindow(enrollment, observation.observedAt);

    const result = await this.store.appendObservation({
      id: this.ids.next("observation"),
      subjectRef: observation.subjectRef,
      deviceRef: observation.deviceRef,
      sessionId: session.id,
      fromApplication: observation.fromApplication,
      toApplication: observation.toApplication,
      observedAt: observation.observedAt,
      dwellMs: observation.dwellMs,
    });

    return result.observation;
  }

  /**
   * Delete everything past its retention period.
   *
   * The configured period is applied as a floor across every observation,
   * including any whose enrollment has since been erased, and then each
   * enrollment that chose a shorter period is purged again at its own cut-off.
   * Both cut-offs go through `effectiveRetentionDays`, so a stored value that
   * somehow exceeds the ceiling — a restore, a migration, a psql prompt — still
   * purges at thirty days.
   */
  async purgeExpired(): Promise<number> {
    const now = this.clock.now();

    let purged = await this.store.purgeObservationsBefore(
      retentionCutoff(now, this.settings.retentionDays),
    );

    for (const enrollment of await this.store.listEnrollments()) {
      const days = effectiveRetentionDays(enrollment.retentionDays);
      if (days >= effectiveRetentionDays(this.settings.retentionDays)) continue;
      purged += await this.store.purgeObservationsBefore(
        retentionCutoff(now, days),
        enrollment.subjectRef,
      );
    }

    return purged;
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

  private async requireActiveEnrollment(
    subjectRef: string,
    deviceRef: string,
  ): Promise<Enrollment> {
    const enrollment = await this.store.getEnrollment(subjectRef, deviceRef);
    if (!enrollment) {
      throw new DeniedError(
        "discovery.not_enrolled",
        `No work-discovery enrollment exists for device ${deviceRef}. Observation requires a named person and device to have enrolled themselves.`,
        { gate: "enrollment", subjectRef, deviceRef },
      );
    }
    if (enrollment.state !== "active") {
      throw new DeniedError(
        "discovery.not_enrolled",
        `The work-discovery enrollment for device ${deviceRef} is ${enrollment.state}. Only the observed person can make it active again.`,
        { gate: "enrollment", subjectRef, deviceRef, state: enrollment.state },
      );
    }
    return enrollment;
  }

  private async requireOpenSession(sessionId: Id<"session">): Promise<CollectorSession> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new DeniedError(
        "discovery.not_enrolled",
        "No collector session with that id. Observation requires a collector that somebody started deliberately.",
        { gate: "collector", sessionId },
      );
    }
    if (session.endedAt !== undefined) {
      throw new DeniedError(
        "discovery.not_enrolled",
        `That collector session ended (${session.endedReason ?? "closed"}). An observation arriving after the person stopped collection is refused, not queued.`,
        { gate: "collector", sessionId, endedReason: session.endedReason ?? "closed" },
      );
    }
    return session;
  }

  /** The allowlist, then the floor. Both, on every observation. */
  private assertObservable(enrollment: Enrollment, application: string): void {
    // The floor first, so the refusal names the real reason even when somebody
    // has managed to get a blocked application onto an allowlist.
    assertNotBlocked(application);

    if (!enrollment.applicationAllowlist.includes(application)) {
      throw new DeniedError(
        "discovery.not_enrolled",
        enrollment.applicationAllowlist.length === 0
          ? `Application "${application}" is not observed: this enrollment has an empty allowlist, which observes nothing.`
          : `Application "${application}" is not on this enrollment's allowlist. The allowlist is positive — an application that is not named is not observed.`,
        {
          gate: "allowlist",
          application,
          allowlistSize: enrollment.applicationAllowlist.length,
        },
      );
    }
  }

  /**
   * Refuse a timestamp outside the window this observation can live in.
   *
   * Both directions matter. A future timestamp sits beyond every retention
   * cut-off and would never be purged, which is how a bound gets evaded by
   * padding a field the validator has already accepted as well-formed. A
   * timestamp older than the retention window is data that should not exist,
   * arriving after the purge that would have removed it.
   */
  private assertObservedAtWithinWindow(enrollment: Enrollment, observedAt: string): void {
    const now = this.clock.now();
    const at = Date.parse(observedAt);

    if (at > now + MAX_CLOCK_SKEW_MS) {
      throw new DeniedError(
        "discovery.excluded_field",
        "An observation cannot be timestamped in the future. A future timestamp outlives every retention cut-off, which turns a thirty-day ceiling into no ceiling at all.",
        { field: "observedAt", skewMs: at - now },
      );
    }

    const cutoff = retentionCutoff(now, enrollment.retentionDays);
    if (observedAt < cutoff) {
      throw new DeniedError(
        "discovery.excluded_field",
        `An observation older than the ${effectiveRetentionDays(enrollment.retentionDays)}-day retention period is refused. It would be deleted by the next purge, and accepting it means briefly holding employee data past the period the person agreed to.`,
        { field: "observedAt", cutoff },
      );
    }
  }
}
