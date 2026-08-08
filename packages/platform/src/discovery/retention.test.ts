import { describe, it, expect } from "vitest";
import { loadConfig } from "../kernel/config.js";
import { DeniedError } from "../kernel/errors.js";
import {
  MAX_RETENTION_DAYS,
  assertRetentionWithinCeiling,
  discoverySettings,
  effectiveRetentionDays,
} from "./retention.js";

/**
 * The retention ceiling, split across the two surfaces that enforce it.
 *
 * This file exists because R-06 caught the module's own doc-comment claiming a
 * startup refusal the wiring never performed: `PV_DISCOVERY_RETENTION_DAYS=9999`
 * started clean and was silently clamped to thirty. The comment now states the
 * truth — enrollment refuses, startup clamps — and these tests pin each half so
 * neither can drift back into a lie without a red build. The substantive
 * promise MVW is given in writing is that no observation is ever kept past the
 * ceiling; that is the last group, and it is the one that must never regress.
 */

describe("retention ceiling — the enrollment guard refuses", () => {
  it("refuses a configured value over the ceiling", () => {
    // The true half of the doc comment: the enrollment path calls this, and a
    // request for more than the ceiling is told no rather than trimmed.
    expect(() =>
      assertRetentionWithinCeiling(MAX_RETENTION_DAYS + 1, "PV_DISCOVERY_RETENTION_DAYS"),
    ).toThrowError(DeniedError);
    expect(() => assertRetentionWithinCeiling(9999)).toThrowError(/exceeds the .* ceiling/);
  });

  it("refuses a value that is not a whole number of days, or below the floor", () => {
    expect(() => assertRetentionWithinCeiling(0)).toThrowError(DeniedError);
    expect(() => assertRetentionWithinCeiling(1.5)).toThrowError(DeniedError);
  });

  it("accepts the ceiling itself and anything under it", () => {
    expect(() => assertRetentionWithinCeiling(MAX_RETENTION_DAYS)).not.toThrow();
    expect(() => assertRetentionWithinCeiling(1)).not.toThrow();
  });

  it("is what `discoverySettings` uses to refuse an over-long configured value", () => {
    expect(() =>
      discoverySettings({ discoveryEnabled: true, discoveryRetentionDays: MAX_RETENTION_DAYS + 1 }),
    ).toThrowError(DeniedError);
    const settings = discoverySettings({ discoveryEnabled: false, discoveryRetentionDays: 7 });
    expect(settings.retentionDays).toBe(7);
  });
});

describe("retention ceiling — startup clamps rather than refuses", () => {
  // The gap the finding named: nothing wired `assertRetentionWithinCeiling`
  // into process startup, so an over-ceiling `PV_DISCOVERY_RETENTION_DAYS` was
  // accepted and clamped. That is the composition root's deliberate choice —
  // an over-ceiling value must shorten the purge, never disable it or fail the
  // boot — and the tests below pin the behaviour the comment now describes, so
  // the comment cannot quietly diverge from the wiring a second time.

  it("loadConfig accepts an over-ceiling PV_DISCOVERY_RETENTION_DAYS without refusing", () => {
    const config = loadConfig({
      PV_ENV: "development",
      PV_STORE: "memory",
      PV_DISCOVERY_RETENTION_DAYS: "9999",
    });
    // Startup does not refuse: the raw configured value survives loadConfig.
    expect(config.discoveryRetentionDays).toBe(9999);
  });

  it("the collector's effective period is clamped to the ceiling, not the configured value", () => {
    // This is exactly platform.ts's computation — `effectiveRetentionDays` over
    // the configured value — which is what the collector is handed.
    const config = loadConfig({
      PV_ENV: "development",
      PV_STORE: "memory",
      PV_DISCOVERY_RETENTION_DAYS: "9999",
    });
    expect(effectiveRetentionDays(config.discoveryRetentionDays)).toBe(MAX_RETENTION_DAYS);
  });
});

describe("retention ceiling — the promise that must never regress", () => {
  it("no configured value, however large, yields an effective period past the ceiling", () => {
    for (const days of [MAX_RETENTION_DAYS + 1, 90, 365, 3650, 9999, Number.MAX_SAFE_INTEGER]) {
      expect(effectiveRetentionDays(days)).toBeLessThanOrEqual(MAX_RETENTION_DAYS);
    }
  });

  it("clamps a nonsense stored value up to the floor rather than skipping the purge", () => {
    // A stored row from a migration, restore, or psql prompt must still purge:
    // the clamp never throws, so bad data shortens retention instead of
    // disabling deletion entirely.
    expect(effectiveRetentionDays(Number.NaN)).toBe(1);
    expect(effectiveRetentionDays(-5)).toBe(1);
    expect(effectiveRetentionDays(0)).toBe(1);
  });
});
