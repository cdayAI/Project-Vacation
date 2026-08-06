import { createHmac } from "node:crypto";
import { canonicalJson } from "../kernel/canonical.js";
import type { Clock } from "../kernel/clock.js";
import { ConfigError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { ActorRef } from "../record/types.js";
import { identityRefusal } from "./denials.js";
import type { IdentityStore } from "./port.js";
import type { MappedEntitlements } from "./roles.js";
import { secretsEqual } from "./secrets.js";
import { toActorRef, type Actor, type Session, type VerifiedIdentity } from "./types.js";

/**
 * Sessions, and the step-up clock the authorization chokepoint reads.
 *
 * The cookie carries a session id and an integrity tag. It carries no roles,
 * no scopes, and no entitlements of any kind. That is the single most
 * important decision in this file: a cookie that carried entitlements would be
 * a bearer token for yesterday's access, and revoking someone would mean
 * waiting for it to expire. Everything that decides what a person may do is
 * read from the store on every request, so removing a directory group takes
 * effect on the next click rather than the next day.
 *
 * The signature is an HMAC over the cookie's canonical JSON. It does not make
 * the session id secret — the browser has it either way — it makes the cookie
 * unforgeable, so that a session id cannot be guessed or incremented into a
 * different person's session without also producing a valid tag.
 *
 * Two audit events originate here, and both are in the shared event vocabulary
 * rather than invented locally:
 *
 *   `identity.session_started`     someone signed in, with what roles.
 *   `identity.step_up_completed`   someone re-proved who they are, which is
 *                                  what makes `secondsSinceAuthentication`
 *                                  small enough for a high-consequence action
 *                                  to pass the chokepoint.
 */

/** The cookie name. Prefixed so it is obviously ours in a browser inspector. */
export const SESSION_COOKIE_NAME = "pv_session";

/** Bumped if the payload shape ever changes, so old cookies fail closed. */
const COOKIE_VERSION = "v1";

const MIN_SECRET_LENGTH = 32;

export interface SessionCookiePayload {
  /** Session id. */
  readonly sid: string;
  /** Actor id, so a cookie cannot be pointed at another actor's session. */
  readonly aid: string;
  /** Issued-at and expiry, in epoch seconds. */
  readonly iat: number;
  readonly exp: number;
}

export interface SessionCookieAttributes {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "lax";
  readonly path: "/";
  readonly maxAge: number;
}

export interface IssuedSession {
  readonly session: Session;
  readonly actor: Actor;
  readonly actorRef: ActorRef;
  /** The cookie value to set. */
  readonly cookie: string;
  readonly cookieAttributes: SessionCookieAttributes;
}

export interface ResolvedSession {
  readonly session: Session;
  readonly actor: Actor;
  readonly actorRef: ActorRef;
  /**
   * Seconds since the actor last proved who they are.
   *
   * Passed straight into `ActionRequest.secondsSinceAuthentication`, which is
   * what the chokepoint's step-up check compares against
   * `PV_STEP_UP_MAX_AGE_SECONDS`.
   */
  readonly secondsSinceAuthentication: number;
}

export interface SessionServiceOptions {
  /** How long a session lives before the person must sign in again. */
  readonly sessionTtlMs?: number;
  /**
   * Whether to mark the cookie `Secure`.
   *
   * True everywhere except local development over plain HTTP. `loadConfig`
   * refuses to start without OIDC in staging and production, so the only
   * deployments that can legitimately pass `false` are the ones on localhost.
   */
  readonly secureCookie?: boolean;
}

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export class SessionService {
  private readonly sessionTtlMs: number;
  private readonly secureCookie: boolean;

  constructor(
    private readonly store: IdentityStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly audit: AuditLog,
    private readonly sessionSecret: string,
    options: SessionServiceOptions = {},
  ) {
    // Fail closed at construction. A platform that will happily issue
    // unsigned or weakly signed sessions must not reach the point of
    // accepting a request.
    if (typeof sessionSecret !== "string" || sessionSecret.length < MIN_SECRET_LENGTH) {
      throw new ConfigError(
        `The session secret must be at least ${MIN_SECRET_LENGTH} characters. Sessions are refused rather than signed with a weak key.`,
        { field: "sessionSecret" },
      );
    }
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.secureCookie = options.secureCookie ?? true;
  }

  /**
   * Open a session for a verified identity.
   *
   * The actor record is written first and the session second. If the audit
   * receipt cannot be written, `AuditLog.record` raises and the caller never
   * receives a cookie — a sign-in nobody can account for does not happen.
   */
  async start(input: {
    readonly identity: VerifiedIdentity;
    readonly entitlements: MappedEntitlements;
    readonly correlationId?: string;
  }): Promise<IssuedSession> {
    const { identity, entitlements } = input;
    const nowMs = this.clock.now();
    const nowIso = new Date(nowMs).toISOString();

    const subjectDigest = digestValue({ issuer: identity.issuer, subject: identity.subject });

    // A person's actor id is stable across sign-ins so that a year of audit
    // entries names the same subject. The store keys on `subjectDigest`, so
    // the generated id below is used only the first time we see them.
    const existing = await this.store.getActorBySubjectDigest(subjectDigest);
    const actorId = existing?.id ?? this.ids.next("actor");

    const deprovisioned = entitlements.roles.length === 0 && entitlements.scopes.length === 0;

    const actor = await this.store.upsertActor({
      id: actorId,
      kind: "human",
      subjectDigest,
      issuer: identity.issuer,
      roles: entitlements.roles,
      scopes: entitlements.scopes,
      directoryGroups: entitlements.matchedGroups,
      status: deprovisioned ? "deprovisioned" : "active",
      seenAt: nowIso,
    });

    if (deprovisioned) {
      // The directory is not asserting that this person belongs here. Their
      // existing sessions go too, so a group removed five minutes ago cannot
      // keep working through a tab that is already open.
      await this.store.revokeSessionsForActor(actor.id, nowIso, "directory_groups_removed");
      throw identityRefusal(
        "no_entitlements",
        "The directory asserts no group that maps to a role on this platform, so there is nothing to sign in to. Access is granted by directory group membership and nowhere else.",
        { actorId: actor.id },
      );
    }

    const session: Session = {
      // A fresh id on every sign-in. Reusing one would let a session fixed
      // before authentication survive it, which is the whole session-fixation
      // attack.
      id: this.ids.next("session"),
      actorId: actor.id,
      issuedAt: nowIso,
      expiresAt: new Date(nowMs + this.sessionTtlMs).toISOString(),
      // The provider's `auth_time` when it gave one; otherwise now. Taking the
      // provider's value matters: a silent re-authentication against a session
      // the provider opened an hour ago must not read as a fresh step-up.
      authenticatedAt: identity.authenticatedAt ?? nowIso,
      authenticationMethods: identity.authenticationMethods,
      idpSessionId: identity.idpSessionId,
      roles: actor.roles,
      scopes: actor.scopes,
    };

    const created = await this.store.createSession(session);

    await this.audit.record(
      auditDecision({
        eventType: "identity.session_started",
        actorId: actor.id,
        actorKind: "human",
        actorRoles: actor.roles,
        correlationId: input.correlationId,
        subject: { sessionId: created.id, issuer: identity.issuer },
        // The claim set is fingerprinted, never recorded. An audit entry has to
        // prove which assertion the session was opened on, not retain it.
        inputDigests: { claims: identity.claimsDigest, subject: subjectDigest },
        decision: {
          roles: actor.roles.join(","),
          scopes: actor.scopes.join(","),
          groups: actor.directoryGroups.length,
          methods: identity.authenticationMethods.join(","),
          expiresAt: created.expiresAt,
        },
      }),
    );

    return {
      session: created,
      actor,
      actorRef: toActorRef(actor),
      cookie: this.signCookie({
        sid: created.id,
        aid: actor.id,
        iat: Math.floor(nowMs / 1000),
        exp: Math.floor((nowMs + this.sessionTtlMs) / 1000),
      }),
      cookieAttributes: this.cookieAttributes(),
    };
  }

  /**
   * Resolve a cookie to the actor it names, or refuse.
   *
   * Every check is a refusal rather than a downgrade. There is no path here
   * that returns a partially trusted caller, because every consumer of the
   * result treats it as "this is who is calling".
   *
   * @throws {DeniedError} on a forged, expired, revoked, unknown, or
   *   deprovisioned session, and if the store cannot answer.
   */
  async resolve(cookieValue: string | undefined): Promise<ResolvedSession> {
    const payload = this.verifyCookie(cookieValue);
    if (!payload) {
      throw identityRefusal("cookie_invalid", "No valid session cookie was presented.");
    }

    const nowMs = this.clock.now();
    if (payload.exp * 1000 <= nowMs) {
      throw identityRefusal("cookie_expired", "The session cookie has expired.");
    }

    // A store failure raises out of here as a denial. "We cannot tell who this
    // is" must never resolve to "let them through".
    const session = await this.store.getSession(payload.sid as Id<"session">);
    if (!session) {
      throw identityRefusal("session_unknown", "The session is not in the store.");
    }
    if (session.actorId !== payload.aid) {
      // The signature already makes this unreachable without the secret. It is
      // checked anyway: a mismatch would mean the signing key had leaked or the
      // store had been tampered with, and both are worth refusing loudly.
      throw identityRefusal("session_actor_mismatch", "The session does not belong to this actor.");
    }
    if (session.revokedAt) {
      throw identityRefusal("session_revoked", `The session was revoked at ${session.revokedAt}.`, {
        reason: session.revokedReason ?? "",
      });
    }
    if (session.expiresAt <= new Date(nowMs).toISOString()) {
      throw identityRefusal("session_expired", `The session expired at ${session.expiresAt}.`);
    }

    const actor = await this.store.getActor(session.actorId);
    if (!actor) {
      throw identityRefusal("actor_unknown", "The session names an actor that no longer exists.");
    }
    if (actor.status !== "active") {
      // The immediate half of the revocation guarantee. A directory group
      // removed since sign-in takes effect here, on the next request.
      throw identityRefusal(
        "actor_deprovisioned",
        "This actor has been deprovisioned. Access follows directory group membership.",
        { actorId: actor.id },
      );
    }

    return {
      session,
      actor,
      // Entitlements come from the actor, which is refreshed at every sign-in,
      // rather than from the session snapshot, which is history.
      actorRef: toActorRef(actor),
      secondsSinceAuthentication: secondsSince(session.authenticatedAt, nowMs),
    };
  }

  /**
   * Record a completed step-up re-authentication.
   *
   * The caller has already re-run the provider's flow with `prompt=login` (or
   * `acr_values` for a specific assurance level) and verified the resulting ID
   * token. This stamps the time, which is what makes the chokepoint's step-up
   * check pass for the next few minutes and no longer.
   *
   * @throws {DeniedError} if the identity does not belong to the session's
   *   actor. Without that check, one person's fresh re-authentication would
   *   step up somebody else's session.
   */
  async stepUp(input: {
    readonly sessionId: Id<"session">;
    readonly identity: VerifiedIdentity;
    readonly correlationId?: string;
  }): Promise<ResolvedSession> {
    const session = await this.store.getSession(input.sessionId);
    if (!session || session.revokedAt) {
      throw identityRefusal("session_unknown", "There is no live session to step up.");
    }
    const actor = await this.store.getActor(session.actorId);
    if (!actor || actor.status !== "active") {
      throw identityRefusal("actor_deprovisioned", "The session's actor is not active.");
    }

    const subjectDigest = digestValue({
      issuer: input.identity.issuer,
      subject: input.identity.subject,
    });
    if (subjectDigest !== actor.subjectDigest) {
      throw identityRefusal(
        "step_up_subject_mismatch",
        "The re-authentication was performed by a different person than the session's owner.",
        { sessionId: session.id },
      );
    }

    const nowMs = this.clock.now();
    const authenticatedAt = new Date(nowMs).toISOString();
    const stamped = await this.store.stampAuthentication(session.id, authenticatedAt);

    await this.audit.record(
      auditDecision({
        eventType: "identity.step_up_completed",
        actorId: actor.id,
        actorKind: "human",
        actorRoles: actor.roles,
        correlationId: input.correlationId,
        subject: { sessionId: session.id },
        inputDigests: { claims: input.identity.claimsDigest },
        decision: {
          methods: input.identity.authenticationMethods.join(","),
          authenticatedAt,
        },
      }),
    );

    return {
      session: stamped,
      actor,
      actorRef: toActorRef(actor),
      secondsSinceAuthentication: secondsSince(stamped.authenticatedAt, nowMs),
    };
  }

  /** End a session. Idempotent: revoking an already-revoked session is fine. */
  async revoke(
    sessionId: Id<"session">,
    reason: string,
  ): Promise<Session | null> {
    return this.store.revokeSession(sessionId, this.clock.nowIso(), reason);
  }

  /**
   * Deprovision an actor and end every session they hold.
   *
   * The manual counterpart to a directory group disappearing — used when
   * somebody has to be locked out now rather than at their next sign-in.
   */
  async deprovision(actorId: Id<"actor">, reason: string): Promise<number> {
    const at = this.clock.nowIso();
    await this.store.setActorStatus(actorId, "deprovisioned", at);
    return this.store.revokeSessionsForActor(actorId, at, reason);
  }

  cookieAttributes(): SessionCookieAttributes {
    return {
      httpOnly: true,
      secure: this.secureCookie,
      // Lax rather than Strict: the OIDC callback is a top-level navigation
      // from the identity provider, and Strict would drop the cookie on the
      // hop that immediately follows sign-in. Lax still blocks the
      // cross-site POST that CSRF depends on.
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(this.sessionTtlMs / 1000),
    };
  }

  /** The `Set-Cookie` value that clears the session. */
  clearedCookie(): string {
    return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${this.secureCookie ? "; Secure" : ""}`;
  }

  signCookie(payload: SessionCookiePayload): string {
    return signSessionCookie(payload, this.sessionSecret);
  }

  verifyCookie(value: string | undefined): SessionCookiePayload | null {
    return verifySessionCookie(value, this.sessionSecret);
  }
}

/**
 * Produce `v1.<payload>.<tag>`.
 *
 * The payload is canonical JSON, so the bytes that were signed are the bytes
 * that are verified regardless of key order — the same property the audit
 * chain depends on, for the same reason.
 */
export function signSessionCookie(payload: SessionCookiePayload, secret: string): string {
  const body = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  return `${COOKIE_VERSION}.${body}.${cookieTag(body, secret)}`;
}

/**
 * Verify and parse a cookie, or return null.
 *
 * Returns null rather than throwing because a malformed cookie is the ordinary
 * case for a first-time visitor, not an incident. The caller turns null into a
 * refusal; there is no path where null means "proceed".
 */
export function verifySessionCookie(
  value: string | undefined,
  secret: string,
): SessionCookiePayload | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;

  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [version, body, tag] = parts;
  if (version !== COOKIE_VERSION || !body || !tag) return null;

  // Constant-time. A byte-at-a-time comparison here would let an attacker
  // discover a valid tag for a session id of their choosing.
  if (!secretsEqual(tag, cookieTag(body, secret))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (
    typeof record["sid"] !== "string" ||
    typeof record["aid"] !== "string" ||
    typeof record["iat"] !== "number" ||
    typeof record["exp"] !== "number"
  ) {
    return null;
  }
  return { sid: record["sid"], aid: record["aid"], iat: record["iat"], exp: record["exp"] };
}

function cookieTag(body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${COOKIE_VERSION}.${body}`).digest("base64url");
}

function secondsSince(iso: string, nowMs: number): number {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    // An unparseable stamp must not read as "authenticated just now". Infinity
    // fails every step-up check, which is the safe direction.
    return Number.POSITIVE_INFINITY;
  }
  // Clamped at zero: a stamp slightly in the future (clock skew between this
  // process and the provider) must not produce a negative age that would
  // satisfy a step-up check forever.
  return Math.max(0, Math.floor((nowMs - then) / 1000));
}
