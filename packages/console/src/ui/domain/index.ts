/**
 * The domain components.
 *
 * Where this product stops looking generic. Each of these carries a rule from
 * the specification that is really a product decision — a metric tile that
 * refuses to render without a comparison, an approval whose two answers are the
 * same size, a chart that ships its own numbers, an evidence item that never
 * makes an approver leave the screen to check a citation.
 *
 * They are built on the primitives and the surfaces rather than beside them: a
 * second chip, a second skeleton, or a second idea of what read-only looks like
 * would be the thing that makes the console feel assembled instead of designed.
 *
 * This is the domain barrel only. `src/ui/index.ts` is assembled centrally once
 * every part of the library has landed; nothing here writes to it.
 */

export { ApprovalCard } from "./ApprovalCard";
export type {
  ApprovalBlastRadius,
  ApprovalCardProps,
  ApprovalDecision,
  ApprovalRejectReason,
  ApprovalRequestKind,
  ApprovalRisk,
} from "./ApprovalCard";

export { AreaChart } from "./AreaChart";
export type { AreaChartProps } from "./AreaChart";

export { BarChart } from "./BarChart";
export type { BarChartProps } from "./BarChart";

export { Callout } from "./Callout";
export type { CalloutProps } from "./Callout";

export { ChartFrame, seriesColor } from "./ChartFrame";
export type { ChartDirectLabel, ChartFrameProps } from "./ChartFrame";

export { CopilotMessage } from "./CopilotMessage";
export type { CopilotCitation, CopilotMessageProps } from "./CopilotMessage";

export { DiffView } from "./DiffView";
export type { DiffChange, DiffRow, DiffViewProps } from "./DiffView";

export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";

export { ErrorState } from "./ErrorState";
export type { ErrorStateProps } from "./ErrorState";

export { EvidenceItem } from "./EvidenceItem";
export type { EvidenceItemProps } from "./EvidenceItem";

export { FilterBar } from "./FilterBar";
export type { ActiveFilter, FilterBarProps, SavedView } from "./FilterBar";

export { LineChart } from "./LineChart";
export type { LineChartProps } from "./LineChart";

export { MetricTile } from "./MetricTile";
export type { MetricComparison, MetricTileProps } from "./MetricTile";

export {
  PROVENANCE_KINDS,
  PROVENANCE_MEANINGS,
  PROVENANCE_WORDS,
  ProvenanceMark,
} from "./ProvenanceMark";
export type { ProvenanceKind, ProvenanceMarkProps } from "./ProvenanceMark";

export { Sparkline, SPARKLINE_SPOKEN_LIMIT } from "./Sparkline";
export type { SparklineProps } from "./Sparkline";

export { StackedBarChart } from "./StackedBarChart";
export type { StackedBarChartProps } from "./StackedBarChart";

export { Timeline } from "./Timeline";
export type {
  TimelineCitation,
  TimelineProps,
  TimelineStep,
  TimelineStepKind,
  TimelineStepState,
} from "./Timeline";

export { Toast, ToastRegion, TOAST_DURATION_MS, UNDO_WINDOW_MS } from "./Toast";
export type { ToastProps, ToastRecord, ToastRegionProps, ToastUndo } from "./Toast";

/** The chart arithmetic, exported because screens compose their own series. */
export {
  areaPath,
  axisFor,
  bandFor,
  categoriesOf,
  extentOf,
  groupedBand,
  linePath,
  MAX_SERIES,
  projectX,
  projectY,
  stackByCategory,
  stackTotals,
  valuesFor,
} from "./chartGeometry";
export type { Axis, Band, ChartAnnotation, ChartPoint, ChartSeries, Extent, StackSegment } from "./chartGeometry";

/** The domain glyph set. Every mark is decorative and sits beside a word. */
export {
  MarkAction,
  MarkAdded,
  MarkAsserted,
  MarkChanged,
  MarkComputed,
  MarkExternal,
  MarkFilter,
  MarkHuman,
  MarkModel,
  MarkRemoved,
  MarkRetrieval,
  MarkRetrieved,
  MarkTrendDown,
  MarkTrendFlat,
  MarkTrendUp,
  MarkUndo,
  MarkWait,
} from "./marks";
export type { MarkProps } from "./marks";
