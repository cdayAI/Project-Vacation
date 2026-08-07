import type { ReactNode } from "react";
import { Button } from "../primitives/Button";
import { Chip } from "../primitives/Chip";
import { MarkFilter } from "./marks";
import "./FilterBar.css";

/**
 * The bar above the work queue: which view, which filters, how many results.
 *
 * **It holds no state at all.** Spec §3.1 requires every filter state to encode
 * into the URL so a view can be pasted into a ticket, and a component that
 * keeps its own copy of the active filters guarantees that the URL and the
 * screen disagree the first time somebody uses the back button. Everything here
 * is controlled: the screen owns the state, the URL is the state, and this
 * draws it.
 *
 * **The result count is a live region.** An operator who clicks a saved view
 * and hears nothing has no idea whether the filter did anything. It is polite,
 * so it waits for a gap rather than interrupting, and it always carries the
 * noun — "1,240 cases", never a bare number.
 *
 * **Saved views are toggles, not tabs.** They look like pills and a tab list
 * would be the obvious reading, but tabs promise arrow-key movement between
 * panels that are all present, and these swap the contents of one table. A
 * pressed button says exactly what is true.
 *
 * The bar sticks under the top bar and is deliberately not glass: it sits
 * directly over a scrolling virtualized table, which is the one place spec §1.5
 * forbids a blur outright.
 */

export interface SavedView {
  readonly id: string;
  /** "All open", "Mine", "Breaching", "High value", "Unassigned". */
  readonly label: string;
  /** How many rows the view holds, when it is known cheaply. */
  readonly count?: number;
}

export interface ActiveFilter {
  readonly id: string;
  /** What is being filtered. "Owner state". */
  readonly label: string;
  /** What it is filtered to. "Florida". Shown after the label. */
  readonly value?: string;
}

export interface FilterBarProps {
  /** Names the region. "Queue filters", not "Filter bar". */
  readonly label: string;
  readonly views?: readonly SavedView[];
  readonly activeViewId?: string;
  readonly onViewSelect?: (id: string) => void;

  readonly filters?: readonly ActiveFilter[];
  readonly onFilterRemove?: (id: string) => void;
  /** Offered only when more than one filter is active — one chip removes itself. */
  readonly onFiltersClear?: () => void;
  /** Opens the filter builder. The builder itself is a Popover the screen owns. */
  readonly onBuildFilter?: () => void;
  readonly buildFilterLabel?: string;

  /** How many rows the current filters produce. */
  readonly resultCount?: number;
  /** The noun, both numbers. Defaults to case / cases. */
  readonly resultNoun?: { readonly one: string; readonly other: string };
  /** The count is still being fetched. Reserves its space rather than jumping. */
  readonly loading?: boolean;

  /** Trailing controls — the density toggle, a column chooser, an export. */
  readonly children?: ReactNode;
  /** Drops every control and keeps the filters visible as stated facts. */
  readonly readOnly?: boolean;
  readonly className?: string;
}

export function FilterBar({
  label,
  views = [],
  activeViewId,
  onViewSelect,
  filters = [],
  onFilterRemove,
  onFiltersClear,
  onBuildFilter,
  buildFilterLabel = "Filters",
  resultCount,
  resultNoun = { one: "case", other: "cases" },
  loading = false,
  children,
  readOnly = false,
  className,
}: FilterBarProps) {
  const interactive = !readOnly;

  return (
    <section
      className={className === undefined ? "pv-filter-bar" : `pv-filter-bar ${className}`}
      aria-label={label}
      data-read-only={readOnly || undefined}
    >
      {views.length === 0 ? null : (
        <ul className="pv-filter-bar-views">
          {views.map((view) => (
            <li key={view.id}>
              <Chip
                selected={view.id === activeViewId}
                count={view.count}
                disabled={!interactive}
                onSelect={interactive ? () => onViewSelect?.(view.id) : undefined}
              >
                {view.label}
              </Chip>
            </li>
          ))}
        </ul>
      )}

      <div className="pv-filter-bar-filters">
        {onBuildFilter === undefined || readOnly ? null : (
          <Button size="sm" variant="secondary" onClick={onBuildFilter}>
            <MarkFilter size="sm" />
            {buildFilterLabel}
            {filters.length > 0 ? (
              <span className="pv-filter-bar-filter-count" data-numeric>
                {filters.length}
                <span className="pv-sr-only"> active</span>
              </span>
            ) : null}
          </Button>
        )}

        {filters.length === 0 ? null : (
          <ul className="pv-filter-bar-active">
            {filters.map((filter) => (
              <li key={filter.id}>
                <Chip
                  size="sm"
                  label={`${filter.label}${filter.value === undefined ? "" : `: ${filter.value}`}`}
                  onRemove={
                    interactive && onFilterRemove !== undefined
                      ? () => onFilterRemove(filter.id)
                      : undefined
                  }
                >
                  <span className="pv-filter-bar-filter-label">{filter.label}</span>
                  {filter.value === undefined ? null : (
                    <>
                      <span aria-hidden="true">: </span>
                      <span className="pv-filter-bar-filter-value">{filter.value}</span>
                    </>
                  )}
                </Chip>
              </li>
            ))}
          </ul>
        )}

        {/* One filter can remove itself; offering "Clear all" beside a single
            chip is a second control for the same job. */}
        {filters.length > 1 && onFiltersClear !== undefined && interactive ? (
          <Button size="sm" variant="ghost" onClick={onFiltersClear}>
            Clear filters
          </Button>
        ) : null}
      </div>

      <div className="pv-filter-bar-trailing">
        {resultCount === undefined && !loading ? null : (
          <p className="pv-filter-bar-count" role="status" data-numeric>
            {loading || resultCount === undefined
              ? "Counting…"
              : `${resultCount.toLocaleString()} ${
                  resultCount === 1 ? resultNoun.one : resultNoun.other
                }`}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}
