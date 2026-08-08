import type { Clock } from "../kernel/clock.js";
import type { Config } from "../kernel/config.js";
import type { IdGenerator } from "../kernel/ids.js";
import type { Logger } from "../kernel/logger.js";
import type { AuditLog } from "../audit/log.js";
import { MemoryDb, PgDb, type Db } from "../store/db.js";
import { DevelopmentIdentityProvider } from "./dev-provider.js";
import type { IdentityStore } from "./port.js";
import { DEFAULT_ROLE_MAPPING, assertMappingIsSound, type RoleMapping } from "./roles.js";
import { SessionService } from "./session.js";
import { MemoryIdentityStore } from "./store.memory.js";
import { PgIdentityStore } from "./store.pg.js";

/**
 * Identity, composed for a surface that has to know who is calling.
 *
 * The module below this one was complete and had no importer: a session
 * carried an authentication instant, `SessionService.resolve` computed a real
 * age from it, and nothing ever built a `SessionService`. So the HTTP layer had
 * no session to ask, `secondsSinceAuthentication` was permanently unknown, and
 * every grant of a step-up action was refused — correctly, and for ever. This
 * is the wiring that makes the other answer reachable.
 *
 * It lives here rather than in the composition root because identity is
 * per-surface state, not per-platform state. The HTTP server needs it to
 * resolve a cookie; the command line needs it to resolve a session an operator
 * hands it; a worker sweeping timers needs none of it and should not pay to
 * construct one.
 *
 * **Unavailable is an answer, not an error.** A deployment with no session
 * secret cannot sign anything, so it gets no session service at all and every
 * caller falls back to "nobody has authenticated here" — which refuses a
 * high-consequence grant. The reason string is carried so the surface can say
 * which setting is missing instead of leaving an operator to guess why sign-in
 * is not there.
 */

export interface IdentityRuntime {
  readonly sessions: SessionService;
  readonly store: IdentityStore;
  /**
   * The development identity provider, when this deployment has one.
   *
   * Present only in development with no OIDC issuer configured — the same
   * combination `buildPlatform` treats as "local work". It authenticates
   * nobody, refuses to construct itself anywhere else, and is the only way a
   * session is minted until the OIDC callback is wired.
   */
  readonly developmentProvider?: DevelopmentIdentityProvider;
  readonly roleMapping: RoleMapping;
  /**
   * Whether a session opened here is visible to another process.
   *
   * False on the in-memory store, where the identity tables live in this
   * process's heap. It is not a defect — the whole operating record is
   * process-local there — but it is the difference between "your cookie is
   * invalid" and "your cookie was issued by a server that is not this one",
   * and an operator who is not told cannot tell those apart.
   */
  readonly sharedAcrossProcesses: boolean;
}

export type IdentityAvailability =
  | { readonly available: true; readonly runtime: IdentityRuntime }
  | { readonly available: false; readonly reason: string };

/** What composing identity needs. A subset of `Platform`, so tests can pass parts. */
export interface IdentityRuntimeDeps {
  readonly config: Config;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly audit: AuditLog;
  readonly logger: Logger;
  readonly db?: Db | undefined;
  /** Overrides the shipped directory-group mapping. Validated before use. */
  readonly roleMapping?: RoleMapping;
}

/** Sessions are signed with an HMAC; a short key is refused rather than stretched. */
const MIN_SESSION_SECRET_LENGTH = 32;

export function buildIdentityRuntime(deps: IdentityRuntimeDeps): IdentityAvailability {
  const { config } = deps;

  const secret = config.sessionSecret ?? "";
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    // Refused, not generated. A key this process invented would be a key no
    // second instance shares and no restart survives, so a session would stop
    // meaning "this person signed in" and start meaning "this person signed in
    // to the process that happens to be answering".
    return {
      available: false,
      reason: `PV_SESSION_SECRET is ${secret.length === 0 ? "not set" : `only ${secret.length} characters`}; sessions must be signed with at least ${MIN_SESSION_SECRET_LENGTH}. Without it this deployment cannot open a session, so it cannot observe when anybody authenticated, and every approval that requires step-up re-authentication is refused.`,
    };
  }

  const roleMapping = deps.roleMapping ?? DEFAULT_ROLE_MAPPING;
  // At construction rather than at first sign-in: a malformed mapping is a
  // startup failure everywhere, not a permissions mystery for whoever signs in
  // first.
  assertMappingIsSound(roleMapping);

  const usingPostgres = deps.db instanceof PgDb;
  const store: IdentityStore = usingPostgres
    ? new PgIdentityStore(deps.db as PgDb)
    : // A database of its own, not the operating record's.
      //
      // `buildPlatform` keeps its `MemoryDb` private, and reaching for it would
      // couple every surface to the composition root's internals for no gain:
      // nothing joins an identity row to a run row, so two heaps hold what one
      // would have.
      new MemoryIdentityStore(new MemoryDb());

  const sessions = new SessionService(store, deps.clock, deps.ids, deps.audit, secret, {
    // Plain HTTP is a local-development shape only; `loadConfig` refuses to
    // start without OIDC in staging and production.
    secureCookie: config.environment !== "development",
  });

  const developmentProvider =
    config.environment === "development" && !config.oidcIssuer
      ? new DevelopmentIdentityProvider(config.environment, deps.clock, deps.logger)
      : undefined;

  return {
    available: true,
    runtime: {
      sessions,
      store,
      ...(developmentProvider ? { developmentProvider } : {}),
      roleMapping,
      sharedAcrossProcesses: usingPostgres,
    },
  };
}
