import { readFileSync } from "node:fs";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { RiskTier } from "../guard/types.js";
import type { ActorRef } from "../record/types.js";
import { ModelGateway } from "../models/invoke.js";
import { AnthropicProvider, FakeProvider, ProviderRegistry } from "../models/provider.js";
import { MemoryModelInvocationStore } from "../models/store.memory.js";
import { PgModelInvocationStore } from "../models/store.pg.js";
import { draftRole } from "../roles/authoring.js";
import { EvaluationHarness } from "../roles/evaluation.js";
import type { GoldenSet, Role, RoleVersion } from "../roles/types.js";
import { MemoryDb, PgDb } from "../store/db.js";
import type { Platform } from "../platform.js";

/**
 * `pv roles` — the role factory from a terminal.
 *
 * A role is what MVW adds when it wants the platform to do a new job. The whole
 * point of the module beneath this one is that adding one is a business change
 * rather than an engineering cycle — and until this file existed there was no
 * way to make that change at all. `draftRole`, the registry, the promotion
 * service, and the fairness analysis were built and had no caller outside their
 * own tests, so no role could be authored, evaluated, or promoted, and
 * `pv evaluate --ci` reported that nothing in the registry had been evaluated
 * because nothing ever could be. This is the operator surface that closes that.
 *
 * The house rules apply, each closing a way a command line lies to its operator:
 *
 * **Diagnostics to stderr, the answer to stdout**, so `pv roles show intake
 * --json | jq` composes and `pv roles propose ... > evidence.txt` writes a file
 * an auditor can read without a banner in it. The one thing each verb prints on
 * stdout is its answer: a role id, an evaluation run id, a version number.
 *
 * **The real services, never a second copy of their rules.** Every verb here
 * goes through `RoleRegistry`, `RolePromotionService`, and the `EvaluationHarness`
 * the composition root built. There is no promotion rule re-implemented in this
 * file: promotion still demands recorded evaluation evidence *and* a human
 * approval through the ordinary chokepoint, and this command cannot weaken that
 * because it does not own it.
 *
 * **Fail closed.** `roles draft` produces an inert draft — it cannot act, and
 * saying so is the first thing the verb prints. `roles promote` refuses without
 * both evidence and an approval, because the service it calls refuses. The step
 * that grants the approval is `pv approvals decide`, run by a *different* person:
 * nobody approves their own proposal, and there is no flag here that pretends
 * otherwise.
 *
 * **Exit codes mean something.** Zero means the thing happened; a refusal exits
 * non-zero with its reason, propagated to the top-level handler in `main.ts`.
 */

// ---------------------------------------------------------------------------
// Arguments and output
// ---------------------------------------------------------------------------

/** The shape `parseArgs` in main.ts produces. Structural, so it stays in step. */
export interface CommandArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string[]>>;
  readonly json: boolean;
}

export const ROLES_USAGE = `
pv roles — author, evaluate, promote, and stop the roles MVW runs here

  roles list                     Every role, with the version that may act
  roles show <role>              One role, its versions, and its promotion evidence

  roles draft --name <n> --description <text> --model-task <task>
              --prompt-template <id> --prompt-version <n> --evaluation-set <id>
              [--scope <name>]... [--must-include <action>]... [--exclude <action>]...
              [--max-risk <routine|sensitive|high_consequence>] [--change-note <text>]
              Author an INERT draft from a plain-language brief. It cannot act.

  roles golden publish --file <path>
              Publish a curated golden set (JSON). Adding cases is allowed;
              weakening an existing set is refused.

  roles propose --role <role> [--version <n>] [--golden-set <id>]
              Measure the version against its golden set, record the evidence,
              and submit it for promotion. Prints the evaluation run id.

  roles promote --role <role> --version <n> --evaluation-run <id>
              --raise-approval
              Raise the promotion approval. Somebody else grants it with
              "pv approvals decide", then:
  roles promote --role <role> --version <n> --evaluation-run <id>
              --approval <id> --reauthenticated
              Promote the version so it may act. Refused without both recorded
              evidence and a granted approval.

  roles revert --role <role> --to-version <n> --reason <text>
              Roll back to a version that was previously promoted.
  roles disable --role <role> --reason <text>
              Stop a role NOW, through containment, without a deploy.
  roles enable --role <role> --version <n> --reason <text>
              Bring a disabled version back.

Global:
  --json      Machine-readable output
  --operator  Name the operator this command is attributed to

Promotion is high-consequence: it needs an approval a different person granted
and a fresh re-authentication. The approver grants through "pv approvals decide";
the promoter asserts their own re-authentication with --reauthenticated, which
the audit record shows came from the CLI.

Exit codes:
  0   the thing happened
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
  // A flag given with no value parses as the string "true". Treated as absent,
  // so `--reason` with nothing after it is a usage error rather than the literal
  // word "true" being recorded as the reason a role was stopped.
  return value === undefined || value === "true" ? undefined : value;
}

function flagPresent(args: CommandArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}

function many(args: CommandArgs, name: string): readonly string[] {
  return (args.flags[name] ?? []).filter((value) => value !== "true");
}

function requireFlag(args: CommandArgs, name: string): string {
  const value = first(args, name);
  if (value === undefined) throw new InvalidInputError(`--${name} is required`, name);
  return value;
}

function requireInt(args: CommandArgs, name: string): number {
  const raw = requireFlag(args, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidInputError(`--${name} must be a positive integer, received "${raw}"`, name);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface RolesCommandContext {
  readonly platform: Platform;
  /** The operator, as main.ts attributes them. Unverified, and marked `cli:`. */
  readonly actor: ActorRef;
  readonly correlationId?: string | undefined;
}

export async function commandRoles(
  args: CommandArgs,
  context: RolesCommandContext,
): Promise<number> {
  try {
    return await dispatch(args, context);
  } catch (error) {
    // A malformed command is a usage error, not a crash. `DeniedError` is
    // deliberately NOT caught: a refusal is an outcome the operator has to see
    // with its reason code, and it propagates to main.ts's top-level handler.
    if (error instanceof InvalidInputError) {
      note(`${error.message}${error.field ? ` (${error.field})` : ""}`);
      return 2;
    }
    throw error;
  }
}

async function dispatch(args: CommandArgs, context: RolesCommandContext): Promise<number> {
  const sub = args.positional[1];
  switch (sub) {
    case "list":
      return await listRoles(args, context);
    case "show":
      return await showRole(args, context);
    case "draft":
      return await draftRoleVerb(args, context);
    case "golden":
      return await goldenVerb(args, context);
    case "propose":
      return await proposeRole(args, context);
    case "promote":
      return await promoteRole(args, context);
    case "revert":
      return await revertRole(args, context);
    case "disable":
      return await disableRole(args, context);
    case "enable":
      return await enableRole(args, context);
    default:
      note(`Unknown roles subcommand: ${sub ?? "(none)"}\n`);
      note(ROLES_USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Resolve a role from a name or an id.
 *
 * Operators think in names, the record thinks in ids. The name is tried first
 * and exactly — never case-insensitively — because the name is the handle
 * everything else refers to, and matching loosely would act on the wrong role.
 */
async function resolveRole(platform: Platform, reference: string | undefined): Promise<Role> {
  if (reference === undefined || reference.length === 0) {
    throw new InvalidInputError("A role is required: its name, or its identifier.", "role");
  }
  const byName = await platform.roles.findByName(reference);
  if (byName) return byName;
  const byId = await platform.roles.get(reference as Id<"role">);
  if (byId) return byId;
  throw new DeniedError("record.unavailable", `No role "${reference}" in the registry.`, {
    role: reference,
  });
}

function roleLine(role: Role): Record<string, unknown> {
  return {
    id: role.id,
    name: role.name,
    latestVersion: role.latestVersion,
    promotedVersion: role.promotedVersion ?? null,
    createdBy: role.createdBy.actorId,
    createdAt: role.createdAt,
  };
}

async function listRoles(args: CommandArgs, context: RolesCommandContext): Promise<number> {
  const roles = await context.platform.roles.list();

  if (args.json) {
    emit(roles.map(roleLine), args);
    return 0;
  }

  if (roles.length === 0) {
    note(
      "No role is registered. `pv roles draft` authors one — as an inert draft that cannot act until it is evaluated and its promotion approved.",
    );
    return 0;
  }

  console.log(
    `${"NAME".padEnd(28)} ${"LATEST".padEnd(7)} ${"PROMOTED".padEnd(9)} ${"CREATED BY".padEnd(24)} ROLE ID`,
  );
  for (const role of roles) {
    console.log(
      `${role.name.padEnd(28)} ${String(role.latestVersion).padEnd(7)} ${(role.promotedVersion ? `v${role.promotedVersion}` : "none").padEnd(9)} ${role.createdBy.actorId.padEnd(24)} ${role.id}`,
    );
  }
  const live = roles.filter((role) => role.promotedVersion !== undefined).length;
  note(
    `${roles.length} role(s), ${live} with a promoted version. A role with no promoted version cannot act — "none" is inert, not broken.`,
  );
  return 0;
}

function versionLine(version: RoleVersion): Record<string, unknown> {
  return {
    version: version.version,
    status: version.status,
    definitionDigest: version.definitionDigest,
    createdBy: version.createdBy.actorId,
    createdAt: version.createdAt,
    changeNote: version.changeNote,
    restoredFromVersion: version.restoredFromVersion ?? null,
    evidence: version.evidence
      ? {
          evaluationRunId: version.evidence.evaluationRunId,
          accuracy: version.evidence.accuracy,
          threshold: version.evidence.threshold,
          approvalId: version.evidence.approvalId,
          promotedBy: version.evidence.promotedBy.actorId,
          promotedAt: version.evidence.promotedAt,
        }
      : null,
  };
}

async function showRole(args: CommandArgs, context: RolesCommandContext): Promise<number> {
  const { platform } = context;
  const role = await resolveRole(platform, args.positional[2]);
  const versions = await platform.roles.versions(role.id);

  if (args.json) {
    emit({ role: roleLine(role), versions: versions.map(versionLine) }, args);
    return 0;
  }

  console.log(`name              ${role.name}`);
  console.log(`id                ${role.id}`);
  console.log(`latest version    v${role.latestVersion}`);
  console.log(`promoted version  ${role.promotedVersion ? `v${role.promotedVersion}` : "none — this role cannot act"}`);
  console.log(`created           ${role.createdAt} by ${role.createdBy.actorId}`);

  console.log("");
  console.log(`VERSIONS (${versions.length})`);
  console.log(
    `  ${"VER".padEnd(4)} ${"STATUS".padEnd(9)} ${"CREATED BY".padEnd(22)} ${"EVIDENCE".padEnd(28)} CHANGE NOTE`,
  );
  for (const version of versions) {
    const evidence = version.evidence
      ? `${(version.evidence.accuracy * 100).toFixed(1)}% run ${version.evidence.evaluationRunId}`
      : version.status === "proposed"
        ? "proposed, awaiting promotion"
        : "—";
    console.log(
      `  v${String(version.version).padEnd(3)} ${version.status.padEnd(9)} ${version.createdBy.actorId.padEnd(22)} ${evidence.padEnd(28)} ${version.changeNote}`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

async function draftRoleVerb(args: CommandArgs, context: RolesCommandContext): Promise<number> {
  const { platform } = context;

  const maxRiskRaw = first(args, "max-risk");
  const draft = draftRole(
    {
      name: requireFlag(args, "name"),
      description: requireFlag(args, "description"),
      dataScopes: many(args, "scope"),
      modelTask: requireFlag(args, "model-task"),
      promptTemplateId: requireFlag(args, "prompt-template"),
      promptTemplateVersion: requireInt(args, "prompt-version"),
      evaluationSetId: requireFlag(args, "evaluation-set"),
      ...(many(args, "must-include").length > 0 ? { mustInclude: many(args, "must-include") } : {}),
      ...(many(args, "exclude").length > 0 ? { exclude: many(args, "exclude") } : {}),
      ...(maxRiskRaw !== undefined ? { maxRisk: maxRiskRaw as RiskTier } : {}),
    },
    platform.registry,
  );

  // The matcher's reasoning belongs on stderr: it is the reviewer's material,
  // not the answer. Every warning and every considered action is shown, because
  // a draft an operator promotes without reading is the failure this whole
  // module is built to prevent.
  note("This is a proposal. It CANNOT act: it becomes a draft, and a draft is inert");
  note("until it has been evaluated against its golden set and a person with authority");
  note("has approved its promotion.");
  note("");
  for (const warning of draft.warnings) note(`  warning  ${warning}`);
  note("");
  note("Actions the matcher considered:");
  for (const entry of draft.considered) {
    note(
      `  ${entry.selected ? "SELECTED" : "left out"}  ${entry.action} (${entry.risk})${entry.excludedBecause ? ` — ${entry.excludedBecause}` : ""}`,
    );
  }

  // Authoring an existing role by name appends a version rather than colliding
  // with it: editing a role is a new version, and the previous one stays exactly
  // as it was. A name that is free creates the role and its first version.
  const changeNote =
    first(args, "change-note") ?? "Authored from a plain-language brief via `pv roles draft`.";
  const existing = await platform.roles.findByName(draft.definition.name);
  const created = existing
    ? await platform.roles.createVersion({
        roleId: existing.id,
        definition: draft.definition,
        author: context.actor,
        changeNote,
      })
    : await platform.roles.createRole({
        definition: draft.definition,
        author: context.actor,
        changeNote,
      });

  note("");
  note(
    `${existing ? "Drafted a new version of" : "Drafted"} "${created.role.name}" v${created.version.version} (${created.role.id}) with actions ${draft.definition.actions.join(", ")}, ceiling ${draft.definition.riskCeiling}, in ${draft.definition.operatingModes.join(", ")} mode. Evaluate it with: pv roles propose --role ${created.role.name} --version ${created.version.version}`,
  );

  if (args.json) {
    emit(
      {
        roleId: created.role.id,
        name: created.role.name,
        version: created.version.version,
        status: created.version.status,
        definition: draft.definition,
        warnings: draft.warnings,
      },
      args,
    );
    return 0;
  }

  // The answer, alone on stdout: the role id the next verb takes.
  console.log(created.role.id);
  return 0;
}

// ---------------------------------------------------------------------------
// Golden sets
// ---------------------------------------------------------------------------

async function goldenVerb(args: CommandArgs, context: RolesCommandContext): Promise<number> {
  const verb = args.positional[2];
  if (verb !== "publish") {
    note(`Unknown golden subcommand: ${verb ?? "(none)"}. Try: publish.`);
    return 2;
  }

  const path = requireFlag(args, "file");
  let parsed: GoldenSet;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as GoldenSet;
  } catch (error) {
    throw new InvalidInputError(
      `Could not read a golden set from ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "file",
    );
  }

  // Through the harness's publish path, not a bare store write, so the guard
  // that refuses a weakened set runs even though this caller did not ask for it.
  const harness = buildHarness(context.platform);
  const published = await harness.publishGoldenSet(parsed);

  note(
    `Published golden set "${published.set.id}" v${published.set.version} — ${published.set.cases.length} case(s), threshold ${(published.set.threshold * 100).toFixed(1)}%, curated by ${published.set.curatedBy}.${
      published.delta ? ` Added ${published.delta.addedCaseIds.length} case(s) to the previous version.` : ""
    }`,
  );

  if (args.json) {
    emit(
      {
        goldenSetId: published.set.id,
        version: published.set.version,
        caseCount: published.set.cases.length,
        threshold: published.set.threshold,
        addedCaseIds: published.delta?.addedCaseIds ?? [],
      },
      args,
    );
    return 0;
  }
  console.log(`${published.set.id}@${published.set.version}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Propose (measure, record evidence, submit for promotion)
// ---------------------------------------------------------------------------

async function proposeRole(args: CommandArgs, context: RolesCommandContext): Promise<number> {
  const { platform } = context;
  const role = await resolveRole(platform, first(args, "role"));
  // Default to the latest version: the one an operator has just drafted or
  // versioned is the one they mean, and naming it every time is a step to skip.
  const version = flagPresent(args, "version") ? requireInt(args, "version") : role.latestVersion;

  const harness = buildHarness(platform);

  // A real operating-record run, so the model calls are charged somewhere and,
  // on Postgres, the evaluation row's foreign key to the run is satisfied.
  const run = await platform.runs.createRun({
    kind: "role.evaluation",
    mode: "shadow",
    requestedBy: context.actor,
    subject: { roleId: role.id, roleVersion: String(version) },
    correlationId: context.correlationId ?? `roles-propose-${role.name}`,
  });
  platform.ceilings.markRunStarted(run.id);

  let evaluationId: string;
  let accuracy: number;
  let meetsThreshold: boolean;
  try {
    const evaluation = await harness.runEvaluation({
      roleId: role.id,
      version,
      actor: context.actor,
      // Evaluation produces evidence and has no external effect, so it runs in
      // shadow — the only mode a role this unproven should be measured in.
      mode: "shadow",
      runId: run.id,
      ...(first(args, "golden-set") !== undefined ? { goldenSetId: requireFlag(args, "golden-set") } : {}),
    });
    evaluationId = evaluation.id;
    accuracy = evaluation.accuracy;
    meetsThreshold = evaluation.meetsThreshold;
  } finally {
    platform.ceilings.markRunEnded(run.id);
  }

  note(
    `Evaluated "${role.name}" v${version}: ${(accuracy * 100).toFixed(1)}% (${meetsThreshold ? "meets" : "BELOW"} its threshold). Evidence recorded as ${evaluationId}.`,
  );
  if (!meetsThreshold) {
    note(
      "This evidence is below the golden set's threshold. It is proposed anyway — the evidence is a fact either way — but promotion will refuse it: quality is measured, not asserted.",
    );
  }

  const proposed = await platform.rolePromotion.propose({
    roleId: role.id,
    version,
    actor: context.actor,
    // `role.propose` is sensitive, which shadow mode does not permit; supervised
    // is the mode a deliberate submission is made in.
    mode: "supervised",
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  });

  note(
    `Submitted "${role.name}" v${proposed.version} for promotion (status: ${proposed.status}). Raise the approval with:\n  pv roles promote --role ${role.name} --version ${proposed.version} --evaluation-run ${evaluationId} --raise-approval`,
  );

  if (args.json) {
    emit(
      {
        roleId: role.id,
        version: proposed.version,
        status: proposed.status,
        evaluationRunId: evaluationId,
        accuracy,
        meetsThreshold,
      },
      args,
    );
    return 0;
  }
  // The answer, alone on stdout: the evidence id the promote verb cites.
  console.log(evaluationId);
  return 0;
}

// ---------------------------------------------------------------------------
// Promote (through the role.promote action and its approval)
// ---------------------------------------------------------------------------

/**
 * Refuse to invent a step-up the platform cannot observe.
 *
 * The command line cannot verify who is typing — `main.ts` says so where it
 * builds the actor. `--reauthenticated` is the operator asserting they have just
 * re-authenticated to this host, and it is required rather than assumed: a
 * high-consequence promotion that quietly counted "we are on a terminal" as
 * re-authentication would make the step-up requirement decorative for every
 * headless install. The audit record shows the promotion came from the CLI, so
 * the assertion is visible to whoever reviews it. The *approval* this promotion
 * spends is a separate matter, granted by a different person through
 * `pv approvals decide`, where an assertion is not accepted at all.
 */
function promoterStepUpSeconds(args: CommandArgs): number {
  if (!flagPresent(args, "reauthenticated")) {
    throw new DeniedError(
      "authorization.step_up_required",
      "Promoting a role requires a fresh re-authentication. The command line cannot verify one, so it is asserted: re-authenticate to this host and pass --reauthenticated.",
      { action: "role.promote" },
    );
  }
  return 0;
}

async function promoteRole(args: CommandArgs, context: RolesCommandContext): Promise<number> {
  const { platform } = context;
  const role = await resolveRole(platform, first(args, "role"));
  const version = requireInt(args, "version");
  const evaluationRunId = requireFlag(args, "evaluation-run") as Id<"evaluation">;

  if (flagPresent(args, "raise-approval")) {
    const approval = await platform.rolePromotion.requestPromotionApproval({
      roleId: role.id,
      version,
      evaluationRunId,
      requestedBy: context.actor,
      ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    });
    note(
      `Approval ${approval.id} raised to promote "${role.name}" v${version}. Somebody other than ${context.actor.actorId} must grant it — nobody approves their own proposal:\n  pv approvals decide ${approval.id} --grant --note "<why>" --session-file <path>\nGranting a high-consequence action needs a session this platform can see the authentication instant of; see "pv approvals". Then:\n  pv roles promote --role ${role.name} --version ${version} --evaluation-run ${evaluationRunId} --approval ${approval.id} --reauthenticated`,
    );
    emit(args.json ? { approvalId: approval.id } : approval.id, args);
    return 0;
  }

  const approvalId = requireFlag(args, "approval") as Id<"approval">;
  const stepUp = promoterStepUpSeconds(args);

  const promoted = await platform.rolePromotion.promote({
    roleId: role.id,
    version,
    evaluationRunId,
    approvalId,
    actor: context.actor,
    // `role.promote` is not permitted in shadow; supervised is the mode a
    // deliberate, approved promotion is made in.
    mode: "supervised",
    secondsSinceAuthentication: stepUp,
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  });

  note(
    `PROMOTED "${promoted.role.name}" v${promoted.version.version} — it may now act. Every future run of this role uses this version; runs already in flight finish on the version they started with. It is now visible to \`pv evaluate --ci\`.`,
  );
  emit(
    args.json
      ? {
          roleId: promoted.role.id,
          name: promoted.role.name,
          promotedVersion: promoted.version.version,
          evaluationRunId,
          approvalId,
        }
      : String(promoted.version.version),
    args,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Revert, disable, enable
// ---------------------------------------------------------------------------

async function revertRole(args: CommandArgs, context: RolesCommandContext): Promise<number> {
  const { platform } = context;
  const role = await resolveRole(platform, first(args, "role"));
  const toVersion = requireInt(args, "to-version");
  const reason = requireReason(args, "revert");

  const reverted = await platform.roles.revert({
    roleId: role.id,
    toVersion,
    actor: context.actor,
    // `role.revert` is sensitive and deliberately not a second-approver gate:
    // undoing a bad change should never wait. Supervised is the mode it runs in.
    mode: "supervised",
    reason,
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  });

  note(
    `Reverted "${reverted.role.name}" to the definition of v${toVersion}, which is now live as v${reverted.version.version}. The rollback is a new version in the history — what was live between two dates stays answerable.`,
  );
  emit(
    args.json
      ? { roleId: reverted.role.id, restoredFromVersion: toVersion, promotedVersion: reverted.version.version }
      : String(reverted.version.version),
    args,
  );
  return 0;
}

async function disableRole(args: CommandArgs, context: RolesCommandContext): Promise<number> {
  const { platform } = context;
  const reason = requireReason(args, "disable");
  const role = await resolveRole(platform, first(args, "role"));

  const result = await platform.rolePromotion.disable({
    roleId: role.id,
    actor: context.actor,
    reason,
  });

  note(
    `DISABLED "${role.name}" — ${reason}\nThe role's containment switch is engaged, so it is refused at its next action boundary now, without a deploy.${
      result.version ? ` Its promoted version v${result.version.version} is marked disabled.` : " No version was promoted, so only the switch was engaged."
    }`,
  );
  emit(
    args.json
      ? { roleId: role.id, containmentEngaged: result.switch.engaged, disabledVersion: result.version?.version ?? null }
      : role.id,
    args,
  );
  return 0;
}

async function enableRole(args: CommandArgs, context: RolesCommandContext): Promise<number> {
  const { platform } = context;
  const role = await resolveRole(platform, first(args, "role"));
  const version = requireInt(args, "version");
  const reason = requireReason(args, "enable");

  const result = await platform.rolePromotion.enable({
    roleId: role.id,
    version,
    actor: context.actor,
    reason,
  });

  note(
    `ENABLED "${role.name}" v${result.version.version} — ${reason}\nIts containment switch is released and it may act again. No fresh approval was needed: this version was evidenced and approved when it was promoted, and nothing about it has changed.`,
  );
  emit(
    args.json ? { roleId: role.id, promotedVersion: result.version.version } : String(result.version.version),
    args,
  );
  return 0;
}

/** A mandatory, non-empty reason. It is recorded, and an unexplained change is unreviewable. */
function requireReason(args: CommandArgs, verb: string): string {
  const reason = first(args, "reason");
  if (reason === undefined || reason.trim().length === 0) {
    throw new InvalidInputError(
      `--reason is required for ${verb}. It is recorded on the change and in the audit chain; a change nobody explained cannot be reviewed.`,
      "reason",
    );
  }
  return reason;
}

// ---------------------------------------------------------------------------
// The evaluation harness, built the way `pv evaluate` builds its own
// ---------------------------------------------------------------------------

/**
 * Compose the evaluation harness for the verbs that need one.
 *
 * The gateway is built here rather than on the platform for the same reason
 * `pv evaluate` builds its own: a process that only serves requests, or only
 * disables a misbehaving role, should never construct a model provider it will
 * not call. The authorizer is the platform's — its registry now carries
 * `role.evaluate`, so the harness does not need a second one — and the inventory
 * and templates are the platform's, so the evidence this records names the same
 * model and prompt the promotion drift check will read.
 */
function buildHarness(platform: Platform): EvaluationHarness {
  const db = platform.db;
  const providers = new ProviderRegistry([
    platform.config.modelProvider === "fake"
      ? new FakeProvider(platform.config.demoSeed)
      : new AnthropicProvider({
          apiKey: platform.config.anthropicApiKey ?? "",
          baseUrl: platform.config.anthropicBaseUrl,
        }),
  ]);
  const gateway = new ModelGateway({
    inventory: platform.inventory,
    providers,
    templates: platform.templates,
    runs: platform.runs,
    // On Postgres the invocation log joins the operating record; on the
    // in-memory store it is a throwaway, because that store holds nothing
    // between processes and this path is a local convenience there, not the gate.
    invocations: db instanceof PgDb ? new PgModelInvocationStore(db) : new MemoryModelInvocationStore(new MemoryDb()),
    audit: platform.audit,
    ceilings: platform.ceilings,
    clock: platform.clock,
  });
  return new EvaluationHarness({
    roles: platform.roleStore,
    evaluations: platform.evaluations,
    gateway,
    inventory: platform.inventory,
    templates: platform.templates,
    authorizer: platform.authorizer,
    audit: platform.audit,
    clock: platform.clock,
    ids: platform.ids,
  });
}
