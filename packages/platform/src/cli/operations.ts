import { InvalidInputError } from "../kernel/errors.js";
import type { AuditEntry } from "../audit/types.js";
import type { ApprovalRequest, ApprovalStatus } from "../guard/types.js";
import type { RunCostRollup } from "../record/types.js";
import type { PendingTimer } from "../engine/types.js";
import type { Platform } from "../platform.js";

/**
 * The four verbs the runbooks page an operator into running.
 *
 * Each one existed as an instruction in `docs/ops/runbooks.md` and nowhere
 * else. `... cost report`, `... approvals list`, `... models degradation` and
 * `... engine timers` were all written against an intended operator surface
 * rather than the built one, so four alerts — including the SEV1 for a
 * possibly-missed statutory deadline — sent a woken responder to a command
 * that answered "Unknown command". A runbook step that errors is worse than a
 * missing one: it costs the responder the time to discover it is wrong, at the
 * moment they have none, and it teaches them the runbooks are fiction.
 *
 * They live here rather than in `main.ts` for the reason `agents` and
 * `evaluate` do: the commands an operator reaches for during an incident
 * should not pay to load the reporting code, and this module should not be
 * loaded at all by a process that only serves requests.
 *
 * The house rules apply, and each closes a way a report lies:
 *
 * **Diagnostics to stderr, the answer to stdout**, so `pv cost report --json |
 * jq` composes and a report redirected into an incident record contains the
 * report and nothing else.
 *
 * **A zero is qualified.** Every one of these can return nothing, and "nothing
 * is wrong" and "nothing was recorded" are different answers that look
 * identical in an empty table. Each verb says which one it is giving.
 *
 * **The window is stated, always.** A spend figure without its window is not a
 * figure, and the window these report is the one the ceiling counts —
 * `recordedAt`, not when the run started — so the report and the meter that
 * raised the alert cannot disagree.
 *
 * **Exit codes mean something.** Zero means the thing was answered and the
 * condition it checks for is absent. Non-zero means the condition is present,
 * so each of these is wireable to a scheduler rather than only readable by a
 * person.
 */

export const OPERATIONS_USAGE = `
pv cost | approvals | models | engine — the operator reports the runbooks call for

  cost report [--since <iso> | --hours <n>] [--group-by <keys>] [--top <n>]
              Spend inside a window, per workflow, role, mode, or category, and
              the runs that spent it. --group-by takes a comma-separated list of
              workflow, role, mode, category. Default: workflow,role.
              Exits 1 when the default 24-hour window is at or above the daily
              ceiling, because work is being refused right now.

  approvals list [--status <a,b>] [--action <name>] [--ageing]
                 [--within <minutes>] [--limit <n>]
              Parked human decisions. --ageing keeps the ones inside --within
              of expiry (default 240 minutes) or already past it.
              Exits 1 when a pending approval has passed its expiry, which also
              means nothing is sweeping — see "pv worker".

  models degradation [--since <iso> | --hours <n>] [--limit <n>]
              Fallback-chain walks in a window, by task, hop, and cause.
              Exits 1 when a call exhausted every fallback and was refused.

  engine timers [--overdue] [--late-by <seconds>] [--within <hours>] [--limit <n>]
              Timers waiting to fire, soonest first, with the case each belongs
              to. --overdue keeps only those more than --late-by seconds past
              due (default 60, the STATUTORY-TIMER-LATE threshold).
              Exits 1 when --overdue finds one.

Global:
  --json      Machine-readable output
`.trim();

// ---------------------------------------------------------------------------
// Arguments and output
// ---------------------------------------------------------------------------

/** The shape `parseArgs` in main.ts produces. Structural, so it stays in step. */
export interface CommandArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string[]>>;
  readonly json: boolean;
}

export interface OperationsContext {
  readonly platform: Platform;
}

/** stderr, so stdout stays a clean artifact. */
function note(message: string): void {
  console.error(message);
}

function emit(value: unknown, args: CommandArgs): void {
  if (args.json) console.log(JSON.stringify(value, null, 2));
  else console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function first(args: CommandArgs, name: string): string | undefined {
  const value = args.flags[name]?.[0];
  // A flag given with no value parses as the string "true". Treated as absent,
  // so `--since` with nothing after it is a usage error rather than a window
  // starting at the literal word "true".
  return value === undefined || value === "true" ? undefined : value;
}

function flagPresent(args: CommandArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}

function number(args: CommandArgs, name: string, fallback: number): number {
  const raw = first(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidInputError(`--${name} must be a non-negative number, received "${raw}"`, name);
  }
  return value;
}

function csv(args: CommandArgs, name: string): readonly string[] | undefined {
  const raw = first(args, name);
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Money for a terminal. Sub-dollar amounts keep four places; see console format.ts. */
function usd(amount: number): string {
  const digits = amount !== 0 && Math.abs(amount) < 1 ? 4 : 2;
  return `$${amount.toFixed(digits)}`;
}

/** "3h 04m late", "in 12m". Written for somebody reading it at three in the morning. */
function duration(ms: number): string {
  const total = Math.abs(Math.round(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  if (days === 0 && (hours > 0 || minutes > 0)) parts.push(`${minutes}m`);
  if (days === 0 && hours === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * The start of the window a report covers.
 *
 * `--since` wins when given; otherwise `--hours` back from the platform's
 * clock. The clock is the platform's rather than the process's, so a report
 * taken twice from a fixed clock is identical and this file stays inside the
 * rule that only `kernel/clock.ts` reads the wall clock.
 */
function windowStart(
  args: CommandArgs,
  platform: Platform,
  defaultHours: number,
): { since: string; hours: number; explicit: boolean } {
  const explicitSince = first(args, "since");
  const hours = number(args, "hours", defaultHours);
  if (explicitSince !== undefined) {
    if (Number.isNaN(Date.parse(explicitSince))) {
      throw new InvalidInputError(
        `--since must be an instant, e.g. 2026-08-07T00:00:00.000Z; received "${explicitSince}"`,
        "since",
      );
    }
    const parsed = new Date(Date.parse(explicitSince)).toISOString();
    return {
      since: parsed,
      hours: (platform.clock.now() - Date.parse(parsed)) / 3_600_000,
      explicit: true,
    };
  }
  return {
    since: new Date(platform.clock.now() - hours * 3_600_000).toISOString(),
    hours,
    explicit: flagPresent(args, "hours"),
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function commandOperations(
  args: CommandArgs,
  context: OperationsContext,
): Promise<number> {
  try {
    return await dispatch(args, context);
  } catch (error) {
    // A malformed command is a usage error, not a crash. `DeniedError` is
    // deliberately not caught: a refusal is an outcome the operator has to see
    // with its reason code, and it propagates to main.ts's handler.
    if (error instanceof InvalidInputError) {
      note(`${error.message}${error.field ? ` (${error.field})` : ""}`);
      return 2;
    }
    throw error;
  }
}

async function dispatch(args: CommandArgs, context: OperationsContext): Promise<number> {
  const command = args.positional[0];
  const sub = args.positional[1];

  if (command === "cost" && sub === "report") return await costReport(args, context);
  if (command === "approvals" && sub === "list") return await approvalsList(args, context);
  if (command === "models" && sub === "degradation") return await modelsDegradation(args, context);
  if (command === "engine" && sub === "timers") return await engineTimers(args, context);

  note(`Unknown ${command ?? "operations"} subcommand: ${sub ?? "(none)"}\n`);
  note(OPERATIONS_USAGE);
  return 2;
}

// ---------------------------------------------------------------------------
// cost report — SPEND-CEILING-APPROACHING
// ---------------------------------------------------------------------------

const COST_GROUPS: Readonly<Record<string, (row: RunCostRollup) => string>> = {
  workflow: (row) => row.kind,
  role: (row) => (row.roleId ? `${row.roleId}${row.roleVersion ? ` v${row.roleVersion}` : ""}` : "(no role)"),
  mode: (row) => row.mode,
  category: () => "", // handled separately: one run spans several categories
};

interface CostGroupLine {
  readonly key: string;
  readonly totalUsd: number;
  readonly runs: number;
  readonly entries: number;
}

function groupCost(rows: readonly RunCostRollup[], by: string): readonly CostGroupLine[] {
  const totals = new Map<string, { totalUsd: number; runs: number; entries: number }>();

  if (by === "category") {
    for (const row of rows) {
      for (const [category, amount] of Object.entries(row.byCategory)) {
        const held = totals.get(category) ?? { totalUsd: 0, runs: 0, entries: 0 };
        // Runs are counted once per category they touch, so these do not sum
        // to the run count — stated in the header rather than left to surprise
        // somebody adding the column up.
        totals.set(category, {
          totalUsd: held.totalUsd + amount,
          runs: held.runs + 1,
          entries: held.entries,
        });
      }
    }
  } else {
    const project = COST_GROUPS[by];
    if (!project) {
      throw new InvalidInputError(
        `"${by}" is not a grouping. Use one or more of: ${Object.keys(COST_GROUPS).sort().join(", ")}.`,
        "group-by",
      );
    }
    for (const row of rows) {
      const key = project(row);
      const held = totals.get(key) ?? { totalUsd: 0, runs: 0, entries: 0 };
      totals.set(key, {
        totalUsd: held.totalUsd + row.totalUsd,
        runs: held.runs + 1,
        entries: held.entries + row.entries,
      });
    }
  }

  return [...totals.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((left, right) => right.totalUsd - left.totalUsd || left.key.localeCompare(right.key));
}

async function costReport(args: CommandArgs, context: OperationsContext): Promise<number> {
  const { platform } = context;
  const window = windowStart(args, platform, 24);
  const groups = csv(args, "group-by") ?? ["workflow", "role"];
  const top = Math.max(1, Math.round(number(args, "top", 10)));

  const rows = await platform.runs.costRollupSince(window.since);
  // The headline is the meter's own figure rather than a sum of the rows
  // below, because the meter is what refused the work. If the two could
  // disagree an operator would be raising a ceiling against a number the
  // ceiling does not use; the store contract pins them together.
  const totalUsd = await platform.runs.costSince(window.since);
  const ceilingUsd = platform.config.dailySpendCeilingUsd;

  const grouped = Object.fromEntries(groups.map((by) => [by, groupCost(rows, by)]));
  const entries = rows.reduce((sum, row) => sum + row.entries, 0);
  const mostExpensive = rows[0];
  const topShare = mostExpensive && totalUsd > 0 ? mostExpensive.totalUsd / totalUsd : 0;

  // Only meaningful against the ceiling's own window. A four-hour report
  // compared to a daily ceiling would read as reassuring when it is not.
  const isDailyWindow = !window.explicit && Math.abs(window.hours - 24) < 0.001;
  const atCeiling = isDailyWindow && ceilingUsd > 0 && totalUsd >= ceilingUsd;

  if (args.json) {
    emit(
      {
        since: window.since,
        until: platform.clock.nowIso(),
        windowHours: Number(window.hours.toFixed(4)),
        totalUsd,
        dailyCeilingUsd: ceilingUsd,
        comparableToDailyCeiling: isDailyWindow,
        atOrOverCeiling: atCeiling,
        runs: rows.length,
        entries,
        largestRunShare: Number(topShare.toFixed(4)),
        grouped,
        runsByCost: rows.slice(0, top),
      },
      args,
    );
    return atCeiling ? 1 : 0;
  }

  console.log(`window            ${window.since} → ${platform.clock.nowIso()}`);
  console.log(
    `recorded spend    ${usd(totalUsd)} across ${rows.length} run(s), ${entries} entr${entries === 1 ? "y" : "ies"}`,
  );
  console.log(
    `daily ceiling     ${usd(ceilingUsd)}${
      isDailyWindow
        ? ceilingUsd > 0
          ? `  (${Math.round((totalUsd / ceilingUsd) * 100)}% of it, same window)`
          : "  (no ceiling configured)"
        : "  (a different window from this report — not comparable)"
    }`,
  );

  if (rows.length === 0) {
    // The distinction the whole report turns on. An empty table during a spend
    // alert means the window is wrong, not that the money was imagined.
    console.log("");
    console.log(
      "No spend was recorded in this window. That is not the same as no spend: check the window before concluding the alert was wrong.",
    );
    return 0;
  }

  console.log("");
  console.log(
    `largest run       ${usd(mostExpensive?.totalUsd ?? 0)} — ${Math.round(topShare * 100)}% of the window, run ${mostExpensive?.runId ?? "?"}`,
  );
  note(
    "One run holding most of the window is the signature of a loop; spend spread across many runs is volume. The runbook asks you to know which before raising anything.",
  );

  for (const by of groups) {
    console.log("");
    console.log(`BY ${by.toUpperCase()}`);
    if (by === "category") {
      note("A run spends in several categories, so the run column below counts each run once per category.");
    }
    for (const line of grouped[by] ?? []) {
      console.log(`  ${line.key.padEnd(38)} ${usd(line.totalUsd).padStart(12)}  ${line.runs} run(s)`);
    }
  }

  console.log("");
  console.log(`MOST EXPENSIVE RUNS (top ${Math.min(top, rows.length)})`);
  for (const row of rows.slice(0, top)) {
    console.log(
      `  ${row.runId.padEnd(27)} ${row.kind.padEnd(26)} ${usd(row.totalUsd).padStart(12)}  ${String(row.entries).padStart(5)} entries  ${row.status.padEnd(10)} ${row.mode}`,
    );
  }

  if (atCeiling) {
    note(
      `Recorded spend has reached the daily ceiling of ${usd(ceilingUsd)}. Work is being refused now. Establish whether this is a loop or volume before raising it — the ceiling is the only thing bounding a runaway.`,
    );
  }
  return atCeiling ? 1 : 0;
}

// ---------------------------------------------------------------------------
// approvals list — APPROVAL-QUEUE-AGEING
// ---------------------------------------------------------------------------

const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "pending",
  "granted",
  "rejected",
  "expired",
  "consumed",
];

interface ApprovalLine {
  readonly approvalId: string;
  readonly action: string;
  readonly status: ApprovalStatus;
  readonly summary: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  /** Negative once expiry has passed. */
  readonly expiresInMs: number;
  readonly expired: boolean;
  readonly grantsSoFar: number;
  readonly approvalsRequired: number;
  readonly eligibleRoles: readonly string[];
  readonly runId?: string | undefined;
  readonly subject: Readonly<Record<string, string>>;
}

function approvalLine(request: ApprovalRequest, nowMs: number): ApprovalLine {
  const expiresAtMs = Date.parse(request.expiresAt);
  return {
    approvalId: request.id,
    action: request.action,
    status: request.status,
    summary: request.summary,
    requestedBy: request.requestedBy.actorId,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    expiresInMs: expiresAtMs - nowMs,
    expired: expiresAtMs <= nowMs,
    // Only grants count toward the N of N-of-M. A rejection ends the request
    // rather than contributing to it, so counting decisions would tell an
    // operator a refused approval was nearly through.
    grantsSoFar: request.decisions.filter((decision) => decision.decision === "granted").length,
    approvalsRequired: request.approvalsRequired,
    eligibleRoles: request.eligibleRoles,
    runId: request.runId,
    subject: request.subject,
  };
}

async function approvalsList(args: CommandArgs, context: OperationsContext): Promise<number> {
  const { platform } = context;
  const requested = csv(args, "status") ?? ["pending"];
  for (const status of requested) {
    if (!APPROVAL_STATUSES.includes(status as ApprovalStatus)) {
      throw new InvalidInputError(
        `"${status}" is not an approval status. Use one or more of: ${[...APPROVAL_STATUSES].sort().join(", ")}.`,
        "status",
      );
    }
  }

  const ageing = flagPresent(args, "ageing");
  const withinMinutes = number(args, "within", 240);
  const limit = Math.max(1, Math.round(number(args, "limit", 100)));
  const action = first(args, "action");
  const nowIso = platform.clock.nowIso();
  const nowMs = platform.clock.now();

  const requests = await platform.approvals.list({
    status: requested as readonly ApprovalStatus[],
    ...(action !== undefined ? { action } : {}),
    limit,
  });

  let lines = requests.map((request) => approvalLine(request, nowMs));
  if (ageing) {
    lines = lines.filter((line) => line.expiresInMs <= withinMinutes * 60_000);
  }
  // Least time left first: the queue is read top-down by somebody deciding who
  // to wake, and the row with an hour left matters more than the row with a day.
  lines = [...lines].sort((left, right) => left.expiresInMs - right.expiresInMs);

  // A pending approval past its expiry is two facts at once: that decision is
  // no longer usable, and nothing swept it — `approvals.expire` is a
  // maintenance pass, so an expired-but-pending row means no worker is running.
  const lapsed = lines.filter((line) => line.status === "pending" && line.expired);

  if (args.json) {
    emit(
      {
        asOf: nowIso,
        statuses: requested,
        ageing,
        withinMinutes: ageing ? withinMinutes : null,
        lapsedPending: lapsed.length,
        approvals: lines,
      },
      args,
    );
    return lapsed.length > 0 ? 1 : 0;
  }

  if (lines.length === 0) {
    console.log(
      ageing
        ? `No approval is within ${withinMinutes} minute(s) of expiry. Nothing is ageing.`
        : `No approval matches (status: ${requested.join(", ")}).`,
    );
    return 0;
  }

  console.log(
    `${"APPROVAL".padEnd(27)} ${"ACTION".padEnd(32)} ${"STATE".padEnd(9)} ${"GRANTS".padEnd(7)} ${"EXPIRES".padEnd(26)} ${"LEFT".padEnd(22)} ELIGIBLE ROLES`,
  );
  for (const line of lines) {
    const left = line.expired ? `EXPIRED ${duration(line.expiresInMs)} ago` : `in ${duration(line.expiresInMs)}`;
    console.log(
      `${line.approvalId.padEnd(27)} ${line.action.padEnd(32)} ${line.status.padEnd(9)} ${`${line.grantsSoFar}/${line.approvalsRequired}`.padEnd(7)} ${line.expiresAt.padEnd(26)} ${left.padEnd(22)} ${line.eligibleRoles.join(", ")}`,
    );
  }
  note(`${lines.length} approval(s).`);
  note(
    "N-of-M needs N distinct eligible people to exist. If nobody eligible is available that is a staffing gap, not something to work around: there is no bypass.",
  );

  if (lapsed.length > 0) {
    note(
      `${lapsed.length} approval(s) are still pending past their expiry. Expiry is a maintenance pass, so this also means nothing is sweeping — check that "pv worker" is running.`,
    );
  }
  return lapsed.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// models degradation — MODEL-PROVIDER-DEGRADED
// ---------------------------------------------------------------------------

function decisionString(entry: AuditEntry, key: string): string {
  const value = entry.decision?.[key];
  return value === undefined ? "(unrecorded)" : String(value);
}

function tally(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function ranked(counts: Map<string, number>): readonly { readonly key: string; readonly count: number }[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

async function modelsDegradation(args: CommandArgs, context: OperationsContext): Promise<number> {
  const { platform } = context;
  const window = windowStart(args, platform, 24);
  const limit = Math.max(1, Math.round(number(args, "limit", 2000)));

  // The audit chain rather than the invocation store, deliberately: the alert
  // this answers fires on `model.degraded`, so the check an operator runs has
  // to read the same record the alert was raised from. Anything else could say
  // "nothing here" about an alert that was correct.
  const calls = await platform.audit.count({
    eventType: ["model.invoked"],
    recordedAfter: window.since,
  });
  const degradations = await platform.audit.count({
    eventType: ["model.degraded"],
    recordedAfter: window.since,
  });

  const degraded = await platform.audit.list({
    eventType: ["model.degraded"],
    recordedAfter: window.since,
    limit,
  });
  const invoked = await platform.audit.list({
    eventType: ["model.invoked"],
    recordedAfter: window.since,
    limit,
  });

  const byTask = new Map<string, number>();
  const byHop = new Map<string, number>();
  const byReason = new Map<string, number>();
  for (const entry of degraded) {
    tally(byTask, decisionString(entry, "task"));
    tally(byHop, `${decisionString(entry, "fromModelId")} → ${decisionString(entry, "toModelId")}`);
    tally(byReason, decisionString(entry, "reason"));
  }

  const exhausted = invoked.filter((entry) => entry.decision?.["outcome"] === "failed");
  const byFailure = new Map<string, number>();
  for (const entry of exhausted) tally(byFailure, decisionString(entry, "failureKind"));

  // Stated rather than hidden. A histogram built from a truncated scan is a
  // histogram of whatever happened to be recent, and an operator who does not
  // know that will read a partial picture as the whole one.
  const truncated = degraded.length >= limit || invoked.length >= limit;

  if (args.json) {
    emit(
      {
        since: window.since,
        until: platform.clock.nowIso(),
        modelCalls: calls,
        degradations,
        degradationRate: calls > 0 ? Number((degradations / calls).toFixed(4)) : null,
        exhaustedCalls: exhausted.length,
        scanned: { degraded: degraded.length, invoked: invoked.length, limit, truncated },
        byTask: ranked(byTask),
        byHop: ranked(byHop),
        byReason: ranked(byReason),
        byFailureKind: ranked(byFailure),
      },
      args,
    );
    return exhausted.length > 0 ? 1 : 0;
  }

  console.log(`window            ${window.since} → ${platform.clock.nowIso()}`);
  console.log(`model calls       ${calls}`);
  console.log(
    `degradations      ${degradations}${calls > 0 ? `  (${Math.round((degradations / calls) * 100)}% of calls walked the chain)` : ""}`,
  );
  console.log(`exhausted         ${exhausted.length}  (every fallback failed; the call was refused)`);

  if (calls === 0) {
    // The false green this command most easily produces. A deployment with no
    // model gateway composed records no invocation, and a clean report from
    // one is not evidence that models are healthy.
    console.log("");
    console.log(
      "No model call was recorded in this window at all. A zero here is therefore not evidence that the models are healthy — it is evidence that nothing called one. Confirm the window, and that this deployment invokes models.",
    );
    return 0;
  }

  const sections: readonly { readonly title: string; readonly rows: readonly { key: string; count: number }[] }[] = [
    { title: "BY TASK", rows: ranked(byTask) },
    { title: "BY HOP", rows: ranked(byHop) },
    { title: "BY CAUSE", rows: ranked(byReason) },
    { title: "EXHAUSTED, BY FAILURE", rows: ranked(byFailure) },
  ];
  for (const section of sections) {
    if (section.rows.length === 0) continue;
    console.log("");
    console.log(section.title);
    for (const row of section.rows) {
      console.log(`  ${String(row.count).padStart(6)}  ${row.key}`);
    }
  }

  if (truncated) {
    note(
      `Scanned the most recent ${limit} entries of each type only; the histograms above are of that scan, not of the whole window. Raise --limit or narrow --since.`,
    );
  }
  if (exhausted.length > 0) {
    note(
      "A chain that ran out is a refusal, not a degradation: those calls were denied rather than answered from something worse. The runbook escalates that.",
    );
  }
  return exhausted.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// engine timers — STATUTORY-TIMER-LATE
// ---------------------------------------------------------------------------

function timerLine(timer: PendingTimer): string {
  const subject = Object.entries(timer.subject)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const when = timer.lateByMs >= 0 ? `${duration(timer.lateByMs)} LATE` : `in ${duration(timer.lateByMs)}`;
  return `  ${timer.firesAt}  ${when.padEnd(16)} ${timer.workflow.padEnd(24)} ${timer.step.padEnd(22)} ${timer.instanceId.padEnd(27)} ${subject}`;
}

async function engineTimers(args: CommandArgs, context: OperationsContext): Promise<number> {
  const { platform } = context;
  const overdue = flagPresent(args, "overdue");
  const lateBySeconds = number(args, "late-by", 60);
  const withinHours = number(args, "within", 24);
  const limit = Math.max(1, Math.round(number(args, "limit", 200)));
  const nowIso = platform.clock.nowIso();

  const through = overdue
    ? nowIso
    : new Date(platform.clock.now() + withinHours * 3_600_000).toISOString();

  let timers = await platform.engine.pendingTimers({ through, limit });
  if (overdue) timers = timers.filter((timer) => timer.lateByMs >= lateBySeconds * 1000);

  if (args.json) {
    emit(
      {
        asOf: nowIso,
        through,
        overdueOnly: overdue,
        lateBySeconds: overdue ? lateBySeconds : null,
        count: timers.length,
        timers,
      },
      args,
    );
    return overdue && timers.length > 0 ? 1 : 0;
  }

  if (timers.length === 0) {
    console.log(
      overdue
        ? `No timer is more than ${lateBySeconds}s past due as of ${nowIso}.`
        : `No timer is waiting to fire before ${through}.`,
    );
    // Said every time, because it is the difference between "nothing is late"
    // and "nothing is scheduled". Both print an empty table.
    note(
      "An empty list means no timer is waiting, which is different from no timer being able to fire. Timers advance only while `pv worker` is running.",
    );
    return 0;
  }

  console.log(
    `${"  FIRES AT".padEnd(28)} ${"WHEN".padEnd(16)} ${"WORKFLOW".padEnd(24)} ${"STEP".padEnd(22)} ${"CASE".padEnd(27)} SUBJECT`,
  );
  for (const timer of timers) console.log(timerLine(timer));
  note(`${timers.length} timer(s).`);

  if (overdue) {
    note(
      "Every one of these is a case whose clock has passed. Hand the subjects above to a human for manual handling now — a statutory deadline does not wait for the technical fix. If they span unrelated workflows, the scheduler is the cause: check that `pv worker` is running.",
    );
    return 1;
  }
  return 0;
}
