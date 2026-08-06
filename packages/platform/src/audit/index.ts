/**
 * The tamper-evident audit log.
 *
 * Write through `AuditLog`, never through an `AuditStore` directly: the log is
 * where payload rejection and hash construction are applied, and a caller that
 * bypasses it can write an entry that fails verification later.
 */

export * from "./types.js";
export * from "./port.js";
export * from "./chain.js";
export * from "./log.js";
export * from "./store.memory.js";
export * from "./store.pg.js";
export { MIGRATIONS as AUDIT_MIGRATIONS } from "./migrations.js";
