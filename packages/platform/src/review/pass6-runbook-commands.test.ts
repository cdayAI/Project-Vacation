import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Pass 6 — every alert has a runbook, and the runbook works when followed by
 * someone who did not write it.
 *
 * Three were followed end to end against a populated Postgres deployment.
 *
 *   `AUDIT-CHAIN-BROKEN` works. `pnpm audit:verify` runs, exits non-zero on a
 *   broken chain, and the break kinds it prints are the vocabulary the runbook
 *   lists — except `genesis_mismatch`, which the verifier can emit and the
 *   runbook does not explain.
 *
 *   `EXTERNAL-ACTION-INDETERMINATE` works once the reader guesses the command
 *   prefix. `agents parked --status indeterminate` exists and answers.
 *
 *   `EXTERNAL-CREDENTIAL-EXPIRING` does not. Its first instruction is "the
 *   health payload carries this — `... health`". The CLI's `health` command
 *   does not carry it: its payload is
 *   `{status, environment, store, sandboxMode, sandboxIsContained, sandboxNote,
 *   discoveryEnabled, modelProvider, auditHeadSeq, containmentEngaged,
 *   warnings}` and has no external-agent block at all. The credential rows live
 *   on the HTTP `/health` payload and behind a *different* CLI verb,
 *   `agents health`. An operator following the runbook as written sees nothing
 *   and concludes no credential is expiring.
 *
 * Two problems are systemic rather than per-runbook, and this file pins the
 * second of them.
 *
 * **The command prefix is never defined.** Every command was written as
 * `... <verb>`. There was no `pv` binary — `packages/platform/package.json`
 * declared no `bin` — and the document never said what to substitute. A reader
 * who did not write it had to find `cli/main.ts` to discover the entry point.
 *
 * *Decided.* The prefix is `pv`: the package declares it as its `bin`, the
 * runbooks state once at the top what to run when it is not on PATH, and every
 * command in the document is written out in full. The parser below therefore
 * looks for `pv <verb>` rather than for the elided form, which is what makes it
 * keep working as a check rather than matching nothing. Against the document as
 * it was — where the string `pv ` never appeared — the first assertion fails
 * outright, which is the point: the convention is now load-bearing.
 *
 * **Five documented commands do not exist.** Confirmed by running each one.
 * `cost`, `approvals`, `models` and `engine` are not commands at all, and
 * `db status` is advertised in the CLI's own `--help` but falls through to
 * "Unknown db subcommand". Four alerts therefore route a woken operator to a
 * command that cannot run: `SPEND-CEILING-APPROACHING`,
 * `APPROVAL-QUEUE-AGEING`, `MODEL-PROVIDER-DEGRADED`, and
 * `STATUTORY-TIMER-LATE` — the last of which is the SEV1 for a possibly missed
 * legal deadline.
 *
 * The check below derives both sides from source rather than from a list
 * written here, so a new runbook naming a new command fails until the command
 * exists, and a command that is renamed fails until the runbook follows.
 */

const here = fileURLToPath(import.meta.url);
const repoRoot = here.slice(0, here.indexOf("/packages/platform/"));

function read(relative: string): string {
  return readFileSync(`${repoRoot}/${relative}`, "utf8");
}

/** Top-level verbs the CLI dispatches, taken from its own switch. */
function implementedCommands(): Set<string> {
  const source = read("packages/platform/src/cli/main.ts");
  const commands = new Set<string>();
  for (const match of source.matchAll(/^\s*case "([a-z-]+)":/gm)) {
    if (match[1]) commands.add(match[1]);
  }
  // Handled before the switch, so they carry no `case` label.
  for (const match of source.matchAll(/command === "([a-z-]+)"/g)) {
    if (match[1]) commands.add(match[1]);
  }
  return commands;
}

/**
 * Verbs the runbooks tell an operator to run.
 *
 * Every command in that document is written as `pv <verb> <subcommand>`, so the
 * prefix is what identifies a command line rather than prose. The verb must
 * start with a letter: `pv --help` is a command, but `--help` is a flag on
 * every verb rather than one of its own.
 */
function documentedCommands(): { verb: string; line: string }[] {
  const found: { verb: string; line: string }[] = [];
  for (const line of read("docs/ops/runbooks.md").split("\n")) {
    // Both shapes the document uses: a fenced block, and a backticked command
    // inside a sentence. Missing the second shape hides three of the five.
    for (const match of line.matchAll(/\bpv\s+([a-z][a-z-]*)\b/g)) {
      if (match[1]) found.push({ verb: match[1], line: line.trim() });
    }
  }
  return found;
}

describe("the commands the runbooks tell an operator to run", () => {
  it("names at least one command in more than one runbook", () => {
    // Guards the parser: an empty result would make the assertion below vacuous.
    expect(documentedCommands().length).toBeGreaterThan(5);
  });

  it("every one of them exists in the command line", () => {
    const implemented = implementedCommands();
    const missing = documentedCommands().filter(({ verb }) => !implemented.has(verb));

    // A runbook step that cannot be run is worse than a missing runbook: it
    // costs the operator the time to discover it is wrong, at the moment they
    // were woken up to act.
    expect(
      missing.map(({ verb, line }) => `${verb}  (from: ${line})`),
      "runbook commands with no implementation",
    ).toEqual([]);
  });

  it("advertises no command in --help that the command line does not implement", () => {
    // `db status` is documented in the CLI's own usage text and falls through
    // to "Unknown db subcommand: status".
    const source = read("packages/platform/src/cli/main.ts");
    const usage = /const USAGE = `([\s\S]*?)`\.trim\(\);/.exec(source)?.[1] ?? "";
    const advertisesDbStatus = /^\s{2}db status\b/m.test(usage);
    const implementsDbStatus = /sub === "status"/.test(source);

    expect(advertisesDbStatus && !implementsDbStatus).toBe(false);
  });
});
