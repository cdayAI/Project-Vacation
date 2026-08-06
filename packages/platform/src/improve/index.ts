/**
 * The improvement loop.
 *
 * **The platform gets measurably better over time, and it never changes its own
 * behaviour on its own authority.** Everything in this module serves one of
 * those two sentences, and the second one is why the module is shaped the way
 * it is.
 *
 * The seven stages, and what each one refuses:
 *
 *   `harvest`   Every human correction, rejected proposal, approval override,
 *               escalation, and shadow-mode disagreement becomes a structured
 *               observation tied to the run that produced it. Refuses an
 *               observation with no run behind it, and deduplicates so a retry
 *               cannot inflate a failure's frequency.
 *
 *   `cluster`   Recurring patterns, ranked by frequency and cost, with the
 *               evidence attached. Pure and deterministic; never stored, so a
 *               cluster cannot drift from the observations it summarises.
 *
 *   `propose`   A candidate change to a declarative artifact. **Inert data**:
 *               no `apply`, no `execute`, frozen on the way out. Refuses a
 *               target that is not on the artifact allowlist, an identifier
 *               shaped like a file, content carrying prompt text, a binding to
 *               a prompt that is not in version control, a golden-set change
 *               that weakens existing ground truth, and a proposal citing
 *               evidence that is not in the record.
 *
 *   `evaluate`  Every proposal is measured against the affected role's golden
 *               set **before a human sees it**, and one that does not improve
 *               measured quality is never offered. Refuses a trial whose two
 *               runs were measured against different cases.
 *
 *   `approve`   A person with authority decides, through the ordinary
 *               `Authorizer` and `ApprovalService`, having seen the before and
 *               after, the evaluation delta, and the blast radius — which roles,
 *               which workflows, how many runs — counted from the operating
 *               record.
 *
 *   `apply`     Requires an approval id resolving to a granted, unconsumed,
 *               digest-matching approval. Takes a snapshot, records
 *               `improvement.applied`, and can be reverted to the prior state in
 *               one action. Every refusal is recorded as `improvement.refused`.
 *
 *   `watch`     Post-change quality against the pre-change baseline, from the
 *               golden set and from the correction rate in the operating record.
 *               A regression alerts and **offers** the revert; it does not take
 *               it, because an automatic rollback is still the platform acting
 *               on its own authority.
 *
 * Three boundaries are enforced rather than documented, and each has tests that
 * attempt to cross it:
 *
 *   **No autonomous application.** There is no configuration that disables the
 *   gate — no flag, no environment variable, no test-only bypass. See ADR 0011.
 *
 *   **No self-modifying code.** The loop changes declarative artifacts:
 *   prompt bindings, routing, guardrail rules, corpus gaps, evaluation cases.
 *   The allowlist is closed and a target that names a file is refused.
 *
 *   **The evaluation sets are protected.** A proposal may add cases; it may
 *   never weaken, relabel, or delete an existing expected outcome. Enforced by
 *   the guard `roles/evaluation.ts` exports, run when a proposal is drafted and
 *   again at the moment it is applied — otherwise the cheapest way for the loop
 *   to improve its score is to move the goalposts, and it would find that path.
 *
 * One wiring obligation, stated rather than assumed: the head of a governed
 * artifact is the value the deployment is meant to read at runtime. This module
 * sits above the modules that would consume those values, so the readers reach
 * down to the artifact store themselves. Nothing here can force that.
 */

export * from "./types.js";
export * from "./port.js";
export * from "./actions.js";
export * from "./artifacts.js";
export * from "./harvest.js";
export * from "./cluster.js";
export * from "./propose.js";
export * from "./evaluate.js";
export * from "./approve.js";
export * from "./apply.js";
export * from "./watch.js";
export * from "./store.memory.js";
export * from "./store.pg.js";
export { MIGRATIONS as IMPROVEMENT_MIGRATIONS } from "./migrations.js";
