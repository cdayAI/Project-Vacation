import type { Clock } from "../kernel/clock.js";
import { InvalidInputError } from "../kernel/errors.js";
import { digestBytes, digestsEqual } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { ActorRef } from "../record/types.js";
import { identityRefusal } from "./denials.js";
import type { ServiceAccountStore } from "./port.js";
import { base64Url, type SecretGenerator } from "./secrets.js";
import { scopeRole, type RoleName, type Scope, type ServiceAccount } from "./types.js";

/**
 * Machine credentials: scoped, expiring, and individually revocable.
 *
 * Four properties, each closing a specific failure:
 *
 *   *Only a digest is stored.* The credential exists once, in the response to
 *   the call that issued it. Nothing can recover it afterwards — not an
 *   administrator, not a database dump, not this class. A store that can
 *   recover one credential is a store that leaks all of them at once.
 *
 *   *Individually revocable, immediately.* Revocation is a write followed by
 *   nothing: there is no cache in front of verification, so the very next call
 *   with that credential fails. Caching verification results would make
 *   "revoked" mean "revoked within a minute", which is not what an operator
 *   responding to a leaked key needs to hear.
 *
 *   *Scoped.* A service account holds roles and data scopes like anyone else,
 *   and the authorization chokepoint checks them the same way. A machine
 *   caller cannot do more than the role it was issued.
 *
 *   *Expiring.* Every credential has an end date. An immortal credential
 *   belongs to nobody after the person who created it moves on, and it is
 *   still valid when the integration it was issued for is decommissioned.
 *
 * The credential never reaches a log or an audit record. That is not left to
 * discipline: nothing in this file puts the secret into a structured value
 * that goes anywhere except the return of `issue`, and there are tests that
 * scan the audit chain and the log buffer for it.
 */

/** `pvsa` — Project Vacation service account. Recognisable in a secret scanner. */
const CREDENTIAL_SCHEME = "pvsa";
const PREFIX_BYTES = 8;
const SECRET_BYTES = 32;
const NAME_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;

export interface IssuedCredential {
  readonly account: ServiceAccount;
  /**
   * The credential, in full, exactly once.
   *
   * The caller must hand it to whoever asked and then forget it. It is not
   * stored, it cannot be re-read, and a lost credential is reissued rather
   * than recovered.
   */
  readonly credential: string;
}

export interface IssueServiceAccountInput {
  readonly name: string;
  readonly description: string;
  readonly roles: readonly RoleName[];
  readonly scopes: readonly Scope[];
  readonly issuedBy: string;
  readonly lifetimeMs: number;
  readonly correlationId?: string;
}

/** A year. Long enough to be practical, short enough that rotation is real. */
export const MAX_CREDENTIAL_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export class ServiceAccountService {
  constructor(
    private readonly store: ServiceAccountStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly secrets: SecretGenerator,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Issue a credential.
   *
   * The authorization chokepoint gates the *right* to call this —
   * `identity.issue_service_credential` is high-consequence and needs an
   * approval — so this method's job is to make the credential itself sound,
   * not to decide who may ask for one.
   */
  async issue(input: IssueServiceAccountInput): Promise<IssuedCredential> {
    if (!NAME_PATTERN.test(input.name)) {
      throw new InvalidInputError(
        `Service account name "${input.name}" must be lower-case letters, digits, and hyphens, 3 to 64 characters. The name appears in the audit trail and has to be readable a year from now.`,
        "name",
      );
    }
    if (input.roles.length === 0 && input.scopes.length === 0) {
      throw new InvalidInputError(
        "A service account with no roles and no scopes can do nothing. Issue it with the access it needs, or do not issue it.",
        "roles",
      );
    }
    if (!Number.isFinite(input.lifetimeMs) || input.lifetimeMs <= 0) {
      throw new InvalidInputError("A credential lifetime must be a positive duration.", "lifetimeMs");
    }
    if (input.lifetimeMs > MAX_CREDENTIAL_LIFETIME_MS) {
      throw new InvalidInputError(
        `A credential may live at most ${Math.round(MAX_CREDENTIAL_LIFETIME_MS / 86_400_000)} days. Longer-lived credentials stop being rotated and start being copied.`,
        "lifetimeMs",
      );
    }

    const nowMs = this.clock.now();
    const prefix = base64Url(this.secrets.bytes(PREFIX_BYTES));
    const secret = base64Url(this.secrets.bytes(SECRET_BYTES));
    const credential = `${CREDENTIAL_SCHEME}_${prefix}_${secret}`;

    const account: ServiceAccount = {
      id: this.ids.next("actor"),
      name: input.name,
      description: input.description,
      credentialPrefix: prefix,
      // The digest covers the whole credential, so a caller cannot present a
      // valid prefix with a secret harvested from a different account.
      credentialDigest: digestBytes(credential),
      roles: [...input.roles],
      scopes: [...input.scopes],
      createdAt: new Date(nowMs).toISOString(),
      createdBy: input.issuedBy,
      expiresAt: new Date(nowMs + input.lifetimeMs).toISOString(),
    };

    const created = await this.store.createServiceAccount(account);

    await this.audit.record(
      auditDecision({
        eventType: "authorization.granted",
        actorId: input.issuedBy,
        actorKind: "human",
        correlationId: input.correlationId,
        subject: { serviceAccountId: created.id, serviceAccount: created.name },
        // Note what is absent: no credential, and no digest of one. The digest
        // is a verifier, and a verifier in an append-only seven-year record is
        // a verifier that outlives every rotation of the thing it verifies.
        decision: {
          action: "identity.issue_service_credential",
          roles: created.roles.join(","),
          scopes: created.scopes.join(","),
          expiresAt: created.expiresAt,
        },
      }),
    );

    return { account: created, credential };
  }

  /**
   * Verify a presented credential.
   *
   * @throws {DeniedError} if it is malformed, unknown, revoked, or expired.
   *   Every one of those is the same refusal to the caller — telling a client
   *   which of them applies tells an attacker whether a prefix they guessed
   *   exists.
   */
  async authenticate(credential: string): Promise<{
    readonly account: ServiceAccount;
    readonly actorRef: ActorRef;
  }> {
    const parsed = parseCredential(credential);
    if (!parsed) {
      throw identityRefusal("credential_malformed", "The service credential was not recognised.");
    }

    // No cache, deliberately. See the class comment: revocation has to be
    // observable on the very next call.
    const account = await this.store.getServiceAccountByPrefix(parsed.prefix);
    if (!account) {
      throw identityRefusal("credential_unknown", "The service credential was not recognised.");
    }

    // Constant-time over the digests. Comparing digests rather than secrets
    // means a wrong credential of the right length reveals nothing about how
    // much of it was right.
    if (!digestsEqual(account.credentialDigest, digestBytes(credential))) {
      throw identityRefusal("credential_mismatch", "The service credential was not recognised.", {
        serviceAccountId: account.id,
      });
    }

    if (account.revokedAt) {
      throw identityRefusal(
        "credential_revoked",
        `The credential for "${account.name}" was revoked at ${account.revokedAt}.`,
        { serviceAccountId: account.id },
      );
    }

    const nowIso = this.clock.nowIso();
    if (account.expiresAt <= nowIso) {
      throw identityRefusal(
        "credential_expired",
        `The credential for "${account.name}" expired at ${account.expiresAt}.`,
        { serviceAccountId: account.id },
      );
    }

    // Telemetry, after every gate. A failure here must not fail the call, but
    // it also must not be the reason a revoked credential got through, which
    // is why it is last.
    await this.store.markServiceAccountUsed(account.id, nowIso);

    return {
      account,
      actorRef: {
        actorId: account.id,
        kind: "service",
        roles: [...account.roles, ...account.scopes.map(scopeRole)],
      },
    };
  }

  /**
   * Revoke one credential.
   *
   * Individually: revoking one service account has no effect on any other, so
   * a leaked integration key does not take the rest of the platform's machine
   * traffic down with it.
   */
  async revoke(input: {
    readonly id: Id<"actor">;
    readonly revokedBy: string;
    readonly reason: string;
    readonly correlationId?: string;
  }): Promise<ServiceAccount> {
    const revoked = await this.store.revokeServiceAccount(
      input.id,
      this.clock.nowIso(),
      input.revokedBy,
      input.reason,
    );
    if (!revoked) {
      const existing = await this.store.getServiceAccount(input.id);
      if (!existing) {
        throw identityRefusal("service_account_unknown", `No service account ${input.id}.`, {
          serviceAccountId: input.id,
        });
      }
      // Already revoked. Reported as success: the operator's goal — that this
      // credential does not work — is satisfied, and raising here would make a
      // retried revocation during an incident look like a failure.
      return existing;
    }

    await this.audit.record(
      auditDecision({
        eventType: "containment.engaged",
        actorId: input.revokedBy,
        actorKind: "human",
        correlationId: input.correlationId,
        subject: { serviceAccountId: revoked.id, serviceAccount: revoked.name },
        decision: {
          revoked: true,
          reason: input.reason.slice(0, 512),
          revokedAt: revoked.revokedAt ?? "",
        },
      }),
    );

    return revoked;
  }

  get(id: Id<"actor">): Promise<ServiceAccount | null> {
    return this.store.getServiceAccount(id);
  }

  list(filter?: Parameters<ServiceAccountStore["listServiceAccounts"]>[0]): Promise<
    readonly ServiceAccount[]
  > {
    return this.store.listServiceAccounts(filter);
  }
}

/**
 * Split a credential into its lookup half and its secret half.
 *
 * Returns null on anything that does not have the exact shape, rather than
 * attempting a partial parse — a lenient parser here would widen the set of
 * strings that reach the store lookup.
 */
export function parseCredential(
  credential: string,
): { readonly prefix: string; readonly secret: string } | null {
  if (typeof credential !== "string" || credential.length > 256) return null;
  const parts = credential.split("_");
  if (parts.length !== 3) return null;
  const [scheme, prefix, secret] = parts;
  if (scheme !== CREDENTIAL_SCHEME) return null;
  if (!prefix || !secret) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(prefix) || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;
  // A short secret is not a credential, whatever it claims to be.
  if (secret.length < 32) return null;
  return { prefix, secret };
}
