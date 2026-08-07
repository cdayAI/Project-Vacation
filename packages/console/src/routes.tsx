import type { ComponentType } from "react";
import type { SessionView } from "./api/contract";
import type { RouteDefinition, RouteParams } from "./routing";
import {
  IconApprovals,
  IconChain,
  IconChart,
  IconExchange,
  IconLoop,
  IconPulse,
  IconQueue,
  IconRole,
  IconSearchGlass,
  IconShield,
  IconSystem,
  type NavIconProps,
} from "./shell/navIcons";
import {
  ApprovalDetailRoute,
  ApprovalsQueueRoute,
  AuditEvidenceRoute,
  ContainmentControlsRoute,
  DesignGallery,
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

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/**
 * The four zones of the rail, in the order specification §2 fixes them:
 * **Work · Oversight · Improve · Admin**.
 *
 * The order is not alphabetical and not by size — it is the order of the day.
 * What is in front of you, then the things that govern it, then the things that
 * make it better next time, then the things somebody configures once a quarter.
 * An operator whose whole job is the first zone should never have to scroll past
 * the fourth, and a rail that reorders itself by usage would take away the one
 * thing a rail is for, which is being in the same place every morning.
 *
 * A zone with no surfaces this role can open is not drawn at all — an empty
 * heading is a promise of something the operator cannot have.
 */
export const ZONES = [
  {
    id: "work",
    label: "Work",
    description: "What is in front of you now.",
  },
  {
    id: "oversight",
    label: "Oversight",
    description: "What happened, and what is being held back.",
  },
  {
    id: "improve",
    label: "Improve",
    description: "What should be different next time.",
  },
  {
    id: "admin",
    label: "Admin",
    description: "What governs the platform.",
  },
] as const satisfies readonly { id: string; label: string; description: string }[];

export type ZoneId = (typeof ZONES)[number]["id"];

export interface NavigationItem {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly zone: ZoneId;
  /** The mark shown when the rail is collapsed to 64px. Never the only label. */
  readonly icon: ComponentType<NavIconProps>;
  /** One line for the palette and the collapsed rail's tooltip. */
  readonly hint: string;
  /**
   * A capability from SessionView, used only to decide whether to draw this
   * link. See `isNavigationItemVisible` — this is a rendering hint and never
   * an authorization decision.
   *
   * **It must be a capability the platform actually grants somebody.** The
   * platform's vocabulary is the action registry — `record.read_run`,
   * `audit.read`, `contact.send_owner_message` — and nothing else is ever in
   * `SessionView.capabilities`. This field used to carry an invented parallel
   * vocabulary (`work.read`, `approvals.read`, `roles.read`), none of which
   * the platform emits to anyone, so the membership test could only ever fail:
   * a fully-privileged operator opened the console and found nine of eleven
   * surfaces missing from the rail.
   *
   * A hint that hides a surface from *every* operator is not discriminating
   * between operators. It is a broken link check. So the rule is: name a real
   * capability, or leave this undefined and let the server refuse the read —
   * which is where the boundary is anyway.
   *
   * Most surfaces are undefined for a reason that is worth knowing: the
   * platform has no read-scope vocabulary at all. Reading the work queue is
   * mapped to `record.read_run` because that is genuinely the same read, but
   * there is no `approvals.read` to point at, and inventing one here would
   * recreate exactly the defect above. See S11 in
   * `docs/handover/not-production-grade.md`.
   */
  readonly capability?: string;
}

/**
 * The primary navigation, in the order an operator's day runs.
 *
 * Workflow instances, approval details, run records, role details, and
 * improvement proposals are all reached from one of these and are deliberately
 * not links of their own: a navigation item that needs an identifier to be
 * useful is a navigation item nobody can click.
 */
export const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  {
    id: "work",
    path: "/work",
    label: "Work queue",
    zone: "work",
    icon: IconQueue,
    hint: "Everything waiting, across every workflow.",
    capability: "record.read_run",
  },
  {
    id: "approvals",
    path: "/approvals",
    label: "Approvals",
    zone: "work",
    icon: IconApprovals,
    hint: "The decisions waiting on you.",
  },
  {
    id: "audit",
    path: "/audit",
    label: "Audit and evidence",
    zone: "oversight",
    icon: IconChain,
    hint: "What happened, and what it was based on.",
    capability: "audit.read",
  },
  {
    id: "containment",
    path: "/containment",
    label: "Containment",
    zone: "oversight",
    icon: IconShield,
    hint: "What is currently stopped, and who stopped it.",
  },
  {
    id: "executive",
    path: "/executive",
    label: "Executive view",
    zone: "oversight",
    icon: IconChart,
    hint: "The measures management reports, with their denominators.",
    capability: "record.read_cost",
  },
  {
    id: "improvements",
    path: "/improvements",
    label: "Improvements",
    zone: "improve",
    icon: IconLoop,
    hint: "Proposals raised from corrections and refusals.",
  },
  {
    id: "discovery",
    path: "/discovery",
    label: "Work discovery",
    zone: "improve",
    icon: IconSearchGlass,
    hint: "Candidate work nobody has written down yet.",
  },
  {
    id: "roles",
    path: "/roles",
    label: "Agent roles",
    zone: "admin",
    icon: IconRole,
    hint: "What each agent role may do, and at what tier.",
  },
  // Top-level rather than nested under roles: an agent running in a vendor's
  // CRM is not a role this platform can dispatch to, and filing it under one
  // would suggest the platform runs it.
  {
    id: "external-agents",
    path: "/external-agents",
    label: "External agents",
    zone: "admin",
    icon: IconExchange,
    hint: "Agents outside the platform that call into it.",
  },
  {
    id: "health",
    path: "/health",
    label: "Platform health",
    zone: "admin",
    icon: IconPulse,
    hint: "Environment, store, sandbox, and the model provider.",
  },
  // No capability: the gallery holds no operating data, and it is how a
  // designer or a reviewer checks the system without an account that can see
  // owner records.
  {
    id: "design",
    path: "/design",
    label: "Design system",
    zone: "admin",
    icon: IconSystem,
    hint: "Every component, in every state, in both themes.",
  },
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

export interface NavigationZone {
  readonly id: ZoneId;
  readonly label: string;
  readonly description: string;
  readonly items: readonly NavigationItem[];
}

/**
 * The rail's contents for one session: the four zones in their fixed order,
 * each holding only what this role can open, and with the empty ones dropped.
 */
export function visibleZones(session: SessionView | null): readonly NavigationZone[] {
  return ZONES.map((zone) => ({
    id: zone.id,
    label: zone.label,
    description: zone.description,
    items: PRIMARY_NAVIGATION.filter(
      (item) => item.zone === zone.id && isNavigationItemVisible(item, session),
    ),
  })).filter((zone) => zone.items.length > 0);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * A route, plus what the shell needs to place it.
 *
 * `RouteDefinition` (routing.tsx) is the matcher's shape and stays that. The
 * three additions here are the breadcrumb's: which zone a surface belongs to,
 * what it hangs off, and what to call the record once the identifier is known.
 * Without them a breadcrumb is a guess made from the path, and a path is not a
 * hierarchy — `/runs/run_01k3` sits under the queue an operator came from, not
 * under a section called "runs" that does not exist.
 */
export interface ConsoleRoute extends RouteDefinition {
  readonly zone: ZoneId;
  /** The id of the route this one sits beneath. */
  readonly parentId?: string;
  /** The crumb for this route once the parameters are known. */
  readonly crumb?: (params: RouteParams) => string;
}

export const ROUTES: readonly ConsoleRoute[] = [
  {
    id: "work",
    path: "/work",
    title: "Work queue",
    zone: "work",
    render: () => <WorkQueueRoute />,
  },
  {
    id: "approvals",
    path: "/approvals",
    title: "Approvals",
    zone: "work",
    render: () => <ApprovalsQueueRoute />,
  },
  {
    id: "approval-detail",
    path: "/approvals/:approvalId",
    title: "Approval",
    zone: "work",
    parentId: "approvals",
    crumb: (params) => params["approvalId"] ?? "Approval",
    render: (params) => <ApprovalDetailRoute approvalId={params["approvalId"] ?? ""} />,
  },
  {
    id: "run-detail",
    path: "/runs/:runId",
    title: "Run record",
    zone: "work",
    parentId: "work",
    crumb: (params) => params["runId"] ?? "Run record",
    render: (params) => <RunDetailRoute runId={params["runId"] ?? ""} />,
  },
  {
    id: "workflow-instance",
    path: "/workflows/:instanceId",
    title: "Piece of work",
    zone: "work",
    parentId: "work",
    crumb: (params) => params["instanceId"] ?? "Piece of work",
    render: (params) => <WorkflowInstanceRoute instanceId={params["instanceId"] ?? ""} />,
  },
  {
    id: "audit",
    path: "/audit",
    title: "Audit and evidence",
    zone: "oversight",
    render: () => <AuditEvidenceRoute />,
  },
  {
    id: "containment",
    path: "/containment",
    title: "Containment controls",
    zone: "oversight",
    render: () => <ContainmentControlsRoute />,
  },
  {
    id: "executive",
    path: "/executive",
    title: "Executive view",
    zone: "oversight",
    render: () => <ExecutiveViewRoute />,
  },
  {
    id: "improvements",
    path: "/improvements",
    title: "Improvements",
    zone: "improve",
    render: () => <ImprovementQueueRoute />,
  },
  {
    id: "improvement-proposal",
    path: "/improvements/:proposalId",
    title: "Improvement proposal",
    zone: "improve",
    parentId: "improvements",
    crumb: (params) => params["proposalId"] ?? "Proposal",
    render: (params) => <ImprovementProposalRoute proposalId={params["proposalId"] ?? ""} />,
  },
  {
    id: "discovery",
    path: "/discovery",
    title: "Work discovery",
    zone: "improve",
    render: () => <DiscoveryBacklogRoute />,
  },
  {
    id: "roles",
    path: "/roles",
    title: "Agent roles",
    zone: "admin",
    render: () => <RoleRegistryRoute />,
  },
  {
    id: "role-detail",
    path: "/roles/:roleId",
    title: "Agent role",
    zone: "admin",
    parentId: "roles",
    crumb: (params) => params["roleId"] ?? "Agent role",
    render: (params) => <RoleDetailRoute roleId={params["roleId"] ?? ""} />,
  },
  {
    id: "external-agents",
    path: "/external-agents",
    title: "External agents",
    zone: "admin",
    render: () => <ExternalAgentsRoute />,
  },
  {
    id: "external-agent-detail",
    path: "/external-agents/:agentId",
    title: "External agent",
    zone: "admin",
    parentId: "external-agents",
    crumb: (params) => params["agentId"] ?? "External agent",
    render: (params) => <ExternalAgentDetailRoute agentId={params["agentId"] ?? ""} />,
  },
  {
    id: "health",
    path: "/health",
    title: "Platform health",
    zone: "admin",
    render: () => <HealthRoute />,
  },
  {
    id: "design",
    path: "/design",
    title: "Design system",
    zone: "admin",
    render: () => <DesignGallery />,
  },
];

export const DEFAULT_PATH = "/work";
export const DOCUMENT_TITLE_SUFFIX = "Operator console";

// ---------------------------------------------------------------------------
// The breadcrumb
// ---------------------------------------------------------------------------

export interface BreadcrumbEntry {
  readonly id: string;
  readonly label: string;
  /** Absent for the zone, which is a place in the rail rather than a page. */
  readonly path?: string;
  /** True for the page the operator is on. Carries `aria-current="page"`. */
  readonly current: boolean;
}

/**
 * The trail from the zone down to the record.
 *
 * Built by walking `parentId` rather than by splitting the path, because the
 * path is not the hierarchy: `/runs/run_01k3` is reached from the work queue and
 * belongs under it, and a breadcrumb assembled from URL segments would invent a
 * section called "runs" that nobody can navigate to.
 *
 * The zone is the first crumb and is not a link. It names where the operator is
 * in the rail — which is the question a breadcrumb answers on the first hop, and
 * the one that is otherwise only answered by a highlighted item they cannot see
 * while the rail is collapsed.
 */
export function breadcrumbFor(
  route: ConsoleRoute | null,
  params: RouteParams,
): readonly BreadcrumbEntry[] {
  if (route === null) return [];

  const chain: ConsoleRoute[] = [];
  let current: ConsoleRoute | undefined = route;
  // Bounded by the number of routes: a `parentId` cycle introduced by a later
  // edit must not hang the shell on every render.
  const guard = new Set<string>();
  while (current !== undefined && !guard.has(current.id)) {
    guard.add(current.id);
    chain.unshift(current);
    const parentId: string | undefined = current.parentId;
    current = parentId === undefined ? undefined : ROUTES.find((entry) => entry.id === parentId);
  }

  const zone = ZONES.find((entry) => entry.id === route.zone);
  const entries: BreadcrumbEntry[] = [];
  if (zone !== undefined) {
    entries.push({ id: `zone-${zone.id}`, label: zone.label, current: false });
  }

  for (const [index, step] of chain.entries()) {
    const isLast = index === chain.length - 1;
    entries.push({
      id: step.id,
      label: isLast && step.crumb !== undefined ? step.crumb(params) : step.title,
      path: isLast ? undefined : step.path,
      current: isLast,
    });
  }

  return entries;
}
