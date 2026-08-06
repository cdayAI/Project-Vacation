import type { Clock } from "../kernel/clock.js";
import type { DeployEnvironment } from "../kernel/config.js";
import { ConfigError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import type { Logger } from "../kernel/logger.js";
import type { VerifiedIdentity } from "./types.js";

/**
 * A development-only identity provider.
 *
 * Running the console locally must not require an Okta tenant, so this stands
 * in for one: hand it a subject and a list of directory groups and it produces
 * the same `VerifiedIdentity` a real ID token would, which then goes through
 * exactly the same group mapping, session creation, and audit path.
 *
 * It is also, obviously, a way to become anyone. So it refuses to exist
 * outside development.
 *
 * The refusal is in the constructor rather than at first use, on purpose. A
 * check at use time means a process can start, pass its health check, serve
 * traffic, and only refuse when someone tries the back door — by which point
 * the deployment has already been running in a state nobody intended. A check
 * at construction turns that into a startup failure with one obvious cause.
 *
 * `test` is refused along with staging and production. The automated suite
 * constructs this class with `development` explicitly, which costs one word
 * per test and removes the possibility that a CI environment variable, set for
 * some unrelated reason, quietly enables a password-free identity provider.
 *
 * There is deliberately no way to switch it on from configuration. It is
 * reachable only by a process that constructed it, and `buildPlatform` does
 * that only when no OIDC issuer is configured — a combination `loadConfig`
 * already refuses in staging and production.
 */
export const DEV_PROVIDER_ISSUER = "https://development.invalid/pv-dev-identity";

export const DEV_PROVIDER_WARNING =
  "IDENTITY: the development identity provider is active. It authenticates nobody: any caller may claim any subject and any directory group. It must never run outside local development.";

export class DevelopmentIdentityProvider {
  constructor(
    environment: DeployEnvironment,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    if (environment !== "development") {
      throw new ConfigError(
        `The development identity provider cannot run in ${environment}. It performs no authentication: it accepts whatever subject and groups the caller asks for. Configure single sign-on (PV_OIDC_ISSUER and friends) instead — there is no local password store and there will not be one.`,
        { environment },
      );
    }
    // Loud, once, at startup — the same channel the sandbox and discovery
    // warnings use, so an operator sees every unsafe setting in one place.
    this.logger.warn(DEV_PROVIDER_WARNING, { environment });
  }

  /**
   * Mint an identity for local work.
   *
   * Warns on every call as well as at construction. A single startup line
   * scrolls away; a line per sign-in is present in whatever log window the
   * person is actually looking at.
   */
  authenticate(input: {
    readonly subject: string;
    readonly groups: readonly string[];
    readonly authenticationMethods?: readonly string[];
  }): VerifiedIdentity {
    if (typeof input.subject !== "string" || input.subject.trim().length === 0) {
      throw new ConfigError("The development identity provider needs a subject.", {
        field: "subject",
      });
    }
    this.logger.warn("development identity issued without authentication", {
      // The subject is a local placeholder like `dev:agent`, not a real person.
      subject: input.subject,
      groups: input.groups.length,
    });

    const claims = {
      iss: DEV_PROVIDER_ISSUER,
      sub: input.subject,
      groups: [...input.groups],
      amr: [...(input.authenticationMethods ?? ["dev"])],
    };

    return {
      issuer: DEV_PROVIDER_ISSUER,
      subject: input.subject,
      groups: [...input.groups],
      authenticationMethods: [...(input.authenticationMethods ?? ["dev"])],
      authenticatedAt: this.clock.nowIso(),
      claimsDigest: digestValue(claims),
    };
  }
}
