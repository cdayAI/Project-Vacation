import { digestValue } from "../kernel/hash.js";
import { isBlockedApplication } from "./exclusions.js";
import type {
  ApplicationKey,
  CandidateOpportunity,
  DraftEvidence,
  DraftRole,
  DraftWorkflow,
  DraftWorkflowStep,
  Observation,
  PromotionNote,
} from "./types.js";

/**
 * Sequence mining over application transitions.
 *
 * The question this answers is narrow: which short sequences of applications
 * does a person walk through repeatedly, how often, and how long does one pass
 * take. That is enough to rank an automation backlog by evidence rather than by
 * whoever spoke most confidently in the prioritisation meeting, and it is
 * deliberately not enough to describe what anyone did.
 *
 * Four properties, each of which is a decision rather than an accident.
 *
 * **Deterministic.** The same observations produce the same candidates in the
 * same order, whatever order they arrive in. Every aggregation is
 * order-independent, the ranking has a total ordering with no ties left to the
 * sort's stability, and the median is the lower median rather than a mean, so
 * no floating-point value ever reaches the output. A prioritisation result that
 * shifts between runs is one nobody can act on or argue with.
 *
 * **Computed on demand.** Nothing here writes anything. Candidates are derived
 * from observations at the moment somebody asks. A stored candidate table would
 * be a second record of employee behaviour with its own retention rule, its own
 * erasure path, and its own way of being forgotten about — and it would outlive
 * the observations it was derived from, including through an erasure.
 *
 * **Chains break at gaps.** Two consecutive observations only extend the same
 * chain when the application being entered by the first is the one being left
 * by the second. Anything else — a missed transition, a collector restart, a
 * blocked application in between — starts a new chain rather than inventing a
 * step that nobody took.
 *
 * **The blocklist floor applies here too.** A sequence touching a blocked
 * application is dropped rather than mined, so an observation that predates a
 * change to the floor cannot resurface inside a candidate.
 */

export interface MineOptions {
  /** Minimum times a sequence must occur. A thing seen twice is a coincidence. */
  readonly minOccurrences?: number;
  /** Minimum distinct sessions. A pattern from one sitting is one sitting. */
  readonly minSessions?: number;
  /** Shortest sequence, in applications. Two applications is one transition. */
  readonly minApplications?: number;
  /** Longest sequence, in applications. */
  readonly maxApplications?: number;
  /** How many candidates to return. */
  readonly limit?: number;
}

const DEFAULTS = {
  minOccurrences: 3,
  minSessions: 2,
  minApplications: 2,
  maxApplications: 6,
  limit: 10,
} as const;

/** One pass through a sequence, before aggregation. */
interface Occurrence {
  readonly sessionId: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
}

/** Every pass through one sequence, keyed by the sequence. */
interface Bucket {
  readonly applications: readonly ApplicationKey[];
  readonly passes: Occurrence[];
}

/**
 * Rank repeated application sequences.
 *
 * @param observations any set of observations; order does not matter.
 */
export function mineCandidates(
  observations: readonly Observation[],
  options: MineOptions = {},
): readonly CandidateOpportunity[] {
  const minOccurrences = Math.max(1, options.minOccurrences ?? DEFAULTS.minOccurrences);
  const minSessions = Math.max(1, options.minSessions ?? DEFAULTS.minSessions);
  const minApplications = Math.max(2, options.minApplications ?? DEFAULTS.minApplications);
  const maxApplications = Math.max(
    minApplications,
    options.maxApplications ?? DEFAULTS.maxApplications,
  );
  const limit = Math.max(0, options.limit ?? DEFAULTS.limit);

  const buckets = new Map<string, Bucket>();

  for (const chain of chainsOf(observations)) {
    const path = applicationPath(chain);
    // A chain of k transitions visits k+1 applications; a window of m
    // applications spans m-1 of those transitions.
    for (let size = minApplications; size <= Math.min(maxApplications, path.length); size += 1) {
      for (let start = 0; start + size <= path.length; start += 1) {
        const applications = path.slice(start, start + size);
        if (applications.some((application) => isBlockedApplication(application))) continue;

        const transitions = chain.slice(start, start + size - 1);
        const first = transitions[0];
        const last = transitions[transitions.length - 1];
        if (!first || !last) continue;

        const key = sequenceKey(applications);
        const bucket = buckets.get(key) ?? { applications, passes: [] };
        bucket.passes.push({
          sessionId: first.sessionId,
          durationMs: transitions.reduce((total, item) => total + item.dwellMs, 0),
          startedAt: first.observedAt,
          endedAt: last.observedAt,
        });
        buckets.set(key, bucket);
      }
    }
  }

  const kept: CandidateOpportunity[] = [];
  for (const { applications, passes } of buckets.values()) {
    if (passes.length < minOccurrences) continue;
    const sessions = new Set(passes.map((pass) => pass.sessionId));
    if (sessions.size < minSessions) continue;

    const durations = passes.map((pass) => pass.durationMs).sort((a, b) => a - b);
    const median = lowerMedian(durations);

    kept.push({
      key: digestValue(applications),
      applications,
      occurrences: passes.length,
      sessions: sessions.size,
      medianDurationMs: median,
      estimatedTotalMs: median * passes.length,
      firstObservedAt: passes.reduce(
        (earliest, pass) => (pass.startedAt < earliest ? pass.startedAt : earliest),
        passes[0]?.startedAt ?? "",
      ),
      lastObservedAt: passes.reduce(
        (latest, pass) => (pass.endedAt > latest ? pass.endedAt : latest),
        passes[0]?.endedAt ?? "",
      ),
      rank: 0,
    });
  }

  return rank(dropSubsumed(kept), limit);
}

/**
 * Drop sequences that a longer sequence already accounts for.
 *
 * If `a → b` occurs eleven times and `a → b → c` also occurs eleven times, then
 * every occurrence of the short one is part of the long one and reporting both
 * fills the ranking with prefixes of the same finding. Keeping only the longer
 * of an equally-supported pair is the standard closed-pattern rule, and it is
 * what makes the output readable.
 */
function dropSubsumed(candidates: readonly CandidateOpportunity[]): CandidateOpportunity[] {
  return candidates.filter((candidate) => {
    return !candidates.some(
      (other) =>
        other !== candidate &&
        other.applications.length > candidate.applications.length &&
        other.occurrences === candidate.occurrences &&
        containsRun(other.applications, candidate.applications),
    );
  });
}

/** True if `needle` appears as a contiguous run inside `haystack`. */
function containsRun(
  haystack: readonly ApplicationKey[],
  needle: readonly ApplicationKey[],
): boolean {
  if (needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Total ordering, so the result never depends on sort stability.
 *
 * Estimated time first, because the backlog question is "where does the time
 * go". Then frequency, then length, then the sequence itself — the last of
 * which can never tie, since two candidates with the same applications in the
 * same order are the same candidate.
 */
function rank(
  candidates: readonly CandidateOpportunity[],
  limit: number,
): readonly CandidateOpportunity[] {
  const ordered = [...candidates].sort((a, b) => {
    if (b.estimatedTotalMs !== a.estimatedTotalMs) return b.estimatedTotalMs - a.estimatedTotalMs;
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    if (b.applications.length !== a.applications.length) {
      return b.applications.length - a.applications.length;
    }
    return sequenceKey(a.applications) < sequenceKey(b.applications) ? -1 : 1;
  });

  return Object.freeze(
    ordered.slice(0, limit).map((candidate, index) =>
      Object.freeze({ ...candidate, rank: index + 1 }),
    ),
  );
}

/**
 * Split observations into contiguous chains.
 *
 * One chain per unbroken run within one session: the application entered by one
 * transition must be the one left by the next, and time must not run backwards.
 * Anything else starts a new chain, because bridging a gap would invent a step
 * that nobody took and inflate the duration of a sequence with time spent
 * somewhere the collector could not see.
 */
function chainsOf(observations: readonly Observation[]): readonly (readonly Observation[])[] {
  const bySession = new Map<string, Observation[]>();
  for (const observation of observations) {
    const bucket = bySession.get(observation.sessionId) ?? [];
    bucket.push(observation);
    bySession.set(observation.sessionId, bucket);
  }

  const chains: Observation[][] = [];
  // Sessions in key order, so the set of chains does not depend on the order
  // observations were handed to us.
  for (const sessionId of [...bySession.keys()].sort()) {
    const inSession = (bySession.get(sessionId) ?? []).slice().sort(compareObservations);
    let current: Observation[] = [];
    let previous: Observation | undefined;

    for (const observation of inSession) {
      const contiguous =
        previous !== undefined &&
        previous.toApplication === observation.fromApplication &&
        previous.observedAt <= observation.observedAt;
      if (!contiguous && current.length > 0) {
        chains.push(current);
        current = [];
      }
      current.push(observation);
      previous = observation;
    }
    if (current.length > 0) chains.push(current);
  }

  return chains;
}

/** The applications a chain of transitions visits, in order. */
function applicationPath(chain: readonly Observation[]): readonly ApplicationKey[] {
  const first = chain[0];
  if (!first) return [];
  const path: ApplicationKey[] = [first.fromApplication];
  for (const observation of chain) path.push(observation.toApplication);
  return path;
}

/** Ordering within a session: the store's sequence, then time, then id. */
export function compareObservations(a: Observation, b: Observation): number {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sequenceKey(applications: readonly ApplicationKey[]): string {
  return applications.join(">");
}

/**
 * Lower median of a sorted array.
 *
 * Lower rather than the mean of the two middle values, because a mean produces
 * a fraction and a fraction produces a float, and a ranking that depends on
 * floating-point arithmetic is a ranking that can reorder itself between two
 * runs over identical data.
 */
function lowerMedian(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

/**
 * The one thing this module says about promotion.
 *
 * Carried on every draft as data, so a console rendering a draft shows the
 * reader where the governance path is instead of offering them a button.
 */
const PROMOTION: PromotionNote = Object.freeze({
  promotable: false,
  path: "A human promotes this by writing a workflow definition and registering its actions in the action registry, with a risk tier and an approval policy, through the normal review path. Nothing in the discovery module can execute, save, schedule, or activate a draft, and no method exists that would.",
});

function evidenceOf(candidate: CandidateOpportunity): DraftEvidence {
  return Object.freeze({
    occurrences: candidate.occurrences,
    sessions: candidate.sessions,
    medianDurationMs: candidate.medianDurationMs,
    estimatedTotalMs: candidate.estimatedTotalMs,
    observedFrom: candidate.firstObservedAt,
    observedTo: candidate.lastObservedAt,
  });
}

/**
 * Draft a workflow from a candidate. Inert, and stays inert.
 *
 * The result is plain frozen data with `status: "draft"`. There is no companion
 * function that saves, schedules, publishes, or activates it — not one that
 * refuses, not one behind a flag, none. A draft becomes a workflow when a person
 * writes the definition and puts their name on the risk classification.
 */
export function draftWorkflow(candidate: CandidateOpportunity): DraftWorkflow {
  const steps: DraftWorkflowStep[] = candidate.applications.map((application, index) =>
    Object.freeze({
      name: `step_${index + 1}_${application.replace(/\./g, "_")}`,
      application,
      humanInvolvement: "human_only" as const,
    }),
  );

  return Object.freeze({
    status: "draft" as const,
    candidateKey: candidate.key,
    name: `draft_${candidate.applications.map((a) => a.replace(/\./g, "_")).join("__")}`,
    summary: `Observed ${candidate.occurrences} times across ${candidate.sessions} collection sessions, taking a median of ${candidate.medianDurationMs} ms per pass. This is a description of a repeated path between applications, not a specification: it says nothing about what was decided at each step, what the inputs were, or whether any of it should be automated.`,
    steps: Object.freeze(steps),
    evidence: evidenceOf(candidate),
    promotion: PROMOTION,
  });
}

/**
 * Draft a role from a candidate. Inert, and stays inert.
 *
 * Deliberately says nothing about permissions, ceilings, or model choice. Those
 * are governance decisions that belong to whoever promotes the draft, and a
 * draft that pre-filled them would invite somebody to accept the defaults.
 */
export function draftRole(candidate: CandidateOpportunity): DraftRole {
  return Object.freeze({
    status: "draft" as const,
    candidateKey: candidate.key,
    name: `draft_role_${candidate.applications.map((a) => a.replace(/\./g, "_")).join("__")}`,
    summary: `A role scoped to this repeated path would need reach into ${candidate.applications.length} applications. Permissions, spend and rate ceilings, operating mode, and model choice are deliberately absent: they are governance decisions for whoever promotes this, and a draft that pre-filled them would invite somebody to accept the defaults.`,
    applications: candidate.applications,
    evidence: evidenceOf(candidate),
    promotion: PROMOTION,
  });
}
