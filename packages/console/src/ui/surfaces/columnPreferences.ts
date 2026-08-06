/**
 * Column order, visibility, and width — remembered per operator, per table.
 *
 * Spec §3.1 makes columns user-configurable and says the order persists per
 * user. That sounds like a one-line localStorage write, and the one-line
 * version breaks the first time a release adds a column: the stored order does
 * not contain the new key, so either it never appears or it appears at the far
 * right of a layout somebody spent a release arranging. Both are the same bug
 * reported as "the new column is missing".
 *
 * So resolving a stored view against the current definitions is the real work
 * here, and the rules are:
 *
 *   - Unknown keys in the stored order are dropped. A column that was removed
 *     must not leave a hole, and a key from a different table pasted into
 *     storage must not be able to render anything.
 *   - New columns are inserted next to the neighbour they were defined beside,
 *     not appended. A release that adds "risk" next to "status" puts it next to
 *     status on the operator's screen too.
 *   - A column marked `alwaysVisible` cannot be hidden, whatever storage says.
 *     The row header is the thing that identifies a row; a table whose rows
 *     cannot be identified is not a smaller table, it is a broken one.
 *   - If a stored view would hide every column, it is ignored entirely.
 *   - Widths are clamped to the column's own bounds, so a stored 4000px from a
 *     wide monitor does not arrive on a laptop as a column nobody can scroll
 *     past.
 *
 * Storage is guarded the same way theme/preferences.ts guards it: private
 * browsing, a locked-down profile, and a full quota are all real, and a console
 * that cannot remember a column order still has to draw the table.
 */

/** Bumped when the stored shape changes. An older or newer payload is ignored. */
const STORED_VERSION = 1;

export interface StoredTableView {
  readonly order: readonly string[];
  readonly hidden: readonly string[];
  readonly widths: Readonly<Record<string, number>>;
}

export interface ColumnConstraints {
  readonly key: string;
  readonly width: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  /** The row header and anything else the table is meaningless without. */
  readonly alwaysVisible?: boolean;
}

export interface ResolvedTableView {
  /** Every known column, in the order to render, including hidden ones. */
  readonly order: readonly string[];
  readonly hidden: ReadonlySet<string>;
  readonly widths: Readonly<Record<string, number>>;
}

export const EMPTY_STORED_VIEW: StoredTableView = { order: [], hidden: [], widths: {} };

export function tableViewStorageKey(tableId: string): string {
  return `pv.console.table.${tableId}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isWidthRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/**
 * Reads a stored view, or null when there is nothing usable.
 *
 * Everything about the parsed payload is checked rather than trusted.
 * localStorage is writable by anything running on the origin, including an
 * older build of this console, and a malformed value must degrade to the
 * default layout instead of throwing inside a table's first render.
 */
export function readStoredTableView(tableId: string): StoredTableView | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(tableViewStorageKey(tableId));
  } catch {
    return null;
  }
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.v !== STORED_VERSION) return null;

    const order = isStringArray(candidate.order) ? candidate.order : [];
    const hidden = isStringArray(candidate.hidden) ? candidate.hidden : [];
    const widths = isWidthRecord(candidate.widths) ? candidate.widths : {};
    return { order, hidden, widths };
  } catch {
    return null;
  }
}

export function writeStoredTableView(tableId: string, view: StoredTableView): void {
  try {
    window.localStorage.setItem(
      tableViewStorageKey(tableId),
      JSON.stringify({ v: STORED_VERSION, ...view }),
    );
  } catch {
    // Losing a column order is acceptable. Throwing on the drag that set it is
    // not.
  }
}

export function clearStoredTableView(tableId: string): void {
  try {
    window.localStorage.removeItem(tableViewStorageKey(tableId));
  } catch {
    // Nothing to do — the view is already effectively cleared for this session.
  }
}

/**
 * Merges what the operator arranged with what the build currently defines.
 *
 * The definitions always win on what exists; storage only ever wins on
 * arrangement.
 */
export function resolveTableView(
  columns: readonly ColumnConstraints[],
  stored: StoredTableView | null,
): ResolvedTableView {
  const defined = columns.map((column) => column.key);
  const byKey = new Map(columns.map((column) => [column.key, column]));

  const widths: Record<string, number> = {};
  for (const column of columns) {
    const storedWidth = stored?.widths[column.key];
    const width = typeof storedWidth === "number" ? storedWidth : column.width;
    widths[column.key] = Math.min(column.maxWidth, Math.max(column.minWidth, Math.round(width)));
  }

  if (stored === null) {
    return { order: defined, hidden: new Set(), widths };
  }

  // Start from the stored arrangement, keeping only columns that still exist
  // and dropping duplicates a corrupted payload might contain.
  const seen = new Set<string>();
  const order: string[] = [];
  for (const key of stored.order) {
    if (!byKey.has(key) || seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }

  // Then place every column the stored arrangement has never heard of beside
  // the neighbour it was defined next to, so a new column lands where the
  // build put it rather than at the far right.
  for (const [index, key] of defined.entries()) {
    if (seen.has(key)) continue;
    seen.add(key);

    const precedingDefined = findPlaced(defined, index, -1, order);
    if (precedingDefined !== null) {
      order.splice(order.indexOf(precedingDefined) + 1, 0, key);
      continue;
    }
    const followingDefined = findPlaced(defined, index, 1, order);
    if (followingDefined !== null) {
      order.splice(order.indexOf(followingDefined), 0, key);
      continue;
    }
    order.push(key);
  }

  const hidden = new Set<string>();
  for (const key of stored.hidden) {
    const column = byKey.get(key);
    if (column === undefined) continue;
    if (column.alwaysVisible === true) continue;
    hidden.add(key);
  }

  // A table with no columns is not a narrower table. Something has gone wrong
  // upstream — a rename, a hand-edited payload — and the default layout is a
  // better answer than a blank grid.
  if (hidden.size >= order.length) return { order, hidden: new Set(), widths };

  return { order, hidden, widths };
}

/** The nearest column in `defined` (walking in `step`) that is already placed. */
function findPlaced(
  defined: readonly string[],
  from: number,
  step: 1 | -1,
  placed: readonly string[],
): string | null {
  for (let index = from + step; index >= 0 && index < defined.length; index += step) {
    const key = defined[index];
    if (key !== undefined && placed.includes(key)) return key;
  }
  return null;
}

/** Moves a column to a new position, returning the new order. */
export function moveColumn(
  order: readonly string[],
  key: string,
  toIndex: number,
): readonly string[] {
  const from = order.indexOf(key);
  if (from === -1) return order;
  const target = Math.min(order.length - 1, Math.max(0, toIndex));
  if (from === target) return order;

  const next = [...order];
  next.splice(from, 1);
  next.splice(target, 0, key);
  return next;
}

/** Toggles a column's visibility, refusing to hide the last visible one. */
export function toggleColumnVisibility(
  hidden: ReadonlySet<string>,
  order: readonly string[],
  key: string,
): ReadonlySet<string> {
  const next = new Set(hidden);
  if (next.has(key)) {
    next.delete(key);
    return next;
  }
  if (order.length - next.size <= 1) return hidden;
  next.add(key);
  return next;
}
