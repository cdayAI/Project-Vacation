/**
 * Schema for work discovery.
 *
 * This is the schema of a component that observes employees, and the
 * constraints in it are the last line of the structural exclusions rather than
 * tidiness. Two things are worth reading before anything else.
 *
 * **There is nowhere to put content.** No column here is free text. There is no
 * `title`, no `url`, no `body`, no `content`, no `payload`, and no unstructured
 * `jsonb` on the observation table. Application names are constrained by a
 * regular expression that cannot match a sentence, a path, or a query string,
 * so the field that is *permitted* to hold a name cannot be used to smuggle
 * what somebody was reading. If a future change needs a free-text column here,
 * that change is a privacy decision and the absence of anywhere to put the text
 * is what forces it to be made in the open.
 *
 * **Erasure is a cascade.** `discovery_collector_session` references the
 * enrollment and `discovery_observation` references the session, both `ON
 * DELETE CASCADE`. Deleting one person's enrollment therefore destroys their
 * sessions and every observation in them as a property of the database, not as
 * a sequence of statements the application has to remember to issue in the
 * right order. The application still counts the rows first, so the person
 * asking can be told what was destroyed.
 *
 * **On the blocklist floor in SQL.** The families below are a snapshot of the
 * floor in `exclusions.ts` as at this migration. The authoritative floor is the
 * frozen constant in that file, which is checked at enrollment and again at
 * every observation; this CHECK is a second, independent barrier for anything
 * reaching the table another way. It is a literal rather than generated from
 * the constant on purpose: a released migration is immutable, and SQL generated
 * from a value somebody can edit would change its checksum the next time the
 * floor grew, and the migration runner would refuse to run at all. Adding a
 * family to the floor is a code change plus, if the database barrier should
 * cover it too, a new additive migration.
 *
 * Timestamps are text in the platform's one UTC form, for the reasons set out
 * in `record/migrations.ts`. Retention purges and the mining window both depend
 * on lexicographic order matching chronological order.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;

/** One to three lowercase dot-separated segments. Cannot match a URL or a title. */
const APPLICATION_KEY_SQL = String.raw`^[a-z][a-z0-9_]{0,31}(\.[a-z0-9_]{1,31}){0,2}$`;

/** Opaque references: bounded, no whitespace, no punctuation that carries text. */
const REFERENCE_SQL = String.raw`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`;

/** A snapshot of the immutable blocklist floor. See the module comment. */
const BLOCKED_FAMILY_SQL = String.raw`^(email|chat|meeting|telephony|sms|social|browser|owner_record|contract_record|association_record|hr|payroll|benefits|medical|legal|compliance|ledger|banking|payments|identity|vault|union|personal)(\.|$)`;

/** The retention ceiling, matching MAX_RETENTION_DAYS in retention.ts. */
const MAX_RETENTION_DAYS_SQL = 30;

/** The dwell ceiling, matching MAX_DWELL_MS in exclusions.ts: 24 hours. */
const MAX_DWELL_MS_SQL = 86_400_000;

const DISCOVERY_SQL = `
CREATE TABLE IF NOT EXISTS discovery_enrollment (
  subject_ref            text NOT NULL,
  device_ref             text NOT NULL,
  -- The identity of the observed person. Every control — pause, stop, revoke,
  -- erase — is checked against this and nothing else. There is no
  -- administrator column because there is no administrator path.
  subject_actor_id       text NOT NULL,
  state                  text NOT NULL,
  -- A positive allowlist. An empty array is legal and observes nothing, which
  -- is a state somebody must be able to sit in.
  application_allowlist  jsonb NOT NULL DEFAULT '[]'::jsonb,
  retention_days         integer NOT NULL,
  -- Which written notice this person was given, and when they acknowledged it.
  -- Not nullable: an enrollment that cannot answer "which notice, given when"
  -- is not evidence of anything, and that is the first question every
  -- electronic-monitoring regime asks.
  notice_reference       text NOT NULL,
  notice_acknowledged_at text NOT NULL,
  enrolled_at            text NOT NULL,
  updated_at             text NOT NULL,
  PRIMARY KEY (subject_ref, device_ref),
  CONSTRAINT discovery_enrollment_subject_ref_shape CHECK (subject_ref ~ '${REFERENCE_SQL}'),
  CONSTRAINT discovery_enrollment_device_ref_shape CHECK (device_ref ~ '${REFERENCE_SQL}'),
  CONSTRAINT discovery_enrollment_actor_shape CHECK (subject_actor_id ~ '${REFERENCE_SQL}'),
  CONSTRAINT discovery_enrollment_state_known CHECK (state IN ('active','paused','revoked')),
  CONSTRAINT discovery_enrollment_allowlist_is_array CHECK (
    jsonb_typeof(application_allowlist) = 'array'
  ),
  -- The retention ceiling, in the database as well as in code. Days, not
  -- months: a longer period turns a process sample into a behavioural profile.
  CONSTRAINT discovery_enrollment_retention_ceiling CHECK (
    retention_days BETWEEN 1 AND ${MAX_RETENTION_DAYS_SQL}
  ),
  CONSTRAINT discovery_enrollment_notice_present CHECK (btrim(notice_reference) <> ''),
  CONSTRAINT discovery_enrollment_notice_at_utc CHECK (notice_acknowledged_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT discovery_enrollment_enrolled_at_utc CHECK (enrolled_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT discovery_enrollment_updated_at_utc CHECK (updated_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS discovery_enrollment_subject_idx
  ON discovery_enrollment (subject_ref);
CREATE INDEX IF NOT EXISTS discovery_enrollment_actor_idx
  ON discovery_enrollment (subject_actor_id);

CREATE TABLE IF NOT EXISTS discovery_collector_session (
  id                 text PRIMARY KEY,
  subject_ref        text NOT NULL,
  device_ref         text NOT NULL,
  -- The actor that started collection. Checked against the enrollment's
  -- subject_actor_id by the application: nobody starts a collector for
  -- somebody else.
  started_by         text NOT NULL,
  started_at         text NOT NULL,
  ended_at           text,
  ended_reason       text,
  -- Monotonic counter, incremented in the same statement that inserts an
  -- observation. Held here rather than derived by counting rows so that a
  -- retention purge, which deletes rows, cannot cause a sequence number to be
  -- issued twice.
  observation_count  integer NOT NULL DEFAULT 0,
  CONSTRAINT discovery_session_id_shape CHECK (id ~ '${REFERENCE_SQL}'),
  CONSTRAINT discovery_session_started_by_shape CHECK (started_by ~ '${REFERENCE_SQL}'),
  CONSTRAINT discovery_session_started_at_utc CHECK (started_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT discovery_session_ended_at_utc CHECK (ended_at IS NULL OR ended_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT discovery_session_window_ordered CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- Every way a session can end is an act by the observed person. There is no
  -- 'ended_by_administrator'.
  CONSTRAINT discovery_session_end_reason_known CHECK (
    ended_reason IS NULL OR ended_reason IN (
      'stopped_by_subject','paused_by_subject','revoked_by_subject','erased_by_subject'
    )
  ),
  CONSTRAINT discovery_session_ended_has_reason CHECK (
    (ended_at IS NULL AND ended_reason IS NULL) OR (ended_at IS NOT NULL AND ended_reason IS NOT NULL)
  ),
  CONSTRAINT discovery_session_count_non_negative CHECK (observation_count >= 0),
  -- Erasing an enrollment erases its sessions, as a property of the database.
  CONSTRAINT discovery_session_enrollment_fk FOREIGN KEY (subject_ref, device_ref)
    REFERENCES discovery_enrollment (subject_ref, device_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS discovery_session_subject_idx
  ON discovery_collector_session (subject_ref, started_at DESC);
-- The open-session lookup, which runs on every pause, stop, and revoke.
CREATE INDEX IF NOT EXISTS discovery_session_open_idx
  ON discovery_collector_session (subject_ref) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS discovery_observation (
  id                text PRIMARY KEY,
  subject_ref       text NOT NULL,
  device_ref        text NOT NULL,
  session_id        text NOT NULL,
  sequence          integer NOT NULL,
  -- The only two columns that carry anything about what was happening, and
  -- both are constrained to a normalised application name. There is no column
  -- on this table that can hold a window title, a URL, a keystroke, a document,
  -- a form value, a message body, or a customer record.
  from_application  text NOT NULL,
  to_application    text NOT NULL,
  observed_at       text NOT NULL,
  dwell_ms          integer NOT NULL,
  CONSTRAINT discovery_observation_id_shape CHECK (id ~ '${REFERENCE_SQL}'),
  CONSTRAINT discovery_observation_subject_shape CHECK (subject_ref ~ '${REFERENCE_SQL}'),
  CONSTRAINT discovery_observation_device_shape CHECK (device_ref ~ '${REFERENCE_SQL}'),
  CONSTRAINT discovery_observation_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT discovery_observation_from_shape CHECK (from_application ~ '${APPLICATION_KEY_SQL}'),
  CONSTRAINT discovery_observation_to_shape CHECK (to_application ~ '${APPLICATION_KEY_SQL}'),
  -- The blocklist floor, independently enforced. See the module comment on why
  -- this is a literal rather than generated.
  CONSTRAINT discovery_observation_from_not_blocked CHECK (
    from_application !~ '${BLOCKED_FAMILY_SQL}'
  ),
  CONSTRAINT discovery_observation_to_not_blocked CHECK (
    to_application !~ '${BLOCKED_FAMILY_SQL}'
  ),
  CONSTRAINT discovery_observation_observed_at_utc CHECK (observed_at ~ '${ISO_UTC_SQL}'),
  -- Bounded, because an unbounded integer is a channel and a dwell longer than
  -- a day is a broken collector rather than a person.
  CONSTRAINT discovery_observation_dwell_bounded CHECK (
    dwell_ms BETWEEN 0 AND ${MAX_DWELL_MS_SQL}
  ),
  CONSTRAINT discovery_observation_session_fk FOREIGN KEY (session_id)
    REFERENCES discovery_collector_session (id) ON DELETE CASCADE
);

-- One session cannot contain the same transition at the same millisecond: that
-- is a retried submission, not a person moving twice. The unique index is what
-- makes the append idempotent rather than the adapter checking first.
CREATE UNIQUE INDEX IF NOT EXISTS discovery_observation_natural_key
  ON discovery_observation (session_id, observed_at, from_application, to_application);

CREATE UNIQUE INDEX IF NOT EXISTS discovery_observation_session_sequence
  ON discovery_observation (session_id, sequence);

-- The retention purge and the mining read, which are the only two queries that
-- scan this table.
CREATE INDEX IF NOT EXISTS discovery_observation_observed_at_idx
  ON discovery_observation (observed_at);
CREATE INDEX IF NOT EXISTS discovery_observation_subject_idx
  ON discovery_observation (subject_ref, observed_at);
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0012_discovery", sql: DISCOVERY_SQL },
];
