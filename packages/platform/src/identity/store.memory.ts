import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import type { MemoryDb } from "../store/db.js";
import { identityRefusal } from "./denials.js";
import type { IdentityStore, ServiceAccountStore, UpsertActorInput } from "./port.js";
import type { Actor, ActorStatus, AuthorizationRequest, ServiceAccount, Session } from "./types.js";

/**
 * In-memory identity.
 *
 * Held to the same contract as the Postgres adapter. The operations the port
 * specifies as atomic take `MemoryDb.withLock`, mirroring the row lock or the
 * conditional UPDATE the real store uses:
 *
 *   `upsertActor`                    two first sign-ins for the same subject
 *                                    must produce one actor, not two.
 *   `consumeAuthorizationRequest`    exactly one caller may take a state.
 *   `revokeServiceAccount`           exactly one caller performs a revocation,
 *                                    so an "already revoked" answer is true.
 *
 * As in the operating record's fake, everything is cloned on the way in and
 * out. A caller holding a reference to a stored session must not be able to
 * clear its own `revokedAt`.
 */

const ACTORS = "identity_actor";
const SESSIONS = "identity_session";
const AUTH_REQUESTS = "identity_authorization_request";
const SERVICE_ACCOUNTS = "identity_service_account";

export class MemoryIdentityStore implements IdentityStore {
  constructor(private readonly db: MemoryDb) {}

  async upsertActor(input: UpsertActorInput): Promise<Actor> {
    assertIsoUtc("seenAt", input.seenAt);

    // Keyed on the subject digest, not on the supplied id: the id is only
    // used the first time a subject is seen. Two concurrent first sign-ins
    // would otherwise each mint an id and one person would end up with two
    // actor records and a split audit trail.
    return this.db.withLock(`identity:actor:${input.subjectDigest}`, async () => {
      const table = this.db.table<Actor>(ACTORS);
      const existing = [...table.values()].find(
        (actor) => actor.subjectDigest === input.subjectDigest,
      );

      const next: Actor = {
        id: existing?.id ?? input.id,
        kind: input.kind,
        subjectDigest: input.subjectDigest,
        issuer: input.issuer,
        // Overwritten, never merged. A directory group that disappears has to
        // take its access with it.
        roles: [...input.roles],
        scopes: [...input.scopes],
        directoryGroups: [...input.directoryGroups],
        status: input.status,
        firstSeenAt: existing?.firstSeenAt ?? input.seenAt,
        lastSeenAt: input.seenAt,
      };
      table.set(next.id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async getActor(id: Id<"actor">): Promise<Actor | null> {
    const found = this.db.table<Actor>(ACTORS).get(id);
    return found ? structuredClone(found) : null;
  }

  async getActorBySubjectDigest(subjectDigest: Digest): Promise<Actor | null> {
    const found = this.db
      .rows<Actor>(ACTORS)
      .find((actor) => actor.subjectDigest === subjectDigest);
    return found ? structuredClone(found) : null;
  }

  async listActors(
    filter: { readonly status?: ActorStatus; readonly limit?: number } = {},
  ): Promise<readonly Actor[]> {
    const matched = this.db
      .rows<Actor>(ACTORS)
      .filter((actor) => filter.status === undefined || actor.status === filter.status)
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const limited = filter.limit === undefined ? matched : matched.slice(0, filter.limit);
    return limited.map((actor) => structuredClone(actor));
  }

  async setActorStatus(id: Id<"actor">, status: ActorStatus, at: string): Promise<Actor> {
    assertIsoUtc("at", at);
    return this.db.withLock(`identity:actor-status:${id}`, async () => {
      const table = this.db.table<Actor>(ACTORS);
      const current = table.get(id);
      if (!current) {
        throw identityRefusal("actor_unknown", `No actor ${id}.`, { actorId: id });
      }
      const next: Actor = { ...current, status, lastSeenAt: at };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async createSession(session: Session): Promise<Session> {
    assertIsoUtc("issuedAt", session.issuedAt);
    assertIsoUtc("expiresAt", session.expiresAt);
    assertIsoUtc("authenticatedAt", session.authenticatedAt);
    assertOptionalIsoUtc("revokedAt", session.revokedAt);

    return this.db.withLock(`identity:session:${session.id}`, async () => {
      const table = this.db.table<Session>(SESSIONS);
      if (table.has(session.id)) {
        throw new InvalidInputError(
          `Session ${session.id} already exists. Reusing a session id would let a revoked session be presented as a fresh one.`,
          "id",
        );
      }
      if (!this.db.table<Actor>(ACTORS).has(session.actorId)) {
        throw new DeniedError(
          "record.unavailable",
          `Cannot open a session for ${session.actorId}: no such actor.`,
          { actorId: session.actorId },
        );
      }
      table.set(session.id, structuredClone(session));
      return structuredClone(session);
    });
  }

  async getSession(id: Id<"session">): Promise<Session | null> {
    const found = this.db.table<Session>(SESSIONS).get(id);
    return found ? structuredClone(found) : null;
  }

  async listSessionsForActor(actorId: Id<"actor">): Promise<readonly Session[]> {
    return this.db
      .rows<Session>(SESSIONS)
      .filter((session) => session.actorId === actorId)
      .sort((left, right) => (left.issuedAt < right.issuedAt ? -1 : 1))
      .map((session) => structuredClone(session));
  }

  async stampAuthentication(id: Id<"session">, authenticatedAt: string): Promise<Session> {
    assertIsoUtc("authenticatedAt", authenticatedAt);
    return this.db.withLock(`identity:session:${id}`, async () => {
      const table = this.db.table<Session>(SESSIONS);
      const current = table.get(id);
      if (!current) {
        throw identityRefusal("session_unknown", `No session ${id}.`, { sessionId: id });
      }
      if (current.revokedAt) {
        // A step-up must not resurrect a revoked session. Without this the
        // re-authentication path would be a way back in after a lock-out.
        throw identityRefusal("session_revoked", `Session ${id} is revoked.`, { sessionId: id });
      }
      const next: Session = { ...current, authenticatedAt };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async revokeSession(id: Id<"session">, at: string, reason: string): Promise<Session | null> {
    assertIsoUtc("at", at);
    return this.db.withLock(`identity:session:${id}`, async () => {
      const table = this.db.table<Session>(SESSIONS);
      const current = table.get(id);
      // Compare and set. A session that is already revoked yields null, so a
      // caller can tell "I revoked it" from "it was already gone".
      if (!current || current.revokedAt) return null;
      const next: Session = { ...current, revokedAt: at, revokedReason: reason };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async revokeSessionsForActor(actorId: Id<"actor">, at: string, reason: string): Promise<number> {
    assertIsoUtc("at", at);
    return this.db.withLock(`identity:sessions:${actorId}`, async () => {
      const table = this.db.table<Session>(SESSIONS);
      let revoked = 0;
      for (const [id, session] of table) {
        if (session.actorId !== actorId || session.revokedAt) continue;
        table.set(id, structuredClone({ ...session, revokedAt: at, revokedReason: reason }));
        revoked += 1;
      }
      return revoked;
    });
  }

  async purgeExpiredSessions(before: string): Promise<number> {
    assertIsoUtc("before", before);
    return this.db.withLock("identity:sessions:purge", async () => {
      const table = this.db.table<Session>(SESSIONS);
      let removed = 0;
      for (const [id, session] of [...table]) {
        if (session.expiresAt >= before) continue;
        table.delete(id);
        removed += 1;
      }
      return removed;
    });
  }

  async putAuthorizationRequest(request: AuthorizationRequest): Promise<void> {
    assertIsoUtc("createdAt", request.createdAt);
    assertIsoUtc("expiresAt", request.expiresAt);
    await this.db.withLock(`identity:authreq:${request.state}`, async () => {
      const table = this.db.table<AuthorizationRequest>(AUTH_REQUESTS);
      if (table.has(request.state)) {
        // A state collision means the generator repeated itself, which would
        // break the single-use property. Refuse rather than overwrite.
        throw new InvalidInputError(
          "An authorization request with this state already exists.",
          "state",
        );
      }
      table.set(request.state, structuredClone(request));
    });
  }

  async consumeAuthorizationRequest(state: string): Promise<AuthorizationRequest | null> {
    if (typeof state !== "string" || state.length === 0) return null;
    return this.db.withLock(`identity:authreq:${state}`, async () => {
      const table = this.db.table<AuthorizationRequest>(AUTH_REQUESTS);
      const found = table.get(state);
      if (!found) return null;
      // Take and remove, under the lock. Of N concurrent callers presenting
      // the same state, exactly one gets a request and the rest get null.
      table.delete(state);
      return structuredClone(found);
    });
  }

  async purgeExpiredAuthorizationRequests(now: string): Promise<number> {
    assertIsoUtc("now", now);
    return this.db.withLock("identity:authreq:purge", async () => {
      const table = this.db.table<AuthorizationRequest>(AUTH_REQUESTS);
      let removed = 0;
      for (const [state, request] of [...table]) {
        if (request.expiresAt >= now) continue;
        table.delete(state);
        removed += 1;
      }
      return removed;
    });
  }
}

export class MemoryServiceAccountStore implements ServiceAccountStore {
  constructor(private readonly db: MemoryDb) {}

  async createServiceAccount(account: ServiceAccount): Promise<ServiceAccount> {
    assertIsoUtc("createdAt", account.createdAt);
    assertIsoUtc("expiresAt", account.expiresAt);
    assertOptionalIsoUtc("revokedAt", account.revokedAt);
    assertOptionalIsoUtc("lastUsedAt", account.lastUsedAt);

    return this.db.withLock("identity:service-accounts", async () => {
      const table = this.db.table<ServiceAccount>(SERVICE_ACCOUNTS);
      for (const existing of table.values()) {
        if (existing.id === account.id) {
          throw new InvalidInputError(`Service account ${account.id} already exists.`, "id");
        }
        if (existing.name === account.name) {
          throw new InvalidInputError(
            `Service account "${account.name}" already exists. Names identify a credential in the audit trail and must not be reused.`,
            "name",
          );
        }
        if (existing.credentialPrefix === account.credentialPrefix) {
          // Two accounts sharing a prefix would make verification ambiguous,
          // and an ambiguous verification is one that can be steered.
          throw new InvalidInputError(
            "Credential prefix collision. Reissue rather than storing an ambiguous prefix.",
            "credentialPrefix",
          );
        }
      }
      table.set(account.id, structuredClone(account));
      return structuredClone(account);
    });
  }

  async getServiceAccount(id: Id<"actor">): Promise<ServiceAccount | null> {
    const found = this.db.table<ServiceAccount>(SERVICE_ACCOUNTS).get(id);
    return found ? structuredClone(found) : null;
  }

  async getServiceAccountByPrefix(prefix: string): Promise<ServiceAccount | null> {
    const found = this.db
      .rows<ServiceAccount>(SERVICE_ACCOUNTS)
      .find((account) => account.credentialPrefix === prefix);
    return found ? structuredClone(found) : null;
  }

  async listServiceAccounts(
    filter: { readonly includeRevoked?: boolean; readonly limit?: number } = {},
  ): Promise<readonly ServiceAccount[]> {
    const matched = this.db
      .rows<ServiceAccount>(SERVICE_ACCOUNTS)
      .filter((account) => filter.includeRevoked === true || !account.revokedAt)
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const limited = filter.limit === undefined ? matched : matched.slice(0, filter.limit);
    return limited.map((account) => structuredClone(account));
  }

  async revokeServiceAccount(
    id: Id<"actor">,
    at: string,
    by: string,
    reason: string,
  ): Promise<ServiceAccount | null> {
    assertIsoUtc("at", at);
    return this.db.withLock(`identity:service-account:${id}`, async () => {
      const table = this.db.table<ServiceAccount>(SERVICE_ACCOUNTS);
      const current = table.get(id);
      if (!current || current.revokedAt) return null;
      const next: ServiceAccount = {
        ...current,
        revokedAt: at,
        revokedBy: by,
        revokedReason: reason,
      };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async markServiceAccountUsed(id: Id<"actor">, at: string): Promise<void> {
    assertIsoUtc("at", at);
    await this.db.withLock(`identity:service-account:${id}`, async () => {
      const table = this.db.table<ServiceAccount>(SERVICE_ACCOUNTS);
      const current = table.get(id);
      if (!current) return;
      table.set(id, structuredClone({ ...current, lastUsedAt: at }));
    });
  }
}
