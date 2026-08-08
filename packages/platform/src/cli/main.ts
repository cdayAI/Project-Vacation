#!/usr/bin/env node
import { loadConfig } from "../kernel/config.js";
import { DeniedError } from "../kernel/errors.js";
import { formatVerificationResult, verifyChain } from "../audit/chain.js";
import {
  buildPlatform,
  describeConfig,
  migrate,
  migrationState,
  type Platform,
} from "../platform.js";

/**
 * The operator command line.
 *
 * Two design rules, both aimed at the same failure: a command that appears to
 * have worked when it did not.
 *
 * Everything writes to stderr except the actual answer, which goes to stdout.
 * That is what makes `pv audit verify > evidence.txt` produce a clean artifact
 * and `pv cost report --json | jq` compose, without an operator having to strip
 * a banner out of their evidence file. `--json` is the only output switch, on
 * purpose: one convention that pipes into anything beats three that each cover
 * two thirds of the verbs. This comment used to promise a `--format csv` that
 * did not exist, which is the same defect as `db status` in the usage text
 * below — the file's own documentation advertising a command nobody built.
 *
 * Exit codes are meaningful. Zero means the thing succeeded. Non-zero means it
 * did not, and — importantly — a *verification failure* is non-zero too. The
 * audit verifier is likely to be wired into a scheduled job, and a job that
 * reports success while the chain is broken is worse than no job at all.
 */

const USAGE = `
Project Vacation — operator commands

  db migrate                      Apply pending schema migrations
  db status                       Show applied and pending migrations

  audit verify [--from N] [--to N]  Verify the audit chain; exits non-zero if broken
  audit head                      Show the current chain head
  audit query [filters]           Query audit entries
        --event-type <type>       (repeatable)
        --run <runId>
        --actor <actorId>
        --subject <key=value>     (repeatable; all must match)
        --correlation-id <id>
        --after <iso>  --before <iso>
        --limit <n>

  containment list                Show every containment switch
  containment engage --scope <global|workflow|role|integration>
                     [--target <name>] --reason <text>
  containment release --scope <...> [--target <name>] --reason <text>

  agents <verb>                   Govern the agents MVW runs elsewhere.
                                  list, show, health, enroll, update, contain,
                                  release, revoke, credential, runs, parked.
                                  Run "agents" alone for the full usage.

  roles <verb>                    Author, evaluate, promote, and stop the roles
                                  this platform runs. list, show, draft, golden,
                                  propose, promote, revert, disable, enable.
                                  Run "roles" alone for the full usage.

  contact <verb>                  Record consent and clear outbound messages
                                  through the compliance gate. consent grant,
                                  consent revoke, consent state, dnc add, check,
                                  send. Run "contact" alone for the full usage.

  knowledge <verb>                Ingest authority, answer regulated questions
                                  from cited corpora, and keep corpora fresh.
                                  corpus create, ingest, ask, freshness, review.
                                  Run "knowledge" alone for the full usage.

  workflow <verb>                 Start, drive, and inspect governed workflow
                                  instances through the engine. definitions,
                                  start, show, tasks, complete-task, signal.
                                  Run "workflow" alone for the full usage.

  actions list                    Show the action registry with risk tiers

  approvals list [--status <a,b>] [--ageing] [--within <minutes>]
                                  Parked human decisions, least time left first
  approvals decide <id> --grant|--reject --note <text> [--session-file <path>]
                                  Decide one, through the same chokepoint the
                                  console posts to. Granting a high-consequence
                                  action needs a session this platform can see
                                  the authentication instant of; rejecting does
                                  not. Run "approvals" alone for how to get one.
  cost report [--since <iso> | --hours <n>] [--group-by workflow,role]
                                  Spend in a window, and the runs that spent it
  models degradation [--since <iso> | --hours <n>]
                                  Fallback-chain walks, by task, hop, and cause
  engine timers [--overdue] [--late-by <seconds>]
                                  Timers waiting to fire, and the cases they hold

  evaluate [--ci]                 Measure promoted roles against their golden
                                  sets. --ci is the build gate: it also runs the
                                  golden set shipped in source, and says on every
                                  run what that set does and does not prove.

  config show                     Show effective configuration and warnings
  health                          Report platform health
  serve [--seed]                  Run the HTTP API. --seed serves the seeded
                                  demonstration from memory (development only)
  worker [--once]                 Run maintenance: expiries, sweeps, reclaims, retention
  demo run                        Run the seeded demonstration

Global:
  --json                          Machine-readable output where supported
  --help                          This message

Configuration comes from the environment. See .env.example.
`.trim();

interface Args {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string[]>>;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        (flags[name] ??= []).push("true");
      } else {
        (flags[name] ??= []).push(next);
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }

  return { positional, flags, json: flags.json !== undefined };
}

function first(args: Args, name: string): string | undefined {
  return args.flags[name]?.[0];
}

function require_(args: Args, name: string): string {
  const value = first(args, name);
  if (value === undefined || value === "true") {
    throw new Error(`--${name} is required`);
  }
  return value;
}

/** stderr, so stdout stays a clean artifact. */
function note(message: string): void {
  console.error(message);
}

function emit(value: unknown, args: Args): void {
  if (args.json) console.log(JSON.stringify(value, null, 2));
  else console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

/**
 * The operator running a command *is* the actor, and the CLI cannot verify who
 * that is. So CLI actions are attributed to an explicitly-named operator, and
 * the audit record shows both the name and that it came from the CLI rather
 * than from an authenticated console session. Anything less would make the
 * audit trail claim more than it knows.
 *
 * The role is asserted the same way, and for the same reason. `--role`
 * (repeatable) names the role the operator is acting in, defaulting to
 * `platform_admin` — which is what every verb assumed before `contact`, whose
 * actions are deliberately not an admin's to perform: `consent.record` is for
 * owner-services staff and their supervisors, and `contact.send_owner_message`
 * is a supervisor's. The command line cannot prove the operator holds the role
 * any more than it can prove their name, so it is stated and the audit record
 * shows it came from the CLI. The chokepoint still refuses a role the asserted
 * one does not include, so asserting one buys nothing an operator was not
 * already entitled to.
 */
function cliActor(args: Args): { actorId: string; kind: "human"; roles: string[] } {
  const operator = first(args, "operator") ?? process.env.USER ?? "unknown-operator";
  const roles = (args.flags.role ?? []).filter((role) => role !== "true");
  return {
    actorId: `cli:${operator}`,
    kind: "human",
    roles: roles.length > 0 ? roles : ["platform_admin"],
  };
}

// ---------------------------------------------------------------------------

async function commandDb(args: Args, platform: Platform): Promise<number> {
  const sub = args.positional[1];

  if (sub === "migrate") {
    const result = await migrate(platform);
    if (result.applied.length === 0) {
      note("No pending migrations. Schema is up to date.");
    } else {
      note(`Applied ${result.applied.length} migration(s):`);
      for (const id of result.applied) note(`  ${id}`);
    }
    emit({ applied: result.applied }, args);
    return 0;
  }

  if (sub === "status") {
    const status = await migrationState(platform);
    if (!status) {
      // Not "up to date". A deployment on the in-memory store has no schema at
      // all, and reporting it as migrated would tell an operator something
      // false about a database that does not exist.
      note(
        "This deployment has no schema: PV_STORE is not postgres, so there is nothing to migrate and nothing to report. Set PV_STORE=postgres and PV_DATABASE_URL.",
      );
      return 78; // EX_CONFIG
    }

    if (args.json) {
      emit(status, args);
    } else {
      const appliedById = new Map(status.applied.map((entry) => [entry.id, entry]));
      for (const entry of status.applied) {
        console.log(`applied      ${entry.id.padEnd(34)} ${entry.appliedAt}`);
      }
      for (const id of status.pending) {
        console.log(`PENDING      ${id}`);
      }
      for (const id of status.unrecognised) {
        console.log(`UNKNOWN      ${id.padEnd(34)} applied here, absent from this build`);
      }
      for (const changed of status.changed) {
        console.log(
          `CHANGED      ${changed.id.padEnd(34)} applied ${changed.appliedAt}; SQL has been edited since`,
        );
      }
      note(
        `${appliedById.size} applied, ${status.pending.length} pending, ${status.unrecognised.length} unrecognised, ${status.changed.length} changed.`,
      );
    }

    if (status.unrecognised.length > 0) {
      // Normal for minutes during a rolling deploy, and evidence of hand-applied
      // schema at any other time. Reported either way; refused neither way.
      note(
        "Migrations applied here are not in this build. During a rolling deploy that is an older instance seeing a newer one's work. Outside a deploy window it means somebody has been changing the schema by hand.",
      );
    }
    if (status.changed.length > 0) {
      note(
        "A released migration's SQL has been edited. `db migrate` will refuse to apply anything at all until the original SQL is restored and the change is expressed as a new migration — a half-migrated database is worse than an unmigrated one.",
      );
    }
    // Non-zero only for the state that stops migration entirely. Pending
    // migrations are the ordinary state of a machine that has not deployed yet
    // and are reported on stdout for a caller that wants to gate on them.
    return status.changed.length > 0 ? 1 : 0;
  }

  note(`Unknown db subcommand: ${sub ?? "(none)"}`);
  return 2;
}

async function commandAudit(args: Args, platform: Platform): Promise<number> {
  const sub = args.positional[1];

  if (sub === "verify") {
    const fromRaw = first(args, "from");
    const toRaw = first(args, "to");
    const from = fromRaw && fromRaw !== "true" ? Number(fromRaw) : undefined;
    const to = toRaw && toRaw !== "true" ? Number(toRaw) : undefined;

    const chain = await platform.audit.readChain(from, to);

    // Verifying a window rather than the whole chain needs the hash the window
    // is expected to start from. Without it, a legitimate window looks exactly
    // like a forged genesis, and the operator gets a false alarm.
    let anchor: string | undefined;
    if (from !== undefined && from > 1) {
      const previous = await platform.audit.readChain(from - 1, from - 1);
      anchor = previous[0]?.entryHash;
      if (!anchor) {
        note(
          `Cannot verify from sequence ${from}: entry ${from - 1} is not present, so there is nothing to anchor the window to.`,
        );
        return 1;
      }
    }

    // The watermark is what makes head truncation visible. Without it an
    // emptied table verifies as intact and this command exits zero, which is
    // the single most likely tampering going entirely unreported.
    const watermark = await platform.audit.watermark();
    const result = anchor
      ? verifyChain(chain, anchor, watermark)
      : verifyChain(chain, undefined, watermark);

    if (args.json) {
      emit(result, args);
    } else {
      console.log(formatVerificationResult(result));
    }

    // Non-zero on a broken chain: a scheduled verification job that exits zero
    // while the chain is broken is worse than no job at all.
    return result.intact ? 0 : 1;
  }

  if (sub === "head") {
    const head = await platform.audit.head();
    if (!head) {
      note("The audit chain is empty.");
      emit({ head: null }, args);
      return 0;
    }
    emit(
      args.json
        ? { seq: head.seq, entryHash: head.entryHash, recordedAt: head.recordedAt }
        : `seq ${head.seq}  ${head.recordedAt}  ${head.entryHash}`,
      args,
    );
    return 0;
  }

  if (sub === "query") {
    const limitRaw = first(args, "limit");

    // Narrowing by subject is what makes "what has this one agent been refused
    // for" a question this command can answer. Without it the operator gets
    // every denial in the deployment and reads another agent's behaviour as
    // this one's — a wrong answer that looks exactly like a right one, which is
    // worse than a command that fails.
    //
    // `key=value`, matching the form this command already prints, so what an
    // operator reads out of one line is what they can paste into the next.
    const subject: Record<string, string> = {};
    for (const pair of args.flags["subject"] ?? []) {
      const at = pair.indexOf("=");
      if (at <= 0 || at === pair.length - 1) {
        note(`--subject must be key=value, e.g. --subject externalAgentId=eag_1234; received "${pair}"`);
        return 2;
      }
      subject[pair.slice(0, at)] = pair.slice(at + 1);
    }

    const entries = await platform.audit.list({
      eventType: args.flags["event-type"] as never,
      runId: first(args, "run") as never,
      actorId: first(args, "actor"),
      correlationId: first(args, "correlation-id"),
      recordedAfter: first(args, "after"),
      recordedBefore: first(args, "before"),
      ...(Object.keys(subject).length > 0 ? { subject } : {}),
      limit: limitRaw && limitRaw !== "true" ? Number(limitRaw) : 50,
    });

    if (args.json) {
      emit(entries, args);
    } else {
      for (const entry of entries) {
        const subject = Object.entries(entry.subject)
          .map(([key, value]) => `${key}=${value}`)
          .join(" ");
        console.log(
          `${String(entry.seq).padStart(6)}  ${entry.recordedAt}  ${entry.eventType.padEnd(34)}  ${entry.actor.actorId.padEnd(20)}  ${subject}`,
        );
      }
      note(`${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`);
    }
    return 0;
  }

  note(`Unknown audit subcommand: ${sub ?? "(none)"}`);
  return 2;
}

async function commandContainment(args: Args, platform: Platform): Promise<number> {
  const sub = args.positional[1];

  if (sub === "list") {
    const switches = await platform.containment.list();
    const engaged = switches.filter((entry) => entry.engaged);

    if (args.json) {
      emit(switches, args);
    } else if (engaged.length === 0) {
      console.log("Nothing is contained. All work may proceed.");
    } else {
      console.log(`${engaged.length} containment switch(es) ENGAGED:`);
      for (const entry of engaged) {
        console.log(
          `  ${entry.scope}${entry.target ? `:${entry.target}` : ""}  engaged ${entry.engagedAt ?? "?"} by ${entry.engagedBy ?? "?"}  — ${entry.reason ?? "no reason recorded"}`,
        );
      }
    }
    return 0;
  }

  if (sub === "engage" || sub === "release") {
    const scope = require_(args, "scope");
    if (!["global", "workflow", "role", "integration"].includes(scope)) {
      note(`--scope must be one of: global, workflow, role, integration`);
      return 2;
    }
    const target = scope === "global" ? "" : require_(args, "target");
    // A reason is mandatory. It goes into the audit record, and an unexplained
    // pause is nearly as disruptive to the next operator as the incident was.
    const reason = require_(args, "reason");
    const actor = cliActor(args);

    const result =
      sub === "engage"
        ? await platform.containment.engage(scope as never, target, actor.actorId, reason)
        : await platform.containment.release(scope as never, target, actor.actorId, reason);

    note(
      `${sub === "engage" ? "ENGAGED" : "RELEASED"} ${scope}${target ? `:${target}` : ""} — ${reason}`,
    );
    if (sub === "engage") {
      note("In-flight work stops at its next action boundary. Compensation steps still run.");
    }
    emit(result, args);
    return 0;
  }

  note(`Unknown containment subcommand: ${sub ?? "(none)"}`);
  return 2;
}

function commandActions(args: Args, platform: Platform): number {
  const actions = platform.registry.list();
  if (args.json) {
    emit(actions, args);
    return 0;
  }

  console.log(
    `${"ACTION".padEnd(40)} ${"RISK".padEnd(18)} ${"HUMAN".padEnd(24)} ${"REVERSIBLE".padEnd(11)} APPROVALS`,
  );
  for (const action of actions) {
    console.log(
      `${action.name.padEnd(40)} ${action.risk.padEnd(18)} ${action.humanInvolvement.padEnd(24)} ${(action.reversible ? "yes" : "NO").padEnd(11)} ${action.approvalsRequired}`,
    );
  }
  note(`${actions.length} registered actions. Anything not listed here is refused.`);
  return 0;
}

async function commandHealth(args: Args, platform: Platform): Promise<number> {
  // Same posture as the HTTP endpoint: an unreadable dependency is the answer,
  // not a reason to refuse to answer. An operator running this during an outage
  // needs to be told what is unreachable, and a command that raises instead
  // tells them only that something is wrong somewhere.
  const unreachable: string[] = [];
  const head = await platform.audit.head().catch((error: unknown) => {
    // allow-swallow: reported as an unhealthy status naming the dependency.
    unreachable.push(`audit chain (${error instanceof Error ? error.message : String(error)})`);
    return null;
  });
  const switches = await platform.containment.list().catch((error: unknown) => {
    // allow-swallow: as above.
    unreachable.push(
      `containment switches (${error instanceof Error ? error.message : String(error)})`,
    );
    return [];
  });
  // The same four external-agent conditions the HTTP payload carries.
  //
  // They are here because they were not, and the EXTERNAL-CREDENTIAL-EXPIRING
  // runbook said "the health payload carries this — `pv health`". It did not:
  // there were three implementations of health — this one, `GET /health`, and
  // `pv agents health` — and only the last two knew about credentials. An
  // operator following that runbook saw a payload with no external block in it
  // and concluded no credential was expiring. Computed from the same function
  // the HTTP handler calls, so the three cannot drift apart again.
  const { externalAgentHealth, externalHealthPorts, EXTERNAL_PLANE_DISABLED } = await import(
    "../external/health.js"
  );
  const externalAgents = platform.external.enabled
    ? await externalAgentHealth(
        externalHealthPorts(platform.external.stores),
        platform.clock.nowIso(),
      ).catch((error: unknown) => {
        // allow-swallow: reported as unreachable, not hidden.
        unreachable.push(
          `external agent plane (${error instanceof Error ? error.message : String(error)})`,
        );
        return EXTERNAL_PLANE_DISABLED;
      })
    : EXTERNAL_PLANE_DISABLED;

  const engaged = switches.filter((entry) => entry.engaged);
  const paused = engaged.some((entry) => entry.scope === "global");

  const status = unreachable.length > 0 ? "unavailable" : paused ? "degraded" : "ok";

  const health = {
    status,
    unreachable,
    environment: platform.config.environment,
    store: platform.config.store,
    sandboxMode: platform.sandbox.mode,
    sandboxIsContained: platform.sandbox.isContained,
    sandboxNote: platform.sandbox.describe(),
    discoveryEnabled: platform.config.discoveryEnabled,
    modelProvider: platform.config.modelProvider,
    auditHeadSeq: head?.seq ?? null,
    externalAgents,
    containmentEngaged: engaged.map((entry) => `${entry.scope}:${entry.target}`),
    warnings: platform.config.warnings,
  };

  if (args.json) {
    emit(health, args);
    // Non-zero when the platform cannot serve, so this command is usable as a
    // probe rather than only as something a person reads.
    return status === "unavailable" ? 1 : 0;
  }

  console.log(`status            ${status}`);
  for (const item of unreachable) console.log(`unreachable       ${item}`);
  if (paused) console.log(`                  globally paused by an operator — refusing on purpose`);
  console.log(`environment       ${health.environment}`);
  console.log(`operating record  ${health.store}`);
  console.log(`sandbox           ${health.sandboxMode} (${health.sandboxIsContained ? "contained" : "NOT CONTAINED"})`);
  console.log(`work discovery    ${health.discoveryEnabled ? "ENABLED" : "disabled"}`);
  console.log(`model provider    ${health.modelProvider}`);
  console.log(`audit head        ${health.auditHeadSeq ?? "(empty)"}`);
  console.log(
    `containment       ${engaged.length === 0 ? "clear" : engaged.map((e) => `${e.scope}:${e.target}`).join(", ")}`,
  );
  console.log(
    `external agents   ${
      !externalAgents.planeEnabled
        ? "plane off"
        : `${externalAgents.enrolledCount} enrolled, ${externalAgents.activeCount} active`
    }`,
  );
  if (externalAgents.enabledWithNothingEnrolled) {
    console.log(
      `                  the plane is ON with nothing enrolled — every external figure this platform reports is a zero it has not earned`,
    );
  }
  for (const agent of externalAgents.contained) {
    console.log(`  CONTAINED       ${agent.name} (${agent.agentId}) — ${agent.reason ?? "no reason recorded"}`);
  }
  for (const agent of externalAgents.overBudget) {
    console.log(
      `  OVER BUDGET     ${agent.name} (${agent.agentId}) — $${agent.spentUsd.toFixed(2)} of $${agent.ceilingUsd.toFixed(2)} for ${agent.periodKey}`,
    );
  }
  for (const credential of externalAgents.credentialsNearingExpiry) {
    console.log(
      `  CREDENTIAL      ${credential.expired ? "EXPIRED" : "expiring"} ${credential.expiresAt}  ${credential.agentName} — ${credential.kind} "${credential.label}" (${credential.credentialId})`,
    );
  }
  for (const warning of health.warnings) console.log(`WARNING  ${warning}`);
  return status === "unavailable" ? 1 : 0;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.help !== undefined || args.positional.length === 0) {
    console.error(USAGE);
    return args.positional.length === 0 ? 2 : 0;
  }

  const command = args.positional[0];

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Configuration failure is fatal and must say exactly what is wrong.
    // A CLI that starts with half a configuration is a CLI that acts on a
    // deployment other than the one the operator thinks they are talking to.
    console.error(
      `Configuration error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 78; // EX_CONFIG
  }

  if (command === "demo") {
    if (args.positional[1] !== undefined && args.positional[1] !== "run") {
      console.error("Unknown demo subcommand. Try: demo run");
      return 2;
    }
    // The demonstration builds its own platform with a fixed clock and a
    // seeded id generator, because reproducibility is the point.
    const { runDemo } = await import("../demo/run.js");
    const result = await runDemo();
    return result.chainIntact ? 0 : 1;
  }

  if (command === "serve" && args.flags.seed !== undefined) {
    // A demonstration server: the seeded scenario, then HTTP over the same
    // in-process record it just wrote.
    //
    // It exists because the console was unlookable without one. `pnpm demo`
    // runs in memory and closes behind itself, so an API started afterwards
    // serves an empty store and every screen renders its empty state — which
    // is a fair rendering of an empty platform and a useless way to review a
    // design. Nothing else in the repository seeds a durable store.
    //
    // **Development only, and it refuses rather than warns.** This process
    // serves fabricated owners, contracts and approvals over a real HTTP API.
    // Somewhere it could be mistaken for a deployment, that is not a
    // demonstration, it is a platform telling an operator things that are not
    // true about people who do not exist.
    if (config.environment !== "development") {
      console.error(
        `\`serve --seed\` fabricates operating data and refuses to run outside development. PV_ENV is "${config.environment}". Start \`pv serve\` without --seed.`,
      );
      return 78; // EX_CONFIG
    }

    const { runDemoKeepingPlatform } = await import("../demo/run.js");
    // The ambient port, not the demonstration's default: the console's dev
    // proxy reads PV_HTTP_PORT, so the two have to agree or the console
    // reports a healthy platform unreachable.
    const { platform: seeded } = await runDemoKeepingPlatform(undefined, {
      PV_HTTP_PORT: String(config.httpPort),
    });

    const { startServer } = await import("../api/server.js");
    await startServer(seeded);
    note(`API listening on port ${seeded.config.httpPort}, serving the seeded demonstration.`);
    note(
      "Everything this serves is fabricated and lives in memory. It disappears when this process stops, and it is not a record of anything.",
    );
    await new Promise<never>(() => {});
    return 0;
  }

  if (command === "config") {
    if (args.positional[1] === "show") {
      console.log(describeConfig(config));
      return 0;
    }
    console.error("Unknown config subcommand. Try: config show");
    return 2;
  }

  const platform = await buildPlatform(config);
  try {
    switch (command) {
      case "db":
        return await commandDb(args, platform);
      case "audit":
        return await commandAudit(args, platform);
      case "containment":
        return await commandContainment(args, platform);
      case "actions":
        return commandActions(args, platform);
      case "agents": {
        // Imported here rather than at the top so that a deployment with no
        // external-agent plane never loads the module at all, and so that this
        // file's own dependency graph stays as small as its other commands'.
        const { commandAgents, AGENTS_USAGE } = await import("./external.js");
        if (args.positional[1] === undefined) {
          console.error(AGENTS_USAGE);
          return 2;
        }
        if (!platform.external.enabled) {
          // Refused rather than served against an empty roster. An empty roster
          // reads as "nothing is running out there", which is a claim a
          // deployment with the plane switched off has not earned and cannot
          // make. The plane ships off; turning it on is a deliberate act.
          console.error(
            "The external-agent plane is switched off in this deployment (PV_EXTERNAL_AGENTS_ENABLED). Nothing is governed here, which is different from having a plane with nothing enrolled in it.",
          );
          return 78; // EX_CONFIG
        }
        return await commandAgents(args, {
          plane: platform.external,
          approvals: platform.approvals,
          nowIso: () => platform.clock.nowIso(),
          actor: cliActor(args),
          correlationId: first(args, "correlation-id"),
        });
      }
      case "cost":
      case "approvals":
      case "models":
      case "engine": {
        // Imported here rather than at the top for the same reason `agents` is:
        // a process that only serves requests should never load the reporting
        // code, and the commands reached for during an incident should not pay
        // to parse it.
        const { commandOperations } = await import("./operations.js");
        return await commandOperations(args, {
          platform,
          // Only `approvals decide` writes anything; the reports ignore it.
          // Passed unconditionally so a second verb that acts cannot be added
          // without one, which is how a decision ends up attributed to nobody.
          actor: cliActor(args),
          correlationId: first(args, "correlation-id"),
        });
      }
      case "evaluate": {
        // Imported here rather than at the top so that the commands an operator
        // reaches for during an incident do not pay to load the evaluation
        // harness, the model gateway, and the shipped golden set.
        const { commandEvaluate } = await import("./evaluate.js");
        return await commandEvaluate(args, { platform, actor: cliActor(args) });
      }
      case "roles": {
        // Imported here rather than at the top for the same reason `agents` and
        // `evaluate` are: the role factory pulls in the promotion service, the
        // evaluation harness, and the model gateway, and a process that only
        // serves requests should not pay to parse them.
        const { commandRoles } = await import("./roles.js");
        return await commandRoles(args, {
          platform,
          actor: cliActor(args),
          correlationId: first(args, "correlation-id"),
        });
      }
      case "contact": {
        // Imported here rather than at the top for the same reason the verbs
        // above are: a process that only serves requests should not pay to
        // parse the contact gate, the consent ledger, and their store adapters.
        const { commandContact, CONTACT_USAGE } = await import("./contact.js");
        if (args.positional[1] === undefined) {
          console.error(CONTACT_USAGE);
          return 2;
        }
        return await commandContact(args, {
          platform,
          actor: cliActor(args),
          correlationId: first(args, "correlation-id"),
        });
      }
      case "knowledge": {
        // Imported here rather than at the top for the same reason the verbs
        // above are: a process that only serves requests should not pay to parse
        // the ingestion service, the retriever, the grounded answer service, and
        // their store adapters.
        const { commandKnowledge, KNOWLEDGE_USAGE } = await import("./knowledge.js");
        if (args.positional[1] === undefined) {
          console.error(KNOWLEDGE_USAGE);
          return 2;
        }
        return await commandKnowledge(args, {
          platform,
          actor: cliActor(args),
          correlationId: first(args, "correlation-id"),
        });
      }
      case "workflow": {
        // Imported here rather than at the top for the same reason the verbs
        // above are: a process that only serves requests should not pay to parse
        // the engine's operator surface.
        const { commandWorkflow, WORKFLOW_USAGE } = await import("./workflow.js");
        if (args.positional[1] === undefined) {
          console.error(WORKFLOW_USAGE);
          return 2;
        }
        return await commandWorkflow(args, {
          platform,
          actor: cliActor(args),
          correlationId: first(args, "correlation-id"),
        });
      }
      case "health":
        return await commandHealth(args, platform);
      case "serve": {
        const { startServer } = await import("../api/server.js");
        await startServer(platform);
        note(`API listening on port ${config.httpPort}. Press Ctrl-C to stop.`);
        note(
          "This process serves requests only. Run `pv worker` somewhere as well, or approvals never expire, statutory timers never fire, a commit abandoned by a dead worker is never surfaced to anyone, and no retention period is enforced.",
        );
        // Deliberately never resolves: the process stays up serving requests,
        // and the `finally` below must not close the pool underneath it.
        await new Promise<never>(() => {});
        return 0;
      }
      case "worker": {
        // A separate process from `serve`, deliberately.
        //
        // Folding the loop into the API would make every instance a scheduler,
        // and two instances sweeping the same tables need leader election
        // before anyone can scale the API horizontally — a decision that would
        // then be forced by an unrelated capacity change, at the worst possible
        // moment. Separating them makes the deployment shape state the answer:
        // run one worker.
        const { MaintenanceLoop } = await import("../maintenance.js");
        const loop = new MaintenanceLoop(platform, platform.logger, platform.clock);

        if (first(args, "once") !== undefined) {
          const report = await loop.runOnce();
          if (args.json) emit(report, args);
          else {
            for (const result of report.results) {
              const state = result.error
                ? `FAILED — ${result.error}`
                : result.skipped
                  ? "skipped (platform paused)"
                  : `${result.affected}`;
              console.log(`${result.name.padEnd(34)} ${state}`);
            }
          }
          // Non-zero when a pass failed, so a scheduled invocation is visible
          // to whatever ran it rather than quietly returning success.
          return report.results.some((result) => result.error) ? 1 : 0;
        }

        loop.start();
        note(`Maintenance running every 60s: ${loop.describe().join(", ")}. Press Ctrl-C to stop.`);
        await new Promise<never>(() => {});
        return 0;
      }
      default:
        console.error(`Unknown command: ${command}\n`);
        console.error(USAGE);
        return 2;
    }
  } finally {
    await platform.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof DeniedError) {
      // A refusal is an outcome, not a crash. Report it as one, with its
      // machine-readable reason, and exit non-zero because the thing the
      // operator asked for did not happen.
      console.error(`Refused (${error.reason}): ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 70; // EX_SOFTWARE
  });
