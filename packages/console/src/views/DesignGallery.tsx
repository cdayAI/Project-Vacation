import { useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { KeyboardProvider } from "../keyboard/KeyboardProvider";
import type { CommandDefinition } from "../keyboard/registry";
import { useTheme } from "../theme/ThemeProvider";
import type { Density, ThemePreference, TransparencyPreference } from "../theme/preferences";
import {
  ApprovalCard,
  AreaChart,
  Avatar,
  BarChart,
  Badge,
  Button,
  Callout,
  ChartFrame,
  Checkbox,
  Chip,
  Combobox,
  CommandPalette,
  CopilotMessage,
  Card,
  DatePicker,
  DateRange,
  DiffView,
  Dropdown,
  EmptyState,
  ErrorState,
  EvidenceItem,
  Field,
  FilterBar,
  IconAlert,
  IconBlocked,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCircle,
  IconCross,
  IconDash,
  IconDot,
  IconInfo,
  IconLock,
  Input,
  LineChart,
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
  MetricTile,
  Modal,
  OptionList,
  PROVENANCE_KINDS,
  PROVENANCE_MEANINGS,
  Panel,
  Popover,
  ProvenanceMark,
  Radio,
  RadioGroup,
  ReadOnlyChip,
  ResizeSeparator,
  Select,
  Sheet,
  ShortcutReference,
  Skeleton,
  Sparkline,
  Spinner,
  StackedBarChart,
  SurfaceState,
  Switch,
  Table,
  Tabs,
  Textarea,
  Timeline,
  Toast,
  ToastRegion,
  Tooltip,
  UnassignedAvatar,
  axisFor,
  categoriesOf,
  dropdownTriggerProps,
  popoverTriggerProps,
  type ChartSeries,
  type DiffRow,
  type DropdownItem,
  type ListOption,
  type TableColumn,
  type TimelineStep,
} from "../ui";
import "./DesignGallery.css";

/**
 * `/design` — the component gallery.
 *
 * Specification §4 asks for every component, in every state, in both themes,
 * with and without transparency, in the application itself. It calls the page
 * the review surface and the regression check, and both halves of that are
 * literal:
 *
 *   - **Review surface.** A designer looks at one screen and sees whether the
 *     system holds together — whether two components disagree about what
 *     read-only looks like, whether an empty state anywhere says "No items".
 *   - **Regression check.** A reviewer flips the three controls at the top and
 *     catches the component that only ever worked in light mode, or the one
 *     whose glass has no designed solid behind it.
 *
 * -----------------------------------------------------------------------------
 * WHY THE ENTRIES ARE DATA AND WHY THE TEST WALKS THE DIRECTORY
 *
 * A gallery that silently omits a component is worse than no gallery, because
 * it reads as coverage: a reviewer who has looked at this page believes they
 * have looked at the library. Prose cannot prevent that and neither can care —
 * somebody lands a component on a Friday and the omission is invisible.
 *
 * So `GALLERY_ENTRIES` is a list keyed by the module basename, and
 * DesignGallery.test.tsx reads `src/ui/` off the disk and fails when a
 * component file has no entry. That is the same ratchet
 * tools/check-accessibility-coverage.mjs applies to views, for the same reason:
 * a gate that can be skipped is a gate that rots quietly while the badge stays
 * green.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS PAGE CANNOT SHOW, AND SAYS SO
 *
 * Hover, focus-visible and active are real states of a real element. They are
 * not pictured here because picturing them would mean writing a class that
 * imitates them, and an imitation is exactly the thing a regression check must
 * not contain — it would keep looking right after the real one broke. The page
 * says this out loud at the top and asks the reviewer to Tab through it, which
 * is also how the keyboard pass gets done.
 */

// ---------------------------------------------------------------------------
// The shape of the gallery
// ---------------------------------------------------------------------------

export type GalleryFamily = "primitives" | "surfaces" | "domain" | "palette";

export interface GalleryFamilyMeta {
  readonly id: GalleryFamily;
  readonly label: string;
  /** What belongs in this family, so a new component lands in the right one. */
  readonly blurb: string;
}

export const GALLERY_FAMILIES: readonly GalleryFamilyMeta[] = [
  {
    id: "primitives",
    label: "Primitives",
    blurb:
      "The atoms every screen is made of. Most of the product's quality is decided here rather than in any one screen.",
  },
  {
    id: "surfaces",
    label: "Surfaces",
    blurb:
      "What a screen is arranged out of, and the four overlays that appear on top of it. Every overlay traps focus and gives it back to the control that opened it.",
  },
  {
    id: "domain",
    label: "Domain",
    blurb:
      "Where this product stops looking generic. Each of these carries a rule from the specification that is really a product decision.",
  },
  {
    id: "palette",
    label: "Command palette",
    blurb:
      "Primary navigation, not a bonus. Both of these read the keyboard registry rather than a list of their own.",
  },
];

export interface GalleryState {
  /** Named in text under the demo. Colour and shape never carry it alone. */
  readonly name: string;
  /** What this state is for, when the name does not already say it. */
  readonly note?: string;
  /** Spans the row. For anything that needs the width to be judged at all. */
  readonly wide?: boolean;
  readonly Demo: ComponentType;
}

export interface GalleryEntry {
  /** The module basename under `src/ui/<family>/`. The ratchet matches on it. */
  readonly id: string;
  readonly family: GalleryFamily;
  readonly name: string;
  /** One line: when to reach for this rather than something adjacent. */
  readonly when: string;
  readonly states: readonly GalleryState[];
}

// ---------------------------------------------------------------------------
// Fixtures
//
// One cast of characters across the whole page. A gallery whose every demo
// invents its own names reads as a pile of components; one that keeps the same
// three owners and the same case in view reads as a product, and it also makes
// two components disagreeing about how a name or a money value is written
// immediately visible.
// ---------------------------------------------------------------------------

const OWNER_OPTIONS: readonly ListOption[] = [
  { value: "delgado", label: "M. Delgado", description: "Account 41823 · Florida" },
  { value: "okonkwo", label: "A. Okonkwo", description: "Account 39112 · Nevada" },
  { value: "reyes", label: "P. Reyes", description: "Account 44207 · Florida" },
  {
    value: "vance",
    label: "T. Vance",
    description: "Left the collections team",
    disabled: true,
  },
];

const REASON_OPTIONS: readonly ListOption[] = [
  { value: "evidence", label: "Evidence is thin", description: "The citation does not cover this" },
  { value: "wrong-owner", label: "Wrong owner", description: "The record does not match" },
  { value: "policy", label: "Outside policy R-14", description: "Needs a supervisor" },
];

const RECOVERY_SERIES: readonly ChartSeries[] = [
  {
    id: "recovered",
    label: "Recovered",
    points: [
      { x: "Mar", y: 38 },
      { x: "Apr", y: 44 },
      { x: "May", y: 51 },
      { x: "Jun", y: 57 },
      { x: "Jul", y: 61 },
      { x: "Aug", y: 66 },
    ],
  },
  {
    id: "written-off",
    label: "Written off",
    points: [
      { x: "Mar", y: 22 },
      { x: "Apr", y: 20 },
      { x: "May", y: 17 },
      { x: "Jun", y: 15 },
      { x: "Jul", y: 13 },
      { x: "Aug", y: 11 },
    ],
  },
];

const INTERVENTION = [{ x: "Jun", label: "Shadow → assisted, 12 Jun" }];

const RECOVERY_CAPTION = "Of 1,240 cases · monthly, last 6 months";

interface DemoCase {
  readonly id: string;
  readonly what: string;
  readonly owner: string;
  readonly age: string;
  readonly value: number;
  readonly next: string;
}

const DEMO_CASES: readonly DemoCase[] = [
  {
    id: "case-41823",
    what: "Rescission window closing",
    owner: "M. Delgado",
    age: "2d 4h",
    value: 12_400,
    next: "Send the confirmation",
  },
  {
    id: "case-39112",
    what: "Payment plan lapsed",
    owner: "A. Okonkwo",
    age: "6d 1h",
    value: 3_180,
    next: "Call the owner",
  },
  {
    id: "case-44207",
    what: "Maintenance fee dispute",
    owner: "P. Reyes",
    age: "9h",
    value: 940,
    next: "Answer the dispute",
  },
  {
    id: "case-40551",
    what: "Deed transfer stalled",
    owner: "M. Delgado",
    age: "14d 3h",
    value: 21_750,
    next: "Chase the title company",
  },
];

const CASE_COLUMNS: readonly TableColumn<DemoCase>[] = [
  {
    key: "what",
    header: "What",
    rowHeader: true,
    alwaysVisible: true,
    width: 240,
    sortValue: (row) => row.what,
    cell: (row) => row.what,
  },
  {
    key: "owner",
    header: "Owner",
    width: 160,
    sortValue: (row) => row.owner,
    cell: (row) => row.owner,
  },
  { key: "age", header: "Age", width: 100, sortValue: (row) => row.age, cell: (row) => row.age },
  {
    key: "value",
    header: "Value",
    width: 120,
    numeric: true,
    sortValue: (row) => row.value,
    cell: (row) => `$${row.value.toLocaleString("en-US")}`,
  },
  { key: "next", header: "Next", width: 200, cell: (row) => row.next },
];

const RUN_STEPS: readonly TimelineStep[] = [
  {
    id: "step-1",
    kind: "retrieval",
    title: "Retrieved owner contract",
    time: "09:41:02",
    duration: "120ms",
    cost: "$0.00",
    detail: "3 documents · 2 cited",
    state: "done",
  },
  {
    id: "step-2",
    kind: "model",
    title: "Determined rescission window",
    time: "09:41:03",
    duration: "1.4s",
    cost: "$0.011",
    state: "done",
    citations: [
      { id: "fl-721-10", source: "Florida Statutes §721.10 (rev 2025-07-01)", kind: "retrieved" },
      { id: "window", source: "Window ends 14 Aug 2026", kind: "computed" },
    ],
    details: "Contract signed 24 Jul 2026 · statutory window is ten days from signature.",
  },
  {
    id: "step-3",
    kind: "human",
    title: "Checked the owner's mailing address",
    time: "09:41:40",
    duration: "31s",
    state: "done",
    actor: "D. Ruiz",
  },
  {
    id: "step-4",
    kind: "action",
    title: "Wrote the confirmation letter",
    time: "09:42:11",
    duration: "2.2s",
    cost: "$0.004",
    state: "failed",
    failure: {
      what: "The document service refused the template.",
      then: "Retried once, then escalated to the workflow owner.",
    },
  },
  {
    id: "step-5",
    kind: "wait",
    title: "Parked — awaiting approval #4182",
    time: "09:42:14",
    state: "parked",
    detail: "Waiting on a named approver",
  },
];

const DIFF_ROWS: readonly DiffRow[] = [
  {
    id: "threshold",
    label: "Escalation threshold",
    current: "$10,000",
    draft: "$7,500",
    change: "changed",
  },
  {
    id: "approver",
    label: "Second approver",
    draft: "Required above $25,000",
    change: "added",
  },
  {
    id: "auto-close",
    label: "Auto-close after",
    current: "30 days",
    change: "removed",
  },
  {
    id: "notice",
    label: "Notice template",
    current: "Dear {{owner}}, your rescission request is confirmed.",
    draft: "Dear {{owner}}, we have confirmed your rescission and closed the contract.",
    change: "changed",
    multiline: true,
  },
  {
    id: "queue",
    label: "Queue",
    current: "Collections",
    draft: "Collections",
    change: "unchanged",
  },
];

const BLAST_RADIUS = {
  ownersAffected: "3 owners in Florida",
  money: "$0 — no payment moves",
  reversible: "Yes, within 24 hours",
  howToReverse: "Void the notice and re-issue from the case",
};

const IF_APPROVED: readonly ReactNode[] = [
  "Three confirmation letters are generated and queued for mail today.",
  "Each contract is marked rescinded, effective the date the owner asked.",
  "The collections hold on all three accounts is released.",
  "Nothing is charged and no payment is refunded — there is none to refund.",
];

const PALETTE_RESULTS: readonly CommandDefinition[] = [
  {
    id: "demo-approve",
    label: "Approve and go to the next item",
    kind: "action",
    hint: "Sends the confirmation, then opens approval #4183",
    shortcut: "approve",
    run: () => {},
  },
  {
    id: "demo-queue",
    label: "Go to the work queue",
    kind: "navigate",
    shortcut: "goQueue",
    run: () => {},
  },
  {
    id: "demo-case",
    label: "Case 41823 · M. Delgado",
    kind: "record",
    hint: "Rescission window closing · $12,400",
    run: () => {},
  },
  {
    id: "demo-view",
    label: "Breaching",
    kind: "view",
    hint: "Saved view · 47 cases",
    run: () => {},
  },
];

/** Demos that only need to be pressable do this, so no click is a dead end. */
function noop(): void {}

// ---------------------------------------------------------------------------
// Demos that hold state
//
// Each one takes a `variant` rather than a spread of props: a demo is a fixed,
// named specimen of one state, and letting the gallery pass arbitrary props
// would make it possible for the page to show a combination the component was
// never built for and call it a state.
// ---------------------------------------------------------------------------

function CheckboxDemo({
  variant,
}: {
  readonly variant: "default" | "selected" | "indeterminate" | "error" | "disabled" | "read-only";
}) {
  const [checked, setChecked] = useState(variant === "selected" || variant === "read-only");
  // Ticking a partially selected box resolves it, the way the header checkbox
  // over a part-selected queue does. Holding it indeterminate for ever would
  // make the specimen the one control on the page that ignores a click.
  const [partial, setPartial] = useState(variant === "indeterminate");
  return (
    <Checkbox
      label="Release the collections hold"
      hint={variant === "default" ? "The account stops accruing late fees today." : undefined}
      error={variant === "error" ? "Choose an outcome before you continue." : undefined}
      indeterminate={partial}
      checked={checked}
      onChange={(event) => {
        setPartial(false);
        setChecked(event.currentTarget.checked);
      }}
      disabled={variant === "disabled"}
      readOnly={variant === "read-only"}
    />
  );
}

function SwitchDemo({
  variant,
}: {
  readonly variant: "off" | "on" | "error" | "disabled" | "read-only";
}) {
  const [on, setOn] = useState(variant === "on" || variant === "read-only");
  return (
    <Switch
      label="Pause the rescission workflow"
      hint={variant === "off" ? "Takes effect on the next run, not on runs in flight." : undefined}
      error={variant === "error" ? "We could not save this. Try again." : undefined}
      checked={on}
      onChange={setOn}
      disabled={variant === "disabled"}
      readOnly={variant === "read-only"}
    />
  );
}

function SelectDemo({
  variant,
}: {
  readonly variant: "default" | "chosen" | "loading" | "error" | "empty" | "disabled" | "read-only";
}) {
  const [value, setValue] = useState<string | null>(
    variant === "chosen" || variant === "read-only" ? "delgado" : null,
  );
  return (
    <Select
      label="Assignee"
      options={variant === "empty" ? [] : OWNER_OPTIONS}
      value={value}
      onChange={setValue}
      placeholder="Choose an assignee"
      hint={variant === "default" ? "Only people on this queue are listed." : undefined}
      error={variant === "error" ? "Choose an assignee before you save." : undefined}
      loading={variant === "loading"}
      loadingLabel="Loading the collections team"
      emptyMessage="Nobody on this queue can take it. A supervisor can add someone."
      disabled={variant === "disabled"}
      readOnly={variant === "read-only"}
    />
  );
}

function ComboboxDemo({
  variant,
}: {
  readonly variant: "default" | "custom" | "loading" | "error" | "disabled" | "read-only";
}) {
  const [value, setValue] = useState<string | null>(variant === "read-only" ? "okonkwo" : null);
  return (
    <Combobox
      label="Owner"
      options={OWNER_OPTIONS}
      value={value}
      onChange={setValue}
      placeholder="Type a name or an account"
      hint={variant === "default" ? "Search by name or by account number." : undefined}
      error={variant === "error" ? "We do not have an owner by that name." : undefined}
      allowCustomValue={variant === "custom"}
      loading={variant === "loading"}
      loadingLabel="Searching owners"
      disabled={variant === "disabled"}
      readOnly={variant === "read-only"}
    />
  );
}

function DatePickerDemo({
  variant,
}: {
  readonly variant: "default" | "chosen" | "error" | "disabled" | "read-only";
}) {
  const [value, setValue] = useState<string | null>(
    variant === "chosen" || variant === "read-only" ? "2026-08-14" : null,
  );
  return (
    <DatePicker
      label="Rescission received"
      value={value}
      onChange={setValue}
      min="2026-01-01"
      max="2026-12-31"
      error={variant === "error" ? "That date is outside the statutory window." : undefined}
      disabled={variant === "disabled"}
      readOnly={variant === "read-only"}
    />
  );
}

function DateRangeDemo({
  variant,
}: {
  readonly variant: "default" | "chosen" | "error" | "read-only";
}) {
  const chosen = variant === "chosen" || variant === "read-only";
  const [value, setValue] = useState<{ start: string | null; end: string | null }>({
    start: chosen ? "2026-07-01" : null,
    end: chosen ? "2026-07-31" : null,
  });
  return (
    <DateRange
      label="Decided between"
      value={value}
      onChange={setValue}
      min="2026-01-01"
      max="2026-12-31"
      error={variant === "error" ? "The end date is before the start date." : undefined}
      readOnly={variant === "read-only"}
    />
  );
}

function RadioGroupDemo({
  variant,
}: {
  readonly variant: "default" | "horizontal" | "error" | "disabled" | "read-only";
}) {
  const [value, setValue] = useState<string | null>(variant === "read-only" ? "policy" : null);
  return (
    <RadioGroup
      label="Why are you rejecting this?"
      value={value}
      onChange={setValue}
      orientation={variant === "horizontal" ? "horizontal" : "vertical"}
      hint={variant === "default" ? "The reason is captured as improvement signal." : undefined}
      error={variant === "error" ? "Pick a reason so the workflow can learn from it." : undefined}
      disabled={variant === "disabled"}
      readOnly={variant === "read-only"}
    >
      {REASON_OPTIONS.map((option) => (
        <Radio
          key={option.value}
          value={option.value}
          label={option.label}
          description={option.description}
        />
      ))}
    </RadioGroup>
  );
}

function OptionListDemo() {
  const listId = useId();
  const labelId = `${listId}-label`;
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<string | null>("okonkwo");
  return (
    <div className="pv-gallery-stack">
      <p className="pv-gallery-caption" id={labelId}>
        Assignee
      </p>
      <OptionList
        id={listId}
        labelledBy={labelId}
        options={OWNER_OPTIONS}
        activeIndex={active}
        selectedValue={selected}
        optionId={(index) => `${listId}-option-${index}`}
        onPick={(option, index) => {
          setSelected(option.value);
          setActive(index);
        }}
        onHoverIndex={setActive}
      />
    </div>
  );
}

function ChipToggleDemo() {
  const [selected, setSelected] = useState(true);
  return (
    <Chip selected={selected} onSelect={() => setSelected(!selected)} count={47}>
      Breaching
    </Chip>
  );
}

function ChipRemovableDemo() {
  const [present, setPresent] = useState(true);
  return present ? (
    <Chip onRemove={() => setPresent(false)} label="Owner state: Florida">
      Owner state: Florida
    </Chip>
  ) : (
    <Button size="sm" onClick={() => setPresent(true)}>
      Put the filter back
    </Button>
  );
}

function FieldDemo({ variant }: { readonly variant: "default" | "error" | "read-only" }) {
  // Field is for a control the caller owns. This is what one looks like when it
  // borrows the library's control shell rather than inventing a second one.
  return (
    <Field
      label="Reference"
      hint={variant === "default" ? "The reference from the servicing system." : undefined}
      error={variant === "error" ? "We could not find that reference." : undefined}
      readOnly={variant === "read-only"}
      footer={<span>Six characters, letters and digits.</span>}
    >
      {(control) => (
        <span className="pv-ui-control" data-size="md" data-readonly={control.readOnly}>
          <input
            className="pv-ui-control-field"
            id={control.id}
            aria-describedby={control.describedBy}
            aria-invalid={control.invalid ? true : undefined}
            required={control.required}
            readOnly={control.readOnly}
            defaultValue="8f2a41"
          />
        </span>
      )}
    </Field>
  );
}

function TabsDemo({ variant }: { readonly variant: "default" | "read-only" | "loading" }) {
  const [active, setActive] = useState("diff");
  return (
    <Tabs
      label="Configuration stages"
      activeId={active}
      onActiveIdChange={setActive}
      readOnly={variant === "read-only"}
      loading={variant === "loading"}
      tabs={[
        { id: "current", label: "Current" },
        { id: "draft", label: "Draft" },
        { id: "diff", label: "Diff", count: 4, countDescription: "changes" },
        {
          id: "impact",
          label: "Impact",
          disabled: true,
          disabledReason: "Runs once the draft is saved",
        },
      ]}
    >
      <p>
        {active === "diff"
          ? "Four fields change. The threshold drops by $2,500."
          : "The panel for this stage renders here."}
      </p>
    </Tabs>
  );
}

function TableDemo({
  variant,
}: {
  readonly variant: "default" | "loading" | "error" | "empty" | "read-only";
}) {
  const [active, setActive] = useState<string | null>("case-41823");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(["case-39112"]));
  return (
    <Table
      caption="Work queue"
      tableId="design-gallery-cases"
      columns={CASE_COLUMNS}
      rows={variant === "empty" ? [] : DEMO_CASES}
      rowKey={(row) => row.id}
      rowNoun="cases"
      totalRowCount={variant === "empty" ? 0 : 1_240}
      activeKey={active}
      onActiveKeyChange={setActive}
      selectedKeys={selected}
      onToggleSelect={(key) => {
        const next = new Set(selected);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setSelected(next);
      }}
      loading={variant === "loading"}
      error={
        variant === "error" ? (
          <ErrorState
            title="We could not reach the case store."
            meaning="Your filters are saved."
            guidance="Retry now, or keep working and we will sync when it is back."
            reference="8f2a41"
            headingLevel={4}
          />
        ) : undefined
      }
      empty={
        <EmptyState
          title="Nothing needs you right now."
          body="New cases arrive as owners contact us or as workflows escalate. A digest lands at 9:00 each morning."
          headingLevel={4}
        />
      }
      readOnly={variant === "read-only"}
    />
  );
}

function ResizeSeparatorDemo() {
  const [width, setWidth] = useState(380);
  return (
    <div className="pv-gallery-resize">
      <div className="pv-gallery-resize-panel" style={{ inlineSize: `${width}px` }}>
        <p className="pv-gallery-caption">
          Context panel · <span className="pv-numeric">{width}</span>px
        </p>
      </div>
      <ResizeSeparator
        label="Context panel width"
        value={width}
        min={320}
        max={520}
        direction={-1}
        onChange={setWidth}
      />
    </div>
  );
}

/**
 * A panel is a region landmark, named by its title. Eight panels all called
 * "Record context" would be eight landmarks a screen reader cannot tell apart —
 * which is a real defect on this page, not a test artefact, so each specimen is
 * given the title it would plausibly carry in the product.
 */
const PANEL_TITLES = {
  default: "Record context",
  glass: "Copilot",
  collapsible: "Owner",
  resizable: "Context panel",
  loading: "Contract",
  error: "Servicing system",
  empty: "Prior decisions",
  "read-only": "Audit context",
} as const;

function PanelDemo({
  variant,
}: {
  readonly variant: keyof typeof PANEL_TITLES;
}) {
  const [width, setWidth] = useState(380);
  return (
    <Panel
      title={PANEL_TITLES[variant]}
      titleLevel={4}
      description="Owner, contract, and the timeline for case 41823."
      glass={variant === "glass"}
      collapsible={variant === "collapsible"}
      resize={
        variant === "resizable"
          ? {
              label: "Context panel width",
              width,
              min: 320,
              max: 520,
              edge: "inline-start",
              onWidthChange: setWidth,
            }
          : undefined
      }
      actions={
        <Button size="sm" variant="ghost">
          Open the record
        </Button>
      }
      loading={variant === "loading"}
      error={
        variant === "error"
          ? "We could not reach the owner record. Reference 8f2a41."
          : undefined
      }
      empty={variant === "empty" ? "No record is open. Select a case to see it here." : undefined}
      readOnly={variant === "read-only"}
    >
      <p>M. Delgado · account 41823 · Florida</p>
      <p>Contract signed 24 Jul 2026 · rescission window ends 14 Aug 2026.</p>
    </Panel>
  );
}

function ModalDemo({
  variant,
}: {
  readonly variant: "default" | "danger" | "loading" | "error" | "empty" | "read-only";
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <Button
        ref={triggerRef}
        variant={variant === "danger" ? "danger" : "secondary"}
        onClick={() => setOpen(true)}
      >
        {variant === "danger" ? "Revoke credentials" : "Open the modal"}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        tone={variant === "danger" ? "danger" : "default"}
        title={
          variant === "danger"
            ? "Revoke credentials for sf-quotebot?"
            : "Move three cases to the escalation queue?"
        }
        description={
          variant === "danger"
            ? "It stops working immediately, including three runs in flight. You can issue new credentials at any time, but the current ones cannot be restored."
            : "The three owners keep their assignee. Nothing is sent."
        }
        loading={variant === "loading"}
        error={
          variant === "error"
            ? "We could not reach the credential service. Nothing has changed. Reference 8f2a41."
            : undefined
        }
        empty={variant === "empty" ? "There is nothing to move. Every case is assigned." : undefined}
        readOnly={variant === "read-only"}
        actions={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant={variant === "danger" ? "danger" : "primary"}
              onClick={() => setOpen(false)}
            >
              {variant === "danger" ? "Revoke them" : "Move them"}
            </Button>
          </>
        }
      >
        <p>Focus is trapped while this is open and returns to the button that opened it.</p>
      </Modal>
    </>
  );
}

function SheetDemo({
  variant,
}: {
  readonly variant: "default" | "full" | "loading" | "error" | "empty" | "read-only";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open the sheet</Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        size={variant === "full" ? "full" : "md"}
        title="Evidence chain · approval #4182"
        description="Inputs, sources, decisions, and the chain verification."
        loading={variant === "loading"}
        error={
          variant === "error"
            ? "We could not verify the chain. The record is still readable. Reference 8f2a41."
            : undefined
        }
        empty={variant === "empty" ? "This decision has no evidence attached yet." : undefined}
        readOnly={variant === "read-only"}
        actions={
          <Button size="sm" variant="ghost">
            Export as CSV
          </Button>
        }
        footer={
          <Button variant="primary" onClick={() => setOpen(false)}>
            Done
          </Button>
        }
      >
        <EvidenceItem
          source="Florida Statutes §721.10"
          version="rev 2025-07-01"
          effectiveDate="Effective 1 Jul 2025"
          kind="retrieved"
          summary="Sets the ten-day rescission window this decision depends on."
          passage="A purchaser has the right to cancel the contract until midnight of the tenth calendar day following the execution date."
        />
      </Sheet>
    </>
  );
}

function PopoverDemo({
  variant,
}: {
  readonly variant: "default" | "loading" | "error" | "empty" | "read-only";
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  return (
    <>
      <Button ref={anchorRef} {...popoverTriggerProps(id, open)} onClick={() => setOpen(!open)}>
        Filter builder
      </Button>
      <Popover
        id={id}
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        title="Add a filter"
        loading={variant === "loading"}
        error={
          variant === "error"
            ? "We could not load the filterable fields. Reference 8f2a41."
            : undefined
        }
        empty={variant === "empty" ? "Every field is already filtered." : undefined}
        readOnly={variant === "read-only"}
        footer={
          <Button size="sm" variant="primary" onClick={() => setOpen(false)}>
            Apply
          </Button>
        }
      >
        <SelectDemo variant="default" />
      </Popover>
    </>
  );
}

const ROW_ACTIONS: readonly DropdownItem[] = [
  { id: "open", label: "Open the case", shortcut: "Enter", onSelect: noop },
  { id: "preview", label: "Preview in the panel", shortcut: "Space", onSelect: noop },
  {
    id: "assign",
    label: "Assign to me",
    description: "You become the owner of record",
    onSelect: noop,
  },
  {
    id: "escalate",
    label: "Escalate",
    disabled: true,
    disabledReason: "Only a supervisor can escalate",
    onSelect: noop,
  },
  {
    id: "close",
    label: "Close without action",
    destructive: true,
    separatorBefore: true,
    onSelect: noop,
  },
];

function DropdownDemo({
  variant,
}: {
  readonly variant: "default" | "loading" | "error" | "empty";
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  return (
    <>
      <Button ref={anchorRef} {...dropdownTriggerProps(id, open)} onClick={() => setOpen(!open)}>
        Row actions
      </Button>
      <Dropdown
        id={id}
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        label="Row actions"
        items={variant === "empty" ? [] : ROW_ACTIONS}
        loading={variant === "loading"}
        error={variant === "error" ? "We could not load the actions. Reference 8f2a41." : undefined}
        empty="Nothing can be done to this case from here."
      />
    </>
  );
}

/**
 * A toast, held still so it can be looked at.
 *
 * `durationMs={null}` stops it dismissing itself mid-review, and dismissing it
 * puts a way back in its place: a specimen that can leave the page and not
 * return takes a state out of the review surface until somebody reloads.
 */
function ToastSpecimen({
  variant,
}: {
  readonly variant: "success" | "undo" | "failure";
}) {
  const [shown, setShown] = useState(true);
  if (!shown) {
    return (
      <Button size="sm" onClick={() => setShown(true)}>
        Show the toast again
      </Button>
    );
  }
  if (variant === "undo") {
    return (
      <Toast
        title="Rejected. The case is back in the queue."
        tone="neutral"
        undo={{ onUndo: () => setShown(false), label: "Undo the rejection" }}
        durationMs={null}
        onDismiss={() => setShown(false)}
      />
    );
  }
  if (variant === "failure") {
    return (
      <Toast
        title="We could not queue the letter."
        description="Nothing was sent. Reference 8f2a41."
        tone="danger"
        durationMs={null}
        onDismiss={() => setShown(false)}
      />
    );
  }
  return (
    <Toast
      title="Approved. Letter queued for 3 owners."
      description="Approval #4182"
      tone="success"
      record={{ href: "/audit" }}
      durationMs={null}
      onDismiss={() => setShown(false)}
    />
  );
}

function ToastLiveDemo() {
  const [shown, setShown] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setShown(true)}>
        Approve and raise a toast
      </Button>
      {shown && (
        <ToastRegion>
          <Toast
            title="Approved. Letter queued for 3 owners."
            description="Approval #4182 · M. Delgado, A. Okonkwo, P. Reyes"
            tone="success"
            undo={{ onUndo: () => setShown(false) }}
            record={{ href: "/audit" }}
            onDismiss={() => setShown(false)}
          />
        </ToastRegion>
      )}
    </>
  );
}

/**
 * An approval is a region landmark named by its ask, so six specimens sharing
 * one ask would be six landmarks nobody can tell apart. Each state gets a real
 * ask instead, which also stops the page reading as the same card six times.
 */
const APPROVAL_ASKS = {
  default: "Send a rescission confirmation to 3 owners in Florida.",
  deciding: "Waive a $180 late fee for A. Okonkwo.",
  decided: "Release the collections hold on account 44207.",
  "read-only": "Close 4 maintenance-fee disputes with no further action.",
  loading: "Re-issue a deed transfer packet to the title company.",
  error: "Move 2 cases to the escalation queue.",
  proposed: "Send the rescission confirmation to M. Delgado now.",
} as const;

function ApprovalCardDemo({
  variant,
}: {
  readonly variant: keyof typeof APPROVAL_ASKS;
}) {
  const [decided, setDecided] = useState<"approved" | "rejected" | null>(null);
  const decision =
    variant === "decided"
      ? {
          outcome: "approved" as const,
          by: "D. Ruiz",
          at: "Approved 09:44",
          reason: "Window verified against the signed contract.",
        }
      : decided !== null
        ? { outcome: decided, by: "You", at: "Just now" }
        : undefined;

  return (
    <ApprovalCard
      ask={APPROVAL_ASKS[variant]}
      headingLevel={4}
      requestedBy="Rescission workflow"
      requestKind="workflow"
      requestedAt="Requested 09:41"
      risk="high_consequence"
      ifApproved={IF_APPROVED}
      artifact={{
        label: "The letter that will be sent",
        preview: (
          <p>
            Dear M. Delgado, we have confirmed your rescission of contract 41823 and closed it,
            effective 8 Aug 2026. Nothing further is owed.
          </p>
        ),
      }}
      ifRejected="Nothing is sent. The three cases return to the queue with your reason attached."
      rule={{ label: "State rescission notice · high risk · policy R-14" }}
      blastRadius={BLAST_RADIUS}
      evidence={
        <EvidenceItem
          source="Florida Statutes §721.10"
          version="rev 2025-07-01"
          effectiveDate="Effective 1 Jul 2025"
          kind="retrieved"
          summary="Sets the ten-day window this decision depends on."
          passage="A purchaser has the right to cancel the contract until midnight of the tenth calendar day following the execution date."
        />
      }
      priorDecisions={
        <ul className="pv-gallery-prior">
          <li>Same ask, 3 owners · D. Ruiz approved · letters delivered</li>
          <li>Same ask, 1 owner · M. Webb approved · letter delivered</li>
          <li>Same ask, 2 owners · D. Ruiz rejected · wrong owner on file</li>
        </ul>
      }
      rejectReasons={REASON_OPTIONS.map((option) => ({
        id: option.value,
        label: option.label,
        description: option.description,
      }))}
      onApprove={() => setDecided("approved")}
      onReject={() => setDecided("rejected")}
      busy={variant === "deciding" ? "approve" : undefined}
      decision={decision}
      readOnly={variant === "read-only"}
      loading={variant === "loading"}
      error={
        variant === "error"
          ? "We could not load this approval. It is still in the queue. Reference 8f2a41."
          : undefined
      }
    />
  );
}

function EvidenceItemDemo({
  variant,
}: {
  readonly variant: "default" | "expanded" | "asserted" | "computed" | "read-only";
}) {
  const kind =
    variant === "asserted" ? "asserted" : variant === "computed" ? "computed" : "retrieved";
  return (
    <EvidenceItem
      source={
        variant === "asserted"
          ? "Owner statement, call 12 Jun 2026"
          : variant === "computed"
            ? "Rescission window ends 14 Aug 2026"
            : "Florida Statutes §721.10"
      }
      version={kind === "retrieved" ? "rev 2025-07-01" : undefined}
      effectiveDate={kind === "retrieved" ? "Effective 1 Jul 2025" : undefined}
      kind={kind}
      summary="Supports the ten-day window this decision depends on."
      passage="A purchaser has the right to cancel the contract until midnight of the tenth calendar day following the execution date."
      defaultExpanded={variant === "expanded"}
      actions={
        <Button size="sm" variant="ghost">
          Flag as wrong
        </Button>
      }
      readOnly={variant === "read-only"}
    />
  );
}

/** Named regions, one per specimen — see the note above PANEL_TITLES. */
const FILTER_BAR_LABELS = {
  default: "Queue filters",
  loading: "Approval filters",
  "read-only": "Audit filters",
} as const;

function FilterBarDemo({ variant }: { readonly variant: keyof typeof FILTER_BAR_LABELS }) {
  const [view, setView] = useState("open");
  const [filters, setFilters] = useState([
    { id: "state", label: "Owner state", value: "Florida" },
    { id: "value", label: "Value over", value: "$5,000" },
  ]);
  return (
    <FilterBar
      label={FILTER_BAR_LABELS[variant]}
      views={[
        { id: "open", label: "All open", count: 1240 },
        { id: "mine", label: "Mine", count: 47 },
        { id: "breaching", label: "Breaching", count: 12 },
        { id: "unassigned", label: "Unassigned" },
      ]}
      activeViewId={view}
      onViewSelect={setView}
      filters={filters}
      onFilterRemove={(id) => setFilters(filters.filter((filter) => filter.id !== id))}
      onFiltersClear={() => setFilters([])}
      onBuildFilter={noop}
      resultCount={1240}
      loading={variant === "loading"}
      readOnly={variant === "read-only"}
    >
      <Button size="sm" variant="ghost">
        Columns
      </Button>
    </FilterBar>
  );
}

function TimelineDemo({
  variant,
}: {
  readonly variant: "default" | "loading" | "error" | "empty" | "read-only";
}) {
  return (
    <Timeline
      label="Run 41823 steps"
      steps={variant === "empty" ? [] : RUN_STEPS}
      onCorrect={noop}
      loading={variant === "loading"}
      error={variant === "error" ? "We could not load the steps. Reference 8f2a41." : undefined}
      empty="This run has not started. The first step appears the moment it does."
      readOnly={variant === "read-only"}
    />
  );
}

function PaletteDemo({
  variant,
}: {
  readonly variant: "default" | "loading" | "error" | "read-only";
}) {
  // Its own registry, deliberately. The palette reads whatever the surrounding
  // screen has registered, and a gallery must show a fixed specimen rather than
  // whatever happens to be mounted — an empty registry also means this
  // provider's key listener has nothing bound to it and dispatches nothing, so
  // the demo cannot fire a real verb behind the reviewer's back.
  return (
    <KeyboardProvider>
      <PaletteDemoInner variant={variant} />
    </KeyboardProvider>
  );
}

function PaletteDemoInner({
  variant,
}: {
  readonly variant: "default" | "loading" | "error" | "read-only";
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <Button ref={triggerRef} onClick={() => setOpen(true)}>
        Open the palette
      </Button>
      <CommandPalette
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        results={PALETTE_RESULTS}
        loading={variant === "loading"}
        error={
          variant === "error"
            ? "We could not search records. Actions and views are still listed. Reference 8f2a41."
            : undefined
        }
        readOnly={variant === "read-only"}
      />
    </>
  );
}

function ShortcutReferenceDemo() {
  return (
    <KeyboardProvider>
      <ShortcutReferenceDemoInner />
    </KeyboardProvider>
  );
}

function ShortcutReferenceDemoInner() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open the reference</Button>
      <ShortcutReference open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** A named glyph, so the set can be read rather than guessed at. */
function Glyph({ name, children }: { readonly name: string; readonly children: ReactNode }) {
  return (
    <li className="pv-gallery-glyph">
      <span className="pv-gallery-glyph-mark" aria-hidden="true">
        {children}
      </span>
      <span className="pv-gallery-glyph-name">{name}</span>
    </li>
  );
}

function IconSetDemo() {
  return (
    <ul className="pv-gallery-glyphs">
      <Glyph name="Check">
        <IconCheck />
      </Glyph>
      <Glyph name="Alert">
        <IconAlert />
      </Glyph>
      <Glyph name="Cross">
        <IconCross />
      </Glyph>
      <Glyph name="Info">
        <IconInfo />
      </Glyph>
      <Glyph name="Dot">
        <IconDot />
      </Glyph>
      <Glyph name="Blocked">
        <IconBlocked />
      </Glyph>
      <Glyph name="Chevron down">
        <IconChevronDown />
      </Glyph>
      <Glyph name="Chevron left">
        <IconChevronLeft />
      </Glyph>
      <Glyph name="Chevron right">
        <IconChevronRight />
      </Glyph>
      <Glyph name="Calendar">
        <IconCalendar />
      </Glyph>
      <Glyph name="Lock">
        <IconLock />
      </Glyph>
      <Glyph name="Circle">
        <IconCircle />
      </Glyph>
      <Glyph name="Dash">
        <IconDash />
      </Glyph>
    </ul>
  );
}

function MarkSetDemo({ variant }: { readonly variant: "steps" | "provenance" | "trend" | "edit" }) {
  if (variant === "steps") {
    return (
      <ul className="pv-gallery-glyphs">
        <Glyph name="Retrieval">
          <MarkRetrieval />
        </Glyph>
        <Glyph name="Model">
          <MarkModel />
        </Glyph>
        <Glyph name="Action">
          <MarkAction />
        </Glyph>
        <Glyph name="Human">
          <MarkHuman />
        </Glyph>
        <Glyph name="Wait">
          <MarkWait />
        </Glyph>
      </ul>
    );
  }
  if (variant === "provenance") {
    return (
      <ul className="pv-gallery-glyphs">
        <Glyph name="Retrieved">
          <MarkRetrieved />
        </Glyph>
        <Glyph name="Asserted">
          <MarkAsserted />
        </Glyph>
        <Glyph name="Computed">
          <MarkComputed />
        </Glyph>
        <Glyph name="External">
          <MarkExternal />
        </Glyph>
      </ul>
    );
  }
  if (variant === "trend") {
    return (
      <ul className="pv-gallery-glyphs">
        <Glyph name="Trend up">
          <MarkTrendUp />
        </Glyph>
        <Glyph name="Trend down">
          <MarkTrendDown />
        </Glyph>
        <Glyph name="Trend flat">
          <MarkTrendFlat />
        </Glyph>
      </ul>
    );
  }
  return (
    <ul className="pv-gallery-glyphs">
      <Glyph name="Added">
        <MarkAdded />
      </Glyph>
      <Glyph name="Removed">
        <MarkRemoved />
      </Glyph>
      <Glyph name="Changed">
        <MarkChanged />
      </Glyph>
      <Glyph name="Undo">
        <MarkUndo />
      </Glyph>
      <Glyph name="Filter">
        <MarkFilter />
      </Glyph>
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The entries
// ---------------------------------------------------------------------------

const PRIMITIVE_ENTRIES: readonly GalleryEntry[] = [
  {
    id: "Avatar",
    family: "primitives",
    name: "Avatar",
    when: "Beside a name, never instead of one. Initials are a recognition aid, not an identifier.",
    states: [
      { name: "Small · 28px", Demo: () => <Avatar name="M. Delgado" size="sm" /> },
      { name: "Medium · 32px", Demo: () => <Avatar name="M. Delgado" /> },
      { name: "Large · 40px", Demo: () => <Avatar name="Adaeze Okonkwo" size="lg" /> },
      {
        name: "Beside its name",
        note: "Hidden from assistive technology when the name is already written.",
        Demo: () => (
          <span className="pv-gallery-inline">
            <Avatar name="P. Reyes" decorative />
            P. Reyes
          </span>
        ),
      },
      {
        name: "Unassigned",
        note: "A designed absence, not a broken image.",
        Demo: () => <UnassignedRow />,
      },
    ],
  },
  {
    id: "Badge",
    family: "primitives",
    name: "Badge",
    when: "A status on a record. Every tone carries its word, so the row survives a monochrome print.",
    states: [
      { name: "Success", Demo: () => <Badge tone="success">Within policy</Badge> },
      { name: "Warning", Demo: () => <Badge tone="warning">Approaching the limit</Badge> },
      { name: "Danger", Demo: () => <Badge tone="danger">Breached</Badge> },
      { name: "Info", Demo: () => <Badge tone="info">In progress</Badge> },
      { name: "Neutral", Demo: () => <Badge tone="neutral">Archived</Badge> },
      { name: "Denied", Demo: () => <Badge tone="denied">Refused by policy</Badge> },
      {
        name: "Small · uppercase",
        Demo: () => (
          <Badge tone="info" size="sm">
            Workflow
          </Badge>
        ),
      },
      {
        name: "Outline",
        note: "For a column of badges, where a stack of tints becomes a stripe.",
        Demo: () => (
          <Badge tone="success" emphasis="outline">
            Verified
          </Badge>
        ),
      },
    ],
  },
  {
    id: "Button",
    family: "primitives",
    name: "Button",
    when: "Every action. Approve and Reject are the same size on purpose — neither is the easy path.",
    states: [
      { name: "Primary", Demo: () => <Button variant="primary">Approve</Button> },
      { name: "Secondary", Demo: () => <Button>Reject</Button> },
      { name: "Ghost", Demo: () => <Button variant="ghost">Preview changes</Button> },
      { name: "Danger", Demo: () => <Button variant="danger">Revoke credentials</Button> },
      { name: "Small · 28px", Demo: () => <Button size="sm">Columns</Button> },
      { name: "Large · 40px", Demo: () => <Button size="lg">Approve</Button> },
      {
        name: "Loading",
        note: "Keeps its width and its place in the tab order. Refuses the second click.",
        Demo: () => (
          <Button variant="primary" loading>
            Approve
          </Button>
        ),
      },
      { name: "Disabled", Demo: () => <Button disabled>Approve</Button> },
      {
        name: "Unavailable",
        note: "Reachable and announced, with the reason beside it. Not the same as disabled.",
        Demo: () => <UnavailableButton />,
      },
      {
        name: "Icon only",
        note: "The accessible name is required by the type, not by a convention.",
        Demo: () => (
          <Button iconOnly label="Close the panel">
            <IconCross />
          </Button>
        ),
      },
    ],
  },
  {
    id: "Checkbox",
    family: "primitives",
    name: "Checkbox",
    when: "An independent choice. The hint says what ticking it does, before it is ticked.",
    states: [
      { name: "Default", Demo: () => <CheckboxDemo variant="default" /> },
      { name: "Selected", Demo: () => <CheckboxDemo variant="selected" /> },
      {
        name: "Indeterminate",
        note: "Some of what this box covers, not all.",
        Demo: () => <CheckboxDemo variant="indeterminate" />,
      },
      { name: "Error", Demo: () => <CheckboxDemo variant="error" /> },
      { name: "Disabled", Demo: () => <CheckboxDemo variant="disabled" /> },
      { name: "Read-only", Demo: () => <CheckboxDemo variant="read-only" /> },
    ],
  },
  {
    id: "Chip",
    family: "primitives",
    name: "Chip",
    when: "A filter, a saved view, or a piece of metadata. Toggling and removing are different chips.",
    states: [
      { name: "Default", Demo: () => <Chip>Collections</Chip> },
      { name: "Toned", Demo: () => <Chip tone="warning">Breaching in 4 hours</Chip> },
      { name: "Small", Demo: () => <Chip size="sm">rev 2025-07-01</Chip> },
      { name: "Toggle · selected", Demo: ChipToggleDemo },
      { name: "Removable", Demo: ChipRemovableDemo },
      { name: "Disabled", Demo: () => <Chip disabled>High value</Chip> },
    ],
  },
  {
    id: "Combobox",
    family: "primitives",
    name: "Combobox",
    when: "A list too long to read: the operator types, the list narrows. Typing is never debounced.",
    states: [
      { name: "Default", Demo: () => <ComboboxDemo variant="default" /> },
      {
        name: "Custom value allowed",
        note: "Off by default — a value that is not in the list is usually a typo.",
        Demo: () => <ComboboxDemo variant="custom" />,
      },
      { name: "Loading", Demo: () => <ComboboxDemo variant="loading" /> },
      { name: "Error", Demo: () => <ComboboxDemo variant="error" /> },
      { name: "Disabled", Demo: () => <ComboboxDemo variant="disabled" /> },
      { name: "Read-only", Demo: () => <ComboboxDemo variant="read-only" /> },
    ],
  },
  {
    id: "DatePicker",
    family: "primitives",
    name: "DatePicker",
    when: "One date. Typing and picking both work, and the accepted formats are written in the hint.",
    states: [
      { name: "Default", Demo: () => <DatePickerDemo variant="default" /> },
      { name: "Chosen", Demo: () => <DatePickerDemo variant="chosen" /> },
      { name: "Error", Demo: () => <DatePickerDemo variant="error" /> },
      { name: "Disabled", Demo: () => <DatePickerDemo variant="disabled" /> },
      { name: "Read-only", Demo: () => <DatePickerDemo variant="read-only" /> },
    ],
  },
  {
    id: "DateRange",
    family: "primitives",
    name: "DateRange",
    when: "Two dates that constrain each other. The audit browser's date filter is one of these.",
    states: [
      { name: "Default", Demo: () => <DateRangeDemo variant="default" />, wide: true },
      { name: "Chosen", Demo: () => <DateRangeDemo variant="chosen" />, wide: true },
      { name: "Error", Demo: () => <DateRangeDemo variant="error" />, wide: true },
      { name: "Read-only", Demo: () => <DateRangeDemo variant="read-only" />, wide: true },
    ],
  },
  {
    id: "Field",
    family: "primitives",
    name: "Field",
    when: "The label, hint, error and read-only chip around a control the caller owns.",
    states: [
      { name: "Default", Demo: () => <FieldDemo variant="default" /> },
      { name: "Error", Demo: () => <FieldDemo variant="error" /> },
      { name: "Read-only", Demo: () => <FieldDemo variant="read-only" /> },
    ],
  },
  {
    id: "Input",
    family: "primitives",
    name: "Input",
    when: "One line of text. The hint goes above the control, because a hint below it is read after the mistake.",
    states: [
      {
        name: "Default",
        Demo: () => <Input label="Case reference" hint="Six characters, letters and digits." />,
      },
      {
        name: "With a prefix and a unit",
        Demo: () => <Input label="Value" leading="$" trailing="USD" defaultValue="12,400" />,
      },
      {
        name: "Loading",
        note: "An in-flight check against the server, not a page load.",
        Demo: () => <Input label="Account number" defaultValue="41823" loading loadingLabel="Checking the account" />,
      },
      {
        name: "Error",
        Demo: () => (
          <Input
            label="Case reference"
            defaultValue="8f2"
            error="A reference is six characters. Check the one on the letter."
          />
        ),
      },
      { name: "Disabled", Demo: () => <Input label="Case reference" defaultValue="8f2a41" disabled /> },
      {
        name: "Read-only",
        Demo: () => <Input label="Case reference" defaultValue="8f2a41" readOnly />,
      },
      { name: "Small · 28px", Demo: () => <Input label="Search" labelHidden size="sm" type="search" /> },
      { name: "Large · 40px", Demo: () => <Input label="Owner name" size="lg" /> },
    ],
  },
  {
    id: "OptionList",
    family: "primitives",
    name: "OptionList",
    when: "The listbox behind Select and Combobox. Shown here alone so its rows can be judged.",
    states: [
      {
        name: "Default",
        note: "The check mark's space is reserved whether or not it is drawn, so choosing shifts nothing.",
        Demo: OptionListDemo,
      },
    ],
  },
  {
    id: "Radio",
    family: "primitives",
    name: "Radio and RadioGroup",
    when: "One answer out of a few, where the operator should read every option. The rejection reason is one.",
    states: [
      { name: "Default", Demo: () => <RadioGroupDemo variant="default" /> },
      { name: "Horizontal", Demo: () => <RadioGroupDemo variant="horizontal" />, wide: true },
      { name: "Error", Demo: () => <RadioGroupDemo variant="error" /> },
      { name: "Disabled", Demo: () => <RadioGroupDemo variant="disabled" /> },
      { name: "Read-only", Demo: () => <RadioGroupDemo variant="read-only" /> },
    ],
  },
  {
    id: "Select",
    family: "primitives",
    name: "Select",
    when: "A short, known list. Anything the operator would rather type into is a Combobox.",
    states: [
      { name: "Default", Demo: () => <SelectDemo variant="default" /> },
      { name: "Chosen", Demo: () => <SelectDemo variant="chosen" /> },
      { name: "Loading", Demo: () => <SelectDemo variant="loading" /> },
      { name: "Error", Demo: () => <SelectDemo variant="error" /> },
      {
        name: "Empty",
        note: "Says why there is nothing and who can change it.",
        Demo: () => <SelectDemo variant="empty" />,
      },
      { name: "Disabled", Demo: () => <SelectDemo variant="disabled" /> },
      { name: "Read-only", Demo: () => <SelectDemo variant="read-only" /> },
    ],
  },
  {
    id: "Skeleton",
    family: "primitives",
    name: "Skeleton",
    when: "Past 300ms only. Below that, show nothing rather than a flash (spec §7).",
    states: [
      { name: "Text · three lines", Demo: () => <Skeleton lines={3} delayMs={0} label="Loading the case" /> },
      {
        // Sizes come from the scale like everything else. The delay is zeroed
        // only here: a gallery that waited 300ms to show a skeleton would show
        // a reviewer an empty box and call it the state.
        name: "Card",
        Demo: () => (
          <Skeleton lines={1} height="var(--pv-space-64)" radius="card" delayMs={0} />
        ),
      },
      {
        name: "Pill",
        Demo: () => (
          <Skeleton lines={1} width="var(--pv-space-96)" radius="pill" delayMs={0} />
        ),
      },
    ],
  },
  {
    id: "Spinner",
    family: "primitives",
    name: "Spinner",
    when: "Inside a control that is working. For a region, use a skeleton — a spinner reserves no space.",
    states: [
      { name: "Small · 12px", Demo: () => <Spinner size="sm" label="Saving" /> },
      { name: "Medium · 16px", Demo: () => <Spinner label="Saving" /> },
      { name: "Large · 24px", Demo: () => <Spinner size="lg" label="Verifying the chain" /> },
      {
        name: "Decorative",
        note: "Inside a control that already announces itself busy.",
        Demo: () => <Spinner decorative />,
      },
    ],
  },
  {
    id: "Switch",
    family: "primitives",
    name: "Switch",
    when: "A setting that takes effect immediately. Anything needing Save is a Checkbox.",
    states: [
      { name: "Off", Demo: () => <SwitchDemo variant="off" /> },
      { name: "On", Demo: () => <SwitchDemo variant="on" /> },
      { name: "Error", Demo: () => <SwitchDemo variant="error" /> },
      { name: "Disabled", Demo: () => <SwitchDemo variant="disabled" /> },
      { name: "Read-only", Demo: () => <SwitchDemo variant="read-only" /> },
    ],
  },
  {
    id: "Textarea",
    family: "primitives",
    name: "Textarea",
    when: "A free-text reason or note. The counter reports; it never truncates what was typed.",
    states: [
      {
        name: "Default",
        Demo: () => (
          <Textarea label="Why are you rejecting this?" hint="Captured as improvement signal." maxLength={280} />
        ),
      },
      {
        name: "Error",
        Demo: () => (
          <Textarea label="Why are you rejecting this?" error="Say what was wrong, so the workflow can learn." />
        ),
      },
      { name: "Disabled", Demo: () => <Textarea label="Note" defaultValue="Window verified." disabled /> },
      {
        name: "Read-only",
        Demo: () => <Textarea label="Note" defaultValue="Window verified against the signed contract." readOnly />,
      },
    ],
  },
  {
    id: "Tooltip",
    family: "primitives",
    name: "Tooltip",
    when: "Supplementary detail, never the only carrier of a meaning. The bubble is always in the DOM.",
    states: [
      {
        name: "On a button",
        note: "Hover, or Tab to it. Announced with the control whether or not anyone hovered.",
        Demo: () => (
          <Tooltip content="Breaching in 4 hours · SLA is 48 hours">
            <Button>Age</Button>
          </Tooltip>
        ),
      },
      {
        name: "Below",
        Demo: () => (
          <Tooltip placement="bottom" content="Approval #4182 was decided by D. Ruiz at 09:44.">
            <Button variant="ghost">Decided</Button>
          </Tooltip>
        ),
      },
    ],
  },
  {
    id: "icons",
    family: "primitives",
    name: "Icon set",
    when: "The interface glyphs. Every one is decorative and sits beside a word that carries the meaning.",
    states: [{ name: "Every icon", Demo: IconSetDemo, wide: true }],
  },
];

const SURFACE_ENTRIES: readonly GalleryEntry[] = [
  {
    id: "Card",
    family: "surfaces",
    name: "Card",
    when: "A bounded record. It lifts on hover only when it is actually clickable.",
    states: [
      {
        name: "Default",
        Demo: () => (
          <Card title="Case 41823" titleLevel={4} eyebrow="Collections" footer="Opened 2d 4h ago">
            M. Delgado · $12,400 · breaching in 4 hours
          </Card>
        ),
      },
      {
        name: "Interactive",
        note: "The title becomes the button. Nothing else in the card may be clickable.",
        Demo: () => (
          <Card title="Case 39112" titleLevel={4} onActivate={noop}>
            A. Okonkwo · $3,180
          </Card>
        ),
      },
      {
        name: "Selected",
        Demo: () => (
          <Card title="Case 44207" titleLevel={4} selected>
            P. Reyes · $940
          </Card>
        ),
      },
      { name: "Glass", note: "Chrome and summary cards only, never behind a table.", Demo: () => (
        <Card title="This week" titleLevel={4} tone="glass">
          47 approvals · 3 breaching
        </Card>
      ) },
      { name: "Loading", Demo: () => <Card title="Recovery" titleLevel={4} loading /> },
      {
        name: "Error",
        Demo: () => (
          <Card
            title="Recovery"
            titleLevel={4}
            error="We could not reach the loan servicing system. Reference 8f2a41."
          />
        ),
      },
      {
        name: "Empty",
        Demo: () => <Card title="Prior decisions" titleLevel={4} empty="No comparable decision yet." />,
      },
      {
        name: "Read-only",
        note: "The actions go rather than dim. A dimmed button is an invitation to keep clicking.",
        Demo: () => (
          <Card title="Owner record" titleLevel={4} readOnly actions={<Button size="sm">Edit</Button>}>
            M. Delgado · account 41823
          </Card>
        ),
      },
      {
        name: "Disabled",
        Demo: () => <Card title="Case 40551" titleLevel={4} onActivate={noop} disabled />,
      },
    ],
  },
  {
    id: "Dropdown",
    family: "surfaces",
    name: "Dropdown",
    when: "A menu of actions on a record. A destructive item is separated and named, never just red.",
    states: [
      { name: "Default", Demo: () => <DropdownDemo variant="default" /> },
      { name: "Loading", Demo: () => <DropdownDemo variant="loading" /> },
      { name: "Error", Demo: () => <DropdownDemo variant="error" /> },
      { name: "Empty", Demo: () => <DropdownDemo variant="empty" /> },
    ],
  },
  {
    id: "Modal",
    family: "surfaces",
    name: "Modal",
    when: "A question that must be answered before anything else. Destructive ones state what cannot be restored.",
    states: [
      { name: "Default", Demo: () => <ModalDemo variant="default" /> },
      {
        name: "Danger",
        note: "Announces as an alert. For irreversible actions only.",
        Demo: () => <ModalDemo variant="danger" />,
      },
      { name: "Loading", Demo: () => <ModalDemo variant="loading" /> },
      { name: "Error", Demo: () => <ModalDemo variant="error" /> },
      { name: "Empty", Demo: () => <ModalDemo variant="empty" /> },
      { name: "Read-only", Demo: () => <ModalDemo variant="read-only" /> },
    ],
  },
  {
    id: "Panel",
    family: "surfaces",
    name: "Panel",
    when: "A titled region beside the content — the record context and the copilot live in one.",
    states: [
      { name: "Default", Demo: () => <PanelDemo variant="default" />, wide: true },
      { name: "Glass", Demo: () => <PanelDemo variant="glass" />, wide: true },
      { name: "Collapsible", Demo: () => <PanelDemo variant="collapsible" />, wide: true },
      { name: "Resizable", Demo: () => <PanelDemo variant="resizable" />, wide: true },
      { name: "Loading", Demo: () => <PanelDemo variant="loading" />, wide: true },
      { name: "Error", Demo: () => <PanelDemo variant="error" />, wide: true },
      { name: "Empty", Demo: () => <PanelDemo variant="empty" />, wide: true },
      { name: "Read-only", Demo: () => <PanelDemo variant="read-only" />, wide: true },
    ],
  },
  {
    id: "Popover",
    family: "surfaces",
    name: "Popover",
    when: "A small piece of interface anchored to the control that opened it. The filter builder is one.",
    states: [
      { name: "Default", Demo: () => <PopoverDemo variant="default" /> },
      { name: "Loading", Demo: () => <PopoverDemo variant="loading" /> },
      { name: "Error", Demo: () => <PopoverDemo variant="error" /> },
      { name: "Empty", Demo: () => <PopoverDemo variant="empty" /> },
      { name: "Read-only", Demo: () => <PopoverDemo variant="read-only" /> },
    ],
  },
  {
    id: "ReadOnlyChip",
    family: "surfaces",
    name: "ReadOnlyChip",
    when: "One per surface, in the header. It is how read-only is stated rather than implied by dimming.",
    states: [
      { name: "Default", Demo: () => <ReadOnlyChip /> },
      { name: "With its own words", Demo: () => <ReadOnlyChip label="Auditor session" /> },
    ],
  },
  {
    id: "ResizeSeparator",
    family: "surfaces",
    name: "ResizeSeparator",
    when: "A draggable boundary. Arrow keys move it too, and it is named after what it resizes.",
    states: [
      {
        name: "Default",
        note: "Focus it and press the arrow keys. Shift multiplies the step.",
        Demo: ResizeSeparatorDemo,
        wide: true,
      },
    ],
  },
  {
    id: "Sheet",
    family: "surfaces",
    name: "Sheet",
    when: "A full-height record opened from a row — the evidence chain. It grows from the row and collapses back into it.",
    states: [
      { name: "Default", Demo: () => <SheetDemo variant="default" /> },
      { name: "Full width", Demo: () => <SheetDemo variant="full" /> },
      { name: "Loading", Demo: () => <SheetDemo variant="loading" /> },
      { name: "Error", Demo: () => <SheetDemo variant="error" /> },
      { name: "Empty", Demo: () => <SheetDemo variant="empty" /> },
      { name: "Read-only", Demo: () => <SheetDemo variant="read-only" /> },
    ],
  },
  {
    id: "SurfaceState",
    family: "surfaces",
    name: "SurfaceState",
    when: "The loading, error and empty bodies that Card, Panel, Modal and Sheet all share. One idea of each, everywhere.",
    states: [
      {
        name: "Loading",
        Demo: () => <SurfaceState loading skeletonLines={3} />,
      },
      {
        name: "Error",
        Demo: () => <SurfaceState error="We could not reach the case store. Reference 8f2a41." />,
      },
      { name: "Empty", Demo: () => <SurfaceState empty="Nothing is waiting on you." /> },
      { name: "Content", Demo: () => <SurfaceState>The body renders untouched.</SurfaceState> },
    ],
  },
  {
    id: "Table",
    family: "surfaces",
    name: "Table",
    when: "The queue. Virtualized, sortable, resizable, and configurable — and it tells the truth about how many rows there are.",
    states: [
      {
        name: "Default",
        note: "J and K move, Enter opens, Space previews, X selects. Sorting never animates.",
        Demo: () => <TableDemo variant="default" />,
        wide: true,
      },
      { name: "Loading", Demo: () => <TableDemo variant="loading" />, wide: true },
      { name: "Error", Demo: () => <TableDemo variant="error" />, wide: true },
      { name: "Empty", Demo: () => <TableDemo variant="empty" />, wide: true },
      {
        name: "Read-only",
        note: "Navigation, preview, sorting and columns stay. Selection goes, because it exists to feed bulk actions.",
        Demo: () => <TableDemo variant="read-only" />,
        wide: true,
      },
    ],
  },
  {
    id: "Tabs",
    family: "surfaces",
    name: "Tabs",
    when: "Stages of one thing — Current, Draft, Diff, Impact. Not navigation between records.",
    states: [
      { name: "Default", Demo: () => <TabsDemo variant="default" />, wide: true },
      { name: "Loading", Demo: () => <TabsDemo variant="loading" />, wide: true },
      { name: "Read-only", Demo: () => <TabsDemo variant="read-only" />, wide: true },
    ],
  },
];

const DOMAIN_ENTRIES: readonly GalleryEntry[] = [
  {
    id: "ApprovalCard",
    family: "domain",
    name: "ApprovalCard",
    when: "The hero. Open to decided in under ten seconds, with the consequence stated before the answer is given.",
    states: [
      { name: "Default", Demo: () => <ApprovalCardDemo variant="default" />, wide: true },
      {
        name: "Deciding",
        note: "Both buttons hold their place; only the pressed one spins.",
        Demo: () => <ApprovalCardDemo variant="deciding" />,
        wide: true,
      },
      { name: "Decided", Demo: () => <ApprovalCardDemo variant="decided" />, wide: true },
      {
        name: "Read-only",
        note: "The auditor's view of a live approval: everything to read, nothing to press.",
        Demo: () => <ApprovalCardDemo variant="read-only" />,
        wide: true,
      },
      { name: "Loading", Demo: () => <ApprovalCardDemo variant="loading" />, wide: true },
      { name: "Error", Demo: () => <ApprovalCardDemo variant="error" />, wide: true },
    ],
  },
  {
    id: "AreaChart",
    family: "domain",
    name: "AreaChart",
    when: "A quantity accumulating over time. Bars start at zero and so does this.",
    states: [
      {
        name: "Default",
        Demo: () => (
          <AreaChart
            question="How much have we recovered each month?"
            headingLevel={4}
            caption={RECOVERY_CAPTION}
            series={RECOVERY_SERIES}
            annotations={INTERVENTION}
            formatValue={(value) => `$${value}k`}
          />
        ),
        wide: true,
      },
      {
        name: "Loading",
        Demo: () => <AreaChart question="How much have we recovered each month?" headingLevel={4} series={[]} loading />,
        wide: true,
      },
      {
        name: "Error",
        Demo: () => (
          <AreaChart
            question="How much have we recovered each month?"
            headingLevel={4}
            series={[]}
            error="We could not reach the metrics store. Reference 8f2a41."
          />
        ),
        wide: true,
      },
      {
        name: "Empty",
        Demo: () => (
          <AreaChart
            question="How much have we recovered each month?"
            headingLevel={4}
            series={[]}
            empty="No months have closed yet. The first appears after month end."
          />
        ),
        wide: true,
      },
    ],
  },
  {
    id: "BarChart",
    family: "domain",
    name: "BarChart",
    when: "Comparing categories. Bars are lengths, so the axis starts at zero — always.",
    states: [
      {
        name: "Default",
        Demo: () => (
          <BarChart
            question="Which months recovered the most?"
            headingLevel={4}
            caption={RECOVERY_CAPTION}
            series={RECOVERY_SERIES}
            formatValue={(value) => `$${value}k`}
          />
        ),
        wide: true,
      },
      {
        name: "Loading",
        Demo: () => <BarChart question="Which months recovered the most?" headingLevel={4} series={[]} loading />,
        wide: true,
      },
      {
        name: "Error",
        Demo: () => (
          <BarChart
            question="Which months recovered the most?"
            headingLevel={4}
            series={[]}
            error="We could not reach the metrics store. Reference 8f2a41."
          />
        ),
        wide: true,
      },
      {
        name: "Empty",
        Demo: () => (
          <BarChart
            question="Which months recovered the most?"
            headingLevel={4}
            series={[]}
            empty="No months have closed yet."
          />
        ),
        wide: true,
      },
    ],
  },
  {
    id: "Callout",
    family: "domain",
    name: "Callout",
    when: "“If you approve”. A bordered claim about what will happen, never a paraphrase of it.",
    states: [
      {
        name: "Outline · the approval's own",
        Demo: () => (
          <Callout title="If you approve">
            <ul>
              {IF_APPROVED.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          </Callout>
        ),
        wide: true,
      },
      {
        name: "Tinted · warning",
        Demo: () => (
          <Callout tone="warning" emphasis="tinted" title="This owner is inside the rescission window.">
            Anything sent before 14 Aug 2026 must carry the statutory notice.
          </Callout>
        ),
        wide: true,
      },
      {
        name: "Tinted · danger",
        Demo: () => (
          <Callout tone="danger" emphasis="tinted" title="The chain could not be verified.">
            Event 41823 does not hash to its predecessor. The record is readable; its integrity is not proven.
          </Callout>
        ),
        wide: true,
      },
      {
        name: "With actions",
        Demo: () => (
          <Callout
            tone="info"
            title="This rule fires on every case over $10,000."
            actions={
              <>
                <Button size="sm">Preview the letter</Button>
                <Button size="sm" variant="ghost">
                  Change the rule
                </Button>
              </>
            }
          >
            Policy R-14 · last changed 12 Jun 2026 by D. Ruiz.
          </Callout>
        ),
        wide: true,
      },
      {
        name: "Read-only",
        note: "The actions go. Auditors read callouts; they do not act on them.",
        Demo: () => (
          <Callout
            tone="info"
            readOnly
            title="This rule fires on every case over $10,000."
            actions={<Button size="sm">Change the rule</Button>}
          >
            Policy R-14 · last changed 12 Jun 2026 by D. Ruiz.
          </Callout>
        ),
        wide: true,
      },
    ],
  },
  {
    id: "ChartFrame",
    family: "domain",
    name: "ChartFrame",
    when: "The question, the denominator, the axis, and the numbers behind every chart. The four chart types are marks drawn inside it.",
    states: [
      {
        name: "Default",
        note: "“Show the numbers” is the same table a screen reader and a spreadsheet both get.",
        Demo: () => (
          <ChartFrame
            question="Is collections recovery improving?"
            headingLevel={4}
            caption={RECOVERY_CAPTION}
            series={RECOVERY_SERIES}
            categories={categoriesOf(RECOVERY_SERIES)}
            axis={axisFor(RECOVERY_SERIES.flatMap((one) => one.points.map((point) => point.y)))}
            kind="Line chart"
            legend
          />
        ),
        wide: true,
      },
      {
        name: "Loading",
        Demo: () => (
          <ChartFrame
            question="Is collections recovery improving?"
            headingLevel={4}
            series={[]}
            categories={[]}
            axis={axisFor([])}
            kind="Line chart"
            loading
          />
        ),
        wide: true,
      },
      {
        name: "Error",
        Demo: () => (
          <ChartFrame
            question="Is collections recovery improving?"
            headingLevel={4}
            series={[]}
            categories={[]}
            axis={axisFor([])}
            kind="Line chart"
            error="We could not reach the metrics store. Reference 8f2a41."
          />
        ),
        wide: true,
      },
      {
        name: "Empty",
        Demo: () => (
          <ChartFrame
            question="Is collections recovery improving?"
            headingLevel={4}
            series={[]}
            categories={[]}
            axis={axisFor([])}
            kind="Line chart"
            empty="No months have closed yet."
          />
        ),
        wide: true,
      },
    ],
  },
  {
    id: "CopilotMessage",
    family: "domain",
    name: "CopilotMessage",
    when: "One turn in the copilot. Citations carry the same provenance distinction as everywhere else.",
    states: [
      {
        name: "From the operator",
        Demo: () => (
          <CopilotMessage author="operator" time="09:40" body="Can this owner still rescind?" />
        ),
        wide: true,
      },
      {
        name: "From the copilot",
        Demo: () => (
          <CopilotMessage
            author="copilot"
            time="09:41"
            body="Yes. The contract was signed on 24 July 2026, so the ten-day window closes at midnight on 14 August 2026 [1]."
            citations={[
              {
                id: "fl",
                marker: "1",
                source: "Florida Statutes §721.10",
                kind: "retrieved",
                version: "rev 2025-07-01",
                effectiveDate: "Effective 1 Jul 2025",
                passage:
                  "A purchaser has the right to cancel the contract until midnight of the tenth calendar day following the execution date.",
              },
            ]}
            cost="$0.011"
            elapsed="1.4s"
          />
        ),
        wide: true,
      },
      {
        name: "Streaming",
        note: "Text streams; an action card is held back until it is complete.",
        Demo: () => (
          <CopilotMessage author="copilot" body="Checking the contract dates against the statute" streaming />
        ),
        wide: true,
      },
      {
        name: "Proposed action",
        note: "The approval's anatomy, inside the conversation.",
        Demo: () => (
          <CopilotMessage
            author="copilot"
            time="09:42"
            body="I can send the confirmation now."
            action={<ApprovalCardDemo variant="proposed" />}
            cost="$0.004"
            elapsed="0.9s"
          />
        ),
        wide: true,
      },
      {
        name: "I don't know",
        note: "A designed, first-class answer that offers a person instead.",
        Demo: () => (
          <CopilotMessage
            author="copilot"
            time="09:43"
            body="I do not know whether this contract was amended after signature. Nothing in the record says either way."
            unknown
            onRouteToHuman={noop}
          />
        ),
        wide: true,
      },
      {
        name: "Read-only",
        Demo: () => (
          <CopilotMessage
            author="copilot"
            time="09:43"
            body="The window closes at midnight on 14 August 2026."
            onRouteToHuman={noop}
            readOnly
          />
        ),
        wide: true,
      },
    ],
  },
  {
    id: "DiffView",
    family: "domain",
    name: "DiffView",
    when: "Current beside draft, before anything is published. Mandatory on every configuration surface.",
    states: [
      {
        name: "Default",
        Demo: () => <DiffView label="Changes to policy R-14" rows={DIFF_ROWS} />,
        wide: true,
      },
      {
        name: "Showing unchanged",
        Demo: () => <DiffView label="Changes to policy R-14" rows={DIFF_ROWS} showUnchanged />,
        wide: true,
      },
      {
        name: "Loading",
        Demo: () => <DiffView label="Changes to policy R-14" rows={[]} loading />,
        wide: true,
      },
      {
        name: "Error",
        Demo: () => (
          <DiffView
            label="Changes to policy R-14"
            rows={[]}
            error="We could not load the draft. The live value is unchanged. Reference 8f2a41."
          />
        ),
        wide: true,
      },
      {
        name: "Empty",
        Demo: () => (
          <DiffView label="Changes to policy R-14" rows={[]} empty="The draft matches what is live. There is nothing to publish." />
        ),
        wide: true,
      },
      {
        name: "Read-only",
        Demo: () => <DiffView label="Changes to policy R-14" rows={DIFF_ROWS} readOnly />,
        wide: true,
      },
    ],
  },
  {
    id: "EmptyState",
    family: "domain",
    name: "EmptyState",
    when: "Nothing to show, and that is not a failure. It says what will change it and offers the way out.",
    states: [
      {
        name: "Default",
        Demo: () => (
          <EmptyState
            title="Nothing needs you right now."
            headingLevel={4}
            body="New cases arrive as owners contact us or as workflows escalate. You will see them here, and a digest lands at 9:00 each morning."
            actions={
              <>
                <Button>Change my digest</Button>
                <Button variant="ghost">See all cases</Button>
              </>
            }
          />
        ),
        wide: true,
      },
      {
        name: "Filtered to nothing",
        note: "The hint is what turns a confusing empty table into an obvious one.",
        Demo: () => (
          <EmptyState
            title="No case matches these filters."
            headingLevel={4}
            body="Widen the value range, or clear the owner state."
            actions={<Button>Clear the filters</Button>}
            hint="3 filters are active."
          />
        ),
        wide: true,
      },
      {
        name: "Centred",
        Demo: () => (
          <EmptyState
            title="No evidence is attached yet."
            headingLevel={4}
            body="Evidence appears here as the run cites it."
            align="center"
          />
        ),
        wide: true,
      },
    ],
  },
  {
    id: "ErrorState",
    family: "domain",
    name: "ErrorState",
    when: "What happened, what it means, what to do, and the reference. Never “Something went wrong”.",
    states: [
      {
        name: "Failure",
        Demo: () => (
          <ErrorState
            title="We could not reach the loan servicing system."
            headingLevel={4}
            meaning="Your work is saved."
            guidance="You can retry now, or continue and we will sync when it is back."
            reference="8f2a41"
            actions={
              <>
                <Button variant="primary">Retry</Button>
                <Button>Continue offline</Button>
              </>
            }
          />
        ),
        wide: true,
      },
      {
        name: "Degraded",
        note: "A warning is a state the operator can keep working through.",
        Demo: () => (
          <ErrorState
            title="These figures are 40 minutes old."
            headingLevel={4}
            tone="warning"
            meaning="The metrics store is behind. Everything shown was true at 09:05."
            guidance="Refresh to try again."
            reference="c14e07"
            actions={<Button>Refresh</Button>}
          />
        ),
        wide: true,
      },
      {
        name: "Permission denied",
        Demo: () => (
          <ErrorState
            title="You do not have access to collections cases."
            headingLevel={4}
            meaning="Nothing here is hidden from you by accident."
            guidance="A supervisor can grant it — Dana Ruiz or Marc Webb administer this queue."
            reference="a92b10"
          />
        ),
        wide: true,
      },
    ],
  },
  {
    id: "EvidenceItem",
    family: "domain",
    name: "EvidenceItem",
    when: "A citation an approver can check without leaving the screen. Source, version, effective date, exact passage.",
    states: [
      { name: "Retrieved", Demo: () => <EvidenceItemDemo variant="default" />, wide: true },
      { name: "Expanded", Demo: () => <EvidenceItemDemo variant="expanded" />, wide: true },
      { name: "Asserted", Demo: () => <EvidenceItemDemo variant="asserted" />, wide: true },
      { name: "Computed", Demo: () => <EvidenceItemDemo variant="computed" />, wide: true },
      { name: "Read-only", Demo: () => <EvidenceItemDemo variant="read-only" />, wide: true },
    ],
  },
  {
    id: "FilterBar",
    family: "domain",
    name: "FilterBar",
    when: "Above a queue: saved views, the active filters as removable chips, and the count with its noun.",
    states: [
      { name: "Default", Demo: () => <FilterBarDemo variant="default" />, wide: true },
      {
        name: "Loading the count",
        note: "The count's space is reserved, so the bar does not jump when it arrives.",
        Demo: () => <FilterBarDemo variant="loading" />,
        wide: true,
      },
      { name: "Read-only", Demo: () => <FilterBarDemo variant="read-only" />, wide: true },
    ],
  },
  {
    id: "LineChart",
    family: "domain",
    name: "LineChart",
    when: "A position over time. The labels sit at the ends of the lines instead of in a legend.",
    states: [
      {
        name: "Default",
        Demo: () => (
          <LineChart
            question="Is collections recovery improving?"
            headingLevel={4}
            caption={RECOVERY_CAPTION}
            series={RECOVERY_SERIES}
            annotations={INTERVENTION}
            formatValue={(value) => `$${value}k`}
          />
        ),
        wide: true,
      },
      {
        name: "Loading",
        Demo: () => <LineChart question="Is collections recovery improving?" headingLevel={4} series={[]} loading />,
        wide: true,
      },
      {
        name: "Error",
        Demo: () => (
          <LineChart
            question="Is collections recovery improving?"
            headingLevel={4}
            series={[]}
            error="We could not reach the metrics store. Reference 8f2a41."
          />
        ),
        wide: true,
      },
      {
        name: "Empty",
        Demo: () => (
          <LineChart
            question="Is collections recovery improving?"
            headingLevel={4}
            series={[]}
            empty="No months have closed yet."
          />
        ),
        wide: true,
      },
    ],
  },
  {
    id: "MetricTile",
    family: "domain",
    name: "MetricTile",
    when: "One number with its comparison and its denominator. A tile without a comparison is not shipped.",
    states: [
      {
        name: "Default",
        Demo: () => (
          <MetricTile
            label="First-pass resolution"
            headingLevel={4}
            value="94.2%"
            denominator="of 1,240 cases"
            comparison={{ basis: "vs. prior 30 days", changePercent: 4.2 }}
            history={[88, 89, 91, 90, 92, 93, 94]}
            historyLabel="Weekly, last 7 weeks"
          />
        ),
      },
      {
        name: "Down is good",
        note: "Cost and handle time improve by falling. The arrow says which way is good.",
        Demo: () => (
          <MetricTile
            label="Cost per resolved case"
            headingLevel={4}
            value="$1.42"
            denominator="across 1,240 cases"
            comparison={{
              basis: "vs. prior 30 days",
              changePercent: -11.4,
              direction: "down-is-good",
              priorValue: "$1.60",
            }}
            history={[1.9, 1.82, 1.7, 1.66, 1.55, 1.48, 1.42]}
          />
        ),
      },
      {
        // Each tile is a region named by its label, so the specimens carry
        // different measures rather than four tiles a screen reader cannot
        // tell apart.
        name: "Loading",
        Demo: () => (
          <MetricTile
            label="Approvals decided today"
            headingLevel={4}
            value="—"
            comparison={{ basis: "vs. the same day last week", changePercent: 0 }}
            loading
          />
        ),
      },
      {
        name: "Error",
        Demo: () => (
          <MetricTile
            label="Median time to decide"
            headingLevel={4}
            value="—"
            comparison={{ basis: "vs. prior 30 days", changePercent: 0 }}
            error="We could not reach the metrics store. Reference 8f2a41."
          />
        ),
      },
      {
        name: "Read-only",
        Demo: () => (
          <MetricTile
            label="Cases closed this month"
            headingLevel={4}
            value="1,180"
            denominator="of 1,240 opened"
            comparison={{ basis: "vs. prior month", changePercent: 6.1 }}
            readOnly
          />
        ),
      },
    ],
  },
  {
    id: "ProvenanceMark",
    family: "domain",
    name: "ProvenanceMark",
    when: "Whether a fact was retrieved, asserted, or computed. The distinction appears everywhere a citation does.",
    states: [
      ...PROVENANCE_KINDS.map((kind) => ({
        name: kind.charAt(0).toUpperCase() + kind.slice(1),
        note: PROVENANCE_MEANINGS[kind],
        Demo: () => <ProvenanceMark kind={kind} />,
      })),
      {
        name: "With its meaning",
        Demo: () => <ProvenanceMark kind="computed" describe />,
        wide: true,
      },
    ],
  },
  {
    id: "Sparkline",
    family: "domain",
    name: "Sparkline",
    when: "The shape behind a metric. It never carries a number of its own — the tile does that.",
    states: [
      {
        name: "Default",
        Demo: () => (
          <Sparkline values={[88, 89, 91, 90, 92, 93, 94]} label="First-pass rate, last 7 weeks" formatValue={(value) => `${value}%`} />
        ),
      },
      {
        name: "Falling",
        Demo: () => <Sparkline values={[1.9, 1.82, 1.7, 1.66, 1.55, 1.48, 1.42]} label="Cost per case, last 7 weeks" />,
      },
      {
        name: "Not enough history",
        Demo: () => <Sparkline values={[]} label="First-pass rate" emptyLabel="Not enough history yet" />,
      },
    ],
  },
  {
    id: "StackedBarChart",
    family: "domain",
    name: "StackedBarChart",
    when: "Composition within a total. The table behind it carries the per-category total, because the reader is owed it.",
    states: [
      {
        name: "Default",
        Demo: () => (
          <StackedBarChart
            question="What happened to each month's caseload?"
            headingLevel={4}
            caption={RECOVERY_CAPTION}
            series={RECOVERY_SERIES}
            formatValue={(value) => `$${value}k`}
          />
        ),
        wide: true,
      },
      {
        name: "Loading",
        Demo: () => <StackedBarChart question="What happened to each month's caseload?" headingLevel={4} series={[]} loading />,
        wide: true,
      },
      {
        name: "Error",
        Demo: () => (
          <StackedBarChart
            question="What happened to each month's caseload?"
            headingLevel={4}
            series={[]}
            error="We could not reach the metrics store. Reference 8f2a41."
          />
        ),
        wide: true,
      },
      {
        name: "Empty",
        Demo: () => (
          <StackedBarChart
            question="What happened to each month's caseload?"
            headingLevel={4}
            series={[]}
            empty="No months have closed yet."
          />
        ),
        wide: true,
      },
    ],
  },
  {
    id: "Timeline",
    family: "domain",
    name: "Timeline",
    when: "The spine of a run: one row per step, with what, when, how long, what it cost, and what it cited.",
    states: [
      {
        name: "Default",
        note: "Retrieval, model, human, failed action, and parked, in one trail.",
        Demo: () => <TimelineDemo variant="default" />,
        wide: true,
      },
      { name: "Loading", Demo: () => <TimelineDemo variant="loading" />, wide: true },
      { name: "Error", Demo: () => <TimelineDemo variant="error" />, wide: true },
      { name: "Empty", Demo: () => <TimelineDemo variant="empty" />, wide: true },
      {
        name: "Read-only",
        note: "“Correct this” goes; everything else stays.",
        Demo: () => <TimelineDemo variant="read-only" />,
        wide: true,
      },
    ],
  },
  {
    id: "Toast",
    family: "domain",
    name: "Toast and ToastRegion",
    when: "A receipt for something that already happened, with the way to undo it and the way to the permanent record.",
    states: [
      { name: "Success", Demo: () => <ToastSpecimen variant="success" />, wide: true },
      {
        name: "With undo",
        note: "In the shell it shortens itself to the undo window, so the offer never outlives the chance.",
        Demo: () => <ToastSpecimen variant="undo" />,
        wide: true,
      },
      {
        name: "Failure",
        note: "Stays up until it is acknowledged. A failure the operator missed is a failure they will meet later.",
        Demo: () => <ToastSpecimen variant="failure" />,
        wide: true,
      },
      {
        name: "Live, in its region",
        note: "Docked bottom-end over the shell. Press the button to raise one.",
        Demo: ToastLiveDemo,
      },
    ],
  },
  {
    id: "marks",
    family: "domain",
    name: "Domain marks",
    when: "The product's own glyph set: step kinds, provenance, trend, and edit. Every one sits beside a word.",
    states: [
      { name: "Step kinds", Demo: () => <MarkSetDemo variant="steps" />, wide: true },
      { name: "Provenance", Demo: () => <MarkSetDemo variant="provenance" />, wide: true },
      { name: "Trend", Demo: () => <MarkSetDemo variant="trend" />, wide: true },
      { name: "Edit and filter", Demo: () => <MarkSetDemo variant="edit" />, wide: true },
    ],
  },
];

const PALETTE_ENTRIES: readonly GalleryEntry[] = [
  {
    id: "CommandPalette",
    family: "palette",
    name: "CommandPalette",
    when: "Primary movement. Actions, records and saved views in one list, each showing its shortcut.",
    states: [
      {
        name: "Default",
        note: "Opens with its own demo registry, so nothing here can fire a real verb.",
        Demo: () => <PaletteDemo variant="default" />,
      },
      { name: "Loading records", Demo: () => <PaletteDemo variant="loading" /> },
      { name: "Error", Demo: () => <PaletteDemo variant="error" /> },
      {
        name: "Read-only",
        note: "An auditor session: mutating commands arrive already refused, with the reason.",
        Demo: () => <PaletteDemo variant="read-only" />,
      },
    ],
  },
  {
    id: "ShortcutReference",
    family: "palette",
    name: "ShortcutReference",
    when: "The `?` sheet, generated from the same table the dispatcher matches against. It says which verbs are inert right now.",
    states: [
      {
        name: "Default",
        note: "Nothing is bound in the demo registry, so every verb correctly reads as unavailable.",
        Demo: ShortcutReferenceDemo,
      },
    ],
  },
];

export const GALLERY_ENTRIES: readonly GalleryEntry[] = [
  ...PRIMITIVE_ENTRIES,
  ...SURFACE_ENTRIES,
  ...DOMAIN_ENTRIES,
  ...PALETTE_ENTRIES,
];

// Two small demos that read better as components than as inline expressions.

function UnassignedRow() {
  return (
    <span className="pv-gallery-inline">
      <UnassignedAvatar decorative />
      Unassigned
    </span>
  );
}

function UnavailableButton() {
  const reasonId = useId();
  return (
    <span className="pv-gallery-stack">
      <Button variant="primary" unavailable describedBy={reasonId}>
        Approve
      </Button>
      <span className="pv-gallery-caption" id={reasonId}>
        A supervisor approves anything over $25,000.
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function toThemePreference(value: string): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

function toDensity(value: string): Density {
  return value === "compact" ? "compact" : "comfortable";
}

function toTransparency(value: string): TransparencyPreference {
  return value === "reduced" ? "reduced" : "system";
}

function DisplayControls() {
  const {
    theme,
    themePreference,
    setThemePreference,
    density,
    setDensity,
    transparency,
    setTransparency,
    reducedTransparency,
  } = useTheme();

  return (
    <div className="pv-gallery-controls">
      <RadioGroup
        label="Theme"
        orientation="horizontal"
        value={themePreference}
        onChange={(value) => setThemePreference(toThemePreference(value))}
      >
        <Radio value="system" label="System" />
        <Radio value="light" label="Light" />
        <Radio value="dark" label="Dark" />
      </RadioGroup>

      <RadioGroup
        label="Density"
        orientation="horizontal"
        value={density}
        onChange={(value) => setDensity(toDensity(value))}
      >
        <Radio value="comfortable" label="Comfortable" />
        <Radio value="compact" label="Compact" />
      </RadioGroup>

      <RadioGroup
        label="Transparency"
        orientation="horizontal"
        value={transparency}
        onChange={(value) => setTransparency(toTransparency(value))}
      >
        <Radio value="system" label="Follow the system" />
        <Radio value="reduced" label="Reduced" />
      </RadioGroup>

      {/* The resolved answer, not the stored preference. "System" tells a
          reviewer nothing about what they are looking at, and what they are
          looking at is the thing under review. */}
      <p className="pv-gallery-resolved">
        Showing the <strong>{theme}</strong> theme at <strong>{density}</strong> density, with glass{" "}
        <strong>{reducedTransparency ? "off" : "on"}</strong>.
      </p>
    </div>
  );
}

function GalleryContents() {
  return (
    <nav className="pv-gallery-contents" aria-label="Components">
      {GALLERY_FAMILIES.map((family) => (
        <div className="pv-gallery-contents-group" key={family.id}>
          <p className="pv-gallery-contents-label">{family.label}</p>
          <ul className="pv-gallery-contents-list">
            {GALLERY_ENTRIES.filter((entry) => entry.family === family.id).map((entry) => (
              <li key={entry.id}>
                <a href={`#component-${entry.id}`}>{entry.name}</a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function GalleryStateCell({ state }: { readonly state: GalleryState }) {
  const { Demo } = state;
  return (
    <li className="pv-gallery-state" data-wide={state.wide === true ? "true" : undefined}>
      <div className="pv-gallery-stage">
        <Demo />
      </div>
      <p className="pv-gallery-state-name">{state.name}</p>
      {state.note !== undefined && <p className="pv-gallery-state-note">{state.note}</p>}
    </li>
  );
}

function GalleryEntrySection({ entry }: { readonly entry: GalleryEntry }) {
  return (
    <section className="pv-gallery-entry" id={`component-${entry.id}`}>
      <div className="pv-gallery-entry-header">
        <h3 className="pv-gallery-entry-name">{entry.name}</h3>
        <code className="pv-gallery-entry-file">
          ui/{entry.family}/{entry.id}.tsx
        </code>
      </div>
      <p className="pv-gallery-entry-when">{entry.when}</p>
      <ul className="pv-gallery-states">
        {entry.states.map((state) => (
          <GalleryStateCell key={state.name} state={state} />
        ))}
      </ul>
    </section>
  );
}

export function DesignGallery() {
  const componentCount = GALLERY_ENTRIES.length;
  const stateCount = GALLERY_ENTRIES.reduce((total, entry) => total + entry.states.length, 0);

  return (
    <div className="pv-gallery">
      <header className="pv-gallery-head">
        {/* The same words the rail and the breadcrumb use for this surface. A
            page whose title does not match the link that reached it makes an
            operator wonder whether they arrived somewhere else. */}
        <h1>Design system gallery</h1>
        <p className="pv-gallery-lede">
          Every component in the library, in every state it has, in both themes and with
          transparency on and off. This is the surface a design review is held against and the one a
          regression shows up on first.
        </p>
        <p className="pv-gallery-count">
          <span className="pv-numeric">{componentCount}</span> components ·{" "}
          <span className="pv-numeric">{stateCount}</span> states · four families
        </p>
      </header>

      <section className="pv-gallery-display" aria-labelledby="gallery-display">
        <h2 id="gallery-display" className="pv-sr-only">
          Display preferences
        </h2>
        <DisplayControls />
      </section>

      <Callout title="Hover, focus and press are live here, not pictured.">
        <p>
          Those three states belong to a real element under a real pointer, and drawing an imitation
          of them is exactly what a regression check must not contain — the imitation would keep
          looking right after the real one broke. Tab through this page to see the focus ring, and
          hold the pointer on anything that reacts.
        </p>
        <p>
          Every specimen is the real component and behaves like one: it opens, closes, sorts,
          expands, and decides. The controls that hand work to a screen the gallery does not have —
          “Correct this”, “Export as CSV”, “Change the rule” — are drawn and do nothing, because
          there is nothing here to correct or export.
        </p>
      </Callout>

      <GalleryContents />

      {GALLERY_FAMILIES.map((family) => {
        const entries = GALLERY_ENTRIES.filter((entry) => entry.family === family.id);
        return (
          <section
            className="pv-gallery-family"
            key={family.id}
            aria-labelledby={`family-${family.id}`}
          >
            <h2 id={`family-${family.id}`}>{family.label}</h2>
            <p className="pv-gallery-family-blurb">{family.blurb}</p>
            {entries.map((entry) => (
              <GalleryEntrySection entry={entry} key={entry.id} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
