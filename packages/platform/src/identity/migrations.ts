/**
 * Schema for identity.
 *
 * The most important property of this file is what is *not* in it. There is no
 * password column, no password-hash column, no reset token, and no local
 * account table. Human authentication happens at MVW's identity provider and
 * nowhere else, and the schema is the layer where that promise can actually be
 * enforced — application code can grow a login form in an afternoon, but it
 * cannot store a password in a column that does not exist. A test asserts the
 * absence, so adding one is a deliberate, visible act rather than a quiet one.
 *
 * Three constraints here are controls rather than tidiness.
 *
 * *`identity_actor.subject_digest` is unique.* One directory subject is one
 * actor, permanently. Without the constraint, a race between two simultaneous
 * first sign-ins would create two actors for one person, and half their audit
 * trail would file itself under an id nobody looks at.
 *
 * *`identity_service_account.credential_digest` must be a sha256 digest.* The
 * column is shaped so that a plaintext credential cannot be written into it,
 * whatever a future adapter believes it is passing. Storing only a digest is a
 * promise made in `service-accounts.ts`; this is where the database keeps it.
 *
 * *`identity_authorization_request` is keyed on `state` and deleted on
 * consumption.* The state parameter is single-use: the primary key gives the
 * uniqueness, and `DELETE ... RETURNING` gives the atomic take. A row that
 * survives its exchange is a replayable sign-in.
 *
 * On the one table that holds short-lived secrets: `identity_authorization_request`
 * stores the PKCE code verifier and the nonce in the clear for the few minutes
 * between the redirect out and the callback in. They have to be readable to be
 * used, they are useless once the row is gone, and every row is removed either
 * by its exchange or by the expiry sweep. What matters is that they are never
 * logged and never leave the process — which is why the store returns them to
 * exactly one caller and nothing else reads this table.
 *
 * Timestamps are text in the platform's ISO-8601 UTC form for the reasons set
 * out in `record/migrations.ts`: the fixed-width form sorts lexicographically
 * in chronological order, which is what makes the expiry sweeps index range
 * scans, and it round-trips byte for byte.
 */

const ISO_UTC_SQL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`;
const DIGEST_SQL = String.raw`^sha256:[0-9a-f]{64}$`;

const IDENTITY_SQL = `
CREATE TABLE IF NOT EXISTS identity_actor (
  id                text PRIMARY KEY,
  kind              text NOT NULL,
  -- digestValue({issuer, subject}). The subject claim itself is never stored:
  -- the platform needs a stable pseudonym, not a copy of the directory.
  subject_digest    text NOT NULL UNIQUE,
  issuer            text NOT NULL,
  roles             jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes            jsonb NOT NULL DEFAULT '[]'::jsonb,
  directory_groups  jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            text NOT NULL,
  first_seen_at     text NOT NULL,
  last_seen_at      text NOT NULL,
  CONSTRAINT identity_actor_kind_known CHECK (kind IN ('human','service')),
  CONSTRAINT identity_actor_status_known CHECK (status IN ('active','deprovisioned')),
  CONSTRAINT identity_actor_subject_digest_shape CHECK (subject_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT identity_actor_first_seen_utc CHECK (first_seen_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT identity_actor_last_seen_utc CHECK (last_seen_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS identity_actor_status_idx ON identity_actor (status);

CREATE TABLE IF NOT EXISTS identity_session (
  id                     text PRIMARY KEY,
  actor_id               text NOT NULL REFERENCES identity_actor (id) ON DELETE RESTRICT,
  issued_at              text NOT NULL,
  expires_at             text NOT NULL,
  -- Moved forward by a step-up re-authentication. The authorization
  -- chokepoint's step-up check is computed from this and nothing else.
  authenticated_at       text NOT NULL,
  authentication_methods jsonb NOT NULL DEFAULT '[]'::jsonb,
  idp_session_id         text,
  -- The entitlements in force when the session opened, kept for the audit
  -- question "what could they do at the time". Never used to authorise:
  -- authorisation reads identity_actor, so a removal takes effect at once.
  roles                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  revoked_at             text,
  revoked_reason         text,
  CONSTRAINT identity_session_issued_at_utc CHECK (issued_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT identity_session_expires_at_utc CHECK (expires_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT identity_session_authenticated_at_utc CHECK (authenticated_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT identity_session_revoked_at_utc CHECK (revoked_at IS NULL OR revoked_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS identity_session_actor_idx ON identity_session (actor_id);
-- The purge sweep asks for sessions past their expiry; a partial index keeps
-- it away from every session ever opened.
CREATE INDEX IF NOT EXISTS identity_session_expiry_idx
  ON identity_session (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS identity_authorization_request (
  state          text PRIMARY KEY,
  nonce          text NOT NULL,
  code_verifier  text NOT NULL,
  redirect_uri   text NOT NULL,
  created_at     text NOT NULL,
  expires_at     text NOT NULL,
  return_to      text,
  CONSTRAINT identity_authorization_request_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT identity_authorization_request_expires_at_utc CHECK (expires_at ~ '${ISO_UTC_SQL}')
);

CREATE INDEX IF NOT EXISTS identity_authorization_request_expiry_idx
  ON identity_authorization_request (expires_at);

CREATE TABLE IF NOT EXISTS identity_service_account (
  id                 text PRIMARY KEY,
  name               text NOT NULL UNIQUE,
  description        text NOT NULL,
  -- The non-secret half, used to find the row so verification is a single
  -- lookup rather than a scan across every stored digest.
  credential_prefix  text NOT NULL UNIQUE,
  credential_digest  text NOT NULL,
  roles              jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes             jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at         text NOT NULL,
  created_by         text NOT NULL,
  expires_at         text NOT NULL,
  last_used_at       text,
  revoked_at         text,
  revoked_by         text,
  revoked_reason     text,
  -- The column cannot hold a plaintext credential, whatever writes to it.
  CONSTRAINT identity_service_account_digest_shape CHECK (credential_digest ~ '${DIGEST_SQL}'),
  CONSTRAINT identity_service_account_created_at_utc CHECK (created_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT identity_service_account_expires_at_utc CHECK (expires_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT identity_service_account_last_used_at_utc CHECK (last_used_at IS NULL OR last_used_at ~ '${ISO_UTC_SQL}'),
  CONSTRAINT identity_service_account_revoked_at_utc CHECK (revoked_at IS NULL OR revoked_at ~ '${ISO_UTC_SQL}'),
  -- A revocation without a time is not a revocation anyone can evidence.
  CONSTRAINT identity_service_account_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS identity_service_account_live_idx
  ON identity_service_account (expires_at) WHERE revoked_at IS NULL;
`;

export const MIGRATIONS: readonly { readonly id: string; readonly sql: string }[] = [
  { id: "0008_identity", sql: IDENTITY_SQL },
];
