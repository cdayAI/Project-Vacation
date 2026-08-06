import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * A router, in about a hundred lines, with no dependency.
 *
 * The console has five routes. A routing library would bring more surface to
 * audit and hand over than the problem justifies, and — more to the point —
 * the two things that actually matter here are things a library gives you only
 * if you remember to ask:
 *
 *   1. A client-side navigation changes the page without a document load, so
 *      assistive technology gets no signal unless we send one. After every
 *      route change this router moves focus to the main landmark and rewrites
 *      document.title. Without that, a screen-reader user presses a link and
 *      nothing appears to happen.
 *
 *   2. Links are real anchors with real hrefs. Middle-click, ctrl-click, and
 *      "open in new tab" all work, because the handler bows out for any click
 *      that is not a plain left click.
 */

export type RouteParams = Readonly<Record<string, string>>;

export interface RouteDefinition {
  readonly id: string;
  /** A pattern such as "/approvals/:approvalId". */
  readonly path: string;
  /** Rendered into document.title on entry. */
  readonly title: string;
  readonly render: (params: RouteParams) => ReactNode;
}

export interface RouteMatch {
  readonly route: RouteDefinition;
  readonly params: RouteParams;
}

// ---------------------------------------------------------------------------
// Location as an external store
// ---------------------------------------------------------------------------

const subscribers = new Set<() => void>();

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  window.addEventListener("popstate", callback);
  return () => {
    subscribers.delete(callback);
    window.removeEventListener("popstate", callback);
  };
}

function currentPath(): string {
  return window.location.pathname;
}

export function useLocationPath(): string {
  return useSyncExternalStore(subscribe, currentPath, currentPath);
}

export function navigate(to: string, options?: { readonly replace?: boolean }): void {
  if (to === window.location.pathname) return;
  if (options?.replace === true) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  notify();
}

export function useNavigate(): (to: string, options?: { readonly replace?: boolean }) => void {
  return useCallback((to: string, options?: { readonly replace?: boolean }) => {
    navigate(to, options);
  }, []);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

export function matchRoute(pattern: string, pathname: string): RouteParams | null {
  const patternSegments = segments(pattern);
  const pathSegments = segments(pathname);
  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index] as string;
    const actual = pathSegments[index] as string;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export function matchRoutes(
  routes: readonly RouteDefinition[],
  pathname: string,
): RouteMatch | null {
  for (const route of routes) {
    const params = matchRoute(route.path, pathname);
    if (params !== null) return { route, params };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

export interface LinkProps {
  readonly to: string;
  readonly children: ReactNode;
  readonly className?: string;
  /** Set on the anchor when `to` is the current page. */
  readonly markCurrent?: boolean;
  readonly ariaLabel?: string;
}

export function Link({ to, children, className, markCurrent = false, ariaLabel }: LinkProps) {
  const path = useLocationPath();
  const isCurrent = markCurrent && (path === to || path.startsWith(`${to}/`));

  function onClick(event: MouseEvent<HTMLAnchorElement>): void {
    // Anything that is not a plain left click belongs to the browser: opening
    // in a new tab or window must keep working.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(to);
  }

  return (
    <a
      href={to}
      className={className}
      onClick={onClick}
      aria-current={isCurrent ? "page" : undefined}
      aria-label={ariaLabel}
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Route change announcement
// ---------------------------------------------------------------------------

/**
 * Sets document.title and moves focus to the main landmark whenever the route
 * changes. Focus is deliberately not moved on first render — the browser has
 * just loaded a document and the user's focus is where they put it.
 */
export function useRouteChangeAnnouncement(
  documentTitle: string,
  mainRef: RefObject<HTMLElement | null>,
): void {
  const path = useLocationPath();
  const isFirstRender = useRef(true);

  useEffect(() => {
    document.title = documentTitle;
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [path, documentTitle, mainRef]);
}
