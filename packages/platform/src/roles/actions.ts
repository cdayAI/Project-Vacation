import type { ActionDefinition } from "../guard/registry.js";

/**
 * Action names this module performs, and the descriptors the platform
 * catalogue does not yet carry.
 *
 * The canonical catalogue is `src/actions.ts`, and it already declares
 * `role.promote` — the one action here that changes what the platform will do
 * without further review, classified `high_consequence` with an approval gate.
 * This file adds the three lifecycle actions around it and exists so they are
 * registerable while they move into the catalogue beside the rest.
 *
 * Two classifications here are deliberate and would be wrong if copied
 * thoughtlessly:
 *
 * `role.revert` is `sensitive`, not `high_consequence`. Rolling a role back to
 * a version that was already evaluated and already approved restores a state
 * the company has previously accepted. Putting an approval gate in front of it
 * would mean an operator watching a bad role misbehave while they wait for a
 * second signature — the same reasoning that keeps `containment.engage` out of
 * the high-consequence tier. `promotion.ts` additionally refuses to revert to
 * a version that was never promoted, so this cannot be used as a promotion
 * with the gate removed.
 *
 * `role.evaluate` is `routine` despite spending real money, because an
 * evaluation produces evidence and has no external effect — and because the
 * routine tier is the only one permitted in shadow mode, which is exactly
 * where an unproven role should be measured. Cost is bounded by the run's
 * spend ceiling, which is the control that actually fits the concern.
 */

/** Promote a role version so it may act. Declared in the platform catalogue. */
export const PROMOTE_ROLE_ACTION = "role.promote";

/** Submit a drafted version for promotion. Changes nothing about what can act. */
export const PROPOSE_ROLE_ACTION = "role.propose";

/** Roll a role back to a version that was previously promoted. */
export const REVERT_ROLE_ACTION = "role.revert";

/** Run a role version against a golden set and record the results. */
export const EVALUATE_ROLE_ACTION = "role.evaluate";

export const ROLE_ACTIONS: readonly ActionDefinition[] = [
  {
    name: PROPOSE_ROLE_ACTION,
    risk: "sensitive",
    description:
      "Submit a drafted role version for promotion. Records the proposal; the role still cannot act.",
    reversible: true,
    allowedRoles: ["platform_admin", "supervisor", "compliance_reviewer"],
  },
  {
    name: EVALUATE_ROLE_ACTION,
    risk: "routine",
    description:
      "Run a role version against its golden set and record the measured results. Produces evidence, not an effect.",
    reversible: true,
    allowedRoles: ["platform_admin", "supervisor", "compliance_reviewer", "system"],
  },
  {
    name: REVERT_ROLE_ACTION,
    risk: "sensitive",
    description:
      "Roll a role back to a version that was previously promoted. Deliberately not gated on a second approver: undoing a bad change should never wait.",
    reversible: true,
    allowedRoles: ["platform_admin", "supervisor", "compliance_reviewer"],
  },
];
