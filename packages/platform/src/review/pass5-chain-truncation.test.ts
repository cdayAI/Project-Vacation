import { describe, it, expect } from "vitest";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { MemoryDb } from "../store/db.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { AuditLog, decision } from "../audit/log.js";
import { verifyChain } from "../audit/chain.js";
import type { AuditEntry } from "../audit/types.js";

/**
 * Pass 5 — what the chain verifier can and cannot see.
 *
 * The hash chain's promise is that history cannot be rewritten without the
 * verifier saying so. Two of the three ways to rewrite it are caught: altering
 * an entry breaks its own hash, and removing an entry from the middle breaks
 * both the sequence and the link of the entry after it. Both were confirmed
 * against a populated Postgres deployment as well as here.
 *
 * The third way is not caught. Deleting entries from the *head* — the newest
 * ones, which is what somebody erasing what they just did would delete — leaves
 * a shorter chain that is internally perfect: seq 1..n contiguous, every link
 * correct, every hash recomputing. `verifyChain` reports INTACT and
 * `pv audit verify` exits zero. Deleting the whole table is the same defect at
 * its limit: the verifier reports "empty, nothing to verify" and exits zero
 * while the operating record still holds the runs whose authorizations are gone.
 *
 * `verifyChain` itself is not the bug. It is deliberately storage-independent
 * so an auditor can verify an exported archive, and a function handed only the
 * surviving entries cannot know how many it was not handed. The gap is that no
 * caller supplies that knowledge: nothing anywhere persists how far the chain
 * had got, so nothing can notice that it has got shorter.
 *
 * These tests state the property the platform needs — verification detects a
 * truncated chain — at the level a caller could satisfy it.
 */

const NOW = "2026-08-06T12:00:00.000Z";

async function populatedChain(entries = 6) {
  const db = new MemoryDb();
  const store = new MemoryAuditStore(db);
  const audit = new AuditLog(store, new FixedClock(NOW), new SeededIdGenerator("pass5"));

  for (let index = 0; index < entries; index += 1) {
    await audit.record(
      decision({
        eventType: "authorization.granted",
        actorId: `ops:sam`,
        actorKind: "human",
        actorRoles: ["owner_services_agent"],
        subject: { contractId: `ctr_${index}` },
        decision: { action: "record.read_run", granted: true },
      }),
    );
  }

  return { db, store, audit };
}

/** Delete rows from the store the way a psql prompt would. */
function deleteEntries(db: MemoryDb, predicate: (seq: number) => boolean): void {
  const table = db.table<AuditEntry>("audit_entry");
  for (const [key, entry] of [...table]) {
    if (predicate(entry.seq)) table.delete(key);
  }
}

describe("audit chain verification on a populated system", () => {
  it("reports the first break and where when one entry is altered", async () => {
    const { db, store } = await populatedChain();

    // The tamper: change one field of one entry, leaving its recorded hash.
    const table = db.table<AuditEntry>("audit_entry");
    const target = table.get("3");
    if (!target) throw new Error("expected an entry at sequence 3");
    table.set("3", { ...target, decision: { ...target.decision, granted: false } });

    const result = verifyChain(await store.readAuditChain());

    expect(result.intact).toBe(false);
    expect(result.breaks[0]?.kind).toBe("hash_mismatch");
    expect(result.breaks[0]?.seq).toBe(3);
  });

  it("reports the gap and the broken link when an entry is removed from the middle", async () => {
    const { db, store } = await populatedChain();
    deleteEntries(db, (seq) => seq === 4);

    const result = verifyChain(await store.readAuditChain());

    expect(result.intact).toBe(false);
    expect(result.breaks.map((problem) => problem.kind)).toContain("sequence_gap");
    expect(result.breaks.map((problem) => problem.kind)).toContain("previous_hash_mismatch");
  });

  it("reports a break when the newest entries are deleted", async () => {
    const { db, store } = await populatedChain();

    const before = verifyChain(await store.readAuditChain());
    expect(before.intact).toBe(true);
    expect(before.lastSeq).toBe(6);

    // Erase the two most recent decisions. Nothing else is touched.
    deleteEntries(db, (seq) => seq >= 5);

    const after = verifyChain(await store.readAuditChain());

    // What the chain claims is that history cannot be silently removed. A run
    // of entries that stops two short of where it stopped before is history
    // silently removed, and saying "INTACT" about it is the log asserting
    // something it has not checked.
    expect(after.intact).toBe(false);
  });

  it("reports a break when the whole chain is deleted", async () => {
    const { db, store } = await populatedChain();
    deleteEntries(db, () => true);

    const result = verifyChain(await store.readAuditChain());

    // The complete erasure is the one the verifier is least able to see, and
    // the one that matters most: it is also the cheapest to perform.
    expect(result.intact).toBe(false);
  });
});
