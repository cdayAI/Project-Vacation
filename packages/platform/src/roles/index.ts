/**
 * Agent roles: the registry, plain-language authoring, promotion, the
 * evaluation harness, and fairness analysis.
 *
 * The module exists to make one sentence true: MVW can add capability without
 * an engineering cycle, and a new agent role is still treated as a change to
 * the system's behaviour. Everything here is in service of the second half.
 *
 * The path a role takes, and what stops it at each step:
 *
 *   draftRole            assembles a proposal from the declared action
 *                        catalogue. Cannot invent capability, never infers a
 *                        high-consequence action from prose, and produces a
 *                        value with no identifier and no status.
 *   RoleRegistry         versions it, attributes it, diffs it, and refuses a
 *                        second role that differs only in prompt wording.
 *   EvaluationHarness    measures it against a human-curated golden set and
 *                        records the numbers, the cases, and the model and
 *                        prompt it ran against.
 *   RolePromotionService checks that the evidence describes what will actually
 *                        run, then puts the promotion through the ordinary
 *                        authorization chokepoint and approval service.
 *   authorizeRoleAction  is how the promoted role acts, inside its declared
 *                        ceilings and under the per-role stop button.
 *
 * There is no other way in. A role that has not been promoted throws
 * `role.not_promoted`, and one asked to exceed its declared ceiling throws
 * `role.ceiling_exceeded`.
 */

export * from "./types.js";
export * from "./port.js";
export * from "./actions.js";
export * from "./registry.js";
export * from "./authoring.js";
export * from "./evaluation.js";
export * from "./promotion.js";
export * from "./bias.js";
export * from "./store.memory.js";
export * from "./store.pg.js";
export { MIGRATIONS as ROLE_MIGRATIONS } from "./migrations.js";
