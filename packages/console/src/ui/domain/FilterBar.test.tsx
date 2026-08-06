import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { FilterBar, type ActiveFilter, type SavedView } from "./FilterBar";

const VIEWS: readonly SavedView[] = [
  { id: "open", label: "All open", count: 1240 },
  { id: "mine", label: "Mine", count: 18 },
  { id: "breaching", label: "Breaching", count: 4 },
];

const FILTERS: readonly ActiveFilter[] = [
  { id: "state", label: "Owner state", value: "Florida" },
  { id: "value", label: "Value", value: "over $10,000" },
];

describe("FilterBar", () => {
  it("is a named region so an operator can jump to it", () => {
    renderSurface(<FilterBar label="Queue filters" views={VIEWS} activeViewId="open" />);
    expect(screen.getByRole("region", { name: "Queue filters" })).toBeInTheDocument();
  });

  it("marks the active view as pressed rather than only tinting it", () => {
    // A saved view whose only "on" signal is a tint is invisible in greyscale
    // and says nothing at all to a screen reader.
    renderSurface(<FilterBar label="Queue filters" views={VIEWS} activeViewId="mine" />);
    expect(screen.getByRole("button", { name: /Mine/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /All open/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("hands the view change to the screen, which owns the URL", async () => {
    // Spec §3.1: every filter state encodes into the URL. A component holding
    // its own copy guarantees the two disagree after a back button.
    const onViewSelect = vi.fn();
    const user = userEvent.setup();
    renderSurface(
      <FilterBar
        label="Queue filters"
        views={VIEWS}
        activeViewId="open"
        onViewSelect={onViewSelect}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Breaching/ }));
    expect(onViewSelect).toHaveBeenCalledWith("breaching");
    // Nothing moved: the screen decides.
    expect(screen.getByRole("button", { name: /All open/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("announces the result count with its noun", async () => {
    // An operator who clicks a saved view and hears nothing has no idea
    // whether the filter did anything.
    renderSurface(<FilterBar label="Queue filters" resultCount={1240} />);
    const count = screen.getByRole("status");
    expect(count).toHaveTextContent("1,240 cases");
  });

  it("uses the singular for one result", () => {
    renderSurface(<FilterBar label="Queue filters" resultCount={1} />);
    expect(screen.getByRole("status")).toHaveTextContent("1 case");
  });

  it("holds the count's place while it is being fetched", () => {
    // Cumulative layout shift is zero on the hot paths (spec §7), so the count
    // reserves its box rather than appearing into the row.
    renderSurface(<FilterBar label="Queue filters" loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Counting…");
  });

  it("removes one filter at a time, by name", async () => {
    const onFilterRemove = vi.fn();
    const user = userEvent.setup();
    renderSurface(
      <FilterBar label="Queue filters" filters={FILTERS} onFilterRemove={onFilterRemove} />,
    );

    await user.click(screen.getByRole("button", { name: "Remove Owner state: Florida" }));
    expect(onFilterRemove).toHaveBeenCalledWith("state");
  });

  it("offers Clear filters only when one chip cannot do the job", () => {
    const single = renderSurface(
      <FilterBar
        label="Queue filters"
        filters={[FILTERS[0] as ActiveFilter]}
        onFiltersClear={vi.fn()}
      />,
    );
    expect(single.queryByRole("button", { name: "Clear filters" })).toBeNull();

    renderSurface(
      <FilterBar label="Owner filters" filters={FILTERS} onFiltersClear={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it("counts the active filters on the builder button", () => {
    renderSurface(
      <FilterBar label="Queue filters" filters={FILTERS} onBuildFilter={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Filters 2 active" })).toBeInTheDocument();
  });

  it("keeps the filters legible when read-only and drops the controls", () => {
    renderSurface(
      <FilterBar
        label="Queue filters"
        views={VIEWS}
        activeViewId="open"
        filters={FILTERS}
        onFilterRemove={vi.fn()}
        onBuildFilter={vi.fn()}
        readOnly
      />,
    );
    expect(screen.queryByRole("button", { name: "Filters" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.getByText("Florida")).toBeInTheDocument();
  });

  it("takes trailing controls from the screen", () => {
    renderSurface(
      <FilterBar label="Queue filters" resultCount={12}>
        <button type="button">Density</button>
      </FilterBar>,
    );
    expect(screen.getByRole("button", { name: "Density" })).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <FilterBar
        label="Queue filters"
        views={VIEWS}
        activeViewId="open"
        filters={FILTERS}
        onViewSelect={() => {}}
        onFilterRemove={() => {}}
        onFiltersClear={() => {}}
        onBuildFilter={() => {}}
        resultCount={1240}
      >
        <button type="button">Density</button>
      </FilterBar>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
