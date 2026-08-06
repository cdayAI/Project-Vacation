import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type {
  CollectorSession,
  Enrollment,
  EnrollmentState,
  ErasureResult,
  NewObservation,
  Observation,
  SessionEndReason,
} from "./types.js";

/**
 * Persistence port for work discovery.
 *
 * Three requirements shape this interface, and none of them can be met by a
 * read followed by a write in the caller.
 *
 * *The stop button must win.* `appendObservation` increments the session's
 * counter and inserts the row as one atomic operation, conditional on the
 * session still being open. A collector that checked "is the session open?" and
 * then wrote would leave a window in which the person hits stop and one more
 * observation lands anyway. It is a small window and a small amount of data,
 * and it is precisely the thing the control promises will not happen — so the
 * condition is evaluated by the store, under its lock, and an in-flight append
 * against a closed session is refused rather than written.
 *
 * *Erasure is one operation.* `eraseSubject` removes observations, sessions,
 * and the enrollment together. Erasing in three calls from the caller means a
 * crash between two of them leaves a person half-erased, which is worse than
 * not having started: the residue is exactly the record they asked to have
 * destroyed, and nobody is now looking for it.
 *
 * *A read that cannot be served must raise.* "No enrollment exists" and "the
 * enrollment store is unreachable" lead to opposite behaviour — the first is a
 * refusal to observe, the second is a refusal to observe *and* an incident —
 * and what neither may become is an observation. Adapters wrap failures with
 * `storeUnavailable()`.
 *
 * There is deliberately **no method here that stores a candidate, a draft
 * workflow, or a draft role.** Candidates are computed on demand from
 * observations. A second store of mined employee behaviour would have its own
 * retention rule, its own erasure path, and its own way of being forgotten
 * about, and it would survive the erasure of the observations it was derived
 * from.
 */

export interface ObservationFilter {
  readonly subjectRef?: string | undefined;
  readonly deviceRef?: string | undefined;
  readonly sessionId?: Id<"session"> | undefined;
  /** Inclusive lower bound on `observedAt`. */
  readonly observedFrom?: IsoTimestamp | undefined;
  /** Exclusive upper bound on `observedAt`. */
  readonly observedBefore?: IsoTimestamp | undefined;
  readonly limit?: number | undefined;
}

/** Whether the append created a row or found the identical one already there. */
export interface AppendObservationResult {
  readonly observation: Observation;
  readonly created: boolean;
}

export interface DiscoveryStore {
  /**
   * Create or replace an enrollment for one person and device.
   *
   * Keyed on `(subjectRef, deviceRef)`. Replacing a revoked enrollment is how a
   * person opts back in after revoking, which must be a fresh deliberate act
   * rather than a state transition back to `active`.
   */
  putEnrollment(enrollment: Enrollment): Promise<Enrollment>;

  getEnrollment(subjectRef: string, deviceRef: string): Promise<Enrollment | null>;

  listEnrollments(subjectRef?: string): Promise<readonly Enrollment[]>;

  /**
   * Move an enrollment to a new state, atomically.
   *
   * Returns the updated record. Refuses if the enrollment is absent, so a pause
   * or a revocation cannot silently succeed against nothing — the person
   * pressing the button is entitled to know it did something.
   */
  setEnrollmentState(
    subjectRef: string,
    deviceRef: string,
    state: EnrollmentState,
    updatedAt: IsoTimestamp,
  ): Promise<Enrollment>;

  startSession(session: CollectorSession): Promise<CollectorSession>;

  getSession(id: Id<"session">): Promise<CollectorSession | null>;

  /**
   * Close a session, once.
   *
   * Idempotent: closing an already-closed session returns it unchanged rather
   * than raising, because a person pressing stop twice has not made a mistake
   * and must not be shown an error that suggests the first press failed.
   */
  endSession(
    id: Id<"session">,
    endedAt: IsoTimestamp,
    reason: SessionEndReason,
  ): Promise<CollectorSession>;

  /** Every session for a subject, newest first. Open sessions included. */
  listSessions(subjectRef: string, openOnly?: boolean): Promise<readonly CollectorSession[]>;

  /**
   * Append one observation to an open session.
   *
   * The store assigns `sequence` from the session's counter under the same lock
   * that checks the session is open, and refuses if it is not. Idempotent on
   * the natural key `(sessionId, observedAt, fromApplication, toApplication)`:
   * a retried submission returns the stored row with `created: false` rather
   * than recording the same transition twice.
   */
  appendObservation(observation: NewObservation): Promise<AppendObservationResult>;

  /** Observations in ascending `(observedAt, sessionId, sequence)` order. */
  listObservations(filter: ObservationFilter): Promise<readonly Observation[]>;

  countObservations(filter: ObservationFilter): Promise<number>;

  /** Delete every observation recorded before `cutoff`. Returns the row count. */
  purgeObservationsBefore(cutoff: IsoTimestamp): Promise<number>;

  /**
   * Destroy everything held about one person, in one operation.
   *
   * Observations, sessions, and enrollments. Nothing is retained, tombstoned,
   * or moved aside — a tombstone naming the person is a record of the person.
   */
  eraseSubject(subjectRef: string): Promise<ErasureResult>;
}
