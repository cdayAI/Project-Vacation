import type { ActionDefinition } from "../guard/registry.js";

/**
 * Action names this module performs, and the descriptors the platform
 * catalogue does not yet carry.
 *
 * The canonical catalogue is `src/actions.ts`, and it already declares
 * `consent.record` and `contact.send_owner_message`. This module holds the two
 * it does not, following the same convention `knowledge/actions.ts` uses: the
 * array should shrink to empty as the entries move into the catalogue, where a
 * risk reviewer can read the whole capability surface in one place.
 */

/** Record a consent grant or a revocation. Declared in the platform catalogue. */
export const RECORD_CONSENT_ACTION = "consent.record";

/** The standard outbound path. Declared in the platform catalogue. */
export const SEND_MESSAGE_ACTION = "contact.send_owner_message";

/** The elevated outbound path: two approvers instead of one. */
export const SEND_HIGH_RISK_MESSAGE_ACTION = "contact.send_high_risk_message";

/** Add an owner or a destination to a suppression list. */
export const RECORD_DO_NOT_CALL_ACTION = "contact.record_do_not_call";

export const CONTACT_ACTIONS: readonly ActionDefinition[] = [
  {
    name: SEND_HIGH_RISK_MESSAGE_ACTION,
    risk: "high_consequence",
    description:
      "Send an owner message on the elevated path: collections or marketing purpose, a live call, model-written content, or a recipient who is not the owner. Two approvers.",
    // A sent message cannot be unsent. That is a fact about the world, not a
    // classification choice, and the registry refuses to let an irreversible
    // action be automatic.
    reversible: false,
    // Compliance is added alongside supervisors here, and only here. The
    // elevated band is where a second pair of eyes should be a compliance
    // reviewer's rather than a second operations manager's.
    allowedRoles: ["supervisor", "compliance_reviewer"],
    approvalsRequired: 2,
    integration: "messaging",
    approvalGuidance: {
      ask: "Send an owner message on the elevated path",
      effects: [
        "The message reaches the owner through the messaging integration, on a collections or marketing purpose, a live call, or model-written content.",
        "The contact compliance gate is consulted at send time: a suppression, a quiet-hours window, or a revoked consent refuses it even after both approvals.",
        "Two approvers are recorded against the send, and the second may not be the first.",
      ],
      ifRejected:
        "Nothing is sent. The contact attempt is closed with the rejection reason, and the reason is captured as improvement signal.",
      reversal:
        "A sent message cannot be recalled. On the elevated path a corrective follow-up is itself an elevated send and needs two approvers again.",
    },
  },
  {
    name: RECORD_DO_NOT_CALL_ACTION,
    // Deliberately not high-consequence, and deliberately without an approval
    // gate. Suppressing contact is a *stop* action: making an owner's "do not
    // call me again" wait for a second signature would mean calling them again
    // while it waited. Accountability for a suppression is after the fact —
    // every entry is recorded with its source — because the failure mode of
    // delay is worse than the failure mode of an over-broad suppression.
    //
    // There is no matching "lift" action anywhere in this module. A suppression
    // expires on the date it was recorded with, or it does not expire at all.
    risk: "sensitive",
    description:
      "Add an owner reference or a destination fingerprint to a do-not-call suppression list.",
    reversible: true,
    allowedRoles: [
      "owner_services_agent",
      "supervisor",
      "compliance_reviewer",
      "platform_admin",
      "system",
    ],
  },
];
