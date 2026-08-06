import { readFileSync } from "node:fs";
import type { ApprovalService } from "../guard/approvals.js";
import type { RiskTier } from "../guard/types.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef } from "../record/types.js";
import {
  ENROLL_ACTION,
  REVOKE_ACTION,
  enrollmentProposalDigest,
  revocationProposalDigest,
  type EnrollRequest,
  type OperatorContext,
} from "../external/enrollment.js";
import {
  EXTERNAL_PLANE_DISABLED,
  externalAgentHealth,
  externalHealthPorts,
  type ExternalAgentHealth,
} from "../external/health.js";
import type { ExternalPlane } from "../external/plane.js";
import {
  CREDENTIAL_KINDS,
  isStrongCredentialKind,
  type AgentCredential,
  type CredentialKind,
  type EnrolledAgent,
  type EnrollmentUpdate,
  type ExternalAgentId,
  type ExternalRunStatus,
  type ParkedActionStatus,
} from "../external/types.js";

/**
 * `pv agents` — the whole external-agent plane from a terminal.
 *
 * This exists because a governance plane that can only be operated from a
 * browser is a governance plane that is unavailable during exactly the incident
 * it was built for. The console is where an operator lives; the command line is
 * where they end up at three in the morning when the console is behind the same
 * outage, or when the deployment has no browser pointed at it at all. Every
 * administrative action is therefore reachable here — enroll, re-enroll,
 * contain, release, revoke, mint, list, revoke a credential, read runs, read
 * parked actions — with no verb that is console-only.
 *
 * Four rules, each closing a specific way a command line lies to its operator.
 *
 * **Diagnostics to stderr, the answer to stdout.** So `pv agents list --json |
 * jq` composes and `pv agents credential list crm-bot > evidence.txt` produces
 * a file somebody can hand to an auditor, without anyone having to strip a
 * banner out of it first.
 *
 * **A minted bearer token is printed once, and never appears anywhere else.**
 * It is generated at mint, returned once, and stored only as a hash. There is
 * no verb that reads it back, because there is nothing to read back — so the
 * one moment it is printed carries a warning saying so plainly.
 *
 * **Reasons are typed, and mandatory where the action is hard to undo.**
 * Containment, release, revocation, and credential revocation each take a
 * reason from a closed vocabulary. Free prose is accepted alongside it and
 * never instead of it: "asked to" and "per Dave" are what a mandatory free-text
 * reason field actually collects, and neither answers the question an incident
 * review asks six months later. There is deliberately no `other` code — an
 * escape hatch becomes the default within a fortnight, and after that the
 * vocabulary means nothing. If nothing fits, the list is wrong, and changing it
 * is a reviewable change to this file.
 *
 * **Exit codes mean something.** Zero means the thing happened. A refusal exits
 * non-zero, and so does `agents parked` when it finds an action whose effect is
 * indeterminate — that verb is meant to be wired to a scheduler, and a check
 * that exits zero while a write may or may not have landed is worse than no
 * check at all.
 */

// ---------------------------------------------------------------------------
// Typed reasons
// ---------------------------------------------------------------------------

/**
 * Why an agent is being stopped.
 *
 * Typed so that "how often do we contain an agent because we think its
 * credential leaked?" is a question the audit record can answer. A free-text
 * field cannot answer it, and by the time anybody asks, the prose is a year old
 * and written by someone who has left.
 */
export const CONTAINMENT_REASONS: Readonly<Record<string, string>> = {
  suspected_compromise: "the agent's credential or its host may be in the wrong hands",
  misbehaviour: "the agent is doing something it is not supposed to do",
  cost_overrun: "the agent is spending faster than anyone expected",
  data_concern: "the agent is reaching data it should not be reaching",
  vendor_offboarding: "the team or vendor that runs this agent is being offboarded",
  under_investigation: "something is being looked into and the agent should hold still",
  planned_change: "a deliberate, planned stop while something is changed",
};

/**
 * Why an agent is being let go again.
 *
 * A separate vocabulary from containment, because "why did you stop it" and
 * "why did you start it again" are different questions and reusing one list for
 * both would record the answer to neither.
 */
export const RELEASE_REASONS: Readonly<Record<string, string>> = {
  investigated_and_clear: "it was looked into and nothing was wrong",
  fixed_by_owner: "the agent's owner corrected the behaviour",
  credential_rotated: "the credential in question has been replaced",
  change_complete: "the planned change is finished",
  contained_in_error: "it should not have been stopped in the first place",
};

export const REVOCATION_REASONS: Readonly<Record<string, string>> = {
  no_longer_needed: "the work this agent did is finished or has moved elsewhere",
  superseded: "another enrollment replaces this one",
  vendor_offboarding: "the team or vendor that ran this agent has been offboarded",
  policy_violation: "the agent did something that ends its enrollment",
  suspected_compromise: "the agent or its credentials cannot be trusted again",
  enrollment_error: "this enrollment was created by mistake",
};

export const CREDENTIAL_REVOCATION_REASONS: Readonly<Record<string, string>> = {
  rotated: "a replacement has been minted and is in use",
  suspected_compromise: "this credential may be in the wrong hands",
  no_longer_needed: "the integration that used it is gone",
  owner_departed: "the person who held it has left",
  minted_in_error: "it should not have been minted",
  vendor_offboarding: "the team or vendor that held it has been offboarded",
};

/**
 * Compose the recorded reason from a code and optional prose.
 *
 * The code leads, so a reason is still classifiable when the prose is absent,
 * wrong, or written in a hurry.
 */
export function composeReason(
  vocabulary: Readonly<Record<string, string>>,
  code: string,
  note: string | undefined,
): string {
  const meaning = vocabulary[code];
  if (meaning === undefined) {
    throw new InvalidInputError(
      `"${code}" is not a recognised reason. Use one of: ${Object.keys(vocabulary).sort().join(", ")}. There is deliberately no "other": an escape hatch becomes the default answer within a fortnight, and after that the reason field records nothing worth reading.`,
      "reason",
    );
  }
  return note === undefined ? `${code} — ${meaning}` : `${code} — ${meaning}: ${note}`;
}

// ---------------------------------------------------------------------------
// Arguments and output
// ---------------------------------------------------------------------------

/** The shape `parseArgs` in main.ts produces. Structural, so it stays in step. */
export interface CommandArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string[]>>;
  readonly json: boolean;
}

export const AGENTS_USAGE = `
pv agents — govern the agents MVW runs elsewhere

  agents list [--status a,b] [--department <name>] [--contained] [--over-budget]
  agents show <agent>
  agents health

  agents enroll --name <n> --owner <email> --department <d> --host <platform>
                --purpose <text> --risk-ceiling <routine|sensitive|high_consequence>
                --spend-ceiling <usd> --budget-period <monthly|lifetime>
                --wall-clock-ms <n> --expires <iso>
                [--tool <name[:tier]>]... [--scope <name>]...
                [--raise-approval | --approval <id>] [--reauthenticated]
  agents update <agent> [--owner|--department|--host|--purpose|--risk-ceiling
                         |--spend-ceiling|--budget-period|--wall-clock-ms
                         |--expires|--tool|--scope ...]

  agents contain <agent> --reason <code> [--note <text>]
  agents release <agent> --reason <code> [--note <text>]
  agents revoke  <agent> --reason <code> [--note <text>]
                 [--raise-approval | --approval <id>] [--reauthenticated]

  agents credential mint <agent> --kind <bearer|jwt|hmac|envelope> --label <text>
                    --reauthenticated [--expires <iso>]
                    [--issuer <iss> --audience <aud> --jwks <path>]
                    [--secret-ref <name>] [--public-key-file <path>]
  agents credential list <agent>
  agents credential revoke <credentialId> --reason <code> [--note <text>]

  agents runs [<agent>] [--status <a,b>] [--limit <n>]
  agents parked [<agent>] [--status <a,b>] [--limit <n>]

Reasons are typed. Run any of contain, release, revoke, or credential revoke
without --reason to see the vocabulary for that verb.

Enrolling and revoking are high-consequence: each needs an approval a different
person granted, and a fresh re-authentication. Raise the approval with
--raise-approval, have somebody else decide it, then pass --approval <id>.

Exit codes:
  0   the thing happened
  1   refused, or "agents parked" found an indeterminate action
  2   the command was not usable as written
  78  this deployment has no external-agent plane configured
`.trim();

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
  // so `--reason` with nothing after it produces "a reason is required" rather
  // than recording the literal word "true" as the reason an agent was stopped.
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

function requireNumber(args: CommandArgs, name: string): number {
  const raw = requireFlag(args, name);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new InvalidInputError(`--${name} must be a number, received "${raw}"`, name);
  }
  return value;
}

/** Money for a terminal. Sub-dollar amounts keep four places; see console format.ts. */
function usd(amount: number): string {
  const digits = amount !== 0 && Math.abs(amount) < 1 ? 4 : 2;
  return `$${amount.toFixed(digits)}`;
}

function csv(args: CommandArgs, name: string): readonly string[] | undefined {
  const raw = first(args, name);
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// Views — what the CLI is allowed to print
// ---------------------------------------------------------------------------

/**
 * A credential as an operator may see it.
 *
 * Built field by field from a whitelist rather than by spreading the record and
 * deleting what should not be there. A spread would carry any field a future
 * credential kind adds — including whatever material that kind stores — into
 * every log, pipe, and evidence file this command writes, and nobody would
 * notice until it was in one.
 *
 * `tokenHash` and `publicKey` are both omitted. The hash is not the token, but
 * printing it hands an offline attacker an oracle for guesses at no benefit to
 * anybody; the pinned public key is genuinely public and simply too long to be
 * useful in a list. Neither is needed to answer the question this view exists
 * for, which is "which credentials does this agent hold, and are any of them
 * about to expire".
 */
export interface CredentialLine {
  readonly credentialId: string;
  readonly agentId: string;
  readonly kind: CredentialKind;
  readonly label: string;
  readonly strong: boolean;
  readonly issuer?: string | undefined;
  readonly audience?: string | undefined;
  readonly jwksPath?: string | undefined;
  /** The NAME resolved from the secret manager. Never a value. */
  readonly secretRef?: string | undefined;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt?: string | undefined;
  readonly revokedAt?: string | undefined;
  readonly revokedBy?: string | undefined;
  readonly revokedReason?: string | undefined;
  readonly lastUsedAt?: string | undefined;
}

export function credentialLine(credential: AgentCredential): CredentialLine {
  return {
    credentialId: credential.id,
    agentId: credential.agentId,
    kind: credential.kind,
    label: credential.label,
    strong: isStrongCredentialKind(credential.kind),
    issuer: credential.issuer,
    audience: credential.audience,
    jwksPath: credential.jwksPath,
    secretRef: credential.secretRef,
    createdBy: credential.createdBy,
    createdAt: credential.createdAt,
    expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt,
    revokedBy: credential.revokedBy,
    revokedReason: credential.revokedReason,
    lastUsedAt: credential.lastUsedAt,
  };
}

/** True when this credential can still authenticate at `nowIso`. */
export function credentialIsLive(credential: AgentCredential, nowIso: string): boolean {
  if (credential.revokedAt !== undefined) return false;
  return credential.expiresAt === undefined || credential.expiresAt > nowIso;
}

/** The credential KINDS an agent currently holds. Never a value, never a hash. */
export function heldCredentialKinds(
  credentials: readonly AgentCredential[],
  nowIso: string,
): readonly CredentialKind[] {
  const kinds = new Set<CredentialKind>();
  for (const credential of credentials) {
    if (credentialIsLive(credential, nowIso)) kinds.add(credential.kind);
  }
  return [...kinds].sort();
}

export interface AgentLine {
  readonly agentId: string;
  readonly name: string;
  readonly owner: string;
  readonly department: string;
  readonly hostPlatform: string;
  readonly purpose: string;
  readonly status: EnrolledAgent["status"];
  readonly statusReason?: string | undefined;
  readonly statusChangedAt?: string | undefined;
  readonly riskCeiling: RiskTier;
  readonly budgetPeriod: EnrolledAgent["budgetPeriod"];
  readonly periodKey: string;
  readonly spentUsd: number;
  readonly spendCeilingUsd: number;
  readonly overBudget: boolean;
  readonly wallClockCeilingMs: number;
  readonly allowedTools: readonly string[];
  readonly dataScopes: readonly string[];
  readonly credentialKinds: readonly CredentialKind[];
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly lastSeenAt?: string | undefined;
  readonly enrolledBy: string;
  readonly enrolledAt: string;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface AgentsCommandContext {
  readonly plane: ExternalPlane;
  /** The platform's approval queue, so `--raise-approval` parks a real one. */
  readonly approvals: ApprovalService;
  /**
   * The instant every read is rendered against.
   *
   * Passed in rather than read, so a roster printed twice from the same clock
   * agrees with itself about which budget period it is in, and so this file
   * stays inside the rule that only `kernel/clock.ts` reads the wall clock.
   */
  readonly nowIso: () => string;
  /** The operator, as main.ts attributes them. Unverified, and marked `cli:`. */
  readonly actor: ActorRef;
  readonly correlationId?: string | undefined;
}

export async function commandAgents(
  args: CommandArgs,
  context: AgentsCommandContext,
): Promise<number> {
  try {
    return await dispatch(args, context);
  } catch (error) {
    // A malformed command is a usage error, not a crash. `InvalidInputError` is
    // "your request does not make sense", which deserves the message and exit
    // code 2 rather than a stack trace that reads like the platform broke.
    //
    // `DeniedError` is deliberately NOT caught here. A refusal is an outcome
    // the operator has to see with its reason code, and it propagates to the
    // top-level handler that prints it and exits non-zero.
    if (error instanceof InvalidInputError) {
      note(`${error.message}${error.field ? ` (${error.field})` : ""}`);
      return 2;
    }
    throw error;
  }
}

async function dispatch(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const sub = args.positional[1];

  switch (sub) {
    case "list":
      return await listAgents(args, context);
    case "show":
      return await showAgent(args, context);
    case "health":
      return await agentHealth(args, context);
    case "enroll":
      return await enrollAgent(args, context);
    case "update":
      return await updateAgent(args, context);
    case "contain":
      return await containAgent(args, context);
    case "release":
      return await releaseAgent(args, context);
    case "revoke":
      return await revokeAgent(args, context);
    case "credential":
      return await credentialVerb(args, context);
    case "runs":
      return await listRuns(args, context);
    case "parked":
      return await listParked(args, context);
    default:
      note(`Unknown agents subcommand: ${sub ?? "(none)"}\n`);
      note(AGENTS_USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function agentLine(
  plane: ExternalPlane,
  agent: EnrolledAgent,
  nowIso: string,
): Promise<AgentLine> {
  const periodKey = agent.budgetPeriod === "lifetime" ? "lifetime" : nowIso.slice(0, 7);
  const meter = await plane.stores.spend.getMeter(agent.id, periodKey);
  const spentUsd = meter?.spentUsd ?? 0;
  const credentials = await plane.credentials.list(agent.id);

  return {
    agentId: agent.id,
    name: agent.name,
    owner: agent.owner,
    department: agent.department,
    hostPlatform: agent.hostPlatform,
    purpose: agent.purpose,
    status: agent.status,
    statusReason: agent.statusReason,
    statusChangedAt: agent.statusChangedAt,
    riskCeiling: agent.riskCeiling,
    budgetPeriod: agent.budgetPeriod,
    periodKey,
    spentUsd,
    spendCeilingUsd: agent.spendCeilingUsd,
    overBudget: spentUsd >= agent.spendCeilingUsd,
    wallClockCeilingMs: agent.wallClockCeilingMs,
    allowedTools: agent.allowedTools.map((grant) =>
      grant.operatorRisk ? `${grant.tool}:${grant.operatorRisk}` : grant.tool,
    ),
    dataScopes: [...agent.dataScopes],
    credentialKinds: heldCredentialKinds(credentials, nowIso),
    expiresAt: agent.expiresAt,
    expired: agent.expiresAt <= nowIso,
    lastSeenAt: agent.lastSeenAt,
    enrolledBy: agent.enrolledBy,
    enrolledAt: agent.enrolledAt,
  };
}

async function listAgents(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  const nowIso = context.nowIso();

  const status = csv(args, "status") as readonly EnrolledAgent["status"][] | undefined;
  const department = first(args, "department");

  const agents = await plane.enrollment.list({
    ...(status ? { status } : {}),
    ...(department !== undefined ? { department } : {}),
  });

  let lines = await Promise.all(agents.map((agent) => agentLine(plane, agent, nowIso)));
  if (flagPresent(args, "contained")) lines = lines.filter((line) => line.status === "contained");
  if (flagPresent(args, "over-budget")) lines = lines.filter((line) => line.overBudget);

  if (args.json) {
    // A bare array, matching `pv actions list --json`: the consumer here is jq,
    // not a browser that needs paging metadata.
    emit(lines, args);
    return 0;
  }

  if (lines.length === 0) {
    note(
      "No external agent matches. If nothing at all is enrolled while this plane is switched on, every figure the platform reports about external agents is a zero it has not earned — run `pv agents health`.",
    );
    return 0;
  }

  console.log(
    `${"NAME".padEnd(24)} ${"HOST".padEnd(18)} ${"OWNER".padEnd(26)} ${"DEPARTMENT".padEnd(18)} ${"STATE".padEnd(11)} ${"SPEND / CEILING".padEnd(24)} ${"LAST SEEN".padEnd(22)} CREDENTIALS`,
  );
  for (const line of lines) {
    // Both conditions are written out as words. A terminal has colour and a
    // pipe does not, and the operator most likely to be reading this is reading
    // it through `less` on a monochrome session.
    const state =
      line.status === "contained"
        ? "CONTAINED"
        : line.status === "revoked"
          ? "revoked"
          : line.expired
            ? "EXPIRED"
            : "active";
    const spend = `${usd(line.spentUsd)} / ${usd(line.spendCeilingUsd)} ${line.overBudget ? "OVER" : ""}`;
    console.log(
      `${line.name.padEnd(24)} ${line.hostPlatform.padEnd(18)} ${line.owner.padEnd(26)} ${line.department.padEnd(18)} ${state.padEnd(11)} ${spend.padEnd(24)} ${(line.lastSeenAt ?? "never").padEnd(22)} ${line.credentialKinds.join(",") || "none"}`,
    );
  }

  const contained = lines.filter((line) => line.status === "contained").length;
  const over = lines.filter((line) => line.overBudget).length;
  note(
    `${lines.length} agent(s). ${contained} contained, ${over} over budget for the current period.`,
  );
  return 0;
}

async function showAgent(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  const nowIso = context.nowIso();
  const agent = await resolveAgent(plane, args.positional[2]);

  const line = await agentLine(plane, agent, nowIso);
  const credentials = (await plane.credentials.list(agent.id)).map(credentialLine);
  const meters = await plane.stores.spend.listMeters(agent.id);
  const runs = await plane.stores.runs.listExternalRuns({ agentId: agent.id, limit: 10 });
  const parked = await plane.stores.parked.listParkedActions({ agentId: agent.id, limit: 10 });

  if (args.json) {
    emit({ agent: line, credentials, meters, recentRuns: runs, parkedActions: parked }, args);
    return 0;
  }

  console.log(`name              ${line.name}`);
  console.log(`id                ${line.agentId}`);
  console.log(`owner             ${line.owner}`);
  console.log(`department        ${line.department}`);
  console.log(`host platform     ${line.hostPlatform}`);
  console.log(`purpose           ${line.purpose}`);
  console.log(
    `state             ${line.status.toUpperCase()}${line.statusReason ? ` — ${line.statusReason}` : ""}`,
  );
  console.log(`risk ceiling      ${line.riskCeiling}`);
  console.log(
    `spend             ${usd(line.spentUsd)} of ${usd(line.spendCeilingUsd)} (${line.budgetPeriod}, period ${line.periodKey})${line.overBudget ? "  OVER CEILING" : ""}`,
  );
  console.log(`wall clock        ${line.wallClockCeilingMs} ms per run`);
  console.log(`tools             ${line.allowedTools.join(", ") || "(none granted)"}`);
  console.log(`data scopes       ${line.dataScopes.join(", ") || "(none granted)"}`);
  console.log(`expires           ${line.expiresAt}${line.expired ? "  EXPIRED" : ""}`);
  console.log(`last seen         ${line.lastSeenAt ?? "never"}`);
  console.log(`enrolled          ${line.enrolledAt} by ${line.enrolledBy}`);
  console.log(`credential kinds  ${line.credentialKinds.join(", ") || "none held"}`);

  console.log("");
  console.log(`CREDENTIALS (${credentials.length})`);
  for (const credential of credentials) {
    const state = credential.revokedAt !== undefined ? "REVOKED" : "live";
    console.log(
      `  ${credential.credentialId}  ${credential.kind.padEnd(9)} ${state.padEnd(8)} ${credential.label}${credential.expiresAt ? `  expires ${credential.expiresAt}` : "  no expiry"}`,
    );
  }

  console.log("");
  console.log(`RECENT RUNS (${runs.length})`);
  for (const run of runs) {
    console.log(
      `  ${run.id}  ${run.status.padEnd(10)} ${usd(run.costUsd).padEnd(10)} ${run.startedAt}  ${run.goal}`,
    );
  }

  console.log("");
  console.log(`PARKED ACTIONS (${parked.length})`);
  for (const action of parked) {
    console.log(
      `  ${action.id}  ${action.status.padEnd(13)} ${action.integration}.${action.operation}  expires ${action.expiresAt}`,
    );
  }

  // The whole point of separating the streams: an operator reading this on a
  // screen sees the warning, and a file redirected out of it stays clean.
  if (line.status === "contained") {
    note(
      `\n${line.name} is CONTAINED and is refused at every admission check and at its next heartbeat. Release it with: pv agents release ${line.name} --reason <code>`,
    );
  }
  if (line.overBudget) {
    note(
      `\n${line.name} has reached its ${line.budgetPeriod} ceiling and is refused on spend until the ceiling is raised or the period rolls over. Nothing here clears a meter.`,
    );
  }
  return 0;
}

async function agentHealth(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  const health = plane.enabled
    ? await externalAgentHealth(externalHealthPorts(plane.stores), context.nowIso())
    : EXTERNAL_PLANE_DISABLED;

  if (args.json) {
    emit(health, args);
    return 0;
  }

  printAgentHealth(health);
  return 0;
}

/** Shared with `pv health`, so the two can never tell different stories. */
export function printAgentHealth(health: ExternalAgentHealth): void {
  if (!health.planeEnabled) {
    console.log("external agents   no plane configured in this deployment");
    return;
  }

  console.log(`external agents   ${health.enrolledCount} enrolled, ${health.activeCount} active`);
  if (health.enabledWithNothingEnrolled) {
    console.log(
      "                  PLANE ENABLED, NOTHING ENROLLED — every external figure this platform reports is a zero it has not earned",
    );
  }
  console.log(
    `  contained       ${health.contained.length === 0 ? "none" : health.contained.map((row) => row.name).join(", ")}`,
  );
  console.log(
    `  over budget     ${health.overBudget.length === 0 ? "none" : health.overBudget.map((row) => `${row.name} (${usd(row.spentUsd)} of ${usd(row.ceilingUsd)})`).join(", ")}`,
  );
  console.log(
    `  credentials     ${health.credentialsNearingExpiry.length === 0 ? `none expiring within ${health.expiryHorizonDays} days` : health.credentialsNearingExpiry.map((row) => `${row.agentName}/${row.label} ${row.expired ? "EXPIRED" : "expires"} ${row.expiresAt}`).join(", ")}`,
  );
}

async function listRuns(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  const reference = args.positional[2];
  const agent = reference === undefined ? null : await resolveAgent(plane, reference);
  const status = csv(args, "status") as readonly ExternalRunStatus[] | undefined;
  const limitRaw = first(args, "limit");

  const runs = await plane.stores.runs.listExternalRuns({
    ...(agent ? { agentId: agent.id } : {}),
    ...(status ? { status } : {}),
    limit: limitRaw === undefined ? 50 : Number(limitRaw),
  });

  if (args.json) {
    emit(runs, args);
    return 0;
  }

  if (runs.length === 0) {
    note("No external runs match.");
    return 0;
  }

  console.log(
    `${"EXTERNAL RUN".padEnd(28)} ${"RECORD RUN".padEnd(28)} ${"STATUS".padEnd(11)} ${"COST".padEnd(10)} ${"STARTED".padEnd(26)} GOAL`,
  );
  for (const run of runs) {
    console.log(
      `${run.id.padEnd(28)} ${run.runId.padEnd(28)} ${run.status.padEnd(11)} ${usd(run.costUsd).padEnd(10)} ${run.startedAt.padEnd(26)} ${run.goal}`,
    );
  }
  note(
    `${runs.length} run(s). A "reclaimed" run is one that stopped heartbeating: nobody heard from it, which is not the same as it having failed.`,
  );
  return 0;
}

async function listParked(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  const reference = args.positional[2];
  const agent = reference === undefined ? null : await resolveAgent(plane, reference);
  const status = csv(args, "status") as readonly ParkedActionStatus[] | undefined;
  const limitRaw = first(args, "limit");

  const actions = await plane.stores.parked.listParkedActions({
    ...(agent ? { agentId: agent.id } : {}),
    ...(status ? { status } : {}),
    limit: limitRaw === undefined ? 50 : Number(limitRaw),
  });

  if (args.json) {
    emit(actions, args);
  } else if (actions.length === 0) {
    note("No parked actions match.");
  } else {
    console.log(
      `${"PARKED ACTION".padEnd(28)} ${"AGENT".padEnd(28)} ${"STATUS".padEnd(14)} ${"OPERATION".padEnd(32)} EXPIRES`,
    );
    for (const action of actions) {
      console.log(
        `${action.id.padEnd(28)} ${action.agentId.padEnd(28)} ${action.status.padEnd(14)} ${`${action.integration}.${action.operation}`.padEnd(32)} ${action.expiresAt}`,
      );
    }
    note(`${actions.length} parked action(s).`);
  }

  const indeterminate = actions.filter((action) => action.status === "indeterminate");
  if (indeterminate.length > 0) {
    note(
      `\n${indeterminate.length} parked action(s) are INDETERMINATE. The worker died between starting the effect and recording it, so each may or may not have landed. Nothing retries them: go and look in the system of record, because a button that might duplicate a payment is worse than a person checking.`,
    );
    for (const action of indeterminate) {
      note(`  ${action.id}  ${action.integration}.${action.operation}  agent ${action.agentId}`);
    }
    // Non-zero on purpose. This verb is meant to be wired to a scheduler, and a
    // check that exits zero while a write may or may not have landed is worse
    // than no check at all.
    return 1;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Refuse to invent a step-up the platform cannot observe.
 *
 * The command line cannot verify who is typing — `main.ts` says so where it
 * builds the actor. What it can rely on is that somebody got onto this host,
 * which is the deployment's own authentication. `--reauthenticated` is that
 * fact, asserted explicitly by the operator, and it is required rather than
 * assumed: a high-consequence action that quietly counted "we are on a
 * terminal" as re-authentication would make the step-up requirement decorative
 * for every headless install.
 */
function stepUpSeconds(args: CommandArgs, action: string): number {
  if (!flagPresent(args, "reauthenticated")) {
    throw new DeniedError(
      "authorization.step_up_required",
      `${action} requires a fresh re-authentication. The command line cannot verify one, so it is asserted: re-authenticate to this host and pass --reauthenticated. The audit record shows the action came from the CLI, so the assertion is visible to whoever reviews it.`,
      { action },
    );
  }
  return 0;
}

function operatorContext(
  args: CommandArgs,
  context: AgentsCommandContext,
  stepUp?: number,
): OperatorContext {
  const approvalId = first(args, "approval");
  return {
    actor: context.actor,
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    ...(approvalId !== undefined ? { approvalId: approvalId as Id<"approval"> } : {}),
    ...(stepUp !== undefined ? { secondsSinceAuthentication: stepUp } : {}),
  };
}

function readEnrollRequest(args: CommandArgs): EnrollRequest {
  return {
    name: requireFlag(args, "name"),
    owner: requireFlag(args, "owner"),
    department: requireFlag(args, "department"),
    hostPlatform: requireFlag(args, "host"),
    purpose: requireFlag(args, "purpose"),
    allowedTools: parseTools(many(args, "tool")),
    riskCeiling: requireFlag(args, "risk-ceiling") as RiskTier,
    spendCeilingUsd: requireNumber(args, "spend-ceiling"),
    budgetPeriod: requireFlag(args, "budget-period") as EnrolledAgent["budgetPeriod"],
    wallClockCeilingMs: requireNumber(args, "wall-clock-ms"),
    dataScopes: many(args, "scope"),
    expiresAt: requireFlag(args, "expires"),
  };
}

/**
 * `--tool name` or `--tool name:tier`.
 *
 * Split on the LAST colon, and only when what follows is a risk tier. External
 * tool names are chosen by whoever built the agent and may themselves contain a
 * colon — `crm:issue_refund` is an ordinary name — so splitting on the first
 * one would silently enroll a tool called `crm` and drop the rest of the name.
 */
export function parseTools(
  entries: readonly string[],
): readonly { readonly tool: string; readonly operatorRisk?: RiskTier | undefined }[] {
  const tiers = new Set(["routine", "sensitive", "high_consequence", "prohibited"]);
  return entries.map((entry) => {
    const at = entry.lastIndexOf(":");
    if (at <= 0) return { tool: entry };
    const suffix = entry.slice(at + 1);
    if (!tiers.has(suffix)) return { tool: entry };
    return { tool: entry.slice(0, at), operatorRisk: suffix as RiskTier };
  });
}

async function enrollAgent(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  const request = readEnrollRequest(args);

  if (flagPresent(args, "raise-approval")) {
    // The digest is computed from the raw request the operator will submit, so
    // the approval binds to exactly this enrollment and nothing else. Changing
    // one flag afterwards produces a different digest and the chokepoint
    // refuses — which is the point of binding rather than merely recording.
    const approval = await context.approvals.request({
      action: ENROLL_ACTION,
      proposalDigest: enrollmentProposalDigest(request),
      summary: `Enroll external agent "${request.name}" on ${request.hostPlatform}, owned by ${request.owner} (${request.department}), ceiling ${usd(request.spendCeilingUsd)} ${request.budgetPeriod}, risk up to ${request.riskCeiling}, expiring ${request.expiresAt}.`,
      requestedBy: context.actor,
      approvalsRequired: 1,
      eligibleRoles: ["supervisor", "compliance_reviewer", "platform_admin"],
      subject: {
        externalAgentName: request.name,
        owner: request.owner,
        department: request.department,
        hostPlatform: request.hostPlatform,
      },
      ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    });
    note(
      `Approval ${approval.id} raised. Somebody other than ${context.actor.actorId} must grant it — nobody approves their own proposal — and then:\n  pv agents enroll ... --approval ${approval.id} --reauthenticated`,
    );
    emit(args.json ? { approvalId: approval.id } : approval.id, args);
    return 0;
  }

  const agent = await plane.enrollment.enroll(
    operatorContext(args, context, stepUpSeconds(args, "Enrolling an external agent")),
    request,
  );

  note(
    `Enrolled ${agent.name} (${agent.id}) on ${agent.hostPlatform}, owned by ${agent.owner}. It holds no credential yet and cannot authenticate until one is minted.`,
  );
  emit(args.json ? await agentLine(plane, agent, context.nowIso()) : agent.id, args);
  return 0;
}

/**
 * Flags a caller might reach for hoping re-enrollment applies them.
 *
 * Refused by name rather than ignored. Re-enrollment adjusts ceilings; it never
 * resets a spend meter and never changes status. Silently dropping one of these
 * would leave an operator believing they had cleared a meter or lifted a
 * containment when nothing happened, which is the worst of the three possible
 * outcomes.
 */
const REFUSED_UPDATE_FLAGS: Readonly<Record<string, string>> = {
  status: "Use contain, release, or revoke. Re-enrollment never changes status.",
  contain: "Use `pv agents contain`.",
  release: "Use `pv agents release`.",
  revoke: "Use `pv agents revoke`.",
  spend: "There is no operation anywhere in this platform that clears a spend meter.",
  "reset-spend": "There is no operation anywhere in this platform that clears a spend meter.",
  meter: "There is no operation anywhere in this platform that clears a spend meter.",
  name: "An agent's name is its handle in the roster, in an incident, and in the audit chain. It is assigned once.",
};

async function updateAgent(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  const agent = await resolveAgent(plane, args.positional[2]);

  for (const [flag, guidance] of Object.entries(REFUSED_UPDATE_FLAGS)) {
    if (flagPresent(args, flag)) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `Re-enrollment cannot set --${flag}. ${guidance}`,
        { agentId: agent.id, flag },
      );
    }
  }

  const update: Record<string, unknown> = {};
  const owner = first(args, "owner");
  if (owner !== undefined) update["owner"] = owner;
  const department = first(args, "department");
  if (department !== undefined) update["department"] = department;
  const host = first(args, "host");
  if (host !== undefined) update["hostPlatform"] = host;
  const purpose = first(args, "purpose");
  if (purpose !== undefined) update["purpose"] = purpose;
  const riskCeiling = first(args, "risk-ceiling");
  if (riskCeiling !== undefined) update["riskCeiling"] = riskCeiling;
  if (flagPresent(args, "spend-ceiling")) {
    update["spendCeilingUsd"] = requireNumber(args, "spend-ceiling");
  }
  const budgetPeriod = first(args, "budget-period");
  if (budgetPeriod !== undefined) update["budgetPeriod"] = budgetPeriod;
  if (flagPresent(args, "wall-clock-ms")) {
    update["wallClockCeilingMs"] = requireNumber(args, "wall-clock-ms");
  }
  const expires = first(args, "expires");
  if (expires !== undefined) update["expiresAt"] = expires;

  const tools = many(args, "tool");
  if (tools.length > 0) update["allowedTools"] = parseTools(tools);
  const scopes = many(args, "scope");
  if (scopes.length > 0) update["dataScopes"] = scopes;

  if (Object.keys(update).length === 0) {
    note(
      "Nothing to change. A re-enrollment that changes nothing writes a new timestamp and reads in the roster like a review that happened.",
    );
    return 2;
  }

  if (tools.length > 0 || scopes.length > 0) {
    // Replacement, not addition. Said out loud because the opposite assumption
    // is the natural one and the cost of being wrong is a grant nobody meant to
    // withdraw — or, worse, one nobody meant to keep.
    note(
      "--tool and --scope REPLACE the whole grant rather than adding to it. Pass every tool and scope the agent should still hold.",
    );
  }

  const updated = await plane.enrollment.reEnroll(
    operatorContext(args, context),
    agent.id,
    update as EnrollmentUpdate,
  );

  note(`Updated ${updated.name} (${updated.id}). Its spend meter and its status are unchanged.`);
  emit(args.json ? await agentLine(plane, updated, context.nowIso()) : updated.id, args);
  return 0;
}

function typedReason(
  args: CommandArgs,
  vocabulary: Readonly<Record<string, string>>,
  verb: string,
): string {
  const code = first(args, "reason");
  if (code === undefined) {
    note(`--reason is required for ${verb}. It must be one of:`);
    for (const [name, meaning] of Object.entries(vocabulary).sort()) {
      note(`  ${name.padEnd(24)} ${meaning}`);
    }
    note("Add free text with --note. The note is recorded alongside the code, never instead of it.");
    throw new InvalidInputError(`--reason is required for ${verb}`, "reason");
  }
  return composeReason(vocabulary, code, first(args, "note"));
}

async function containAgent(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  // The reason first, then the lookup. Validating it costs nothing and needs no
  // store, so an operator who typed the verb without a reason is shown the
  // vocabulary immediately rather than being told the agent name is wrong.
  const reason = typedReason(args, CONTAINMENT_REASONS, "containment");
  const agent = await resolveAgent(plane, args.positional[2]);

  const contained = await plane.enrollment.contain(operatorContext(args, context), agent.id, reason);

  note(
    `CONTAINED ${contained.name} (${contained.id}) — ${reason}\nIt is refused at every admission check from now on, and told to stop at its next heartbeat. A run already in flight elsewhere stops when it next asks us something; we hold no handle on somebody else's process.`,
  );
  emit(args.json ? await agentLine(plane, contained, context.nowIso()) : contained.id, args);
  return 0;
}

async function releaseAgent(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  // The reason first, then the lookup. Validating it costs nothing and needs no
  // store, so an operator who typed the verb without a reason is shown the
  // vocabulary immediately rather than being told the agent name is wrong.
  const reason = typedReason(args, RELEASE_REASONS, "release");
  const agent = await resolveAgent(plane, args.positional[2]);

  const released = await plane.enrollment.release(operatorContext(args, context), agent.id, reason);

  note(`RELEASED ${released.name} (${released.id}) — ${reason}`);
  emit(args.json ? await agentLine(plane, released, context.nowIso()) : released.id, args);
  return 0;
}

async function revokeAgent(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  // The reason first, then the lookup. Validating it costs nothing and needs no
  // store, so an operator who typed the verb without a reason is shown the
  // vocabulary immediately rather than being told the agent name is wrong.
  const reason = typedReason(args, REVOCATION_REASONS, "revocation");
  const agent = await resolveAgent(plane, args.positional[2]);

  if (flagPresent(args, "raise-approval")) {
    const approval = await context.approvals.request({
      action: REVOKE_ACTION,
      // Bound to the id AND the reason, so the approval an operator granted
      // cannot be spent on a revocation with a different justification attached.
      proposalDigest: revocationProposalDigest(agent.id, reason),
      summary: `Revoke external agent "${agent.name}" (${agent.id}) on ${agent.hostPlatform}, owned by ${agent.owner}. Terminal: the agent never acts again and its seat returns to the cap. Reason: ${reason}`,
      requestedBy: context.actor,
      approvalsRequired: 1,
      eligibleRoles: ["supervisor", "compliance_reviewer", "platform_admin"],
      subject: {
        externalAgentId: agent.id,
        externalAgentName: agent.name,
        owner: agent.owner,
        department: agent.department,
      },
      ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    });
    note(
      `Approval ${approval.id} raised. Somebody other than ${context.actor.actorId} must grant it, and then:\n  pv agents revoke ${agent.name} --reason ${first(args, "reason") ?? ""}${first(args, "note") !== undefined ? ` --note "${first(args, "note") ?? ""}"` : ""} --approval ${approval.id} --reauthenticated\nThe reason must be identical: the approval is bound to it.`,
    );
    emit(args.json ? { approvalId: approval.id } : approval.id, args);
    return 0;
  }

  const revoked = await plane.enrollment.revoke(
    operatorContext(args, context, stepUpSeconds(args, "Revoking an external agent")),
    agent.id,
    reason,
  );

  note(
    `REVOKED ${revoked.name} (${revoked.id}) — ${reason}\nThis is terminal. There is no release from it: bringing this agent back is a fresh enrollment, which is another approved decision.`,
  );
  emit(args.json ? await agentLine(plane, revoked, context.nowIso()) : revoked.id, args);
  return 0;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

async function credentialVerb(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const verb = args.positional[2];
  switch (verb) {
    case "mint":
      return await mintCredential(args, context);
    case "list":
      return await listCredentials(args, context);
    case "revoke":
      return await revokeCredential(args, context);
    default:
      note(`Unknown credential subcommand: ${verb ?? "(none)"}. Try: mint, list, revoke.`);
      return 2;
  }
}

async function mintCredential(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  const agent = await resolveAgent(plane, args.positional[3]);

  if (agent.status === "revoked") {
    throw new DeniedError(
      "authorization.action_not_permitted",
      `External agent ${agent.name} (${agent.id}) is revoked, so a credential for it would authenticate a principal that may never act. Revocation is terminal; enroll a new agent instead.`,
      { agentId: agent.id, status: agent.status },
    );
  }

  const kindRaw = requireFlag(args, "kind");
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(kindRaw)) {
    throw new InvalidInputError(
      `--kind must be one of: ${CREDENTIAL_KINDS.join(", ")}`,
      "kind",
    );
  }
  const kind = kindRaw as CredentialKind;

  const publicKeyFile = first(args, "public-key-file");
  const minted = await plane.credentials.mint({
    agentId: agent.id,
    kind,
    label: requireFlag(args, "label"),
    createdBy: context.actor.actorId,
    ...(first(args, "expires") !== undefined ? { expiresAt: requireFlag(args, "expires") } : {}),
    ...(first(args, "issuer") !== undefined ? { issuer: requireFlag(args, "issuer") } : {}),
    ...(first(args, "audience") !== undefined ? { audience: requireFlag(args, "audience") } : {}),
    ...(first(args, "jwks") !== undefined ? { jwksPath: requireFlag(args, "jwks") } : {}),
    ...(first(args, "secret-ref") !== undefined
      ? { secretRef: requireFlag(args, "secret-ref") }
      : {}),
    ...(publicKeyFile !== undefined ? { publicKey: readFileSync(publicKeyFile, "utf8") } : {}),
    // Minting is how an agent gets the ability to act at all. It is gated on a
    // fresh re-authentication in the service, not only here, so the API and the
    // console cannot reach a laxer path to the same effect.
    requireStepUp: true,
    stepUpSatisfied: flagPresent(args, "reauthenticated"),
  });

  const line = credentialLine(minted.credential);

  if (minted.token !== undefined) {
    // The one moment this value exists outside the agent that will use it. The
    // warning goes to stderr and the token to stdout, so
    // `... --json | jq -r .token > /run/secrets/x` works and the warning is
    // still read by the person running it.
    note(
      "This bearer token is shown ONCE. It is stored only as a hash, so nothing here, in the console, or in the API can ever show it again. If it is lost, mint a replacement and revoke this one.",
    );
  }
  if (isStrongCredentialKind(kind)) {
    note(
      `${agent.name} now holds a signed credential, so plain bearer authentication is refused for it. A leaked bearer token cannot be used to impersonate an agent that has done the work to sign its requests.`,
    );
  }

  if (args.json) {
    emit({ credential: line, token: minted.token, tokenShownOnce: minted.token !== undefined }, args);
    return 0;
  }

  if (minted.token !== undefined) {
    // The answer, alone on stdout.
    console.log(minted.token);
  } else {
    console.log(line.credentialId);
  }
  note(`Minted ${line.kind} credential ${line.credentialId} ("${line.label}") for ${agent.name}.`);
  return 0;
}

async function listCredentials(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  const nowIso = context.nowIso();
  const agent = await resolveAgent(plane, args.positional[3]);
  const credentials = (await plane.credentials.list(agent.id)).map(credentialLine);

  if (args.json) {
    emit(credentials, args);
    return 0;
  }

  if (credentials.length === 0) {
    note(`${agent.name} holds no credentials and therefore cannot authenticate.`);
    return 0;
  }

  console.log(
    `${"CREDENTIAL".padEnd(28)} ${"KIND".padEnd(9)} ${"STRONG".padEnd(7)} ${"STATE".padEnd(9)} ${"EXPIRES".padEnd(26)} ${"LAST USED".padEnd(26)} LABEL`,
  );
  for (const credential of credentials) {
    const state =
      credential.revokedAt !== undefined
        ? "REVOKED"
        : credential.expiresAt !== undefined && credential.expiresAt <= nowIso
          ? "EXPIRED"
          : "live";
    console.log(
      `${credential.credentialId.padEnd(28)} ${credential.kind.padEnd(9)} ${(credential.strong ? "yes" : "no").padEnd(7)} ${state.padEnd(9)} ${(credential.expiresAt ?? "never").padEnd(26)} ${(credential.lastUsedAt ?? "never").padEnd(26)} ${credential.label}`,
    );
  }
  note(
    `${credentials.length} credential(s). No credential value is stored, so none can be shown — a bearer token is held as a hash and an HMAC secret as a name resolved from the secret manager.`,
  );
  return 0;
}

async function revokeCredential(args: CommandArgs, context: AgentsCommandContext): Promise<number> {
  const { plane } = context;
  const credentialId = args.positional[3];
  if (credentialId === undefined) {
    note("A credential id is required: pv agents credential revoke <credentialId> --reason <code>");
    return 2;
  }
  const reason = typedReason(args, CREDENTIAL_REVOCATION_REASONS, "credential revocation");

  const revoked = await plane.credentials.revoke(
    credentialId as Id<"credential">,
    context.actor.actorId,
    reason,
  );

  note(
    `REVOKED credential ${revoked.id} (${revoked.kind}, "${revoked.label}") for agent ${revoked.agentId} — ${reason}\nIt authenticates nothing from this moment. Requests already in flight elsewhere are refused at their next admission check.`,
  );
  emit(args.json ? credentialLine(revoked) : revoked.id, args);
  return 0;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an agent from an id or a name.
 *
 * Operators think in names and the record thinks in ids, and forcing an
 * operator to look up an id first is how a stop button gets pressed a minute
 * late. The name is tried first and exactly — never case-insensitively —
 * because two enrollments differing only in capitalisation are two agents with
 * two owners and two ceilings, and matching loosely would act on the wrong one.
 */
async function resolveAgent(
  plane: ExternalPlane,
  reference: string | undefined,
): Promise<EnrolledAgent> {
  if (reference === undefined || reference.length === 0) {
    throw new InvalidInputError(
      "An agent is required: its name, or its identifier.",
      "agent",
    );
  }
  const byName = await plane.stores.agents.getAgentByName(reference);
  if (byName) return byName;
  return plane.enrollment.require(reference as ExternalAgentId);
}

