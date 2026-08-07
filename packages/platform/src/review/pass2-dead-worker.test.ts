import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../kernel/config.js";
import { FixedClock, HOUR } from "../kernel/clock.js";
import { digestValue } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { buildPlatform, type Platform } from "../platform.js";
import type { ActorRef } from "../record/types.js";
import type { ExternalAgentId } from "../external/types.js";
import { commandAgents, type CommandArgs } from "../cli/external.js";

/**
 * Pass 2 — a worker that dies mid-effect.
 *
 * `docs/architecture.md` and `external/types.ts` both promise the same thing:
 * a commit stranded in `committing` is found, marked `indeterminate`, never
 * retried, and put in front of a person. `ExecutionService.sweepStaleCommits`
 * implements the marking. `pv agents parked` is the operator surface, and its
 * own source says it "is meant to be wired to a scheduler, and a check that
 * exits zero while a write may or may not have landed is worse than no check
 * at all".
 *
 * `cli/external.test.ts` proves that verb reports an action that is *already*
 * `indeterminate`. Nothing proves anything ever puts an action into that
 * status. This file asks whether the promise holds end to end.
 */

const OPERATOR: ActorRef = {
  actorId: "cli:dana.whitfield",
  kind: "human",
  roles: ["platform_admin"],
};
const NOW = "2026-08-06T12:00:00.000Z";

let platform: Platform;
let clock: FixedClock;

beforeEach(async () => {
  clock = new FixedClock(NOW);
  platform = await buildPlatform(
    loadConfig({
      PV_ENV: "development",
      PV_STORE: "memory",
      PV_EXTERNAL_AGENTS_ENABLED: "true",
    }),
    { clock, ids: new SeededIdGenerator("review-dead-worker"), logger: createNullLogger() },
  );
});

afterEach(async () => {
  await platform.close();
});

function args(positional: readonly string[]): CommandArgs {
  return { positional: ["agents", ...positional], flags: {}, json: false };
}

/**
 * Run a CLI verb in process, capturing the two streams separately.
 *
 * The same capture `cli/external.test.ts` uses. `no-console` is disabled for
 * these four lines rather than for the file: the streams are what the verb's
 * contract is made of — "diagnostics to stderr, the answer to stdout" — so a
 * test of that verb has to hold them, and the rule is right everywhere else.
 */
async function run(command: CommandArgs) {
  const out: string[] = [];
  const err: string[] = [];
  /* eslint-disable no-console */
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts: unknown[]) => out.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.map(String).join(" "));
  /* eslint-enable no-console */
  try {
    const code = await commandAgents(command, {
      plane: platform.external,
      approvals: platform.approvals,
      nowIso: () => platform.clock.nowIso(),
      actor: OPERATOR,
      correlationId: "review-test",
    });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    /* eslint-disable no-console */
    console.log = realLog;
    console.error = realError;
    /* eslint-enable no-console */
  }
}

/**
 * An enrolled agent, written straight to the registry.
 *
 * The enrollment ceremony has its own approval flow and its own tests; this
 * file is about what happens after a commit is already in flight, so the agent
 * is seeded rather than enrolled through the CLI.
 */
async function enrolledAgent() {
  const agent = await platform.external.stores.agents.createAgent({
    id: "eag_review0001" as ExternalAgentId,
    name: "review-crm-agent",
    owner: "dana.whitfield@example.invalid",
    department: "Owner Services",
    hostPlatform: "vendor-crm",
    purpose: "answer owner questions about their contract",
    allowedTools: [{ tool: "crm.issue_refund", operatorRisk: "high_consequence" }],
    riskCeiling: "high_consequence",
    spendCeilingUsd: 100,
    budgetPeriod: "monthly",
    wallClockCeilingMs: 60_000,
    dataScopes: ["owner_services"],
    expiresAt: "2026-09-06T12:00:00.000Z",
    status: "active",
    enrolledBy: OPERATOR.actorId,
    enrolledAt: NOW,
    updatedAt: NOW,
  });
  return { agentId: agent.id, name: agent.name };
}

describe("a commit stranded by a dead worker", () => {
  it("is put in front of an operator rather than sitting in flight forever", async () => {
    const { agentId, name } = await enrolledAgent();

    // A worker claimed the action, started the effect, and died.
    await platform.external.stores.parked.createParkedAction({
      id: "pac_stranded01" as Id<"parkedAction">,
      agentId,
      integration: "crm",
      operation: "issue_refund",
      requestDigest: digestValue({ amount: 120 }),
      preview: [{ label: "Amount", value: "$120.00" }],
      status: "committing",
      createdAt: NOW,
      expiresAt: "2026-08-07T12:00:00.000Z",
    });

    // An hour later — far past any staleness window — an operator runs the
    // check the CLI's own header says is meant to be on a scheduler.
    clock.advance(HOUR);
    const result = await run(args(["parked", name]));

    // Exiting zero here says "nothing needs a person", about a refund that may
    // or may not have been issued.
    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/pac_stranded01/);
    expect(result.stderr).toMatch(/go and look in the system of record/);
  });
});
