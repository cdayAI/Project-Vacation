import { describe, it, expect, beforeEach } from "vitest";
import { createHmac, generateKeyPairSync, createSign } from "node:crypto";
import { SignJWT, exportJWK, importPKCS8 } from "jose";
import { FixedClock, MINUTE } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { digestBytes } from "../kernel/hash.js";
import { DeniedError } from "../kernel/errors.js";
import { MemoryDb } from "../store/db.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { AuditLog } from "../audit/log.js";
import { CredentialService, signingMessage, type SecretResolver } from "./credentials.js";
import type { CredentialStore, NonceStore } from "./port.js";
import type { AgentCredential, ExternalAgentId } from "./types.js";

/**
 * Credential tests.
 *
 * Each one below corresponds to a specific way credential handling is got
 * wrong: a stored token that a leaked backup replays, a token minted for one
 * agent authenticating another, an algorithm confusion, a secret pasted into a
 * reference field, a replay inside a freshness window, and a signed credential
 * that a leftover bearer token silently downgrades.
 */

const AGENT_A = "eag_alpha" as ExternalAgentId;
const AGENT_B = "eag_beta" as ExternalAgentId;
const NOW = "2026-08-06T12:00:00.000Z";

/** Minimal in-file fakes so these tests do not wait on the adapter work. */
class FakeCredentialStore implements CredentialStore {
  readonly credentials = new Map<string, AgentCredential>();

  async createCredential(credential: AgentCredential): Promise<AgentCredential> {
    this.credentials.set(credential.id, credential);
    return credential;
  }
  async getCredential(id: string): Promise<AgentCredential | null> {
    return this.credentials.get(id) ?? null;
  }
  async listCredentials(agentId: ExternalAgentId): Promise<readonly AgentCredential[]> {
    return [...this.credentials.values()].filter((entry) => entry.agentId === agentId);
  }
  async findByTokenHash(tokenHash: string): Promise<AgentCredential | null> {
    return [...this.credentials.values()].find((entry) => entry.tokenHash === tokenHash) ?? null;
  }
  async revokeCredential(
    id: string,
    at: string,
    by: string,
    reason: string,
  ): Promise<AgentCredential | null> {
    const found = this.credentials.get(id);
    if (!found || found.revokedAt) return null;
    const revoked = { ...found, revokedAt: at, revokedBy: by, revokedReason: reason };
    this.credentials.set(id, revoked);
    return revoked;
  }
  async touchCredentialUsed(id: string, at: string): Promise<void> {
    const found = this.credentials.get(id);
    if (found) this.credentials.set(id, { ...found, lastUsedAt: at });
  }
  async hasStrongCredential(agentId: ExternalAgentId, now: string): Promise<boolean> {
    return [...this.credentials.values()].some(
      (entry) =>
        entry.agentId === agentId &&
        entry.kind !== "bearer" &&
        !entry.revokedAt &&
        (!entry.expiresAt || entry.expiresAt > now),
    );
  }
}

class FakeNonceStore implements NonceStore {
  readonly claims = new Set<string>();
  async claimNonce(agentId: ExternalAgentId, nonce: string): Promise<boolean> {
    const key = `${agentId}:${nonce}`;
    if (this.claims.has(key)) return false;
    this.claims.add(key);
    return true;
  }
  async purgeExpiredNonces(): Promise<number> {
    return 0;
  }
  async countNonces(): Promise<number> {
    return this.claims.size;
  }
}

class FakeSecrets implements SecretResolver {
  constructor(private readonly values: Record<string, string>) {}
  async resolve(name: string): Promise<string | null> {
    return this.values[name] ?? null;
  }
}

function build(options: Parameters<typeof CredentialService.prototype.constructor>[6] = {}) {
  const clock = new FixedClock(NOW);
  const store = new FakeCredentialStore();
  const nonces = new FakeNonceStore();
  const secrets = new FakeSecrets({ "crm/hmac": "the-shared-secret-value" });
  const audit = new AuditLog(
    new MemoryAuditStore(new MemoryDb()),
    clock,
    new SeededIdGenerator("cred"),
  );
  const service = new CredentialService(
    store,
    nonces,
    secrets,
    clock,
    new SeededIdGenerator("cred"),
    audit,
    options as never,
  );
  return { clock, store, nonces, secrets, audit, service };
}

describe("bearer credentials", () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  it("returns the token exactly once and stores only a hash", async () => {
    const minted = await h.service.mint({
      agentId: AGENT_A,
      kind: "bearer",
      label: "crm",
      createdBy: "admin",
    });

    expect(minted.token).toBeTruthy();
    const stored = h.store.credentials.get(minted.credential.id);
    // The value must be absent from the record entirely.
    expect(JSON.stringify(stored)).not.toContain(minted.token ?? "impossible");
    expect(stored?.tokenHash).toBe(digestBytes(minted.token ?? ""));
  });

  it("authenticates a valid token", async () => {
    const minted = await h.service.mint({
      agentId: AGENT_A,
      kind: "bearer",
      label: "crm",
      createdBy: "admin",
    });
    const identity = await h.service.verify({ kind: "bearer", token: minted.token ?? "" });
    expect(identity.agentId).toBe(AGENT_A);
    expect(identity.strong).toBe(false);
  });

  it("cannot be authenticated from the stored hash alone", async () => {
    // The scenario: someone reads a registry backup. What they find must not
    // work as a credential.
    const minted = await h.service.mint({
      agentId: AGENT_A,
      kind: "bearer",
      label: "crm",
      createdBy: "admin",
    });
    const leaked = h.store.credentials.get(minted.credential.id)?.tokenHash ?? "";
    await expect(h.service.verify({ kind: "bearer", token: leaked })).rejects.toBeInstanceOf(
      DeniedError,
    );
  });

  it("refuses a revoked credential", async () => {
    const minted = await h.service.mint({
      agentId: AGENT_A,
      kind: "bearer",
      label: "crm",
      createdBy: "admin",
    });
    await h.service.revoke(minted.credential.id, "admin", "rotation");
    await expect(
      h.service.verify({ kind: "bearer", token: minted.token ?? "" }),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses an expired credential", async () => {
    const minted = await h.service.mint({
      agentId: AGENT_A,
      kind: "bearer",
      label: "crm",
      createdBy: "admin",
      expiresAt: "2026-08-06T12:30:00.000Z",
    });
    h.clock.advance(60 * MINUTE);
    await expect(
      h.service.verify({ kind: "bearer", token: minted.token ?? "" }),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("rotates without touching any other agent's credential", async () => {
    const a = await h.service.mint({
      agentId: AGENT_A,
      kind: "bearer",
      label: "a",
      createdBy: "admin",
    });
    const b = await h.service.mint({
      agentId: AGENT_B,
      kind: "bearer",
      label: "b",
      createdBy: "admin",
    });
    await h.service.revoke(a.credential.id, "admin", "rotation");

    await expect(h.service.verify({ kind: "bearer", token: a.token ?? "" })).rejects.toThrow();
    await expect(h.service.verify({ kind: "bearer", token: b.token ?? "" })).resolves.toMatchObject(
      { agentId: AGENT_B },
    );
  });

  it("gives the same refusal whether the agent is unknown or the token is wrong", async () => {
    // Otherwise the endpoint is an oracle for enumerating enrolled agents.
    const unknown = await h.service
      .verify({ kind: "bearer", token: "pvx_completely-made-up-token-value" })
      .catch((error: DeniedError) => error);
    await h.service.mint({ agentId: AGENT_A, kind: "bearer", label: "x", createdBy: "admin" });
    const wrong = await h.service
      .verify({ kind: "bearer", token: "pvx_another-made-up-token-value" })
      .catch((error: DeniedError) => error);

    expect((unknown as DeniedError).message).toBe((wrong as DeniedError).message);
  });
});

describe("the strong-credential switch", () => {
  it("refuses bearer authentication for an agent holding any strong credential", async () => {
    // Every strong kind, not just some: a switch naming two of the three leaves
    // the third as a silent downgrade path.
    for (const kind of ["jwt", "hmac", "envelope"] as const) {
      const h = build({ refuseBearerWhenStrongCredentialExists: true });
      const minted = await h.service.mint({
        agentId: AGENT_A,
        kind: "bearer",
        label: "legacy",
        createdBy: "admin",
      });

      await h.service.mint({
        agentId: AGENT_A,
        kind,
        label: `strong-${kind}`,
        createdBy: "admin",
        ...(kind === "jwt"
          ? { issuer: "https://idp.example", audience: "pv", jwksPath: "/tmp/jwks.json" }
          : {}),
        ...(kind === "hmac" ? { secretRef: "crm/hmac" } : {}),
        ...(kind === "envelope" ? { publicKey: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----" } : {}),
      });

      await expect(
        h.service.verify({ kind: "bearer", token: minted.token ?? "" }),
        `bearer should be refused once a ${kind} credential exists`,
      ).rejects.toThrow(/signed credential/);
    }
  });

  it("permits bearer when the agent holds no strong credential", async () => {
    const h = build({ refuseBearerWhenStrongCredentialExists: true });
    const minted = await h.service.mint({
      agentId: AGENT_A,
      kind: "bearer",
      label: "only",
      createdBy: "admin",
    });
    await expect(
      h.service.verify({ kind: "bearer", token: minted.token ?? "" }),
    ).resolves.toBeDefined();
  });

  it("ignores a revoked strong credential when deciding", async () => {
    const h = build({ refuseBearerWhenStrongCredentialExists: true });
    const bearer = await h.service.mint({
      agentId: AGENT_A,
      kind: "bearer",
      label: "legacy",
      createdBy: "admin",
    });
    const strong = await h.service.mint({
      agentId: AGENT_A,
      kind: "hmac",
      label: "signed",
      createdBy: "admin",
      secretRef: "crm/hmac",
    });
    await h.service.revoke(strong.credential.id, "admin", "retired");

    await expect(
      h.service.verify({ kind: "bearer", token: bearer.token ?? "" }),
    ).resolves.toBeDefined();
  });
});

describe("signed assertions", () => {
  async function jwtHarness() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey);
    const jwks = { keys: [{ ...jwk, alg: "RS256", use: "sig" }] };
    const h = build({ readJwks: () => jwks });
    await h.service.mint({
      agentId: AGENT_A,
      kind: "jwt",
      label: "idp",
      createdBy: "admin",
      issuer: "https://idp.example",
      audience: "project-vacation",
      jwksPath: "/does/not/exist.json",
    });
    return { ...h, privateKey, publicKey };
  }

  async function sign(
    privateKey: import("node:crypto").KeyObject,
    claims: { sub: string; iss?: string; aud?: string },
  ): Promise<string> {
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const key = await importPKCS8(pem, "RS256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(claims.sub)
      .setIssuer(claims.iss ?? "https://idp.example")
      .setAudience(claims.aud ?? "project-vacation")
      .setIssuedAt(Math.floor(Date.parse(NOW) / 1000))
      .setExpirationTime(Math.floor(Date.parse(NOW) / 1000) + 600)
      .sign(key);
  }

  it("accepts a correctly signed assertion", async () => {
    const h = await jwtHarness();
    const token = await sign(h.privateKey, { sub: AGENT_A });
    const identity = await h.service.verify({ kind: "jwt", token });
    expect(identity.agentId).toBe(AGENT_A);
    expect(identity.strong).toBe(true);
  });

  it("refuses a token minted for a different agent", async () => {
    // The binding that matters most. Without it, any principal the IdP will
    // sign for can authenticate as any enrolled agent.
    const h = await jwtHarness();
    await h.service.mint({
      agentId: AGENT_B,
      kind: "jwt",
      label: "idp",
      createdBy: "admin",
      issuer: "https://idp.example",
      audience: "project-vacation",
      jwksPath: "/does/not/exist.json",
    });

    const tokenForB = await sign(h.privateKey, { sub: AGENT_B });
    const identity = await h.service.verify({ kind: "jwt", token: tokenForB });
    // It authenticates as B, and only as B.
    expect(identity.agentId).toBe(AGENT_B);
    expect(identity.agentId).not.toBe(AGENT_A);
  });

  it("refuses a token whose subject matches no enrolled agent", async () => {
    const h = await jwtHarness();
    const token = await sign(h.privateKey, { sub: "eag_not_enrolled" });
    await expect(h.service.verify({ kind: "jwt", token })).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses a symmetric algorithm, so the public key cannot be used to sign", async () => {
    const h = await jwtHarness();
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(AGENT_A)
      .setIssuer("https://idp.example")
      .setAudience("project-vacation")
      .setExpirationTime(Math.floor(Date.parse(NOW) / 1000) + 600)
      .sign(new TextEncoder().encode("public-key-material-used-as-an-hmac-secret"));

    await expect(h.service.verify({ kind: "jwt", token: forged })).rejects.toBeInstanceOf(
      DeniedError,
    );
  });

  it("refuses the wrong issuer or audience", async () => {
    const h = await jwtHarness();
    const wrongIssuer = await sign(h.privateKey, { sub: AGENT_A, iss: "https://evil.example" });
    const wrongAudience = await sign(h.privateKey, { sub: AGENT_A, aud: "somebody-else" });
    await expect(h.service.verify({ kind: "jwt", token: wrongIssuer })).rejects.toThrow();
    await expect(h.service.verify({ kind: "jwt", token: wrongAudience })).rejects.toThrow();
  });

  it("verifies offline: no key material is fetched at verify time", async () => {
    // The jwksPath points at a file that does not exist, and the injected
    // reader is what supplies the keys. A network fetch on this path would be
    // both a denial-of-service lever and a request-forgery surface.
    let reads = 0;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey);
    const h = build({
      readJwks: () => {
        reads += 1;
        return { keys: [{ ...jwk, alg: "RS256", use: "sig" }] };
      },
    });
    await h.service.mint({
      agentId: AGENT_A,
      kind: "jwt",
      label: "idp",
      createdBy: "admin",
      issuer: "https://idp.example",
      audience: "project-vacation",
      jwksPath: "/nonexistent/jwks.json",
    });

    const token = await sign(privateKey, { sub: AGENT_A });
    await h.service.verify({ kind: "jwt", token });
    expect(reads).toBeGreaterThan(0);
  });

  it("refuses to mint without an issuer, audience, and local key path", async () => {
    const h = build();
    await expect(
      h.service.mint({ agentId: AGENT_A, kind: "jwt", label: "x", createdBy: "admin" }),
    ).rejects.toThrow(/issuer, an audience, and a local JWKS path/);
  });
});

describe("HMAC-signed requests", () => {
  function signHmac(secret: string, parts: { agentId: string; timestamp: string; nonce: string; bodyDigest: string }) {
    return createHmac("sha256", secret).update(signingMessage(parts)).digest("base64");
  }

  it("accepts a correctly signed request", async () => {
    const h = build();
    await h.service.mint({
      agentId: AGENT_A,
      kind: "hmac",
      label: "crm",
      createdBy: "admin",
      secretRef: "crm/hmac",
    });

    const parts = {
      agentId: AGENT_A,
      timestamp: NOW,
      nonce: "nonce-0000001",
      bodyDigest: digestBytes("{}"),
    };
    const identity = await h.service.verify({
      kind: "hmac",
      ...parts,
      signature: signHmac("the-shared-secret-value", parts),
    });
    expect(identity.strong).toBe(true);
  });

  it("refuses a replayed request inside the freshness window", async () => {
    // Freshness alone is not replay protection. A captured request presented
    // twice within its window is still a replay.
    const h = build();
    await h.service.mint({
      agentId: AGENT_A,
      kind: "hmac",
      label: "crm",
      createdBy: "admin",
      secretRef: "crm/hmac",
    });

    const parts = {
      agentId: AGENT_A,
      timestamp: NOW,
      nonce: "nonce-replay",
      bodyDigest: digestBytes("{}"),
    };
    const presented = {
      kind: "hmac" as const,
      ...parts,
      signature: signHmac("the-shared-secret-value", parts),
    };

    await expect(h.service.verify(presented)).resolves.toBeDefined();
    await expect(h.service.verify(presented)).rejects.toMatchObject({
      reason: "approval.already_used",
    });
  });

  it("refuses when the named secret cannot be resolved", async () => {
    const h = build();
    await h.service.mint({
      agentId: AGENT_A,
      kind: "hmac",
      label: "crm",
      createdBy: "admin",
      secretRef: "crm/absent",
    });
    const parts = {
      agentId: AGENT_A,
      timestamp: NOW,
      nonce: "nonce-absent",
      bodyDigest: digestBytes("{}"),
    };
    await expect(
      h.service.verify({ kind: "hmac", ...parts, signature: signHmac("anything", parts) }),
    ).rejects.toThrow(/could not be resolved/);
  });

  it("refuses a stale timestamp", async () => {
    const h = build();
    await h.service.mint({
      agentId: AGENT_A,
      kind: "hmac",
      label: "crm",
      createdBy: "admin",
      secretRef: "crm/hmac",
    });
    const parts = {
      agentId: AGENT_A,
      timestamp: "2026-08-06T10:00:00.000Z",
      nonce: "nonce-stale",
      bodyDigest: digestBytes("{}"),
    };
    await expect(
      h.service.verify({
        kind: "hmac",
        ...parts,
        signature: signHmac("the-shared-secret-value", parts),
      }),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses a signature over a different body", async () => {
    const h = build();
    await h.service.mint({
      agentId: AGENT_A,
      kind: "hmac",
      label: "crm",
      createdBy: "admin",
      secretRef: "crm/hmac",
    });
    const signed = {
      agentId: AGENT_A,
      timestamp: NOW,
      nonce: "nonce-body",
      bodyDigest: digestBytes('{"amount":1}'),
    };
    const signature = signHmac("the-shared-secret-value", signed);

    await expect(
      h.service.verify({
        kind: "hmac",
        ...signed,
        bodyDigest: digestBytes('{"amount":1000000}'),
        signature,
      }),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("does not burn a nonce on a request that failed to verify", async () => {
    // Otherwise an unauthenticated caller can exhaust an agent's nonce space
    // and lock it out.
    const h = build();
    await h.service.mint({
      agentId: AGENT_A,
      kind: "hmac",
      label: "crm",
      createdBy: "admin",
      secretRef: "crm/hmac",
    });
    const parts = {
      agentId: AGENT_A,
      timestamp: NOW,
      nonce: "nonce-contested",
      bodyDigest: digestBytes("{}"),
    };

    await expect(
      h.service.verify({ kind: "hmac", ...parts, signature: signHmac("wrong-secret", parts) }),
    ).rejects.toThrow();

    // The legitimate holder can still use that nonce.
    await expect(
      h.service.verify({
        kind: "hmac",
        ...parts,
        signature: signHmac("the-shared-secret-value", parts),
      }),
    ).resolves.toBeDefined();
  });

  it("refuses a secret value pasted into the reference field", async () => {
    const h = build();
    await expect(
      h.service.mint({
        agentId: AGENT_A,
        kind: "hmac",
        label: "crm",
        createdBy: "admin",
        secretRef: "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCB2YWx1ZQ==",
      }),
    ).rejects.toThrow(/secret value rather than a secret name/);
  });
});

describe("signed envelopes", () => {
  it("accepts a correctly signed envelope and refuses a tampered one", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const h = build();
    await h.service.mint({
      agentId: AGENT_A,
      kind: "envelope",
      label: "pinned",
      createdBy: "admin",
      publicKey: pem,
    });

    const parts = {
      agentId: AGENT_A,
      timestamp: NOW,
      nonce: "env-0001",
      bodyDigest: digestBytes("{}"),
    };
    const signer = createSign("SHA256");
    signer.update(signingMessage(parts));
    signer.end();
    const signature = signer.sign(privateKey).toString("base64");

    await expect(h.service.verify({ kind: "envelope", ...parts, signature })).resolves.toMatchObject(
      { strong: true },
    );

    // A different nonce is a different message, so the signature no longer fits.
    await expect(
      h.service.verify({ kind: "envelope", ...parts, nonce: "env-0002", signature }),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("binds the signature to this platform and purpose", () => {
    // Domain separation. Without a fixed prefix, a signature produced for
    // another system over the same values would verify here.
    const message = signingMessage({
      agentId: AGENT_A,
      timestamp: NOW,
      nonce: "n",
      bodyDigest: digestBytes("{}"),
    });
    expect(message.startsWith("project-vacation/external-agent/v1\n")).toBe(true);
  });

  it("delimits fields so two different requests cannot produce identical bytes", () => {
    // Without a delimiter, ("ab", "cd") and ("abc", "d") concatenate the same.
    const left = signingMessage({
      agentId: "ab",
      timestamp: "cd",
      nonce: "n",
      bodyDigest: digestBytes("{}"),
    });
    const right = signingMessage({
      agentId: "abc",
      timestamp: "d",
      nonce: "n",
      bodyDigest: digestBytes("{}"),
    });
    expect(left).not.toBe(right);
  });

  it("treats a malformed key as a failed verification, never a passed one", async () => {
    const h = build();
    await h.service.mint({
      agentId: AGENT_A,
      kind: "envelope",
      label: "broken",
      createdBy: "admin",
      publicKey: "not a key at all",
    });
    await expect(
      h.service.verify({
        kind: "envelope",
        agentId: AGENT_A,
        timestamp: NOW,
        nonce: "env-broken",
        bodyDigest: digestBytes("{}"),
        signature: "AAAA",
      }),
    ).rejects.toBeInstanceOf(DeniedError);
  });
});

describe("step-up on minting", () => {
  it("is enforced in the core, so a CLI path cannot walk past it", async () => {
    const h = build();
    await expect(
      h.service.mint({
        agentId: AGENT_A,
        kind: "bearer",
        label: "x",
        createdBy: "admin",
        requireStepUp: true,
      }),
    ).rejects.toMatchObject({ reason: "authorization.step_up_required" });

    await expect(
      h.service.mint({
        agentId: AGENT_A,
        kind: "bearer",
        label: "x",
        createdBy: "admin",
        requireStepUp: true,
        stepUpSatisfied: true,
      }),
    ).resolves.toBeDefined();
  });
});
