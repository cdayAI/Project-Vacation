import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";

/**
 * Work discovery: the shapes.
 *
 * This module observes employees, which makes the *type definitions* a control
 * rather than a convenience. Everything this component is permitted to see is
 * declared here and nowhere else, and the things it is forbidden to see are
 * absent by construction: there is no field on `Observation` that could hold a
 * window title, a keystroke, a URL, a document body, or a customer record, and
 * `exclusions.ts` refuses at runtime any object carrying a key that is not on
 * the list derived from this file.
 *
 * The design rule behind that: **exclusions are structural, not
 * configurable.** A setting that says "do not capture screen contents" is a
 * setting someone can change, in a hurry, for a good-sounding reason, at a
 * point where nobody is looking. A type that cannot represent screen contents,
 * backed by a validator that rejects unexpected keys and a database with
 * nowhere to put them, is a decision that has to be made again in code review
 * with the diff on screen. Only the second one survives contact with a
 * deadline.
 *
 * What that leaves is genuinely narrow and deliberately so: that a person moved
 * from one allowlisted application to another, when, and how long they had been
 * in the first one. That is enough to notice "this sequence of four
 * applications happens eleven times a day and takes six minutes" — which is the
 * whole question work discovery exists to answer — and it is not enough to
 * reconstruct what anybody wrote, read, said, or decided.
 */

/**
 * A normalised application name, e.g. `ticketing` or `spreadsheet.desktop`.
 *
 * Lowercase, dot-separated, bounded. The shape is part of the exclusion story
 * rather than tidiness: the most obvious way to smuggle a window title or a URL
 * past a validator that only checks *which* keys are present is to put it in a
 * key that is allowed. An application name that cannot contain a space, a
 * slash, a colon, a query string, or a capital letter cannot carry the sentence
 * someone was reading.
 */
export type ApplicationKey = string;

/**
 * One transition between two allowlisted applications.
 *
 * Every field is either an opaque reference, a normalised application name, a
 * timestamp, or a duration. Nothing here is content, and nothing here can
 * become content: see `assertObservationShape` in `exclusions.ts`, which
 * refuses any object whose key set differs from `OBSERVATION_KEYS` below.
 *
 * **Adding a field to this interface is a privacy decision.** It will fail to
 * compile until it is also added to `OBSERVATION_KEY_COVERAGE`, and the test
 * that pins the key set will fail until someone updates it deliberately. That
 * friction is the point.
 */
export interface Observation {
  readonly id: Id<"observation">;
  /**
   * Pseudonymous reference to the observed person.
   *
   * Never a name, an email address, or a directory identifier. The mapping from
   * this reference to a human being lives in the enrollment record, which the
   * person themself can erase.
   */
  readonly subjectRef: string;
  /** Pseudonymous reference to the device the collector runs on. */
  readonly deviceRef: string;
  readonly sessionId: Id<"session">;
  /** 1-based position within the collector session, assigned by the store. */
  readonly sequence: number;
  /** The application being left. Always on the enrollment allowlist. */
  readonly fromApplication: ApplicationKey;
  /** The application being entered. Always on the enrollment allowlist. */
  readonly toApplication: ApplicationKey;
  /** When the transition happened. */
  readonly observedAt: IsoTimestamp;
  /** How long the person had been in `fromApplication` before switching. */
  readonly dwellMs: number;
}

/**
 * Compile-time proof that the runtime key allowlist covers the type.
 *
 * `Record<keyof Observation, true>` means a field added to `Observation`
 * without being listed here does not compile. The runtime allowlist is derived
 * from this object rather than written out a second time, so the two cannot
 * drift apart — which is the failure mode that would otherwise let a new field
 * slip past the validator while every test still passed.
 */
const OBSERVATION_KEY_COVERAGE: Readonly<Record<keyof Observation, true>> = {
  id: true,
  subjectRef: true,
  deviceRef: true,
  sessionId: true,
  sequence: true,
  fromApplication: true,
  toApplication: true,
  observedAt: true,
  dwellMs: true,
};

/** Every key an `Observation` may carry, sorted. Nothing else is accepted. */
export const OBSERVATION_KEYS: readonly string[] = Object.freeze(
  Object.keys(OBSERVATION_KEY_COVERAGE).sort(),
);

/** What a collector submits. The store assigns `sequence`; the platform assigns `id`. */
export interface ObservationInput {
  readonly subjectRef: string;
  readonly deviceRef: string;
  readonly fromApplication: ApplicationKey;
  readonly toApplication: ApplicationKey;
  readonly observedAt: IsoTimestamp;
  readonly dwellMs: number;
}

const OBSERVATION_INPUT_KEY_COVERAGE: Readonly<Record<keyof ObservationInput, true>> = {
  subjectRef: true,
  deviceRef: true,
  fromApplication: true,
  toApplication: true,
  observedAt: true,
  dwellMs: true,
};

/** Every key a submitted observation may carry, sorted. */
export const OBSERVATION_INPUT_KEYS: readonly string[] = Object.freeze(
  Object.keys(OBSERVATION_INPUT_KEY_COVERAGE).sort(),
);

/** The stored shape, before the store assigns a position in the session. */
export type NewObservation = Omit<Observation, "sequence">;

/**
 * Enrollment state, controlled by the observed person.
 *
 * `paused` and `revoked` are both reachable by the subject alone, at any time,
 * with no administrator involved. `revoked` is terminal: resuming observation
 * after a revocation requires a fresh enrollment, which is another deliberate
 * act by the same person.
 */
export type EnrollmentState = "active" | "paused" | "revoked";

export const ENROLLMENT_STATES: readonly EnrollmentState[] = ["active", "paused", "revoked"];

/**
 * One person, one device, one allowlist.
 *
 * The allowlist is *positive*: an application not named here is not observed.
 * An empty allowlist is legal and observes nothing at all — which is the state
 * a cautious person should be able to sit in without having to trust that
 * somebody else configured the blocklist correctly.
 */
export interface Enrollment {
  readonly subjectRef: string;
  /**
   * The identity of the person being observed.
   *
   * Held so the platform can check that pause, stop, revoke, and erase are
   * being exercised *by that person*, and so that nobody else can enroll them.
   */
  readonly subjectActorId: string;
  readonly deviceRef: string;
  readonly state: EnrollmentState;
  /** Applications this person agreed to have observed. Empty observes nothing. */
  readonly applicationAllowlist: readonly ApplicationKey[];
  /** Days of retention for this enrollment. Capped by `MAX_RETENTION_DAYS`. */
  readonly retentionDays: number;
  /**
   * Reference to the written notice this person was given, and the moment they
   * acknowledged it.
   *
   * Required. An enrollment that cannot say which notice the person read is not
   * evidence of anything, and "which notice, given when" is the first question
   * asked in every one of the legal regimes named in `index.ts`.
   */
  readonly noticeReference: string;
  readonly noticeAcknowledgedAt: IsoTimestamp;
  readonly enrolledAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** Why a collector session ended. Every value is an act by the observed person. */
export type SessionEndReason =
  | "stopped_by_subject"
  | "paused_by_subject"
  | "revoked_by_subject"
  | "erased_by_subject";

export const SESSION_END_REASONS: readonly SessionEndReason[] = [
  "stopped_by_subject",
  "paused_by_subject",
  "revoked_by_subject",
  "erased_by_subject",
];

/**
 * A deliberately started collection window.
 *
 * The third gate. An active enrollment does not by itself cause anything to be
 * observed: someone has to start a collector, and it stops when they say so or
 * when the enrollment stops being active.
 *
 * `observationCount` is the session's monotonic counter, incremented by the
 * store as part of the same atomic operation that appends an observation. It is
 * held here rather than derived by counting rows so that retention purges — which
 * delete old rows — cannot cause sequence numbers to be handed out twice.
 */
export interface CollectorSession {
  readonly id: Id<"session">;
  readonly subjectRef: string;
  readonly deviceRef: string;
  /** The actor that started collection. Must be the observed person. */
  readonly startedBy: string;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp | undefined;
  readonly endedReason?: SessionEndReason | undefined;
  readonly observationCount: number;
}

/**
 * The three gates, each refused separately.
 *
 * The kernel's denial taxonomy is shared across the platform and is not this
 * module's to extend, so all three refusals carry one of the reserved
 * `discovery.*` reasons and name the specific gate in `detail.gate`. A caller
 * that wants to tell them apart reads the detail rather than parsing prose.
 */
export type DiscoveryGate =
  /** The feature is switched on in configuration. Defaults to off. */
  | "feature_enabled"
  /** A named person and device are enrolled and the enrollment is active. */
  | "enrollment"
  /** The application is on that enrollment's positive allowlist. */
  | "allowlist"
  /** The application is not on the immutable blocklist floor. */
  | "blocklist"
  /** A collector was started deliberately and is still running. */
  | "collector";

export const DISCOVERY_GATES: readonly DiscoveryGate[] = [
  "feature_enabled",
  "enrollment",
  "allowlist",
  "blocklist",
  "collector",
];

/** What an erasure destroyed. Returned to the person who asked for it. */
export interface ErasureResult {
  readonly observationsErased: number;
  readonly sessionsErased: number;
  readonly enrollmentsErased: number;
}

/**
 * A repeated application sequence, computed on demand.
 *
 * Never persisted. Candidates are derived from observations at the moment
 * somebody asks, so there is no second store of employee behaviour accumulating
 * beside the first one with its own retention rule and its own way of being
 * forgotten about.
 */
export interface CandidateOpportunity {
  /**
   * Stable identity: a digest of the application sequence.
   *
   * Derived rather than generated, because the same sequence mined twice from
   * the same observations must produce the same candidate — a generated id
   * would make two identical results look like two different findings.
   */
  readonly key: Digest;
  /** The applications, in the order they were visited. */
  readonly applications: readonly ApplicationKey[];
  /** How many times the full sequence was observed. */
  readonly occurrences: number;
  /** Sessions the sequence appeared in. A pattern seen once is not a pattern. */
  readonly sessions: number;
  /** Median wall-clock time one pass through the sequence took. */
  readonly medianDurationMs: number;
  /** `occurrences × medianDurationMs`. The ranking signal. */
  readonly estimatedTotalMs: number;
  readonly firstObservedAt: IsoTimestamp;
  readonly lastObservedAt: IsoTimestamp;
  /** 1-based position in the ranking this candidate was returned in. */
  readonly rank: number;
}

/**
 * Why a draft cannot be promoted from here.
 *
 * Carried on every draft as data rather than stated in a comment, so that a
 * console rendering a draft shows the reader where the governance path is
 * instead of offering them a button.
 */
export interface PromotionNote {
  /** Always false. There is no code path in this module that sets it otherwise. */
  readonly promotable: false;
  /** Where a human takes this next. */
  readonly path: string;
}

export interface DraftWorkflowStep {
  readonly name: string;
  readonly application: ApplicationKey;
  /**
   * Always `human_only` on a draft.
   *
   * A draft mined from observation has no evidence about reversibility,
   * consumer impact, or cost, so it cannot classify its own risk. Whoever
   * promotes it classifies it, in the action registry, with their name on it.
   */
  readonly humanInvolvement: "human_only";
}

/** An inert proposal. Plain data; nothing in this module can act on it. */
export interface DraftWorkflow {
  readonly status: "draft";
  readonly candidateKey: Digest;
  readonly name: string;
  readonly summary: string;
  readonly steps: readonly DraftWorkflowStep[];
  readonly evidence: DraftEvidence;
  readonly promotion: PromotionNote;
}

/** An inert proposal. Plain data; nothing in this module can act on it. */
export interface DraftRole {
  readonly status: "draft";
  readonly candidateKey: Digest;
  readonly name: string;
  readonly summary: string;
  /** Applications the role would need reach into, for whoever scopes it. */
  readonly applications: readonly ApplicationKey[];
  readonly evidence: DraftEvidence;
  readonly promotion: PromotionNote;
}

/** The counts a draft was derived from, so a reader can judge it. */
export interface DraftEvidence {
  readonly occurrences: number;
  readonly sessions: number;
  readonly medianDurationMs: number;
  readonly estimatedTotalMs: number;
  readonly observedFrom: IsoTimestamp;
  readonly observedTo: IsoTimestamp;
}
