import type { ActionDefinition } from "./guard/registry.js";
import { EXTERNAL_AGENT_ACTIONS } from "./external/enrollment.js";

/**
 * The action registry contents.
 *
 * Every effect this platform can produce is declared here, once, with its risk
 * tier stated explicitly. The authorization chokepoint resolves actions through
 * this list and refuses anything it does not find, so adding a capability is a
 * deliberate, reviewable entry in source control rather than a new call site
 * that quietly works.
 *
 * This file is where a reviewer — including MVW's risk committee — can read the
 * complete list of things the platform is capable of doing, and what human
 * involvement each one carries. That is why it is one flat file rather than
 * scattered registrations near each call site: the value is in being able to
 * read it all at once.
 *
 * How to classify a new action:
 *
 *   routine           No external effect, or trivially reversible. Reading from
 *                     the operating record. Retrieval. Drafting.
 *   sensitive         A real effect, reversible with effort, no direct consumer
 *                     consequence. Writing internal records. Calling a system of
 *                     record. Generating an internal document.
 *   high_consequence  Irreversible, consumer-facing, legally significant, or
 *                     expensive. Anything an owner sees. Anything that changes
 *                     what the platform itself will do next.
 *   prohibited        Never permitted, whatever the configuration says.
 *
 * When in doubt, classify higher. The cost of an unnecessary approval is a few
 * seconds of a supervisor's attention. The cost of an unapproved consumer-facing
 * action is a regulatory finding.
 */

const AGENT = "owner_services_agent";
const SUPERVISOR = "supervisor";
const COMPLIANCE = "compliance_reviewer";
const ASSOCIATION = "association_manager";
const FINANCE = "finance";
const ADMIN = "platform_admin";
const AUDITOR = "auditor";
/** The platform acting on its own behalf inside a workflow step. */
const SYSTEM = "system";

export const PLATFORM_ACTIONS: readonly ActionDefinition[] = [
  // ---------------------------------------------------------------------
  // Reading. Routine, and the only actions permitted in shadow mode, because
  // shadow mode's whole point is that nothing lands.
  // ---------------------------------------------------------------------
  {
    name: "record.read_run",
    risk: "routine",
    description: "Read a run and its step trail from the operating record.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, ASSOCIATION, FINANCE, ADMIN, AUDITOR, SYSTEM],
  },
  {
    name: "record.read_cost",
    risk: "routine",
    description: "Read cost figures for a run, workflow, or department.",
    reversible: true,
    allowedRoles: [SUPERVISOR, FINANCE, ADMIN, AUDITOR, SYSTEM],
  },
  {
    name: "audit.read",
    risk: "routine",
    description: "Read the audit chain and its verification status.",
    reversible: true,
    allowedRoles: [COMPLIANCE, ADMIN, AUDITOR, SYSTEM],
  },
  {
    name: "knowledge.retrieve",
    risk: "routine",
    description: "Retrieve passages from a governed corpus, with provenance.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, ASSOCIATION, SYSTEM],
  },
  {
    name: "timeline.compute_deadline",
    risk: "routine",
    description:
      "Compute a statutory deadline and its full derivation. Produces evidence, not an effect.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, SYSTEM],
  },
  {
    name: "model.invoke_draft",
    risk: "routine",
    description: "Invoke a model to produce a draft that no one but a reviewer will see.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, ASSOCIATION, SYSTEM],
  },

  // ---------------------------------------------------------------------
  // Real effects, no direct consumer consequence.
  // ---------------------------------------------------------------------
  {
    name: "contract.check_rescission",
    risk: "sensitive",
    description:
      "Check a contract's rescission window against effective-dated authority and record the finding.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, SYSTEM],
    integration: "contract-records",
  },
  {
    name: "contract.flag_for_review",
    risk: "sensitive",
    description: "Flag a contract for compliance review and place it on a human queue.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, SYSTEM],
  },
  {
    name: "association.read_records",
    risk: "sensitive",
    description: "Read association budget and reserve data from the system of record.",
    reversible: true,
    allowedRoles: [ASSOCIATION, FINANCE, SYSTEM],
    integration: "association-records",
  },
  {
    name: "document.generate_internal",
    risk: "sensitive",
    description:
      "Generate an internal document, such as an association board pack. Not seen by a consumer.",
    reversible: true,
    allowedRoles: [ASSOCIATION, SUPERVISOR, FINANCE, SYSTEM],
  },
  {
    name: "knowledge.ingest_document",
    risk: "sensitive",
    description:
      "Ingest a document into a governed corpus after screening, classification, and scoping.",
    reversible: true,
    allowedRoles: [COMPLIANCE, ADMIN],
  },
  {
    name: "consent.record",
    risk: "sensitive",
    description: "Record a consent or revocation event with its provenance.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, SYSTEM],
  },

  // ---------------------------------------------------------------------
  // High consequence. Every one of these requires a human decision before the
  // effect lands, and step-up re-authentication.
  // ---------------------------------------------------------------------
  {
    name: "contact.send_owner_message",
    risk: "high_consequence",
    description:
      "Send a message to an owner. Passes the contact gate and requires approval; a sent message cannot be unsent.",
    reversible: false,
    allowedRoles: [SUPERVISOR],
    approvalsRequired: 1,
    integration: "messaging",
  },
  {
    name: "document.generate_owner_facing",
    risk: "high_consequence",
    description: "Generate a document that will be delivered to an owner.",
    reversible: false,
    allowedRoles: [SUPERVISOR, COMPLIANCE],
    approvalsRequired: 1,
  },
  {
    name: "owner.export_data",
    risk: "high_consequence",
    description:
      "Export an owner's personal data, for a subject-rights request. Two approvers, because the data leaves the platform.",
    reversible: false,
    allowedRoles: [COMPLIANCE, ADMIN],
    approvalsRequired: 2,
  },
  {
    name: "owner.delete_data",
    risk: "high_consequence",
    description: "Delete an owner's personal data in fulfilment of a subject-rights request.",
    reversible: false,
    allowedRoles: [COMPLIANCE, ADMIN],
    approvalsRequired: 2,
  },
  {
    name: "role.promote",
    risk: "high_consequence",
    description:
      "Promote a role version so it may act. Changes what the platform will do without further review.",
    reversible: true,
    allowedRoles: [ADMIN, SUPERVISOR],
    approvalsRequired: 1,
  },
  {
    name: "improvement.apply",
    risk: "high_consequence",
    description:
      "Apply an improvement proposal. Changes the platform's behaviour; there is no configuration that removes this gate.",
    reversible: true,
    allowedRoles: [ADMIN, SUPERVISOR, COMPLIANCE],
    approvalsRequired: 1,
  },
  {
    name: "improvement.revert",
    risk: "sensitive",
    description:
      "Revert a previously applied improvement. Deliberately easier than applying one: undoing a bad change should never wait for a second approver.",
    reversible: true,
    allowedRoles: [ADMIN, SUPERVISOR, COMPLIANCE],
  },
  {
    name: "identity.issue_service_credential",
    risk: "high_consequence",
    description: "Issue a machine credential.",
    reversible: true,
    allowedRoles: [ADMIN],
    approvalsRequired: 1,
  },
  {
    name: "discovery.enroll_device",
    risk: "high_consequence",
    description:
      "Enrol a person and device for work-discovery observation. Requires the employment-law prerequisites to have been satisfied in writing.",
    reversible: true,
    allowedRoles: [ADMIN],
    approvalsRequired: 2,
  },

  // ---------------------------------------------------------------------
  // Containment. Deliberately NOT high-consequence.
  //
  // Engaging a stop button is a safety action under time pressure, and putting
  // an approval gate in front of it would mean an operator watching bad output
  // reach owners while they wait for a second signature. Releasing is the same
  // tier for symmetry, but every engage and release is recorded with a typed
  // reason, so the accountability is after the fact rather than before it.
  // ---------------------------------------------------------------------
  {
    name: "containment.engage",
    risk: "sensitive",
    description: "Stop work: globally, or for one workflow, role, or integration.",
    reversible: true,
    allowedRoles: [SUPERVISOR, COMPLIANCE, ADMIN],
  },
  {
    name: "containment.release",
    risk: "sensitive",
    description: "Resume work after a containment switch was engaged.",
    reversible: true,
    allowedRoles: [SUPERVISOR, COMPLIANCE, ADMIN],
  },

  // ---------------------------------------------------------------------
  // Prohibited. Refused unconditionally; no configuration enables these.
  //
  // They are listed rather than merely absent so the refusal is visible to a
  // reviewer, and so an attempt to perform one is refused with a reason instead
  // of an "unknown action" error that reads like an oversight.
  // ---------------------------------------------------------------------
  {
    name: "model.train_on_owner_data",
    risk: "prohibited",
    description:
      "Train or fine-tune a model on owner data. Never permitted by this platform.",
    reversible: false,
    allowedRoles: [],
    humanInvolvement: "human_only",
  },
  {
    name: "payment.capture_card",
    risk: "prohibited",
    description:
      "Accept or store a primary account number. The platform is designed to stay outside PCI scope; payment is handed to MVW's systems by reference.",
    reversible: false,
    allowedRoles: [],
    humanInvolvement: "human_only",
  },
  {
    name: "improvement.apply_without_approval",
    risk: "prohibited",
    description:
      "Apply a behaviour change with no recorded human decision. Listed so the refusal is explicit rather than implied by absence.",
    reversible: false,
    allowedRoles: [],
    humanInvolvement: "human_only",
  },
  {
    name: "audit.modify_entry",
    risk: "prohibited",
    description:
      "Alter or delete an audit entry. There is no code path, and the database refuses it as well.",
    reversible: false,
    allowedRoles: [],
    humanInvolvement: "human_only",
  },

  // ---------------------------------------------------------------------
  // The external-agent lifecycle, defined next to the plane it governs and
  // spliced in here so that this file remains the one list a reviewer reads.
  // Governing an agent MVW already has is an effect this platform produces
  // like any other, and it is refused if it is not in this registry.
  // ---------------------------------------------------------------------
  ...EXTERNAL_AGENT_ACTIONS,
];
