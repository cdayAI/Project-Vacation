import { useEffect, useRef } from "react";
import { useClient } from "./api/ClientProvider";
import type { HealthView, SessionView } from "./api/contract";
import { useResource } from "./api/useResource";
import { KeyboardProvider } from "./keyboard/KeyboardProvider";
import {
  DEFAULT_PATH,
  DOCUMENT_TITLE_SUFFIX,
  ROUTES,
  breadcrumbFor,
  visibleZones,
  type ConsoleRoute,
} from "./routes";
import { Link, matchRoutes, navigate, useLocationPath, useRouteChangeAnnouncement } from "./routing";
import { AppShell } from "./shell/AppShell";
import { PlatformStateBanner } from "./shell/PlatformStateBanner";
import { ThemeProvider } from "./theme/ThemeProvider";
import "./App.css";

/**
 * The console.
 *
 * Three providers and a shell. `ThemeProvider` holds the operator's three
 * reading preferences, `KeyboardProvider` holds the single document key
 * listener and the verb registry every screen registers into, and `AppShell`
 * is the frame from specification §2.
 *
 * The order matters in one direction only: the shell registers commands that
 * change theme, density and transparency, so it has to be inside both.
 */
export function App() {
  return (
    <ThemeProvider>
      <KeyboardProvider>
        <Console />
      </KeyboardProvider>
    </ThemeProvider>
  );
}

function Console() {
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
  // Looked up by id rather than cast: `matchRoutes` is typed against the
  // matcher's shape, and the zone and breadcrumb fields are this module's
  // addition to it.
  const route: ConsoleRoute | null =
    match === null ? null : (ROUTES.find((entry) => entry.id === match.route.id) ?? null);

  const pageTitle = route === null ? "Page not found" : route.title;
  useRouteChangeAnnouncement(`${pageTitle} — ${DOCUMENT_TITLE_SUFFIX}`, mainRef);

  // "/" is not a surface. Replace rather than push so Back does not bounce.
  useEffect(() => {
    if (path === "/" || path === "") navigate(DEFAULT_PATH, { replace: true });
  }, [path]);

  const parent =
    route?.parentId === undefined
      ? undefined
      : ROUTES.find((entry) => entry.id === route.parentId);

  return (
    <AppShell
      zones={visibleZones(session)}
      breadcrumb={breadcrumbFor(route, match?.params ?? {})}
      routeId={route?.id ?? "not-found"}
      actorName={describeActor(sessionResource.state.status, session)}
      actorRoles={session?.actor.roles ?? []}
      readOnly={session?.readOnly === true}
      banner={<PlatformStateBanner health={health} unavailable={healthUnavailable} />}
      contextTitle={route === null ? "Context" : route.title}
      contextDescription={
        health === null
          ? undefined
          : `Environment ${health.environment} · store ${health.store} · sandbox ${health.sandboxMode} · model provider ${health.modelProvider}`
      }
      {...(parent === undefined ? {} : { backTo: { label: parent.title, path: parent.path } })}
      mainRef={mainRef}
    >
      {route === null ? <NotFound path={path} /> : route.render(match?.params ?? {})}
    </AppShell>
  );
}

function describeActor(
  status: "loading" | "ready" | "denied" | "error",
  session: SessionView | null,
): string {
  if (session !== null) return session.actor.displayName;
  // "Not signed in" and "still asking" are different facts, and the difference
  // is the first thing somebody checks when a screen refuses them.
  return status === "loading" ? "Identifying you" : "Not signed in";
}

function NotFound({ path }: { readonly path: string }) {
  return (
    <div className="pv-not-found">
      <h1>That page does not exist</h1>
      <p>
        The address <span className="pv-not-found-path">{path}</span> does not match any surface in this
        console.
      </p>
      <p>
        <Link to={DEFAULT_PATH}>Go to the work queue</Link>
      </p>
    </div>
  );
}
