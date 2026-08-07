import type { Clock } from "../kernel/clock.js";
import { canonicalJson } from "../kernel/canonical.js";
import { DeniedError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import { isDigest } from "../kernel/hash.js";
import type { IdGenerator } from "../kernel/ids.js";
import { GENESIS_PREVIOUS_HASH, verifyChain } from "./chain.js";
import { containsSecret, looksLikeCardNumber } from "../kernel/redact.js";
import type { AuditStore } from "./port.js";
import { computeEntryHash } from "./chain.js";
import type { AuditEntry, AuditEventType, AuditFilter, NewAuditEntry } from "./types.js";

/**
 * The write path for the audit chain.
 *
 * Everything that records a decision goes through `record()`. Nothing writes
 * to the `AuditStore` directly — an architecture test enforces that — because
 * this class is where three guarantees are applied that would otherwise depend
 * on every caller remembering them:
 *
 *   1. Entries are hashed and linked correctly.
 *   2. Payloads that look like secrets or raw personal data are rejected
 *      outright rather than written and regretted. The audit log records
 *      fingerprints; a caller trying to write a value here has made a mistake
 *      that is much cheaper to catch now than after seven years of retention.
 *   3. A failed append raises. "The receipt is unavailable" must stop the
 *      action, not be logged and stepped over.
 */
/**
 * Ceiling on the canonical size of one entry's content.
 *
 * Generous enough that no legitimate decision comes close, small enough that a
 * seven-year chain stays cheap to store and quick to verify.
 */
/**
 * Email addresses and telephone numbers, the two shapes that are never a
 * reference.
 *
 * Deliberately narrow, and narrowed once more after it fired on a digest. A
 * sha256 hex string contains long digit runs by chance, so a pattern that
 * matched bare digits refused the very values this rule wants callers to write.
 * The telephone half therefore requires punctuation or a country prefix —
 * something a person typed — and digests are skipped outright at the call site.
 * A broad heuristic here is not "safer": a refused audit write refuses the
 * action it was recording, so over-refusal costs accountability rather than
 * buying privacy.
 */
const LOOKS_PERSONAL = new RegExp(
  [
    // An email address.
    "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
    // A telephone number as a human writes one: a country prefix, or digit
    // groups separated by spaces, dots, hyphens or brackets.
    "\\+\\d[\\d \\-().]{7,}\\d",
    "\\d{3}[ \\-.()]+\\d{3}[ \\-.()]+\\d{4}",
  ].join("|"),
);

const MAX_ENTRY_CONTENT_BYTES = 16 * 1024;

export class AuditLog {
  constructor(
    private readonly store: AuditStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Append a decision to the chain.
   *
   * @throws {DeniedError} `record.unavailable` if the entry cannot be written,
   *   so the caller fails closed rather than proceeding unrecorded.
   */
  async record(content: NewAuditEntry): Promise<AuditEntry> {
    this.assertNoRawPayloads(content);

    const recordedAt = content.recordedAt ?? this.clock.nowIso();

    try {
      return await this.store.appendEntry({ ...content, recordedAt }, (entryContent, position) => {
        const base = {
          seq: position.seq,
          eventType: entryContent.eventType,
          recordedAt: entryContent.recordedAt ?? recordedAt,
          actor: entryContent.actor,
          runId: entryContent.runId,
          correlationId: entryContent.correlationId,
          subject: entryContent.subject,
          inputDigests: entryContent.inputDigests,
          decision: entryContent.decision,
          previousHash: position.previousHash,
        };
        return {
          id: this.ids.next("auditEntry"),
          ...base,
          entryHash: computeEntryHash(base),
        } as AuditEntry;
      });
    } catch (error) {
      if (error instanceof DeniedError) throw error;
      throw new DeniedError(
        "record.unavailable",
        `The audit record could not be written, so the action was refused: ${error instanceof Error ? error.message : String(error)}`,
        { eventType: content.eventType },
      );
    }
  }

  /**
   * Reject anything that would put a payload or a secret into the chain.
   *
   * The rules are deliberately blunt. `inputDigests` must contain digests and
   * nothing else. `subject` values must be short opaque references. Any string
   * anywhere that looks like a credential is refused. Over-refusing here costs
   * a developer one clear error message; under-refusing costs a permanent
   * record of something that should never have been retained.
   */
  private assertNoRawPayloads(content: NewAuditEntry): void {
    // Bound the shape before bounding the values.
    //
    // Capping each value's length is not enough on its own: every individual
    // value can sit under its cap while the number of keys carries the payload
    // instead. Twenty thousand keys of two hundred characters is a four-megabyte
    // audit entry composed entirely of legal values — which defeats the point of
    // storing fingerprints, makes verification hashing expensive forever, and is
    // a denial-of-service against the store. So the counts are capped too, and
    // so is the total size of the whole entry.
    const shapeLimits = [
      { name: "inputDigests", value: content.inputDigests ?? {}, max: 32 },
      { name: "subject", value: content.subject ?? {}, max: 32 },
      { name: "decision", value: content.decision ?? {}, max: 64 },
    ] as const;

    for (const limit of shapeLimits) {
      const count = Object.keys(limit.value).length;
      if (count > limit.max) {
        throw new DeniedError(
          "record.unavailable",
          `Audit ${limit.name} has ${count} keys, past the limit of ${limit.max}. An audit entry records a decision, not a dataset.`,
          { field: limit.name, count, eventType: content.eventType },
        );
      }
    }

    const contentSize = canonicalJson({
      subject: content.subject ?? {},
      inputDigests: content.inputDigests ?? {},
      decision: content.decision ?? {},
    }).length;
    if (contentSize > MAX_ENTRY_CONTENT_BYTES) {
      throw new DeniedError(
        "record.unavailable",
        `Audit entry content is ${contentSize} bytes, past the ${MAX_ENTRY_CONTENT_BYTES}-byte limit. Record a digest of the material instead of the material.`,
        { size: contentSize, eventType: content.eventType },
      );
    }

    for (const [key, value] of Object.entries(content.inputDigests ?? {})) {
      if (typeof value !== "string" || !isDigest(value)) {
        throw new DeniedError(
          "record.unavailable",
          `Audit inputDigests.${key} must be a sha256 digest, not a value. The audit log records fingerprints of inputs, never the inputs themselves.`,
          { field: `inputDigests.${key}`, eventType: content.eventType },
        );
      }
    }

    for (const [key, value] of Object.entries(content.subject ?? {})) {
      if (typeof value !== "string") {
        throw new DeniedError(
          "record.unavailable",
          `Audit subject.${key} must be a string reference.`,
          { field: `subject.${key}`, eventType: content.eventType },
        );
      }
      if (value.length > 256) {
        throw new DeniedError(
          "record.unavailable",
          `Audit subject.${key} is ${value.length} characters. Subject values are opaque references, not content — store a digest or an identifier instead.`,
          { field: `subject.${key}`, eventType: content.eventType },
        );
      }
      if (containsSecret(value)) {
        throw new DeniedError(
          "record.unavailable",
          `Audit subject.${key} contains something that looks like a credential or a card number and was refused.`,
          { field: `subject.${key}`, eventType: content.eventType },
        );
      }
      // Defence in depth, not the primary control.
      //
      // Callers that take a subject from an untrusted source reduce it to
      // opaque references before it gets here, which is where that belongs —
      // this chain is append-only and kept for seven years, so a value written
      // by mistake cannot be taken out again. This check exists because "the
      // caller does it" is a convention, and a convention is one careless new
      // caller away from being false. It catches the two shapes that are
      // unambiguously a person rather than a reference.
      // A digest is already the answer this rule is asking for.
      if (!isDigest(value) && LOOKS_PERSONAL.test(value)) {
        throw new DeniedError(
          "record.unavailable",
          `Audit subject.${key} looks like personal contact details rather than an opaque reference, and was refused. The chain records who a decision was about by identifier or digest, never by name, email, or telephone number — it cannot be edited afterwards to remove one.`,
          { field: `subject.${key}`, eventType: content.eventType },
        );
      }
    }

    for (const [key, value] of Object.entries(content.decision ?? {})) {
      const type = typeof value;
      if (type !== "string" && type !== "number" && type !== "boolean") {
        throw new DeniedError(
          "record.unavailable",
          `Audit decision.${key} must be a string, number, or boolean. Nested payloads do not belong in the audit log.`,
          { field: `decision.${key}`, eventType: content.eventType },
        );
      }
      if (type === "string") {
        const text = value as string;
        if (text.length > 1024) {
          throw new DeniedError(
            "record.unavailable",
            `Audit decision.${key} is ${text.length} characters, which is long enough to be a payload rather than a decision.`,
            { field: `decision.${key}`, eventType: content.eventType },
          );
        }
        if (containsSecret(text)) {
          throw new DeniedError(
            "record.unavailable",
            `Audit decision.${key} contains something that looks like a credential or a card number and was refused.`,
            { field: `decision.${key}`, eventType: content.eventType },
          );
        }
      }
      // The same rule, for the other JSON type sixteen digits can arrive in.
      //
      // The string branch above ran and the numeric one did not, so
      // `{ paymentInstrument: 4111111111111111 }` passed the type check and was
      // written straight into the chain. That is worse than the log-sink case:
      // the chain is append-only and stated to be retained for years, and its
      // own retention design prunes a contiguous prefix and never edits a
      // middle — so a card number landing here could not be taken out again
      // without breaking verification for every entry after it.
      //
      // `looksLikeCardNumber` starts at fourteen digits rather than thirteen,
      // for the measured reason recorded next to it: at thirteen it would
      // refuse about one epoch-millisecond value in ten, and a refused audit
      // write refuses the action it was recording.
      if (type === "number" && looksLikeCardNumber(value as number)) {
        throw new DeniedError(
          "record.unavailable",
          `Audit decision.${key} is a number shaped like a card number and was refused. The audit log records decisions, not instruments; record a digest or a masked reference instead.`,
          { field: `decision.${key}`, eventType: content.eventType },
        );
      }
    }
  }

  list(filter?: AuditFilter): Promise<readonly AuditEntry[]> {
    return this.store.listAuditEntries(filter);
  }

  count(filter?: AuditFilter): Promise<number> {
    return this.store.countAuditEntries(filter);
  }

  readChain(fromSeq?: number, toSeq?: number): Promise<readonly AuditEntry[]> {
    return this.store.readAuditChain(fromSeq, toSeq);
  }

  head(): Promise<AuditEntry | null> {
    return this.store.auditHead();
  }

  /**
   * The furthest this chain has ever reached.
   *
   * Every verifier that has a store must pass this in. `head()` describes what
   * survives; this describes what there was, and the gap between them is the
   * only evidence that entries were deleted from the end.
   */
  watermark(): Promise<{ readonly maxSeq: number; readonly headHash: string } | null> {
    return this.store.auditWatermark();
  }

  /**
   * Verify the whole chain against what this store knows it should hold.
   *
   * The supported way to verify a live deployment, and the reason it exists is
   * that the alternative is a trap: `verifyChain(entries)` is
   * storage-independent by design — an auditor verifying an exported archive
   * has entries and nothing else — so a caller who reaches for it directly gets
   * a verifier that cannot see head truncation and says INTACT about an emptied
   * table. Reading the entries and the watermark together is the only way to
   * ask the question that matters on a running system, so it is the method the
   * CLI, the API and the tests use.
   */
  async verify(options: { readonly fromSeq?: number; readonly toSeq?: number } = {}) {
    const [chain, mark] = await Promise.all([
      this.store.readAuditChain(options.fromSeq, options.toSeq),
      this.store.auditWatermark(),
    ]);
    // A partial read is not evidence of truncation: an operator asking for
    // entries 5..10 has deliberately excluded the rest.
    const bounded = options.fromSeq !== undefined || options.toSeq !== undefined;
    return verifyChain(chain, GENESIS_PREVIOUS_HASH, bounded ? null : mark);
  }
}

/** Convenience shape for the common case of recording a governance decision. */
export interface DecisionRecord {
  readonly eventType: AuditEventType;
  readonly actorId: string;
  readonly actorKind: "human" | "service" | "system";
  readonly actorRoles?: readonly string[];
  readonly runId?: string;
  readonly correlationId?: string;
  readonly subject?: Readonly<Record<string, string>>;
  readonly inputDigests?: Readonly<Record<string, Digest>>;
  readonly decision?: Readonly<Record<string, string | number | boolean>>;
}

/** Build a `NewAuditEntry` from the flatter shape most call sites want. */
export function decision(input: DecisionRecord): NewAuditEntry {
  return {
    eventType: input.eventType,
    actor: {
      actorId: input.actorId,
      kind: input.actorKind,
      roles: input.actorRoles ?? [],
    },
    runId: input.runId as NewAuditEntry["runId"],
    correlationId: input.correlationId,
    subject: input.subject ?? {},
    inputDigests: input.inputDigests ?? {},
    decision: input.decision ?? {},
  };
}
