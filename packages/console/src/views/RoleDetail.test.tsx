import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RoleView } from "../api/contract";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { disabledRoleVersions, rescissionRoleVersions, roles } from "../test/fixtures";
import { RoleDetail } from "./RoleDetail";

describe("RoleDetail", () => {
  it("shows the newest version as the current one", () => {
    renderSurface(<RoleDetail versions={rescissionRoleVersions} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Rescission package assurance" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/role_rescission_assurance · version 9/)).toBeInTheDocument();
  });

  it("derives the current version whatever order the API returned", () => {
    const shuffled = [
      rescissionRoleVersions[2] as RoleView,
      rescissionRoleVersions[0] as RoleView,
      rescissionRoleVersions[1] as RoleView,
    ];
    renderSurface(<RoleDetail versions={shuffled} />);

    expect(screen.getByText(/role_rescission_assurance · version 9/)).toBeInTheDocument();
  });

  it("lists every permitted action and data scope in full", () => {
    renderSurface(<RoleDetail versions={rescissionRoleVersions} />);

    const authority = screen.getByRole("region", { name: "What it is permitted to do" });
    expect(within(authority).getByText("timeline.compute_deadline")).toBeInTheDocument();
    expect(within(authority).getByText("documents.check_package")).toBeInTheDocument();
    expect(within(authority).getByText("documents.draft_corrected_package")).toBeInTheDocument();
    expect(within(authority).getByText("approvals.request")).toBeInTheDocument();
    expect(within(authority).getByText("contracts.metadata")).toBeInTheDocument();
    expect(within(authority).getByText("corpus.state_rescission_rules")).toBeInTheDocument();
  });

  it("shows the latest evaluation against its threshold", () => {
    renderSurface(<RoleDetail versions={rescissionRoleVersions} />);

    const evaluation = screen.getByRole("region", { name: "Latest evaluation" });
    expect(within(evaluation).getByText("Meets the 95% threshold")).toBeInTheDocument();
    expect(within(evaluation).getByText("231 of 240 cases passed — 96.3%")).toBeInTheDocument();
    expect(
      within(evaluation).getByText("Rescission package assurance — curated set 2026.3"),
    ).toBeInTheDocument();
  });

  it("says plainly when the latest evaluation does not meet its threshold", () => {
    const below = [roles[2] as RoleView];
    renderSurface(<RoleDetail versions={below} />);

    expect(
      screen.getByText("The latest evaluation does not meet its threshold"),
    ).toBeInTheDocument();
    expect(screen.getByText(/scored 85\.6% on 180 cases against a threshold of 90%/)).toBeInTheDocument();
  });

  it("says plainly when a role is disabled, and where to go about it", () => {
    renderSurface(<RoleDetail versions={disabledRoleVersions} />);

    expect(screen.getByText("This role is disabled and will not run")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check the containment controls" })).toHaveAttribute(
      "href",
      "/containment",
    );
  });

  it("separates never evaluated from evaluated and adequate", () => {
    const unmeasured: RoleView = {
      ...(roles[0] as RoleView),
      latestEvaluation: undefined,
    };
    renderSurface(<RoleDetail versions={[unmeasured]} />);

    expect(screen.getByText("This role has never been evaluated")).toBeInTheDocument();
  });

  it("shows the promotion history newest first, with who changed it", () => {
    renderSurface(<RoleDetail versions={rescissionRoleVersions} />);

    // The caption names the table, and the table is what these assertions are
    // about — the scroll container it used to sit in is not a landmark any more.
    const history = screen.getByRole("grid", { name: /Version history/ });
    const rows = within(history).getAllByRole("row");
    // Header plus three versions.
    expect(rows).toHaveLength(4);
    expect(within(rows[1] as HTMLElement).getByText("9")).toBeInTheDocument();
    // A version that was promoted and then taken back out is named as such.
    expect(within(history).getByText("Reverted")).toBeInTheDocument();
    expect(within(history).getAllByText("Marcus Oyelaran").length).toBeGreaterThan(0);
  });

  it("does not draw a history table for a role with one version", () => {
    renderSurface(<RoleDetail versions={disabledRoleVersions} />);

    expect(
      screen.getByText(/This role has one version\./),
    ).toBeInTheDocument();
  });

  it("says so rather than rendering a broken page when there are no versions", () => {
    renderSurface(<RoleDetail versions={[]} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "This role has no versions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the role registry" })).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<RoleDetail versions={rescissionRoleVersions} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations for a disabled role", async () => {
    const { container } = renderSurface(<RoleDetail versions={disabledRoleVersions} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations with no versions", async () => {
    const { container } = renderSurface(<RoleDetail versions={[]} />);
    await expectNoAccessibilityViolations(container);
  });
});
