import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";

/**
 * Model governance types.
 *
 * The controlling rule is that business logic asks for a *task* — a stable
 * name like `rescission.extract_contract_facts` — and never for a model. Every
 * type here exists to make that indirection carry the things a risk committee
 * will ask about: which model serves which task, at what version, what it
 * costs, what it may see, what happens when it fails, and what the provider is
 * contractually permitted to do with the input.
 *
 * Two conventions carried from the operating record: timestamps are ISO-8601
 * UTC strings, and payloads are recorded as digests. A model invocation is the
 * sharpest case of the second rule — the prompt and the response are exactly
 * the material that must not be duplicated into a governance record, so only
 * their fingerprints are kept.
 */

export const PROVIDER_NAMES = ["fake", "anthropic"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * What the provider is contractually permitted to do with what we send.
 *
 * `unconfirmed` is the default for every shipped entry and is deliberately
 * uncomfortable: it means nobody has yet put the provider's retention and
 * training terms in writing for this deployment. It is surfaced as an
 * inventory warning rather than silently assumed away, because "we assumed
 * zero retention" is not an answer to a data-protection question.
 */
export const DATA_RETENTION_POSTURES = [
  /** Zero data retention and no training on customer data, confirmed in writing. */
  "zero_retention_confirmed",
  /** Retention bounded by a written agreement that is not zero. */
  "limited_retention_confirmed",
  /** Nothing is confirmed. Treat as "the provider may keep this". */
  "unconfirmed",
] as const;
export type DataRetentionPosture = (typeof DATA_RETENTION_POSTURES)[number];

/**
 * One concrete model the platform may call.
 *
 * Costs are per single token rather than per million so that a call's cost is
 * a multiplication with no scaling factor to get wrong at the call site. They
 * are stored to ten decimal places, matching the `numeric(20, 10)` column the
 * operating record sums them in.
 */
export interface ModelBinding {
  readonly provider: ProviderName;
  /** The provider's identifier for the model. Only ever set from the inventory. */
  readonly modelId: string;
  /**
   * The exact revision behind `modelId`.
   *
   * `unpinned` means `modelId` is a floating alias that moves to the newest
   * revision in its family without any change on our side — which is the one
   * thing an inventory is supposed to make impossible. It is legitimate in
   * development and must be replaced by a confirmed dated snapshot before
   * production.
   */
  readonly modelVersion: string;
  readonly costPerInputTokenUsd: number;
  readonly costPerOutputTokenUsd: number;
  readonly maxOutputTokens: number;
  /** Wall-clock budget for one attempt. A provider that has not answered by then has failed. */
  readonly timeoutMs: number;
}

/**
 * A logical task, bound to a model.
 *
 * `fallbacks` is an ordered chain walked when the primary is unavailable. It
 * exists so degradation is a declared, reviewable property of the task rather
 * than a decision some caller improvises during an outage.
 */
export interface ModelEntry extends ModelBinding {
  /** Stable logical name, e.g. `rescission.extract_contract_facts`. */
  readonly task: string;
  /** One sentence an auditor can read to understand why this model is here. */
  readonly purpose: string;
  readonly fallbacks: readonly ModelBinding[];
  /**
   * Whether this task's input may contain owner personal data.
   *
   * Declared per task so the data inventory can be derived from the model
   * inventory instead of maintained beside it and drifting.
   */
  readonly maySeeOwnerData: boolean;
  readonly dataRetention: DataRetentionPosture;
  /** Prompt artifact used for this task. Lives in version control, never in a database. */
  readonly promptTemplateId: string;
}

/**
 * A prompt, versioned as a source artifact.
 *
 * Two properties matter. The template lives in version control, so changing a
 * prompt is a reviewable diff rather than a database update nobody can
 * reconstruct later. And `system` is a *constant* — untrusted text is only
 * ever substituted into `userTemplate`, so no amount of crafted input can
 * append to the instruction surface.
 */
export interface PromptTemplate {
  readonly id: string;
  /** Bumped on every change. Recorded with each invocation so an answer traces to its prompt. */
  readonly version: number;
  readonly task: string;
  /** Fixed instructions. Never contains caller-supplied text. */
  readonly system: string;
  /** Body with `{{name}}` placeholders. This is where untrusted text lands. */
  readonly userTemplate: string;
  /** Placeholders the template requires. Rendering refuses if any is missing. */
  readonly variables: readonly string[];
}

export type ModelOutcome = "succeeded" | "failed";

/**
 * What one gateway call did.
 *
 * Keyed by the operating-record step it belongs to: every invocation records a
 * step, and reusing that identifier means the cost report, the audit entry,
 * and this row all join without a second identifier scheme.
 *
 * `promptDigest` and `responseDigest` are fingerprints. The text itself is
 * never stored here — this table is retained for two years for cost and
 * quality analysis, and two years of prompts and responses would be a second
 * copy of everything the platform ever read.
 */
export interface ModelInvocation {
  readonly stepId: Id<"step">;
  readonly runId: Id<"run">;
  readonly task: string;
  readonly provider: ProviderName;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly promptTemplateId: string;
  readonly promptTemplateVersion: number;
  readonly promptDigest: Digest;
  readonly responseDigest?: Digest | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  /** Attempts made against the model that finally answered, starting at 1. */
  readonly attempt: number;
  /** True when the answer came from a fallback rather than the task's primary model. */
  readonly degraded: boolean;
  readonly outcome: ModelOutcome;
  /** Set when `outcome` is `failed`; why the chain ran out. */
  readonly failureKind?: string | undefined;
  readonly invokedAt: IsoTimestamp;
}

export interface ModelInvocationFilter {
  readonly runId?: Id<"run">;
  readonly task?: string;
  readonly modelId?: string;
  readonly outcome?: ModelOutcome;
  readonly degradedOnly?: boolean;
  readonly invokedAfter?: IsoTimestamp;
  readonly invokedBefore?: IsoTimestamp;
  readonly limit?: number;
  readonly offset?: number;
}

/** Rolled-up spend for the cost report and the console. */
export interface TaskUsage {
  readonly task: string;
  readonly modelId: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/**
 * Round to the precision the cost column stores.
 *
 * The in-memory adapter and Postgres must agree on what a call cost, or a
 * ceiling that holds in a test fails in production at the tenth decimal place.
 * `numeric(20, 10)` rounds on write; this rounds before it.
 */
export function roundUsd(amount: number): number {
  return Number(amount.toFixed(10));
}
