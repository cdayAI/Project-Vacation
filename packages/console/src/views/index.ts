/**
 * The console's surfaces.
 *
 * -----------------------------------------------------------------------------
 * COVERAGE RULE — read before adding a file to this directory.
 *
 * tools/check-accessibility-coverage.mjs walks every .tsx in this directory and
 * fails the build unless some test file names it and runs an automated
 * accessibility assertion. Adding a view without a test is not a warning; it
 * stops the build. That is deliberate — an accessibility gate that can be
 * skipped is a gate that rots quietly while the badge stays green (ADR 0014).
 *
 * The helper is `expectNoAccessibilityViolations` in src/test/axe.ts.
 *
 * -----------------------------------------------------------------------------
 * THE SURFACES
 *
 * Daily work:
 *
 *   WorkQueue.tsx           the work queue, filterable and sortable
 *   ApprovalsQueue.tsx      approvals awaiting a decision
 *   ApprovalDetail.tsx      the single most consequential screen in the product
 *   RunDetail.tsx           the per-run step trail, cost, and citations
 *   WorkflowInstance.tsx    one piece of work in plain language: where it is,
 *                           why it is stuck, what it is waiting for
 *
 * Governance:
 *
 *   RoleRegistry.tsx        every agent role, its status, ceiling, and score
 *   RoleDetail.tsx          one role in full, with its promotion history
 *   ImprovementQueue.tsx    observation clusters and the proposals raised from
 *                           them, all inert until a human approves
 *   ImprovementProposal.tsx before, after, evaluation delta, blast radius
 *   ContainmentControls.tsx the operator stop buttons, all four scopes
 *   ExternalAgents.tsx      the roster of agents running outside this platform:
 *                           who, whose, on what, spending what against which
 *                           ceiling, and which credential kinds they hold
 *   ExternalAgentDetail.tsx one external agent's runs, costs, outcomes,
 *                           refusals in plain language, and containment history
 *
 * Assurance and oversight:
 *
 *   AuditEvidence.tsx       the hash-chained record and its verification,
 *                           written for a compliance officer to use unaided
 *   DiscoveryBacklog.tsx    the discovery backlog, inert by construction, and
 *                           an explanation of why it ships off when it is off
 *   ExecutiveView.tsx       the executive tiles, each carrying its source note
 *   Health.tsx              configuration, containment, and startup warnings
 *
 * And one outcome that is not a surface of its own:
 *
 *   Denial.tsx              a refusal, rendered as a first-class outcome
 *
 * Every surface has a route in src/routes.tsx, a navigation entry there if it
 * is top-level, a client method in src/api/client.ts, and a test carrying an
 * axe assertion. Nothing else in the shell needs to change to add another.
 */

export { ApprovalDetail, ApprovalDetailRoute } from "./ApprovalDetail";
export { ApprovalsQueue, ApprovalsQueueRoute } from "./ApprovalsQueue";
export {
  AuditEvidence,
  AuditEvidenceRoute,
  NO_AUDIT_FILTERS,
  eventLabel,
  type AuditFilters,
} from "./AuditEvidence";
export {
  ContainmentControls,
  ContainmentControlsRoute,
  type ContainmentChangeRequest,
} from "./ContainmentControls";
export { Denial } from "./Denial";
export { DiscoveryBacklog, DiscoveryBacklogRoute } from "./DiscoveryBacklog";
export { ExecutiveView, ExecutiveViewRoute } from "./ExecutiveView";
export {
  ExternalAgentDetail,
  ExternalAgentDetailRoute,
  denialPresentation,
} from "./ExternalAgentDetail";
export {
  ExternalAgents,
  ExternalAgentsRoute,
  agentState,
  credentialKindLabel,
} from "./ExternalAgents";
export { Health, HealthRoute } from "./Health";
export { ImprovementProposal, ImprovementProposalRoute } from "./ImprovementProposal";
export { ImprovementQueue, ImprovementQueueRoute } from "./ImprovementQueue";
export { RoleDetail, RoleDetailRoute } from "./RoleDetail";
export { RoleRegistry, RoleRegistryRoute } from "./RoleRegistry";
export { RunDetail, RunDetailRoute } from "./RunDetail";
export { WorkflowInstance, WorkflowInstanceRoute } from "./WorkflowInstance";
export { WorkQueue, WorkQueueRoute } from "./WorkQueue";
