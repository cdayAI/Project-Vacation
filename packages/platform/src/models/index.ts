/**
 * Model governance: the inventory, the providers, and the one gateway every
 * model call goes through.
 *
 * The rule this module exists to enforce is that business logic asks for a
 * logical task and never for a model. Callers import `ModelGateway` and a task
 * name; nothing outside this module should reach for a provider directly, and
 * an architecture test keeps concrete model identifiers inside the inventory.
 */

export * from "./types.js";
export * from "./port.js";
export * from "./inventory.js";
export * from "./templates.js";
export * from "./provider.js";
export * from "./invoke.js";
export * from "./store.memory.js";
export * from "./store.pg.js";
export { MIGRATIONS as MODEL_MIGRATIONS } from "./migrations.js";
