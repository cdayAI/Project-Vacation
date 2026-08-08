import { useId, useMemo, useState, type ReactNode } from "react";
import { useClient } from "../api/ClientProvider";
import type { RiskTier, RoleView } from "../api/contract";
import { useResource } from "../api/useResource";
import { formatDateTime, formatPercent, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import type { StatusTone } from "../theme/tokens";
import { Badge, Callout, EmptyState, IconAlert, IconBlocked, IconCircle, MarkUndo, Select } from "../ui";

/**
 * The role registry.
 *
 * An agent role is the unit of authority in this platform: it names what an
 * agent may do, over what data, up to what risk tier, and with what human
 * involvement. This screen is the answer to "what is allowed to run here", and
 * two facts have to survive a fast scan of it.
 *
 * **A disabled role.** Disabled means stopped, usually deliberately and usually
 * for a reason. It is stated in its own column, in words, and the row is
 * marked; it is never signalled by colour alone.
 *
 * **An evaluation that does not meet its threshold.** A role can be in service
 * and still be scoring below the bar its owner set for it — that is exactly the
 * situation somebody needs to notice — so the measured accuracy, the threshold,
 * and whether one clears the other are all shown rather than reduced to a tick.
 */

// ---------------------------------------------------------------------------
// The status vocabulary this screen speaks
// ---------------------------------------------------------------------------

/**
 * A status, in words, with a tone and a mark laid on top of the words rather
 * than in place of them. The label is what survives greyscale and a printed
 * evidence export, so it is the carrier (WCAG 1.4.1).
 *
 * A mark is named explicitly only where the tone's own default would say
 * something different from what the status means. `Badge` keys its default mark
 * by tone alone, so four separate danger badges appear in a single row of this
 * table — disabled, high consequence, below threshold — and would arrive at one
 * indistinguishable cross unless the shapes are asked for.
 */
interface Presentation {
  readonly label: string;
  readonly tone: StatusTone;
  readonly icon?: ReactNode;
}

/**
 * Role lifecycle status.
 *
 * "Disabled" is deliberately the loudest of the five. A disabled role is not a
 * dormant one — it has been stopped, usually for a reason someone recorded —
 * and a registry that renders it in the same grey as "draft" hides the single
 * most operationally significant thing about it.
 */
const ROLE_STATUS: Readonly<Record<RoleView["status"], Presentation>> = {
  draft: { label: "Draft", tone: "neutral", icon: <IconCircle size="sm" /> },
  proposed: { label: "Proposed", tone: "info" },
  promoted: { label: "In service", tone: "success" },
  disabled: { label: "Disabled", tone: "danger", icon: <IconBlocked size="sm" /> },
  reverted: { label: "Reverted", tone: "warning", icon: <MarkUndo size="sm" /> },
};

function roleStatusLabel(status: RoleView["status"]): string {
  return ROLE_STATUS[status].label;
}

function RoleStatusBadge({ status }: { readonly status: RoleView["status"] }) {
  const presentation = ROLE_STATUS[status];
  return (
    <Badge tone={presentation.tone} icon={presentation.icon}>
      {presentation.label}
    </Badge>
  );
}

const RISK: Readonly<Record<RiskTier, Presentation>> = {
  routine: { label: "Routine", tone: "neutral" },
  sensitive: { label: "Sensitive", tone: "info" },
  high_consequence: { label: "High consequence", tone: "danger", icon: <IconAlert size="sm" /> },
  // Not "danger": a tier nothing may reach is the ceiling working, not a fault.
  prohibited: { label: "Prohibited", tone: "denied" },
};

function riskLabel(risk: RiskTier): string {
  return RISK[risk].label;
}

/** The pill says "Routine risk"; the bare label is for sorting and prose. */
function RiskBadge({ risk }: { readonly risk: RiskTier }) {
  const presentation = RISK[risk];
  return (
    <Badge tone={presentation.tone} icon={presentation.icon}>
      {presentation.label} risk
    </Badge>
  );
}

type Availability = "all" | "enabled" | "disabled";

const AVAILABILITY_OPTIONS = [
  { value: "all", label: "All roles" },
  { value: "enabled", label: "Available only" },
  { value: "disabled", label: "Disabled only" },
] as const;

export interface RoleRegistryProps {
  readonly roles: readonly RoleView[];
  readonly total?: number;
}

export function RoleRegistry({ roles, total }: RoleRegistryProps) {
  const [showDisabled, setShowDisabled] = useState<Availability>("all");

  const visible = useMemo(
    () =>
      roles.filter((role) => {
        if (showDisabled === "enabled") return !role.disabled;
        if (showDisabled === "disabled") return role.disabled;
        return true;
      }),
    [roles, showDisabled],
  );

  const disabledCount = roles.filter((role) => role.disabled).length;
  const belowThreshold = roles.filter(
    (role) => role.latestEvaluation !== undefined && !role.latestEvaluation.meetsThreshold,
  );
  const unevaluated = roles.filter((role) => role.latestEvaluation === undefined);

  const columns: readonly SortableColumn<RoleView>[] = [
    {
      key: "name",
      header: "Role",
      rowHeader: true,
      sortValue: (role) => role.name,
      render: (role) => (
        <span className="pv-stack-tight">
          <Link to={`/roles/${role.roleId}`}>{role.name}</Link>
          <span className="pv-meta pv-mono">{role.roleId}</span>
        </span>
      ),
    },
    {
      key: "availability",
      header: "Available",
      sortValue: (role) => (role.disabled ? 0 : 1),
      render: (role) =>
        role.disabled ? (
          <Badge tone="danger" icon={<IconBlocked size="sm" />}>
            Disabled
          </Badge>
        ) : (
          <span className="pv-meta">Available</span>
        ),
    },
    {
      key: "status",
      header: "Lifecycle",
      sortValue: (role) => roleStatusLabel(role.status),
      render: (role) => <RoleStatusBadge status={role.status} />,
    },
    {
      key: "version",
      header: "Version",
      numeric: true,
      sortValue: (role) => role.version,
      render: (role) => <span>{role.version}</span>,
    },
    {
      key: "riskCeiling",
      header: "Risk ceiling",
      sortValue: (role) => riskLabel(role.riskCeiling),
      render: (role) => <RiskBadge risk={role.riskCeiling} />,
    },
    {
      key: "evaluation",
      header: "Latest evaluation",
      sortValue: (role) => role.latestEvaluation?.accuracy ?? -1,
      render: (role) => {
        const evaluation = role.latestEvaluation;
        if (evaluation === undefined) {
          return <span className="pv-meta">Never evaluated</span>;
        }
        return (
          <span className="pv-stack-tight">
            <span>
              {formatPercent(evaluation.accuracy)} against a {formatPercent(evaluation.threshold, 0)}{" "}
              threshold
            </span>
            {evaluation.meetsThreshold ? (
              <span className="pv-meta">Meets threshold</span>
            ) : (
              <Badge tone="danger" icon={<IconAlert size="sm" />}>
                Below threshold
              </Badge>
            )}
          </span>
        );
      },
    },
    {
      key: "humanInvolvement",
      header: "Human involvement",
      sortValue: (role) => role.humanInvolvement,
      render: (role) => <span>{role.humanInvolvement}</span>,
    },
    {
      key: "updatedAt",
      header: "Last changed",
      sortValue: (role) => role.updatedAt,
      render: (role) => (
        <span className="pv-stack-tight">
          <time dateTime={role.updatedAt}>{formatDateTime(role.updatedAt)}</time>
          <span className="pv-meta">{role.updatedBy.displayName}</span>
        </span>
      ),
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>Agent roles</h1>
        <p className="pv-page-lede">
          Every role the platform can run, with what it is permitted to do, the data it may see,
          the risk tier it may not exceed, and how it last scored against its curated evaluation
          set.
        </p>
      </div>

      <div className="pv-toolbar">
        <Select
          label="Availability"
          options={AVAILABILITY_OPTIONS}
          value={showDisabled}
          onChange={(value) => setShowDisabled(value as Availability)}
        />
      </div>

      <p role="status" className="pv-meta">
        Showing {pluralise(visible.length, "role", "roles")}
        {total !== undefined && total !== roles.length ? ` of ${total} on the server` : ""}.
      </p>

      {disabledCount > 0 && (
        <Callout
          tone="warning"
          title={`${pluralise(disabledCount, "role is", "roles are")} disabled`}
        >
          <p>
            A disabled role will not run. Anything that depends on it stops rather than proceeds
            without it, which is the intended behaviour — but it is worth knowing whether the
            disabling was deliberate and whether anyone is waiting on it.
          </p>
        </Callout>
      )}

      {belowThreshold.length > 0 && (
        <Callout
          tone="danger"
          title={`${pluralise(belowThreshold.length, "role is", "roles are")} scoring below the threshold set for it`}
        >
          <p>
            {belowThreshold.map((role) => role.name).join(", ")}. A role below its threshold is
            still permitted to run if it is in service. Whether it should be is a decision for its
            owner, and the evaluation column is the evidence for it.
          </p>
        </Callout>
      )}

      {unevaluated.length > 0 && (
        <Callout
          tone="info"
          title={`${pluralise(unevaluated.length, "role has", "roles have")} never been evaluated`}
        >
          <p>
            {unevaluated.map((role) => role.name).join(", ")}. &ldquo;Not measured&rdquo; is a
            different statement from &ldquo;measured and adequate&rdquo;, and only one of them is
            reassuring.
          </p>
        </Callout>
      )}

      {visible.length === 0 ? (
        <EmptyState
          title={
            showDisabled === "all" ? "No roles are registered" : "No role matches this filter"
          }
          body={
            showDisabled === "all"
              ? "Nothing has been registered yet. Until a role exists, the platform has nothing it is permitted to run."
              : "Change the availability filter to see the rest of the registry."
          }
          headingLevel={2}
        />
      ) : (
        <SortableTable
          caption={`Agent roles, ${pluralise(visible.length, "role", "roles")}.`}
          columns={columns}
          rows={visible}
          rowKey={(role) => role.roleId}
          rowClassName={(role) => (role.disabled ? "pv-row-denied" : undefined)}
          defaultSort={{ columnKey: "availability", direction: "ascending" }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * A sortable table, kept here rather than reached for from `ui/surfaces/Table`.
 *
 * The registry's one non-negotiable is that a disabled role reads as stopped
 * from across the room: the *whole row* is marked, not one cell in it, because
 * a disabled role is not an ordinary row with a loud badge — it is a row that
 * does not run. That is a `rowClassName`, and the design-system Table has none;
 * it hardcodes the row class and exposes only cursor and selection state, so
 * the strongest claim it could make here is a marked badge, which is a weaker
 * statement than the one this screen owes its operator.
 *
 * The gallery Table is also a virtualised `role="grid"` widget — a keyboard
 * cursor over ten thousand rows — where this is a real `<table>` a screen
 * reader reads as a document: `<caption>`, `<th scope>` on both axes, and
 * `aria-sort` on the sorted column, none of which survive being rebuilt as a
 * grid of divs. A registry is read, not driven; the document table is the
 * honest role for it. Move to the shared Table the moment it takes a
 * `rowClassName` and a role a reader can still parse.
 *
 * The `pv-dt-` class prefix is shared with the other document tables on the
 * platform (styled once, centrally); it is deliberately distinct from the
 * gallery grid's `pv-table-` so the two stylesheets never land on each other's
 * elements.
 */
type SortDirection = "ascending" | "descending";

interface SortState {
  readonly columnKey: string;
  readonly direction: SortDirection;
}

interface SortableColumn<T> {
  readonly key: string;
  readonly header: string;
  /** Right-aligned and tabular-figured. For money, counts, durations. */
  readonly numeric?: boolean;
  /** Supply to make the column sortable. Omit and the header is plain text. */
  readonly sortValue?: (row: T) => string | number;
  /** Exactly one column should set this: it becomes the row's `<th scope="row">`. */
  readonly rowHeader?: boolean;
  readonly render: (row: T) => ReactNode;
}

interface SortableTableProps<T> {
  /** Always rendered. A table without a caption is one nobody can identify out of context. */
  readonly caption: string;
  readonly columns: readonly SortableColumn<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly rowClassName?: (row: T) => string | undefined;
  readonly defaultSort?: SortState;
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function SortableTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowClassName,
  defaultSort,
}: SortableTableProps<T>) {
  const captionId = useId();
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null);

  const sortedRows = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((candidate) => candidate.key === sort.columnKey);
    if (column?.sortValue === undefined) return rows;
    const sortValue = column.sortValue;
    const direction = sort.direction === "ascending" ? 1 : -1;
    // Decorated so the sort is stable: equal keys keep their original order, so
    // "available, then oldest first within available" actually behaves so.
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
                  {/* The button fills the header cell, so the target is the whole
                      header rather than a glyph inside it (WCAG 2.2 2.5.8). */}
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

/** Route-level container. */
export function RoleRegistryRoute() {
  const client = useClient();
  const resource = useResource((signal) => client.roles({}, { signal }), [client]);

  return (
    <ResourceView resource={resource} attempted="the role registry">
      {(page) => <RoleRegistry roles={page.items} total={page.total} />}
    </ResourceView>
  );
}
