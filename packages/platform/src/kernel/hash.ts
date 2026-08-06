import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./canonical.js";

/**
 * Content fingerprints.
 *
 * The audit log records "the fingerprints of their inputs — never raw
 * payloads, never secrets". Everything that needs to prove "this is the same
 * thing I saw earlier" without retaining the thing itself goes through here.
 *
 * Digests are prefixed with their algorithm (`sha256:<hex>`) so that a stored
 * digest stays interpretable if the algorithm ever changes. A verifier that
 * finds an unfamiliar prefix must fail rather than guess.
 */

const ALGORITHM = "sha256";
export const DIGEST_PREFIX = `${ALGORITHM}:`;

/** A prefixed content digest, e.g. `sha256:9f86d0...`. */
export type Digest = string;

/** Hash raw bytes or a string. */
export function digestBytes(input: string | Uint8Array): Digest {
  const hash = createHash(ALGORITHM);
  hash.update(input);
  return DIGEST_PREFIX + hash.digest("hex");
}

/**
 * Hash a structured value through canonical JSON.
 *
 * Two values that are logically equal produce the same digest regardless of
 * key insertion order.
 */
export function digestValue(value: unknown): Digest {
  return digestBytes(canonicalJson(value));
}

/** True if the string is a well-formed sha256 digest in our prefixed form. */
export function isDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * Constant-time digest comparison.
 *
 * Digests are not secrets, so this is not strictly required — but approval
 * binding compares a caller-supplied digest against a stored one, and using a
 * constant-time compare on that path by default is cheaper than reasoning
 * about whether any particular call site leaks anything useful.
 */
export function digestsEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
