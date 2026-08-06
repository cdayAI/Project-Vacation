import { useEffect, useRef } from "react";
import { useClient } from "./api/ClientProvider";
import type { HealthView, SessionView } from "./api/contract";
import { useResource } from "./api/useResource";
import { Badge, Callout } from "./components";
import {
  DEFAULT_PATH,
  DOCUMENT_TITLE_SUFFIX,
  PRIMARY_NAVIGATION,
  ROUTES,
  isNavigationItemVisible,
} from "./routes";
import { Link, matchRoutes, navigate, useLocationPath, useRouteChangeAnnouncement } from "./routing";
import { ThemeProvider } from "./theme/ThemeProvider";
import { ThemeToggle } from "./theme/ThemeToggle";

/**
 * The shell.
 *
 * Skip link, header, primary navigation, one `<main>` landmark, and the
 * platform-state banner. Everything else is a route.
 */
export function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

function Shell() {
  const client = useClient();
  const path = useLocationPath();
  const mainRef = useRef<HTMLElement | null>(null);

  const sessionResource = useResource((signal) => client.session({ signal }), [client]);
  const healthResource = useResource((signal) => client.health({ signal }), [client]);

  const session: SessionView | null =
    sessionResource.state.status === "ready" ? sessionResource.state.data : null;
  const health: HealthView | null =
    healthResource.state.status === "ready" ? healthResource.state.data : null;
  const healthUnavailable =
    healthResource.state.status === "error" || healthResource.state.status === "denied";

  const match = matchRoutes(ROUTES, path);
  const pageTitle = match === null ? "Page not found" : match.route.title;
  useRouteChangeAnnouncement(`${pageTitle} — ${DOCUMENT_TITLE_SUFFIX}`, mainRef);

  // "/" is not a surface. Replace rather than push so Back does not bounce.
  useEffect(() => {
    if (path === "/" || path === "") navigate(DEFAULT_PATH, { replace: true });
  }, [path]);

  const navigationItems = PRIMARY_NAVIGATION.filter((item) =>
    isNavigationItemVisible(item, session),
  );

  return (
    <div className="pv-shell">
      <a className="pv-skip-link" href="#main-content">
        Skip to main content
      </a>

      <PlatformStateBanner health={health} unavailable={healthUnavailable} />

      <header className="pv-header">
        <div className="pv-header-bar">
          <p className="pv-wordmark">
            Operator console
            <span className="pv-wordmark-secondary">Governed operations platform</span>
          </p>

          <div className="pv-header-actions">
            {session?.readOnly === true && (
              <Badge tone="info" glyph="◆">
                Read-only
              </Badge>
            )}
            <ThemeToggle />
            <SignedInActor resource={sessionResource.state.status} session={session} />
          </div>
        </div>
      </header>

      <nav className="pv-nav" aria-label="Primary">
        <ul className="pv-nav-list">
          {navigationItems.map((item) => (
            <li key={item.id}>
              <Link to={item.path} className="pv-nav-link" markCurrent>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* tabIndex -1 so a route change can move focus here. Not in the tab
          order; the skip link is what puts a keyboard user into the content. */}
      <main className="pv-main" id="main-content" ref={mainRef} tabIndex={-1}>
        {match === null ? (
          <div className="pv-stack">
            <h1>That page does not exist</h1>
            <p>
              The address <span className="pv-mono">{path}</span> does not match any surface in
              this console.
            </p>
            <p>
              <Link to={DEFAULT_PATH}>Go to the work queue</Link>
            </p>
          </div>
        ) : (
          match.route.render(match.params)
        )}
      </main>

      <footer className="pv-footer">
        <div className="pv-footer-inner">
          <p>
            {health === null
              ? "Platform state is not available."
              : `Environment ${health.environment} · store ${health.store} · sandbox ${health.sandboxMode} · model provider ${health.modelProvider}`}
          </p>
        </div>
      </footer>
    </div>
  );
}

function SignedInActor({
  resource,
  session,
}: {
  readonly resource: "loading" | "ready" | "denied" | "error";
  readonly session: SessionView | null;
}) {
  if (session !== null) {
    return (
      <p className="pv-actor">
        <span className="pv-sr-only">Signed in as </span>
        <span className="pv-actor-name">{session.actor.displayName}</span>
        <span className="pv-actor-roles">
          {session.actor.roles.length === 0 ? "No roles" : session.actor.roles.join(", ")}
        </span>
      </p>
    );
  }

  return (
    <p className="pv-actor">
      <span className="pv-actor-name">
        {resource === "loading" ? "Identifying you…" : "Not signed in"}
      </span>
    </p>
  );
}

/**
 * The three facts an operator must never have to go looking for.
 *
 * An uncontained sandbox, work discovery switched on, and an audit chain that
 * does not verify are each, on their own, a reason to stop and check something
 * before trusting anything else on screen. So they are stated at the top of
 * every page, in a banner that cannot be dismissed and does not collapse.
 *
 * A missing verification is reported too. "Nobody has checked" is a different
 * statement from "it is intact", and only one of them is reassuring.
 */
function PlatformStateBanner({
  health,
  unavailable,
}: {
  readonly health: HealthView | null;
  readonly unavailable: boolean;
}) {
  if (unavailable) {
    return (
      <div className="pv-banner">
        <div className="pv-banner-inner">
          <Callout tone="danger" title="Platform state is unknown">
            <p>
              The console could not read the platform&rsquo;s health. It cannot currently tell you
              whether the sandbox is contained, whether work discovery is enabled, or whether the
              audit chain verifies. Treat those three as unconfirmed until this clears.
            </p>
          </Callout>
        </div>
      </div>
    );
  }

  if (health === null) return null;

  const alerts: { readonly id: string; readonly text: string }[] = [];

  if (!health.sandboxIsContained) {
    alerts.push({
      id: "sandbox",
      text: `The execution sandbox is not contained (mode: ${health.sandboxMode}). Code the platform runs is not isolated from this host.`,
    });
  }

  if (health.discoveryEnabled) {
    alerts.push({
      id: "discovery",
      text: "Work discovery is enabled. Employee observation is being collected. It ships disabled, so someone turned this on deliberately — confirm that was intended and that enrolment and notice are in place.",
    });
  }

  const verification = health.lastAuditVerification;
  if (verification === undefined) {
    alerts.push({
      id: "audit-unverified",
      text: "The audit chain has not been verified. Nobody has checked that the record is intact; that is not the same as it being intact.",
    });
  } else if (!verification.intact) {
    alerts.push({
      id: "audit-broken",
      text: `Audit verification failed: ${verification.breaks.length} break${
        verification.breaks.length === 1 ? "" : "s"
      } found across ${verification.entriesChecked} entries. The evidence trail cannot be relied on until this is explained.`,
    });
  }

  for (const warning of health.warnings) {
    alerts.push({ id: `warning-${warning}`, text: warning });
  }

  if (alerts.length === 0) return null;

  return (
    <div className="pv-banner">
      <section className="pv-banner-inner" aria-labelledby="platform-state-heading">
        <h2 className="pv-banner-heading" id="platform-state-heading">
          Platform state needs your attention
        </h2>
        <ul className="pv-banner-list">
          {alerts.map((alert) => (
            <li key={alert.id}>{alert.text}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
