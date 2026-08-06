import type { SessionView } from "./api/contract";
import type { RouteDefinition } from "./routing";
import {
  ApprovalDetailRoute,
  ApprovalsQueueRoute,
  AuditEvidenceRoute,
  ContainmentControlsRoute,
  DiscoveryBacklogRoute,
  ExecutiveViewRoute,
  ExternalAgentDetailRoute,
  ExternalAgentsRoute,
  HealthRoute,
  ImprovementProposalRoute,
  ImprovementQueueRoute,
  RoleDetailRoute,
  RoleRegistryRoute,
  RunDetailRoute,
  WorkflowInstanceRoute,
  WorkQueueRoute,
} from "./views";

/**
 * Navigation and routing, in one place.
 *
 * Adding a surface means adding an entry to one or both of these lists and
 * nothing else. Keeping them here rather than inline in App.tsx is what lets
 * two people extend the console at once without colliding in the shell.
 */

export interface NavigationItem {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  /**
   * A capability from SessionView, used only to decide whether to draw this
   * link. See `isNavigationItemVisible` — this is a rendering hint and never
   * an authorization decision.
   */
  readonly capability?: string;
}

/**
 * The primary navigation, in the order an operator's day runs.
 *
 * Daily work first, then the things that govern it, then the things somebody
 * checks rather than uses. Workflow instances, approval details, run records,
 * role details, and improvement proposals are all reached from one of these and
 * are deliberately not links of their own: a navigation item that needs an
 * identifier to be useful is a navigation item nobody can click.
 */
export const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  { id: "work", path: "/work", label: "Work queue", capability: "work.read" },
  { id: "approvals", path: "/approvals", label: "Approvals", capability: "approvals.read" },
  { id: "roles", path: "/roles", label: "Agent roles", capability: "roles.read" },
  // Top-level rather than nested under roles: an agent running in a vendor's
  // CRM is not a role this platform can dispatch to, and filing it under one
  // would suggest the platform runs it.
  {
    id: "external-agents",
    path: "/external-agents",
    label: "External agents",
    capability: "external_agents.read",
  },
  {
    id: "improvements",
    path: "/improvements",
    label: "Improvements",
    capability: "improvements.read",
  },
  { id: "audit", path: "/audit", label: "Audit and evidence", capability: "audit.read" },
  { id: "containment", path: "/containment", label: "Containment", capability: "containment.read" },
  { id: "discovery", path: "/discovery", label: "Work discovery", capability: "discovery.read" },
  { id: "executive", path: "/executive", label: "Executive view", capability: "executive.read" },
  { id: "health", path: "/health", label: "Platform health", capability: "health.read" },
];

/**
 * Whether to draw a navigation link.
 *
 * ## This is a rendering hint. It is not a security boundary.
 *
 * `SessionView.capabilities` exists so the console can avoid offering a
 * control that the actor will only be refused for using. The server re-checks
 * every action at the authorization chokepoint (docs/architecture.md §3), and
 * it re-checks it whether or not this function ever ran. Hiding a link is a
 * courtesy to the operator; it prevents nothing. Anyone who later reads this
 * as access control, or who removes a server-side check because "the console
 * hides it", has introduced a vulnerability.
 *
 * Because it is only a courtesy, it errs toward showing. An item shown that
 * the actor cannot use costs them one clear refusal screen. An item hidden
 * that they *can* use costs them the ability to do their job, with no clue
 * why — a far worse failure, and one nobody reports as a bug because the
 * feature simply appears not to exist.
 */
export function isNavigationItemVisible(
  item: NavigationItem,
  session: SessionView | null,
): boolean {
  if (item.capability === undefined) return true;
  // Session not loaded, or the API sent no capability list: show the link and
  // let the server answer.
  if (session === null || session.capabilities.length === 0) return true;
  return session.capabilities.includes(item.capability);
}

export const ROUTES: readonly RouteDefinition[] = [
  {
    id: "work",
    path: "/work",
    title: "Work queue",
    render: () => <WorkQueueRoute />,
  },
  {
    id: "approvals",
    path: "/approvals",
    title: "Approvals",
    render: () => <ApprovalsQueueRoute />,
  },
  {
    id: "approval-detail",
    path: "/approvals/:approvalId",
    title: "Approval",
    render: (params) => <ApprovalDetailRoute approvalId={params["approvalId"] ?? ""} />,
  },
  {
    id: "run-detail",
    path: "/runs/:runId",
    title: "Run record",
    render: (params) => <RunDetailRoute runId={params["runId"] ?? ""} />,
  },
  {
    id: "workflow-instance",
    path: "/workflows/:instanceId",
    title: "Piece of work",
    render: (params) => <WorkflowInstanceRoute instanceId={params["instanceId"] ?? ""} />,
  },
  {
    id: "roles",
    path: "/roles",
    title: "Agent roles",
    render: () => <RoleRegistryRoute />,
  },
  {
    id: "role-detail",
    path: "/roles/:roleId",
    title: "Agent role",
    render: (params) => <RoleDetailRoute roleId={params["roleId"] ?? ""} />,
  },
  {
    id: "external-agents",
    path: "/external-agents",
    title: "External agents",
    render: () => <ExternalAgentsRoute />,
  },
  {
    id: "external-agent-detail",
    path: "/external-agents/:agentId",
    title: "External agent",
    render: (params) => <ExternalAgentDetailRoute agentId={params["agentId"] ?? ""} />,
  },
  {
    id: "improvements",
    path: "/improvements",
    title: "Improvements",
    render: () => <ImprovementQueueRoute />,
  },
  {
    id: "improvement-proposal",
    path: "/improvements/:proposalId",
    title: "Improvement proposal",
    render: (params) => <ImprovementProposalRoute proposalId={params["proposalId"] ?? ""} />,
  },
  {
    id: "audit",
    path: "/audit",
    title: "Audit and evidence",
    render: () => <AuditEvidenceRoute />,
  },
  {
    id: "containment",
    path: "/containment",
    title: "Containment controls",
    render: () => <ContainmentControlsRoute />,
  },
  {
    id: "discovery",
    path: "/discovery",
    title: "Work discovery",
    render: () => <DiscoveryBacklogRoute />,
  },
  {
    id: "executive",
    path: "/executive",
    title: "Executive view",
    render: () => <ExecutiveViewRoute />,
  },
  {
    id: "health",
    path: "/health",
    title: "Platform health",
    render: () => <HealthRoute />,
  },
];

export const DEFAULT_PATH = "/work";
export const DOCUMENT_TITLE_SUFFIX = "Operator console";
