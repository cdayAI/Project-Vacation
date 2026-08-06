import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc } from "../record/migrations.js";
import { storeUnavailable, type Db } from "../store/db.js";
import { assertObservationShape, assertReference } from "./exclusions.js";
import type { AppendObservationResult, DiscoveryStore, ObservationFilter } from "./port.js";
import {
  assertEnrollmentWritable,
  assertSessionWritable,
  observationNaturalKey,
} from "./store.memory.js";
import { ENROLLMENT_STATES, SESSION_END_REASONS } from "./types.js";
import type {
  ApplicationKey,
  CollectorSession,
  Enrollment,
  EnrollmentState,
  ErasureResult,
  NewObservation,
  Observation,
  SessionEndReason,
} from "./types.js";

/**
 * Postgres work discovery.
 *
 * Three operations carry the concurrency requirements the port describes, and
 * each has the database do the work rather than the application checking first.
 *
 *   - `appendObservation` increments the session counter with `UPDATE ... WHERE
 *     ended_at IS NULL RETURNING`. If the person pressed stop, that statement
 *     matches nothing and the append is refused. A read-then-write would leave
 *     a window in which stop had been pressed, the console said stopped, and
 *     one more observation landed — small, and precisely the thing the control
 *     promises does not happen.
 *
 *   - `eraseSubject` deletes the enrollment inside a transaction and lets the
 *     `ON DELETE CASCADE` chain destroy the sessions and every observation in
 *     them, then sweeps any rows whose enrollment had already gone. Erasure in
 *     three statements from the caller means a crash between two of them leaves
 *     a person half-erased, and the residue is exactly the record they asked to
 *     have destroyed.
 *
 *   - `endSession` is a conditional UPDATE that only fires on an open session,
 *     and returns the existing row when it is already closed. Somebody pressing
 *     stop twice must not see an error suggesting the first press failed.
 *
 * Sequence numbers are monotonic within a session, not gapless. A concurrent
 * append that loses the race on the natural key has already consumed a counter
 * value, and the alternative — holding the session row locked across the insert
 * to keep the numbering dense — would serialise every collector on the planet
 * behind one row for the sake of a property nothing reads.
 */

type EnrollmentRow = {
  subject_ref: string;
  device_ref: string;
  subject_actor_id: string;
  state: string;
  application_allowlist: string[];
  retention_days: number;
  notice_reference: string;
  notice_acknowledged_at: string;
  enrolled_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  subject_ref: string;
  device_ref: string;
  started_by: string;
  started_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  observation_count: number;
};

type ObservationRow = {
  id: string;
  subject_ref: string;
  device_ref: string;
  session_id: string;
  sequence: number;
  from_application: string;
  to_application: string;
  observed_at: string;
  dwell_ms: number;
};

const ENROLLMENT_COLUMNS = `subject_ref, device_ref, subject_actor_id, state,
  application_allowlist, retention_days, notice_reference, notice_acknowledged_at,
  enrolled_at, updated_at`;

const SESSION_COLUMNS = `id, subject_ref, device_ref, started_by, started_at, ended_at,
  ended_reason, observation_count`;

const OBSERVATION_COLUMNS = `id, subject_ref, device_ref, session_id, sequence,
  from_application, to_application, observed_at, dwell_ms`;

function toEnrollment(row: EnrollmentRow): Enrollment {
  const state = row.state;
  if (!ENROLLMENT_STATES.includes(state as EnrollmentState)) {
    throw new InvalidInputError(`Stored enrollment has unknown state ${state}.`, "state");
  }
  return {
    subjectRef: row.subject_ref,
    subjectActorId: row.subject_actor_id,
    deviceRef: row.device_ref,
    state: state as EnrollmentState,
    applicationAllowlist: Object.freeze([...row.application_allowlist]) as readonly ApplicationKey[],
    retentionDays: row.retention_days,
    noticeReference: row.notice_reference,
    noticeAcknowledgedAt: row.notice_acknowledged_at,
    enrolledAt: row.enrolled_at,
    updatedAt: row.updated_at,
  };
}

function toSession(row: SessionRow): CollectorSession {
  const reason = row.ended_reason;
  if (reason !== null && !SESSION_END_REASONS.includes(reason as SessionEndReason)) {
    throw new InvalidInputError(`Stored session has unknown end reason ${reason}.`, "endedReason");
  }
  return {
    id: row.id as Id<"session">,
    subjectRef: row.subject_ref,
    deviceRef: row.device_ref,
    startedBy: row.started_by,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    endedReason: (reason as SessionEndReason | null) ?? undefined,
    observationCount: row.observation_count,
  };
}

function toObservation(row: ObservationRow): Observation {
  return {
    id: row.id as Id<"observation">,
    subjectRef: row.subject_ref,
    deviceRef: row.device_ref,
    sessionId: row.session_id as Id<"session">,
    sequence: row.sequence,
    fromApplication: row.from_application,
    toApplication: row.to_application,
    observedAt: row.observed_at,
    dwellMs: row.dwell_ms,
  };
}

export class PgDiscoveryStore implements DiscoveryStore {
  constructor(private readonly db: Db) {}

  async putEnrollment(enrollment: Enrollment): Promise<Enrollment> {
    assertEnrollmentWritable(enrollment);
    try {
      // Upsert rather than delete-then-insert. A delete would cascade through
      // the sessions and observations of somebody who was only updating their
      // allowlist.
      const rows = await this.db.query<EnrollmentRow>(
        `INSERT INTO discovery_enrollment (${ENROLLMENT_COLUMNS})
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
         ON CONFLICT (subject_ref, device_ref) DO UPDATE SET
           subject_actor_id = EXCLUDED.subject_actor_id,
           state = EXCLUDED.state,
           application_allowlist = EXCLUDED.application_allowlist,
           retention_days = EXCLUDED.retention_days,
           notice_reference = EXCLUDED.notice_reference,
           notice_acknowledged_at = EXCLUDED.notice_acknowledged_at,
           updated_at = EXCLUDED.updated_at
         RETURNING ${ENROLLMENT_COLUMNS}`,
        [
          enrollment.subjectRef,
          enrollment.deviceRef,
          enrollment.subjectActorId,
          enrollment.state,
          JSON.stringify(enrollment.applicationAllowlist),
          enrollment.retentionDays,
          enrollment.noticeReference,
          enrollment.noticeAcknowledgedAt,
          enrollment.enrolledAt,
          enrollment.updatedAt,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("upsert returned no row");
      return toEnrollment(row);
    } catch (error) {
      throw storeUnavailable("discovery.putEnrollment", error);
    }
  }

  async getEnrollment(subjectRef: string, deviceRef: string): Promise<Enrollment | null> {
    try {
      const rows = await this.db.query<EnrollmentRow>(
        `SELECT ${ENROLLMENT_COLUMNS} FROM discovery_enrollment
         WHERE subject_ref = $1 AND device_ref = $2`,
        [subjectRef, deviceRef],
      );
      const row = rows[0];
      return row ? toEnrollment(row) : null;
    } catch (error) {
      throw storeUnavailable("discovery.getEnrollment", error);
    }
  }

  async listEnrollments(subjectRef?: string): Promise<readonly Enrollment[]> {
    try {
      const rows =
        subjectRef === undefined
          ? await this.db.query<EnrollmentRow>(
              `SELECT ${ENROLLMENT_COLUMNS} FROM discovery_enrollment
               ORDER BY subject_ref, device_ref`,
            )
          : await this.db.query<EnrollmentRow>(
              `SELECT ${ENROLLMENT_COLUMNS} FROM discovery_enrollment
               WHERE subject_ref = $1 ORDER BY subject_ref, device_ref`,
              [subjectRef],
            );
      return rows.map(toEnrollment);
    } catch (error) {
      throw storeUnavailable("discovery.listEnrollments", error);
    }
  }

  async setEnrollmentState(
    subjectRef: string,
    deviceRef: string,
    state: EnrollmentState,
    updatedAt: string,
  ): Promise<Enrollment> {
    if (!ENROLLMENT_STATES.includes(state)) {
      throw new InvalidInputError(`Unknown enrollment state: ${String(state)}`, "state");
    }
    assertIsoUtc("updatedAt", updatedAt);

    let rows: EnrollmentRow[];
    try {
      rows = await this.db.query<EnrollmentRow>(
        `UPDATE discovery_enrollment SET state = $3, updated_at = $4
         WHERE subject_ref = $1 AND device_ref = $2
         RETURNING ${ENROLLMENT_COLUMNS}`,
        [subjectRef, deviceRef, state, updatedAt],
      );
    } catch (error) {
      throw storeUnavailable("discovery.setEnrollmentState", error);
    }

    const row = rows[0];
    if (!row) {
      throw new DeniedError(
        "discovery.not_enrolled",
        `No work-discovery enrollment for device ${deviceRef}.`,
        { gate: "enrollment", subjectRef, deviceRef },
      );
    }
    return toEnrollment(row);
  }

  async startSession(session: CollectorSession): Promise<CollectorSession> {
    assertSessionWritable(session);
    try {
      const rows = await this.db.query<SessionRow>(
        `INSERT INTO discovery_collector_session (${SESSION_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${SESSION_COLUMNS}`,
        [
          session.id,
          session.subjectRef,
          session.deviceRef,
          session.startedBy,
          session.startedAt,
          session.endedAt ?? null,
          session.endedReason ?? null,
          session.observationCount,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("insert returned no row");
      return toSession(row);
    } catch (error) {
      throw storeUnavailable("discovery.startSession", error);
    }
  }

  async getSession(id: Id<"session">): Promise<CollectorSession | null> {
    try {
      const rows = await this.db.query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM discovery_collector_session WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      return row ? toSession(row) : null;
    } catch (error) {
      throw storeUnavailable("discovery.getSession", error);
    }
  }

  async endSession(
    id: Id<"session">,
    endedAt: string,
    reason: SessionEndReason,
  ): Promise<CollectorSession> {
    assertIsoUtc("endedAt", endedAt);
    if (!SESSION_END_REASONS.includes(reason)) {
      throw new InvalidInputError(`Unknown session end reason: ${String(reason)}`, "reason");
    }

    let updated: SessionRow[];
    try {
      updated = await this.db.query<SessionRow>(
        `UPDATE discovery_collector_session SET ended_at = $2, ended_reason = $3
         WHERE id = $1 AND ended_at IS NULL
         RETURNING ${SESSION_COLUMNS}`,
        [id, endedAt, reason],
      );
    } catch (error) {
      throw storeUnavailable("discovery.endSession", error);
    }

    const row = updated[0];
    if (row) return toSession(row);

    // Either already closed — in which case this is a second press of stop and
    // returning the existing row is the honest answer — or absent.
    const existing = await this.getSession(id);
    if (existing) return existing;
    throw new DeniedError("discovery.not_enrolled", `No collector session ${id}.`, {
      gate: "collector",
      sessionId: id,
    });
  }

  async listSessions(subjectRef: string, openOnly = false): Promise<readonly CollectorSession[]> {
    try {
      const rows = openOnly
        ? await this.db.query<SessionRow>(
            `SELECT ${SESSION_COLUMNS} FROM discovery_collector_session
             WHERE subject_ref = $1 AND ended_at IS NULL
             ORDER BY started_at DESC, id DESC`,
            [subjectRef],
          )
        : await this.db.query<SessionRow>(
            `SELECT ${SESSION_COLUMNS} FROM discovery_collector_session
             WHERE subject_ref = $1
             ORDER BY started_at DESC, id DESC`,
            [subjectRef],
          );
      return rows.map(toSession);
    } catch (error) {
      throw storeUnavailable("discovery.listSessions", error);
    }
  }

  async appendObservation(observation: NewObservation): Promise<AppendObservationResult> {
    // Shape first, outside the transaction, with a placeholder sequence: the
    // real one is assigned by the database and the structural exclusions have
    // nothing to say about it. A refused observation must not have consumed a
    // sequence number or opened a transaction.
    assertObservationShape({ ...observation, sequence: 1 });
    const naturalKey = observationNaturalKey(observation);

    const append = this.db.transaction(async (tx) => {
      const existing = await tx.query<ObservationRow>(
        `SELECT ${OBSERVATION_COLUMNS} FROM discovery_observation
         WHERE session_id = $1 AND observed_at = $2
           AND from_application = $3 AND to_application = $4`,
        [
          observation.sessionId,
          observation.observedAt,
          observation.fromApplication,
          observation.toApplication,
        ],
      );
      const already = existing[0];
      if (already) return { observation: toObservation(already), created: false };

      // Atomic, and conditional on the session still being open. This is the
      // statement that makes the stop button win a race with a collector.
      const claimed = await tx.query<{ observation_count: number }>(
        `UPDATE discovery_collector_session
         SET observation_count = observation_count + 1
         WHERE id = $1 AND ended_at IS NULL
         RETURNING observation_count`,
        [observation.sessionId],
      );
      const claim = claimed[0];
      if (!claim) {
        const session = await tx.query<SessionRow>(
          `SELECT ${SESSION_COLUMNS} FROM discovery_collector_session WHERE id = $1`,
          [observation.sessionId],
        );
        const row = session[0];
        throw new DeniedError(
          "discovery.not_enrolled",
          row
            ? `Collector session ${observation.sessionId} ended (${row.ended_reason ?? "closed"}); the observation was refused.`
            : `No collector session ${observation.sessionId}.`,
          {
            gate: "collector",
            sessionId: observation.sessionId,
            endedReason: row?.ended_reason ?? "absent",
          },
        );
      }

      const inserted = await tx.query<ObservationRow>(
        `INSERT INTO discovery_observation (${OBSERVATION_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (session_id, observed_at, from_application, to_application) DO NOTHING
         RETURNING ${OBSERVATION_COLUMNS}`,
        [
          observation.id,
          observation.subjectRef,
          observation.deviceRef,
          observation.sessionId,
          claim.observation_count,
          observation.fromApplication,
          observation.toApplication,
          observation.observedAt,
          observation.dwellMs,
        ],
      );
      const row = inserted[0];
      if (row) return { observation: toObservation(row), created: true };

      // Lost the race on the natural key. The counter value this call consumed
      // is simply not used: sequence is monotonic, not gapless.
      const winner = await tx.query<ObservationRow>(
        `SELECT ${OBSERVATION_COLUMNS} FROM discovery_observation
         WHERE session_id = $1 AND observed_at = $2
           AND from_application = $3 AND to_application = $4`,
        [
          observation.sessionId,
          observation.observedAt,
          observation.fromApplication,
          observation.toApplication,
        ],
      );
      const settled = winner[0];
      if (!settled) {
        throw storeUnavailable(
          "discovery.appendObservation",
          new Error(`insert conflicted on ${naturalKey} but the conflicting row is not readable`),
        );
      }
      return { observation: toObservation(settled), created: false };
    });

    try {
      return await append;
    } catch (error) {
      // A refusal is a refusal; only a genuine store failure becomes one.
      if (error instanceof DeniedError) throw error;
      throw storeUnavailable("discovery.appendObservation", error);
    }
  }

  async listObservations(filter: ObservationFilter): Promise<readonly Observation[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      params.push(value);
      where.push(clause.replace("?", `$${params.length}`));
    };

    if (filter.subjectRef !== undefined) add("subject_ref = ?", filter.subjectRef);
    if (filter.deviceRef !== undefined) add("device_ref = ?", filter.deviceRef);
    if (filter.sessionId !== undefined) add("session_id = ?", filter.sessionId);
    if (filter.observedFrom !== undefined) add("observed_at >= ?", filter.observedFrom);
    if (filter.observedBefore !== undefined) add("observed_at < ?", filter.observedBefore);

    let sql = `SELECT ${OBSERVATION_COLUMNS} FROM discovery_observation`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY observed_at, session_id, sequence, id";
    if (filter.limit !== undefined) {
      params.push(filter.limit);
      sql += ` LIMIT $${params.length}`;
    }

    try {
      const rows = await this.db.query<ObservationRow>(sql, params);
      return rows.map(toObservation);
    } catch (error) {
      throw storeUnavailable("discovery.listObservations", error);
    }
  }

  async countObservations(filter: ObservationFilter): Promise<number> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      params.push(value);
      where.push(clause.replace("?", `$${params.length}`));
    };

    if (filter.subjectRef !== undefined) add("subject_ref = ?", filter.subjectRef);
    if (filter.deviceRef !== undefined) add("device_ref = ?", filter.deviceRef);
    if (filter.sessionId !== undefined) add("session_id = ?", filter.sessionId);
    if (filter.observedFrom !== undefined) add("observed_at >= ?", filter.observedFrom);
    if (filter.observedBefore !== undefined) add("observed_at < ?", filter.observedBefore);

    let sql = "SELECT count(*)::int AS total FROM discovery_observation";
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;

    try {
      const rows = await this.db.query<{ total: number }>(sql, params);
      return rows[0]?.total ?? 0;
    } catch (error) {
      throw storeUnavailable("discovery.countObservations", error);
    }
  }

  async purgeObservationsBefore(cutoff: string, subjectRef?: string): Promise<number> {
    assertIsoUtc("cutoff", cutoff);
    try {
      const rows =
        subjectRef === undefined
          ? await this.db.query<{ id: string }>(
              "DELETE FROM discovery_observation WHERE observed_at < $1 RETURNING id",
              [cutoff],
            )
          : await this.db.query<{ id: string }>(
              `DELETE FROM discovery_observation
               WHERE observed_at < $1 AND subject_ref = $2 RETURNING id`,
              [cutoff, subjectRef],
            );
      return rows.length;
    } catch (error) {
      throw storeUnavailable("discovery.purgeObservationsBefore", error);
    }
  }

  async eraseSubject(subjectRef: string): Promise<ErasureResult> {
    assertReference("subjectRef", subjectRef);
    try {
      return await this.db.transaction(async (tx) => {
        // Count before deleting, so the person who asked can be told what was
        // destroyed. Inside the transaction, so the counts describe what the
        // delete then removes.
        const counted = await tx.query<{ observations: number; sessions: number }>(
          `SELECT
             (SELECT count(*)::int FROM discovery_observation WHERE subject_ref = $1) AS observations,
             (SELECT count(*)::int FROM discovery_collector_session WHERE subject_ref = $1) AS sessions`,
          [subjectRef],
        );
        const counts = counted[0] ?? { observations: 0, sessions: 0 };

        // The cascade does the work: enrollment → sessions → observations.
        const enrollments = await tx.query<{ device_ref: string }>(
          "DELETE FROM discovery_enrollment WHERE subject_ref = $1 RETURNING device_ref",
          [subjectRef],
        );

        // Then anything whose enrollment had already gone. Rows nobody is
        // looking for are exactly the rows a cascade alone would leave behind.
        await tx.query("DELETE FROM discovery_observation WHERE subject_ref = $1", [subjectRef]);
        await tx.query("DELETE FROM discovery_collector_session WHERE subject_ref = $1", [
          subjectRef,
        ]);

        return {
          observationsErased: counts.observations,
          sessionsErased: counts.sessions,
          enrollmentsErased: enrollments.length,
        };
      });
    } catch (error) {
      if (error instanceof DeniedError) throw error;
      throw storeUnavailable("discovery.eraseSubject", error);
    }
  }
}
