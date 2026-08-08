import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FixedClock } from "../kernel/clock.js";
import { loadConfig } from "../kernel/config.js";
import { DeniedError } from "../kernel/errors.js";
import { SeededIdGenerator, type Id } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { digestValue } from "../kernel/hash.js";
import { buildPlatform, type Platform } from "../platform.js";
import type { ActorRef } from "../record/types.js";
import { commandContact, type CommandArgs, type ContactCommandContext } from "./contact.js";

/**
 * The contact gate, driven through the surface an operator actually has.
 *
 * These are not the gate's own tests — those live in `contact/contact.test.ts`
 * and prove the checks in isolation. These prove the wiring: that `buildPlatform`
 * composes the gate, the ledger, and their shared store at all; that the CLI
 * reaches the one composed instance; and that a consent recorded from a terminal
 * is the consent the gate reads a moment later when it clears — or refuses — a
 * send. Before this file the gate had no caller outside its own tests, so every
 * one of these paths was unreachable.
 */

const START = "2026-08-06T16:00:00.000Z";

/** Records consent; may not send. `consent.record` permits owner-services staff. */
const AGENT: ActorRef = { actorId: "cli:agent", kind: "human", roles: ["owner_services_agent"] };
/** Holds the role the outbound action permits, and the do-not-call one. */
const SUPERVISOR: ActorRef = { actorId: "cli:supervisor", kind: "human", roles: ["supervisor"] };
/** A second, distinct supervisor: the approver a send's segregation of duties needs. */
const SUPERVISOR_TWO: ActorRef = { actorId: "cli:supervisor2", kind: "human", roles: ["supervisor"] };

const EVIDENCE = digestValue({ artifact: "signed-consent-form" });

function args(line: string): CommandArgs {
  const tokens = tokenize(line);
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        (flags[token.slice(2)] ??= []).push("true");
      } else {
        (flags[token.slice(2)] ??= []).push(next);
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags, json: flags["json"] !== undefined };
}

/** Split on spaces, but keep a single-quoted run together so a flag can carry a sentence. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  const pattern = /'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) out.push(match[1] ?? match[2] ?? "");
  return out;
}

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly thrown?: unknown;
}

async function capture(platform: Platform, line: string, actor: ActorRef): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (message?: unknown) => out.push(String(message));
  console.error = (message?: unknown) => err.push(String(message));
  const context: ContactCommandContext = { platform, actor };
  try {
    const code = await commandContact(args(line), context);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } catch (thrown) {
    return { code: 1, stdout: out.join("\n"), stderr: err.join("\n"), thrown };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

async function run(platform: Platform, line: string, actor: ActorRef): Promise<Captured> {
  const result = await capture(platform, line, actor);
  if (result.thrown) throw result.thrown;
  return result;
}

/**
 * The targeting flags check and send share, for one owner on sms/servicing.
 *
 * Deliberately without a timezone: each call appends its own, because a repeated
 * `--timezone` would be read as the first occurrence and silently ignore the
 * second. The default recipient clock is Eastern.
 */
function target(owner = "ctr_owner_1", timeZone = "America/New_York"): string {
  return `--owner ${owner} --channel sms --purpose servicing --destination +14075550134 --timezone ${timeZone}`;
}

/** Grant sms/servicing consent for an owner through the CLI, as an agent. */
async function grant(platform: Platform, owner = "ctr_owner_1"): Promise<void> {
  await run(
    platform,
    `contact consent grant --owner ${owner} --channel sms --purpose servicing --source signed_document --evidence-digest ${EVIDENCE} --captured-by cli:agent`,
    AGENT,
  );
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe("the composition root wires the contact gate", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("contact-cli"),
      logger: createNullLogger(),
    });
  });

  afterEach(async () => {
    await platform.close();
  });

  it("exposes the gate, the ledger, and the store they share", () => {
    expect(platform.contactGate).toBeDefined();
    expect(platform.consentLedger).toBeDefined();
    expect(platform.contactStore).toBeDefined();
  });

  it("registers the contact actions in the one chokepoint", () => {
    // Without these the ledger's record, a do-not-call write, and the gate's
    // clear are each refused with an unknown-action error the moment they are
    // reached — which is why the gate had never gated a message.
    for (const action of [
      "consent.record",
      "contact.send_owner_message",
      "contact.send_high_risk_message",
      "contact.record_do_not_call",
    ]) {
      expect(platform.registry.get(action), `${action} must be registered`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The verbs, driven through the CLI
// ---------------------------------------------------------------------------

describe("pv contact, end to end", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
      clock: new FixedClock(START),
      ids: new SeededIdGenerator("contact-cli"),
      logger: createNullLogger(),
    });
  });

  afterEach(async () => {
    await platform.close();
  });

  it("check for an owner with no consent is not sendable, and says why", async () => {
    // 16:00Z is 12:00 in New York — outside quiet hours — so consent is the
    // check that refuses. The dry run answers on stdout and exits 0: the
    // evidence IS the answer.
    const check = await run(platform, `contact check ${target()}`, SUPERVISOR);
    expect(check.code).toBe(0);
    expect(check.stdout.trim()).toBe("contact.no_consent");
    expect(check.stderr).toMatch(/No consent on record/);
  });

  it("records consent through the CLI, and then the gate no longer blocks on it", async () => {
    const granted = await run(
      platform,
      `contact consent grant --owner ctr_owner_1 --channel sms --purpose servicing --source signed_document --evidence-digest ${EVIDENCE}`,
      AGENT,
    );
    expect(granted.code).toBe(0);
    expect(granted.stdout.trim()).toMatch(/^cns_/);

    const state = await run(
      platform,
      "contact consent state --owner ctr_owner_1 --channel sms --purpose servicing",
      SUPERVISOR,
    );
    expect(state.stdout.trim()).toBe("granted");

    const check = await run(platform, `contact check ${target()}`, SUPERVISOR);
    expect(check.stdout.trim()).toBe("sendable");
  });

  it("refuses to record consent through an actor without the role", async () => {
    // platform_admin is deliberately not on `consent.record`; the default CLI
    // actor is refused, which is why --role exists.
    const outsider: ActorRef = { actorId: "cli:admin", kind: "human", roles: ["platform_admin"] };
    const result = await capture(
      platform,
      `contact consent grant --owner ctr_owner_1 --channel sms --purpose servicing --source signed_document --evidence-digest ${EVIDENCE}`,
      outsider,
    );
    expect(result.thrown).toBeInstanceOf(DeniedError);
    expect((result.thrown as DeniedError).reason).toBe("authorization.action_not_permitted");
  });

  it("blocks a message inside quiet hours in the recipient's timezone", async () => {
    await grant(platform);
    // 2026-08-07T02:00Z is 22:00 in New York — inside the 21:00–08:00 window —
    // and 16:00 in Honolulu, outside it. The recipient's clock decides.
    platform.clock.set("2026-08-07T02:00:00.000Z");

    const eastern = await run(platform, `contact check ${target()}`, SUPERVISOR);
    expect(eastern.stdout.trim()).toBe("contact.quiet_hours");

    const hawaii = await run(
      platform,
      `contact check ${target("ctr_owner_1", "Pacific/Honolulu")}`,
      SUPERVISOR,
    );
    expect(hawaii.stdout.trim()).toBe("sendable");
  });

  it("a do-not-call entry blocks even with consent on record", async () => {
    await grant(platform);
    const dnc = await run(
      platform,
      "contact dnc add --owner ctr_owner_1 --jurisdiction US --source 'owner asked an agent to stop'",
      SUPERVISOR,
    );
    expect(dnc.code).toBe(0);

    const check = await run(platform, `contact check ${target()}`, SUPERVISOR);
    expect(check.stdout.trim()).toBe("contact.do_not_call");

    // And a real send is refused, not merely reported unsendable.
    const raised = await run(
      platform,
      `contact send ${target()} --content 'fee statement' --idempotency-key idem-dnc --raise-approval`,
      SUPERVISOR,
    );
    const approvalId = raised.stdout.trim();
    await grantSendApproval(platform, approvalId);
    const result = await capture(
      platform,
      `contact send ${target()} --content 'fee statement' --idempotency-key idem-dnc --approval ${approvalId} --reauthenticated`,
      SUPERVISOR,
    );
    expect(result.thrown).toBeInstanceOf(DeniedError);
    expect((result.thrown as DeniedError).reason).toBe("contact.do_not_call");
  });

  it("a revocation makes state read revoked and the gate refuse", async () => {
    await grant(platform);
    const revoke = await run(
      platform,
      `contact consent revoke --owner ctr_owner_1 --all-channels --all-purposes --source inbound_call --evidence-digest ${EVIDENCE}`,
      AGENT,
    );
    expect(revoke.code).toBe(0);

    const state = await run(
      platform,
      "contact consent state --owner ctr_owner_1 --channel sms --purpose servicing",
      SUPERVISOR,
    );
    expect(state.stdout.trim()).toBe("revoked");

    const check = await run(platform, `contact check ${target()}`, SUPERVISOR);
    expect(check.stdout.trim()).toBe("contact.revoked");
  });

  it("clears a governed send and recognises a replay on the same key", async () => {
    await grant(platform);
    const flags = `${target()} --content 'Your maintenance fee statement is ready.' --idempotency-key idem-send`;

    const raised = await run(platform, `contact send ${flags} --raise-approval`, SUPERVISOR);
    expect(raised.code).toBe(0);
    const approvalId = raised.stdout.trim();
    expect(approvalId).toMatch(/^apr_/);

    // A different, eligible supervisor grants it — nobody approves their own
    // send. This is the step `pv approvals decide` performs against a session;
    // here the platform's own service stands in with an observed step-up.
    await grantSendApproval(platform, approvalId);

    const first = await run(
      platform,
      `contact send ${flags} --approval ${approvalId} --reauthenticated`,
      SUPERVISOR,
    );
    expect(first.code).toBe(0);
    const messageId = first.stdout.trim();
    expect(messageId).toMatch(/^msg_/);
    expect(first.stderr).toMatch(/no outbound channel in this build/);

    // The governed record exists, cleared and receipted.
    const stored = await platform.contactStore.findOutboundMessageByKey("idem-send");
    expect(stored?.status).toBe("cleared");
    expect(stored?.receiptId).toBeDefined();

    // A second identical send on the same key is recognised, not double-sent.
    const second = await run(
      platform,
      `contact send ${flags} --approval ${approvalId} --reauthenticated`,
      SUPERVISOR,
    );
    expect(second.stdout.trim()).toBe(messageId);
    expect(second.stderr).toMatch(/not sent again/);
    const cleared = await platform.contactStore.listOutboundMessages({ status: "cleared" });
    expect(cleared).toHaveLength(1);
  });

  it("refuses a send with no --reauthenticated, before touching the gate", async () => {
    await grant(platform);
    const flags = `${target()} --content 'x' --idempotency-key idem-nostepup`;
    const raised = await run(platform, `contact send ${flags} --raise-approval`, SUPERVISOR);
    const approvalId = raised.stdout.trim();
    await grantSendApproval(platform, approvalId);

    const result = await capture(
      platform,
      `contact send ${flags} --approval ${approvalId}`,
      SUPERVISOR,
    );
    expect(result.thrown).toBeInstanceOf(DeniedError);
    expect((result.thrown as DeniedError).reason).toBe("authorization.step_up_required");
    // Nothing was cleared: the assertion is refused before the gate is reached.
    expect(await platform.contactStore.findOutboundMessageByKey("idem-nostepup")).toBeNull();
  });

  it("refuses an abbreviation timezone alias rather than reading it an hour early", async () => {
    // L18. `EST` is a frozen UTC-5, so at 02:00Z it reads 21:00 rather than the
    // true 22:00 EDT and would clear a 21:00 quiet-hours check. The gate refuses
    // it as an unusable zone instead.
    await grant(platform);
    platform.clock.set("2026-08-07T02:00:00.000Z");
    const check = await run(platform, `contact check ${target("ctr_owner_1", "EST")}`, SUPERVISOR);
    expect(check.stdout.trim()).toBe("contact.evidence_unavailable");
  });

  it("a usage error exits 2, not 1: an unusable command is not a refusal", async () => {
    const result = await capture(platform, "contact consent grant --owner ctr_owner_1", AGENT);
    expect(result.code).toBe(2);
    expect(result.thrown).toBeUndefined();
  });
});

/**
 * Grant a send's approval as a second, eligible supervisor.
 *
 * The CLI raises the approval bound to the send's proposal digest; the grant is
 * the approver's act, through the same service `pv approvals decide` posts to. A
 * different person, an eligible role, and an observed step-up — none of which
 * the requester could supply for themselves.
 */
async function grantSendApproval(platform: Platform, approvalId: string): Promise<void> {
  await platform.approvals.decide({
    approvalId: approvalId as Id<"approval">,
    actor: SUPERVISOR_TWO,
    decision: "granted",
    requiresStepUp: true,
    secondsSinceAuthentication: 5,
    stepUpMaxAgeSeconds: 300,
  });
}
