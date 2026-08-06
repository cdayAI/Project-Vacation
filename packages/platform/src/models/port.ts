import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type { ModelInvocation, ModelInvocationFilter, TaskUsage } from "./types.js";

/**
 * Persistence port for model invocations.
 *
 * `recordInvocation` is idempotent on `stepId`, and that is a requirement
 * rather than a convenience. The gateway records the invocation after the
 * provider has answered but before the ceiling is re-checked, so a process
 * that crashes in that window and is recovered will try to write the same row
 * again. Writing it twice would double the recorded spend for a single call —
 * which is worse than losing it, because the spend ceiling reads this data and
 * would then refuse work that was never done.
 *
 * A re-write with *different* content is refused outright: it means two
 * different calls claimed the same step, and silently keeping either one would
 * make the cost report a guess.
 *
 * As everywhere else, a read that cannot be served raises rather than
 * returning an empty result. "This run made no model calls" and "we cannot
 * tell what model calls this run made" are different answers.
 */
export interface ModelInvocationStore {
  /**
   * Record one invocation.
   *
   * Re-recording identical content is a no-op. Re-recording different content
   * under the same `stepId` must throw.
   */
  recordInvocation(invocation: ModelInvocation): Promise<void>;
  getInvocation(stepId: Id<"step">): Promise<ModelInvocation | null>;
  listInvocations(filter?: ModelInvocationFilter): Promise<readonly ModelInvocation[]>;
  countInvocations(filter?: ModelInvocationFilter): Promise<number>;
  /** Spend and token totals grouped by task and model, for the cost report. */
  usageByTask(since?: IsoTimestamp): Promise<readonly TaskUsage[]>;
}
