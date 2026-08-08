/**
 * Identity: who is acting, what they are allowed to be, and how long ago they
 * proved it.
 *
 * Four promises hold across the module.
 *
 *   *No local password store.* Human authentication is OIDC against MVW's
 *   identity provider. There is no password column, no reset flow, and no
 *   break-glass local account. The development provider exists for local work
 *   and refuses to construct itself outside development.
 *
 *   *Access follows the HR lifecycle.* Roles come from directory groups and
 *   are never granted inside the platform. A person removed from a group loses
 *   their roles at the next sign-in, and loses their live sessions
 *   immediately, because every request re-reads the actor rather than trusting
 *   the session's snapshot.
 *
 *   *The auditor sees everything and changes nothing.* Encoded as a capability
 *   set computed from the read-only capabilities, not as a convention.
 *
 *   *Machine credentials are scoped, expiring, and individually revocable.*
 *   Only a digest is stored. Revocation takes effect on the next call, because
 *   nothing caches a verification.
 */

export type {
  Actor,
  ActorStatus,
  AuthorizationRequest,
  Capability,
  CapabilityDescriptor,
  RoleName,
  Scope,
  ServiceAccount,
  Session,
  VerifiedIdentity,
} from "./types.js";
export {
  CAPABILITIES,
  CAPABILITY_NAMES,
  READ_ONLY_CAPABILITIES,
  ROLE_CAPABILITIES,
  ROLE_NAMES,
  SCOPE_PATTERN,
  SCOPE_ROLE_PREFIX,
  capabilitiesFor,
  isMutatingCapability,
  isRoleName,
  scopeRole,
  toActorRef,
} from "./types.js";

export type { IdentityStore, ServiceAccountStore, UpsertActorInput } from "./port.js";

export { identityRefusal } from "./denials.js";

export type {
  GroupRoleRule,
  GroupScopeRule,
  MappedEntitlements,
  RoleMapping,
} from "./roles.js";
export {
  DEFAULT_ROLE_MAPPING,
  assertMappingIsSound,
  grantsNothing,
  mapDirectoryGroups,
} from "./roles.js";

export type { SecretGenerator } from "./secrets.js";
export { CryptoSecretGenerator, base64Url, pkceChallenge, randomToken, secretsEqual } from "./secrets.js";

export type {
  BeginSignInResult,
  CompleteSignInInput,
  CompletedSignIn,
  DiscoveryDocument,
  OidcAuthenticatorOptions,
  OidcSettings,
  OidcTransport,
} from "./oidc.js";
export { FetchOidcTransport, OidcAuthenticator, safeReturnTo } from "./oidc.js";

export type {
  IssuedSession,
  ResolvedSession,
  SessionCookieAttributes,
  SessionCookiePayload,
  SessionServiceOptions,
} from "./session.js";
export {
  SESSION_COOKIE_NAME,
  SessionService,
  signSessionCookie,
  verifySessionCookie,
} from "./session.js";

export {
  DEV_PROVIDER_ISSUER,
  DEV_PROVIDER_WARNING,
  DevelopmentIdentityProvider,
} from "./dev-provider.js";

export type { IdentityAvailability, IdentityRuntime, IdentityRuntimeDeps } from "./runtime.js";
export { buildIdentityRuntime } from "./runtime.js";

export type { IssueServiceAccountInput, IssuedCredential } from "./service-accounts.js";
export {
  MAX_CREDENTIAL_LIFETIME_MS,
  ServiceAccountService,
  parseCredential,
} from "./service-accounts.js";

export { MemoryIdentityStore, MemoryServiceAccountStore } from "./store.memory.js";
export { PgIdentityStore, PgServiceAccountStore } from "./store.pg.js";

export { MIGRATIONS as IDENTITY_MIGRATIONS } from "./migrations.js";
