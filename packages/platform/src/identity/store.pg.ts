import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import { storeUnavailable, type Db } from "../store/db.js";
import { identityRefusal } from "./denials.js";
import type { IdentityStore, ServiceAccountStore, UpsertActorInput } from "./port.js";
import type {
  Actor,
  ActorStatus,
  AuthorizationRequest,
  RoleName,
  Scope,
  ServiceAccount,
  Session,
} from "./types.js";

/**
 * Postgres identity.
 *
 * The three operations with a concurrency requirement are single statements
 * rather than a read followed by a write, because each of them is a control:
 *
 *   `upsertActor` is `INSERT ... ON CONFLICT (subject_digest) DO UPDATE`, so
 *   two simultaneous first sign-ins converge on one actor row. The unique
 *   index on `subject_digest` is what makes that unconditional.
 *
 *   `consumeAuthorizationRequest` is `DELETE ... RETURNING`. Postgres
 *   serialises concurrent deletes of one row, so of N callers presenting the
 *   same state exactly one gets a row back. That is the difference between a
 *   single-use state parameter and one that is single-use unless two requests
 *   arrive together — which is precisely the condition a replay creates.
 *
 *   `revokeServiceAccount` is `UPDATE ... WHERE revoked_at IS NULL RETURNING`,
 *   the same compare-and-set, so "already revoked" is an answer the database
 *   gives rather than one the application guesses from a stale read.
 */

type ActorRow = {
  id: string;
  kind: string;
  subject_digest: string;
  issuer: string;
  roles: string[];
  scopes: string[];
  directory_groups: string[];
  status: string;
  first_seen_at: string;
  last_seen_at: string;
};

type SessionRow = {
  id: string;
  actor_id: string;
  issued_at: string;
  expires_at: string;
  authenticated_at: string;
  authentication_methods: string[];
  idp_session_id: string | null;
  roles: string[];
  scopes: string[];
  revoked_at: string | null;
  revoked_reason: string | null;
};

type AuthorizationRequestRow = {
  state: string;
  nonce: string;
  code_verifier: string;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
  return_to: string | null;
};

type ServiceAccountRow = {
  id: string;
  name: string;
  description: string;
  credential_prefix: string;
  credential_digest: string;
  roles: string[];
  scopes: string[];
  created_at: string;
  created_by: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
};

const ACTOR_COLUMNS = `id, kind, subject_digest, issuer, roles, scopes, directory_groups,
  status, first_seen_at, last_seen_at`;

const SESSION_COLUMNS = `id, actor_id, issued_at, expires_at, authenticated_at,
  authentication_methods, idp_session_id, roles, scopes, revoked_at, revoked_reason`;

const AUTH_REQUEST_COLUMNS = `state, nonce, code_verifier, redirect_uri, created_at,
  expires_at, return_to`;

const SERVICE_ACCOUNT_COLUMNS = `id, name, description, credential_prefix, credential_digest,
  roles, scopes, created_at, created_by, expires_at, last_used_at, revoked_at, revoked_by,
  revoked_reason`;

export class PgIdentityStore implements IdentityStore {
  constructor(private readonly db: Db) {}

  async upsertActor(input: UpsertActorInput): Promise<Actor> {
    assertIsoUtc("seenAt", input.seenAt);

    return this.guard("upsertActor", async () => {
      const rows = await this.db.query<ActorRow>(
        `INSERT INTO identity_actor (${ACTOR_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
         ON CONFLICT (subject_digest) DO UPDATE
           SET roles = EXCLUDED.roles,
               scopes = EXCLUDED.scopes,
               directory_groups = EXCLUDED.directory_groups,
               status = EXCLUDED.status,
               issuer = EXCLUDED.issuer,
               last_seen_at = EXCLUDED.last_seen_at
         RETURNING ${ACTOR_COLUMNS}`,
        [
          input.id,
          input.kind,
          input.subjectDigest,
          input.issuer,
          JSON.stringify([...input.roles]),
          JSON.stringify([...input.scopes]),
          JSON.stringify([...input.directoryGroups]),
          input.status,
          input.seenAt,
        ],
      );
      const row = rows[0];
      if (!row) {
        throw new DeniedError(
          "record.unavailable",
          "The actor record could not be written, so the sign-in was refused.",
          {},
        );
      }
      return toActor(row);
    });
  }

  async getActor(id: Id<"actor">): Promise<Actor | null> {
    const rows = await this.guard("getActor", () =>
      this.db.query<ActorRow>(`SELECT ${ACTOR_COLUMNS} FROM identity_actor WHERE id = $1`, [id]),
    );
    const row = rows[0];
    return row ? toActor(row) : null;
  }

  async getActorBySubjectDigest(subjectDigest: Digest): Promise<Actor | null> {
    const rows = await this.guard("getActorBySubjectDigest", () =>
      this.db.query<ActorRow>(
        `SELECT ${ACTOR_COLUMNS} FROM identity_actor WHERE subject_digest = $1`,
        [subjectDigest],
      ),
    );
    const row = rows[0];
    return row ? toActor(row) : null;
  }

  async listActors(
    filter: { readonly status?: ActorStatus; readonly limit?: number } = {},
  ): Promise<readonly Actor[]> {
    const values: unknown[] = [];
    let where = "";
    if (filter.status !== undefined) {
      values.push(filter.status);
      where = `WHERE status = $${values.length}`;
    }
    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page = ` LIMIT $${values.length}`;
    }
    const rows = await this.guard("listActors", () =>
      this.db.query<ActorRow>(
        `SELECT ${ACTOR_COLUMNS} FROM identity_actor ${where} ORDER BY id ASC${page}`,
        values,
      ),
    );
    return rows.map(toActor);
  }

  async setActorStatus(id: Id<"actor">, status: ActorStatus, at: string): Promise<Actor> {
    assertIsoUtc("at", at);
    const rows = await this.guard("setActorStatus", () =>
      this.db.query<ActorRow>(
        `UPDATE identity_actor SET status = $2, last_seen_at = $3 WHERE id = $1
         RETURNING ${ACTOR_COLUMNS}`,
        [id, status, at],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw identityRefusal("actor_unknown", `No actor ${id}.`, { actorId: id });
    }
    return toActor(row);
  }

  async createSession(session: Session): Promise<Session> {
    assertIsoUtc("issuedAt", session.issuedAt);
    assertIsoUtc("expiresAt", session.expiresAt);
    assertIsoUtc("authenticatedAt", session.authenticatedAt);
    assertOptionalIsoUtc("revokedAt", session.revokedAt);

    const rows = await this.guard("createSession", () =>
      this.db.query<SessionRow>(
        `INSERT INTO identity_session (${SESSION_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${SESSION_COLUMNS}`,
        [
          session.id,
          session.actorId,
          session.issuedAt,
          session.expiresAt,
          session.authenticatedAt,
          JSON.stringify([...session.authenticationMethods]),
          session.idpSessionId ?? null,
          JSON.stringify([...session.roles]),
          JSON.stringify([...session.scopes]),
          session.revokedAt ?? null,
          session.revokedReason ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new InvalidInputError(
        `Session ${session.id} already exists. Reusing a session id would let a revoked session be presented as a fresh one.`,
        "id",
      );
    }
    return toSession(row);
  }

  async getSession(id: Id<"session">): Promise<Session | null> {
    const rows = await this.guard("getSession", () =>
      this.db.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM identity_session WHERE id = $1`, [
        id,
      ]),
    );
    const row = rows[0];
    return row ? toSession(row) : null;
  }

  async listSessionsForActor(actorId: Id<"actor">): Promise<readonly Session[]> {
    const rows = await this.guard("listSessionsForActor", () =>
      this.db.query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM identity_session WHERE actor_id = $1
         ORDER BY issued_at ASC, id ASC`,
        [actorId],
      ),
    );
    return rows.map(toSession);
  }

  async stampAuthentication(id: Id<"session">, authenticatedAt: string): Promise<Session> {
    assertIsoUtc("authenticatedAt", authenticatedAt);
    const rows = await this.guard("stampAuthentication", () =>
      this.db.query<SessionRow>(
        // The `revoked_at IS NULL` guard is what stops a step-up from
        // resurrecting a session someone has already been locked out of.
        `UPDATE identity_session SET authenticated_at = $2
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING ${SESSION_COLUMNS}`,
        [id, authenticatedAt],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw identityRefusal(
        "session_unknown",
        `Session ${id} does not exist or has been revoked.`,
        { sessionId: id },
      );
    }
    return toSession(row);
  }

  async revokeSession(id: Id<"session">, at: string, reason: string): Promise<Session | null> {
    assertIsoUtc("at", at);
    const rows = await this.guard("revokeSession", () =>
      this.db.query<SessionRow>(
        `UPDATE identity_session SET revoked_at = $2, revoked_reason = $3
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING ${SESSION_COLUMNS}`,
        [id, at, reason],
      ),
    );
    const row = rows[0];
    return row ? toSession(row) : null;
  }

  async revokeSessionsForActor(actorId: Id<"actor">, at: string, reason: string): Promise<number> {
    assertIsoUtc("at", at);
    const rows = await this.guard("revokeSessionsForActor", () =>
      this.db.query<{ id: string }>(
        `UPDATE identity_session SET revoked_at = $2, revoked_reason = $3
         WHERE actor_id = $1 AND revoked_at IS NULL
         RETURNING id`,
        [actorId, at, reason],
      ),
    );
    return rows.length;
  }

  async purgeExpiredSessions(before: string): Promise<number> {
    assertIsoUtc("before", before);
    const rows = await this.guard("purgeExpiredSessions", () =>
      this.db.query<{ id: string }>(
        `DELETE FROM identity_session WHERE expires_at < $1 RETURNING id`,
        [before],
      ),
    );
    return rows.length;
  }

  async putAuthorizationRequest(request: AuthorizationRequest): Promise<void> {
    assertIsoUtc("createdAt", request.createdAt);
    assertIsoUtc("expiresAt", request.expiresAt);

    const rows = await this.guard("putAuthorizationRequest", () =>
      this.db.query<{ state: string }>(
        `INSERT INTO identity_authorization_request (${AUTH_REQUEST_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (state) DO NOTHING
         RETURNING state`,
        [
          request.state,
          request.nonce,
          request.codeVerifier,
          request.redirectUri,
          request.createdAt,
          request.expiresAt,
          request.returnTo ?? null,
        ],
      ),
    );
    if (rows.length === 0) {
      throw new InvalidInputError(
        "An authorization request with this state already exists.",
        "state",
      );
    }
  }

  async consumeAuthorizationRequest(state: string): Promise<AuthorizationRequest | null> {
    if (typeof state !== "string" || state.length === 0) return null;
    const rows = await this.guard("consumeAuthorizationRequest", () =>
      this.db.query<AuthorizationRequestRow>(
        // Take and remove in one statement. Concurrent deletes of one row are
        // serialised by Postgres, so exactly one caller sees a row.
        `DELETE FROM identity_authorization_request WHERE state = $1
         RETURNING ${AUTH_REQUEST_COLUMNS}`,
        [state],
      ),
    );
    const row = rows[0];
    return row ? toAuthorizationRequest(row) : null;
  }

  async purgeExpiredAuthorizationRequests(now: string): Promise<number> {
    assertIsoUtc("now", now);
    const rows = await this.guard("purgeExpiredAuthorizationRequests", () =>
      this.db.query<{ state: string }>(
        `DELETE FROM identity_authorization_request WHERE expires_at < $1 RETURNING state`,
        [now],
      ),
    );
    return rows.length;
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DeniedError || error instanceof InvalidInputError) throw error;
      throw storeUnavailable(operation, error);
    }
  }
}

export class PgServiceAccountStore implements ServiceAccountStore {
  constructor(private readonly db: Db) {}

  async createServiceAccount(account: ServiceAccount): Promise<ServiceAccount> {
    assertIsoUtc("createdAt", account.createdAt);
    assertIsoUtc("expiresAt", account.expiresAt);
    assertOptionalIsoUtc("revokedAt", account.revokedAt);
    assertOptionalIsoUtc("lastUsedAt", account.lastUsedAt);

    const rows = await this.guard("createServiceAccount", () =>
      this.db.query<ServiceAccountRow>(
        `INSERT INTO identity_service_account (${SERVICE_ACCOUNT_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT DO NOTHING
         RETURNING ${SERVICE_ACCOUNT_COLUMNS}`,
        [
          account.id,
          account.name,
          account.description,
          account.credentialPrefix,
          account.credentialDigest,
          JSON.stringify([...account.roles]),
          JSON.stringify([...account.scopes]),
          account.createdAt,
          account.createdBy,
          account.expiresAt,
          account.lastUsedAt ?? null,
          account.revokedAt ?? null,
          account.revokedBy ?? null,
          account.revokedReason ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (!row) {
      // Covers a duplicate id, a duplicate name, and a prefix collision. All
      // three are refusals rather than overwrites: an ambiguous credential
      // prefix is a verification that can be steered.
      throw new InvalidInputError(
        `Service account "${account.name}" could not be created: its id, name, or credential prefix is already in use.`,
        "name",
      );
    }
    return toServiceAccount(row);
  }

  async getServiceAccount(id: Id<"actor">): Promise<ServiceAccount | null> {
    const rows = await this.guard("getServiceAccount", () =>
      this.db.query<ServiceAccountRow>(
        `SELECT ${SERVICE_ACCOUNT_COLUMNS} FROM identity_service_account WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toServiceAccount(row) : null;
  }

  async getServiceAccountByPrefix(prefix: string): Promise<ServiceAccount | null> {
    const rows = await this.guard("getServiceAccountByPrefix", () =>
      this.db.query<ServiceAccountRow>(
        `SELECT ${SERVICE_ACCOUNT_COLUMNS} FROM identity_service_account WHERE credential_prefix = $1`,
        [prefix],
      ),
    );
    const row = rows[0];
    return row ? toServiceAccount(row) : null;
  }

  async listServiceAccounts(
    filter: { readonly includeRevoked?: boolean; readonly limit?: number } = {},
  ): Promise<readonly ServiceAccount[]> {
    const values: unknown[] = [];
    const where = filter.includeRevoked === true ? "" : "WHERE revoked_at IS NULL";
    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page = ` LIMIT $${values.length}`;
    }
    const rows = await this.guard("listServiceAccounts", () =>
      this.db.query<ServiceAccountRow>(
        `SELECT ${SERVICE_ACCOUNT_COLUMNS} FROM identity_service_account ${where}
         ORDER BY name ASC${page}`,
        values,
      ),
    );
    return rows.map(toServiceAccount);
  }

  async revokeServiceAccount(
    id: Id<"actor">,
    at: string,
    by: string,
    reason: string,
  ): Promise<ServiceAccount | null> {
    assertIsoUtc("at", at);
    const rows = await this.guard("revokeServiceAccount", () =>
      this.db.query<ServiceAccountRow>(
        `UPDATE identity_service_account
         SET revoked_at = $2, revoked_by = $3, revoked_reason = $4
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING ${SERVICE_ACCOUNT_COLUMNS}`,
        [id, at, by, reason],
      ),
    );
    const row = rows[0];
    return row ? toServiceAccount(row) : null;
  }

  async markServiceAccountUsed(id: Id<"actor">, at: string): Promise<void> {
    assertIsoUtc("at", at);
    await this.guard("markServiceAccountUsed", () =>
      this.db.query(`UPDATE identity_service_account SET last_used_at = $2 WHERE id = $1`, [id, at]),
    );
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DeniedError || error instanceof InvalidInputError) throw error;
      throw storeUnavailable(operation, error);
    }
  }
}

function toActor(row: ActorRow): Actor {
  return {
    id: row.id as Id<"actor">,
    kind: row.kind as Actor["kind"],
    subjectDigest: row.subject_digest as Digest,
    issuer: row.issuer,
    roles: row.roles as RoleName[],
    scopes: row.scopes as Scope[],
    directoryGroups: row.directory_groups,
    status: row.status as ActorStatus,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id as Id<"session">,
    actorId: row.actor_id as Id<"actor">,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    authenticatedAt: row.authenticated_at,
    authenticationMethods: row.authentication_methods,
    idpSessionId: row.idp_session_id ?? undefined,
    roles: row.roles as RoleName[],
    scopes: row.scopes as Scope[],
    revokedAt: row.revoked_at ?? undefined,
    revokedReason: row.revoked_reason ?? undefined,
  };
}

function toAuthorizationRequest(row: AuthorizationRequestRow): AuthorizationRequest {
  return {
    state: row.state,
    nonce: row.nonce,
    codeVerifier: row.code_verifier,
    redirectUri: row.redirect_uri,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    returnTo: row.return_to ?? undefined,
  };
}

function toServiceAccount(row: ServiceAccountRow): ServiceAccount {
  return {
    id: row.id as Id<"actor">,
    name: row.name,
    description: row.description,
    credentialPrefix: row.credential_prefix,
    credentialDigest: row.credential_digest as Digest,
    roles: row.roles as RoleName[],
    scopes: row.scopes as Scope[],
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    revokedBy: row.revoked_by ?? undefined,
    revokedReason: row.revoked_reason ?? undefined,
  };
}
