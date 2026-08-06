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
 * DIVISION OF WORK
 *
 * Present here (foundation and the three highest-traffic surfaces):
 *
 *   WorkQueue.tsx        the work queue, filterable and sortable
 *   ApprovalsQueue.tsx   approvals awaiting a decision
 *   ApprovalDetail.tsx   the single most consequential screen in the product
 *   RunDetail.tsx        the per-run step trail, cost, and citations
 *   Denial.tsx           a refusal, rendered as a first-class outcome
 *
 * Still to be added, and reserved so that navigation can be extended without a
 * merge conflict — see PRIMARY_NAVIGATION and ROUTES in src/routes.tsx, which
 * are the only two lists that need an entry:
 *
 *   WorkflowInstance.tsx  a workflow instance in plain language: where it is,
 *                         why it is stuck, what it is waiting for
 *   Roles.tsx             agent roles, their version, status, risk ceiling,
 *                         and latest golden-set evaluation
 *   Improvements.tsx      improvement proposals and observation clusters,
 *                         with blast radius and before/after evaluation
 *   Discovery.tsx         the discovery backlog, shown only when the feature
 *                         is enabled, and inert by construction
 *   AuditLog.tsx          the hash-chained audit trail and its verification
 *   Executive.tsx         the executive tiles, each carrying its source note
 *   Health.tsx            platform state, containment, and startup warnings
 *
 * Each of those needs a route in src/routes.tsx, a nav entry if it is a
 * top-level surface, a client method in src/api/client.ts, and a test with an
 * axe assertion. Nothing else in the shell should need to change.
 */

export { ApprovalDetail, ApprovalDetailRoute } from "./ApprovalDetail";
export { ApprovalsQueue, ApprovalsQueueRoute } from "./ApprovalsQueue";
export { Denial } from "./Denial";
export { RunDetail, RunDetailRoute } from "./RunDetail";
export { WorkQueue, WorkQueueRoute } from "./WorkQueue";
