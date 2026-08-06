import type { ActionDefinition } from "../guard/registry.js";

/**
 * Action names this module performs.
 *
 * `improvement.apply` and `improvement.revert` are already in the platform
 * catalogue (`src/actions.ts`) and are **not** redeclared here — the tiers they
 * carry there are the ones that matter, and a second declaration would be two
 * places to change one classification. This file adds the three that produce
 * evidence and nothing else, so they are registerable while they move into the
 * catalogue beside the rest.
 *
 * All three are `routine`, and that is deliberate rather than lax. None of them
 * has an external effect: recording that a person corrected something, drafting
 * an inert description of a change, and measuring that description against a
 * golden set are all writes to the platform's own record. The routine tier is
 * also the only one permitted in shadow mode, which is exactly where the loop
 * should be able to run — a platform that cannot learn while it is proving
 * itself in shadow is a platform that arrives at go-live with nothing learned.
 *
 * The consequential half of this module — `improvement.apply` — is
 * `high_consequence` with an approval gate, because it changes what the
 * platform will do without further review. That is the one place a human
 * decision is required, and ADR 0011 records that there is no configuration
 * which removes it.
 */

/** Record a human correction, rejection, override, escalation, or disagreement. */
export const OBSERVE_ACTION = "improvement.observe";

/** Draft a candidate change. Produces inert data; changes nothing. */
export const PROPOSE_ACTION = "improvement.propose";

/** Measure a candidate change against the affected role's golden set. */
export const EVALUATE_ACTION = "improvement.evaluate";

/** Apply an approved change. Declared in the platform catalogue. */
export const APPLY_ACTION = "improvement.apply";

/** Roll an applied change back to its snapshot. Declared in the catalogue. */
export const REVERT_ACTION = "improvement.revert";

/**
 * The name of the prohibited action that exists so the refusal is explicit.
 *
 * Declared in the platform catalogue as `prohibited`, which the chokepoint
 * refuses unconditionally. Referenced here so this module's tests can prove
 * that the refusal is real rather than rhetorical.
 */
export const APPLY_WITHOUT_APPROVAL_ACTION = "improvement.apply_without_approval";

export const IMPROVEMENT_ACTIONS: readonly ActionDefinition[] = [
  {
    name: OBSERVE_ACTION,
    risk: "routine",
    description:
      "Record a human correction, rejected proposal, approval override, escalation, or shadow-mode disagreement against the run that produced it.",
    reversible: true,
    allowedRoles: [
      "owner_services_agent",
      "supervisor",
      "compliance_reviewer",
      "association_manager",
      "platform_admin",
      "system",
    ],
  },
  {
    name: PROPOSE_ACTION,
    risk: "routine",
    description:
      "Draft a candidate change to a declarative artifact. The result is inert data with no way to apply itself.",
    reversible: true,
    allowedRoles: ["supervisor", "compliance_reviewer", "platform_admin", "system"],
  },
  {
    name: EVALUATE_ACTION,
    risk: "routine",
    description:
      "Measure a candidate change against the affected role's golden set. Produces evidence, not an effect.",
    reversible: true,
    allowedRoles: ["supervisor", "compliance_reviewer", "platform_admin", "system"],
  },
];
