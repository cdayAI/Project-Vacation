import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { improvementClusters, improvementProposals } from "../test/fixtures";
import { ImprovementQueue } from "./ImprovementQueue";

describe("ImprovementQueue", () => {
  it("states on the page that a proposal is inert until a human approves it", () => {
    renderSurface(
      <ImprovementQueue clusters={improvementClusters} proposals={improvementProposals} />,
    );

    expect(
      screen.getByText("Nothing here changes anything until a person approves it"),
    ).toBeInTheDocument();
    expect(screen.getByText(/there is no auto-apply/)).toBeInTheDocument();
    expect(
      screen.getByText(/no configuration that turns the human decision off/),
    ).toBeInTheDocument();
  });

  it("offers no control that would apply a change", () => {
    renderSurface(
      <ImprovementQueue clusters={improvementClusters} proposals={improvementProposals} />,
    );

    const buttons = screen.queryAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);

    // Every button on this screen belongs to a table's own view controls: a
    // sort control, or the column chooser. Both change what this reader is
    // looking at and neither reaches the platform.
    //
    // Matched on what each control announces rather than on a class name. A
    // control that applied a change could be given any class; it could not
    // pass this without telling a screen-reader user it sorts a column.
    const columnChoosers = buttons.filter((button) => button.textContent === "Columns");
    const sortControls = buttons.filter((button) =>
      /, (not sorted|sorted (ascending|descending))\. Activate to sort (ascending|descending)\.$/.test(
        button.textContent ?? "",
      ),
    );

    // One chooser per table, and the two kinds account for every button — so a
    // third kind cannot arrive unnoticed.
    expect(columnChoosers).toHaveLength(2);
    expect(columnChoosers.length + sortControls.length).toBe(buttons.length);
  });

  it("ranks clusters by how often each one happens", () => {
    renderSurface(
      <ImprovementQueue clusters={improvementClusters} proposals={improvementProposals} />,
    );

    // `grid`, not `table`: J/K/Enter row navigation is a widget and the role
    // says so. Its columnheader, row and rowheader children are unchanged.
    const clusterTable = screen.getByRole("grid", { name: /Observation clusters/ });
    const rows = within(clusterTable).getAllByRole("row");
    // Header plus three, most frequent first.
    expect(rows).toHaveLength(4);
    expect(within(rows[1] as HTMLElement).getByText("412")).toBeInTheDocument();
    expect(within(rows[3] as HTMLElement).getByText("58")).toBeInTheDocument();

    // The table mounts a window of rows, so a count of what is in the DOM can
    // no longer stand on its own: `aria-rowcount` is what a screen reader is
    // told, and it must be the whole list rather than the mounted part of it.
    // +1 for the header row, which occupies index 1 in that coordinate space.
    expect(clusterTable).toHaveAttribute("aria-rowcount", String(improvementClusters.length + 1));

    // And the ranking is announced, not merely applied. A list that is
    // silently sorted is a list nobody can trust the top of.
    expect(
      within(clusterTable).getByRole("columnheader", { name: /Times seen/ }),
    ).toHaveAttribute("aria-sort", "descending");
  });

  it("shows the cost of each cluster and the total", () => {
    renderSurface(
      <ImprovementQueue clusters={improvementClusters} proposals={improvementProposals} />,
    );

    expect(screen.getByText("$186.42")).toBeInTheDocument();
    expect(screen.getByText(/\$402\.22 of estimated cost/)).toBeInTheDocument();
  });

  it("attaches the evidence as links a reviewer can open", () => {
    renderSurface(
      <ImprovementQueue clusters={improvementClusters} proposals={improvementProposals} />,
    );

    expect(screen.getByRole("link", { name: "run_01k3m9y8q1" })).toHaveAttribute(
      "href",
      "/runs/run_01k3m9y8q1",
    );
    expect(screen.getByRole("link", { name: "role_rescission_assurance" })).toHaveAttribute(
      "href",
      "/roles/role_rescission_assurance",
    );
  });

  it("shows the measured change and blast radius for each proposal", () => {
    renderSurface(
      <ImprovementQueue clusters={improvementClusters} proposals={improvementProposals} />,
    );

    expect(screen.getByText("+2.92 percentage points")).toBeInTheDocument();
    expect(screen.getByText("-7.23 percentage points")).toBeInTheDocument();
    expect(screen.getByText("2,238")).toBeInTheDocument();
    expect(screen.getByText("8,914")).toBeInTheDocument();
  });

  it("links each proposal to its detail", () => {
    renderSurface(
      <ImprovementQueue clusters={improvementClusters} proposals={improvementProposals} />,
    );

    expect(
      screen.getByRole("link", { name: "Wait for the state rules corpus before checking a package" }),
    ).toHaveAttribute("href", "/improvements/imp_01k3r2m8k5");
  });

  it("sorts clusters by cost when the operator asks", async () => {
    const user = userEvent.setup();
    renderSurface(
      <ImprovementQueue clusters={improvementClusters} proposals={improvementProposals} />,
    );

    const clusterTable = screen.getByRole("grid", { name: /Observation clusters/ });
    const costHeader = within(clusterTable).getByRole("columnheader", { name: /Estimated cost/ });
    await user.click(within(costHeader).getByRole("button"));
    await user.click(within(costHeader).getByRole("button"));

    expect(costHeader).toHaveAttribute("aria-sort", "descending");
    const rows = within(clusterTable).getAllByRole("row");
    expect(within(rows[1] as HTMLElement).getByText("$186.42")).toBeInTheDocument();
  });

  it("says so when nothing has clustered rather than showing a blank area", () => {
    renderSurface(<ImprovementQueue clusters={[]} proposals={improvementProposals} />);

    expect(
      screen.getByRole("heading", { name: "Nothing has repeated often enough to cluster" }),
    ).toBeInTheDocument();
  });

  it("says so when no proposal is waiting", () => {
    renderSurface(<ImprovementQueue clusters={improvementClusters} proposals={[]} />);

    expect(screen.getByRole("heading", { name: "No proposal is waiting" })).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <ImprovementQueue clusters={improvementClusters} proposals={improvementProposals} />,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when both lists are empty", async () => {
    const { container } = renderSurface(<ImprovementQueue clusters={[]} proposals={[]} />);
    await expectNoAccessibilityViolations(container);
  });
});
