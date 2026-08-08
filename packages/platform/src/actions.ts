import type { ActionDefinition } from "./guard/registry.js";
import { EXTERNAL_AGENT_ACTIONS } from "./external/enrollment.js";
import { IMPROVEMENT_ACTIONS } from "./improve/actions.js";

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
 *
 * **Every action states `requiresStepUp` beside its risk tier.** Step-up is
 * re-authentication within the last `PV_STEP_UP_MAX_AGE_SECONDS`, and it is
 * demanded at one moment: when a person grants an approval. High-consequence
 * actions require it, because that grant is the last thing standing between a
 * proposal and an irreversible effect. Sensitive and routine ones do not — a
 * step-up in front of a read teaches people to re-authenticate without reading
 * the prompt, and a prompt nobody reads is evidence of nothing.
 *
 * The field is declared here rather than left to the tier default in
 * `guard/registry.ts`, because it decides whether an approval can be granted at
 * all. Read as an unset field it says nothing, and it was: `requiresStepUp`
 * appeared nowhere in this file, the API defaulted a missing descriptor to
 * `true`, and the whole question of which actions deserve a second proof of
 * identity had no answer anybody could read. It is one line next to the tier it
 * follows from, so a reviewer sees the classification and its consequence
 * together.
 *
 * **Anything that parks for a human decision also declares `approvalGuidance`.**
 * That is the text the approval screen renders: the ask in plain language, the
 * concrete effects of saying yes, what happens instead on a rejection, and how
 * the effect is undone. It lives here rather than in the console because a
 * consequence is a governance statement — the same reviewer who signs off the
 * risk tier should be reading the sentence the approver will see, and two
 * screens must not be able to describe one action differently.
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
    requiresStepUp: false,
  },
  {
    name: "record.read_cost",
    risk: "routine",
    description: "Read cost figures for a run, workflow, or department.",
    reversible: true,
    allowedRoles: [SUPERVISOR, FINANCE, ADMIN, AUDITOR, SYSTEM],
    requiresStepUp: false,
  },
  {
    name: "audit.read",
    risk: "routine",
    description: "Read the audit chain and its verification status.",
    reversible: true,
    allowedRoles: [COMPLIANCE, ADMIN, AUDITOR, SYSTEM],
    requiresStepUp: false,
  },
  {
    name: "knowledge.retrieve",
    risk: "routine",
    description: "Retrieve passages from a governed corpus, with provenance.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, ASSOCIATION, SYSTEM],
    requiresStepUp: false,
  },
  {
    name: "timeline.compute_deadline",
    risk: "routine",
    description:
      "Compute a statutory deadline and its full derivation. Produces evidence, not an effect.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, SYSTEM],
    requiresStepUp: false,
  },
  {
    name: "model.invoke_draft",
    risk: "routine",
    description: "Invoke a model to produce a draft that no one but a reviewer will see.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, ASSOCIATION, SYSTEM],
    requiresStepUp: false,
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
    requiresStepUp: false,
    integration: "contract-records",
  },
  {
    name: "contract.flag_for_review",
    risk: "sensitive",
    description: "Flag a contract for compliance review and place it on a human queue.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, SYSTEM],
    requiresStepUp: false,
  },
  {
    name: "association.read_records",
    risk: "sensitive",
    description: "Read association budget and reserve data from the system of record.",
    reversible: true,
    allowedRoles: [ASSOCIATION, FINANCE, SYSTEM],
    requiresStepUp: false,
    integration: "association-records",
  },
  {
    name: "document.generate_internal",
    risk: "sensitive",
    description:
      "Generate an internal document, such as an association board pack. Not seen by a consumer.",
    reversible: true,
    allowedRoles: [ASSOCIATION, SUPERVISOR, FINANCE, SYSTEM],
    requiresStepUp: false,
  },
  {
    name: "knowledge.ingest_document",
    risk: "sensitive",
    description:
      "Ingest a document into a governed corpus after screening, classification, and scoping.",
    reversible: true,
    allowedRoles: [COMPLIANCE, ADMIN],
    requiresStepUp: false,
  },
  {
    name: "consent.record",
    risk: "sensitive",
    description: "Record a consent or revocation event with its provenance.",
    reversible: true,
    allowedRoles: [AGENT, SUPERVISOR, COMPLIANCE, SYSTEM],
    requiresStepUp: false,
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
    requiresStepUp: true,
    approvalsRequired: 1,
    integration: "messaging",
    approvalGuidance: {
      ask: "Send a message to an owner",
      effects: [
        "The message leaves the platform through the messaging integration and reaches the owner.",
        "The contact compliance gate is consulted first: a suppressed destination or a quiet-hours window refuses the send even after this approval.",
        "The message, its template version, and this approval are written to the operating record as one linked event.",
      ],
      ifRejected:
        "Nothing is sent. The case returns to the owner-services queue with the rejection reason attached, and the reason is captured as improvement signal.",
      reversal:
        "A sent message cannot be recalled. The only remedy is a second, corrective message, which is itself a new approval.",
    },
  },
  {
    name: "document.generate_owner_facing",
    risk: "high_consequence",
    description: "Generate a document that will be delivered to an owner.",
    reversible: false,
    allowedRoles: [SUPERVISOR, COMPLIANCE],
    requiresStepUp: true,
    approvalsRequired: 1,
    approvalGuidance: {
      ask: "Produce a document an owner will receive",
      effects: [
        "The document is rendered from the approved template at the version named in the proposal and stored against the case.",
        "It becomes deliverable: the delivery step that follows does not ask again.",
        "The rendered document's digest is bound to this approval, so a document altered afterwards cannot be delivered under it.",
      ],
      ifRejected:
        "No document is produced. The case stays where it is and the drafting step can be re-run with different inputs.",
      reversal:
        "A document that has not yet been delivered can be superseded by a new version. Once it has left the platform it cannot be withdrawn.",
    },
  },
  {
    name: "owner.export_data",
    risk: "high_consequence",
    description:
      "Export an owner's personal data, for a subject-rights request. Two approvers, because the data leaves the platform.",
    reversible: false,
    allowedRoles: [COMPLIANCE, ADMIN],
    requiresStepUp: true,
    approvalsRequired: 2,
    approvalGuidance: {
      ask: "Export one owner's personal data out of the platform",
      effects: [
        "A package containing that owner's personal data is assembled and made available for delivery to the requester.",
        "The data leaves this platform's boundary; from that point its handling is governed by the receiving process, not by this one.",
        "The export, its scope, and both approvers are recorded against the subject-rights request.",
      ],
      ifRejected:
        "No package is assembled. The subject-rights request stays open and the statutory response clock keeps running, so a rejection needs a same-day alternative.",
      reversal:
        "An export cannot be recalled once delivered. Before delivery the package can be destroyed and the request restarted.",
    },
  },
  {
    name: "owner.delete_data",
    risk: "high_consequence",
    description: "Delete an owner's personal data in fulfilment of a subject-rights request.",
    reversible: false,
    allowedRoles: [COMPLIANCE, ADMIN],
    requiresStepUp: true,
    approvalsRequired: 2,
    approvalGuidance: {
      ask: "Delete one owner's personal data",
      effects: [
        "The owner's personal data is deleted from the systems named in the proposal.",
        "Records the platform is required to retain — the audit chain and the operating record — keep opaque references only, never the deleted content.",
        "Any workflow still relying on that data will refuse rather than proceed on a partial record.",
      ],
      ifRejected:
        "Nothing is deleted. The request stays open with the rejection reason attached, which is itself disclosable to the data subject.",
      reversal:
        "Deletion is permanent by design. There is no restore path, because a restorable deletion would not satisfy the right it exists to honour.",
    },
  },
  {
    name: "role.promote",
    risk: "high_consequence",
    description:
      "Promote a role version so it may act. Changes what the platform will do without further review.",
    reversible: true,
    allowedRoles: [ADMIN, SUPERVISOR],
    requiresStepUp: true,
    approvalsRequired: 1,
    changesPlatformBehaviour: true,
    approvalGuidance: {
      ask: "Let a new version of a role act",
      effects: [
        "Every future run of this role uses the promoted version's prompt, tools, data scopes, and risk ceiling.",
        "Runs already in flight finish on the version they started with; nothing changes underneath them.",
        "The promoted version's evaluation result is pinned to the promotion, so what it scored at promotion time stays readable afterwards.",
      ],
      ifRejected:
        "The role keeps acting on its current version. The proposed version stays as a draft and can be revised and re-submitted.",
      reversal:
        "Revert to the previous version from the role's version list. The reverted version stays in the history — what was live between two dates is a question an incident review asks.",
    },
  },
  {
    name: "improvement.apply",
    risk: "high_consequence",
    description:
      "Apply an improvement proposal. Changes the platform's behaviour; there is no configuration that removes this gate.",
    reversible: true,
    allowedRoles: [ADMIN, SUPERVISOR, COMPLIANCE],
    requiresStepUp: true,
    approvalsRequired: 1,
    changesPlatformBehaviour: true,
    approvalGuidance: {
      ask: "Change how the platform behaves",
      effects: [
        "The proposed value replaces the current head of the named artifact, and every run reading it from that moment uses the new value.",
        "A snapshot of the value being replaced is taken first, so the change can be undone in one action.",
        "The change is watched afterwards against its pre-change baseline; a regression alerts and offers the revert rather than taking it.",
      ],
      ifRejected:
        "The artifact is untouched. The proposal is closed and the rejection is recorded against the failure cluster that produced it.",
      reversal:
        "Revert to the snapshot taken at apply time, through `improvement.revert`, which needs no second approver.",
    },
  },
  {
    name: "improvement.revert",
    risk: "sensitive",
    description:
      "Revert a previously applied improvement. Deliberately easier than applying one: undoing a bad change should never wait for a second approver.",
    reversible: true,
    allowedRoles: [ADMIN, SUPERVISOR, COMPLIANCE],
    requiresStepUp: false,
    changesPlatformBehaviour: true,
  },
  {
    name: "identity.issue_service_credential",
    risk: "high_consequence",
    description: "Issue a machine credential.",
    reversible: true,
    allowedRoles: [ADMIN],
    requiresStepUp: true,
    approvalsRequired: 1,
    changesPlatformBehaviour: true,
    approvalGuidance: {
      ask: "Issue a credential to a machine caller",
      effects: [
        "A credential is minted and shown once. The platform stores a hash and can never show the value again.",
        "The holder can act under the grant named in the proposal, up to its expiry, until it is revoked.",
        "Every use of it is attributed to the named service in the operating record and the audit chain.",
      ],
      ifRejected:
        "No credential is minted and the caller stays unable to reach the platform. Anything waiting on it stays blocked.",
      reversal:
        "Revoke the credential. Revocation takes effect at the next admission check, and a new credential can be issued at any time.",
    },
  },
  {
    name: "discovery.enroll_device",
    risk: "high_consequence",
    description:
      "Enrol a person and device for work-discovery observation. Requires the employment-law prerequisites to have been satisfied in writing.",
    reversible: true,
    allowedRoles: [ADMIN],
    requiresStepUp: true,
    approvalsRequired: 2,
    changesPlatformBehaviour: true,
    approvalGuidance: {
      ask: "Begin observing a named employee's device",
      effects: [
        "The named person's device begins producing work-discovery observations, within the deployment's data boundary and never to a model provider.",
        "Observation starts only after the employment-law prerequisites recorded on this request have been satisfied in writing.",
        "Anything discovered is inert: it becomes a draft candidate and cannot be activated from the discovery screens.",
      ],
      ifRejected:
        "No observation begins. The person's device is untouched and the enrolment request is closed.",
      reversal:
        "Un-enrol the device. Observation stops at the next check-in, and observations already recorded are removed under the retention schedule for discovery data.",
    },
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
    requiresStepUp: false,
  },
  {
    name: "containment.release",
    risk: "sensitive",
    description: "Resume work after a containment switch was engaged.",
    reversible: true,
    allowedRoles: [SUPERVISOR, COMPLIANCE, ADMIN],
    requiresStepUp: false,
  },

  // ---------------------------------------------------------------------
  // Prohibited. Refused unconditionally; no configuration enables these.
  //
  // They are listed rather than merely absent so the refusal is visible to a
  // reviewer, and so an attempt to perform one is refused with a reason instead
  // of an "unknown action" error that reads like an oversight.
  //
  // These are the only entries that state no `requiresStepUp`, and the omission
  // is the honest reading: there is no approval to grant and no path that
  // performs one, so a boolean either way would describe a decision nobody can
  // reach. `true` would imply a re-authentication makes this possible.
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
  //
  // Both spliced-in groups declare their tiers in their own modules and state
  // no `requiresStepUp`, so `defineAction` derives it from the tier — the same
  // policy the entries above write out. Enrolling and revoking an external
  // agent are high-consequence and therefore require step-up; the rest do not.
  // ---------------------------------------------------------------------
  ...EXTERNAL_AGENT_ACTIONS,

  // ---------------------------------------------------------------------
  // The improvement loop's evidence-producing actions.
  //
  // `improvement.apply` and `improvement.revert` are declared above, where
  // their tiers belong. These three produce evidence and nothing else, and
  // they are spliced in here because the chokepoint refuses an action it
  // cannot find — which meant that until now the console had no way to record
  // a correction against a step, however carefully the loop below it was
  // built. See improve/actions.ts.
  // ---------------------------------------------------------------------
  ...IMPROVEMENT_ACTIONS,
];
