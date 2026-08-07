import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { RoleView } from "../api/contract";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { roles } from "../test/fixtures";
import { RoleRegistry } from "./RoleRegistry";

/**
 * The availability filter is a listbox combobox rather than a native `<select>`,
 * so choosing is open-then-pick. Asserting the trigger's text afterwards keeps
 * what `selectOptions` used to give for free: proof that the control committed
 * the choice and says so, not merely that the list re-rendered.
 */
async function filterAvailability(user: UserEvent, optionName: string): Promise<void> {
  const availability = screen.getByRole("combobox", { name: "Availability" });
  await user.click(availability);
  await user.click(screen.getByRole("option", { name: optionName }));
  expect(availability).toHaveTextContent(optionName);
}

describe("RoleRegistry", () => {
  it("lists every role with a link to its detail", () => {
    renderSurface(<RoleRegistry roles={roles} total={roles.length} />);

    expect(
      screen.getByRole("link", { name: "Rescission package assurance" }),
    ).toHaveAttribute("href", "/roles/role_rescission_assurance");
    expect(screen.getByRole("link", { name: "Loan file evidence assembly" })).toHaveAttribute(
      "href",
      "/roles/role_consumer_finance_evidence",
    );
  });

  it("makes a disabled role obvious in words, not only in colour", () => {
    const { container } = renderSurface(<RoleRegistry roles={roles} />);

    // Twice over: once in the availability column, once as the lifecycle state.
    expect(screen.getAllByText("Disabled")).toHaveLength(2);
    expect(screen.getByText("1 role is disabled")).toBeInTheDocument();
    // Available roles say so rather than saying nothing.
    expect(screen.getAllByText("Available")).not.toHaveLength(0);
    // A second channel for a sighted operator scanning the table.
    expect(container.querySelectorAll("tr.pv-row-denied")).toHaveLength(1);
  });

  it("makes an evaluation below its threshold obvious", () => {
    renderSurface(<RoleRegistry roles={roles} />);

    expect(
      screen.getByText("1 role is scoring below the threshold set for it"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Below threshold").length).toBeGreaterThan(0);
    // The measured number and the bar it is measured against are both shown.
    expect(screen.getByText(/85\.6% against a 90% threshold/)).toBeInTheDocument();
  });

  it("separates never evaluated from evaluated and adequate", () => {
    const unevaluated: RoleView = {
      ...(roles[1] as RoleView),
      roleId: "role_never_measured",
      name: "Never measured",
      latestEvaluation: undefined,
    };
    renderSurface(<RoleRegistry roles={[...roles, unevaluated]} />);

    expect(screen.getByText("1 role has never been evaluated")).toBeInTheDocument();
    expect(screen.getByText("Never evaluated")).toBeInTheDocument();
  });

  it("shows the risk ceiling for every role", () => {
    renderSurface(<RoleRegistry roles={roles} />);

    expect(screen.getByText("High consequence risk")).toBeInTheDocument();
    expect(screen.getByText("Routine risk")).toBeInTheDocument();
    expect(screen.getAllByText("Sensitive risk")).toHaveLength(2);
  });

  it("filters to disabled roles only", async () => {
    const user = userEvent.setup();
    renderSurface(<RoleRegistry roles={roles} />);

    await filterAvailability(user, "Disabled only");

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2); // header plus one
    expect(screen.getByRole("link", { name: "Loan file evidence assembly" })).toBeInTheDocument();
  });

  it("filters to available roles only", async () => {
    const user = userEvent.setup();
    renderSurface(<RoleRegistry roles={roles} />);

    await filterAvailability(user, "Available only");

    const table = screen.getByRole("table");
    const available = roles.filter((role) => !role.disabled);
    expect(within(table).getAllByRole("row")).toHaveLength(available.length + 1);
    // The filter kept what it should have kept, not merely the right count.
    for (const role of available) {
      expect(within(table).getByRole("link", { name: role.name })).toBeInTheDocument();
    }
  });

  it("says the registry is empty rather than showing a blank area", () => {
    renderSurface(<RoleRegistry roles={[]} total={0} />);

    expect(screen.getByRole("heading", { name: "No roles are registered" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("distinguishes an empty registry from an over-tight filter", async () => {
    const user = userEvent.setup();
    const availableOnly = roles.filter((role) => !role.disabled);
    renderSurface(<RoleRegistry roles={availableOnly} />);

    await filterAvailability(user, "Disabled only");

    expect(
      screen.getByRole("heading", { name: "No role matches this filter" }),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<RoleRegistry roles={roles} total={roles.length} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when empty", async () => {
    const { container } = renderSurface(<RoleRegistry roles={[]} total={0} />);
    await expectNoAccessibilityViolations(container);
  });
});
