/**
 * The workflow engine.
 *
 * Workflows are declarative, versioned artifacts in source control; instances
 * are durable rows that pin the version they started under. The engine claims a
 * step, re-checks containment, passes the effect through the authorization
 * chokepoint, records it with input and output digests, and only then advances
 * — writing the transition before it begins the next one, so a deploy in the
 * middle of a case does not lose the case.
 *
 * Callers depend on `WorkflowStore` and are handed an adapter. Nothing outside
 * this module should name a concrete adapter except the composition root.
 */

export * from "./types.js";
export * from "./port.js";
export * from "./definition.js";
export {
  MAX_CONTEXT_KEYS,
  MAX_CONTEXT_VALUE_LENGTH,
  assertContextSafe,
  backoffMsFor,
  buildCompensationQueue,
  canRetry,
  chooseBranch,
  deriveStatus,
  deriveWakeAt,
  evaluateCondition,
  idempotencyKeyFor,
  mergeContext,
  normaliseInstance,
  pickInputs,
} from "./instance.js";
export type { BranchChoice, ConditionResult } from "./instance.js";
export * from "./runner.js";
export * from "./store.memory.js";
export * from "./store.pg.js";
export { MIGRATIONS as ENGINE_MIGRATIONS } from "./migrations.js";
