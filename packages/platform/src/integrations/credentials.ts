import type { Clock } from "../kernel/clock.js";
import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { CredentialRevocationStore, SecretProvider } from "./port.js";
import type { IntegrationCredential } from "./types.js";

/**
 * Outbound credentials: sealed, scoped, and individually revocable.
 *
 * The three things this file exists to guarantee.
 *
 * *A credential cannot be serialised by accident.* `sealCredential` makes
 * `value` non-enumerable. `JSON.stringify` skips it, object spread drops it,
 * `Object.entries` does not see it, and the kernel's `redactValue` — which
 * walks entries — therefore cannot carry it into a log line. A future
 * `logger.debug("calling", { credential })` prints the reference and nothing
 * else. That is a property of the object rather than a rule someone has to
 * remember, which is the only kind of rule that survives a year of changes.
 *
 * *A credential is scoped to hosts.* The egress client checks the request's
 * host against `allowedHosts` before it attaches anything. A call that got its
 * URL wrong — or that was steered somewhere by a crafted parameter — does not
 * arrive at the wrong system holding the right key.
 *
 * *Revocation is a platform decision, not a vault operation.* The revocation
 * list lives in this platform's own store and is consulted on every read, so a
 * leaked key is out of service the moment an operator says so, without waiting
 * for whoever owns the vault to rotate it.
 */

/**
 * Wrap credential material so the secret cannot leak through serialisation.
 *
 * The returned object satisfies `IntegrationCredential` — `value` reads
 * normally — but the property is non-enumerable and `toJSON` omits it.
 */
export function sealCredential(input: IntegrationCredential): IntegrationCredential {
  const sealed = {
    reference: input.reference,
    scheme: input.scheme,
    headerName: input.headerName,
    allowedHosts: [...input.allowedHosts].map((host) => host.trim().toLowerCase()),
    expiresAt: input.expiresAt,
    toJSON(): Record<string, unknown> {
      return {
        reference: input.reference,
        scheme: input.scheme,
        allowedHosts: input.allowedHosts,
        value: "[sealed]",
      };
    },
  };
  Object.defineProperty(sealed, "value", {
    value: input.value,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  // Two casts, deliberately. `value` is attached by `defineProperty` above so
  // that it is non-enumerable — which is the whole mechanism keeping the secret
  // out of JSON.stringify, console output, and any structured log. The literal
  // therefore genuinely lacks the property at the type level, and TypeScript is
  // right to object to a direct assertion.
  return sealed as unknown as IntegrationCredential;
}

/**
 * Credentials from an already-resolved map, sealed on the way out.
 *
 * The deployment fills the map from wherever its secrets live — environment,
 * secret manager, token service. Everything downstream sees one interface.
 */
export class StaticSecretProvider implements SecretProvider {
  private readonly credentials = new Map<string, IntegrationCredential>();

  constructor(credentials: readonly IntegrationCredential[] = []) {
    for (const credential of credentials) {
      this.credentials.set(credential.reference, sealCredential(credential));
    }
  }

  async get(reference: string): Promise<IntegrationCredential | null> {
    return this.credentials.get(reference) ?? null;
  }
}

/**
 * Credentials resolved from the process environment.
 *
 * The `SecretProvider` doc names this backing explicitly: the deployment may
 * back an outbound credential with an environment variable, a secret manager,
 * or a short-lived token service, and everything downstream sees one interface.
 * This is the environment-variable backing, and it is the default the
 * composition root wraps in the revocation check — a deployment injects each
 * credential's material from wherever its secrets actually live.
 *
 * For a credential asked for by reference `R`, this reads variables keyed on `R`
 * upper-cased with every run of non-alphanumerics collapsed to one underscore
 * (so `contract-records` becomes `CONTRACT_RECORDS`):
 *
 *     PV_INTEGRATION_CREDENTIAL_<KEY>          the secret value
 *     PV_INTEGRATION_CREDENTIAL_<KEY>_HOSTS    comma-separated hosts it may be
 *                                              presented to
 *     PV_INTEGRATION_CREDENTIAL_<KEY>_SCHEME   bearer | basic | header (bearer)
 *     PV_INTEGRATION_CREDENTIAL_<KEY>_HEADER   header name for scheme "header"
 *
 * Two fail-closed properties. An absent value returns null rather than throwing,
 * so the egress client's refusal carries `integration.credential_missing` — the
 * contract the interface requires, distinguishing "no credential" from an
 * outage. And `_HOSTS` absent leaves `allowedHosts` empty, which the scope check
 * reads as "presentable to nothing": a credential configured without its hosts
 * is refused at every host rather than accepted at all of them. The credential
 * is sealed on the way out, so its value cannot reach a log.
 */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(reference: string): Promise<IntegrationCredential | null> {
    const key = reference.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    if (key.length === 0) return null;
    const value = this.env[`PV_INTEGRATION_CREDENTIAL_${key}`];
    if (value === undefined || value.length === 0) return null;

    const schemeRaw = (this.env[`PV_INTEGRATION_CREDENTIAL_${key}_SCHEME`] ?? "bearer")
      .trim()
      .toLowerCase();
    const scheme: IntegrationCredential["scheme"] =
      schemeRaw === "basic" ? "basic" : schemeRaw === "header" ? "header" : "bearer";
    const allowedHosts = (this.env[`PV_INTEGRATION_CREDENTIAL_${key}_HOSTS`] ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host.length > 0);
    const headerName = this.env[`PV_INTEGRATION_CREDENTIAL_${key}_HEADER`]?.trim();

    return sealCredential({
      reference,
      scheme,
      value,
      allowedHosts,
      ...(headerName && headerName.length > 0 ? { headerName } : {}),
    });
  }
}

/**
 * A provider that consults the revocation list before answering.
 *
 * Wraps any other provider, so revocation works the same whether the secret
 * comes from an environment variable or a vault. There is no cache: caching a
 * "not revoked" answer would make revocation mean "revoked within a minute",
 * which is not the promise an operator responding to a leak needs.
 */
export class RevocableSecretProvider implements SecretProvider {
  constructor(
    private readonly inner: SecretProvider,
    private readonly revocations: CredentialRevocationStore,
  ) {}

  async get(reference: string): Promise<IntegrationCredential | null> {
    // Revocation is checked first so that a revoked reference never causes the
    // underlying provider to materialise the secret at all.
    if (await this.revocations.isRevoked(reference)) return null;
    return this.inner.get(reference);
  }
}

/**
 * Take a credential out of service.
 *
 * Records the decision in the audit chain, with the reference — which is a
 * name, not a secret — and never the credential.
 */
export class CredentialRevocationService {
  constructor(
    private readonly store: CredentialRevocationStore,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  async revoke(input: {
    readonly reference: string;
    readonly revokedBy: string;
    readonly reason: string;
    readonly correlationId?: string;
  }): Promise<void> {
    const revokedAt = this.clock.nowIso();
    await this.store.revoke({
      reference: input.reference,
      revokedAt,
      revokedBy: input.revokedBy,
      reason: input.reason,
    });

    await this.audit.record(
      auditDecision({
        eventType: "containment.engaged",
        actorId: input.revokedBy,
        actorKind: "human",
        correlationId: input.correlationId,
        subject: { credentialReference: input.reference },
        decision: { revoked: true, reason: input.reason.slice(0, 512), revokedAt },
      }),
    );
  }

  isRevoked(reference: string): Promise<boolean> {
    return this.store.isRevoked(reference);
  }
}

/**
 * Does this credential permit a call to `host`?
 *
 * Exact host match, or a leading-dot entry matching any subdomain of it. There
 * is no wildcard form: `*` in a host pattern is where allowlists go wrong,
 * because `*.mvw.example.com` written slightly differently matches
 * `mvw.example.com.attacker.net`.
 */
export function credentialPermitsHost(
  credential: IntegrationCredential,
  host: string,
): boolean {
  const target = host.trim().toLowerCase();
  if (target.length === 0) return false;
  return credential.allowedHosts.some((entry) => hostMatches(target, entry));
}

/** Shared by the credential scope check and the egress allowlist. */
export function hostMatches(host: string, entry: string): boolean {
  const pattern = entry.trim().toLowerCase();
  if (pattern.length === 0) return false;
  if (pattern.startsWith(".")) {
    // A suffix entry covers subdomains only, never the bare domain, and never
    // a host that merely ends with the same characters.
    return host.endsWith(pattern) && host.length > pattern.length;
  }
  return host === pattern;
}
