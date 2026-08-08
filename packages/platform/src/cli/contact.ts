import { readFileSync } from "node:fs";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestBytes, digestValue, isDigest, type Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef } from "../record/types.js";
import {
  SEND_HIGH_RISK_MESSAGE_ACTION,
  SEND_MESSAGE_ACTION,
} from "../contact/actions.js";
import { destinationFingerprint } from "../contact/gate.js";
import {
  ALL_CHANNELS,
  ALL_PURPOSES,
  CONSENT_SOURCES,
  CONTACT_CHANNELS,
  CONTACT_PURPOSES,
  DO_NOT_CALL_LISTS,
  RECIPIENT_RELATIONSHIPS,
} from "../contact/types.js";
import type {
  ConsentChannelScope,
  ConsentPurposeScope,
  ConsentSource,
  ContactChannel,
  ContactPurpose,
  DoNotCallList,
  OutboundRequest,
  RecipientRelationship,
} from "../contact/types.js";
import type { Platform } from "../platform.js";

/**
 * `pv contact` — the outbound compliance gate from a terminal.
 *
 * The gate is where a mistake is a statutory-damages claim per message, and
 * until this file existed it had never gated one outside its own tests:
 * `ContactGate` and `ConsentLedger` were composed nowhere, so there was no way
 * to record a consent, add a do-not-call entry, or clear a send at all. This is
 * the operator surface that makes the control reachable — a control nothing can
 * reach refuses nothing.
 *
 * The house rules apply, each closing a way a command line lies to its operator:
 *
 * **Diagnostics to stderr, the answer to stdout**, so `pv contact check ... |
 * jq` composes and a redirected send record contains the record and nothing
 * else. The one thing each verb prints on stdout is its answer: a consent event
 * id, a consent status, whether a message is sendable, a cleared message id.
 *
 * **The real services, never a second copy of their rules.** Every verb goes
 * through `ConsentLedger` or `ContactGate` — the composition root's one
 * instance of each, over the one store the gate reads and the ledger writes.
 * There is no rule re-implemented here: consent is still per channel and
 * purpose, a revocation still wins, a suppression still refuses, quiet hours are
 * still measured at the recipient's clock, and this command cannot weaken any of
 * it because it does not own it.
 *
 * **Check is a dry run; send is the chokepoint.** `contact check` runs every
 * check and prints the answer without sending, recording, or authorizing
 * anything — the evidence *is* the answer, so it exits 0 even when a message is
 * not sendable. `contact send` is the only path that may act: it authorizes,
 * consumes the approval, and records the governed message. A refusal raises and
 * exits 1 with its reason.
 *
 * **There is no real outbound channel.** No adapter delivers an SMS, an email,
 * or a call in this build — that is L11-adjacent, and honest. Recording the
 * governed message through the gate *is* the send here, and the help text says
 * so rather than implying a letter left the building.
 *
 * **Exit codes mean something.** Zero means the thing happened (or the dry run
 * was answered); a refusal exits non-zero with its reason, propagated to the
 * top-level handler in `main.ts`.
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

export const CONTACT_USAGE = `
pv contact — record consent and clear outbound messages through the compliance gate

  contact consent grant  --owner <ref> --channel <voice|sms|email|postal>
                         --purpose <transactional|servicing|collections|marketing|survey>
                         --source <${CONSENT_SOURCES.join("|")}>
                         (--evidence-file <path> | --evidence-digest <sha256>)
                         [--captured-by <id>] [--evidence-uri <uri>]
                         [--effective-at <iso>] [--note <text>]
              Record a consent grant with its provenance. Consent is for one
              channel and one purpose; a blanket grant is refused.

  contact consent revoke --owner <ref> (--channel <ch> | --all-channels)
                         (--purpose <p> | --all-purposes)
                         --source <...> (--evidence-file <path> | --evidence-digest <sha256>)
                         [--captured-by <id>] [--effective-at <iso>] [--note <text>]
              Record a revocation — the stop signal, made durable first. It may
              be blanket: "stop contacting me" is a thing the law honours.

  contact consent state  --owner <ref> --channel <ch> --purpose <p> [--as-of <iso>]
              Show the derived consent state for one owner, channel and purpose.
              A read: it sends nothing and exits 0.

  contact dnc add        [--list <federal|state|internal>] [--owner <ref>]
                         [--destination <value> --destination-channel <ch>
                          | --destination-digest <sha256>]
                         [--channels <a,b>] [--jurisdiction <US|FL|...>]
                         [--registered-at <iso>] [--expires-at <iso>] --source <text>
              Add a do-not-call entry, keyed by owner, destination, or both.
              An empty --channels means every channel. Suppression only widens.

  contact check          --owner <ref> --channel <ch> --purpose <p>
                         --timezone <IANA zone> [--jurisdiction <US|FL|...>]
                         [--relationship <owner|co_owner|authorised_representative|third_party>]
                         (--destination <value> | --destination-digest <sha256>)
                         [--content <text> | --content-digest <sha256>]
              The safe dry run: run every check and print whether the message is
              sendable, and if not, why. Sends nothing, records nothing, exits 0.

  contact send           <same targeting flags as check>
                         --content <text> | --content-digest <sha256>
                         --idempotency-key <key> [--model-id <id>]
                         [--template-id <id> --template-version <n>]
                         --raise-approval
              Raise the approval a send requires. Somebody else grants it with
              "pv approvals decide", then:
  contact send           <same flags> --approval <id> --reauthenticated
              Clear the send: authorize, consume the approval, and record the
              governed message. Refused (exit 1) by any failing check. There is
              no real outbound channel — recording the message through the gate
              IS the send in this build.

Global:
  --json      Machine-readable output
  --operator  Name the operator this command is attributed to
  --role      Name the role the operator is acting in (repeatable). Consent is
              recorded by owner-services staff and their supervisors; a send is a
              supervisor's. Defaults to platform_admin, which neither permits.

Sending is high-consequence: it needs an approval a different person granted
through "pv approvals decide", and a fresh re-authentication the sender asserts
with --reauthenticated, which the audit record shows came from the CLI.

Exit codes:
  0   the thing happened, or the dry run was answered
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
  // so `--source` with nothing after it is a usage error rather than the literal
  // word "true" being recorded as where a consent came from.
  return value === undefined || value === "true" ? undefined : value;
}

function flagPresent(args: CommandArgs, name: string): boolean {
  return args.flags[name] !== undefined;
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

function csv(args: CommandArgs, name: string): readonly string[] {
  const raw = first(args, name);
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// Domain-flag validation. A bad channel is a usage error, caught here rather
// than turned into an "unknown channel" refusal deeper in the service.
// ---------------------------------------------------------------------------

function requireChannel(args: CommandArgs, name = "channel"): ContactChannel {
  const value = requireFlag(args, name);
  if (!CONTACT_CHANNELS.includes(value as ContactChannel)) {
    throw new InvalidInputError(
      `--${name} must be one of ${CONTACT_CHANNELS.join(", ")}; received "${value}".`,
      name,
    );
  }
  return value as ContactChannel;
}

function requirePurpose(args: CommandArgs, name = "purpose"): ContactPurpose {
  const value = requireFlag(args, name);
  if (!CONTACT_PURPOSES.includes(value as ContactPurpose)) {
    throw new InvalidInputError(
      `--${name} must be one of ${CONTACT_PURPOSES.join(", ")}; received "${value}".`,
      name,
    );
  }
  return value as ContactPurpose;
}

function resolveRelationship(args: CommandArgs): RecipientRelationship {
  const value = first(args, "relationship") ?? "owner";
  if (!RECIPIENT_RELATIONSHIPS.includes(value as RecipientRelationship)) {
    throw new InvalidInputError(
      `--relationship must be one of ${RECIPIENT_RELATIONSHIPS.join(", ")}; received "${value}".`,
      "relationship",
    );
  }
  return value as RecipientRelationship;
}

function requireSource(args: CommandArgs): ConsentSource {
  const value = requireFlag(args, "source");
  if (!CONSENT_SOURCES.includes(value as ConsentSource)) {
    throw new InvalidInputError(
      `--source must be one of ${CONSENT_SOURCES.join(", ")}; received "${value}".`,
      "source",
    );
  }
  return value as ConsentSource;
}

/**
 * The fingerprint of the evidence a consent came from.
 *
 * The platform never holds the signed form or the call recording — only a
 * fingerprint of it — so the operator supplies either the artifact to
 * fingerprint (`--evidence-file`) or the fingerprint itself (`--evidence-digest`)
 * when it was computed elsewhere. One is required: a consent event with no
 * evidence is an assertion, not proof, and the ledger refuses it.
 */
function evidenceDigest(args: CommandArgs): Digest {
  const digest = first(args, "evidence-digest");
  if (digest !== undefined) {
    if (!isDigest(digest)) {
      throw new InvalidInputError(
        `--evidence-digest must be a sha256 fingerprint; received "${digest}".`,
        "evidence-digest",
      );
    }
    return digest;
  }
  const file = first(args, "evidence-file");
  if (file !== undefined) {
    try {
      return digestBytes(readFileSync(file));
    } catch (error) {
      throw new InvalidInputError(
        `Could not fingerprint the evidence at ${file}: ${error instanceof Error ? error.message : String(error)}`,
        "evidence-file",
      );
    }
  }
  throw new InvalidInputError(
    "Consent needs a fingerprint of the evidence it came from: --evidence-file <path> to fingerprint the signed form or recording, or --evidence-digest <sha256> if it was computed elsewhere.",
    "evidence",
  );
}

/**
 * The destination fingerprint for a send or a check.
 *
 * The gate never handles a raw number or address — it matches a suppression
 * list and counts frequency on a fingerprint. `--destination` is fingerprinted
 * on the message's own channel; `--destination-digest` is one already computed.
 */
function requireDestinationDigest(args: CommandArgs, channel: ContactChannel): string {
  const digest = first(args, "destination-digest");
  if (digest !== undefined) {
    if (!isDigest(digest)) {
      throw new InvalidInputError(
        `--destination-digest must be a sha256 fingerprint from destinationFingerprint(); received "${digest}".`,
        "destination-digest",
      );
    }
    return digest;
  }
  const raw = first(args, "destination");
  if (raw !== undefined) return destinationFingerprint(channel, raw);
  throw new InvalidInputError(
    "A destination is required: --destination <value> (fingerprinted on the channel), or --destination-digest <sha256> if you already hold the fingerprint. The gate never sees a raw number or address.",
    "destination",
  );
}

/**
 * The content fingerprint for a send or a check.
 *
 * A send needs the exact content it would deliver, so one of `--content` /
 * `--content-digest` is required there. A check feeds the content into no
 * outcome — it is a dry run of consent, suppression, quiet hours and caps — so
 * when neither is given it uses a stable placeholder rather than refusing.
 */
function contentDigest(args: CommandArgs, required: boolean): Digest {
  const digest = first(args, "content-digest");
  if (digest !== undefined) {
    if (!isDigest(digest)) {
      throw new InvalidInputError(
        `--content-digest must be a sha256 digest of exactly what would be sent; received "${digest}".`,
        "content-digest",
      );
    }
    return digest;
  }
  const text = first(args, "content");
  if (text !== undefined) return digestBytes(text);
  if (required) {
    throw new InvalidInputError(
      "A send needs the content it would deliver: --content <text> to fingerprint it, or --content-digest <sha256>.",
      "content",
    );
  }
  return digestValue({ contactCheck: "dry-run" });
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface ContactCommandContext {
  readonly platform: Platform;
  /** The operator, as main.ts attributes them. Unverified, and marked `cli:`. */
  readonly actor: ActorRef;
  readonly correlationId?: string | undefined;
}

export async function commandContact(
  args: CommandArgs,
  context: ContactCommandContext,
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

async function dispatch(args: CommandArgs, context: ContactCommandContext): Promise<number> {
  const sub = args.positional[1];
  switch (sub) {
    case "consent":
      return await consentVerb(args, context);
    case "dnc":
      return await dncVerb(args, context);
    case "check":
      return await checkSend(args, context);
    case "send":
      return await sendMessage(args, context);
    default:
      note(`Unknown contact subcommand: ${sub ?? "(none)"}\n`);
      note(CONTACT_USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// consent grant | revoke | state
// ---------------------------------------------------------------------------

async function consentVerb(args: CommandArgs, context: ContactCommandContext): Promise<number> {
  const verb = args.positional[2];
  switch (verb) {
    case "grant":
      return await recordConsent(args, context, "granted");
    case "revoke":
      return await recordConsent(args, context, "revoked");
    case "state":
      return await consentState(args, context);
    default:
      note(`Unknown consent subcommand: ${verb ?? "(none)"}. Try: grant, revoke, state.`);
      return 2;
  }
}

async function recordConsent(
  args: CommandArgs,
  context: ContactCommandContext,
  kind: "granted" | "revoked",
): Promise<number> {
  const { platform } = context;

  // Breadth is a revocation's alone: "stop contacting me about anything" is a
  // thing the law honours; a blanket grant is not consent to anything specific.
  // The ledger enforces this too — asserted here only to give a clear flag name.
  const channel: ConsentChannelScope =
    kind === "revoked" && flagPresent(args, "all-channels") ? ALL_CHANNELS : requireChannel(args);
  const purpose: ConsentPurposeScope =
    kind === "revoked" && flagPresent(args, "all-purposes") ? ALL_PURPOSES : requirePurpose(args);

  const event = await platform.consentLedger.record({
    subjectRef: requireFlag(args, "owner"),
    channel,
    purpose,
    kind,
    // The instant the owner acted. Defaults to now; the ledger refuses a future
    // date and back-dates are recorded with the gap between the two clocks.
    effectiveAt: first(args, "effective-at") ?? platform.clock.nowIso(),
    provenance: {
      source: requireSource(args),
      capturedBy: first(args, "captured-by") ?? context.actor.actorId,
      evidenceDigest: evidenceDigest(args),
      ...(first(args, "evidence-uri") !== undefined ? { evidenceUri: requireFlag(args, "evidence-uri") } : {}),
      ...(first(args, "note") !== undefined ? { note: requireFlag(args, "note") } : {}),
    },
    actor: context.actor,
    // `consent.record` is sensitive, which shadow mode does not permit;
    // supervised is the mode a deliberate write is made in.
    mode: "supervised",
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  });

  note(
    kind === "granted"
      ? `Recorded consent for ${event.subjectRef} on ${event.channel}/${event.purpose}, effective ${event.effectiveAt}, from ${event.provenance.source}. Its audit receipt is ${event.receiptId ?? "(pending)"}.`
      : `Recorded a revocation for ${event.subjectRef} on ${String(event.channel)}/${String(event.purpose)}, effective ${event.effectiveAt}. A revocation wins over any grant it does not strictly postdate on both clocks.`,
  );

  if (args.json) {
    emit(
      {
        consentId: event.id,
        subjectRef: event.subjectRef,
        channel: event.channel,
        purpose: event.purpose,
        kind: event.kind,
        effectiveAt: event.effectiveAt,
        recordedAt: event.recordedAt,
        source: event.provenance.source,
        receiptId: event.receiptId ?? null,
      },
      args,
    );
    return 0;
  }
  // The answer, alone on stdout: the consent event id.
  console.log(event.id);
  return 0;
}

async function consentState(args: CommandArgs, context: ContactCommandContext): Promise<number> {
  const { platform } = context;
  const state = await platform.consentLedger.stateFor({
    subjectRef: requireFlag(args, "owner"),
    channel: requireChannel(args),
    purpose: requirePurpose(args),
    asOf: first(args, "as-of") ?? platform.clock.nowIso(),
  });

  if (args.json) {
    emit(state, args);
    return 0;
  }

  // The reasoning to stderr, the one answer — the status — to stdout, so
  // `pv contact consent state ... ` composes and a caller can gate on it.
  note(`owner             ${state.subjectRef}`);
  note(`channel/purpose   ${state.channel}/${state.purpose}`);
  if (state.since) note(`since             ${state.since}`);
  if (state.decidedBy) note(`decided by        ${state.decidedBy}`);
  note(`events considered ${state.eventsConsidered}`);
  note(
    state.status === "never_given"
      ? "No consent on record for this channel and purpose. A message on it will be refused at the gate."
      : state.status === "revoked"
        ? "Revoked. A message on it will be refused, and re-consent must be later than the revocation on both clocks to restore it."
        : "Consent is on record. The gate still checks do-not-call, quiet hours, and frequency caps before a send clears.",
  );
  console.log(state.status);
  return 0;
}

// ---------------------------------------------------------------------------
// dnc add
// ---------------------------------------------------------------------------

async function dncVerb(args: CommandArgs, context: ContactCommandContext): Promise<number> {
  const verb = args.positional[2];
  if (verb !== "add") {
    note(`Unknown dnc subcommand: ${verb ?? "(none)"}. Try: add.`);
    return 2;
  }
  return await dncAdd(args, context);
}

async function dncAdd(args: CommandArgs, context: ContactCommandContext): Promise<number> {
  const { platform } = context;

  const list = (first(args, "list") ?? "internal") as DoNotCallList;
  if (!DO_NOT_CALL_LISTS.includes(list)) {
    throw new InvalidInputError(
      `--list must be one of ${DO_NOT_CALL_LISTS.join(", ")}; received "${list}".`,
      "list",
    );
  }

  // A subject, a destination, or both. The service refuses an entry with
  // neither — one that would match nothing — so this stays a validation, not a
  // second copy of the rule.
  const subjectRef = first(args, "owner") ?? "";
  const destinationDigest = optionalDestinationDigest(args);

  const channels = csv(args, "channels");
  for (const channel of channels) {
    if (!CONTACT_CHANNELS.includes(channel as ContactChannel)) {
      throw new InvalidInputError(
        `--channels must be a comma-separated list of ${CONTACT_CHANNELS.join(", ")}; received "${channel}".`,
        "channels",
      );
    }
  }

  const expiresAtRaw = first(args, "expires-at");
  const entry = await platform.consentLedger.suppress({
    list,
    subjectRef,
    destinationDigest,
    channels: channels as ContactChannel[],
    jurisdiction: first(args, "jurisdiction") ?? "US",
    registeredAt: first(args, "registered-at") ?? platform.clock.nowIso(),
    // Null means it does not lapse. An absent field would read as "no expiry
    // recorded", which is a different claim.
    expiresAt: expiresAtRaw ?? null,
    source: requireFlag(args, "source"),
    actor: context.actor,
    // `contact.record_do_not_call` is sensitive; supervised is its mode.
    mode: "supervised",
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  });

  note(
    `Suppressed on the ${entry.list} list${entry.subjectRef ? ` for ${entry.subjectRef}` : ""}${
      entry.destinationDigest ? ` (destination fingerprint)` : ""
    }, covering ${entry.channels.length === 0 ? "every channel" : entry.channels.join(", ")}, in ${entry.jurisdiction}, until ${entry.expiresAt ?? "it is lifted (it does not expire)"}. Suppression only widens.`,
  );

  if (args.json) {
    emit(entry, args);
    return 0;
  }
  // The answer, alone on stdout: the entry's key.
  console.log(`${entry.list}:${entry.subjectRef || entry.destinationDigest}`);
  return 0;
}

function optionalDestinationDigest(args: CommandArgs): string {
  const digest = first(args, "destination-digest");
  if (digest !== undefined) {
    if (!isDigest(digest)) {
      throw new InvalidInputError(
        `--destination-digest must be a sha256 fingerprint; received "${digest}".`,
        "destination-digest",
      );
    }
    return digest;
  }
  const raw = first(args, "destination");
  if (raw === undefined) return "";
  const channel = first(args, "destination-channel");
  if (channel === undefined || !CONTACT_CHANNELS.includes(channel as ContactChannel)) {
    throw new InvalidInputError(
      `--destination needs --destination-channel <${CONTACT_CHANNELS.join("|")}> so the value is fingerprinted the way the gate matches it.`,
      "destination-channel",
    );
  }
  return destinationFingerprint(channel as ContactChannel, raw);
}

// ---------------------------------------------------------------------------
// check — the safe dry run
// ---------------------------------------------------------------------------

async function checkSend(args: CommandArgs, context: ContactCommandContext): Promise<number> {
  const request = buildRequest(args, context, { requireContent: false, requireIdempotency: false });
  const evidence = await context.platform.contactGate.evaluate(request);

  if (args.json) {
    emit(evidence, args);
    // Exit 0 either way: the evidence IS the answer, and a "not sendable" dry
    // run is a successful answer to the question asked.
    return 0;
  }

  // The check-by-check reasoning is the reviewer's material, not the answer, so
  // it goes to stderr; the one answer — sendable, or the reason it is not —
  // goes to stdout, and the verb exits 0 either way because the evidence IS the
  // answer to a dry run.
  const failing = evidence.checks.find((check) => check.outcome !== "pass");
  note(`owner             ${evidence.subjectRef}`);
  note(`channel/purpose   ${evidence.channel}/${evidence.purpose}`);
  note(`jurisdiction      ${evidence.jurisdiction}`);
  note(`recipient clock   ${evidence.recipientLocalTime} (${evidence.recipientTimeZone})`);
  note(`policy            ${evidence.policyVersion}`);
  note("");
  for (const check of evidence.checks) {
    const mark = check.outcome === "pass" ? "pass " : check.outcome === "block" ? "BLOCK" : "UNAVL";
    note(`  ${mark}  ${check.name.padEnd(14)} ${check.summary}`);
  }
  note("");
  note(
    evidence.allowed
      ? "Sendable. This is a dry run: nothing was sent, recorded, or authorized. `contact send` still needs an approval."
      : `Not sendable: ${failing?.summary ?? "a required check could not be answered."} Nothing was sent.`,
  );
  console.log(evidence.allowed ? "sendable" : (evidence.blockingReason ?? "contact.evidence_unavailable"));
  return 0;
}

// ---------------------------------------------------------------------------
// send — the governed chokepoint
// ---------------------------------------------------------------------------

/**
 * Refuse to invent a step-up the platform cannot observe.
 *
 * The command line cannot verify who is typing — `main.ts` says so where it
 * builds the actor. `--reauthenticated` is the sender asserting they have just
 * re-authenticated to this host, and it is required rather than assumed: a
 * high-consequence send that quietly counted "we are on a terminal" as
 * re-authentication would make the step-up requirement decorative. The audit
 * record shows the send came from the CLI, so the assertion is visible to
 * whoever reviews it. The *approval* this send spends is separate, granted by a
 * different person through `pv approvals decide`, where an assertion is not
 * accepted at all.
 */
function senderStepUpSeconds(args: CommandArgs): number {
  if (!flagPresent(args, "reauthenticated")) {
    throw new DeniedError(
      "authorization.step_up_required",
      "Sending an owner message requires a fresh re-authentication. The command line cannot verify one, so it is asserted: re-authenticate to this host and pass --reauthenticated.",
      { action: SEND_MESSAGE_ACTION },
    );
  }
  return 0;
}

async function sendMessage(args: CommandArgs, context: ContactCommandContext): Promise<number> {
  const { platform } = context;
  const request = buildRequest(args, context, { requireContent: true, requireIdempotency: true });
  const band = platform.contactGate.riskBand(request);
  const action = band === "elevated" ? SEND_HIGH_RISK_MESSAGE_ACTION : SEND_MESSAGE_ACTION;

  if (flagPresent(args, "raise-approval")) {
    // The approval is bound to the proposal digest — this recipient, channel,
    // purpose, content and band — so a message altered before it is sent cannot
    // be cleared under it. Eligible roles and the approver count come off the
    // registered action, not this file, so they cannot drift from the tier.
    const descriptor = platform.registry.require(action);
    const approval = await platform.approvals.request({
      action,
      proposalDigest: platform.contactGate.proposalDigest(request),
      summary: `Send a ${request.channel} ${request.purpose} message to ${request.subjectRef}`,
      requestedBy: context.actor,
      approvalsRequired: descriptor.approvalsRequired,
      eligibleRoles: descriptor.allowedRoles,
      subject: {
        subjectRef: request.subjectRef,
        channel: request.channel,
        purpose: request.purpose,
        jurisdiction: request.jurisdiction,
      },
      ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    });

    note(
      `Approval ${approval.id} raised to send a ${request.channel} ${request.purpose} message to ${request.subjectRef} (${band} band, ${descriptor.approvalsRequired} approver(s) from ${descriptor.allowedRoles.join(", ")}). Somebody other than ${context.actor.actorId} must grant it — nobody approves their own request:\n  pv approvals decide ${approval.id} --grant --note "<why>" --session-file <path>\nGranting a high-consequence action needs a session this platform can see the authentication instant of; see "pv approvals". Then:\n  pv contact send <the same targeting flags> --approval ${approval.id} --reauthenticated`,
    );
    emit(args.json ? { approvalId: approval.id, band, action } : approval.id, args);
    return 0;
  }

  const approvalId = requireFlag(args, "approval") as Id<"approval">;
  const stepUp = senderStepUpSeconds(args);

  // The chokepoint. A refusal raises a DeniedError, which is deliberately not
  // caught here: it propagates to main.ts, which prints its reason and exits 1.
  // Nothing was sent on that path — the gate records the blocked attempt itself.
  const clearance = await platform.contactGate.clear({
    ...request,
    approvalId,
    secondsSinceAuthentication: stepUp,
  });

  note(
    clearance.replayed
      ? `Recognised an earlier send under idempotency key "${request.idempotencyKey}" — not sent again. One owner, one message.`
      : `Cleared and recorded the governed message to ${clearance.message.subjectRef} on ${clearance.message.channel} (${clearance.message.riskBand} band). There is no outbound channel in this build: the governed record IS the send. Its audit receipt is ${clearance.message.receiptId ?? "(pending)"}.`,
  );

  if (args.json) {
    emit(
      {
        messageId: clearance.message.id,
        status: clearance.message.status,
        riskBand: clearance.message.riskBand,
        replayed: clearance.replayed,
        receiptId: clearance.message.receiptId ?? null,
        evidenceDigest: clearance.message.evidenceDigest,
        policyVersion: clearance.evidence.policyVersion,
      },
      args,
    );
    return 0;
  }
  // The answer, alone on stdout: the cleared message id.
  console.log(clearance.message.id);
  return 0;
}

// ---------------------------------------------------------------------------
// Building the outbound request the gate reads
// ---------------------------------------------------------------------------

/**
 * Assemble an `OutboundRequest` from the flags `check` and `send` share.
 *
 * The two verbs target the same message the same way; only their obligations
 * differ. `send` requires the real content and a real idempotency key, because
 * it writes; `check` needs neither, because it is a dry run whose content feeds
 * no outcome and whose key is never stored.
 */
function buildRequest(
  args: CommandArgs,
  context: ContactCommandContext,
  options: { readonly requireContent: boolean; readonly requireIdempotency: boolean },
): OutboundRequest {
  const channel = requireChannel(args);
  const purpose = requirePurpose(args);
  const subjectRef = requireFlag(args, "owner");

  return {
    subjectRef,
    channel,
    purpose,
    relationship: resolveRelationship(args),
    destinationDigest: requireDestinationDigest(args, channel),
    contentDigest: contentDigest(args, options.requireContent),
    jurisdiction: first(args, "jurisdiction") ?? "US",
    recipientTimeZone: requireFlag(args, "timezone"),
    actor: context.actor,
    // Both the dry run and the send run supervised: the gate does no
    // authorization on `check`, and `send` is high-consequence, which shadow
    // does not permit.
    mode: "supervised",
    idempotencyKey: options.requireIdempotency
      ? requireFlag(args, "idempotency-key")
      : (first(args, "idempotency-key") ?? `check:${subjectRef}:${channel}:${purpose}`),
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    ...(first(args, "model-id") !== undefined ? { modelId: requireFlag(args, "model-id") } : {}),
    ...(first(args, "template-id") !== undefined
      ? { templateId: requireFlag(args, "template-id") as Id<"template"> }
      : {}),
    ...(flagPresent(args, "template-version")
      ? { templateVersion: requireInt(args, "template-version") }
      : {}),
  };
}
