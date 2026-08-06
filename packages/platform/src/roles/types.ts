import type { HumanInvolvement, RiskTier } from "../guard/types.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, IsoTimestamp, OperatingMode } from "../record/types.js";

/**
 * Agent roles: the shapes.
 *
 * A role is what MVW adds when it wants the platform to do a new job — "chase
 * association delinquencies", "triage rescission requests". The point of this
 * module is that adding one does not need an engineering cycle, and the point
 * of these types is that it is still treated as a change to the system's
 * behaviour: versioned, attributable, evidenced, approved, and revertible.
 *
 * Four decisions are encoded in the types rather than left to convention.
 *
 * *A role names a task, not a model.* `modelTask` is a logical name resolved
 * through the model inventory. A role that named a model would move a model
 * choice out of the inventory and into a database row, which is precisely the
 * ungoverned change the inventory exists to prevent.
 *
 * *A role references a prompt, it does not contain one.* `promptTemplateId`
 * and `promptTemplateVersion` point at an artifact in version control. Storing
 * prompt text on a role would put a prompt in a database where it could be
 * edited without review — the one thing the platform forbids about prompts.
 *
 * *A role declares its ceiling, and the ceiling is a bound, not a wish.* The
 * actions it may call, the highest risk tier it may reach, the data it may
 * see, and the human involvement it carries are all part of the versioned
 * artifact. Changing any of them is a new version with an author and a date.
 *
 * *Evidence is part of the record, not a side note.* A promoted version
 * carries the identifier of the evaluation run that justified it and the
 * approval that authorised it. A version cannot be promoted without both, and
 * the schema refuses a promoted row with no evidence.
 *
 * Timestamps are ISO-8601 UTC strings, as everywhere else in the platform.
 */

/**
 * Where a version sits in its life.
 *
 *   `draft`     Created. Not submitted, not evidenced, cannot act.
 *   `proposed`  Submitted for promotion. Still cannot act.
 *   `promoted`  The version that may act. At most one per role, enforced by a
 *               unique partial index rather than by remembering.
 *   `disabled`  Was promoted; an operator has stopped it. Cannot act.
 *   `reverted`  Was promoted and has been rolled off — either superseded by a
 *               newer promotion or rolled back deliberately. Cannot act.
 *
 * There is no status that means "acting without evidence", which is the whole
 * design: the only path into `promoted` runs through `promotion.ts`.
 */
export const ROLE_STATUSES = ["draft", "proposed", "promoted", "disabled", "reverted"] as const;
export type RoleStatus = (typeof ROLE_STATUSES)[number];

/** Statuses from which a version may still be promoted. */
export const PROMOTABLE_STATUSES: readonly RoleStatus[] = ["draft", "proposed"];

/**
 * The versioned artifact.
 *
 * Everything a reviewer needs to answer "what is this role allowed to do" is
 * in here, and nothing that would make the row a payload store.
 */
export interface RoleDefinition {
  /** Stable machine name, lower_snake_case, e.g. `rescission_intake`. */
  readonly name: string;
  /** Why this role exists, in a sentence or two an approver will actually read. */
  readonly purpose: string;
  /**
   * Action names the role may call.
   *
   * Every one must already be in the action registry. A role cannot invent
   * capability: it selects from what the platform has declared it can do, so
   * the capability surface stays readable in one file.
   */
  readonly actions: readonly string[];
  /**
   * The highest risk tier the role may reach.
   *
   * Never `prohibited` — a role whose ceiling was `prohibited` would be
   * claiming authority the platform refuses to anyone, and the validator
   * rejects it rather than relying on the authorization chokepoint to catch
   * every call.
   */
  readonly riskCeiling: RiskTier;
  /** Data scopes the role may read, e.g. `legal`, `association`. */
  readonly dataScopes: readonly string[];
  /** Logical task from the model inventory. Never a model identifier. */
  readonly modelTask: string;
  /** Prompt artifact in version control. Never prompt text. */
  readonly promptTemplateId: string;
  /** Pinned so an evaluation's evidence names the exact prompt it ran against. */
  readonly promptTemplateVersion: number;
  /** Identifier of the golden set this role is measured against. */
  readonly evaluationSetId: string;
  /** How a human is involved when this role acts. */
  readonly humanTier: HumanInvolvement;
  /** Operating modes the role may run in. `shadow` proposes and lands nothing. */
  readonly operatingModes: readonly OperatingMode[];
}

/**
 * What justified a promotion.
 *
 * Held on the version rather than reconstructed from the audit log, because an
 * operator looking at a live role needs to see "promoted by whom, on what
 * evidence" without running a chain query. The audit log remains the
 * tamper-evident copy; this is the operational one.
 */
export interface PromotionEvidence {
  /** The evaluation run whose results justified the promotion. */
  readonly evaluationRunId: Id<"evaluation">;
  readonly accuracy: number;
  readonly threshold: number;
  /** The approval the promoter spent. Single-use, bound to the proposal digest. */
  readonly approvalId: Id<"approval">;
  readonly promotedAt: IsoTimestamp;
  readonly promotedBy: ActorRef;
  /** Model and prompt that were evaluated, recorded so drift is detectable. */
  readonly modelId: string;
  readonly modelVersion: string;
  readonly promptTemplateId: string;
  readonly promptTemplateVersion: number;
}

export interface RoleVersion {
  readonly id: Id<"roleVersion">;
  readonly roleId: Id<"role">;
  /** 1-based, contiguous, assigned by the store so concurrent authors cannot collide. */
  readonly version: number;
  readonly status: RoleStatus;
  readonly definition: RoleDefinition;
  /** Fingerprint of the definition, bound into approvals and evaluation runs. */
  readonly definitionDigest: Digest;
  readonly createdAt: IsoTimestamp;
  /** Who made this change. Every version is attributable to a person. */
  readonly createdBy: ActorRef;
  /** What the author says changed and why. Shown beside the diff. */
  readonly changeNote: string;
  readonly evidence?: PromotionEvidence | undefined;
  /** Set when this version was created by reverting to an earlier one. */
  readonly restoredFromVersion?: number | undefined;
  /** When this version stopped being the promoted one. */
  readonly rolledOffAt?: IsoTimestamp | undefined;
}

/**
 * The role itself.
 *
 * A thin head record: identity, authorship, and two denormalised pointers the
 * console and the authorization path read on every call. `promotedVersion` is
 * kept consistent with the version rows inside the same atomic operation, and
 * the database additionally enforces that at most one version per role carries
 * `promoted` — so the pointer cannot drift into naming a version that is not.
 */
export interface Role {
  readonly id: Id<"role">;
  readonly name: string;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: ActorRef;
  readonly latestVersion: number;
  /** The version that may act, when there is one. */
  readonly promotedVersion?: number | undefined;
  /**
   * Fingerprint of what makes this role distinct from another.
   *
   * Covers actions, risk ceiling, data scopes, and model task — and
   * deliberately not the prompt. Unique across roles: if two roles differ only
   * in prompt wording, they are one role.
   */
  readonly identityDigest: Digest;
}

/** One line of a rendered diff between two versions. */
export interface RoleChange {
  /** Field name in the definition, e.g. `actions`. */
  readonly field: string;
  readonly kind: "added" | "removed" | "changed";
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /**
   * True when the change lets the role do more than it could before.
   *
   * The console renders these first and an approver reads them first. A diff
   * that buries "gained contact.send_owner_message" among prose edits is a
   * diff that gets approved without being read.
   */
  readonly widensAuthority: boolean;
  /** One line a human can read without knowing the schema. */
  readonly summary: string;
}

/**
 * How strictly an expected outcome is stated.
 *
 *   `exact`     the answer must match this string once normalised.
 *   `contains`  every listed phrase must appear.
 *   `refusal`   the role must refuse, mentioning the stated ground.
 *   `any`       anything passes. The weakest possible assertion, and the
 *               shape an automated improvement loop would love to relabel a
 *               hard case into. `evaluation.ts` refuses exactly that.
 */
export type ExpectedOutcome =
  | { readonly kind: "exact"; readonly value: string }
  | { readonly kind: "contains"; readonly values: readonly string[] }
  | { readonly kind: "refusal"; readonly ground: string }
  | { readonly kind: "any" };

/**
 * One curated case.
 *
 * Curated by a human, and the record says which one. The golden set is the
 * ground truth of record — the thing a quality claim is measured against — so
 * "who decided this was the right answer, and when" is part of the case rather
 * than tribal knowledge.
 */
export interface GoldenCase {
  /** Stable, human-assigned, unique within the set. Renaming one orphans it. */
  readonly id: string;
  /** What this case is testing, for the person reading a failure. */
  readonly description: string;
  /** Values for the prompt template's declared variables. */
  readonly input: Readonly<Record<string, string>>;
  readonly expected: ExpectedOutcome;
  /** Free-form labels, e.g. `jurisdiction:FL`. Used for slicing results. */
  readonly tags: readonly string[];
  /**
   * Protected-class attributes for fairness testing.
   *
   * Permitted **only** on synthetic fixtures, and the validator enforces that.
   * See bias.ts: this platform does not hold protected-class attributes about
   * real people, and a fairness fixture that did would be a worse problem than
   * the one it was measuring.
   */
  readonly protectedAttributes?: Readonly<Record<string, string>> | undefined;
  /** The person or team who decided this is the right answer. */
  readonly curatedBy: string;
  readonly curatedAt: IsoTimestamp;
}

/**
 * A curated collection of real-shaped cases with expected outcomes.
 *
 * Immutable per `(id, version)`. A change is a new version, which is what makes
 * the protection guard in evaluation.ts meaningful: there is no in-place edit
 * for the automated loop to reach for.
 */
export interface GoldenSet {
  /** Stable machine name, e.g. `rescission_intake.v1`. */
  readonly id: string;
  /** Bumped on every curation change. */
  readonly version: number;
  /** The logical model task these cases exercise. */
  readonly task: string;
  /**
   * True when every case is a synthetic fixture rather than real material.
   *
   * Gates fairness analysis. A set carrying protected-class attributes must be
   * synthetic, and bias.ts refuses to compute a disparity from anything else.
   */
  readonly synthetic: boolean;
  /** Minimum accuracy for this set to support a promotion. In [0, 1]. */
  readonly threshold: number;
  readonly curatedBy: string;
  readonly curatedAt: IsoTimestamp;
  readonly cases: readonly GoldenCase[];
}

export type CaseOutcome = "passed" | "failed" | "errored" | "refused";

/**
 * What one case did.
 *
 * The model's answer is recorded as a digest, not as text. An evaluation run
 * over a few hundred cases, kept for the life of the role, would otherwise
 * become a second copy of everything the platform has ever been asked — held
 * outside the systems of record whose retention and deletion paths govern the
 * originals. `detail` describes the *expectation* that was or was not met, and
 * is derived from the curated case rather than from the model's output.
 */
export interface CaseResult {
  readonly caseId: string;
  readonly outcome: CaseOutcome;
  /** Fingerprint of the answer, so the run in the operating record joins to it. */
  readonly responseDigest?: Digest | undefined;
  /** The operating-record step the model call was charged to. */
  readonly stepId?: Id<"step"> | undefined;
  /** Denial reason when the platform refused the case. */
  readonly denialReason?: string | undefined;
  /** Why it passed or failed, phrased from the curated expectation. */
  readonly detail: string;
  readonly latencyMs: number;
  readonly costUsd: number;
  readonly tags: readonly string[];
  readonly protectedAttributes?: Readonly<Record<string, string>> | undefined;
}

/**
 * One measured run of a role against a golden set.
 *
 * Records the model and prompt versions it ran against, so evidence that
 * describes a different system than the one about to be promoted is detectable
 * rather than assumed away. Quality is measured; nothing here is asserted.
 */
export interface EvaluationRun {
  readonly id: Id<"evaluation">;
  readonly roleId: Id<"role">;
  readonly roleVersion: number;
  /** Binds the evidence to exactly the definition that was evaluated. */
  readonly definitionDigest: Digest;
  readonly goldenSetId: string;
  readonly goldenSetVersion: number;
  /** Binds the evidence to exactly the cases that were run. */
  readonly goldenSetDigest: Digest;
  readonly task: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly promptTemplateId: string;
  readonly promptTemplateVersion: number;
  /** The operating-record run the model calls were charged to. */
  readonly runId: Id<"run">;
  readonly evaluatedBy: ActorRef;
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  readonly caseCount: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  /** Passed cases over total cases, in [0, 1]. */
  readonly accuracy: number;
  readonly threshold: number;
  readonly meetsThreshold: boolean;
  /** Carried from the golden set so fairness analysis cannot be pointed at real data. */
  readonly syntheticFixtures: boolean;
  readonly results: readonly CaseResult[];
  readonly totalCostUsd: number;
}

export interface EvaluationFilter {
  readonly roleId?: Id<"role"> | undefined;
  readonly roleVersion?: number | undefined;
  readonly goldenSetId?: string | undefined;
  readonly meetsThreshold?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** Rank of a risk tier, for ceiling comparisons. Higher is more consequential. */
export const RISK_RANK: Readonly<Record<RiskTier, number>> = {
  routine: 0,
  sensitive: 1,
  high_consequence: 2,
  prohibited: 3,
};

/**
 * Rank of an expected outcome's strictness. Higher is stricter.
 *
 * Used only to describe *how* a proposed golden set weakened an existing case,
 * so the refusal message names the shape of the change. The guard itself does
 * not permit a change of any kind to an existing expectation.
 */
export const STRICTNESS_RANK: Readonly<Record<ExpectedOutcome["kind"], number>> = {
  any: 0,
  contains: 1,
  refusal: 2,
  exact: 3,
};
