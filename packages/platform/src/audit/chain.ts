import { digestValue } from "../kernel/hash.js";
import type { AuditEntry, ChainBreak, VerificationResult } from "./types.js";

/**
 * Hash-chain construction and verification.
 *
 * Kept separate from storage on purpose: the verifier must be able to check a
 * chain it did not write, from any source — a live database, a nightly export,
 * or an archive handed to an auditor — using nothing but the entries
 * themselves. If verification depended on the store, "verify the archive we
 * sent you" would not be answerable.
 */

/**
 * The `previousHash` of the first entry.
 *
 * A fixed, recognisable constant rather than an empty string, so that an entry
 * whose `previousHash` was blanked out cannot pass as a legitimate genesis
 * entry.
 */
export const GENESIS_PREVIOUS_HASH = "sha256:genesis";

/** The fields covered by `entryHash`, in the exact shape that gets hashed. */
export interface HashableEntry {
  readonly seq: number;
  readonly eventType: string;
  readonly recordedAt: string;
  readonly actor: unknown;
  readonly runId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly subject: unknown;
  readonly inputDigests: unknown;
  readonly decision: unknown;
  readonly previousHash: string;
}

/**
 * Compute the hash for an entry.
 *
 * Every field that a reader would rely on is covered. `id` is deliberately
 * excluded: it is assigned by the store and carries no assertion about what
 * happened, so including it would make an otherwise-identical entry
 * re-exported with a fresh id look like a different event.
 */
export function computeEntryHash(entry: HashableEntry): string {
  return digestValue({
    seq: entry.seq,
    eventType: entry.eventType,
    recordedAt: entry.recordedAt,
    actor: entry.actor,
    runId: entry.runId,
    correlationId: entry.correlationId,
    subject: entry.subject,
    inputDigests: entry.inputDigests,
    decision: entry.decision,
    previousHash: entry.previousHash,
  });
}

/**
 * Verify a contiguous run of entries.
 *
 * `entries` must be ordered by ascending `seq` and must start at the true
 * beginning of the chain unless `expectedFirstPreviousHash` is supplied — which
 * is how a caller verifies a window of a long chain without replaying all of
 * it.
 *
 * Every detectable break is reported rather than only the first, because an
 * operator responding to a verification failure needs the extent of the damage,
 * not just its starting point.
 */
/**
 * What the chain is known to have reached, from a source outside the entries.
 *
 * Passing it is what turns verification from "are these entries consistent"
 * into "are these the entries there were". Optional because the function is
 * deliberately storage-independent — an auditor verifying an exported archive
 * has entries and no database — but every caller that *has* a store must
 * supply it, or head truncation stays invisible.
 */
export interface ChainWatermark {
  readonly maxSeq: number;
  readonly headHash: string;
}

export function verifyChain(
  entries: readonly AuditEntry[],
  expectedFirstPreviousHash: string = GENESIS_PREVIOUS_HASH,
  watermark?: ChainWatermark | null,
): VerificationResult {
  const breaks: ChainBreak[] = [];

  // Before anything else, because a truncated chain is internally consistent
  // and every other check will pass on it. This is the cheapest tampering
  // there is and it was the one the verifier could not see.
  const highest = entries.length === 0 ? 0 : Math.max(...entries.map((entry) => entry.seq));
  if (watermark && highest < watermark.maxSeq) {
    breaks.push({
      kind: "chain_truncated",
      seq: highest,
      detail:
        entries.length === 0
          ? `The chain is empty, and it is recorded as having reached sequence ${watermark.maxSeq}. Every entry has been deleted.`
          : `The chain ends at sequence ${highest}, and it is recorded as having reached ${watermark.maxSeq}. ${watermark.maxSeq - highest} entr${watermark.maxSeq - highest === 1 ? "y has" : "ies have"} been deleted from the end.`,
    });
  }

  if (entries.length === 0) {
    return {
      // An empty chain is intact only when nothing says it should not be.
      intact: breaks.length === 0,
      entriesChecked: 0,
      firstSeq: null,
      lastSeq: null,
      headHash: null,
      breaks,
    };
  }

  let previousHash = expectedFirstPreviousHash;
  let previousSeq: number | null = null;
  let previousRecordedAt: string | null = null;

  for (const entry of entries) {
    // Sequence continuity. A gap means an entry was removed; a duplicate means
    // two writers raced or an entry was replayed.
    if (previousSeq !== null) {
      if (entry.seq === previousSeq) {
        breaks.push({
          kind: "sequence_duplicate",
          seq: entry.seq,
          entryId: entry.id,
          detail: `Sequence ${entry.seq} appears more than once.`,
        });
      } else if (entry.seq !== previousSeq + 1) {
        breaks.push({
          kind: "sequence_gap",
          seq: entry.seq,
          entryId: entry.id,
          detail: `Expected sequence ${previousSeq + 1} but found ${entry.seq}; ${entry.seq - previousSeq - 1} entr${entry.seq - previousSeq - 1 === 1 ? "y is" : "ies are"} missing.`,
        });
      }
    }

    // Linkage. This is the property that makes a silent edit impossible.
    if (entry.previousHash !== previousHash) {
      breaks.push({
        kind: previousSeq === null ? "genesis_mismatch" : "previous_hash_mismatch",
        seq: entry.seq,
        entryId: entry.id,
        detail:
          previousSeq === null
            ? `First entry should link to ${expectedFirstPreviousHash} but links to ${entry.previousHash}.`
            : `Entry ${entry.seq} should link to ${previousHash} but links to ${entry.previousHash}.`,
      });
    }

    // Content integrity. Recomputed from the entry's own fields, so any
    // alteration of any covered field is caught here.
    const recomputed = computeEntryHash(entry);
    if (recomputed !== entry.entryHash) {
      breaks.push({
        kind: "hash_mismatch",
        seq: entry.seq,
        entryId: entry.id,
        detail: `Entry ${entry.seq} content does not match its recorded hash. It has been altered since it was written.`,
      });
    }

    // Time monotonicity. Not a cryptographic property, but a back-dated entry
    // in an append-only log is worth surfacing even when the hashes line up —
    // it usually means a clock problem, occasionally something worse.
    if (previousRecordedAt !== null && entry.recordedAt < previousRecordedAt) {
      breaks.push({
        kind: "timestamp_regression",
        seq: entry.seq,
        entryId: entry.id,
        detail: `Entry ${entry.seq} is timestamped ${entry.recordedAt}, earlier than the entry before it (${previousRecordedAt}).`,
      });
    }

    // Chain forward using the entry's *recorded* hash, not the recomputed one.
    // Using the recomputed hash would repair a broken chain as it walked it and
    // report a single break where there are many.
    previousHash = entry.entryHash;
    previousSeq = entry.seq;
    previousRecordedAt = entry.recordedAt;
  }

  const first = entries[0];
  const last = entries[entries.length - 1];

  return {
    intact: breaks.length === 0,
    entriesChecked: entries.length,
    firstSeq: first ? first.seq : null,
    lastSeq: last ? last.seq : null,
    headHash: last ? last.entryHash : null,
    breaks,
  };
}

/** Render a verification result as operator-readable text. */
export function formatVerificationResult(result: VerificationResult): string {
  if (result.entriesChecked === 0) {
    return "Audit chain is empty. Nothing to verify.";
  }
  if (result.intact) {
    return [
      `Audit chain INTACT.`,
      `  entries checked : ${result.entriesChecked}`,
      `  sequence range  : ${result.firstSeq}..${result.lastSeq}`,
      `  head hash       : ${result.headHash}`,
    ].join("\n");
  }
  const lines = [
    `Audit chain BROKEN — ${result.breaks.length} problem${result.breaks.length === 1 ? "" : "s"} found.`,
    `  entries checked : ${result.entriesChecked}`,
    `  sequence range  : ${result.firstSeq}..${result.lastSeq}`,
    "",
  ];
  for (const problem of result.breaks) {
    lines.push(`  [${problem.kind}] seq ${problem.seq}: ${problem.detail}`);
  }
  return lines.join("\n");
}
