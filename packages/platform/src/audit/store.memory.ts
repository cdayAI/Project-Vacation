import { InvariantError } from "../kernel/errors.js";
import type { MemoryDb } from "../store/db.js";
import { assertIsoUtc } from "../record/migrations.js";
import { computeEntryHash, GENESIS_PREVIOUS_HASH } from "./chain.js";
import type { AuditStore, ChainPosition } from "./port.js";
import type { AuditEntry, AuditFilter, NewAuditEntry } from "./types.js";

/**
 * In-memory audit chain.
 *
 * Held to the same contract as the Postgres adapter, including the one that
 * matters most: twenty concurrent appends must produce a chain that
 * `verifyChain` reports as intact. The lock below is what makes that true.
 * Without it, two appends would read the same head, compute the same `seq` and
 * the same `previousHash`, and produce a fork — and a fork is indistinguishable
 * from tampering to anyone reading the log afterwards.
 *
 * There is no update and no delete here, and none is possible: the table is
 * only ever added to, and every entry handed out is a clone, so a caller
 * holding a reference to an entry it wrote cannot reach back into the chain
 * and alter it.
 */

const ENTRIES = "audit_entry";
const APPEND_LOCK = "audit:append";

export class MemoryAuditStore implements AuditStore {
  constructor(private readonly db: MemoryDb) {}

  async appendEntry(
    content: NewAuditEntry,
    build: (content: NewAuditEntry, position: ChainPosition) => AuditEntry,
  ): Promise<AuditEntry> {
    return this.db.withLock(APPEND_LOCK, async () => {
      const table = this.db.table<AuditEntry>(ENTRIES);
      const head = lastOf(table);
      const position: ChainPosition = head
        ? { seq: head.seq + 1, previousHash: head.entryHash }
        : { seq: 1, previousHash: GENESIS_PREVIOUS_HASH };

      const entry = build(content, position);
      assertAppendable(entry, position);

      if (table.has(String(entry.seq))) {
        throw new InvariantError(
          `Audit sequence ${entry.seq} is already occupied. Two appends were not serialised.`,
        );
      }
      table.set(String(entry.seq), structuredClone(entry));

      // Read it back and re-hash it. The same check the Postgres adapter runs,
      // for the same reason: whatever storage does to a value, it must not
      // change what the value hashes to.
      const stored = table.get(String(entry.seq));
      if (!stored) throw new InvariantError(`Audit entry ${entry.seq} did not persist.`);
      assertRoundTrip(entry, stored);

      return structuredClone(stored);
    });
  }

  async listAuditEntries(filter: AuditFilter = {}): Promise<readonly AuditEntry[]> {
    const matched = this.chain().filter((entry) => matchesAuditFilter(entry, filter));
    const from = filter.offset ?? 0;
    const to = filter.limit === undefined ? matched.length : from + filter.limit;
    return matched.slice(from, to).map((entry) => structuredClone(entry));
  }

  async countAuditEntries(filter: AuditFilter = {}): Promise<number> {
    return this.chain().filter((entry) => matchesAuditFilter(entry, filter)).length;
  }

  async readAuditChain(fromSeq?: number, toSeq?: number): Promise<readonly AuditEntry[]> {
    return this.chain()
      .filter((entry) => entry.seq >= (fromSeq ?? 1) && (toSeq === undefined || entry.seq <= toSeq))
      .map((entry) => structuredClone(entry));
  }

  async auditHead(): Promise<AuditEntry | null> {
    const head = lastOf(this.db.table<AuditEntry>(ENTRIES));
    return head ? structuredClone(head) : null;
  }

  /** Every entry, ascending by sequence. The verifier depends on this order. */
  private chain(): AuditEntry[] {
    return this.db.rows<AuditEntry>(ENTRIES).sort((left, right) => left.seq - right.seq);
  }
}

function lastOf(table: Map<string, AuditEntry>): AuditEntry | undefined {
  let head: AuditEntry | undefined;
  for (const entry of table.values()) {
    if (!head || entry.seq > head.seq) head = entry;
  }
  return head;
}

/**
 * Check the builder honoured the position it was given, before storing.
 *
 * The store does not trust its caller here even though the caller is
 * `AuditLog`. A builder that ignored the position — or hashed something other
 * than what it returned — would write a chain that fails verification later,
 * at which point nobody can tell an implementation bug from an intrusion. It
 * is far cheaper to refuse the write.
 */
export function assertAppendable(entry: AuditEntry, position: ChainPosition): void {
  assertIsoUtc("recordedAt", entry.recordedAt);
  if (entry.seq !== position.seq) {
    throw new InvariantError(
      `Audit entry claims sequence ${entry.seq} but the chain is at ${position.seq}.`,
    );
  }
  if (entry.previousHash !== position.previousHash) {
    throw new InvariantError(
      `Audit entry at sequence ${entry.seq} links to ${entry.previousHash} but the head is ${position.previousHash}.`,
    );
  }
  const expected = computeEntryHash(entry);
  if (entry.entryHash !== expected) {
    throw new InvariantError(
      `Audit entry at sequence ${entry.seq} does not hash to its recorded entryHash. It would fail verification the moment it was written.`,
    );
  }
}

/**
 * Confirm what came back out of storage is what went in.
 *
 * Recomputing the hash from the stored row catches a storage or mapping layer
 * that alters a value in transit — a jsonb round trip that renumbers, a
 * timestamp column that re-renders. Left undetected, that produces an audit
 * log which fails verification months later with no way to tell it from an
 * attack.
 */
export function assertRoundTrip(built: AuditEntry, stored: AuditEntry): void {
  if (stored.entryHash !== built.entryHash || computeEntryHash(stored) !== built.entryHash) {
    throw new InvariantError(
      `Audit entry at sequence ${built.seq} did not survive storage unchanged. The stored row does not hash to the value that was written.`,
    );
  }
}

export function matchesAuditFilter(entry: AuditEntry, filter: AuditFilter): boolean {
  if (filter.eventType && !filter.eventType.includes(entry.eventType)) return false;
  if (filter.runId !== undefined && entry.runId !== filter.runId) return false;
  if (filter.actorId !== undefined && entry.actor.actorId !== filter.actorId) return false;
  if (filter.correlationId !== undefined && entry.correlationId !== filter.correlationId) {
    return false;
  }
  // Strictly after and strictly before, matching the words and matching the
  // comparison the Postgres adapter emits.
  if (filter.recordedAfter !== undefined && !(entry.recordedAt > filter.recordedAfter)) return false;
  if (filter.recordedBefore !== undefined && !(entry.recordedAt < filter.recordedBefore)) {
    return false;
  }
  if (filter.fromSeq !== undefined && entry.seq < filter.fromSeq) return false;
  if (filter.subject) {
    // Containment, not equality: an entry matches when its subject includes
    // every pair asked for. An auditor tracing one contract should not have to
    // reproduce the rest of the subject exactly to find it.
    for (const [key, value] of Object.entries(filter.subject)) {
      if (entry.subject[key] !== value) return false;
    }
  }
  return true;
}
