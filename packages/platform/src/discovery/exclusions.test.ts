import { describe, it, expect } from "vitest";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import {
  APPLICATION_KEY_PATTERN,
  BLOCKED_APPLICATION_FAMILIES,
  FORBIDDEN_OBSERVATION_FIELDS,
  MAX_DWELL_MS,
  assertNotBlocked,
  assertObservationInput,
  assertObservationShape,
  blockedFamilyFor,
  isBlockedApplication,
} from "./exclusions.js";
import { OBSERVATION_INPUT_KEYS, OBSERVATION_KEYS } from "./types.js";

/**
 * The structural exclusions.
 *
 * These are the tests that have to fail if the boundary moves. Everything else
 * in this module is a control over data that was permitted to exist; this is
 * the control over what may exist at all, and if it quietly stops holding then
 * every promise made to MVW about employee observation stops being true while
 * the suite stays green.
 *
 * Three shapes of attack are covered deliberately:
 *
 *   - the *named* forbidden field, which is the obvious one;
 *   - the *unnamed* field nobody thought of, which is the one that actually
 *     happens, because a new capability arrives with a new field name;
 *   - the *padded permitted field*, where the window title is put somewhere the
 *     validator has already agreed to accept. That is the interesting one, and
 *     it is why the value shapes are constrained and not only the key set.
 */

const VALID_INPUT = {
  subjectRef: "sub_alpha",
  deviceRef: "dev_alpha",
  fromApplication: "ticketing",
  toApplication: "spreadsheet",
  observedAt: "2026-08-06T13:05:00.000Z",
  dwellMs: 45_000,
};

/** The denial reason a call produced, or a marker describing what it did instead. */
function reasonOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DeniedError) return error.reason;
    if (error instanceof InvalidInputError) return `invalid:${error.field}`;
    return `unexpected:${String(error)}`;
  }
  return "no-throw";
}

describe("observation key set", () => {
  /**
   * Pinned to a literal list rather than derived from the type.
   *
   * Deriving it would make the test vacuous: adding a field would add it to
   * both sides. Adding a field to `Observation` fails to compile until it is
   * also added to the coverage map in types.ts, and then fails here until
   * somebody edits this list — which is a diff a reviewer sees, in a file
   * called exclusions, next to the reasons.
   */
  it("is exactly the nine permitted fields", () => {
    expect(OBSERVATION_KEYS).toEqual([
      "deviceRef",
      "dwellMs",
      "fromApplication",
      "id",
      "observedAt",
      "sequence",
      "sessionId",
      "subjectRef",
      "toApplication",
    ]);
  });

  it("accepts exactly six fields from a collector", () => {
    expect(OBSERVATION_INPUT_KEYS).toEqual([
      "deviceRef",
      "dwellMs",
      "fromApplication",
      "observedAt",
      "subjectRef",
      "toApplication",
    ]);
  });

  it("admits a legitimate transition", () => {
    expect(() => assertObservationInput({ ...VALID_INPUT })).not.toThrow();
  });
});

describe("forbidden fields", () => {
  it("refuses every named excluded field", () => {
    // The enumeration is the point. If somebody deletes an entry from the list,
    // this loop shrinks silently — so the count is asserted too.
    expect(FORBIDDEN_OBSERVATION_FIELDS.length).toBeGreaterThanOrEqual(40);

    const admitted: string[] = [];
    for (const field of FORBIDDEN_OBSERVATION_FIELDS) {
      const reason = reasonOf(() =>
        assertObservationInput({ ...VALID_INPUT, [field]: "anything at all" }),
      );
      if (reason !== "discovery.excluded_field") admitted.push(`${field} -> ${reason}`);
    }

    expect(
      admitted,
      `These excluded fields were not refused. Work discovery must never be able to carry them: ${admitted.join(", ")}`,
    ).toEqual([]);
  });

  it("names the promise being broken", () => {
    let message = "";
    try {
      assertObservationInput({ ...VALID_INPUT, screenshot: "iVBORw0KGgo=" });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("structurally excluded");
  });

  /**
   * The field nobody has thought of yet.
   *
   * A denylist alone would let this through, which is why the check is an
   * allowlist of keys and the named list exists only to improve the message.
   */
  it("refuses an unrecognised field that is on no list", () => {
    expect(reasonOf(() => assertObservationInput({ ...VALID_INPUT, biometricStress: 3 }))).toBe(
      "discovery.excluded_field",
    );
  });

  it("refuses a nested value under a permitted key", () => {
    expect(
      reasonOf(() =>
        assertObservationInput({ ...VALID_INPUT, dwellMs: { ms: 1, title: "Inbox — Outlook" } }),
      ),
    ).toBe("discovery.excluded_field");
  });

  it("refuses something that is not an object at all", () => {
    expect(reasonOf(() => assertObservationInput(["ticketing", "spreadsheet"]))).toBe(
      "invalid:observation",
    );
    expect(reasonOf(() => assertObservationInput("ticketing"))).toBe("invalid:observation");
    expect(reasonOf(() => assertObservationInput(null))).toBe("invalid:observation");
  });
});

describe("padding a permitted field", () => {
  /**
   * The realistic attack, and an easy accident.
   *
   * A collector author who cannot send `windowTitle` will reach for the nearest
   * permitted string. Both application fields and both references are therefore
   * constrained to shapes that cannot hold a sentence, a path, or a URL.
   */
  it("refuses a window title in an application field", () => {
    expect(
      reasonOf(() =>
        assertObservationInput({ ...VALID_INPUT, toApplication: "Inbox — Outlook — Jane Doe" }),
      ),
    ).toBe("discovery.excluded_field");
  });

  it("refuses a URL with a query string in an application field", () => {
    expect(
      reasonOf(() =>
        assertObservationInput({
          ...VALID_INPUT,
          fromApplication: "https://crm.example.com/contract?id=88121",
        }),
      ),
    ).toBe("discovery.excluded_field");
  });

  it("refuses a file path in an application field", () => {
    expect(
      reasonOf(() =>
        assertObservationInput({ ...VALID_INPUT, toApplication: "/home/jane/rescission.docx" }),
      ),
    ).toBe("discovery.excluded_field");
  });

  it("refuses free text in a reference field", () => {
    expect(
      reasonOf(() =>
        assertObservationInput({
          ...VALID_INPUT,
          subjectRef: "Jane Doe called the owner about contract 88121 and agreed a refund",
        }),
      ),
    ).toBe("discovery.excluded_field");
  });

  it("does not echo the value it refused", () => {
    let message = "";
    try {
      assertObservationInput({ ...VALID_INPUT, toApplication: "Inbox — Outlook — Jane Doe" });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    // Refusing a value and then writing it into a log is not refusing it.
    expect(message).not.toContain("Jane Doe");
    expect(message).toContain("chars");
  });

  it("bounds the dwell so an integer cannot become a channel", () => {
    expect(reasonOf(() => assertObservationInput({ ...VALID_INPUT, dwellMs: -1 }))).toBe(
      "invalid:dwellMs",
    );
    expect(reasonOf(() => assertObservationInput({ ...VALID_INPUT, dwellMs: 1.5 }))).toBe(
      "invalid:dwellMs",
    );
    expect(
      reasonOf(() => assertObservationInput({ ...VALID_INPUT, dwellMs: MAX_DWELL_MS + 1 })),
    ).toBe("invalid:dwellMs");
    expect(() => assertObservationInput({ ...VALID_INPUT, dwellMs: MAX_DWELL_MS })).not.toThrow();
  });

  it("insists on the platform's one timestamp form", () => {
    expect(
      reasonOf(() => assertObservationInput({ ...VALID_INPUT, observedAt: "2026-08-06 13:05:00" })),
    ).toBe("invalid:observedAt");
  });

  it("requires every permitted field to be present", () => {
    const { dwellMs: _dropped, ...missing } = VALID_INPUT;
    expect(reasonOf(() => assertObservationInput(missing))).toBe("invalid:dwellMs");
  });
});

describe("stored observation shape", () => {
  const STORED = {
    ...VALID_INPUT,
    id: "obs_alpha",
    sessionId: "ses_alpha",
    sequence: 1,
  };

  it("admits a well-formed stored row", () => {
    expect(() => assertObservationShape({ ...STORED })).not.toThrow();
  });

  it("refuses an excluded field on the way into the store", () => {
    // A module that builds an Observation by hand and goes straight to the
    // store meets the same refusal the collector would have given it.
    expect(reasonOf(() => assertObservationShape({ ...STORED, clipboard: "4111 1111" }))).toBe(
      "discovery.excluded_field",
    );
  });

  it("refuses a row with no position in its session", () => {
    const { sequence: _dropped, ...missing } = STORED;
    expect(reasonOf(() => assertObservationShape(missing))).toBe("invalid:sequence");
  });
});

describe("the blocklist floor", () => {
  it("covers communication tools and systems of record", () => {
    for (const entry of BLOCKED_APPLICATION_FAMILIES) {
      expect(isBlockedApplication(entry.family), `${entry.family} should be blocked`).toBe(true);
      expect(
        isBlockedApplication(`${entry.family}.vendor_product`),
        `${entry.family}.vendor_product should be blocked by namespace`,
      ).toBe(true);
    }
  });

  it("blocks the categories the module promises to block", () => {
    // Named explicitly rather than derived, so removing a family from the floor
    // is a red test rather than a smaller loop.
    for (const family of [
      "email",
      "chat",
      "meeting",
      "telephony",
      "sms",
      "browser",
      "owner_record",
      "contract_record",
      "hr",
      "payroll",
      "medical",
      "ledger",
      "banking",
      "payments",
      "vault",
      "union",
    ]) {
      expect(isBlockedApplication(family), `${family} must be on the floor`).toBe(true);
    }
  });

  it("does not block ordinary process tools", () => {
    for (const application of ["ticketing", "spreadsheet", "document_generator", "console"]) {
      expect(isBlockedApplication(application)).toBe(false);
    }
  });

  it("does not block a name that merely starts with a blocked family's letters", () => {
    // `hr` blocks `hr` and `hr.workday`, not `hrefs_console`. A prefix match
    // without the separator would quietly block unrelated applications and,
    // worse, would make the floor look bigger than it is.
    expect(isBlockedApplication("hrefs_console")).toBe(false);
    expect(isBlockedApplication("emailer_admin")).toBe(false);
  });

  it("explains itself when it refuses", () => {
    const family = blockedFamilyFor("email.exchange");
    expect(family?.family).toBe("email");
    expect(family?.reason).toContain("Message bodies");
    expect(reasonOf(() => assertNotBlocked("email.exchange"))).toBe("discovery.excluded_field");
  });

  it("cannot be extended or emptied at runtime", () => {
    // Frozen top-level array and frozen entries. A module that could push onto
    // this could unblock the HR system from anywhere in the process.
    expect(Object.isFrozen(BLOCKED_APPLICATION_FAMILIES)).toBe(true);
    for (const entry of BLOCKED_APPLICATION_FAMILIES) expect(Object.isFrozen(entry)).toBe(true);

    const mutable = BLOCKED_APPLICATION_FAMILIES as { push?: (value: unknown) => number };
    expect(() => mutable.push?.({ family: "anything", reason: "" })).toThrow();
    expect(isBlockedApplication("anything")).toBe(false);
  });
});

describe("application names", () => {
  it("accepts normalised names and rejects everything else", () => {
    for (const good of ["crm", "crm.desktop", "a", "doc_gen.v2.legacy"]) {
      expect(APPLICATION_KEY_PATTERN.test(good), `${good} should be accepted`).toBe(true);
    }
    for (const bad of [
      "CRM",
      "crm desktop",
      "crm/desktop",
      "crm:8080",
      "crm?id=1",
      "crm.desktop.v2.extra",
      "1crm",
      "",
    ]) {
      expect(APPLICATION_KEY_PATTERN.test(bad), `${bad} should be rejected`).toBe(false);
    }
  });
});
