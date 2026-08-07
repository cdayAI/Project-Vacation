import { randomBytes, createHash } from "node:crypto";

/**
 * Identifier generation.
 *
 * Identifiers are prefixed by entity type. That costs a few bytes and buys
 * two things worth more than the bytes: an id pasted into a support ticket is
 * self-describing, and a run id passed where an approval id was expected fails
 * a cheap check instead of silently querying the wrong table.
 *
 * As with the clock, the demo's "runs twice identically" gate means id
 * generation has to be injectable rather than reaching for `randomUUID`
 * directly.
 */

export const ID_PREFIXES = {
  run: "run",
  step: "stp",
  approval: "apr",
  auditEntry: "aud",
  workflowInstance: "wfi",
  workflowDefinition: "wfd",
  role: "rol",
  roleVersion: "rlv",
  document: "doc",
  template: "tpl",
  corpus: "cor",
  chunk: "chk",
  observation: "obs",
  proposal: "prp",
  cluster: "clu",
  consent: "cns",
  message: "msg",
  evaluation: "evl",
  actor: "act",
  session: "ses",
  incident: "inc",
  candidate: "cnd",
  contract: "ctr",
  // External agents: those MVW already runs elsewhere, admitted under
  // governance rather than orchestrated here.
  externalAgent: "eag",
  credential: "crd",
  externalRun: "xrn",
  parkedAction: "pac",
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;

/** A prefixed identifier, e.g. `run_01j8x...`. */
export type Id<K extends EntityKind = EntityKind> = string & { readonly __kind?: K };

export interface IdGenerator {
  next<K extends EntityKind>(kind: K): Id<K>;
}

const SUFFIX_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford-style, no i/l/o/u

/** Characters in an identifier's suffix. */
const SUFFIX_LENGTH = 22;

/**
 * Encode one byte per character.
 *
 * The alphabet has thirty-two symbols and a byte has two hundred and fifty-six
 * values, so `byte % 32` is exactly uniform — no modulo bias. Callers must
 * supply at least `length` bytes: the index wraps, so a shorter buffer would
 * silently repeat itself and produce an identifier whose tail is a copy of its
 * head, worth fewer bits than its length suggests.
 */
function encodeSuffix(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i % bytes.length] ?? 0;
    out += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length];
  }
  return out;
}

export class RandomIdGenerator implements IdGenerator {
  next<K extends EntityKind>(kind: K): Id<K> {
    // One random byte per character. A UUID carries sixteen bytes and the
    // suffix is twenty-two characters long, so deriving the suffix from one
    // would wrap the index and repeat the first six characters at the end —
    // costing thirty of the hundred and ten bits the length implies. Parked
    // actions and sessions are reached by presenting their identifier, so the
    // strength has to be the strength it looks like.
    return `${ID_PREFIXES[kind]}_${encodeSuffix(randomBytes(SUFFIX_LENGTH), SUFFIX_LENGTH)}` as Id<K>;
  }
}

/**
 * Deterministic identifiers derived from a seed and a per-kind counter.
 *
 * Same seed and same call order produce the same ids, which is what makes the
 * seeded demo reproducible byte for byte. Not suitable for production: ids are
 * predictable by construction.
 */
export class SeededIdGenerator implements IdGenerator {
  private readonly seed: string;
  private readonly counters = new Map<string, number>();

  constructor(seed: string) {
    this.seed = seed;
  }

  next<K extends EntityKind>(kind: K): Id<K> {
    const count = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, count);
    const digest = createHash("sha256").update(`${this.seed}:${kind}:${count}`).digest();
    return `${ID_PREFIXES[kind]}_${encodeSuffix(digest, 22)}` as Id<K>;
  }

  /** Reset counters so a fresh run from the same seed repeats exactly. */
  reset(): void {
    this.counters.clear();
  }
}

/** True if `id` carries the prefix for `kind`. */
export function isId<K extends EntityKind>(id: string, kind: K): id is Id<K> {
  return typeof id === "string" && id.startsWith(`${ID_PREFIXES[kind]}_`);
}

/** Throw unless `id` carries the prefix for `kind`. */
export function assertId<K extends EntityKind>(id: string, kind: K): asserts id is Id<K> {
  if (!isId(id, kind)) {
    throw new TypeError(`Expected a ${kind} id (prefix "${ID_PREFIXES[kind]}_"), received: ${id}`);
  }
}
