import { describe, it, expect } from "vitest";
import { runDemo } from "./run.js";
import { SEED_CONTRACTS, SEED_CORPORA, SEED_DOCUMENTS, SYNTHETIC_MARKER } from "./corpus.js";

/**
 * Demonstration tests.
 *
 * CI also runs the demo twice from a cold start and diffs the output, which is
 * the stronger check. These tests cover what a diff cannot: that the demo is
 * still demonstrating the right things. A demo that runs deterministically but
 * has quietly stopped exercising the refusal path would pass the diff and be
 * worthless.
 */

/** Collect the demo's output instead of printing it. */
function capture() {
  const lines: string[] = [];
  const push = (text = ""): void => {
    lines.push(text);
  };
  return {
    lines,
    out: { line: push, heading: push, step: push },
  };
}

describe("seeded demonstration", () => {
  it("produces identical output on two runs in the same process", async () => {
    const first = capture();
    const second = capture();
    await runDemo(first.out);
    await runDemo(second.out);
    expect(first.lines.join("\n")).toBe(second.lines.join("\n"));
  });

  it("returns a stable summary", async () => {
    const a = await runDemo(capture().out);
    const b = await runDemo(capture().out);
    expect(a).toEqual(b);
  });

  it("ends with an intact audit chain", async () => {
    const result = await runDemo(capture().out);
    expect(result.chainIntact).toBe(true);
    expect(result.auditEntries).toBeGreaterThan(0);
  });

  it("still demonstrates refusal, not only success", async () => {
    // The point of the demonstration. If this ever reaches zero, someone has
    // made the demo "cleaner" and removed the most important thing in it.
    const result = await runDemo(capture().out);
    expect(result.refusals).toBe(2);
    expect(result.deadlinesComputed).toBeGreaterThan(0);
  });

  it("shows every governance control it claims to", async () => {
    const captured = capture();
    await runDemo(captured.out);
    const text = captured.lines.join("\n");

    // Each of these is a distinct guarantee, and each is a line the audience is
    // meant to see. Asserting on them keeps the narrative honest.
    expect(text).toMatch(/REFUSED \(screen\.injection_detected\)/);
    expect(text).toMatch(/REFUSED \(approval\.self_approval\)/);
    expect(text).toMatch(/REFUSED \(approval\.digest_mismatch\)/);
    expect(text).toMatch(/REFUSED \(approval\.already_used\)/);
    expect(text).toMatch(/REFUSED \(containment\.global_pause\)/);
    expect(text).toMatch(/REFUSED \(knowledge\.no_grounding\)/);
    expect(text).toMatch(/Audit chain INTACT/);
  });

  it("answers the same question differently for 2024 and 2026, with citations", async () => {
    // The effective-dating gate. A system that returns today's rule for a 2024
    // contract cannot answer "was this compliant when it was signed", which is
    // the only version of the question that matters once someone disputes it.
    const captured = capture();
    await runDemo(captured.out);
    const text = captured.lines.join("\n");

    expect(text).toMatch(/version 2025\.1, in force from 2025-07-01/);
    expect(text).toMatch(/version 2019\.1, in force from 2019-01-01 to 2025-06-30/);
  });

  it("never claims a placeholder rule is verified", async () => {
    const captured = capture();
    await runDemo(captured.out);
    const text = captured.lines.join("\n");
    expect(text).toMatch(/must be confirmed by counsel/);
    expect(text).not.toMatch(/verified: yes/);
  });

  it("cites the earnings source rather than asserting the figures", async () => {
    const captured = capture();
    await runDemo(captured.out);
    const text = captured.lines.join("\n");
    expect(text).toMatch(/Form 8-K filed 2026-08-06/);
  });
});

describe("seed data", () => {
  it("marks every document as synthetic", () => {
    for (const document of SEED_DOCUMENTS) {
      expect(document.title).toContain(SYNTHETIC_MARKER);
      expect(document.body).toMatch(/SYNTHETIC/);
    }
  });

  it("never presents synthetic text as real authority", () => {
    for (const document of SEED_DOCUMENTS) {
      expect(document.body).toMatch(/not (law|a real)/i);
      // Demonstration sources must be unmistakably not a real citation.
      expect(document.sourceUri.startsWith("synthetic://")).toBe(true);
    }
  });

  it("includes a superseded and a current version of the same rule", () => {
    const florida = SEED_DOCUMENTS.filter((d) => d.jurisdiction === "US-FL");
    expect(florida.some((d) => d.effectiveTo !== undefined)).toBe(true);
    expect(florida.some((d) => d.effectiveTo === undefined)).toBe(true);
  });

  it("includes contracts that must be refused", () => {
    expect(SEED_CONTRACTS.some((c) => c.disclosureDeliveredAt === undefined)).toBe(true);
    expect(SEED_CONTRACTS.some((c) => c.state === "XX")).toBe(true);
  });

  it("gives every corpus an owner and a review cadence", () => {
    for (const corpus of SEED_CORPORA) {
      expect(corpus.owner.length).toBeGreaterThan(0);
      expect(corpus.reviewCadenceDays).toBeGreaterThan(0);
      // Machine names, because the knowledge layer requires them.
      expect(corpus.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
