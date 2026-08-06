/**
 * The operating record: what was requested, who owned it, every step, what it
 * cost, how it ended.
 *
 * Callers depend on `RunStore` and are handed an adapter. Nothing outside this
 * module should name a concrete adapter except the composition root that wires
 * one up.
 */

export * from "./types.js";
export * from "./port.js";
export * from "./store.memory.js";
export * from "./store.pg.js";
export {
  MIGRATIONS as RECORD_MIGRATIONS,
  ISO_UTC_PATTERN,
  TERMINAL_STEP_STATUSES,
  assertIsoUtc,
  assertOptionalIsoUtc,
  isTerminalStepStatus,
} from "./migrations.js";
