import type { ActionDefinition } from "../guard/registry.js";

/**
 * Action names this module performs, and the descriptors the platform
 * catalogue does not yet carry.
 *
 * `src/actions.ts` already declares the two generation actions. The three
 * template-lifecycle actions live here for now, following the convention
 * `knowledge/actions.ts` uses: the array should shrink to empty as the entries
 * move into the catalogue, which is where a risk reviewer reads the whole
 * capability surface at once.
 */

/** Generate a document nobody outside MVW will see. Declared in the catalogue. */
export const GENERATE_INTERNAL_ACTION = "document.generate_internal";

/** Generate a document an owner will see. Declared in the catalogue. */
export const GENERATE_OWNER_FACING_ACTION = "document.generate_owner_facing";

export const REGISTER_TEMPLATE_ACTION = "document.register_template";
export const APPROVE_TEMPLATE_ACTION = "document.approve_template";
export const RETIRE_TEMPLATE_ACTION = "document.retire_template";

export const DOCUMENT_ACTIONS: readonly ActionDefinition[] = [
  {
    name: REGISTER_TEMPLATE_ACTION,
    // A draft has no effect: nothing can be generated from it until it is
    // approved, and approval is where the people are. Gating registration would
    // put an approval in front of writing a first draft, which teaches everyone
    // that approvals are paperwork.
    risk: "sensitive",
    description: "Register a new draft version of a document template.",
    reversible: true,
    allowedRoles: ["compliance_reviewer", "supervisor", "association_manager", "platform_admin"],
  },
  {
    name: APPROVE_TEMPLATE_ACTION,
    // Deliberately not `high_consequence`, and the reason is worth stating: a
    // high-consequence action requires a guard approval, and this action *is*
    // an approval. Requiring an approval to record an approval would produce
    // two records of one human decision and an obvious circularity.
    //
    // The controls that matter are applied instead by the registry itself:
    // distinct approvers, no self-approval, and binding to the digest of the
    // body that was read. Step-up re-authentication is required here because
    // this is the act that lets text reach an owner.
    risk: "sensitive",
    description:
      "Approve or reject a draft template version. Approving makes that version immutable and usable.",
    reversible: true,
    requiresStepUp: true,
    allowedRoles: ["compliance_reviewer", "supervisor", "platform_admin"],
  },
  {
    name: RETIRE_TEMPLATE_ACTION,
    // Taking a template out of service is a stop action, so it is deliberately
    // easier than putting one in: withdrawing a defective disclosure should
    // never wait for a second signature.
    risk: "sensitive",
    description: "Retire an approved template version so nothing new may be generated from it.",
    reversible: true,
    allowedRoles: ["compliance_reviewer", "supervisor", "platform_admin"],
  },
];
