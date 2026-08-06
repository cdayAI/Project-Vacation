/**
 * Canonical JSON serialisation.
 *
 * Two things in this platform depend on byte-identical serialisation of the
 * same logical value: the audit hash chain (audit/) and approval digests
 * (guard/approvals). If serialisation is unstable, a chain that is actually
 * intact will fail verification, and an approval bound to a proposal will stop
 * matching that proposal. Both failures are indistinguishable from tampering,
 * which makes them expensive to diagnose. So serialisation is defined here
 * once, exactly, and everything hashes through it.
 *
 * Rules:
 *   - Object keys are emitted in ascending code-unit order.
 *   - Properties whose value is `undefined` are omitted entirely, matching
 *     `JSON.stringify` and keeping `{a: 1}` and `{a: 1, b: undefined}` equal.
 *   - Arrays keep their order; `undefined` and functions inside an array
 *     become `null`, again matching `JSON.stringify`.
 *   - Non-finite numbers and BigInt throw rather than silently becoming
 *     `null`. A NaN that hashes to the same value as a real number is a
 *     correctness hole in an audit record.
 *   - `Date` is rejected. Callers must convert to an explicit ISO-8601 string
 *     so the intent is visible at the call site rather than depending on the
 *     serialiser's timezone handling.
 */

export class CanonicalisationError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "CanonicalisationError";
    this.path = path;
  }
}

/** Any value that can be canonicalised. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

function encodeString(value: string): string {
  // JSON.stringify on a string is already RFC 8259 compliant and is
  // considerably faster than a hand-rolled escaper.
  return JSON.stringify(value);
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";

  const type = typeof value;

  if (type === "boolean") return value ? "true" : "false";

  if (type === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalisationError(
        `Non-finite number cannot be canonicalised: ${String(n)}`,
        path,
      );
    }
    // Normalise -0 to 0 so the two do not produce different digests.
    return Object.is(n, -0) ? "0" : String(n);
  }

  if (type === "string") return encodeString(value as string);

  if (type === "bigint") {
    throw new CanonicalisationError(
      "BigInt cannot be canonicalised; convert to string at the call site",
      path,
    );
  }

  if (type === "function" || type === "symbol" || type === "undefined") {
    throw new CanonicalisationError(`Cannot canonicalise ${type}`, path);
  }

  if (Array.isArray(value)) {
    const parts = value.map((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        // Mirrors JSON.stringify array behaviour rather than throwing, so that
        // sparse or holey arrays round-trip predictably.
        return "null";
      }
      return encode(item, itemPath);
    });
    return `[${parts.join(",")}]`;
  }

  if (value instanceof Date) {
    throw new CanonicalisationError(
      "Date cannot be canonicalised; pass an explicit ISO-8601 string instead",
      path,
    );
  }

  if (value instanceof Map || value instanceof Set) {
    throw new CanonicalisationError(
      `${value.constructor.name} cannot be canonicalised; convert to a plain object or array`,
      path,
    );
  }

  // Plain object (or a class instance, which we treat as its own enumerable
  // own-properties — deliberate, since audit payloads should be plain data).
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined) continue;
    if (typeof entry === "function" || typeof entry === "symbol") continue;
    parts.push(`${encodeString(key)}:${encode(entry, path ? `${path}.${key}` : key)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Serialise a value to its canonical JSON string.
 *
 * @throws {CanonicalisationError} if the value contains something that has no
 *   stable representation (non-finite number, BigInt, Date, Map, Set).
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "");
}
