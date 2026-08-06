import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { useTheme } from "../../theme/ThemeProvider";
import { Button } from "../primitives/Button";
import { IconChevronDown, IconDash } from "../primitives/icons";
import type { Density } from "../../theme/preferences";
import {
  moveColumn,
  readStoredTableView,
  resolveTableView,
  toggleColumnVisibility,
  writeStoredTableView,
  type ColumnConstraints,
} from "./columnPreferences";
import { useVirtualScrollerRegistration } from "./glassSurface";
import { Popover, popoverTriggerProps } from "./Popover";
import { ReadOnlyChip } from "./ReadOnlyChip";
import { ResizeSeparator } from "./ResizeSeparator";
import { SurfaceState } from "./SurfaceState";
import { computeVirtualWindow, scrollOffsetForIndex } from "./virtualRows";
import "./Table.css";

/**
 * The table. The most load-bearing thing in the console.
 *
 * Spec §7 asks for 10,000 rows without jank, §3.1 fixes the row heights to the
 * density preference and the interaction model to `J`/`K`/`Enter`/`Space`/`X`,
 * and §1.6 forbids animating a sort. All of that is here. The part worth
 * reading before changing anything is the accessibility, because a virtualized
 * table is where accessibility usually dies and it dies quietly.
 *
 * -----------------------------------------------------------------------------
 * TELLING THE TRUTH ABOUT HOW MANY ROWS THERE ARE
 *
 * Thirty rows exist in the DOM at any moment. If nothing says otherwise, a
 * screen reader announces "table, 7 columns, 30 rows" — and an operator triaging
 * a queue of 1,240 has just been told, with total confidence, something false.
 * They will act on it.
 *
 * So the table carries `aria-rowcount` for the real total and every row carries
 * its real `aria-rowindex`. "Row 6,402 of 10,000" is then true whatever is
 * mounted. `totalRowCount` exists for the case where `rows` is what has loaded
 * so far and the server knows the rest.
 *
 * -----------------------------------------------------------------------------
 * WHY role="grid" AND NOT A PLAIN TABLE
 *
 * Because it is one. `J` and `K` move a cursor, `Enter` opens, `Space` previews,
 * `X` selects, `Shift+J` extends a range — that is a widget, and calling it a
 * document table promises arrow-key reading behaviour that does not happen
 * here. Focus lives on the row rather than the cell, which is the row-based
 * grid pattern and matches what an approver is actually doing: choosing rows,
 * not reading cells.
 *
 * The active row is a roving `tabindex`, so the table is one Tab stop and never
 * forty. When a manual scroll takes the active row out of the mounted window,
 * the active row is released rather than pointed at an element that no longer
 * exists — the next `J` continues from the top of what the operator can see,
 * which is also what they would expect.
 *
 * -----------------------------------------------------------------------------
 * WHY SORTING IS NOT ANIMATED, EVER
 *
 * §1.6 is explicit and it is right: sorting re-renders instantly. An animated
 * sort makes the operator wait to read an answer they already asked for, and at
 * 10,000 rows it is also 10,000 elements the compositor has been asked to move.
 * There is no transition on a row in Table.css. Adding one is a defect.
 */

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface TableColumn<T> {
  readonly key: string;
  /** The visible header. Keep it to a word or two. */
  readonly header: string;
  /** The accessible name, when the visible header is a glyph or an abbreviation. */
  readonly headerLabel?: string;
  /** Starting width in pixels. The operator's stored width wins over it. */
  readonly width?: number;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  /** Right-aligned and decimal-aligned. For money, counts, durations. */
  readonly numeric?: boolean;
  /** Exactly one column should set this: it becomes the row's `<th scope="row">`. */
  readonly rowHeader?: boolean;
  /** Default true. False for a fixed-width marker column. */
  readonly resizable?: boolean;
  /** Cannot be hidden by the column chooser. Set it on the row header. */
  readonly alwaysVisible?: boolean;
  /**
   * Supply to make the column sortable. Omit `onSortChange` as well and the
   * table sorts itself; supply `onSortChange` and it reports the intent and
   * renders whatever order it is given, which is what a server-paged table
   * needs.
   */
  readonly sortValue?: (row: T) => string | number;
  readonly cell: (row: T) => ReactNode;
}

export type SortDirection = "ascending" | "descending";

export interface TableSort {
  readonly columnKey: string;
  readonly direction: SortDirection;
}

export interface TableProps<T> {
  /**
   * Names the table. Always required: a table with no caption is a table
   * nobody can identify out of context, and "out of context" is what a screen
   * reader's element list is.
   */
  readonly caption: string;
  /** Where this operator's column order, widths and visibility are stored. */
  readonly tableId: string;
  readonly columns: readonly TableColumn<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;

  /** The total across every page, when `rows` is only what has loaded. */
  readonly totalRowCount?: number;
  /** The noun in the count: "1,240 cases". Plural. */
  readonly rowNoun?: string;

  readonly sort?: TableSort | null;
  readonly onSortChange?: (sort: TableSort | null) => void;

  /** The row cursor. Bind it to keep it in sync with a preview panel. */
  readonly activeKey?: string | null;
  readonly onActiveKeyChange?: (key: string | null) => void;

  readonly selectedKeys?: ReadonlySet<string>;
  /** `X`, and the row's checkbox if the screen renders one. */
  readonly onToggleSelect?: (key: string, row: T) => void;
  /** `Shift+J` / `Shift+K`. Receives the whole inclusive range. */
  readonly onSelectRange?: (keys: readonly string[]) => void;
  /** `Enter`. */
  readonly onOpenRow?: (key: string, row: T) => void;
  /** `Space` — preview without navigating (spec §3.1). */
  readonly onPreviewRow?: (key: string, row: T) => void;

  /** Called once when the operator reaches the end. For infinite scroll. */
  readonly onEndReached?: () => void;

  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  /**
   * Auditors live here. Navigation, preview, sorting and column configuration
   * all stay — none of them changes anything. Selection goes, because
   * selection exists to feed bulk actions.
   */
  readonly readOnly?: boolean;
  readonly className?: string;
}

/**
 * Row heights, in the pixels the tokens produce.
 *
 * Virtualization needs the number in JavaScript and CSS needs it as a token;
 * this is the one place they are allowed to be the same value twice, and
 * Table.test.tsx parses tokens.css and asserts they still agree. A row height
 * that drifts from `--pv-row-height` does not look wrong — it makes the
 * scrollbar lie and the keyboard cursor drift a row every few pages.
 */
export const ROW_HEIGHT_PX: Readonly<Record<Density, number>> = {
  comfortable: 52,
  compact: 40,
};

/** The keys this table binds, for a shortcut reference to render (spec §5). */
export const TABLE_SHORTCUTS = [
  { keys: "J / ↓", action: "Next row" },
  { keys: "K / ↑", action: "Previous row" },
  { keys: "Enter", action: "Open the focused row" },
  { keys: "Space", action: "Preview the focused row" },
  { keys: "X", action: "Toggle selection" },
  { keys: "Shift J / Shift K", action: "Extend the selection" },
  { keys: "Home / End", action: "First / last row" },
] as const;

const DEFAULT_COLUMN_WIDTH = 160;
const DEFAULT_MIN_COLUMN_WIDTH = 64;
const DEFAULT_MAX_COLUMN_WIDTH = 640;
/** Rows of skeleton drawn while the first page is loading. */
const SKELETON_ROWS = 8;
/** How close to the bottom counts as "reached the end", in rows. */
const END_REACHED_ROWS = 6;

// ---------------------------------------------------------------------------

export function Table<T>({
  caption,
  tableId,
  columns,
  rows,
  rowKey,
  totalRowCount,
  rowNoun = "rows",
  sort,
  onSortChange,
  activeKey,
  onActiveKeyChange,
  selectedKeys,
  onToggleSelect,
  onSelectRange,
  onOpenRow,
  onPreviewRow,
  onEndReached,
  loading = false,
  error,
  empty,
  readOnly = false,
  className,
}: TableProps<T>) {
  const { density } = useTheme();
  const rowHeight = ROW_HEIGHT_PX[density];

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const columnsButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocusKey = useRef<string | null>(null);
  const rangeAnchorKey = useRef<string | null>(null);
  const endReachedAt = useRef(-1);

  const captionId = useId();
  const columnsPopoverId = useId();

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [internalSort, setInternalSort] = useState<TableSort | null>(null);
  const [internalActiveKey, setInternalActiveKey] = useState<string | null>(null);

  // A blurred surface over a list that repaints as it scrolls costs a
  // full-viewport re-sample per frame. Registering here is what makes the blur
  // budget refuse an anchored surface while this table exists (spec §1.5).
  useVirtualScrollerRegistration();

  // ---------------------------------------------------------------------------
  // Column view: order, visibility, widths
  // ---------------------------------------------------------------------------

  const constraints = useMemo<readonly ColumnConstraints[]>(
    () =>
      columns.map((column) => ({
        key: column.key,
        width: column.width ?? DEFAULT_COLUMN_WIDTH,
        minWidth: column.minWidth ?? DEFAULT_MIN_COLUMN_WIDTH,
        maxWidth: column.maxWidth ?? DEFAULT_MAX_COLUMN_WIDTH,
        alwaysVisible: column.alwaysVisible === true || column.rowHeader === true,
      })),
    [columns],
  );

  const definitionSignature = constraints.map((column) => column.key).join(" ");

  const [view, setView] = useState(() =>
    resolveTableView(constraints, readStoredTableView(tableId)),
  );

  // Re-resolve when the build's column set changes, so a release that adds a
  // column does not leave it invisible behind a stored order.
  useEffect(() => {
    setView(resolveTableView(constraints, readStoredTableView(tableId)));
    // The signature rather than the array: a new array of the same columns on
    // every render would re-read storage on every render.
  }, [definitionSignature, tableId]);

  const persist = useCallback(
    (next: ReturnType<typeof resolveTableView>) => {
      setView(next);
      writeStoredTableView(tableId, {
        order: next.order,
        hidden: [...next.hidden],
        widths: next.widths,
      });
    },
    [tableId],
  );

  const byKey = useMemo(() => new Map(columns.map((column) => [column.key, column])), [columns]);
  const visibleColumns = useMemo(
    () =>
      view.order
        .filter((key) => !view.hidden.has(key))
        .map((key) => byKey.get(key))
        .filter((column): column is TableColumn<T> => column !== undefined),
    [view, byKey],
  );

  // ---------------------------------------------------------------------------
  // Sorting
  // ---------------------------------------------------------------------------

  const controlledSort = onSortChange !== undefined;
  const activeSort = controlledSort ? (sort ?? null) : internalSort;

  const orderedRows = useMemo(() => {
    if (controlledSort || activeSort === null) return rows;
    const column = byKey.get(activeSort.columnKey);
    const sortValue = column?.sortValue;
    if (sortValue === undefined) return rows;

    const direction = activeSort.direction === "ascending" ? 1 : -1;
    // Decorated so the sort is stable: equal keys keep their original order,
    // which is what makes "sorted by status, oldest first within a status"
    // actually behave that way.
    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const result = compareValues(sortValue(left.row), sortValue(right.row));
        return result !== 0 ? result * direction : left.index - right.index;
      })
      .map((entry) => entry.row);
  }, [rows, byKey, activeSort, controlledSort]);

  function toggleSort(column: TableColumn<T>): void {
    const next: TableSort =
      activeSort?.columnKey === column.key && activeSort.direction === "ascending"
        ? { columnKey: column.key, direction: "descending" }
        : { columnKey: column.key, direction: "ascending" };
    if (controlledSort) onSortChange?.(next);
    else setInternalSort(next);
  }

  // ---------------------------------------------------------------------------
  // Measurement and windowing
  // ---------------------------------------------------------------------------

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (element === null) return;

    const measure = (): void => setViewportHeight(element.clientHeight);
    measure();

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    // Some embedded webviews have no ResizeObserver. A window resize is the
    // only signal left, and it covers the case that actually happens.
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const rowCount = orderedRows.length;
  const window_ = computeVirtualWindow({
    rowCount,
    rowHeight,
    viewportHeight,
    scrollTop,
  });

  const announcedTotal = totalRowCount ?? rowCount;

  // ---------------------------------------------------------------------------
  // The row cursor
  // ---------------------------------------------------------------------------

  const controlledActive = onActiveKeyChange !== undefined && activeKey !== undefined;
  const currentActiveKey = controlledActive ? (activeKey ?? null) : internalActiveKey;

  const keys = useMemo(() => orderedRows.map((row) => rowKey(row)), [orderedRows, rowKey]);
  const activeIndex = currentActiveKey === null ? -1 : keys.indexOf(currentActiveKey);

  const setActive = useCallback(
    (key: string | null) => {
      if (!controlledActive) setInternalActiveKey(key);
      onActiveKeyChange?.(key);
    },
    [controlledActive, onActiveKeyChange],
  );

  // A manual scroll can take the active row out of the mounted window. Pointing
  // focus at an element that no longer exists sends it to <body> without
  // warning, so the cursor is released instead and the next J continues from
  // what the operator can actually see.
  useEffect(() => {
    if (activeIndex < 0) return;
    if (activeIndex >= window_.startIndex && activeIndex < window_.endIndex) return;
    if (pendingFocusKey.current !== null) return;
    setActive(null);
  }, [activeIndex, window_.startIndex, window_.endIndex, setActive]);

  // Focus follows the cursor, once the row it names has been rendered.
  useLayoutEffect(() => {
    const key = pendingFocusKey.current;
    if (key === null) return;
    const element = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-row-key="${CSS.escape(key)}"]`,
    );
    if (element === null || element === undefined) return;
    pendingFocusKey.current = null;
    element.focus();
  });

  function moveCursor(toIndex: number, extendSelection: boolean): void {
    if (rowCount === 0) return;
    const bounded = Math.min(rowCount - 1, Math.max(0, toIndex));
    const key = keys[bounded];
    if (key === undefined) return;

    const offset = scrollOffsetForIndex({
      index: bounded,
      rowCount,
      rowHeight,
      viewportHeight,
      scrollTop,
    });
    if (offset !== null) {
      // Written to the element and to state. The element is the truth in a
      // browser; the state is what makes the row exist to be focused in the
      // same commit, and the element's own scroll event reconciles the two.
      const scroller = scrollerRef.current;
      if (scroller !== null) scroller.scrollTop = offset;
      setScrollTop(offset);
    }

    if (extendSelection && !readOnly && onSelectRange !== undefined) {
      const anchor = rangeAnchorKey.current ?? currentActiveKey ?? key;
      rangeAnchorKey.current = anchor;
      const anchorIndex = keys.indexOf(anchor);
      if (anchorIndex >= 0) {
        const from = Math.min(anchorIndex, bounded);
        const to = Math.max(anchorIndex, bounded);
        onSelectRange(keys.slice(from, to + 1));
      }
    } else {
      rangeAnchorKey.current = key;
    }

    pendingFocusKey.current = key;
    setActive(key);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLTableSectionElement>): void {
    if (rowCount === 0) return;
    const key = event.key;
    const lower = key.toLowerCase();
    const from = activeIndex >= 0 ? activeIndex : window_.startIndex - 1;
    const rowsPerPage = Math.max(1, Math.floor((viewportHeight || rowHeight) / rowHeight));

    if (lower === "j" || key === "ArrowDown") {
      moveCursor(from + 1, event.shiftKey);
    } else if (lower === "k" || key === "ArrowUp") {
      moveCursor(activeIndex >= 0 ? activeIndex - 1 : window_.startIndex, event.shiftKey);
    } else if (key === "Home") {
      moveCursor(0, event.shiftKey);
    } else if (key === "End") {
      moveCursor(rowCount - 1, event.shiftKey);
    } else if (key === "PageDown") {
      moveCursor(from + rowsPerPage, event.shiftKey);
    } else if (key === "PageUp") {
      moveCursor((activeIndex >= 0 ? activeIndex : window_.startIndex) - rowsPerPage, event.shiftKey);
    } else if (key === "Enter") {
      const row = orderedRows[activeIndex];
      if (row !== undefined && currentActiveKey !== null) onOpenRow?.(currentActiveKey, row);
    } else if (key === " " || key === "Spacebar") {
      const row = orderedRows[activeIndex];
      if (row !== undefined && currentActiveKey !== null) onPreviewRow?.(currentActiveKey, row);
    } else if (lower === "x") {
      if (readOnly) return;
      const row = orderedRows[activeIndex];
      if (row !== undefined && currentActiveKey !== null) onToggleSelect?.(currentActiveKey, row);
    } else {
      return;
    }

    // Space would scroll the page and the arrows would scroll the container
    // out from under the cursor we just moved.
    event.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // Scrolling
  // ---------------------------------------------------------------------------

  function onScroll(event: UIEvent<HTMLDivElement>): void {
    const element = event.currentTarget;
    setScrollTop(element.scrollTop);

    if (onEndReached === undefined || rowCount === 0) return;
    const remaining = rowCount - Math.ceil((element.scrollTop + element.clientHeight) / rowHeight);
    if (remaining > END_REACHED_ROWS) return;
    // Once per batch of rows: without the guard, every scroll frame near the
    // bottom asks for the next page again.
    if (endReachedAt.current === rowCount) return;
    endReachedAt.current = rowCount;
    onEndReached();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const showEmptyState = rowCount === 0;
  const selection = readOnly ? undefined : selectedKeys;
  const selectable = !readOnly && (onToggleSelect !== undefined || onSelectRange !== undefined);

  return (
    <div className={className === undefined ? "pv-table" : `pv-table ${className}`}>
      <div className="pv-table-toolbar">
        <p className="pv-table-count" role="status" data-numeric>
          {announcedTotal.toLocaleString()} {rowNoun}
        </p>
        <div className="pv-table-toolbar-trailing">
          {readOnly ? <ReadOnlyChip /> : null}
          <Button
            ref={columnsButtonRef}
            variant="secondary"
            size="sm"
            onClick={() => setColumnsOpen((current) => !current)}
            {...popoverTriggerProps(columnsPopoverId, columnsOpen)}
          >
            Columns
          </Button>
        </div>
      </div>

      <ColumnChooser
        id={columnsPopoverId}
        open={columnsOpen}
        onClose={() => setColumnsOpen(false)}
        anchorRef={columnsButtonRef}
        columns={columns}
        view={view}
        onChange={persist}
      />

      <div
        className="pv-table-scroller"
        ref={scrollerRef}
        onScroll={onScroll}
        aria-busy={loading || undefined}
      >
        <table
          className="pv-table-grid"
          role="grid"
          aria-labelledby={captionId}
          // The truth about how many rows there are, whatever is mounted. The
          // +1 is the header row, which occupies index 1 in this coordinate
          // space.
          aria-rowcount={announcedTotal + 1}
          aria-multiselectable={selectable || undefined}
          aria-readonly={readOnly || undefined}
        >
          <caption className="pv-sr-only" id={captionId}>
            {caption}
          </caption>

          <colgroup>
            {visibleColumns.map((column) => (
              <col key={column.key} style={{ width: `${view.widths[column.key] ?? DEFAULT_COLUMN_WIDTH}px` }} />
            ))}
          </colgroup>

          <thead>
            <tr aria-rowindex={1}>
              {visibleColumns.map((column) => (
                <HeaderCell
                  key={column.key}
                  column={column}
                  sort={activeSort}
                  width={view.widths[column.key] ?? DEFAULT_COLUMN_WIDTH}
                  onSort={() => toggleSort(column)}
                  onResize={(width) =>
                    setView((current) => ({ ...current, widths: { ...current.widths, [column.key]: width } }))
                  }
                  onResizeCommit={(width) =>
                    persist({ ...view, widths: { ...view.widths, [column.key]: width } })
                  }
                />
              ))}
            </tr>
          </thead>

          <tbody onKeyDown={onKeyDown}>
            {showEmptyState ? (
              <tr aria-rowindex={2}>
                <td className="pv-table-state" colSpan={Math.max(1, visibleColumns.length)}>
                  <SurfaceState
                    loading={loading}
                    error={error}
                    empty={empty ?? "Nothing needs you right now."}
                    skeletonLines={SKELETON_ROWS}
                  />
                </td>
              </tr>
            ) : (
              <>
                {window_.leadingSpace > 0 ? (
                  <SpacerRow height={window_.leadingSpace} columns={visibleColumns.length} />
                ) : null}
                {orderedRows.slice(window_.startIndex, window_.endIndex).map((row, offset) => {
                  const index = window_.startIndex + offset;
                  const key = keys[index] ?? String(index);
                  const isActive = key === currentActiveKey;
                  const isSelected = selection?.has(key) === true;
                  return (
                    <tr
                      key={key}
                      data-row-key={key}
                      className="pv-table-row"
                      // Real position in the whole set, not in the mounted
                      // window. +2 for the header row and for 1-based indexing.
                      aria-rowindex={index + 2}
                      aria-selected={selectable ? isSelected : undefined}
                      data-selected={isSelected || undefined}
                      data-active={isActive || undefined}
                      // One Tab stop for the whole table, never one per row.
                      tabIndex={isActive || (currentActiveKey === null && index === window_.startIndex) ? 0 : -1}
                      onFocus={() => {
                        if (key !== currentActiveKey) setActive(key);
                      }}
                      onClick={() => {
                        pendingFocusKey.current = key;
                        setActive(key);
                      }}
                      onDoubleClick={() => onOpenRow?.(key, row)}
                    >
                      {visibleColumns.map((column) => {
                        const content = column.cell(row);
                        const cellClass = column.numeric === true ? "pv-table-cell pv-table-numeric" : "pv-table-cell";
                        return column.rowHeader === true ? (
                          <th key={column.key} scope="row" className={cellClass}>
                            {content}
                          </th>
                        ) : (
                          <td key={column.key} className={cellClass}>
                            {content}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {window_.trailingSpace > 0 ? (
                  <SpacerRow height={window_.trailingSpace} columns={visibleColumns.length} />
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The spacers that give the scrollbar the size of the whole list.
 *
 * Hidden from assistive technology: they are geometry, and a screen reader that
 * walks into a 520,000-pixel empty row has been told something absurd. The real
 * count is `aria-rowcount` and the real position is `aria-rowindex`, both of
 * which are unaffected by these.
 */
function SpacerRow({ height, columns }: { readonly height: number; readonly columns: number }) {
  // A computed offset in pixels, not a design value: it is the row height times
  // a count, and there is no token for "however many rows are above here". The
  // height goes on the cell as well as the row, because a row's height is a
  // minimum that its cells can and do override.
  return (
    <tr aria-hidden="true" className="pv-table-spacer" style={{ height: `${height}px` }}>
      <td colSpan={Math.max(1, columns)} style={{ height: `${height}px` }} />
    </tr>
  );
}

function HeaderCell<T>({
  column,
  sort,
  width,
  onSort,
  onResize,
  onResizeCommit,
}: {
  readonly column: TableColumn<T>;
  readonly sort: TableSort | null;
  readonly width: number;
  readonly onSort: () => void;
  readonly onResize: (width: number) => void;
  readonly onResizeCommit: (width: number) => void;
}) {
  const sortable = column.sortValue !== undefined;
  const isSorted = sort?.columnKey === column.key;
  const label = column.headerLabel ?? column.header;
  const resizable = column.resizable !== false;

  return (
    <th
      scope="col"
      className={column.numeric === true ? "pv-table-header pv-table-numeric" : "pv-table-header"}
      aria-sort={sortable ? (isSorted ? sort.direction : "none") : undefined}
    >
      {sortable ? (
        // The button fills the cell, so the target is the header rather than a
        // glyph inside it (WCAG 2.2 2.5.8).
        <button type="button" className="pv-table-sort" onClick={onSort}>
          <span className="pv-table-header-label">{column.header}</span>
          {/* Three distinct shapes, not three colours and not three characters:
              a glyph like ▲ renders as a box in some fonts, and a mark that
              disappears takes away the second channel the specification
              requires beside aria-sort. */}
          <span className="pv-table-sort-mark" data-sorted={isSorted || undefined}>
            {isSorted ? (
              <IconChevronDown
                size="sm"
                className={sort.direction === "ascending" ? "pv-table-sort-ascending" : undefined}
              />
            ) : (
              <IconDash size="sm" />
            )}
          </span>
          <span className="pv-sr-only">
            {isSorted
              ? `${label}, sorted ${sort.direction}. Activate to sort ${
                  sort.direction === "ascending" ? "descending" : "ascending"
                }.`
              : `${label}, not sorted. Activate to sort ascending.`}
          </span>
        </button>
      ) : (
        <span className="pv-table-header-label">
          {column.header}
          {column.headerLabel === undefined ? null : (
            <span className="pv-sr-only">{column.headerLabel}</span>
          )}
        </span>
      )}

      {resizable ? (
        <ResizeSeparator
          label={`${label} column width`}
          value={width}
          min={column.minWidth ?? DEFAULT_MIN_COLUMN_WIDTH}
          max={column.maxWidth ?? DEFAULT_MAX_COLUMN_WIDTH}
          onChange={onResize}
          onCommit={onResizeCommit}
        />
      ) : null}
    </th>
  );
}

/**
 * The column chooser.
 *
 * Reordering is buttons, not drag. A drag-only reorder is unusable from a
 * keyboard, unpleasant with a trackpad, and impossible with a tremor — and
 * spec §3.1 makes column order a per-user setting, which means every user has
 * to be able to set it.
 */
function ColumnChooser<T>({
  id,
  open,
  onClose,
  anchorRef,
  columns,
  view,
  onChange,
}: {
  readonly id: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorRef: RefObject<HTMLButtonElement | null>;
  readonly columns: readonly TableColumn<T>[];
  readonly view: ReturnType<typeof resolveTableView>;
  readonly onChange: (next: ReturnType<typeof resolveTableView>) => void;
}) {
  const byKey = new Map(columns.map((column) => [column.key, column]));

  return (
    <Popover
      id={id}
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      title="Columns"
      placement="bottom-end"
    >
      <ul className="pv-table-column-list">
        {view.order.map((key, index) => {
          const column = byKey.get(key);
          if (column === undefined) return null;
          const pinned = column.alwaysVisible === true || column.rowHeader === true;
          const hidden = view.hidden.has(key);
          return (
            <li key={key} className="pv-table-column-row">
              <label className="pv-table-column-toggle">
                <input
                  type="checkbox"
                  checked={!hidden}
                  disabled={pinned}
                  onChange={() =>
                    onChange({
                      ...view,
                      hidden: toggleColumnVisibility(view.hidden, view.order, key),
                    })
                  }
                />
                {column.header}
                {pinned ? <span className="pv-sr-only">, always shown</span> : null}
              </label>
              <span className="pv-table-column-move">
                <Button
                  iconOnly
                  variant="ghost"
                  size="sm"
                  label={`Move ${column.header} earlier`}
                  disabled={index === 0}
                  onClick={() => onChange({ ...view, order: moveColumn(view.order, key, index - 1) })}
                >
                  <IconChevronDown className="pv-table-column-move-up" />
                </Button>
                <Button
                  iconOnly
                  variant="ghost"
                  size="sm"
                  label={`Move ${column.header} later`}
                  disabled={index === view.order.length - 1}
                  onClick={() => onChange({ ...view, order: moveColumn(view.order, key, index + 1) })}
                >
                  <IconChevronDown />
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </Popover>
  );
}

function compareValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  // `numeric` so "case 2" sorts before "case 10", and a base sensitivity so a
  // capitalised owner name does not sort into its own group.
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
