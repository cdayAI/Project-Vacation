import { describe, it, expect } from "vitest";
import type { Id } from "../kernel/ids.js";
import * as discovery from "./index.js";
import { draftRole, draftWorkflow, mineCandidates } from "./mine.js";
import { MemoryDiscoveryStore } from "./store.memory.js";
import type { Observation } from "./types.js";

/**
 * Sequence mining, and the inertness of what it produces.
 *
 * Two things are being defended here.
 *
 * *Determinism*, because a prioritisation result that shifts between runs over
 * identical data is one nobody can act on or argue with — and because the
 * seeded demo has to reproduce byte for byte.
 *
 * *Inertness*, because the whole justification for a component that observes
 * employees is that it informs a human decision rather than making one. A draft
 * that could be promoted from inside this module would be a system that
 * observes people and then changes what the platform does, which is a different
 * product with a different set of legal questions.
 */

const T0 = Date.parse("2026-08-06T09:00:00.000Z");

let counter = 0;

function obs(
  session: string,
  sequence: number,
  from: string,
  to: string,
  minutesAfterStart: number,
  dwellMs: number,
): Observation {
  counter += 1;
  return {
    id: `obs_${String(counter).padStart(4, "0")}` as Id<"observation">,
    subjectRef: "sub_jay",
    deviceRef: "dev_laptop_1",
    sessionId: session as Id<"session">,
    sequence,
    fromApplication: from,
    toApplication: to,
    observedAt: new Date(T0 + minutesAfterStart * 60_000).toISOString(),
    dwellMs,
  };
}

/**
 * Two sessions, each walking `ticketing → spreadsheet → document_generator`
 * twice.
 *
 * Each pass is its own chain: the next pass begins in `ticketing` while the
 * previous one ended in `document_generator`, so the two are not contiguous and
 * the miner does not join them. That is what the day actually looks like —
 * somebody does the sequence, does something else the collector cannot see, and
 * comes back to it.
 */
function corpus(): Observation[] {
  const rows: Observation[] = [];
  let minute = 0;
  for (const session of ["ses_mon", "ses_tue"]) {
    let sequence = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      sequence += 1;
      rows.push(obs(session, sequence, "ticketing", "spreadsheet", (minute += 5), 120_000));
      sequence += 1;
      rows.push(
        obs(session, sequence, "spreadsheet", "document_generator", (minute += 5), 180_000),
      );
    }
  }
  return rows;
}

describe("mining candidates", () => {
  it("finds the repeated sequence and ranks it first", () => {
    const candidates = mineCandidates(corpus(), { minOccurrences: 3, minSessions: 2 });

    expect(candidates.length).toBeGreaterThan(0);
    const top = candidates[0];
    expect(top?.applications).toEqual(["ticketing", "spreadsheet", "document_generator"]);
    expect(top?.occurrences).toBe(4);
    expect(top?.sessions).toBe(2);
    // Median of four identical passes: 120s in ticketing plus 180s in the
    // spreadsheet before the handoff.
    expect(top?.medianDurationMs).toBe(300_000);
    expect(top?.estimatedTotalMs).toBe(1_200_000);
    expect(top?.rank).toBe(1);
  });

  it("returns the same ranking whatever order the observations arrive in", () => {
    const forwards = mineCandidates(corpus(), { minOccurrences: 2, minSessions: 1 });
    const shuffled = mineCandidates(
      // A deterministic shuffle: reversed, then odd rows moved to the front.
      // Any permutation would do; a seeded one keeps the test itself stable.
      (() => {
        const rows = corpus().reverse();
        return [...rows.filter((_, index) => index % 2 === 1), ...rows.filter((_, index) => index % 2 === 0)];
      })(),
      { minOccurrences: 2, minSessions: 1 },
    );

    expect(shuffled).toEqual(forwards);
  });

  it("produces the same result when run twice", () => {
    const options = { minOccurrences: 2, minSessions: 1 } as const;
    expect(mineCandidates(corpus(), options)).toEqual(mineCandidates(corpus(), options));
  });

  it("ignores a sequence that has not happened often enough", () => {
    const rows = corpus();
    rows.push(obs("ses_wed", 1, "ticketing", "console", 500, 10_000));
    const candidates = mineCandidates(rows, { minOccurrences: 3, minSessions: 2 });
    const applications = candidates.map((candidate) => candidate.applications.join(">"));
    expect(applications).not.toContain("ticketing>console");
  });

  it("ignores a pattern seen in only one sitting", () => {
    const single: Observation[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      single.push(obs("ses_one", pass * 2 + 1, "ticketing", "console", pass * 10, 30_000));
      single.push(obs("ses_one", pass * 2 + 2, "console", "ticketing", pass * 10 + 1, 30_000));
    }
    expect(mineCandidates(single, { minOccurrences: 3, minSessions: 2 })).toEqual([]);
  });

  /**
   * A gap must not be bridged.
   *
   * If the application entered by one transition is not the one left by the
   * next, something happened in between that the collector could not see —
   * possibly a blocked application. Joining them would invent a step nobody
   * took and add somebody else's time to the estimate.
   */
  it("breaks the chain where a transition is missing", () => {
    const rows: Observation[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const base = pass * 10;
      rows.push(obs("ses_gap", pass * 2 + 1, "ticketing", "spreadsheet", base, 60_000));
      // Next hop starts somewhere else entirely: the person went via an
      // application that was never observed.
      rows.push(obs("ses_gap", pass * 2 + 2, "console", "document_generator", base + 2, 60_000));
    }

    const applications = mineCandidates(rows, { minOccurrences: 2, minSessions: 1 }).map(
      (candidate) => candidate.applications.join(">"),
    );
    expect(applications).toContain("ticketing>spreadsheet");
    expect(applications).toContain("console>document_generator");
    expect(applications).not.toContain("ticketing>spreadsheet>document_generator");
    expect(applications).not.toContain("spreadsheet>console");
  });

  /**
   * The floor applies to mining as well as to collection.
   *
   * Observations recorded before a family was added to the floor are still in
   * the store until retention removes them. They must not resurface inside a
   * candidate.
   */
  it("drops any sequence touching a blocked application", () => {
    const rows: Observation[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const base = pass * 10;
      rows.push(obs("ses_legacy", pass * 2 + 1, "ticketing", "email", base, 60_000));
      rows.push(obs("ses_legacy", pass * 2 + 2, "email", "spreadsheet", base + 1, 60_000));
    }

    for (const candidate of mineCandidates(rows, { minOccurrences: 2, minSessions: 1 })) {
      expect(candidate.applications).not.toContain("email");
    }
  });

  it("drops a prefix that a longer sequence already accounts for", () => {
    // `ticketing → spreadsheet` occurs exactly as often as
    // `ticketing → spreadsheet → document_generator`, so reporting both would
    // fill the ranking with prefixes of one finding.
    const candidates = mineCandidates(corpus(), { minOccurrences: 4, minSessions: 2 });
    const applications = candidates.map((candidate) => candidate.applications.join(">"));
    expect(applications).toContain("ticketing>spreadsheet>document_generator");
    expect(applications).not.toContain("ticketing>spreadsheet");
  });

  it("says nothing when there is nothing to say", () => {
    expect(mineCandidates([])).toEqual([]);
  });

  it("honours the limit, keeping the highest-ranked", () => {
    const rows = corpus();
    // A second, much cheaper pattern, so there is something to cut.
    rows.push(obs("ses_mon", 90, "console", "spreadsheet", 300, 5_000));
    rows.push(obs("ses_tue", 91, "console", "spreadsheet", 310, 5_000));

    const options = { minOccurrences: 1, minSessions: 1 } as const;
    expect(mineCandidates(rows, options)).toHaveLength(2);

    const capped = mineCandidates(rows, { ...options, limit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0]?.applications).toEqual([
      "ticketing",
      "spreadsheet",
      "document_generator",
    ]);
  });
});

describe("proposals are inert", () => {
  function topCandidate(): discovery.CandidateOpportunity {
    const candidates = mineCandidates(corpus(), { minOccurrences: 3, minSessions: 2 });
    const top = candidates[0];
    if (!top) throw new Error("the corpus should produce a candidate");
    return top;
  }

  it("marks a drafted workflow as a draft and says where the governance path is", () => {
    const draft = draftWorkflow(topCandidate());
    expect(draft.status).toBe("draft");
    expect(draft.promotion.promotable).toBe(false);
    expect(draft.promotion.path).toContain("action registry");
    expect(draft.steps).toHaveLength(3);
    for (const step of draft.steps) expect(step.humanInvolvement).toBe("human_only");
  });

  it("marks a drafted role as a draft and leaves its governance blank", () => {
    const draft = draftRole(topCandidate());
    expect(draft.status).toBe("draft");
    expect(draft.promotion.promotable).toBe(false);
    // No permissions, no ceilings, no model. Those belong to whoever promotes
    // it, and pre-filling them would invite somebody to accept the defaults.
    expect(Object.keys(draft).sort()).toEqual([
      "applications",
      "candidateKey",
      "evidence",
      "name",
      "promotion",
      "status",
      "summary",
    ]);
  });

  it("returns frozen plain data with no behaviour attached", () => {
    const candidate = topCandidate();
    for (const draft of [
      draftWorkflow(candidate) as unknown as Record<string, unknown>,
      draftRole(candidate) as unknown as Record<string, unknown>,
    ]) {
      expect(Object.isFrozen(draft)).toBe(true);
      for (const value of Object.values(draft)) {
        expect(typeof value).not.toBe("function");
      }
      // A frozen object is not a suggestion: an attempt to flip the flag fails.
      expect(() => {
        (draft["promotion"] as { promotable: boolean }).promotable = true;
      }).toThrow();
    }
  });

  it("is the same draft every time, for the same candidate", () => {
    const candidate = topCandidate();
    expect(draftWorkflow(candidate)).toEqual(draftWorkflow(candidate));
    expect(draftRole(candidate)).toEqual(draftRole(candidate));
  });

  /**
   * No activation path exists.
   *
   * Not "exists but refuses" — absent. The module's public surface is scanned
   * for anything that sounds like promotion, and the persistence port is
   * scanned for anything that would store a draft, because a store method is
   * how a draft would quietly become durable and then, later, actionable.
   */
  it("exports nothing that promotes, activates, schedules, or executes anything", () => {
    const forbidden =
      /(promote|activate|publish|schedule|deploy|install|execute|enable|approve|apply)/i;
    const offenders = Object.keys(discovery).filter((name) => forbidden.test(name));
    expect(
      offenders,
      `Work discovery proposes and never acts. A human promotes a draft through the normal governance path.\n${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("has no persistence path for a candidate or a draft", () => {
    const methods = Object.getOwnPropertyNames(MemoryDiscoveryStore.prototype).filter(
      (name) => name !== "constructor",
    );
    const offenders = methods.filter((name) =>
      /(candidate|draft|proposal|opportunity|workflow|role)/i.test(name),
    );
    expect(
      offenders,
      `Candidates are computed on demand. A second store of mined employee behaviour would have its own retention rule, its own erasure path, and would outlive the observations it came from.\n${offenders.join(", ")}`,
    ).toEqual([]);

    // And the surface really is only the three things it claims to hold.
    expect(methods.sort()).toEqual([
      "appendObservation",
      "countObservations",
      "endSession",
      "eraseSubject",
      "getEnrollment",
      "getSession",
      "listEnrollments",
      "listObservations",
      "listSessions",
      "purgeObservationsBefore",
      "putEnrollment",
      "setEnrollmentState",
      "startSession",
    ]);
  });
});
