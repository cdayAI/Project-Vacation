import { InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, OperatingMode } from "../record/types.js";
import { OPERATING_MODES } from "../record/types.js";
import type { HumanTask, InstanceDescription, WorkflowContext } from "../engine/types.js";
import { RESCISSION_INTAKE_WORKFLOW_NAME } from "../workflows/rescission-intake.js";
import type { Platform } from "../platform.js";

/**
 * `pv workflow` — the workflow engine from a terminal.
 *
 * The engine was written, tested, and reachable from no composition root:
 * `engine.start`, `handlers.register`, `engine.completeHumanTask` and
 * `engine.signalEvent` had no caller outside tests, no CLI verb, and no API
 * route, and the catalogue shipped empty. So the human-task-and-timer
 * durability gate — Phase 2's exit — was proven in `engine.test.ts` and could
 * be demonstrated in the product by nobody. This is the operator surface that
 * closes that: every verb goes through the composition root's one engine, over
 * the one store it shares, so what an operator drives here is the same engine
 * the sweep and the API drive.
 *
 * The house rules apply, each closing a way a command line lies to its operator:
 *
 * **Diagnostics to stderr, the answer to stdout**, so `pv workflow start ...`
 * prints only the instance id an operator pipes into the next verb, and
 * `pv workflow show <id> --json | jq` composes.
 *
 * **The real engine, never a second copy of its rules.** Starting, advancing,
 * completing a task and delivering a signal all go through `platform.engine`.
 * Version pinning, idempotency, containment, ceilings and authorization are that
 * engine's, and this command cannot weaken any of them because it does not own
 * them — a task completed by the wrong role is refused here exactly as it is
 * over HTTP.
 *
 * **Exit codes mean something.** Zero means the thing happened; a refusal exits
 * non-zero with its reason, propagated to main.ts's top-level handler; a
 * malformed command is a usage error and exits 2.
 */

/** The shape `parseArgs` in main.ts produces. Structural, so it stays in step. */
export interface CommandArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string[]>>;
  readonly json: boolean;
}

export const WORKFLOW_USAGE = `
pv workflow — start, drive, and inspect governed workflow instances

  workflow definitions
              List the published definitions: name, version, mode, and steps.
              This deployment ships one built-in flow, ${RESCISSION_INTAKE_WORKFLOW_NAME};
              a deployment publishes its own alongside it.

  workflow start [--workflow <name>] [--version <n>] [--mode <mode>]
                 [--context <key=value>]... [--subject <key=value>]...
              Start an instance through engine.start and print its id. Defaults
              to ${RESCISSION_INTAKE_WORKFLOW_NAME}, which needs --context for
              contractId, stateCode, executedAt and deliveredAt. The instance is
              durable: it advances only while "pv worker" is running, and it
              survives a restart because its whole state is in the store.

  workflow show <instanceId>
              Read an instance: its status, where each path is, what it is
              waiting for, what to do next, and the steps it has completed.

  workflow tasks [--role <name>]... [--workflow <name>]
              The open human-task queue, worst-SLA first (breached, then soonest
              due). --role keeps only tasks a given role may act on.

  workflow complete-task --task <stepId> --outcome <text>
                         [--output <key=value>]...
              Complete a parked human task through engine.completeHumanTask,
              releasing the step that was waiting on it. The acting role must be
              one the task was assigned to. --output merges scalars into the
              instance context for later steps.

  workflow signal --instance <instanceId> --event <name>
                  [--output <key=value>]...
              Deliver a named external signal through engine.signalEvent to
              whichever path is waiting for it (a wait_for_event step).

Global:
  --json      Machine-readable output
  --operator  Name the operator this command is attributed to
  --role      Name the role the operator is acting in (repeatable). Starting the
              intake flow acts as owner_services_agent; confirming its task is a
              compliance_reviewer's. Defaults to platform_admin, which holds
              neither — the chokepoint refuses a role the asserted one does not
              include, so asserting one buys nothing an operator was not entitled
              to.

Exit codes:
  0   the thing happened, or the listing was produced
  1   refused (with its reason)
  2   the command was not usable as written
`.trim();

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
  // A flag given with no value parses as the string "true"; treated as absent,
  // so `--workflow` with nothing after it is a usage error rather than the
  // literal word "true" being taken as a workflow name.
  return value === undefined || value === "true" ? undefined : value;
}

function many(args: CommandArgs, name: string): readonly string[] {
  return (args.flags[name] ?? []).filter((value) => value !== "true");
}

function requireFlag(args: CommandArgs, name: string): string {
  const value = first(args, name);
  if (value === undefined) throw new InvalidInputError(`--${name} is required`, name);
  return value;
}

/**
 * Parse repeatable `--name key=value` flags into a scalar map.
 *
 * The engine's context and a task's output are scalars only — a contract id, a
 * state code, a boolean finding — never owner data, because the instance row
 * outlives the case. This keeps every value a string; the timeline module and
 * the branch conditions read what they need out of that.
 */
function keyValues(args: CommandArgs, name: string): WorkflowContext {
  const out: Record<string, string> = {};
  for (const pair of many(args, name)) {
    const at = pair.indexOf("=");
    if (at <= 0 || at === pair.length - 1) {
      throw new InvalidInputError(
        `--${name} must be key=value, e.g. --${name} stateCode=FL; received "${pair}"`,
        name,
      );
    }
    out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface WorkflowCommandContext {
  readonly platform: Platform;
  /** The operator, as main.ts attributes them. Unverified, and marked `cli:`. */
  readonly actor: ActorRef;
  readonly correlationId?: string | undefined;
}

export async function commandWorkflow(
  args: CommandArgs,
  context: WorkflowCommandContext,
): Promise<number> {
  try {
    return await dispatch(args, context);
  } catch (error) {
    // A malformed command is a usage error, not a crash. `DeniedError` is
    // deliberately not caught: a refusal is an outcome the operator has to see
    // with its reason code, and it propagates to main.ts's top-level handler.
    if (error instanceof InvalidInputError) {
      note(`${error.message}${error.field ? ` (${error.field})` : ""}`);
      return 2;
    }
    throw error;
  }
}

async function dispatch(args: CommandArgs, context: WorkflowCommandContext): Promise<number> {
  const sub = args.positional[1];
  switch (sub) {
    case "definitions":
      return listDefinitions(args, context);
    case "start":
      return await startInstance(args, context);
    case "show":
      return await showInstance(args, context);
    case "tasks":
      return await listTasks(args, context);
    case "complete-task":
      return await completeTask(args, context);
    case "signal":
      return await signalEvent(args, context);
    default:
      note(`Unknown workflow subcommand: ${sub ?? "(none)"}\n`);
      note(WORKFLOW_USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// definitions — what this deployment can run
// ---------------------------------------------------------------------------

function listDefinitions(args: CommandArgs, context: WorkflowCommandContext): number {
  const published = context.platform.catalogue.list();

  if (args.json) {
    emit(
      published.map((entry) => ({
        name: entry.definition.name,
        version: entry.definition.version,
        mode: entry.definition.mode,
        digest: entry.digest,
        steps: entry.definition.steps.map((step) => ({ name: step.name, type: step.type })),
      })),
      args,
    );
    return 0;
  }

  if (published.length === 0) {
    // Distinguished from a deployment that could not read the catalogue: this is
    // a real, empty catalogue, which this build is not — said plainly so an
    // operator does not read the empty case as a fault.
    note("No workflow is published in this deployment's catalogue.");
    return 0;
  }

  console.log(`${"WORKFLOW".padEnd(28)} ${"VER".padEnd(4)} ${"MODE".padEnd(12)} STEPS`);
  for (const entry of published) {
    const steps = entry.definition.steps.map((step) => `${step.name}(${step.type})`).join(" -> ");
    console.log(
      `${entry.definition.name.padEnd(28)} ${String(entry.definition.version).padEnd(4)} ${entry.definition.mode.padEnd(12)} ${steps}`,
    );
  }
  note(`${published.length} definition(s). A deployment publishes its own alongside these.`);
  return 0;
}

// ---------------------------------------------------------------------------
// start — engine.start
// ---------------------------------------------------------------------------

function parseMode(args: CommandArgs): OperatingMode | undefined {
  const raw = first(args, "mode");
  if (raw === undefined) return undefined;
  if (!OPERATING_MODES.includes(raw as OperatingMode)) {
    throw new InvalidInputError(
      `--mode must be one of ${OPERATING_MODES.join(", ")}; received "${raw}".`,
      "mode",
    );
  }
  return raw as OperatingMode;
}

async function startInstance(
  args: CommandArgs,
  context: WorkflowCommandContext,
): Promise<number> {
  const { platform } = context;
  const workflow = first(args, "workflow") ?? RESCISSION_INTAKE_WORKFLOW_NAME;
  const versionRaw = first(args, "version");
  const version = versionRaw === undefined ? undefined : Number(versionRaw);
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    throw new InvalidInputError(`--version must be a positive integer, received "${versionRaw}"`, "version");
  }
  const workflowContext = keyValues(args, "context");
  const subject = Object.fromEntries(
    Object.entries(keyValues(args, "subject")).map(([key, value]) => [key, String(value)]),
  );
  const mode = parseMode(args);

  // A refusal — an unknown workflow, a missing required context key, a mode
  // bolder than the definition was approved for, an engaged containment switch —
  // raises a DeniedError or an InvalidInputError. Neither is caught here: the
  // first propagates to main.ts and exits 1, the second is a usage error above.
  const started = await platform.engine.start({
    workflow,
    requestedBy: context.actor,
    ...(Object.keys(workflowContext).length > 0 ? { context: workflowContext } : {}),
    ...(Object.keys(subject).length > 0 ? { subject } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  });

  note(
    `Started ${started.definitionName} v${started.definitionVersion} as ${started.id}. It advances while "pv worker" runs; drive it with "pv workflow show ${started.id}".`,
  );

  if (args.json) {
    emit(
      {
        instanceId: started.id,
        workflow: started.definitionName,
        version: started.definitionVersion,
        status: started.status,
        runId: started.runId,
        correlationId: started.correlationId,
      },
      args,
    );
    return 0;
  }
  // The answer, alone on stdout: the instance id the next verb takes.
  console.log(started.id);
  return 0;
}

// ---------------------------------------------------------------------------
// show — engine.describeInstance
// ---------------------------------------------------------------------------

async function showInstance(
  args: CommandArgs,
  context: WorkflowCommandContext,
): Promise<number> {
  const id = args.positional[2];
  if (id === undefined || id.startsWith("--")) {
    throw new InvalidInputError(
      "Name the instance to show: pv workflow show <instanceId>. `pv workflow start` prints the id.",
      "instanceId",
    );
  }

  const described = await context.platform.engine.describeInstance(id as Id<"workflowInstance">);

  if (args.json) {
    emit(described, args);
    return 0;
  }

  printInstance(described);
  return 0;
}

function printInstance(described: InstanceDescription): void {
  console.log(`instance          ${described.instanceId}`);
  console.log(`workflow          ${described.workflow} (version ${described.version})`);
  console.log(`status            ${described.status}`);
  console.log(`headline          ${described.headline}`);
  console.log(`next action       ${described.nextAction}`);
  if (described.stuckReason) console.log(`stuck             ${described.stuckReason}`);
  console.log(`cost              $${described.costUsd.toFixed(4)}`);
  for (const line of described.where) console.log(`  where           ${line}`);
  for (const line of described.waitingFor) console.log(`  waiting for     ${line}`);
  for (const timer of described.timers) {
    console.log(`  timer           ${timer.step} fires ${timer.firesAt} (${timer.basis})`);
  }
  for (const task of described.openTasks) {
    console.log(
      `  task            ${task.taskId} "${task.title}" for ${task.roles.join(", ")}${task.dueAt ? ` due ${task.dueAt}` : ""}${task.breached ? " BREACHED" : ""}`,
    );
  }
  if (described.stepsCompleted.length > 0) {
    console.log("history");
    for (const step of described.stepsCompleted) {
      console.log(
        `  ${step.at}  ${step.status.padEnd(11)} ${step.step}${step.summary ? ` — ${step.summary}` : ""}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// tasks — the open human-task queue, worst-SLA first
// ---------------------------------------------------------------------------

async function listTasks(args: CommandArgs, context: WorkflowCommandContext): Promise<number> {
  const { platform } = context;
  const roles = many(args, "role");
  const workflow = first(args, "workflow");

  const tasks = await platform.engine.listTasks({
    status: ["open"],
    ...(roles.length > 0 ? { roles } : {}),
    ...(workflow !== undefined ? { workflowName: workflow } : {}),
  });

  const now = platform.clock.nowIso();
  // Worst first: a breached task, then the soonest due. A task with no SLA can
  // never breach, so it sorts last — it has no clock to be worst against.
  const ordered = [...tasks].sort((left, right) => rank(left, now) - rank(right, now));

  if (args.json) {
    emit(
      ordered.map((task) => ({
        taskId: task.id,
        instanceId: task.instanceId,
        workflow: task.workflowName,
        step: task.stepName,
        title: task.title,
        assignedRoles: task.assignedRoles,
        dueAt: task.dueAt ?? null,
        breached: task.dueAt !== undefined && now > task.dueAt,
        escalationLevel: task.escalationLevel,
      })),
      args,
    );
    return 0;
  }

  if (ordered.length === 0) {
    note(
      roles.length > 0
        ? `No open task for role(s) ${roles.join(", ")}. An empty queue is not the same as no queue: check "pv worker" is running if you expected one.`
        : `No open human task. An empty queue is not the same as no queue: check "pv worker" is running if you expected one.`,
    );
    return 0;
  }

  console.log(
    `${"TASK".padEnd(27)} ${"WORKFLOW".padEnd(24)} ${"STEP".padEnd(20)} ${"DUE".padEnd(26)} ${"SLA".padEnd(10)} ROLES`,
  );
  for (const task of ordered) {
    const breached = task.dueAt !== undefined && now > task.dueAt;
    const sla = task.dueAt === undefined ? "none" : breached ? `BREACHED L${task.escalationLevel}` : "ok";
    console.log(
      `${task.id.padEnd(27)} ${task.workflowName.padEnd(24)} ${task.stepName.padEnd(20)} ${(task.dueAt ?? "-").padEnd(26)} ${sla.padEnd(10)} ${task.assignedRoles.join(", ")}`,
    );
  }
  note(`${ordered.length} open task(s), worst first. Complete one with "pv workflow complete-task --task <id> --outcome <text>".`);
  return 0;
}

/** Lower ranks sort first: breached before due before un-SLA'd, soonest within each. */
function rank(task: HumanTask, now: string): number {
  if (task.dueAt === undefined) return Number.MAX_SAFE_INTEGER;
  // Milliseconds until due; already-breached tasks are negative and sort first.
  return Date.parse(task.dueAt) - Date.parse(now);
}

// ---------------------------------------------------------------------------
// complete-task — engine.completeHumanTask
// ---------------------------------------------------------------------------

async function completeTask(
  args: CommandArgs,
  context: WorkflowCommandContext,
): Promise<number> {
  const { platform } = context;
  const taskId = requireFlag(args, "task");
  const outcome = requireFlag(args, "outcome");
  const output = keyValues(args, "output");

  // A refusal — the task is not open, or the acting role is not one it was
  // assigned to — raises a DeniedError that propagates to main.ts and exits 1.
  const instance = await platform.engine.completeHumanTask({
    taskId: taskId as Id<"step">,
    actor: context.actor,
    outcome,
    ...(Object.keys(output).length > 0 ? { output } : {}),
  });

  note(
    `Completed task ${taskId}. ${instance.definitionName} ${instance.id} is now ${instance.status}; it advances further while "pv worker" runs.`,
  );

  if (args.json) {
    emit({ taskId, instanceId: instance.id, status: instance.status }, args);
    return 0;
  }
  console.log(instance.status);
  return 0;
}

// ---------------------------------------------------------------------------
// signal — engine.signalEvent
// ---------------------------------------------------------------------------

async function signalEvent(
  args: CommandArgs,
  context: WorkflowCommandContext,
): Promise<number> {
  const { platform } = context;
  const instanceId = requireFlag(args, "instance");
  const event = requireFlag(args, "event");
  const output = keyValues(args, "output");

  // A refusal — nothing on this instance is waiting for that event — raises a
  // DeniedError that propagates to main.ts and exits 1.
  const instance = await platform.engine.signalEvent({
    instanceId: instanceId as Id<"workflowInstance">,
    event,
    actor: context.actor,
    ...(Object.keys(output).length > 0 ? { output } : {}),
  });

  note(`Delivered "${event}" to ${instance.id}; it is now ${instance.status}.`);

  if (args.json) {
    emit({ instanceId: instance.id, event, status: instance.status }, args);
    return 0;
  }
  console.log(instance.status);
  return 0;
}
