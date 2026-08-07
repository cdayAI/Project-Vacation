/**
 * Structure and overlays.
 *
 * The things a screen is *arranged* out of: the table an operator lives in, the
 * cards and panels that hold a record, and the four overlays that appear on top
 * of them. Every one of them carries the states the specification asks for —
 * default, hover, focus-visible, active, disabled, loading, error, empty, and
 * the designed read-only that auditors spend their day in — and none of them
 * reaches for a value that is not a token.
 *
 * Two pieces of shared machinery are exported alongside the components because
 * a screen has to be able to reason about them:
 *
 *   - the **blur budget** (`glassSurface`), which is how spec §1.5's "cap
 *     concurrent blurred surfaces at three, never blur behind a scrolling
 *     virtualized list" is enforced rather than remembered. The shell claims its
 *     three chrome slots through the same hook.
 *   - **origin motion** (`originMotion`), which is how a sheet opens from the
 *     row that triggered it and collapses back into it (§1.6). A screen stamps
 *     an identity on a card and hands the same identity to the sheet.
 *
 * This is the surfaces barrel only. `src/ui/index.ts` is assembled centrally
 * once every part of the library has landed; nothing here writes to it.
 */

export { Card } from "./Card";
export type { CardProps, CardTone } from "./Card";

export { Dropdown, dropdownTriggerProps } from "./Dropdown";
export type { DropdownItem, DropdownProps } from "./Dropdown";

export { Modal } from "./Modal";
export type { ModalProps, ModalSize } from "./Modal";

export { Panel } from "./Panel";
export type { PanelProps, PanelResize } from "./Panel";

export { Popover, popoverTriggerProps } from "./Popover";
export type { PopoverProps } from "./Popover";

export { ReadOnlyChip } from "./ReadOnlyChip";

export { ResizeSeparator } from "./ResizeSeparator";
export type { ResizeSeparatorProps } from "./ResizeSeparator";

export { Sheet } from "./Sheet";
export type { SheetProps, SheetSize } from "./Sheet";

export { SurfaceState } from "./SurfaceState";
export type { SurfaceStateProps } from "./SurfaceState";

export { ROW_HEIGHT_PX, TABLE_SHORTCUTS, Table } from "./Table";
export type { SortDirection, TableColumn, TableProps, TableSort } from "./Table";

export { Tabs } from "./Tabs";
export type { TabDefinition, TabsProps } from "./Tabs";

// --- shared machinery -------------------------------------------------------

export {
  GLASS_BUDGET_CAPACITY,
  GLASS_PRIORITY,
  GlassBudgetProvider,
  SOLID_SURFACE_CLASS,
  inspectGlassBudget,
  useGlassSurface,
  useVirtualScrollerRegistration,
} from "./glassSurface";
export type { GlassPriority, GlassSurface, GlassSurfaceOptions } from "./glassSurface";

export {
  IDENTITY_ATTRIBUTE,
  ORIGIN_VARIABLES,
  captureOriginRect,
  identityAnchor,
  originTransformVariables,
  prefersReducedMotion,
  readTransitionDurationMs,
} from "./originMotion";
export type { OriginRect } from "./originMotion";

export { PLACEMENTS, positionAnchoredSurface, useAnchoredPosition } from "./anchoredSurface";
export type { AnchoredPosition, Placement } from "./anchoredSurface";

export {
  clearStoredTableView,
  moveColumn,
  readStoredTableView,
  resolveTableView,
  tableViewStorageKey,
  toggleColumnVisibility,
  writeStoredTableView,
} from "./columnPreferences";
export type { ResolvedTableView, StoredTableView } from "./columnPreferences";

export { captureFocusOrigin, focusInitialElement, tabbableWithin, wrapTabFocus } from "./focusScope";

export { computeVirtualWindow, scrollOffsetForIndex } from "./virtualRows";
export type { VirtualWindow } from "./virtualRows";
