/**
 * Schema for outbound contact.
 *
 * Four constraints in here are controls rather than tidiness, and each is
 * enforced by the database because the application is not the only thing that
 * can reach these tables. Consent evidence is retained for seven years and will
 * be read by people who were not here when it was written; it has to be true
 * without depending on anyone's memory of how the code worked.
 *
 * *The consent ledger is append-only, with exactly one exception.* A trigger
 * refuses DELETE and TRUNCATE outright, and refuses UPDATE except for the
 * single transition that attaches an audit receipt to an entry that had none.
 * That exception is narrow on purpose: it is the one write that has to happen
 * after the insert (the receipt does not exist yet at insert time) and it can
 * only ever go from NULL to a value, once. Everything else about a consent
 * event — who, what, when, how we know — is fixed the moment it lands. A
 * consent record that can be edited is not evidence of anything.
 *
 * *Consent is granted narrowly and revoked broadly.* A CHECK forbids the
 * `all_channels` and `all_purposes` wildcards on a grant. "Stop contacting me"
 * is a thing an owner says and the law honours; "contact me however you like
 * about anything" is not consent to something specific and could not be
 * evidenced if it were challenged.
 *
 * *One idempotency key clears one message.* A partial unique index over
 * `idempotency_key WHERE status = 'cleared'` makes the deduplication in
 * `gate.ts` unconditional rather than a matter of the adapter checking first. A
 * retry after a crash must not send the owner the same letter twice — every
 * duplicate is separately actionable under the TCPA. The index is partial
 * because a blocked attempt is not a send: several attempts under one key can
 * legitimately be refused, and each of those refusals is worth keeping.
 *
 * *Gate evidence is stored with the message, not derived later.* `evidence` is
 * `jsonb` written once alongside the row, and `evidence_digest` fingerprints
 * it into the audit chain. Evidence reassembled at read time from policy that
 * has since changed is not evidence of what was checked; it is a reconstruction
 * of what would be checked today.
 *
 * Timestamps are text in the platform's one UTC form, for the reasons set out
 * in `record/migrations.ts`. Here the ordering property earns its keep twice
 * over: the rolling frequency window and the consent ledger's fold both depend
 * on lexicographic ordering matching chronological ordering.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;
const DIGEST_SQL = String.raw`^sha256:[0-9a-f]{64}$`;

const CONTACT_SQL = `
CREATE TABLE IF NOT EXISTS contact_consent_event (
  id               text PRIMARY KEY,
  -- Insertion order, so a ledger written inside one millisecond — which the
  -- seeded demo and the whole test suite do — still has one stable order.
  ordinal          bigserial NOT NULL UNIQUE,
  subject_ref      text NOT NULL,
  channel          text NOT NULL,
  purpose          text NOT NULL,
  kind             text NOT NULL,
  -- When the owner acted.
  effective_at     text NOT NULL,
  -- When we learned of it. Both are kept because a grant back-dated past a
  -- revocation is the shape a manipulated or stale record takes, and it is
  -- only detectable if both clocks survive.
  recorded_at      text NOT NULL,
  provenance       jsonb NOT NULL,
  receipt_id       text,
  CONSTRAINT contact_consent_kind_known CHECK (kind IN ('granted','revoked')),
  CONSTRAINT contact_consent_channel_known CHECK (
    channel IN ('voice','sms','email','postal','all_channels')
  ),
  CONSTRAINT contact_consent_purpose_known CHECK (
    purpose IN ('transactional','servicing','collections','marketing','survey','all_purposes')
  ),
  -- Breadth belongs to revocations alone.
  CONSTRAINT contact_consent_grant_is_specific CHECK (
    kind <> 'granted' OR (channel <> 'all_channels' AND purpose <> 'all_purposes')
  ),
  CONSTRAINT contact_consent_effective_at_utc CHECK (effective_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT contact_consent_recorded_at_utc CHECK (recorded_at ~ '${ISO_UTC_SQL}'),
  -- "How do we know" is not optional. Without a source, a capturer, and a
  -- fingerprint of the underlying artifact, a consent row is an assertion.
  CONSTRAINT contact_consent_provenance_complete CHECK (
    provenance ? 'source' AND provenance ? 'capturedBy' AND provenance ? 'evidenceDigest'
  )
);

-- The ledger read: every event for one owner, in the order the fold needs.
CREATE INDEX IF NOT EXISTS contact_consent_subject_idx
  ON contact_consent_event (subject_ref, effective_at, recorded_at, id);
CREATE INDEX IF NOT EXISTS contact_consent_scope_idx
  ON contact_consent_event (subject_ref, channel, purpose);

CREATE OR REPLACE FUNCTION contact_consent_append_only() RETURNS trigger
LANGUAGE plpgsql AS $contact_consent_append_only$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The one permitted write after insert: attaching the audit receipt, once,
    -- to an entry that did not have one. Every other column must be identical.
    IF OLD.receipt_id IS NULL
       AND NEW.receipt_id IS NOT NULL
       AND NEW.id = OLD.id
       AND NEW.subject_ref = OLD.subject_ref
       AND NEW.channel = OLD.channel
       AND NEW.purpose = OLD.purpose
       AND NEW.kind = OLD.kind
       AND NEW.effective_at = OLD.effective_at
       AND NEW.recorded_at = OLD.recorded_at
       AND NEW.provenance = OLD.provenance
    THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'contact_consent_event is append-only; % is not permitted on this table', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct a mistaken consent record by appending a superseding event. A consent history that can be rewritten cannot answer "when did they consent and how do we know", which is the only question it exists to answer.';
END;
$contact_consent_append_only$;

CREATE OR REPLACE TRIGGER contact_consent_no_update
  BEFORE UPDATE ON contact_consent_event
  FOR EACH ROW EXECUTE FUNCTION contact_consent_append_only();

CREATE OR REPLACE TRIGGER contact_consent_no_delete
  BEFORE DELETE ON contact_consent_event
  FOR EACH ROW EXECUTE FUNCTION contact_consent_append_only();

-- Statement-level, because TRUNCATE fires no row triggers. Without this the
-- row triggers above would be theatre: one statement would empty the ledger.
CREATE OR REPLACE TRIGGER contact_consent_no_truncate
  BEFORE TRUNCATE ON contact_consent_event
  FOR EACH STATEMENT EXECUTE FUNCTION contact_consent_append_only();

CREATE TABLE IF NOT EXISTS contact_do_not_call (
  list               text NOT NULL,
  -- Either may be empty, but not both: a registry hit arrives as a number and
  -- matches by fingerprint, while "stop calling me" said to an agent is
  -- recorded against the owner and suppresses every destination they have.
  subject_ref        text NOT NULL,
  destination_digest text NOT NULL,
  -- Empty array means every channel. Someone who says stop has not enumerated.
  channels           jsonb NOT NULL DEFAULT '[]'::jsonb,
  jurisdiction       text NOT NULL,
  registered_at      text NOT NULL,
  expires_at         text,
  source             text NOT NULL,
  recorded_at        text NOT NULL,
  PRIMARY KEY (list, subject_ref, destination_digest),
  CONSTRAINT contact_dnc_list_known CHECK (list IN ('federal','state','internal')),
  CONSTRAINT contact_dnc_has_a_target CHECK (subject_ref <> '' OR destination_digest <> ''),
  CONSTRAINT contact_dnc_registered_at_utc CHECK (registered_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT contact_dnc_expires_at_utc CHECK (expires_at IS NULL OR expires_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT contact_dnc_recorded_at_utc CHECK (recorded_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT contact_dnc_window_ordered CHECK (expires_at IS NULL OR expires_at > registered_at)
);

CREATE INDEX IF NOT EXISTS contact_dnc_subject_idx ON contact_do_not_call (subject_ref)
  WHERE subject_ref <> '';
CREATE INDEX IF NOT EXISTS contact_dnc_destination_idx
  ON contact_do_not_call (destination_digest) WHERE destination_digest <> '';

CREATE TABLE IF NOT EXISTS contact_outbound_message (
  id                 text PRIMARY KEY,
  ordinal            bigserial NOT NULL UNIQUE,
  run_id             text,
  correlation_id     text,
  subject_ref        text NOT NULL,
  channel            text NOT NULL,
  purpose            text NOT NULL,
  relationship       text NOT NULL,
  destination_digest text NOT NULL,
  content_digest     text NOT NULL,
  jurisdiction       text NOT NULL,
  recipient_time_zone text NOT NULL,
  template_id        text,
  template_version   integer,
  model_id           text,
  risk_band          text NOT NULL,
  status             text NOT NULL,
  evidence           jsonb NOT NULL,
  evidence_digest    text NOT NULL,
  requested_by       text NOT NULL,
  requested_at       text NOT NULL,
  idempotency_key    text NOT NULL,
  approval_id        text,
  denial_reason      text,
  receipt_id         text,
  CONSTRAINT contact_message_channel_known CHECK (
    channel IN ('voice','sms','email','postal')
  ),
  CONSTRAINT contact_message_purpose_known CHECK (
    purpose IN ('transactional','servicing','collections','marketing','survey')
  ),
  CONSTRAINT contact_message_relationship_known CHECK (
    relationship IN ('owner','co_owner','authorised_representative','third_party')
  ),
  CONSTRAINT contact_message_status_known CHECK (status IN ('cleared','blocked')),
  CONSTRAINT contact_message_risk_band_known CHECK (risk_band IN ('standard','elevated')),
  CONSTRAINT contact_message_content_digest_shape CHECK (content_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT contact_message_evidence_digest_shape CHECK (evidence_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT contact_message_requested_at_utc CHECK (requested_at ~ '${ISO_UTC_SQL}'),
  -- A blocked message must say why. A cleared one must not: a denial reason on
  -- a message that went out means two parts of the system disagree about
  -- whether it did.
  CONSTRAINT contact_message_blocked_has_reason CHECK (
    (status = 'blocked' AND denial_reason IS NOT NULL)
    OR (status = 'cleared' AND denial_reason IS NULL)
  ),
  -- Evidence is never optional, and a message with an empty evidence document
  -- is a message nobody can defend.
  CONSTRAINT contact_message_evidence_present CHECK (
    evidence ? 'checks' AND evidence ? 'policyVersion' AND evidence ? 'recipientTimeZone'
  )
);

-- One idempotency key clears one message. Partial, because repeated refusals
-- under one key are legitimate and each is worth keeping.
CREATE UNIQUE INDEX IF NOT EXISTS contact_message_idempotency_key
  ON contact_outbound_message (idempotency_key) WHERE status = 'cleared';

-- The rolling frequency-cap count: cleared messages to one owner on one
-- channel since an instant.
CREATE INDEX IF NOT EXISTS contact_message_frequency_idx
  ON contact_outbound_message (subject_ref, channel, requested_at)
  WHERE status = 'cleared';
CREATE INDEX IF NOT EXISTS contact_message_subject_idx
  ON contact_outbound_message (subject_ref, ordinal);
CREATE INDEX IF NOT EXISTS contact_message_run_idx
  ON contact_outbound_message (run_id) WHERE run_id IS NOT NULL;
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0010_contact", sql: CONTACT_SQL },
];
