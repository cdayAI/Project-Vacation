import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";

/**
 * Who is acting, and what they are allowed to be.
 *
 * Three decisions run through every type in this file.
 *
 * *There is no local password store.* Human identity comes from MVW's identity
 * provider over OIDC and from nowhere else. Nothing here has a password, a
 * password hash, a reset token, or a "local account" escape hatch, and the
 * schema has no column for one. A platform that can authenticate a person
 * without the directory is a platform where a departing employee keeps access
 * after HR has switched them off.
 *
 * *Roles are held, not stored as a preference.* Every role a person holds is
 * derived from the directory groups the identity provider asserted at sign-in
 * (see `roles.ts`). Nobody grants a role inside this platform, so access
 * follows the HR lifecycle automatically: the group goes away, the next
 * sign-in yields no roles, and the session store is checked on every request
 * so an existing session stops working too.
 *
 * *The platform keeps a pseudonym, not a person.* An `Actor` carries a digest
 * of `issuer|subject` and the groups that digest was asserted with. It does
 * not carry a name, an email address, or an employee number. The directory
 * already holds those and is the right place to read them from; duplicating
 * them here would put employee personal data into the audit surface, into
 * backups, and into every export, in exchange for nothing the console cannot
 * get from the directory at render time.
 */

/**
 * The roles MVW actually works in.
 *
 * Deliberately a closed union rather than free-form strings. A typo in a role
 * name is otherwise indistinguishable from a role nobody holds, which fails in
 * the safe direction on the authorization path and in the *unsafe* direction
 * on the mapping path — a group mapped to `complaince_reviewer` would silently
 * grant nothing, and the person would ask an administrator for a workaround.
 */
export const ROLE_NAMES = [
  /** Front-line owner services. Prepares work; sends nothing on their own. */
  "owner_services_agent",
  /** Approves front-line work and operates the containment switches. */
  "supervisor",
  /** Reviews consumer-facing and legally significant work before it lands. */
  "compliance_reviewer",
  /** Runs one or more homeowners' associations. Scoped to those associations. */
  "association_manager",
  /** Reads cost and spend across the platform. */
  "finance",
  /** Operates the platform itself: configuration, credentials, containment. */
  "platform_admin",
  /**
   * Sees everything and changes nothing.
   *
   * Encoded, not merely intended: `ROLE_CAPABILITIES.auditor` is exactly the
   * set of capabilities marked `mutates: false`, and a test asserts both
   * halves of that — every read capability is held, and no mutating one is.
   * An auditor who can quietly alter what they are auditing is not an auditor.
   */
  "auditor",
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

export function isRoleName(value: string): value is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(value);
}

/**
 * What a role may do, in terms the platform can reason about.
 *
 * These are coarser than the action registry in `actions.ts`, and that is the
 * point: the registry answers "may this action be performed right now", which
 * depends on mode, approvals, ceilings, and containment. Capabilities answer
 * the prior question of what a role is *for*, which is what a console renders
 * a navigation menu from and what makes the read-only guarantee for `auditor`
 * checkable in one place.
 *
 * `mutates` is the load-bearing field. It is what turns "the auditor changes
 * nothing" from a sentence in a document into an assertion a test can make.
 */
export interface CapabilityDescriptor {
  readonly description: string;
  /** True if exercising it can change platform state or the outside world. */
  readonly mutates: boolean;
}

export const CAPABILITIES = {
  "record.read": {
    description: "Read runs, steps, and their trail from the operating record.",
    mutates: false,
  },
  "cost.read": { description: "Read cost and spend figures.", mutates: false },
  "audit.read": {
    description: "Read the audit chain and verify it.",
    mutates: false,
  },
  "knowledge.read": {
    description: "Retrieve governed passages with their provenance.",
    mutates: false,
  },
  "contract.read": {
    description: "Read contract metadata needed for a rescission check.",
    mutates: false,
  },
  "association.read": {
    description: "Read association budget and reserve data.",
    mutates: false,
  },
  "identity.read": {
    description: "Read actors, sessions, and service accounts.",
    mutates: false,
  },
  "work.perform": {
    description: "Run workflows and perform the actions they contain.",
    mutates: true,
  },
  "work.approve": {
    description: "Decide approvals for work that is waiting on a human.",
    mutates: true,
  },
  "contact.send": {
    description: "Send a message or document that reaches an owner.",
    mutates: true,
  },
  "knowledge.curate": {
    description: "Ingest documents into a governed corpus and record reviews.",
    mutates: true,
  },
  "containment.operate": {
    description: "Engage and release the containment switches.",
    mutates: true,
  },
  "improvement.decide": {
    description: "Approve, apply, or revert an improvement proposal.",
    mutates: true,
  },
  "identity.administer": {
    description: "Issue and revoke service credentials; revoke sessions.",
    mutates: true,
  },
  "platform.configure": {
    description: "Change platform configuration and role assignments.",
    mutates: true,
  },
} as const satisfies Record<string, CapabilityDescriptor>;

export type Capability = keyof typeof CAPABILITIES;

export const CAPABILITY_NAMES = Object.keys(CAPABILITIES) as readonly Capability[];

export function isMutatingCapability(capability: Capability): boolean {
  return CAPABILITIES[capability].mutates;
}

/** Every capability that cannot change anything. The auditor's whole grant. */
export const READ_ONLY_CAPABILITIES: readonly Capability[] = CAPABILITY_NAMES.filter(
  (name) => !CAPABILITIES[name].mutates,
);

/**
 * The capability grant for each role.
 *
 * `auditor` is computed from `READ_ONLY_CAPABILITIES` rather than listed, so
 * that a capability added later is granted to the auditor automatically if it
 * is a read and cannot be granted by accident if it is a write. Writing the
 * list out by hand would mean a future read capability silently missing from
 * the auditor's grant — an auditor who cannot see part of the system is a
 * finding, and one nobody would notice until an audit.
 */
export const ROLE_CAPABILITIES: Readonly<Record<RoleName, readonly Capability[]>> = Object.freeze({
  owner_services_agent: ["record.read", "knowledge.read", "contract.read", "work.perform"],
  supervisor: [
    "record.read",
    "cost.read",
    "knowledge.read",
    "contract.read",
    "work.perform",
    "work.approve",
    "contact.send",
    "containment.operate",
    "improvement.decide",
  ],
  compliance_reviewer: [
    "record.read",
    "audit.read",
    "knowledge.read",
    "contract.read",
    "work.approve",
    "contact.send",
    "knowledge.curate",
    "containment.operate",
    "improvement.decide",
  ],
  association_manager: ["record.read", "knowledge.read", "association.read", "work.perform"],
  finance: ["record.read", "cost.read", "association.read"],
  platform_admin: [
    "record.read",
    "cost.read",
    "audit.read",
    "knowledge.read",
    "identity.read",
    "containment.operate",
    "improvement.decide",
    "identity.administer",
    "platform.configure",
  ],
  auditor: READ_ONLY_CAPABILITIES,
});

/** Capabilities held by an actor holding all of `roles`. Sorted and deduplicated. */
export function capabilitiesFor(roles: readonly RoleName[]): readonly Capability[] {
  const held = new Set<Capability>();
  for (const role of roles) {
    for (const capability of ROLE_CAPABILITIES[role] ?? []) held.add(capability);
  }
  return [...held].sort();
}

/**
 * The prefix that marks a data-scope entitlement inside an actor's role list.
 *
 * `guard/authorize.ts` reads entitlements out of `ActorRef.roles` by looking
 * for this prefix, so the two must agree. It is declared here — the module
 * that produces the entitlements — rather than imported from `guard/`, because
 * identity sits alongside guard in the layering and a lateral import for one
 * string constant is not worth the coupling. The pairing is asserted by a test
 * in this module that runs a mapped actor through the same prefix logic the
 * authorizer uses.
 */
export const SCOPE_ROLE_PREFIX = "scope:";

/**
 * A data-scope entitlement, as `kind:value` — for example
 * `association:1042` or `business_line:vacation_ownership`.
 *
 * **The single-tenancy seam.** This platform is built for one customer and has
 * no tenant concept (ADR 0010). MVW nevertheless has internal boundaries that
 * matter — associations are separate legal entities, and business lines have
 * different data-sensitivity profiles — so scopes exist to express those. If a
 * second customer ever had to be served from one deployment, `tenant` becomes
 * another scope kind carried through the same mechanism: derived from a
 * directory group here, attached to `ActorRef.roles`, checked by the authorizer
 * against `ActionRequest.requiredScopes`, and filtered at the port boundary.
 * That is the whole seam. It is not multi-tenancy and must not be described as
 * such — nothing here isolates one customer's data from another's, and making
 * it do so is a project rather than a configuration change.
 */
export type Scope = string;

export const SCOPE_PATTERN = /^[a-z][a-z0-9_]*:[a-z0-9][a-z0-9_-]*$/;

/** Render a scope as the role string the authorizer looks for. */
export function scopeRole(scope: Scope): string {
  return `${SCOPE_ROLE_PREFIX}${scope}`;
}

export type ActorStatus =
  /** The directory asserted a mapped group at the last sign-in. */
  | "active"
  /**
   * The directory no longer asserts any mapped group, or an administrator
   * revoked the actor. Sessions belonging to a deprovisioned actor stop
   * working immediately — the check is on the read path, not only at sign-in.
   */
  | "deprovisioned";

/**
 * A person or machine the platform has seen.
 *
 * Not an account. There is nothing to log in to here: the record exists so
 * that runs, approvals, and audit entries can name a stable subject, and so an
 * administrator can revoke one. It carries no credential of any kind.
 */
export interface Actor {
  readonly id: Id<"actor">;
  readonly kind: "human" | "service";
  /**
   * `digestValue({ issuer, subject })` of the identity provider's claims.
   *
   * The subject claim itself is not stored. Two different issuers asserting
   * the same `sub` produce different digests, which is what stops a second
   * configured issuer from impersonating a person on the first.
   */
  readonly subjectDigest: Digest;
  /** The issuer that asserted this subject. Stored in the clear; not personal data. */
  readonly issuer: string;
  readonly roles: readonly RoleName[];
  readonly scopes: readonly Scope[];
  /** The directory groups the roles were derived from, for explainability. */
  readonly directoryGroups: readonly string[];
  readonly status: ActorStatus;
  readonly firstSeenAt: IsoTimestamp;
  readonly lastSeenAt: IsoTimestamp;
}

/**
 * A signed-in session.
 *
 * Roles and scopes are snapshotted here at sign-in *and* re-read from the
 * actor on every request. The snapshot is what an auditor needs — "these were
 * the entitlements in force when the action was taken" — and the re-read is
 * what makes revocation immediate. Trusting the snapshot alone would mean a
 * person keeps yesterday's access until their session happens to expire.
 */
export interface Session {
  readonly id: Id<"session">;
  readonly actorId: Id<"actor">;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  /**
   * When the actor last proved who they are.
   *
   * Sign-in sets it; a step-up re-authentication moves it forward. This is the
   * value `ActionRequest.secondsSinceAuthentication` is computed from, and it
   * is why a high-consequence action cannot be performed on the strength of a
   * session that was opened this morning.
   */
  readonly authenticatedAt: IsoTimestamp;
  /** Authentication methods the provider asserted (`amr`), e.g. `pwd`, `mfa`. */
  readonly authenticationMethods: readonly string[];
  /** The provider's session id (`sid`), for back-channel logout. */
  readonly idpSessionId?: string | undefined;
  readonly roles: readonly RoleName[];
  readonly scopes: readonly Scope[];
  readonly revokedAt?: IsoTimestamp | undefined;
  readonly revokedReason?: string | undefined;
}

/**
 * A machine credential.
 *
 * Only `credentialDigest` is stored. The credential itself exists exactly once,
 * in the response to the call that issued it, and is unrecoverable afterwards —
 * a lost credential is reissued, never recovered, because a store that can
 * recover a credential is a store that can leak every credential at once.
 */
export interface ServiceAccount {
  readonly id: Id<"actor">;
  readonly name: string;
  readonly description: string;
  /**
   * The non-secret half of the credential, used to find the row.
   *
   * Without it, verification would have to compare against every stored digest,
   * which is both slow and a timing side channel. The prefix identifies; the
   * secret authenticates.
   */
  readonly credentialPrefix: string;
  readonly credentialDigest: Digest;
  readonly roles: readonly RoleName[];
  readonly scopes: readonly Scope[];
  readonly createdAt: IsoTimestamp;
  readonly createdBy: string;
  /** Machine credentials expire. An immortal credential is an unowned one. */
  readonly expiresAt: IsoTimestamp;
  readonly lastUsedAt?: IsoTimestamp | undefined;
  readonly revokedAt?: IsoTimestamp | undefined;
  readonly revokedBy?: string | undefined;
  readonly revokedReason?: string | undefined;
}

/** What an identity provider asserted, after every check has passed. */
export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  /** Group claims exactly as asserted, before mapping. */
  readonly groups: readonly string[];
  readonly authenticationMethods: readonly string[];
  /** The provider's `auth_time`, as an ISO-8601 UTC instant, when asserted. */
  readonly authenticatedAt?: IsoTimestamp | undefined;
  readonly idpSessionId?: string | undefined;
  /** Digest of the full claim set, for the audit record. Never the claims. */
  readonly claimsDigest: Digest;
}

/**
 * A pending authorization-code exchange.
 *
 * Held server-side between the redirect out and the callback in, and consumed
 * exactly once. `state` defends the callback against cross-site request
 * forgery, `nonce` binds the ID token to this particular request, and
 * `codeVerifier` is the PKCE secret that makes an intercepted authorization
 * code useless to whoever intercepted it.
 */
export interface AuthorizationRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  /** Where to send the person once sign-in completes. Validated as a local path. */
  readonly returnTo?: string | undefined;
}

/** The `ActorRef` shape the operating record and the authorizer consume. */
export function toActorRef(
  actor: Pick<Actor, "id" | "kind" | "roles" | "scopes">,
): ActorRef {
  return {
    actorId: actor.id,
    kind: actor.kind,
    // Scopes ride in the same list because that is where the authorizer's
    // data-scope check reads them from. Keeping them in one list also means an
    // audit entry records the entitlements in force with no extra field.
    roles: [...actor.roles, ...actor.scopes.map(scopeRole)],
  };
}
