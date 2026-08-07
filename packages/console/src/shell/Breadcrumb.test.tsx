import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ROUTES, breadcrumbFor } from "../routes";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { Breadcrumb } from "./Breadcrumb";

function routeById(id: string) {
  const route = ROUTES.find((entry) => entry.id === id);
  if (route === undefined) throw new Error(`no route ${id}`);
  return route;
}

describe("the breadcrumb trail", () => {
  it("starts with the zone, which is a place in the rail and not a page", () => {
    const trail = breadcrumbFor(routeById("work"), {});
    expect(trail[0]).toMatchObject({ label: "Work", current: false });
    expect(trail[0]?.path).toBeUndefined();
  });

  it("walks the route hierarchy rather than splitting the address", () => {
    // `/runs/run_01k3` is reached from the work queue and belongs under it. A
    // trail assembled from URL segments would invent a section called "runs"
    // that nobody can navigate to.
    const trail = breadcrumbFor(routeById("run-detail"), { runId: "run_01k3r2m8k5" });
    expect(trail.map((entry) => entry.label)).toEqual([
      "Work",
      "Work queue",
      "run_01k3r2m8k5",
    ]);
  });

  it("names the record itself on a detail route", () => {
    const trail = breadcrumbFor(routeById("approval-detail"), { approvalId: "apr_4182" });
    expect(trail[trail.length - 1]).toMatchObject({ label: "apr_4182", current: true });
  });

  it("falls back to the route title when a detail route has no identifier", () => {
    const trail = breadcrumbFor(routeById("approval-detail"), {});
    expect(trail[trail.length - 1]?.label).toBe("Approval");
  });

  it("is empty when nothing matched, so a 404 shows no false trail", () => {
    expect(breadcrumbFor(null, {})).toEqual([]);
  });
});

describe("the breadcrumb", () => {
  it("renders nothing when there is no trail", () => {
    const { container } = renderSurface(<Breadcrumb entries={[]} />);
    expect(container.querySelector(".pv-breadcrumb")).toBeNull();
  });

  it("names itself, so it is not one of several unnamed navigations", () => {
    renderSurface(<Breadcrumb entries={breadcrumbFor(routeById("approvals"), {})} />);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
  });

  it("is an ordered list, because the order is the meaning", () => {
    renderSurface(<Breadcrumb entries={breadcrumbFor(routeById("approval-detail"), { approvalId: "apr_4182" })} />);
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  });

  it("links the ancestors and does not link the page you are on", () => {
    renderSurface(
      <Breadcrumb entries={breadcrumbFor(routeById("approval-detail"), { approvalId: "apr_4182" })} />,
    );

    expect(screen.getByRole("link", { name: "Approvals" })).toHaveAttribute("href", "/approvals");
    // A link to the page you are already on is a link that does nothing, and
    // it is the crumb people click by mistake.
    expect(screen.queryByRole("link", { name: "apr_4182" })).not.toBeInTheDocument();
  });

  it("marks the current page for a screen reader", () => {
    renderSurface(<Breadcrumb entries={breadcrumbFor(routeById("audit"), {})} />);
    expect(screen.getByText("Audit and evidence")).toHaveAttribute("aria-current", "page");
  });

  it("hides the separators from assistive technology", () => {
    const { container } = renderSurface(
      <Breadcrumb entries={breadcrumbFor(routeById("approval-detail"), { approvalId: "apr_4182" })} />,
    );
    for (const separator of container.querySelectorAll(".pv-breadcrumb-separator")) {
      expect(separator).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <Breadcrumb entries={breadcrumbFor(routeById("role-detail"), { roleId: "role_rescission" })} />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
