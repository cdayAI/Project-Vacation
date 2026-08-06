import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import { isDigest } from "../kernel/hash.js";
import type { IdGenerator } from "../kernel/ids.js";
import { containsSecret } from "../kernel/redact.js";
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
