#!/usr/bin/env node
import { loadConfig } from "../kernel/config.js";
import { DeniedError } from "../kernel/errors.js";
import { formatVerificationResult, verifyChain } from "../audit/chain.js";
import { buildPlatform, describeConfig, migrate, type Platform } from "../platform.js";

/**
 * The operator command line.
 *
 * Two design rules, both aimed at the same failure: a command that appears to
 * have worked when it did not.
 *
 * Everything writes to stderr except the actual answer, which goes to stdout.
 * That is what makes `pv audit verify > evidence.txt` produce a clean artifact
 * and `pv cost report --format csv | ...` compose, without an operator having
 * to strip a banner out of their evidence file.
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
        --after <iso>  --before <iso>
        --limit <n>

  containment list                Show every containment switch
  containment engage --scope <global|workflow|role|integration>
                     [--target <name>] --reason <text>
  containment release --scope <...> [--target <name>] --reason <text>

  actions list                    Show the action registry with risk tiers
  config show                     Show effective configuration and warnings
  health                          Report platform health
  serve                           Run the HTTP API

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
 */
function cliActor(args: Args): { actorId: string; kind: "human"; roles: string[] } {
  const operator = first(args, "operator") ?? process.env.USER ?? "unknown-operator";
  return { actorId: `cli:${operator}`, kind: "human", roles: ["platform_admin"] };
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

    const result = anchor ? verifyChain(chain, anchor) : verifyChain(chain);

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
    const entries = await platform.audit.list({
      eventType: args.flags["event-type"] as never,
      runId: first(args, "run") as never,
      actorId: first(args, "actor"),
      recordedAfter: first(args, "after"),
      recordedBefore: first(args, "before"),
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
  const head = await platform.audit.head();
  const switches = await platform.containment.list();
  const engaged = switches.filter((entry) => entry.engaged);

  const health = {
    status: "ok" as const,
    environment: platform.config.environment,
    store: platform.config.store,
    sandboxMode: platform.sandbox.mode,
    sandboxIsContained: platform.sandbox.isContained,
    sandboxNote: platform.sandbox.describe(),
    discoveryEnabled: platform.config.discoveryEnabled,
    modelProvider: platform.config.modelProvider,
    auditHeadSeq: head?.seq ?? null,
    containmentEngaged: engaged.map((entry) => `${entry.scope}:${entry.target}`),
    warnings: platform.config.warnings,
  };

  if (args.json) {
    emit(health, args);
    return 0;
  }

  console.log(`status            ok`);
  console.log(`environment       ${health.environment}`);
  console.log(`operating record  ${health.store}`);
  console.log(`sandbox           ${health.sandboxMode} (${health.sandboxIsContained ? "contained" : "NOT CONTAINED"})`);
  console.log(`work discovery    ${health.discoveryEnabled ? "ENABLED" : "disabled"}`);
  console.log(`model provider    ${health.modelProvider}`);
  console.log(`audit head        ${health.auditHeadSeq ?? "(empty)"}`);
  console.log(
    `containment       ${engaged.length === 0 ? "clear" : engaged.map((e) => `${e.scope}:${e.target}`).join(", ")}`,
  );
  for (const warning of health.warnings) console.log(`WARNING  ${warning}`);
  return 0;
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
      case "health":
        return await commandHealth(args, platform);
      case "serve": {
        const { startServer } = await import("../api/server.js");
        await startServer(platform);
        note(`API listening on port ${config.httpPort}. Press Ctrl-C to stop.`);
        // Deliberately never resolves: the process stays up serving requests,
        // and the `finally` below must not close the pool underneath it.
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
