import { createHmac, randomBytes, timingSafeEqual, createVerify, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestBytes, type Digest } from "../kernel/hash.js";
import type { IdGenerator, Id } from "../kernel/ids.js";
import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { CredentialStore, NonceStore } from "./port.js";
import {
  isStrongCredentialKind,
  type AgentCredential,
  type CredentialKind,
  type ExternalAgentId,
  type MintedCredential,
  type PresentedCredential,
  type VerifiedIdentity,
} from "./types.js";

/**
 * Credentials for external agents.
 *
 * A team should be able to use identity it already holds rather than being made
 * to carry a second secret, so four kinds are supported. Each has a specific
 * trap, and each trap below is a real defect that has shipped somewhere:
 *
 * **bearer** — shown exactly once, stored only as a hash. A leaked registry
 * backup must authenticate nothing. Lookup is by hash, so the plaintext never
 * appears in a query, a log, or a slow-query trace.
 *
 * **jwt** — verified OFFLINE against key material read from a local file. No
 * network fetch at verify time: a JWKS fetch on the authentication path is a
 * denial-of-service lever and a request-forgery surface pointed at whatever URL
 * the token names. The verified `sub` must equal the enrolled agent id exactly,
 * or a token minted for agent A authenticates agent B. Asymmetric algorithms
 * only — permitting HS256 alongside RS256 lets an attacker sign with the public
 * key, and permitting `none` needs no explanation.
 *
 * **hmac** — the shared secret is resolved from a secret manager BY NAME at
 * verify time. The registry stores the reference, never the value. Single-use
 * applies here too: a captured request replayed inside its freshness window
 * must be refused, which freshness alone does not achieve.
 *
 * **envelope** — a signature over a domain-separated message covering identity,
 * timestamp, nonce, and a hash of the body, verified against a pinned public
 * key. Domain separation matters: without a fixed prefix binding the message to
 * this platform and this purpose, a signature produced for one system can be
 * replayed into another that happens to sign the same bytes.
 */

/** Prefix binding a signed message to this platform and this purpose. */
const ENVELOPE_DOMAIN = "project-vacation/external-agent/v1";

/** How far a request timestamp may sit from our clock. */
const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;

/** Bearer tokens are generated here and never regenerated. */
const BEARER_BYTES = 32;

export interface SecretResolver {
  /**
   * Resolve a secret by name.
   *
   * Returns null when the name is unknown, which must deny rather than fall
   * back to anything. The platform stores the name; the deployment's secret
   * manager owns the value.
   */
  resolve(name: string): Promise<string | null>;
}

export interface CredentialServiceOptions {
  readonly freshnessMs?: number;
  /**
   * Refuse plain bearer authentication for any agent holding a strong
   * credential.
   *
   * Without this an agent that has done the work to adopt signed requests can
   * still be impersonated with a leaked bearer token, which makes the stronger
   * credential decorative. The check covers every strong kind — a switch that
   * names two of the three leaves the third as a silent downgrade path.
   */
  readonly refuseBearerWhenStrongCredentialExists?: boolean;
  /** Reads a JWKS from disk. Injected so tests need no filesystem. */
  readonly readJwks?: (path: string) => JSONWebKeySet;
}

function defaultReadJwks(path: string): JSONWebKeySet {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JSONWebKeySet;
  } catch (error) {
    throw new DeniedError(
      "config.missing",
      `The key set for this credential could not be read from ${path}: ${error instanceof Error ? error.message : String(error)}. Verification is refused rather than skipped.`,
      {},
    );
  }
}

export class CredentialService {
  private readonly freshnessMs: number;
  private readonly refuseBearerWhenStrong: boolean;
  private readonly readJwks: (path: string) => JSONWebKeySet;

  constructor(
    private readonly store: CredentialStore,
    private readonly nonces: NonceStore,
    private readonly secrets: SecretResolver,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly audit: AuditLog,
    options: CredentialServiceOptions = {},
  ) {
    this.freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
    this.refuseBearerWhenStrong = options.refuseBearerWhenStrongCredentialExists ?? true;
    this.readJwks = options.readJwks ?? defaultReadJwks;
  }

  // -------------------------------------------------------------------------
  // Minting
  // -------------------------------------------------------------------------

  /**
   * Mint a credential. The bearer token is returned once and never again.
   *
   * `stepUpSatisfied` is checked here, in the core, rather than at the HTTP
   * layer. A step-up requirement enforced only in one entry point is not a
   * requirement — the CLI would walk straight past it.
   */
  async mint(input: {
    readonly agentId: ExternalAgentId;
    readonly kind: CredentialKind;
    readonly label: string;
    readonly createdBy: string;
    readonly expiresAt?: string;
    readonly issuer?: string;
    readonly audience?: string;
    readonly jwksPath?: string;
    readonly secretRef?: string;
    readonly publicKey?: string;
    readonly requireStepUp?: boolean;
    readonly stepUpSatisfied?: boolean;
  }): Promise<MintedCredential> {
    if (input.requireStepUp && input.stepUpSatisfied !== true) {
      throw new DeniedError(
        "authorization.step_up_required",
        "Minting this credential requires a fresh human re-authentication.",
        { agentId: input.agentId, kind: input.kind },
      );
    }

    this.assertMintShape(input);

    const now = this.clock.nowIso();
    const id = this.ids.next("credential");

    let token: string | undefined;
    let tokenHash: string | undefined;
    if (input.kind === "bearer") {
      // Generated here so the value exists in exactly one place for exactly as
      // long as it takes to return it.
      token = `pvx_${randomBytes(BEARER_BYTES).toString("base64url")}`;
      tokenHash = digestBytes(token);
    }

    const credential: AgentCredential = {
      id,
      agentId: input.agentId,
      kind: input.kind,
      label: input.label,
      tokenHash,
      issuer: input.issuer,
      audience: input.audience,
      jwksPath: input.jwksPath,
      secretRef: input.secretRef,
      publicKey: input.publicKey,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt: input.expiresAt,
    };

    const created = await this.store.createCredential(credential);

    await this.audit.record(
      auditDecision({
        eventType: "identity.session_started",
        actorId: input.createdBy,
        actorKind: "human",
        subject: { externalAgentId: input.agentId, credentialId: id, kind: input.kind },
        decision: {
          minted: true,
          kind: input.kind,
          strong: isStrongCredentialKind(input.kind),
          // The reference is a name, not a secret; recording it lets an operator
          // see which vault entry an agent depends on.
          ...(input.secretRef ? { secretRef: input.secretRef } : {}),
        },
      }),
    );

    return { credential: created, token };
  }

  private assertMintShape(input: {
    readonly kind: CredentialKind;
    readonly issuer?: string;
    readonly audience?: string;
    readonly jwksPath?: string;
    readonly secretRef?: string;
    readonly publicKey?: string;
  }): void {
    switch (input.kind) {
      case "bearer":
        return;
      case "jwt":
        if (!input.issuer || !input.audience || !input.jwksPath) {
          throw new InvalidInputError(
            "A JWT credential needs an issuer, an audience, and a local JWKS path. Without all three the token would be verified against something we did not choose.",
            "jwt",
          );
        }
        return;
      case "hmac":
        if (!input.secretRef) {
          throw new InvalidInputError(
            "An HMAC credential needs a secret reference — the NAME to resolve from the secret manager. The value is never stored here.",
            "secretRef",
          );
        }
        if (/^[A-Za-z0-9+/=]{32,}$/.test(input.secretRef)) {
          // Refusing this shape is crude and worth it: someone pasting the
          // secret into the reference field is the most likely way a value
          // reaches this table, and it would sit there looking like a name.
          throw new InvalidInputError(
            "That looks like a secret value rather than a secret name. Store the reference the secret manager resolves, never the value.",
            "secretRef",
          );
        }
        return;
      case "envelope":
        if (!input.publicKey) {
          throw new InvalidInputError(
            "An envelope credential needs the pinned public key it will be verified against.",
            "publicKey",
          );
        }
        return;
      default: {
        const exhaustive: never = input.kind;
        throw new InvalidInputError(`Unknown credential kind: ${String(exhaustive)}`, "kind");
      }
    }
  }

  async revoke(
    id: Id<"credential">,
    by: string,
    reason: string,
  ): Promise<AgentCredential> {
    const revoked = await this.store.revokeCredential(id, this.clock.nowIso(), by, reason);
    if (!revoked) {
      throw new DeniedError(
        "integration.credential_missing",
        `Credential ${id} does not exist or was already revoked.`,
        { credentialId: id },
      );
    }
    await this.audit.record(
      auditDecision({
        eventType: "containment.engaged",
        actorId: by,
        actorKind: "human",
        subject: { externalAgentId: revoked.agentId, credentialId: id },
        decision: { revoked: true, reason: reason.slice(0, 512) },
      }),
    );
    return revoked;
  }

  list(agentId: ExternalAgentId): Promise<readonly AgentCredential[]> {
    return this.store.listCredentials(agentId);
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  /**
   * Verify a presented credential and return the identity it proves.
   *
   * @throws {DeniedError} on any failure. There is no partial success and no
   *   "probably fine" path: an unverifiable credential is an unauthenticated
   *   caller.
   */
  async verify(presented: PresentedCredential): Promise<VerifiedIdentity> {
    switch (presented.kind) {
      case "bearer":
        return this.verifyBearer(presented.token);
      case "jwt":
        return this.verifyJwt(presented.token);
      case "hmac":
        return this.verifySigned(presented, "hmac");
      case "envelope":
        return this.verifySigned(presented, "envelope");
      default: {
        const exhaustive: never = presented;
        throw new DeniedError(
          "integration.credential_missing",
          `Unknown credential kind presented: ${JSON.stringify(exhaustive)}`,
          {},
        );
      }
    }
  }

  private async verifyBearer(token: string): Promise<VerifiedIdentity> {
    if (typeof token !== "string" || token.length < 16 || token.length > 512) {
      throw this.refuse("A bearer token of an implausible length was presented.");
    }

    // Looked up by hash, so the plaintext never reaches a query or a log.
    const credential = await this.store.findByTokenHash(digestBytes(token));
    if (!credential) throw this.refuse("No credential matches the presented token.");

    this.assertUsable(credential);

    // The downgrade check. An agent that has adopted a signed credential must
    // not remain impersonable with a leaked string.
    if (this.refuseBearerWhenStrong) {
      const hasStrong = await this.store.hasStrongCredential(
        credential.agentId,
        this.clock.nowIso(),
      );
      if (hasStrong) {
        throw new DeniedError(
          "authorization.action_not_permitted",
          "This agent holds a signed credential, so plain bearer authentication is refused. Present the signed credential instead.",
          { externalAgentId: credential.agentId },
        );
      }
    }

    await this.store.touchCredentialUsed(credential.id, this.clock.nowIso());
    return {
      agentId: credential.agentId,
      credentialId: credential.id,
      kind: "bearer",
      strong: false,
    };
  }

  private async verifyJwt(token: string): Promise<VerifiedIdentity> {
    if (typeof token !== "string" || token.length > 8192) {
      throw this.refuse("A token of an implausible length was presented.");
    }

    // The subject is read from the *unverified* payload only to find which
    // credential to verify against. Nothing is trusted from it: the signature
    // is checked below, and the verified subject is then compared to the
    // enrolled id. Reversing that order is how a token minted for one agent
    // ends up authenticating another.
    const claimedSubject = readUnverifiedSubject(token);
    if (!claimedSubject) throw this.refuse("The token carries no subject claim.");

    const candidates = (await this.store.listCredentials(claimedSubject as ExternalAgentId)).filter(
      (entry) => entry.kind === "jwt",
    );
    if (candidates.length === 0) {
      throw this.refuse("No signed-assertion credential is enrolled for that subject.");
    }

    for (const credential of candidates) {
      try {
        this.assertUsable(credential);
        if (!credential.jwksPath || !credential.issuer || !credential.audience) continue;

        // Read from disk. No network fetch on the authentication path: it is a
        // denial-of-service lever and a request-forgery surface aimed at a URL
        // the token itself names.
        const keySet = createLocalJWKSet(this.readJwks(credential.jwksPath));

        const { payload } = await jwtVerify(token, keySet, {
          issuer: credential.issuer,
          audience: credential.audience,
          // Asymmetric only. Allowing an HMAC algorithm alongside these lets an
          // attacker sign a token with the public key, and `none` needs no
          // explanation.
          algorithms: ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"],
          clockTolerance: Math.floor(this.freshnessMs / 1000),
          currentDate: new Date(this.clock.now()),
        });

        // The binding that matters. The verified subject must equal the enrolled
        // agent id exactly — not start with it, not contain it.
        if (payload.sub !== credential.agentId) {
          throw this.refuse(
            "The token's verified subject does not match the enrolled agent it was presented for.",
          );
        }

        await this.store.touchCredentialUsed(credential.id, this.clock.nowIso());
        return {
          agentId: credential.agentId,
          credentialId: credential.id,
          kind: "jwt",
          strong: true,
        };
      } catch (error) {
        if (error instanceof DeniedError && error.reason === "authorization.action_not_permitted") {
          throw error;
        }
        // Try the next enrolled key. Rotation means an agent can legitimately
        // hold two.
        continue;
      }
    }

    throw this.refuse("The signed assertion could not be verified against any enrolled key.");
  }

  /**
   * Verify an HMAC-signed request or a signed envelope.
   *
   * Both carry identity, timestamp, nonce, and a body digest, and both are
   * single-use. Freshness alone is not replay protection: a captured request
   * replayed inside its window is still a replay, and the nonce claim is what
   * refuses it.
   */
  private async verifySigned(
    presented: Extract<PresentedCredential, { kind: "hmac" | "envelope" }>,
    kind: "hmac" | "envelope",
  ): Promise<VerifiedIdentity> {
    const { agentId, timestamp, nonce, signature, bodyDigest } = presented;

    if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 128) {
      throw this.refuse("The request names no usable agent.");
    }
    if (typeof nonce !== "string" || nonce.length < 8 || nonce.length > 128) {
      throw this.refuse("The request carries no usable nonce.");
    }
    if (typeof signature !== "string" || signature.length === 0 || signature.length > 4096) {
      throw this.refuse("The request carries no usable signature.");
    }

    const skew = Math.abs(this.clock.now() - Date.parse(timestamp));
    if (!Number.isFinite(skew) || skew > this.freshnessMs) {
      throw this.refuse("The request timestamp is outside the accepted freshness window.");
    }

    const credentials = (await this.store.listCredentials(agentId as ExternalAgentId)).filter(
      (entry) => entry.kind === kind,
    );
    if (credentials.length === 0) {
      throw this.refuse(`No ${kind} credential is enrolled for that agent.`);
    }

    const message = signingMessage({ agentId, timestamp, nonce, bodyDigest });

    let matched: AgentCredential | null = null;
    for (const credential of credentials) {
      try {
        this.assertUsable(credential);
      } catch {
        continue;
      }

      if (kind === "hmac") {
        if (!credential.secretRef) continue;
        // Resolved by name, at verify time. The value never rests here.
        const secret = await this.secrets.resolve(credential.secretRef);
        if (!secret) {
          throw new DeniedError(
            "integration.credential_missing",
            `The secret named "${credential.secretRef}" could not be resolved, so the request was refused rather than accepted unverified.`,
            { externalAgentId: agentId },
          );
        }
        const expected = createHmac("sha256", secret).update(message).digest();
        if (constantTimeEquals(expected, decodeSignature(signature))) {
          matched = credential;
          break;
        }
      } else {
        if (!credential.publicKey) continue;
        if (verifyEnvelopeSignature(credential.publicKey, message, signature)) {
          matched = credential;
          break;
        }
      }
    }

    if (!matched) throw this.refuse("The request signature did not verify against any enrolled key.");

    // Single use, claimed durably and bounded per agent. Claimed AFTER the
    // signature verifies, so an unauthenticated caller cannot burn nonces on
    // behalf of an agent and lock it out.
    const claimed = await this.nonces.claimNonce(
      matched.agentId,
      nonce,
      new Date(this.clock.now() + this.freshnessMs * 2).toISOString(),
    );
    if (!claimed) {
      throw new DeniedError(
        "approval.already_used",
        "This request has already been seen. A correctly signed request that is presented twice is a replay, whatever its timestamp says.",
        { externalAgentId: matched.agentId },
      );
    }

    await this.store.touchCredentialUsed(matched.id, this.clock.nowIso());
    return {
      agentId: matched.agentId,
      credentialId: matched.id,
      kind,
      strong: true,
    };
  }

  private assertUsable(credential: AgentCredential): void {
    if (credential.revokedAt) {
      throw new DeniedError(
        "integration.credential_missing",
        "That credential has been revoked.",
        { credentialId: credential.id },
      );
    }
    if (credential.expiresAt && this.clock.nowIso() > credential.expiresAt) {
      throw new DeniedError(
        "integration.credential_missing",
        `That credential expired at ${credential.expiresAt}.`,
        { credentialId: credential.id },
      );
    }
  }

  /**
   * One refusal message for every authentication failure.
   *
   * Deliberately uniform. Distinguishing "no such agent" from "wrong signature"
   * turns the endpoint into an oracle for enumerating enrolled agents. The
   * specific reason is available to an operator in the audit record; it is not
   * available to the caller.
   */
  private refuse(operatorDetail: string): DeniedError {
    return new DeniedError(
      "integration.credential_missing",
      "The presented credential could not be verified.",
      { detail: operatorDetail },
    );
  }
}

// ---------------------------------------------------------------------------

/**
 * The exact bytes a signature covers.
 *
 * Domain-separated and field-delimited. The domain prefix binds the signature
 * to this platform and this purpose, so a signature produced for another system
 * over the same values cannot be replayed here. The newline delimiter means no
 * field can be shifted into its neighbour — without it, an agent id ending in
 * digits and a timestamp beginning with them would concatenate ambiguously, and
 * two different requests could produce identical signed bytes.
 */
export function signingMessage(input: {
  readonly agentId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly bodyDigest: Digest;
}): string {
  return [ENVELOPE_DOMAIN, input.agentId, input.timestamp, input.nonce, input.bodyDigest].join("\n");
}

function decodeSignature(signature: string): Buffer {
  try {
    return Buffer.from(signature, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function verifyEnvelopeSignature(publicKeyPem: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    const verifier = createVerify("SHA256");
    verifier.update(message);
    verifier.end();
    return verifier.verify(key, decodeSignature(signature));
  } catch {
    // A malformed key or signature is a failed verification, never an accepted
    // one. Anything thrown here means we could not establish the signature is
    // good, which is the same outcome as it being bad.
    return false;
  }
}

/** Read `sub` from an unverified token, only to select a credential to verify against. */
function readUnverifiedSubject(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof decoded.sub === "string" && decoded.sub.length > 0 && decoded.sub.length <= 128
      ? decoded.sub
      : null;
  } catch {
    return null;
  }
}
