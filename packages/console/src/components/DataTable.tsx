import { useId, useMemo, useState, type ReactNode } from "react";

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  /** Right-aligned and tabular-figured. Use for money, counts, durations. */
  readonly numeric?: boolean;
  /** Supply to make the column sortable. Omit and the header is plain text. */
  readonly sortValue?: (row: T) => string | number;
  /** Exactly one column should set this: it becomes the row's `<th scope="row">`. */
  readonly rowHeader?: boolean;
  readonly render: (row: T) => ReactNode;
}

export type SortDirection = "ascending" | "descending";

export interface SortState {
  readonly columnKey: string;
  readonly direction: SortDirection;
}

export interface DataTableProps<T> {
  /** Always rendered. A table without a caption is a table nobody can identify out of context. */
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly rowClassName?: (row: T) => string | undefined;
  readonly defaultSort?: SortState;
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * A sortable table.
 *
 * A real `<table>` with a real `<caption>`, `<th scope>` on both axes, and
 * `aria-sort` on the sorted column. All of that is what makes a screen reader
 * able to say "Cost, column 5 of 7" while an operator arrows across a row, and
 * none of it survives being rebuilt out of divs.
 *
 * The sort control is a button that fills its header cell, so the hit target
 * is the whole header rather than a small glyph inside it (WCAG 2.2 2.5.8).
 *
 * The class prefix is `pv-dt-`, not `pv-table-`. `ui/surfaces/Table` — the
 * virtualised grid the design gallery demonstrates — already owns `pv-table`,
 * and CSS has one global namespace: the moment both stylesheets are on the
 * page, `display: flex` from that component lands on this component's
 * `<table>` element and the columns collapse. The two are different widgets
 * and they now say so in their class names.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowClassName,
  defaultSort,
}: DataTableProps<T>) {
  const captionId = useId();
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null);

  const sortedRows = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((candidate) => candidate.key === sort.columnKey);
    if (column?.sortValue === undefined) return rows;
    const sortValue = column.sortValue;
    const direction = sort.direction === "ascending" ? 1 : -1;
    // Decorated so the sort is stable: equal keys keep their original order,
    // which matters when a queue is sorted by status and the secondary order
    // is "oldest first".
    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const result = compare(sortValue(left.row), sortValue(right.row));
        return result !== 0 ? result * direction : left.index - right.index;
      })
      .map((entry) => entry.row);
  }, [rows, columns, sort]);

  function toggleSort(columnKey: string): void {
    setSort((current) => {
      if (current?.columnKey !== columnKey) return { columnKey, direction: "ascending" };
      return {
        columnKey,
        direction: current.direction === "ascending" ? "descending" : "ascending",
      };
    });
  }

  return (
    <div className="pv-dt-scroll" tabIndex={0} role="region" aria-labelledby={captionId}>
      <table className="pv-dt">
        <caption id={captionId}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const isSorted = sort?.columnKey === column.key;
              const className = column.numeric === true ? "pv-dt-numeric" : undefined;

              if (column.sortValue === undefined) {
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className={
                      className === undefined
                        ? "pv-dt-plain-header"
                        : `pv-dt-plain-header ${className}`
                    }
                  >
                    {column.header}
                  </th>
                );
              }

              const nextDirection =
                isSorted && sort.direction === "ascending" ? "descending" : "ascending";

              return (
                <th
                  key={column.key}
                  scope="col"
                  className={className}
                  aria-sort={isSorted ? sort.direction : "none"}
                >
                  <button
                    type="button"
                    className="pv-dt-sort"
                    onClick={() => toggleSort(column.key)}
                  >
                    {column.header}
                    <span className="pv-dt-sort-indicator" aria-hidden="true">
                      {isSorted ? (sort.direction === "ascending" ? "▲" : "▼") : "↕"}
                    </span>
                    <span className="pv-sr-only">
                      {isSorted
                        ? `, sorted ${sort.direction}. Activate to sort ${nextDirection}.`
                        : `, not sorted. Activate to sort ascending.`}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={rowKey(row)} className={rowClassName?.(row)}>
              {columns.map((column) => {
                const className = column.numeric === true ? "pv-dt-numeric" : undefined;
                if (column.rowHeader === true) {
                  return (
                    <th key={column.key} scope="row" className={className}>
                      {column.render(row)}
                    </th>
                  );
                }
                return (
                  <td key={column.key} className={className}>
                    {column.render(row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
