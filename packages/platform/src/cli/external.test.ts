import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../kernel/config.js";
import { FixedClock } from "../kernel/clock.js";
import { digestValue } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { buildPlatform, type Platform } from "../platform.js";
import type { ActorRef } from "../record/types.js";
import type { ExternalAgentId } from "../external/types.js";
import { commandAgents, composeReason, parseTools, type CommandArgs } from "./external.js";

/**
 * Tests for `pv agents`.
 *
 * Run in-process against a real platform with the in-memory store, a fixed
 * clock, and a seeded id generator, because the properties worth testing are
 * stateful across verbs: mint a credential, then check that no later command
 * can print it; contain an agent, then check the roster says so in words. A
 * subprocess per verb would start with an empty database each time and could
 * only ever test one command in isolation.
 *
 * Two things are still tested as a subprocess at the bottom of this file,
 * because they are process-level and unobservable from inside: the exit code
 * when the plane is switched off, and the usage text.
 *
 * Streams are captured separately throughout. "Diagnostics to stderr, the
 * answer to stdout" is a promise this command line makes to every pipeline
 * built on it, and a test that merged the two would not notice it breaking.
 */

const OPERATOR: ActorRef = {
  actorId: "cli:dana.whitfield",
  kind: "human",
  roles: ["platform_admin"],
};

/** A second person, because nobody approves their own proposal. */
const APPROVER: ActorRef = {
  actorId: "act_2c88de40",
  kind: "human",
  roles: ["compliance_reviewer"],
};

const NOW = "2026-08-06T12:00:00.000Z";

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

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
    { clock, ids: new SeededIdGenerator("agents-cli"), logger: createNullLogger() },
  );
});

afterEach(async () => {
  await platform.close();
});

/**
 * Build the argument shape `parseArgs` in main.ts produces.
 *
 * Constructed directly rather than by re-parsing a string: importing main.ts
 * would run the command line, and a second copy of its parser here would drift
 * from the real one while still passing. The real parser is exercised by the
 * subprocess tests below and by cli.test.ts.
 */
function args(
  positional: readonly string[],
  flags: Readonly<Record<string, string | readonly string[] | true>> = {},
): CommandArgs {
  const built: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(flags)) {
    built[name] = value === true ? ["true"] : typeof value === "string" ? [value] : [...value];
  }
  return {
    positional: ["agents", ...positional],
    flags: built,
    json: built["json"] !== undefined,
  };
}

async function run(command: CommandArgs, actor: ActorRef = OPERATOR): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts: unknown[]) => out.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.map(String).join(" "));
  try {
    const code = await commandAgents(command, {
      plane: platform.external,
      approvals: platform.approvals,
      nowIso: () => platform.clock.nowIso(),
      actor,
      correlationId: "cli-test",
    });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/**
 * Run a verb that is not going to succeed, and hand back everything about it.
 *
 * Two shapes of failure matter here and they are deliberately different. A
 * `DeniedError` propagates — a refusal is an outcome the operator must see with
 * its reason code — and lands in `error`. A malformed command is a usage error
 * and comes back as exit code 2 with the message on stderr. The output matters
 * as much as either: a refusal that does not tell the operator what to type
 * instead is a refusal they will work around.
 */
async function refused(
  command: CommandArgs,
  actor: ActorRef = OPERATOR,
): Promise<{ error: Error | null; code: number | null; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts: unknown[]) => out.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.map(String).join(" "));
  try {
    const code = await commandAgents(command, {
      plane: platform.external,
      approvals: platform.approvals,
      nowIso: () => platform.clock.nowIso(),
      actor,
      correlationId: "cli-test",
    });
    if (code === 0) throw new Error("Expected a refusal and the command succeeded.");
    return { error: null, code, stdout: out.join("\n"), stderr: err.join("\n") };
  } catch (error) {
    return { error: error as Error, code: null, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** The thrown refusal. Fails loudly if the verb merely exited non-zero. */
async function refusal(command: CommandArgs, actor: ActorRef = OPERATOR): Promise<Error> {
  const outcome = await refused(command, actor);
  if (outcome.error === null) {
    throw new Error(
      `Expected a thrown refusal; the verb exited ${String(outcome.code)} instead.\n${outcome.stderr}`,
    );
  }
  return outcome.error;
}

const ENROLL_FLAGS: Readonly<Record<string, string | readonly string[] | true>> = {
  name: "crm-refund-bot",
  owner: "dana.whitfield@example.invalid",
  department: "Owner Services",
  host: "vendor-crm",
  purpose: "Answers owner refund questions inside the CRM and asks us before it acts.",
  "risk-ceiling": "sensitive",
  "spend-ceiling": "250",
  "budget-period": "monthly",
  "wall-clock-ms": "60000",
  expires: "2026-11-01T00:00:00.000Z",
  tool: ["crm.issue_refund:high_consequence", "crm.read_contract:routine"],
  scope: ["contracts.metadata"],
};

/** Raise the approval, have somebody else grant it, and enroll. */
async function enrolledAgent(): Promise<{ agentId: ExternalAgentId; name: string }> {
  const raised = await run(args(["enroll"], { ...ENROLL_FLAGS, "raise-approval": true }));
  expect(raised.code).toBe(0);
  const approvalId = raised.stdout.trim();

  await platform.approvals.decide({
    approvalId: approvalId as Id<"approval">,
    actor: APPROVER,
    decision: "granted",
    requiresStepUp: false,
    secondsSinceAuthentication: 0,
    stepUpMaxAgeSeconds: platform.config.stepUpMaxAgeSeconds,
  });

  const enrolled = await run(
    args(["enroll"], { ...ENROLL_FLAGS, approval: approvalId, reauthenticated: true }),
  );
  expect(enrolled.code).toBe(0);

  const agent = await platform.external.stores.agents.getAgentByName("crm-refund-bot");
  if (!agent) throw new Error("enrollment did not create an agent");
  return { agentId: agent.id, name: agent.name };
}

// ---------------------------------------------------------------------------

describe("pv agents — the roster", () => {
  it("says an empty roster is empty, and says why that is worth noticing", async () => {
    const result = await run(args(["list"]));
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/every figure the platform reports about external agents is a zero/);
    expect(result.stdout).toBe("");
  });

  it("lists an enrolled agent with its owner, host, spend against ceiling, and credential kinds", async () => {
    await enrolledAgent();
    const result = await run(args(["list"]));

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/crm-refund-bot/);
    expect(result.stdout).toMatch(/vendor-crm/);
    expect(result.stdout).toMatch(/dana\.whitfield@example\.invalid/);
    expect(result.stdout).toMatch(/Owner Services/);
    expect(result.stdout).toMatch(/\$0\.00 \/ \$250\.00/);
    // No credential minted yet, so the agent cannot authenticate at all.
    expect(result.stdout).toMatch(/none$/m);
  });

  it("keeps stdout parseable so the roster composes with jq", async () => {
    await enrolledAgent();
    const result = await run(args(["list"], { json: true }));

    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout) as { name: string; spendCeilingUsd: number }[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]?.name).toBe("crm-refund-bot");
    expect(parsed[0]?.spendCeilingUsd).toBe(250);
  });

  it("states containment and over-budget in words, not in colour", async () => {
    const { agentId, name } = await enrolledAgent();
    await platform.external.stores.spend.addSpend(agentId, "2026-08", 300, NOW);
    await run(args(["contain", name], { reason: "cost_overrun" }));

    const result = await run(args(["list"]));
    expect(result.stdout).toMatch(/CONTAINED/);
    expect(result.stdout).toMatch(/OVER/);
    expect(result.stderr).toMatch(/1 contained, 1 over budget/);
  });

  it("filters to contained agents and to over-budget agents", async () => {
    const { agentId, name } = await enrolledAgent();
    const contained = await run(args(["list"], { contained: true }));
    expect(contained.stdout).toBe("");

    await run(args(["contain", name], { reason: "misbehaviour" }));
    const afterContainment = await run(args(["list"], { contained: true }));
    expect(afterContainment.stdout).toMatch(/crm-refund-bot/);

    const overBudget = await run(args(["list"], { "over-budget": true }));
    expect(overBudget.stdout).toBe("");
    await platform.external.stores.spend.addSpend(agentId, "2026-08", 250, NOW);
    const afterSpend = await run(args(["list"], { "over-budget": true }));
    expect(afterSpend.stdout).toMatch(/crm-refund-bot/);
  });

  it("shows one agent by name, with its grants and its warnings on stderr", async () => {
    const { name } = await enrolledAgent();
    await run(args(["contain", name], { reason: "under_investigation" }));

    const result = await run(args(["show", name]));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/crm\.issue_refund:high_consequence/);
    expect(result.stdout).toMatch(/contracts\.metadata/);
    expect(result.stdout).toMatch(/state\s+CONTAINED/);
    // The warning is a diagnostic, so a redirected file stays clean.
    expect(result.stderr).toMatch(/is CONTAINED and is refused at every admission check/);
  });

  it("refuses to guess which agent was meant", async () => {
    const error = await refusal(args(["show", "no-such-agent"]));
    expect(error.message).toMatch(/No external agent is enrolled under no-such-agent/);
  });
});

describe("pv agents — enrollment", () => {
  it("refuses to enroll without an approval somebody else granted", async () => {
    const error = await refusal(args(["enroll"], { ...ENROLL_FLAGS, reauthenticated: true }));
    expect(error.message).toMatch(/requires 1 human approval/);
  });

  it("refuses to enroll without a fresh re-authentication, rather than inventing one", async () => {
    const error = await refusal(args(["enroll"], ENROLL_FLAGS));
    expect(error.message).toMatch(/requires a fresh re-authentication/);
    expect(error.message).toMatch(/--reauthenticated/);
  });

  it("binds the raised approval to exactly the enrollment that was proposed", async () => {
    const raised = await run(args(["enroll"], { ...ENROLL_FLAGS, "raise-approval": true }));
    const approvalId = raised.stdout.trim();
    await platform.approvals.decide({
      approvalId: approvalId as Id<"approval">,
      actor: APPROVER,
      decision: "granted",
      requiresStepUp: false,
      secondsSinceAuthentication: 0,
      stepUpMaxAgeSeconds: platform.config.stepUpMaxAgeSeconds,
    });

    // One flag changed after the approval was granted. The digest no longer
    // matches, so the chokepoint refuses rather than enrolling something
    // nobody agreed to.
    const error = await refusal(
      args(["enroll"], {
        ...ENROLL_FLAGS,
        "spend-ceiling": "5000",
        approval: approvalId,
        reauthenticated: true,
      }),
    );
    expect(error.message).toMatch(/digest|approval/i);
  });

  it("says plainly that a new agent cannot authenticate until a credential is minted", async () => {
    const { name } = await enrolledAgent();
    expect(name).toBe("crm-refund-bot");
    const shown = await run(args(["show", name]));
    expect(shown.stdout).toMatch(/credential kinds\s+none held/);
  });
});

describe("pv agents — re-enrollment", () => {
  it("adjusts a ceiling without touching the meter or the status", async () => {
    const { agentId, name } = await enrolledAgent();
    await platform.external.stores.spend.addSpend(agentId, "2026-08", 40, NOW);

    const result = await run(args(["update", name], { "spend-ceiling": "500" }));
    expect(result.code).toBe(0);

    const after = await platform.external.stores.agents.getAgent(agentId);
    expect(after?.spendCeilingUsd).toBe(500);
    const meter = await platform.external.stores.spend.getMeter(agentId, "2026-08");
    expect(meter?.spentUsd).toBe(40);
  });

  it("refuses the flags somebody would reach for to clear a meter or lift a containment", async () => {
    const { name } = await enrolledAgent();

    const meter = await refusal(args(["update", name], { "reset-spend": true }));
    expect(meter.message).toMatch(/no operation anywhere in this platform that clears a spend meter/);

    const status = await refusal(args(["update", name], { status: "active" }));
    expect(status.message).toMatch(/Use contain, release, or revoke/);
  });

  it("warns that a tool grant is replaced rather than added to", async () => {
    const { agentId, name } = await enrolledAgent();
    const result = await run(args(["update", name], { tool: ["crm.read_contract:routine"] }));

    expect(result.stderr).toMatch(/REPLACE the whole grant/);
    const after = await platform.external.stores.agents.getAgent(agentId);
    expect(after?.allowedTools.map((grant) => grant.tool)).toEqual(["crm.read_contract"]);
  });

  it("refuses an update that changes nothing", async () => {
    const { name } = await enrolledAgent();
    const result = await run(args(["update", name]));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/reads in the roster like a review that happened/);
  });
});

describe("pv agents — typed reasons", () => {
  it("refuses containment with no reason, and prints the vocabulary", async () => {
    const { name } = await enrolledAgent();
    const outcome = await refused(args(["contain", name]));

    // A malformed command is a usage error, not a crash: exit 2 and a message,
    // rather than a stack trace that reads like the platform broke.
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toMatch(/--reason is required/);
    // The vocabulary is printed, so an operator learns what to type from the
    // refusal itself rather than from a document they do not have open at 2am.
    expect(outcome.stderr).toMatch(/suspected_compromise/);
    expect(outcome.stderr).toMatch(/cost_overrun/);
    expect(outcome.stderr).toMatch(/Add free text with --note/);
  });

  it("refuses a reason outside the vocabulary rather than recording free prose", async () => {
    const { name } = await enrolledAgent();
    const outcome = await refused(args(["contain", name], { reason: "because-i-said-so" }));
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toMatch(/is not a recognised reason/);
    expect(outcome.stderr).toMatch(/deliberately no "other"/);
  });

  it("records the code and the note together, code first", async () => {
    const composed = composeReason(
      { misbehaviour: "the agent is doing something it is not supposed to do" },
      "misbehaviour",
      "issued three refunds in a minute",
    );
    expect(composed.startsWith("misbehaviour —")).toBe(true);
    expect(composed).toMatch(/issued three refunds in a minute/);
  });

  it("carries the typed reason into the agent's status", async () => {
    const { agentId, name } = await enrolledAgent();
    await run(
      args(["contain", name], { reason: "suspected_compromise", note: "token seen in a paste bin" }),
    );

    const after = await platform.external.stores.agents.getAgent(agentId);
    expect(after?.status).toBe("contained");
    expect(after?.statusReason).toMatch(/^suspected_compromise —/);
    expect(after?.statusReason).toMatch(/token seen in a paste bin/);
  });

  it("uses a different vocabulary for release than for containment", async () => {
    const { name } = await enrolledAgent();
    await run(args(["contain", name], { reason: "under_investigation" }));

    // A containment code is not a release code: the two answer different
    // questions and sharing a list would record the answer to neither.
    const wrongVocabulary = await refused(args(["release", name], { reason: "under_investigation" }));
    expect(wrongVocabulary.code).toBe(2);
    expect(wrongVocabulary.stderr).toMatch(/is not a recognised reason/);

    const released = await run(args(["release", name], { reason: "investigated_and_clear" }));
    expect(released.code).toBe(0);
    expect(released.stderr).toMatch(/RELEASED/);
  });

  it("requires a typed reason to revoke, and revocation stays terminal", async () => {
    const { agentId, name } = await enrolledAgent();

    const raised = await run(
      args(["revoke", name], { reason: "vendor_offboarding", "raise-approval": true }),
    );
    const approvalId = raised.stdout.trim();
    await platform.approvals.decide({
      approvalId: approvalId as Id<"approval">,
      actor: APPROVER,
      decision: "granted",
      requiresStepUp: false,
      secondsSinceAuthentication: 0,
      stepUpMaxAgeSeconds: platform.config.stepUpMaxAgeSeconds,
    });

    const revoked = await run(
      args(["revoke", name], {
        reason: "vendor_offboarding",
        approval: approvalId,
        reauthenticated: true,
      }),
    );
    expect(revoked.code).toBe(0);
    expect(revoked.stderr).toMatch(/This is terminal/);

    const after = await platform.external.stores.agents.getAgent(agentId);
    expect(after?.status).toBe("revoked");

    const release = await refusal(args(["release", name], { reason: "contained_in_error" }));
    expect(release.message).toMatch(/Revocation is terminal/);
  });
});

describe("pv agents — credentials", () => {
  it("prints a minted bearer token exactly once, on stdout, with the warning on stderr", async () => {
    const { name } = await enrolledAgent();
    const minted = await run(
      args(["credential", "mint", name], {
        kind: "bearer",
        label: "crm production",
        reauthenticated: true,
      }),
    );

    expect(minted.code).toBe(0);
    const token = minted.stdout.trim();
    expect(token.startsWith("pvx_")).toBe(true);
    expect(minted.stderr).toMatch(/shown ONCE/);
    expect(minted.stderr).toMatch(/stored only as a hash/);
    // The warning is a diagnostic; the token is the answer. Redirecting stdout
    // into a secret store must not also capture the prose.
    expect(minted.stderr).not.toContain(token);
  });

  it("never shows a minted token again, in any verb", async () => {
    const { name } = await enrolledAgent();
    const minted = await run(
      args(["credential", "mint", name], {
        kind: "bearer",
        label: "crm production",
        reauthenticated: true,
      }),
    );
    const token = minted.stdout.trim();
    expect(token.length).toBeGreaterThan(16);

    const everythingElse = [
      await run(args(["credential", "list", name])),
      await run(args(["credential", "list", name], { json: true })),
      await run(args(["show", name])),
      await run(args(["show", name], { json: true })),
      await run(args(["list"])),
      await run(args(["list"], { json: true })),
      await run(args(["health"], { json: true })),
    ];

    for (const result of everythingElse) {
      expect(result.stdout).not.toContain(token);
      expect(result.stderr).not.toContain(token);
    }
  });

  it("never prints the stored token hash either", async () => {
    const { agentId, name } = await enrolledAgent();
    await run(
      args(["credential", "mint", name], {
        kind: "bearer",
        label: "crm production",
        reauthenticated: true,
      }),
    );
    const stored = await platform.external.stores.credentials.listCredentials(agentId);
    const hash = stored[0]?.tokenHash;
    expect(hash).toBeDefined();

    const listed = await run(args(["credential", "list", name], { json: true }));
    expect(listed.stdout).not.toContain(hash ?? "unreachable");
  });

  it("refuses to mint without a fresh re-authentication", async () => {
    const { name } = await enrolledAgent();
    const error = await refusal(
      args(["credential", "mint", name], { kind: "bearer", label: "crm production" }),
    );
    expect(error.message).toMatch(/fresh human re-authentication/);
  });

  it("refuses to mint for a revoked agent", async () => {
    const { agentId, name } = await enrolledAgent();
    await platform.external.stores.agents.setAgentStatus({
      id: agentId,
      expectedStatus: "active",
      status: "revoked",
      reason: "test",
      by: "test",
      at: NOW,
    });

    const error = await refusal(
      args(["credential", "mint", name], {
        kind: "bearer",
        label: "replacement",
        reauthenticated: true,
      }),
    );
    expect(error.message).toMatch(/is revoked/);
  });

  it("shows which kinds an agent holds, and says a strong credential refuses bearer", async () => {
    const { name } = await enrolledAgent();
    const minted = await run(
      args(["credential", "mint", name], {
        kind: "hmac",
        label: "signed requests",
        "secret-ref": "crm/refund-bot/hmac",
        reauthenticated: true,
      }),
    );
    expect(minted.stderr).toMatch(/plain bearer authentication is refused/);

    const listed = await run(args(["credential", "list", name]));
    expect(listed.stdout).toMatch(/hmac/);
    // The reference is a NAME resolved from the secret manager, and showing it
    // is how an operator finds which vault entry an agent depends on.
    const asJson = await run(args(["credential", "list", name], { json: true }));
    expect(asJson.stdout).toMatch(/crm\/refund-bot\/hmac/);

    const roster = await run(args(["list"]));
    expect(roster.stdout).toMatch(/hmac/);
  });

  it("requires a typed reason to revoke a credential", async () => {
    const { agentId, name } = await enrolledAgent();
    await run(
      args(["credential", "mint", name], {
        kind: "bearer",
        label: "crm production",
        reauthenticated: true,
      }),
    );
    const stored = await platform.external.stores.credentials.listCredentials(agentId);
    const credentialId = stored[0]?.id ?? "";

    const noReason = await refused(args(["credential", "revoke", credentialId]));
    expect(noReason.code).toBe(2);
    expect(noReason.stderr).toMatch(/--reason is required/);

    const revoked = await run(args(["credential", "revoke", credentialId], { reason: "rotated" }));
    expect(revoked.code).toBe(0);
    expect(revoked.stderr).toMatch(/authenticates nothing from this moment/);

    const after = await platform.external.stores.credentials.getCredential(
      credentialId as Id<"credential">,
    );
    expect(after?.revokedAt).toBe(NOW);
    expect(after?.revokedReason).toMatch(/^rotated —/);
  });
});

describe("pv agents — runs and parked actions", () => {
  it("lists an agent's runs against the operating-record run they belong to", async () => {
    const { agentId, name } = await enrolledAgent();
    await platform.external.stores.runs.createExternalRun({
      id: "xrn_test0001" as Id<"externalRun">,
      agentId,
      runId: "run_test0001" as Id<"run">,
      goal: "Answer a refund question",
      status: "running",
      startedAt: NOW,
      lastHeartbeatAt: NOW,
      costUsd: 0,
    });

    const result = await run(args(["runs", name]));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/xrn_test0001/);
    expect(result.stdout).toMatch(/run_test0001/);
    expect(result.stderr).toMatch(/nobody heard from it, which is not the same as it having failed/);
  });

  it("exits non-zero when a parked action's effect is indeterminate", async () => {
    const { agentId, name } = await enrolledAgent();
    await platform.external.stores.parked.createParkedAction({
      id: "pac_test0001" as Id<"parkedAction">,
      agentId,
      integration: "crm",
      operation: "issue_refund",
      requestDigest: digestValue({ amount: 120 }),
      preview: [{ label: "Amount", value: "$120.00" }],
      status: "indeterminate",
      createdAt: NOW,
      expiresAt: "2026-08-07T12:00:00.000Z",
    });

    const result = await run(args(["parked", name]));
    // Non-zero on purpose: this verb is meant to be wired to a scheduler.
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/INDETERMINATE/);
    expect(result.stderr).toMatch(/go and look in the system of record/);
  });

  it("exits zero when every parked action has landed somewhere definite", async () => {
    const { agentId, name } = await enrolledAgent();
    await platform.external.stores.parked.createParkedAction({
      id: "pac_test0002" as Id<"parkedAction">,
      agentId,
      integration: "crm",
      operation: "issue_refund",
      requestDigest: digestValue({ amount: 40 }),
      preview: [{ label: "Amount", value: "$40.00" }],
      status: "pending",
      createdAt: NOW,
      expiresAt: "2026-08-07T12:00:00.000Z",
    });

    const result = await run(args(["parked", name]));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/pac_test0002/);
  });
});

describe("pv agents — health rows", () => {
  it("reports a plane that is switched on with nothing enrolled", async () => {
    const result = await run(args(["health"]));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/PLANE ENABLED, NOTHING ENROLLED/);
  });

  it("reports contained agents, over-budget agents, and expiring credentials", async () => {
    const { agentId, name } = await enrolledAgent();
    await platform.external.stores.spend.addSpend(agentId, "2026-08", 250, NOW);
    await run(args(["contain", name], { reason: "cost_overrun" }));
    await run(
      args(["credential", "mint", name], {
        kind: "bearer",
        label: "expiring soon",
        expires: "2026-08-10T00:00:00.000Z",
        reauthenticated: true,
      }),
    );

    const result = await run(args(["health"], { json: true }));
    const health = JSON.parse(result.stdout) as {
      planeEnabled: boolean;
      enabledWithNothingEnrolled: boolean;
      contained: { name: string }[];
      overBudget: { name: string; spentUsd: number }[];
      credentialsNearingExpiry: { label: string; expired: boolean }[];
    };

    expect(health.planeEnabled).toBe(true);
    expect(health.enabledWithNothingEnrolled).toBe(false);
    expect(health.contained.map((row) => row.name)).toEqual(["crm-refund-bot"]);
    expect(health.overBudget[0]?.spentUsd).toBe(250);
    expect(health.credentialsNearingExpiry[0]?.label).toBe("expiring soon");
    expect(health.credentialsNearingExpiry[0]?.expired).toBe(false);
  });

  it("leaves a credential with no expiry out of the expiry rows", async () => {
    const { name } = await enrolledAgent();
    await run(
      args(["credential", "mint", name], {
        kind: "bearer",
        label: "no expiry",
        reauthenticated: true,
      }),
    );

    const result = await run(args(["health"], { json: true }));
    const health = JSON.parse(result.stdout) as { credentialsNearingExpiry: unknown[] };
    expect(health.credentialsNearingExpiry).toEqual([]);
  });
});

describe("tool grant parsing", () => {
  it("reads an operator risk rating off the end of a tool name", () => {
    expect(parseTools(["crm.issue_refund:high_consequence"])).toEqual([
      { tool: "crm.issue_refund", operatorRisk: "high_consequence" },
    ]);
  });

  it("leaves a tool name that merely contains a colon intact", () => {
    // External tool names are chosen by whoever built the agent. Splitting on
    // the first colon would enroll a tool called "crm" and drop the rest.
    expect(parseTools(["crm:issue_refund"])).toEqual([{ tool: "crm:issue_refund" }]);
    expect(parseTools(["crm:issue_refund:sensitive"])).toEqual([
      { tool: "crm:issue_refund", operatorRisk: "sensitive" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Process-level behaviour
// ---------------------------------------------------------------------------

const runProcess = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "main.ts");
const TSX = resolve(HERE, "../../node_modules/.bin/tsx");

async function cli(
  argv: readonly string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await runProcess(TSX, [CLI, ...argv], {
      env: { ...process.env, PV_ENV: "development", PV_STORE: "memory", ...env },
      timeout: 60_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

describe("pv agents — as a process", () => {
  it("prints the verb list and exits non-zero when given no verb", async () => {
    const result = await cli(["agents"], { PV_EXTERNAL_AGENTS_ENABLED: "true" });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/govern the agents MVW runs elsewhere/);
    expect(result.stderr).toMatch(/credential mint/);
    expect(result.stdout).toBe("");
  });

  it("says the plane is switched off rather than showing an empty roster", async () => {
    // The plane ships off. An empty roster would read as "nothing is running
    // out there", which is a claim this deployment has not earned.
    const result = await cli(["agents", "list"]);
    expect(result.code).toBe(78); // EX_CONFIG
    expect(result.stderr).toMatch(/switched off in this deployment/);
    expect(result.stdout).toBe("");
  });

  it("exits non-zero on an unknown verb instead of doing nothing quietly", async () => {
    const result = await cli(["agents", "frobnicate"], { PV_EXTERNAL_AGENTS_ENABLED: "true" });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Unknown agents subcommand/);
  });

  it("lists agents as JSON on a clean stdout", async () => {
    const result = await cli(["agents", "list", "--json"], {
      PV_EXTERNAL_AGENTS_ENABLED: "true",
    });
    expect(result.code).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("advertises the agents command in the top-level usage", async () => {
    const result = await cli([]);
    expect(result.stderr).toMatch(/agents <verb>/);
  });
});
