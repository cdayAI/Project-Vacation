import type { AuditEntry, AuditFilter, NewAuditEntry } from "./types.js";

/** What the store hands to the builder once it holds the append lock. */
export interface ChainPosition {
  readonly seq: number;
  readonly previousHash: string;
}

/**
 * Persistence port for the audit chain.
 *
 * `appendEntry` takes a builder rather than a finished entry because the store
 * — and only the store — can safely assign `seq` and read the current head
 * hash. Assigning them in the caller would open a window where two appends
 * read the same head and produce a fork, which verification would later report
 * as a duplicate sequence with no way to tell which branch was real.
 *
 * Implementations must:
 *   - serialise appends so that `seq` is contiguous and `previousHash` always
 *     names the immediately preceding entry;
 *   - never update or delete an entry through any code path;
 *   - fail rather than silently skip when the head cannot be read.
 */
export interface AuditStore {
  /**
   * Append one entry.
   *
   * The store acquires its append lock, computes the next `ChainPosition`,
   * calls `build`, persists the result, and releases the lock.
   */
  appendEntry(
    content: NewAuditEntry,
    build: (content: NewAuditEntry, position: ChainPosition) => AuditEntry,
  ): Promise<AuditEntry>;

  listAuditEntries(filter?: AuditFilter): Promise<readonly AuditEntry[]>;
  countAuditEntries(filter?: AuditFilter): Promise<number>;
  /** All entries in ascending sequence order. Used by the verifier. */
  readAuditChain(fromSeq?: number, toSeq?: number): Promise<readonly AuditEntry[]>;
  /** The current head, or null when the chain is empty. */
  auditHead(): Promise<AuditEntry | null>;
}
