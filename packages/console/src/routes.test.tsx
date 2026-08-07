import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { DEFAULT_PATH, PRIMARY_NAVIGATION, ROUTES, isNavigationItemVisible } from "./routes";
import { matchRoutes } from "./routing";
import { renderShell } from "./test/axe";
import { createFakeClient } from "./test/fakeClient";
import { auditorSession, session } from "./test/fixtures";

/**
 * The two lists that have to agree.
 *
 * Adding a surface means adding a route and, if it is top-level, a navigation
 * item. Nothing in the shell enforces that those two lists stay consistent, and
 * a navigation link pointing at no route renders as "That page does not exist"
 * — which nobody reports as a bug, because it looks like the feature was never
 * built.
 */
describe("routes and navigation", () => {
  it("gives every navigation item a route that matches it", () => {
    for (const item of PRIMARY_NAVIGATION) {
      const match = matchRoutes(ROUTES, item.path);
      expect(match, `navigation item "${item.label}" points at ${item.path}, which matches no route`)
        .not.toBeNull();
    }
  });

  it("routes the default path", () => {
    expect(matchRoutes(ROUTES, DEFAULT_PATH)).not.toBeNull();
  });

  it("gives every route a unique id and a unique path", () => {
    expect(new Set(ROUTES.map((route) => route.id)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((route) => route.path)).size).toBe(ROUTES.length);
  });

  it("gives every navigation item a unique id and a unique path", () => {
    expect(new Set(PRIMARY_NAVIGATION.map((item) => item.id)).size).toBe(
      PRIMARY_NAVIGATION.length,
    );
    expect(new Set(PRIMARY_NAVIGATION.map((item) => item.path)).size).toBe(
      PRIMARY_NAVIGATION.length,
    );
  });

  it("gives every route a title, so the browser tab is never blank", () => {
    for (const route of ROUTES) {
      expect(route.title.length, `route ${route.id} has no title`).toBeGreaterThan(0);
    }
  });

  it("does not let a detail route shadow a list route", () => {
    // "/roles" and "/roles/:roleId" have different segment counts, so neither
    // can swallow the other. This asserts it rather than assuming it.
    expect(matchRoutes(ROUTES, "/roles")?.route.id).toBe("roles");
    expect(matchRoutes(ROUTES, "/roles/role_rescission_assurance")?.route.id).toBe("role-detail");
    expect(matchRoutes(ROUTES, "/improvements")?.route.id).toBe("improvements");
    expect(matchRoutes(ROUTES, "/improvements/imp_01k3r2m8k5")?.route.id).toBe(
      "improvement-proposal",
    );
  });

  it("shows a navigation item whose capability the session holds", () => {
    for (const item of PRIMARY_NAVIGATION) {
      expect(isNavigationItemVisible(item, session), `${item.label} is hidden`).toBe(true);
    }
  });

  it("hides a navigation item whose capability the session does not hold", () => {
    // The executive view is spend, and it is gated on `record.read_cost` —
    // which the auditor does not hold. Containment used to be the example
    // here, gated on an invented `containment.read` that the platform grants
    // nobody: the assertion passed because the link was hidden from everyone,
    // including the operator who needs it. See routes.contract.test.ts.
    const executive = PRIMARY_NAVIGATION.find((item) => item.id === "executive");
    expect(executive).toBeDefined();
    expect(executive?.capability).toBe("record.read_cost");
    expect(auditorSession.capabilities).not.toContain("record.read_cost");
    expect(isNavigationItemVisible(executive!, auditorSession)).toBe(false);
  });

  it("renders every top-level surface from the shell", async () => {
    const user = userEvent.setup();
    renderShell(<App />, createFakeClient());

    const expected: readonly { readonly link: string; readonly heading: string }[] = [
      { link: "Agent roles", heading: "Agent roles" },
      { link: "External agents", heading: "External agents" },
      { link: "Improvements", heading: "Improvements" },
      { link: "Audit and evidence", heading: "Audit and evidence" },
      { link: "Containment", heading: "Containment controls" },
      { link: "Work discovery", heading: "Work discovery backlog" },
      { link: "Executive view", heading: "Executive view" },
      { link: "Platform health", heading: "Platform health" },
    ];

    for (const surface of expected) {
      await user.click(await screen.findByRole("link", { name: surface.link }));
      expect(
        await screen.findByRole("heading", { level: 1, name: surface.heading }),
        `clicking "${surface.link}" did not render its surface`,
      ).toBeInTheDocument();
    }
  });
});
