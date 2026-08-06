import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * High-entropy value generation, injected like the clock and the id generator.
 *
 * Everything in this module that produces a secret — a PKCE verifier, an OIDC
 * `state` and `nonce`, a service-account credential — draws from here rather
 * than reaching for `crypto` directly. Two reasons, and the second is the one
 * that matters:
 *
 *   1. Tests can supply a scripted generator and assert on exact values,
 *      including the seeded demo, which has to reproduce byte for byte.
 *   2. There is exactly one place to look when someone asks "where do this
 *      platform's secrets come from, and are they from a CSPRNG?". A generator
 *      scattered across five call sites is five places for one of them to have
 *      quietly become `Math.random()`.
 *
 * The scripted implementation is deliberately not exported from the module's
 * public surface. A deterministic secret generator in a production build would
 * make every credential predictable, and the cheapest way to guarantee that
 * cannot happen by accident is for the only exported implementation to be the
 * real one. Tests import it by path.
 */
export interface SecretGenerator {
  /** `count` cryptographically random bytes. */
  bytes(count: number): Uint8Array;
}

export class CryptoSecretGenerator implements SecretGenerator {
  bytes(count: number): Uint8Array {
    if (!Number.isInteger(count) || count < 16) {
      // Below 128 bits there is no point pretending the value is unguessable.
      throw new RangeError(`Refusing to generate a ${count}-byte secret; 16 bytes is the floor.`);
    }
    return randomBytes(count);
  }
}

/** URL-safe base64 with no padding, as RFC 7636 requires for PKCE. */
export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A fresh URL-safe token of `bytes` bytes of entropy. */
export function randomToken(secrets: SecretGenerator, bytes = 32): string {
  return base64Url(secrets.bytes(bytes));
}

/** The S256 code challenge for a PKCE verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Length is compared first and non-constant-time, which reveals only the
 * length of the supplied value — something an attacker already controls.
 */
export function secretsEqual(left: string, right: string): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
