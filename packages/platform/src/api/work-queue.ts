import { InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { Platform } from "../platform.js";
import type { ActorRef, OperatingMode, Run, RunStatus } from "../record/types.js";
import { OPERATING_MODES } from "../record/types.js";

/**
 * The work queue — the console's default landing screen.
 *
 * The screen shows seven columns: status, what, owner, age, value, assignee,
 * next action. Four of those the operating record knows and three it does not,
 * and the shape of this file is entirely about keeping that line visible.
 *
 * **A figure the platform cannot source is absent, with a reason.** There is no
 * placeholder zero and no plausible-looking estimate. A supervisor who learns
 * that the value column is decorative stops reading it, and then stops reading
 * the columns beside it — so an honest gap costs one screen and a fabricated
 * number costs the whole table.
 *
 * **The SLA band is computed in the browser, from the target.** This layer
 * sends `slaStartedAt`, `dueAt`, and its own answer to "has it breached", and
 * never a colour. Sending a colour would put the 80%-of-target threshold in a
 * serialiser, where the design system cannot change it and where the two
 * densities could disagree.
 */

/** How long a kind of work has before it is late. */
export interface SlaTarget {
  readonly kind: string;
  readonly targetMs: number;
  /** Named on the screen so the number is attributable, not folklore. */
  readonly policy: string;
}

const HOURS = 60 * 60 * 1000;

/**
 * Service-level targets by run kind.
 *
 * Declared in source today, and that is a limitation rather than a design: the
 * definition of done for this screen says an operator can change what governs
 * it without an engineer, and a constant in a TypeScript file fails that test.
 * It is here rather than invented per-request so the number has one home when
 * it moves into configuration, and so a kind with no agreed target reports no
 * target at all instead of borrowing somebody else's.
 */
export const SLA_TARGETS: readonly SlaTarget[] = [
  {
    kind: "rescission.package_check",
    targetMs: 24 * HOURS,
    policy: "Rescission package check — one business day",
  },
  {
    kind: "rescission.clock_compute",
    targetMs: 12 * HOURS,
    policy: "Statutory clock recompute — twelve hours",
  },
  {
    kind: "rescission.verify",
    targetMs: 24 * HOURS,
    policy: "Rescission verification — one business day",
  },
  {
    kind: "owner_services.response_draft",
    targetMs: 4 * HOURS,
    policy: "Owner enquiry first response — four hours",
  },
  {
    kind: "association.board_pack",
    targetMs: 96 * HOURS,
    policy: "Association board pack — four days before the meeting",
  },
  {
    kind: "association.budget_variance",
    targetMs: 72 * HOURS,
    policy: "Budget variance narrative — three days",
  },
  {
    kind: "maintenance_fee.collection_review",
    targetMs: 48 * HOURS,
    policy: "Maintenance-fee collection review — two days",
  },
  {
    kind: "loan_file.evidence_pack",
    targetMs: 48 * HOURS,
    policy: "Delinquency evidence pack — two days",
  },
];

const SLA_BY_KIND = new Map(SLA_TARGETS.map((target) => [target.kind, target]));

/** The saved views the filter bar offers as pills. */
export const SAVED_VIEWS = ["all_open", "mine", "breaching", "high_value", "unassigned"] as const;
export type SavedView = (typeof SAVED_VIEWS)[number];

export const WORK_QUEUE_SORTS = [
  "age_desc",
  "age_asc",
  "due_soonest",
  "value_desc",
  "cost_desc",
  "status",
] as const;
export type WorkQueueSort = (typeof WORK_QUEUE_SORTS)[number];

const RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "awaiting_human",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "denied",
];

/** Statuses "open" means. Terminal work is not waiting for anybody. */
const OPEN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "awaiting_human",
  "awaiting_approval",
];

/** The floor for the "High value" saved view, in US dollars. */
export const HIGH_VALUE_FLOOR_USD = 1000;

export interface WorkQueueOwner {
  /** The opaque reference the operating record holds. Never personal data. */
  readonly accountRef: string;
  /** Absent until an owner system of record is connected. */
  readonly name?: string | undefined;
  readonly nameUnknown?: string | undefined;
}

export interface WorkQueueRow {
  readonly runId: string;
  readonly kind: string;
  readonly title: string;
  /** The second line under the title. Context, not a repeat of the title. */
  readonly subtitle?: string | undefined;
  readonly status: RunStatus;
  readonly mode: OperatingMode;
  readonly createdAt: string;
  /** When the SLA clock started. Distinct from `createdAt` once triage exists. */
  readonly slaStartedAt?: string | undefined;
  readonly dueAt?: string | undefined;
  readonly slaPolicy?: string | undefined;
  readonly slaTargetUnknown?: string | undefined;
  readonly slaBreached: boolean;
  readonly owner?: WorkQueueOwner | undefined;
  readonly ownerUnknown?: string | undefined;
  readonly valueUsd?: number | undefined;
  readonly valueUnknown?: string | undefined;
  readonly assignment: "assigned" | "unassigned" | "not_tracked";
  readonly assignee?: { readonly actorId: string; readonly displayName: string } | undefined;
  readonly assignedRole?: string | undefined;
  readonly nextAction: string;
  readonly nextActionApprovalId?: string | undefined;
  readonly costUsd: number;
  readonly waitingOn?: string | undefined;
}

export interface WorkQueueFilter {
  readonly status?: readonly RunStatus[] | undefined;
  readonly kind?: readonly string[] | undefined;
  readonly mode?: readonly OperatingMode[] | undefined;
  /** An actor id, or the literal `unassigned`. */
  readonly assignee?: string | undefined;
  readonly breaching?: boolean | undefined;
  readonly view?: SavedView | undefined;
  readonly sort: WorkQueueSort;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Parse the query string into a filter.
 *
 * Every filter the screen offers has to survive being pasted into a ticket, so
 * every one of them is a query parameter rather than browser state. Unknown
 * values are refused rather than ignored: a mistyped status that silently
 * widened the result set would answer a different question from the one the
 * URL says it asked, and the person reading the screen would have no way to
 * tell.
 */
export function parseWorkQueueQuery(
  query: Readonly<Record<string, string | string[] | undefined>>,
): WorkQueueFilter {
  const status = parseEnumList(query.status, RUN_STATUSES, "status");
  const mode = parseEnumList(query.mode, OPERATING_MODES, "mode");
  const kind = splitList(query.kind);
  const view = parseView(single(query.view));
  const sort = parseSort(single(query.sort));
  const assignee = single(query.assignee);
  const breaching = parseBoolean(single(query.breaching), "breaching");

  const rawLimit = Number(single(query.limit) ?? 50);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 200) : 50;
  const rawOffset = Number(single(query.offset) ?? 0);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;

  // A saved view is shorthand for a filter set, and the explicit parameters win
  // where they disagree — otherwise a link with `?view=breaching&breaching=false`
  // would show breaching items, which is not what it says.
  //
  // Every saved view means *open* work. "Unassigned" listing runs that finished
  // last month would be a queue of things nobody needs to pick up, and the pill
  // beside it would carry a count nobody can act on.
  const viewStatus = view === undefined ? undefined : OPEN_STATUSES;

  return {
    status: status ?? viewStatus,
    kind: kind && kind.length > 0 ? kind : undefined,
    mode,
    assignee: assignee ?? (view === "unassigned" ? "unassigned" : undefined),
    breaching: breaching ?? (view === "breaching" ? true : undefined),
    view,
    sort,
    limit,
    offset,
  };
}

/**
 * The window the store is asked for.
 *
 * `assignee`, `breaching`, and the high-value view are resolved here rather
 * than in SQL, because none of them is a column: assignment is not modelled on
 * a run, breach is a function of the clock and a target table, and value comes
 * from a system of record that is not connected. So a bounded window is read
 * and narrowed in this process, and the page says plainly whether its `total`
 * is the whole truth — see `WorkQueuePage.totalIsExact`.
 */
const POST_FILTER_WINDOW = 500;

export interface WorkQueuePage {
  readonly items: readonly WorkQueueRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /**
   * False when filters the store cannot apply were resolved over a bounded
   * window, so `total` counts what was examined rather than what exists.
   */
  readonly totalIsExact: boolean;
  readonly view?: SavedView | undefined;
  readonly sort: WorkQueueSort;
  /** The floor the "High value" view uses, so the console can name it. */
  readonly highValueFloorUsd: number;
}

export async function workQueuePage(
  platform: Platform,
  filter: WorkQueueFilter,
  viewer: ActorRef,
): Promise<WorkQueuePage> {
  const needsPostFilter =
    filter.breaching === true || filter.assignee !== undefined || filter.view === "high_value";

  const storeFilter = {
    ...(filter.status ? { status: filter.status } : {}),
    // The store filters on one kind; several are narrowed in this process.
    ...(filter.kind && filter.kind.length === 1 ? { kind: filter.kind[0] } : {}),
    ...(filter.mode && filter.mode.length === 1 ? { mode: filter.mode[0] } : {}),
    limit: needsPostFilter || (filter.kind?.length ?? 0) > 1 || (filter.mode?.length ?? 0) > 1
      ? POST_FILTER_WINDOW
      : filter.limit,
    offset:
      needsPostFilter || (filter.kind?.length ?? 0) > 1 || (filter.mode?.length ?? 0) > 1
        ? 0
        : filter.offset,
  };

  const [runs, storeTotal] = await Promise.all([
    platform.runs.listRuns(storeFilter),
    platform.runs.countRuns({ ...storeFilter, limit: undefined, offset: undefined }),
  ]);

  const now = platform.clock.nowIso();
  const rows: WorkQueueRow[] = [];
  for (const run of runs) {
    rows.push(await workQueueRow(platform, run, now));
  }

  let narrowed = rows;
  if (filter.kind && filter.kind.length > 1) {
    const kinds = new Set(filter.kind);
    narrowed = narrowed.filter((row) => kinds.has(row.kind));
  }
  if (filter.mode && filter.mode.length > 1) {
    const modes = new Set<string>(filter.mode);
    narrowed = narrowed.filter((row) => modes.has(row.mode));
  }
  if (filter.breaching === true) narrowed = narrowed.filter((row) => row.slaBreached);
  if (filter.breaching === false) narrowed = narrowed.filter((row) => !row.slaBreached);
  if (filter.assignee === "unassigned") {
    narrowed = narrowed.filter((row) => row.assignment !== "assigned");
  } else if (filter.assignee !== undefined) {
    narrowed = narrowed.filter((row) => row.assignee?.actorId === filter.assignee);
  }
  if (filter.view === "mine") {
    narrowed = narrowed.filter(
      (row) =>
        row.assignee?.actorId === viewer.actorId ||
        (row.assignedRole !== undefined && viewer.roles.includes(row.assignedRole)),
    );
  }
  if (filter.view === "high_value") {
    // Not "value is unknown, so show it anyway". An item whose value the
    // platform cannot read is not evidence that the value is high.
    narrowed = narrowed.filter(
      (row) => row.valueUsd !== undefined && row.valueUsd >= HIGH_VALUE_FLOOR_USD,
    );
  }

  const sorted = sortRows(narrowed, filter.sort);
  const postFiltered = sorted.length !== rows.length || storeFilter.limit === POST_FILTER_WINDOW;
  const items = postFiltered
    ? sorted.slice(filter.offset, filter.offset + filter.limit)
    : sorted.slice(0, filter.limit);

  return {
    items,
    total: postFiltered ? sorted.length : storeTotal,
    limit: filter.limit,
    offset: filter.offset,
    totalIsExact: !postFiltered || runs.length < POST_FILTER_WINDOW,
    view: filter.view,
    sort: filter.sort,
    highValueFloorUsd: HIGH_VALUE_FLOOR_USD,
  };
}

export async function workQueueRow(
  platform: Platform,
  run: Run,
  nowIso: string,
): Promise<WorkQueueRow> {
  const cost = await platform.runs.costForRun(run.id);
  const target = SLA_BY_KIND.get(run.kind);
  const slaStartedAt = run.startedAt ?? run.createdAt;
  const dueAt = target ? new Date(Date.parse(slaStartedAt) + target.targetMs).toISOString() : undefined;
  const terminal =
    run.status === "succeeded" ||
    run.status === "cancelled" ||
    run.status === "denied" ||
    run.status === "failed";
  // Work that has already ended cannot breach a deadline it met or missed in
  // the past; what matters for the queue is whether somebody is still waiting.
  const slaBreached = dueAt !== undefined && !terminal && nowIso > dueAt;

  const accountRef = subjectReference(run.subject);
  const next = nextAction(run);

  return {
    runId: run.id,
    kind: run.kind,
    title: describeRun(run.kind, run.subject),
    subtitle: subtitleFor(run),
    status: run.status,
    mode: run.mode,
    createdAt: run.createdAt,
    slaStartedAt,
    dueAt,
    slaPolicy: target?.policy,
    slaTargetUnknown: target
      ? undefined
      : `No service-level target is declared for "${run.kind}", so this item has no age band.`,
    slaBreached,
    owner: accountRef
      ? {
          accountRef,
          nameUnknown:
            "The operating record holds an opaque account reference, never an owner's name. Connect the owner system of record to show one here.",
        }
      : undefined,
    ownerUnknown: accountRef
      ? undefined
      : "This run carries no account reference, so there is no owner to show.",
    valueUnknown:
      "Case value comes from the contract and billing systems of record, which are not connected to this deployment.",
    // Assignment is not modelled on a run. Saying "not tracked" is a different
    // statement from "unassigned", and an operator acts differently on each.
    assignment: run.roleId ? "assigned" : "not_tracked",
    assignedRole: run.roleId,
    nextAction: next.text,
    nextActionApprovalId: next.approvalId,
    costUsd: cost.totalUsd,
    waitingOn: waitingOn(run),
  };
}

/** The next action, as a verb phrase. Derived from the record, never guessed. */
function nextAction(run: Run): { readonly text: string; readonly approvalId?: string } {
  switch (run.status) {
    case "awaiting_approval":
      return { text: "Approve or reject the parked action" };
    case "awaiting_human":
      return { text: "Complete the human task" };
    case "running":
      return { text: "Wait — the platform is working on it" };
    case "pending":
      return { text: "Start the run" };
    case "failed":
      return { text: "Review the failure and decide whether to retry" };
    case "denied":
      return { text: "Read the refusal and take it forward by hand" };
    case "cancelled":
      return { text: "Reopen it, or leave it closed" };
    case "succeeded":
      return { text: "Check the result and close the case" };
    default:
      return { text: "Review it" };
  }
}

function waitingOn(run: Run): string | undefined {
  if (run.status === "awaiting_approval") return "a human approval";
  if (run.status === "awaiting_human") return "a person to complete a task";
  if (run.status === "denied") return "nothing — the platform refused this and it will not proceed";
  return undefined;
}

/**
 * The second line under the title.
 *
 * Built from the run's own facts — mode, workflow, refusal — rather than from
 * the title with different words in it. A second line that restates the first
 * costs a row of vertical space and tells the reader nothing.
 */
function subtitleFor(run: Run): string | undefined {
  const parts: string[] = [];
  if (run.mode === "shadow") parts.push("Shadow — nothing this run proposes will land");
  if (run.denialReason) parts.push(run.denialReason);
  else if (run.outcome) parts.push(run.outcome);
  const jurisdiction = run.subject.state ?? run.subject.jurisdiction;
  if (jurisdiction) parts.push(jurisdiction);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** A readable title for a run, from its kind and opaque subject references. */
export function describeRun(kind: string, subject: Readonly<Record<string, string>>): string {
  const reference = subjectReference(subject);
  const readable = kind.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return reference ? `${readable} — ${reference}` : readable;
}

export function subjectReference(
  subject: Readonly<Record<string, string>>,
): string | undefined {
  return (
    subject.contractId ??
    subject.associationId ??
    subject.membershipId ??
    subject.loanId ??
    subject.ownerRef ??
    subject.id
  );
}

function sortRows(rows: readonly WorkQueueRow[], sort: WorkQueueSort): readonly WorkQueueRow[] {
  const copy = [...rows];
  switch (sort) {
    case "age_asc":
      return copy.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case "due_soonest":
      // Items with no target sort last rather than first. A run with no
      // deadline is not the most urgent thing on the screen.
      return copy.sort((a, b) => (a.dueAt ?? "￿").localeCompare(b.dueAt ?? "￿"));
    case "value_desc":
      return copy.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
    case "cost_desc":
      return copy.sort((a, b) => b.costUsd - a.costUsd);
    case "status":
      return copy.sort(
        (a, b) => RUN_STATUSES.indexOf(a.status) - RUN_STATUSES.indexOf(b.status),
      );
    case "age_desc":
    default:
      return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

// ---------------------------------------------------------------------------
// Query-string parsing
// ---------------------------------------------------------------------------

function single(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value as string;
}

function splitList(value: string | readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value as string];
  const parts = raw.flatMap((entry) => entry.split(",")).map((entry) => entry.trim());
  const kept = parts.filter((entry) => entry.length > 0);
  return kept.length > 0 ? kept : undefined;
}

function parseEnumList<T extends string>(
  value: string | readonly string[] | undefined,
  allowed: readonly T[],
  field: string,
): readonly T[] | undefined {
  const parts = splitList(value);
  if (!parts) return undefined;
  const unknown = parts.filter((entry) => !(allowed as readonly string[]).includes(entry));
  if (unknown.length > 0) {
    throw new InvalidInputError(
      `Unknown ${field} ${unknown.map((entry) => `"${entry}"`).join(", ")}. Allowed: ${allowed.join(", ")}.`,
      field,
    );
  }
  return parts as readonly T[];
}

function parseView(value: string | undefined): SavedView | undefined {
  if (value === undefined) return undefined;
  if (!(SAVED_VIEWS as readonly string[]).includes(value)) {
    throw new InvalidInputError(
      `Unknown saved view "${value}". Allowed: ${SAVED_VIEWS.join(", ")}.`,
      "view",
    );
  }
  return value as SavedView;
}

function parseSort(value: string | undefined): WorkQueueSort {
  if (value === undefined) return "age_desc";
  if (!(WORK_QUEUE_SORTS as readonly string[]).includes(value)) {
    throw new InvalidInputError(
      `Unknown sort "${value}". Allowed: ${WORK_QUEUE_SORTS.join(", ")}.`,
      "sort",
    );
  }
  return value as WorkQueueSort;
}

function parseBoolean(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InvalidInputError(`"${field}" must be true or false; received "${value}".`, field);
}

/** Narrow a string to a run id at the one place a route hands one over. */
export function asRunId(value: string): Id<"run"> {
  return value as Id<"run">;
}
