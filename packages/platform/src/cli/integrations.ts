import { InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef } from "../record/types.js";
import {
  DEGRADATION_POLICIES,
  type DegradationPolicy,
} from "../integrations/degrade.js";
import {
  IntegrationCallError,
  type EgressOutcome,
  type EgressRequest,
  type HttpMethod,
} from "../integrations/egress.js";
import type { Platform } from "../platform.js";

/**
 * `pv integrations` — the one governed path to MVW's systems of record, from a
 * terminal.
 *
 * The integrations layer was written, tested, and reachable from no composition
 * root: `EgressClient` was constructed nowhere, `DegradationHandler` had no
 * production caller, and the contract and association ports were implemented
 * only by fakes built inside tests. So no system of record was ever reached from
 * the composed platform, and `PV_EGRESS_ALLOWLIST` bounded nothing because
 * nothing egressed through it. This is the operator surface that closes that:
 * every verb goes through the composition root's one egress client, one
 * degradation handler, and the two ports it shares, so what an operator drives
 * here is the same governed path the workflows and the API drive.
 *
 * The house rules apply, each closing a way a command line lies to its operator:
 *
 * **Diagnostics to stderr, the answer to stdout**, so `pv integrations contract
 * show <id> --json | jq` composes and a record piped to a file is not polluted
 * by a banner.
 *
 * **The real components, never a second copy.** Listing the systems of record,
 * reading a contract or an association, and making a governed egress call all go
 * through `platform`. The allowlist, the credential scoping, the recorded step,
 * the rate ceiling and the containment re-check are the egress client's, and this
 * command cannot weaken any of them because it does not own them — a call to an
 * unallowlisted host is refused here exactly as it is from a workflow step.
 *
 * **Exit codes mean something.** Zero means the thing happened; a refusal exits
 * non-zero with its reason, propagated to main.ts's top-level handler; a call
 * that was permitted and then failed exits 1 with the failure; a malformed
 * command is a usage error and exits 2.
 */

/** The shape `parseArgs` in main.ts produces. Structural, so it stays in step. */
export interface CommandArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string[]>>;
  readonly json: boolean;
}

export const INTEGRATIONS_USAGE = `
pv integrations — reach MVW's systems of record through one governed path

  integrations list
              The registered systems of record and their status: interface
              version, whether the shape has been confirmed with MVW, whether the
              system is reachable, and the depth of the degradation queue for each.
              Also prints the egress allowlist, which bounds every outbound call.

  integrations contract show <contractId>
              Read one contract record from the ContractRecordsPort and print it.
              In development the port is a seeded fake; a real adapter satisfies
              the same interface. Seeded ids include ctr_fl_recent_complete.

  integrations association show <associationId> [--fiscal-year <year>]
              Read an association from the AssociationRecordsPort and its budget
              and reserve summary for a fiscal year (default: the current year).
              A missing budget is reported as absent rather than as zero.

  integrations call --url <https url> --integration <name> --credential <ref>
                    [--method GET|HEAD|POST|PUT|PATCH|DELETE]
                    [--body <json>] [--idempotency-key <key>]
                    [--max-attempts <n>] [--step-name <name>]
                    [--subject <key=value>]... [--degrade queue|park_for_human|refuse]
                    [--show-body]
              Make one governed egress call through the EgressClient. The call is
              bounded by PV_EGRESS_ALLOWLIST: a host the allowlist does not name is
              refused (fail closed) before anything leaves the process, and a
              credential is presented only to the hosts it is scoped to. A POST,
              PUT, PATCH or DELETE needs --idempotency-key. --degrade runs the call
              under an explicit policy: a failure queues, parks, or refuses; a
              governance refusal is never degraded.

Global:
  --json      Machine-readable output
  --operator  Name the operator this command is attributed to
  --role      Name the role the operator is acting in (repeatable)

Exit codes:
  0   the thing happened, or the listing was produced
  1   refused (with its reason), or the call was permitted and then failed
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
  // so `--url` with nothing after it is a usage error rather than the literal
  // word "true" being taken as a URL.
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

/** Parse repeatable `--subject key=value` flags into a scalar map. */
function keyValues(args: CommandArgs, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of many(args, name)) {
    const at = pair.indexOf("=");
    if (at <= 0 || at === pair.length - 1) {
      throw new InvalidInputError(
        `--${name} must be key=value, e.g. --${name} contractId=ctr_1; received "${pair}"`,
        name,
      );
    }
    out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

const HTTP_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface IntegrationsCommandContext {
  readonly platform: Platform;
  /** The operator, as main.ts attributes them. Unverified, and marked `cli:`. */
  readonly actor: ActorRef;
  readonly correlationId?: string | undefined;
}

export async function commandIntegrations(
  args: CommandArgs,
  context: IntegrationsCommandContext,
): Promise<number> {
  try {
    return await dispatch(args, context);
  } catch (error) {
    // A malformed command is a usage error, not a crash. A call that was
    // permitted and then failed is a failure the operator must see, but it is
    // not a crash either. `DeniedError` is deliberately not caught: a refusal is
    // an outcome the operator has to see with its reason code, and it propagates
    // to main.ts's top-level handler.
    if (error instanceof InvalidInputError) {
      note(`${error.message}${error.field ? ` (${error.field})` : ""}`);
      return 2;
    }
    if (error instanceof IntegrationCallError) {
      note(
        `The call to ${error.integration} was permitted and then failed after ${error.attempts} attempt(s): ${error.message}`,
      );
      note(
        "This is a failure, not a refusal — the effect may or may not have landed. Run it under --degrade to queue, park, or refuse it explicitly.",
      );
      return 1;
    }
    throw error;
  }
}

async function dispatch(
  args: CommandArgs,
  context: IntegrationsCommandContext,
): Promise<number> {
  const sub = args.positional[1];
  switch (sub) {
    case "list":
      return await listIntegrations(args, context);
    case "contract":
      return await showContract(args, context);
    case "association":
      return await showAssociation(args, context);
    case "call":
      return await makeCall(args, context);
    default:
      note(`Unknown integrations subcommand: ${sub ?? "(none)"}\n`);
      note(INTEGRATIONS_USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// list — the registered systems of record and their status
// ---------------------------------------------------------------------------

async function listIntegrations(
  args: CommandArgs,
  context: IntegrationsCommandContext,
): Promise<number> {
  const { platform } = context;

  const rows = await Promise.all(
    platform.systemsOfRecord.map(async (integration) => {
      const descriptor = integration.describe();
      const health = await integration.health();
      const queued = await platform.integrationQueue.listQueued({
        integration: descriptor.name,
        status: ["queued", "claimed"],
      });
      const parked = await platform.integrationQueue.listParked({ integration: descriptor.name });
      return {
        name: descriptor.name,
        version: descriptor.version,
        systemOfRecord: descriptor.systemOfRecord,
        shapeConfirmedWithMvw: descriptor.shapeConfirmedWithMvw,
        available: health.available,
        detail: health.detail,
        queued: queued.length,
        parked: parked.length,
      };
    }),
  );

  const allowlist = [...platform.config.egressAllowlist];

  if (args.json) {
    emit({ egressAllowlist: allowlist, integrations: rows }, args);
    return 0;
  }

  console.log(
    `${"SYSTEM OF RECORD".padEnd(22)} ${"VER".padEnd(4)} ${"CONFIRMED".padEnd(10)} ${"REACHABLE".padEnd(10)} ${"QUEUED".padEnd(7)} PARKED`,
  );
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(22)} ${String(row.version).padEnd(4)} ${(row.shapeConfirmedWithMvw ? "yes" : "NO").padEnd(10)} ${(row.available ? "yes" : "NO").padEnd(10)} ${String(row.queued).padEnd(7)} ${row.parked}`,
    );
  }
  note(
    `${rows.length} system(s) of record. Every shape is an informed guess until a named person at MVW confirms it (CONFIRMED=NO).`,
  );
  note(
    allowlist.length > 0
      ? `egress allowlist: ${allowlist.join(", ")} — every outbound call is bounded to these hosts.`
      : "egress allowlist: (empty) — every outbound integration call is refused. Set PV_EGRESS_ALLOWLIST.",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// contract show — read from the ContractRecordsPort
// ---------------------------------------------------------------------------

async function showContract(
  args: CommandArgs,
  context: IntegrationsCommandContext,
): Promise<number> {
  if (args.positional[2] !== "show") {
    note(`Unknown integrations contract subcommand: ${args.positional[2] ?? "(none)"}. Try: contract show <contractId>`);
    return 2;
  }
  const id = args.positional[3];
  if (id === undefined || id.startsWith("--")) {
    throw new InvalidInputError(
      "Name the contract to show: pv integrations contract show <contractId>. Seeded ids include ctr_fl_recent_complete.",
      "contractId",
    );
  }

  const record = await context.platform.contractRecords.getContract(id as Id<"contract">);
  if (!record) {
    // A read that returns null is "no such contract", which is a real answer,
    // not an error — but it exits non-zero so a script that expected the record
    // notices rather than proceeding on an empty one.
    note(`No contract record for "${id}" in the contract system of record.`);
    return 1;
  }

  if (args.json) {
    emit(record, args);
    return 0;
  }

  console.log(`contract          ${record.contractId}`);
  console.log(`jurisdiction      ${record.jurisdiction}`);
  console.log(`status            ${record.status}`);
  console.log(`executed          ${record.executedAt}`);
  console.log(`disclosures       ${record.disclosuresDeliveredAt ?? "(unknown — not 'delivered at execution')"}`);
  console.log(`document set       ${record.documentSetComplete ? "complete" : `INCOMPLETE (${record.missingDocuments.join(", ") || "unspecified"})`}`);
  console.log(`financed          ${record.financed ? "yes" : "no"}`);
  if (record.rescissionRequestedAt) console.log(`rescission asked  ${record.rescissionRequestedAt}`);
  console.log(`provenance        ${record.provenance.system} @ ${record.provenance.retrievedAt}`);
  return 0;
}

// ---------------------------------------------------------------------------
// association show — read from the AssociationRecordsPort
// ---------------------------------------------------------------------------

async function showAssociation(
  args: CommandArgs,
  context: IntegrationsCommandContext,
): Promise<number> {
  if (args.positional[2] !== "show") {
    note(`Unknown integrations association subcommand: ${args.positional[2] ?? "(none)"}. Try: association show <associationId>`);
    return 2;
  }
  const id = args.positional[3];
  if (id === undefined || id.startsWith("--")) {
    throw new InvalidInputError(
      "Name the association to show: pv integrations association show <associationId>.",
      "associationId",
    );
  }

  const fiscalYearRaw = first(args, "fiscal-year");
  const fiscalYear =
    fiscalYearRaw === undefined
      ? new Date(context.platform.clock.nowIso()).getUTCFullYear()
      : Number(fiscalYearRaw);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 3000) {
    throw new InvalidInputError(`--fiscal-year must be a four-digit year, received "${fiscalYearRaw}"`, "fiscal-year");
  }

  const associations = await context.platform.associationRecords.listAssociations();
  const ref = associations.find((entry) => entry.associationId === id);
  if (!ref) {
    note(`No association "${id}" in the association system of record.`);
    return 1;
  }

  const budget = await context.platform.associationRecords.getBudgetSummary(id, fiscalYear);

  if (args.json) {
    emit({ association: ref, fiscalYear, budget }, args);
    return 0;
  }

  console.log(`association       ${ref.associationId}`);
  console.log(`name              ${ref.name}`);
  console.log(`jurisdiction      ${ref.jurisdiction}`);
  console.log(`fiscal year end   month ${ref.fiscalYearEndMonth}`);
  console.log(`budget for        FY${fiscalYear}`);
  if (!budget) {
    console.log(`budget            (no budget on file for FY${fiscalYear})`);
    return 0;
  }
  console.log(`total budget      ${money(budget.totalBudgetCents, budget.currency)}`);
  console.log(`reserve balance   ${money(budget.reserveBalanceCents, budget.currency)}`);
  console.log(
    `reserve study     ${budget.reserveStudyRecommendedCents > 0 ? `recommends ${money(budget.reserveStudyRecommendedCents, budget.currency)}` : "no study on file — no recommended balance"}${budget.reserveStudyDate ? ` (as of ${budget.reserveStudyDate})` : ""}`,
  );
  console.log(`assessment/int'l  ${money(budget.annualAssessmentPerIntervalCents, budget.currency)}`);
  if (budget.delinquencyBasisPoints !== undefined) {
    console.log(`delinquency       ${(budget.delinquencyBasisPoints / 100).toFixed(2)}%`);
  }
  console.log(`provenance        ${budget.provenance.system} @ ${budget.provenance.retrievedAt}`);
  return 0;
}

/** Integer minor units to a human amount. Money is never a float here. */
function money(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${currency} ${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// call — one governed egress call through the EgressClient
// ---------------------------------------------------------------------------

async function makeCall(
  args: CommandArgs,
  context: IntegrationsCommandContext,
): Promise<number> {
  const { platform } = context;

  const url = requireFlag(args, "url");
  const integration = requireFlag(args, "integration");
  const credential = requireFlag(args, "credential");
  const methodRaw = (first(args, "method") ?? "GET").toUpperCase();
  if (!HTTP_METHODS.includes(methodRaw as HttpMethod)) {
    throw new InvalidInputError(`--method must be one of ${HTTP_METHODS.join(", ")}, received "${methodRaw}"`, "method");
  }
  const method = methodRaw as HttpMethod;
  const body = first(args, "body");
  const idempotencyKey = first(args, "idempotency-key");
  const stepName = first(args, "step-name") ?? "operator_probe";
  const subject = keyValues(args, "subject");

  const maxAttemptsRaw = first(args, "max-attempts");
  let maxAttempts: number | undefined;
  if (maxAttemptsRaw !== undefined) {
    maxAttempts = Number(maxAttemptsRaw);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new InvalidInputError(`--max-attempts must be a positive integer, received "${maxAttemptsRaw}"`, "max-attempts");
    }
  }

  const degradeRaw = first(args, "degrade");
  let policy: DegradationPolicy | undefined;
  if (degradeRaw !== undefined) {
    if (!DEGRADATION_POLICIES.includes(degradeRaw as DegradationPolicy)) {
      throw new InvalidInputError(
        `--degrade must be one of ${DEGRADATION_POLICIES.join(", ")}, received "${degradeRaw}"`,
        "degrade",
      );
    }
    policy = degradeRaw as DegradationPolicy;
  }

  // The egress client refuses without a run: no run, no recorded step, no call.
  // A probe from an operator is a real unit of work, so it gets a real run — its
  // one integration step is recorded against it exactly as a workflow's would be.
  const runId = platform.ids.next("run");
  const correlationId = context.correlationId ?? runId;
  await platform.runs.createRun({
    id: runId,
    kind: "integration.probe",
    mode: "assisted",
    requestedBy: context.actor,
    subject: { integration, ...subject },
    correlationId,
  });

  const request: EgressRequest = {
    integration,
    runId,
    stepName,
    method,
    url,
    credentialReference: credential,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(Object.keys(subject).length > 0 ? { subject } : {}),
    correlationId,
  };

  note(
    `Governed egress ${method} ${url} on integration "${integration}" with credential "${credential}"${policy ? ` under --degrade ${policy}` : ""}. Run ${runId}.`,
  );

  // A DeniedError — the host is not allowlisted, the credential is missing,
  // revoked, or out of scope, the rate ceiling is reached, or the integration is
  // contained — propagates to main.ts and exits 1 with its reason. It is NOT
  // caught here, and under --degrade it is NOT degraded either: a governance
  // decision must not become a retry loop.
  if (!policy) {
    const outcome = await platform.egress.send(request);
    return reportEgressOutcome(outcome, args);
  }

  const result = await platform.degradation.run(
    policy,
    {
      integration,
      operation: `egress.${method}`,
      idempotencyKey: idempotencyKey ?? `probe:${runId}:${stepName}`,
      subject: { url, ...subject },
      runId,
      summary: `Operator egress probe ${method} ${url}`,
      ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    },
    () => platform.egress.send(request),
  );

  if (result.kind === "succeeded") {
    return reportEgressOutcome(result.value, args);
  }
  if (result.kind === "queued") {
    note(
      `Queued after a failure. It will be retried; attempt ${result.item.attempts}, next attempt at ${result.item.nextAttemptAt}.`,
    );
    emit(
      args.json
        ? {
            kind: "queued",
            idempotencyKey: result.item.idempotencyKey,
            attempts: result.item.attempts,
            nextAttemptAt: result.item.nextAttemptAt,
            lastError: result.item.lastError,
          }
        : `queued ${result.item.idempotencyKey}`,
      args,
    );
    return 0;
  }
  // parked
  note(`Parked for a human after a failure: ${result.item.reason}`);
  emit(
    args.json
      ? { kind: "parked", reference: result.item.reference, summary: result.item.summary, reason: result.item.reason }
      : `parked ${result.item.reference}`,
    args,
  );
  return 0;
}

function reportEgressOutcome(outcome: EgressOutcome, args: CommandArgs): number {
  if (outcome.kind === "already_performed") {
    note(
      `The effect under idempotency key ${outcome.idempotencyKey} already landed (step ${outcome.stepId}); this call did not repeat it.`,
    );
    emit(
      args.json ? { kind: "already_performed", stepId: outcome.stepId, idempotencyKey: outcome.idempotencyKey } : outcome.stepId,
      args,
    );
    return 0;
  }

  const showBody = args.flags["show-body"] !== undefined;
  note(
    `Sent. HTTP ${outcome.status} in ${outcome.attempts} attempt(s), ${outcome.body.length} bytes, ${outcome.durationMs}ms. Step ${outcome.stepId}.`,
  );
  note(
    "The response body is untrusted: it has crossed a trust boundary and must be screened before it reaches a model or any other instruction surface.",
  );
  emit(
    args.json
      ? {
          kind: "sent",
          status: outcome.status,
          attempts: outcome.attempts,
          durationMs: outcome.durationMs,
          bytes: outcome.body.length,
          stepId: outcome.stepId,
          responseDigest: outcome.responseDigest,
          ...(showBody ? { body: outcome.body } : {}),
        }
      : showBody
        ? outcome.body
        : `HTTP ${outcome.status}`,
    args,
  );
  return 0;
}
