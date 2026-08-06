import { describe, it, expect } from "vitest";
import { FixedClock, MINUTE } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { digestValue } from "../kernel/hash.js";
import { MemoryDb } from "../store/db.js";
import { MemoryAuditStore } from "./store.memory.js";
import { AuditLog } from "./log.js";
import {
  verifyChain,
  computeEntryHash,
  formatVerificationResult,
  GENESIS_PREVIOUS_HASH,
} from "./chain.js";
import type { AuditEntry } from "./types.js";

/**
 * Tamper-detection tests.
 *
 * The audit chain is the product's evidentiary claim: "we automate with a
 * record that survives an audit." That claim is only worth something if
 * altering, removing, or back-dating an entry is detectable after the fact.
 * These tests are the evidence for it, and they are written from the attacker's
 * side — each one performs the edit an insider would actually attempt and
 * asserts that verification catches it.
 *
 * The most important test in this file is the one where the attacker is
 * competent: they alter an entry AND recompute its hash so the entry is
 * internally consistent. That is where a naive per-entry checksum would pass
 * and where chaining earns its place.
 */

const START = "2026-08-06T12:00:00.000Z";

async function buildChain(length: number): Promise<AuditEntry[]> {
  const clock = new FixedClock(START);
  const ids = new SeededIdGenerator("chain-test");
  const log = new AuditLog(new MemoryAuditStore(new MemoryDb()), clock, ids);

  for (let i = 0; i < length; i += 1) {
    await log.record({
      eventType: "authorization.granted",
      actor: { actorId: `agent-${i}`, kind: "human", roles: ["owner_services_agent"] },
      subject: { contractId: `ctr_${i}` },
      inputDigests: { proposal: digestValue({ index: i }) },
      decision: { risk: "sensitive", amount: i * 100 },
    });
    clock.advance(MINUTE);
  }

  return [...(await log.readChain())];
}

/** Re-seal an entry so it is internally consistent, as a competent attacker would. */
function reseal(entry: AuditEntry): AuditEntry {
  return { ...entry, entryHash: computeEntryHash(entry) };
}

describe("verifyChain", () => {
  it("accepts an untouched chain", async () => {
    const chain = await buildChain(6);
    const result = verifyChain(chain);
    expect(result.intact).toBe(true);
    expect(result.entriesChecked).toBe(6);
    expect(result.firstSeq).toBe(1);
    expect(result.lastSeq).toBe(6);
    expect(result.breaks).toEqual([]);
  });

  it("accepts an empty chain rather than reporting a break", async () => {
    const result = verifyChain([]);
    expect(result.intact).toBe(true);
    expect(result.entriesChecked).toBe(0);
    expect(result.headHash).toBeNull();
  });

  it("detects an altered decision", async () => {
    const chain = await buildChain(5);
    const target = chain[2];
    if (!target) throw new Error("fixture");
    // The classic edit: change what was decided, leave everything else.
    chain[2] = { ...target, decision: { ...target.decision, amount: 999_999 } };

    const result = verifyChain(chain);
    expect(result.intact).toBe(false);
    expect(result.breaks.some((b) => b.kind === "hash_mismatch" && b.seq === 3)).toBe(true);
  });

  it("detects an altered actor, which is how attribution would be shifted", async () => {
    const chain = await buildChain(4);
    const target = chain[1];
    if (!target) throw new Error("fixture");
    chain[1] = {
      ...target,
      actor: { actorId: "someone-else", kind: "human", roles: ["supervisor"] },
    };

    expect(verifyChain(chain).breaks.some((b) => b.kind === "hash_mismatch")).toBe(true);
  });

  it("detects an altered input digest, which is how a decision's basis would be rewritten", async () => {
    const chain = await buildChain(4);
    const target = chain[2];
    if (!target) throw new Error("fixture");
    chain[2] = { ...target, inputDigests: { proposal: digestValue({ index: "different" }) } };

    expect(verifyChain(chain).breaks.some((b) => b.kind === "hash_mismatch")).toBe(true);
  });

  it("detects a changed timestamp", async () => {
    const chain = await buildChain(4);
    const target = chain[2];
    if (!target) throw new Error("fixture");
    chain[2] = { ...target, recordedAt: "2020-01-01T00:00:00.000Z" };

    const result = verifyChain(chain);
    expect(result.breaks.some((b) => b.kind === "hash_mismatch")).toBe(true);
  });

  it("detects a deletion as a sequence gap and a broken link", async () => {
    const chain = await buildChain(6);
    chain.splice(3, 1); // remove seq 4

    const result = verifyChain(chain);
    expect(result.intact).toBe(false);
    expect(result.breaks.some((b) => b.kind === "sequence_gap")).toBe(true);
    expect(result.breaks.some((b) => b.kind === "previous_hash_mismatch")).toBe(true);
  });

  it("names how many entries are missing", async () => {
    const chain = await buildChain(8);
    chain.splice(2, 3); // remove seq 3, 4, 5

    const gap = verifyChain(chain).breaks.find((b) => b.kind === "sequence_gap");
    expect(gap?.detail).toMatch(/3 entries are missing/);
  });

  it("detects a duplicated entry", async () => {
    const chain = await buildChain(4);
    const duplicate = chain[1];
    if (!duplicate) throw new Error("fixture");
    chain.splice(2, 0, duplicate);

    expect(verifyChain(chain).breaks.some((b) => b.kind === "sequence_duplicate")).toBe(true);
  });

  it("detects a forged genesis", async () => {
    const chain = await buildChain(3);
    const first = chain[0];
    if (!first) throw new Error("fixture");
    // Blanking previousHash is why the genesis constant is a recognisable value
    // rather than an empty string: an emptied link cannot pass as legitimate.
    chain[0] = reseal({ ...first, previousHash: "" });

    const result = verifyChain(chain);
    expect(result.breaks.some((b) => b.kind === "genesis_mismatch")).toBe(true);
  });

  it("detects a chain that was re-linked around a removed entry", async () => {
    const chain = await buildChain(5);
    const third = chain[2];
    const fourth = chain[3];
    if (!third || !fourth) throw new Error("fixture");

    // Remove entry 3 and re-point entry 4 at entry 2, renumbering so there is
    // no gap. This is the careful version of a deletion.
    const second = chain[1];
    if (!second) throw new Error("fixture");
    chain.splice(2, 1);
    chain[2] = reseal({ ...fourth, seq: 3, previousHash: second.entryHash });

    const result = verifyChain(chain);
    // Entry 4's own hash now verifies, but entry 5 still links to the hash the
    // old entry 4 had, so the break surfaces one position later. That is the
    // property that makes selective deletion impractical: repairing one link
    // breaks the next.
    expect(result.intact).toBe(false);
    expect(result.breaks.length).toBeGreaterThan(0);
  });

  it("catches a competent attacker who re-seals the entry they altered", async () => {
    // This is the test that justifies chaining over per-entry checksums. The
    // attacker changes the content AND recomputes the hash, so the entry is
    // internally consistent and a naive integrity check would pass.
    const chain = await buildChain(6);
    const target = chain[2];
    if (!target) throw new Error("fixture");
    chain[2] = reseal({ ...target, decision: { risk: "routine", amount: 0 } });

    const result = verifyChain(chain);
    expect(result.intact).toBe(false);

    // The altered entry itself now passes its own hash check...
    expect(result.breaks.some((b) => b.kind === "hash_mismatch" && b.seq === 3)).toBe(false);
    // ...but the entry after it still records the old hash, so the link breaks.
    expect(result.breaks.some((b) => b.kind === "previous_hash_mismatch" && b.seq === 4)).toBe(
      true,
    );
  });

  it("reports every break, not only the first", async () => {
    const chain = await buildChain(8);
    const second = chain[1];
    const fifth = chain[4];
    if (!second || !fifth) throw new Error("fixture");
    chain[1] = { ...second, decision: { amount: 1 } };
    chain[4] = { ...fifth, decision: { amount: 2 } };

    const result = verifyChain(chain);
    const mismatches = result.breaks.filter((b) => b.kind === "hash_mismatch");
    // An operator responding to a verification failure needs the extent of the
    // damage, not just where it starts.
    expect(mismatches.length).toBeGreaterThanOrEqual(2);
  });

  it("does not silently repair the chain as it walks it", async () => {
    // Chaining forward from the recorded hash rather than the recomputed one is
    // what makes a run of altered entries report as a run rather than as one.
    const chain = await buildChain(6);
    for (const index of [1, 2, 3]) {
      const entry = chain[index];
      if (!entry) throw new Error("fixture");
      chain[index] = { ...entry, decision: { amount: index } };
    }
    const result = verifyChain(chain);
    expect(result.breaks.filter((b) => b.kind === "hash_mismatch").length).toBe(3);
  });

  it("detects a back-dated entry even when the hashes are consistent", async () => {
    const chain = await buildChain(5);
    const target = chain[3];
    if (!target) throw new Error("fixture");
    // Re-sealed, so hashing passes. Time order is the only thing that betrays it.
    chain[3] = reseal({ ...target, recordedAt: "2026-08-06T11:00:00.000Z" });

    const result = verifyChain(chain);
    expect(result.breaks.some((b) => b.kind === "timestamp_regression")).toBe(true);
  });

  it("verifies a window of a long chain against an explicit anchor", async () => {
    // This is what makes retention pruning possible: the live chain verifies
    // against a recorded anchor rather than requiring every entry ever written.
    const chain = await buildChain(10);
    const window = chain.slice(4);
    const anchor = chain[3];
    if (!anchor) throw new Error("fixture");

    expect(verifyChain(window, anchor.entryHash).intact).toBe(true);
    // Without the anchor, the window looks like a forged genesis.
    expect(verifyChain(window).intact).toBe(false);
  });

  it("rejects a window presented against the wrong anchor", async () => {
    const chain = await buildChain(10);
    const window = chain.slice(4);
    expect(verifyChain(window, GENESIS_PREVIOUS_HASH).intact).toBe(false);
  });

  it("reports the head hash so it can be anchored externally", async () => {
    const chain = await buildChain(4);
    const result = verifyChain(chain);
    expect(result.headHash).toBe(chain[3]?.entryHash);
  });
});

describe("computeEntryHash", () => {
  it("is stable for the same content", async () => {
    const chain = await buildChain(1);
    const entry = chain[0];
    if (!entry) throw new Error("fixture");
    expect(computeEntryHash(entry)).toBe(computeEntryHash({ ...entry }));
  });

  it("ignores the entry id, which carries no assertion about what happened", async () => {
    const chain = await buildChain(1);
    const entry = chain[0];
    if (!entry) throw new Error("fixture");
    // Re-exporting an entry with a fresh id must not make it look like a
    // different event.
    expect(computeEntryHash({ ...entry, id: "aud_reexported" } as AuditEntry)).toBe(
      entry.entryHash,
    );
  });

  it("changes when any covered field changes", async () => {
    const chain = await buildChain(1);
    const entry = chain[0];
    if (!entry) throw new Error("fixture");
    const original = computeEntryHash(entry);

    expect(computeEntryHash({ ...entry, seq: 99 })).not.toBe(original);
    expect(computeEntryHash({ ...entry, eventType: "approval.granted" })).not.toBe(original);
    expect(computeEntryHash({ ...entry, previousHash: "sha256:other" })).not.toBe(original);
    expect(computeEntryHash({ ...entry, subject: { contractId: "different" } })).not.toBe(original);
  });

  it("is insensitive to key order in structured fields", async () => {
    const chain = await buildChain(1);
    const entry = chain[0];
    if (!entry) throw new Error("fixture");
    const reordered = {
      ...entry,
      decision: Object.fromEntries(Object.entries(entry.decision).reverse()),
    } as AuditEntry;
    expect(computeEntryHash(reordered)).toBe(entry.entryHash);
  });
});

describe("formatVerificationResult", () => {
  it("says plainly that an intact chain is intact", async () => {
    const output = formatVerificationResult(verifyChain(await buildChain(3)));
    expect(output).toMatch(/INTACT/);
    expect(output).toMatch(/entries checked : 3/);
  });

  it("says plainly that a broken chain is broken, and lists each problem", async () => {
    const chain = await buildChain(4);
    const target = chain[1];
    if (!target) throw new Error("fixture");
    chain[1] = { ...target, decision: { amount: 1 } };

    const output = formatVerificationResult(verifyChain(chain));
    expect(output).toMatch(/BROKEN/);
    expect(output).toMatch(/hash_mismatch/);
  });

  it("says an empty chain is empty rather than claiming it is verified", async () => {
    expect(formatVerificationResult(verifyChain([]))).toMatch(/empty/i);
  });
});
