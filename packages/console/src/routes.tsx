import type { SessionView } from "./api/contract";
import type { RouteDefinition } from "./routing";
import {
  ApprovalDetailRoute,
  ApprovalsQueueRoute,
  RunDetailRoute,
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

export const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  { id: "work", path: "/work", label: "Work queue", capability: "work.read" },
  { id: "approvals", path: "/approvals", label: "Approvals", capability: "approvals.read" },
  // Second agent: append workflows, roles, improvements, discovery, audit,
  // executive, and health here.
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
  // Second agent: append the remaining routes here. Patterns are matched in
  // order, and a pattern with a different number of segments cannot collide
  // with an existing one.
];

export const DEFAULT_PATH = "/work";
export const DOCUMENT_TITLE_SUFFIX = "Operator console";
