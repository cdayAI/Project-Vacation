import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixedClock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { containsSecret, redactText, redactValue } from "../kernel/redact.js";
import { ENV_KEYS } from "../kernel/config.js";
import { AuditLog } from "../audit/log.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { verifyChain } from "../audit/chain.js";
import { MemoryDb } from "../store/db.js";
import type { ActorRef } from "../record/types.js";

/**
 * Pass 4, group three — card data, and what the platform promises to delete.
 *
 * ADR 0009 says the platform never accepts card data, and `kernel/redact.ts`
 * says primary account numbers are redacted anyway "so an operator who pastes
 * one into a free-text field does not silently drag the deployment into scope".
 * `audit/log.ts` goes further: it refuses an entry whose payload "contains
 * something that looks like a credential or a card number".
 *
 * Both guarantees are asserted here from the outside, on the shapes an operator
 * or an integration actually produces — including the one that is not a string.
 * The audit case is the sharper of the two, because the audit log is append-only
 * with a seven-year stated retention: a PAN that lands in the chain cannot be
 * removed without breaking the chain, which is the precise trap the retention
 * design exists to avoid.
 */

/** Luhn-valid test PANs. None is a real account number. */
const TEST_PANS = [
  "4111111111111111",
  "4111 1111 1111 1111",
  "4111-1111-1111-1111",
  "5555555555554444",
  "378282246310005",
  "3782 822463 10005",
  "6011111111111117",
  "4012888888881881",
] as const;

const ACTOR: ActorRef = {
  actorId: "act_support",
  kind: "human",
  roles: ["supervisor"],
};

function buildLog(): AuditLog {
  return new AuditLog(
    new MemoryAuditStore(new MemoryDb()),
    new FixedClock("2026-08-07T09:00:00.000Z"),
    new SeededIdGenerator("pass4-pci"),
  );
}

describe("primary account numbers in text", () => {
  it("redacts every shape a PAN is pasted in", () => {
    for (const pan of TEST_PANS) {
      expect(redactText(pan).text, pan).toBe("[redacted]");
      expect(redactText(`the owner read out ${pan} over the phone`).text, pan).not.toContain("4111");
      expect(containsSecret(pan), pan).toBe(true);
    }
  });

  it("leaves ordinary long numbers alone", () => {
    // Over-redaction has a cost too: a log line that redacts every order
    // number teaches operators to stop reading logs.
    for (const benign of ["1234567890123456", "20260807090000000", "1111111111111111"]) {
      expect(redactText(benign).text, benign).toBe(benign);
    }
  });

  it("redacts a PAN reached through a nested structure", () => {
    const redacted = redactValue({
      ticket: { body: "customer gave 4111111111111111", attachments: ["pan 4012888888881881"] },
    }) as { ticket: { body: string; attachments: string[] } };
    expect(redacted.ticket.body).not.toContain("4111");
    expect(redacted.ticket.attachments[0]).not.toContain("4012");
  });

  it("redacts a PAN that arrived as a number rather than a string", () => {
    // F-404. `redactValue` returned every number untouched. A sixteen-digit
    // PAN is below `Number.MAX_SAFE_INTEGER`, so any JSON body, integration
    // response, or support payload that carried one as a bare number went to
    // the log sink verbatim — and the key does not have to be named `pan` for
    // that to happen.
    const redacted = redactValue({
      supportNote: 4111111111111111,
      rows: [378282246310005],
    }) as { supportNote: unknown; rows: unknown[] };
    expect(String(redacted.supportNote)).not.toContain("4111111111111111");
    expect(String(redacted.rows[0])).not.toContain("378282246310005");
  });

  it("still logs numbers that are not card-shaped", () => {
    const redacted = redactValue({
      costUsd: 12.5,
      attempt: 3,
      epochMs: 1_775_000_000_000,
      count: 4111,
    }) as Record<string, unknown>;
    expect(redacted["costUsd"]).toBe(12.5);
    expect(redacted["attempt"]).toBe(3);
    expect(redacted["count"]).toBe(4111);
    // An epoch-millisecond reading is thirteen digits and must survive.
    expect(redacted["epochMs"]).toBe(1_775_000_000_000);
  });
});

describe("primary account numbers reaching the audit chain", () => {
  it("refuses a card number in a subject reference", async () => {
    const log = buildLog();
    await expect(
      log.record({
        eventType: "authorization.granted",
        actor: ACTOR,
        subject: { contractId: "ctr_1", cardOnFile: "4111111111111111" },
        inputDigests: { proposal: digestValue({ a: 1 }) },
        decision: { risk: "sensitive" },
      }),
    ).rejects.toThrow(DeniedError);
  });

  it("refuses a card number in a decision string", async () => {
    const log = buildLog();
    await expect(
      log.record({
        eventType: "authorization.granted",
        actor: ACTOR,
        subject: { contractId: "ctr_1" },
        inputDigests: { proposal: digestValue({ a: 1 }) },
        decision: { note: "refunded to 4111111111111111" },
      }),
    ).rejects.toThrow(DeniedError);
  });

  it("refuses a card number written into a decision as a number", async () => {
    // F-405. `AuditLog.record` runs `containsSecret` over string values only.
    // Numeric decision values are permitted by the type check and then written
    // straight into the hash-chained store.
    //
    // This is worse than the log-sink case in one specific way: the chain is
    // append-only and stated to be retained for seven years, and the retention
    // design's own rule is that entries are pruned as a contiguous prefix and
    // never edited. A PAN that lands in the middle of the chain therefore
    // cannot be removed at all without breaking verification — which is the
    // outcome `retention-and-deletion.md` §3 is written to prevent.
    const log = buildLog();
    await expect(
      log.record({
        eventType: "authorization.granted",
        actor: ACTOR,
        subject: { contractId: "ctr_1" },
        inputDigests: { proposal: digestValue({ a: 1 }) },
        decision: { paymentInstrument: 4111111111111111 },
      }),
    ).rejects.toThrow(DeniedError);
  });

  it("still accepts the ordinary numeric decision fields the platform records", async () => {
    const log = buildLog();
    const entry = await log.record({
      eventType: "authorization.granted",
      actor: ACTOR,
      subject: { contractId: "ctr_1" },
      inputDigests: { proposal: digestValue({ a: 1 }) },
      decision: {
        costUsd: 0.42,
        approvers: 2,
        backdatedMs: 1_775_000_000_000,
        checksPassed: 5,
      },
    });
    expect(entry.decision["approvers"]).toBe(2);
    const verification = verifyChain(await log.readChain());
    expect(verification.intact).toBe(true);
  });
});

describe("what the retention documentation promises", () => {
  const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
  const DOC = fileURLToPath(
    new URL("../../../../docs/assurance/retention-and-deletion.md", import.meta.url),
  );

  /** Every `.ts` file under `src/`, excluding tests and this review suite. */
  function productionSources(): readonly string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "review") walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
          files.push(readFileSync(full, "utf8"));
        }
      }
    };
    walk(SOURCE_ROOT);
    return files;
  }

  it("names a purge job that the source actually contains", () => {
    // F-406. `docs/assurance/retention-and-deletion.md` §2 states without
    // qualification that "`PurgeJob` runs daily", that it "records one
    // `retention.purged` audit entry per rule per run", and that three of its
    // properties "matter and are tested". None of it exists. §5 of the same
    // document lists what is *not* built and names only the archival job,
    // which reads as confirmation that the purge itself is.
    //
    // This is an assurance artifact — the document a privacy reviewer is
    // handed — so the gap is a false statement to a buyer rather than a stale
    // comment.
    const doc = readFileSync(DOC, "utf8");
    const sources = productionSources();
    if (doc.includes("PurgeJob")) {
      expect(
        sources.some((source) => source.includes("PurgeJob")),
        "retention-and-deletion.md describes PurgeJob; no source file defines it",
      ).toBe(true);
    }
  });

  it("emits the retention.purged audit event it declares", () => {
    // Declared at `audit/types.ts:75` and written by nothing, which is how the
    // documented "one entry per rule per run" record comes to have no
    // producer.
    const sources = productionSources().filter((source) => !source.includes("AuditEventType ="));
    expect(sources.some((source) => source.includes("retention.purged"))).toBe(true);
  });

  it("reads the retention period an operator can configure", () => {
    // `PV_AUDIT_RETENTION_DAYS` is loaded and documented in `.env.example`;
    // nothing consults `config.auditRetentionDays`. An operator who sets it
    // believes a retention period is being enforced.
    expect(Object.values(ENV_KEYS)).toContain("PV_AUDIT_RETENTION_DAYS");
    const sources = productionSources().filter((source) => !source.includes("ENV_KEYS"));
    expect(sources.some((source) => source.includes("auditRetentionDays"))).toBe(true);
  });
});
