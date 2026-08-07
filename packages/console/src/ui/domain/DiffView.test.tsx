import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { DiffView, type DiffRow } from "./DiffView";

const ROWS: readonly DiffRow[] = [
  { id: "threshold", label: "Escalation threshold", current: "$5,000", draft: "$2,500", change: "changed" },
  { id: "reviewer", label: "Second reviewer", draft: "Required over $10,000", change: "added" },
  { id: "legacy", label: "Legacy fallback", current: "Enabled", change: "removed" },
  { id: "owner", label: "Owner", current: "Dana Ruiz", draft: "Dana Ruiz", change: "unchanged" },
];

describe("DiffView", () => {
  it("counts the changes before showing them", () => {
    // An operator about to publish wants to know how big this is before they
    // know what it is.
    renderSurface(<DiffView label="Changes to policy R-14" rows={ROWS} />);
    expect(screen.getByText("3 changes: 1 added, 1 removed, 1 changed.")).toBeInTheDocument();
  });

  it("names every change in a word as well as tinting the row", () => {
    // Colour is missing entirely from the printed change record, and
    // unreliable for roughly one operator in twelve.
    renderSurface(<DiffView label="Changes to policy R-14" rows={ROWS} />);
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.getByText("Changed")).toBeInTheDocument();
  });

  it("hides unchanged rows by default and shows them on request", () => {
    // A diff of two hundred settings with three changes in it is a haystack.
    const quiet = renderSurface(<DiffView label="Changes to policy R-14" rows={ROWS} />);
    expect(quiet.queryByText("Owner")).toBeNull();

    renderSurface(<DiffView label="Changes to policy R-14" rows={ROWS} showUnchanged />);
    expect(screen.getByRole("rowheader", { name: "Owner" })).toBeInTheDocument();
  });

  it("puts current and draft on the same row, at every width", () => {
    // Two scrolling panels make the reader do the alignment, and the alignment
    // is the entire value of a diff.
    renderSurface(<DiffView label="Changes to policy R-14" rows={ROWS} />);
    const table = screen.getByRole("table", { name: "Changes to policy R-14" });
    expect(table).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Current" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Draft" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "$5,000" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "$2,500" })).toBeInTheDocument();
  });

  it("says what an absent value means on each side", () => {
    renderSurface(<DiffView label="Changes to policy R-14" rows={ROWS} />);
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getByText("Not in the draft")).toBeInTheDocument();
  });

  it("takes the column names from the caller for a non-config diff", () => {
    renderSurface(
      <DiffView
        label="Model version comparison"
        rows={ROWS}
        currentLabel="Live"
        draftLabel="Candidate"
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Live" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Candidate" })).toBeInTheDocument();
  });

  it("says the draft matches rather than showing an empty table", () => {
    renderSurface(
      <DiffView
        label="Changes to policy R-14"
        rows={[ROWS[3] as DiffRow]}
      />,
    );
    expect(
      screen.getByText("The draft matches what is live. There is nothing to publish."),
    ).toBeInTheDocument();
  });

  it("says once that it cannot be edited from here", () => {
    renderSurface(<DiffView label="Changes to policy R-14" rows={ROWS} readOnly />);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <DiffView
        label="Changes to policy R-14"
        rows={[
          ...ROWS,
          {
            id: "template",
            label: "Notice template",
            current: "Dear {{owner}},\nYour contract…",
            draft: "Dear {{owner}},\nYour timeshare contract…",
            change: "changed",
            multiline: true,
          },
        ]}
        showUnchanged
        readOnly
      />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
