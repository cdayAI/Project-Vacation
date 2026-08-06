import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
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
 * Persistence ports for identity.
 *
 * Two operations here carry concurrency requirements that a caller cannot
 * satisfy with a read followed by a write, so they are expressed as single
 * atomic operations and implemented as such in both adapters:
 *
 *   `consumeAuthorizationRequest` must succeed for exactly one caller. The
 *   state parameter is a single-use anti-forgery token; if a replayed callback
 *   could consume it a second time, an attacker who observed one callback URL
 *   could sign in as the person it belonged to. Read-then-delete leaves that
 *   window open.
 *
 *   `revokeServiceAccount` must be observable by the very next verification.
 *   "Revocation is immediate" is only true if the verification path reads
 *   committed state rather than a cache, which is why there is no cache here
 *   and no `getServiceAccount` variant that promises a stale answer.
 *
 * As everywhere else in this platform, a read that cannot be served raises
 * rather than returning nothing. "This session does not exist" and "we cannot
 * tell whether this session exists" must not look the same to a caller: the
 * first is a sign-in prompt and the second is a refusal.
 */
export interface IdentityStore {
  /**
   * Record what the directory asserted about a subject.
   *
   * Creates the actor on first sight and overwrites roles, scopes, and groups
   * on every later sign-in. Overwriting rather than merging is deliberate: a
   * group removed in the directory must remove the access it granted, and a
   * merge would make removal impossible.
   */
  upsertActor(input: UpsertActorInput): Promise<Actor>;
  getActor(id: Id<"actor">): Promise<Actor | null>;
  getActorBySubjectDigest(subjectDigest: Digest): Promise<Actor | null>;
  listActors(filter?: {
    readonly status?: ActorStatus;
    readonly limit?: number;
  }): Promise<readonly Actor[]>;
  /** Mark an actor deprovisioned. Their live sessions stop working at once. */
  setActorStatus(id: Id<"actor">, status: ActorStatus, at: IsoTimestamp): Promise<Actor>;

  createSession(session: Session): Promise<Session>;
  getSession(id: Id<"session">): Promise<Session | null>;
  listSessionsForActor(actorId: Id<"actor">): Promise<readonly Session[]>;
  /** Move `authenticatedAt` forward after a step-up. Refuses a revoked session. */
  stampAuthentication(id: Id<"session">, authenticatedAt: IsoTimestamp): Promise<Session>;
  revokeSession(id: Id<"session">, at: IsoTimestamp, reason: string): Promise<Session | null>;
  /** Revoke every live session for an actor. Returns how many were revoked. */
  revokeSessionsForActor(actorId: Id<"actor">, at: IsoTimestamp, reason: string): Promise<number>;
  /** Remove sessions that expired before `before`. Housekeeping, not a control. */
  purgeExpiredSessions(before: IsoTimestamp): Promise<number>;

  putAuthorizationRequest(request: AuthorizationRequest): Promise<void>;
  /**
   * Take the pending request for `state`, atomically, and remove it.
   *
   * Returns `null` when there is nothing to take — which covers an unknown
   * state, a replayed callback, and a request that has already been consumed.
   * The caller must treat all three the same way: refuse.
   */
  consumeAuthorizationRequest(state: string): Promise<AuthorizationRequest | null>;
  /** Drop authorization requests past their expiry. Returns how many. */
  purgeExpiredAuthorizationRequests(now: IsoTimestamp): Promise<number>;
}

export interface UpsertActorInput {
  readonly id: Id<"actor">;
  readonly kind: "human" | "service";
  readonly subjectDigest: Digest;
  readonly issuer: string;
  readonly roles: readonly RoleName[];
  readonly scopes: readonly Scope[];
  readonly directoryGroups: readonly string[];
  readonly status: ActorStatus;
  readonly seenAt: IsoTimestamp;
}

/**
 * Persistence port for machine credentials.
 *
 * Separate from `IdentityStore` because the two have different blast radii. A
 * bug in session handling logs someone out; a bug here hands out a credential
 * or fails to revoke one. Keeping the surface small makes it possible to read
 * the whole thing in one sitting, which is the only review that catches this
 * class of bug.
 */
export interface ServiceAccountStore {
  createServiceAccount(account: ServiceAccount): Promise<ServiceAccount>;
  getServiceAccount(id: Id<"actor">): Promise<ServiceAccount | null>;
  /** Look up by the non-secret half of the credential. */
  getServiceAccountByPrefix(prefix: string): Promise<ServiceAccount | null>;
  listServiceAccounts(filter?: {
    readonly includeRevoked?: boolean;
    readonly limit?: number;
  }): Promise<readonly ServiceAccount[]>;
  /**
   * Revoke a credential.
   *
   * Returns the updated account, or `null` if it was already revoked — so a
   * caller can tell "I revoked it" from "it was already gone" without a
   * separate read that would race the revocation it is reporting on.
   */
  revokeServiceAccount(
    id: Id<"actor">,
    at: IsoTimestamp,
    by: string,
    reason: string,
  ): Promise<ServiceAccount | null>;
  /** Record successful use. Best-effort telemetry; never gates authentication. */
  markServiceAccountUsed(id: Id<"actor">, at: IsoTimestamp): Promise<void>;
}
