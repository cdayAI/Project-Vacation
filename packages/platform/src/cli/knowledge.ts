import { readFileSync } from "node:fs";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef } from "../record/types.js";
import type { IsoDate } from "../timeline/types.js";
import { RECORD_CORPUS_REVIEW_ACTION } from "../knowledge/actions.js";
import {
  CLASSIFICATIONS,
  type Citation,
  type Classification,
  type Corpus,
  type CorpusFreshness,
  type GroundedAnswer,
} from "../knowledge/types.js";
import type { Platform } from "../platform.js";

/**
 * `pv knowledge` — the governed knowledge layer from a terminal.
 *
 * The layer is where "no grounding, no answer" is enforced, and until this file
 * existed it enforced that promise for nobody: `IngestionService`, `Retriever`,
 * `GroundedAnswerService`, and `FreshnessMonitor` were composed only inside the
 * seeded demonstration, which builds its own instances. There was no way to
 * ingest a document, put a regulated question to the corpus, or attest a review
 * in the product at all. This is the operator surface that closes that — a
 * control nothing can reach answers nothing.
 *
 * The house rules apply, each closing a way a command line lies to its operator:
 *
 * **Diagnostics to stderr, the answer to stdout**, so `pv knowledge ask ...
 * --json | jq` composes and `pv knowledge ask ... > evidence.txt` writes an
 * artifact a reviewer reads without a banner in it. The one thing each verb
 * prints on stdout is its answer: a corpus id, a document id, the cited
 * passages, a freshness listing.
 *
 * **The real services, never a second copy of their rules.** Every verb goes
 * through the composition root's one `IngestionService`, `GroundedAnswerService`,
 * or `FreshnessMonitor`, over the one store they share. No rule is re-implemented
 * here: ingestion still screens at the boundary and refuses a poisoned document,
 * retrieval is still point-in-time and entitlement-scoped, and an answer is still
 * grounded or refused. This command cannot weaken any of it because it does not
 * own it.
 *
 * **The answer is grounded or it does not exist.** `knowledge ask` prints cited
 * passages on success. When nothing clears the relevance floor the service
 * raises `knowledge.no_grounding`, and when the authority that would be cited is
 * overdue for review it raises `knowledge.stale_authority`; both propagate to
 * main.ts and exit 1 with their reason. There is no path here that prints a
 * confident, ungrounded paragraph, because the service this calls cannot produce
 * one.
 *
 * **Exit codes mean something.** Zero means the thing happened (or the freshness
 * listing was produced); a refusal exits non-zero with its reason, propagated to
 * the top-level handler in main.ts.
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

export const KNOWLEDGE_USAGE = `
pv knowledge — ingest authority, answer regulated questions, and keep corpora fresh

  knowledge corpus create --name <lower_snake_case> --owner <team>
                         --classification <${CLASSIFICATIONS.join("|")}>
                         --review-cadence-days <n> [--scope <name>]...
                         [--last-reviewed-at <iso>]
              Define a corpus. A setup helper: which bodies of authority exist,
              who owns them, and how often they are reviewed are declarative
              deploy-time facts, so this is deliberately NOT a governed action.
              Each --scope is a data scope a reader must hold; none means every
              authenticated reader. Prints the corpus id.

  knowledge ingest       --corpus <name|id> --title <text> --version <label>
                         --effective-from <yyyy-mm-dd> [--effective-to <yyyy-mm-dd>]
                         --jurisdiction <FL|NV|GLOBAL|...> --source-uri <uri>
                         (--file <path> | --text <text>)
              Screen and chunk a document into a corpus, governed by
              knowledge.ingest_document. The text is untrusted and is screened at
              the boundary before it enters; a poisoned document is refused and
              never stored. Prints the document id and its chunk count.

  knowledge ask          --question <text> --as-of <yyyy-mm-dd>
                         [--corpus <name|id>]... [--jurisdiction <j>]...
                         [--unregulated] [--max-citations <n>]
              Answer a regulated question from cited authority, or refuse. On
              success prints each cited passage with its provenance. Refused
              (exit 1) with knowledge.no_grounding when nothing clears the
              relevance floor, or knowledge.stale_authority when the authority a
              regulated answer would cite is overdue for review. The answer is
              grounded or it does not exist.

  knowledge freshness    [--stale]
              Every corpus with its review status, worst overdue first. --stale
              shows only the ones needing attention.

  knowledge review       --corpus <name|id> [--reviewed-at <iso>] --reauthenticated
              Attest that a corpus has been reviewed and its authority is
              current, resetting its cadence, through
              knowledge.record_corpus_review. It is the only way to silence a
              staleness refusal, so it is a deliberate speed bump. Prints the
              corpus id.

Global:
  --json      Machine-readable output
  --operator  Name the operator this command is attributed to
  --role      Name the role the operator is acting in (repeatable). Ingesting is
              a compliance reviewer's or an admin's; a review attestation is a
              compliance reviewer's or an admin's. A scoped corpus stays closed
              until --role scope:<name> is asserted — data scope is a separate
              axis from role. Defaults to platform_admin, which holds no scope.

A review is a sensitive attestation and requires a fresh re-authentication. The
command line cannot verify one, so it is asserted with --reauthenticated, which
the audit record shows came from the CLI.

Exit codes:
  0   the thing happened, or the freshness listing was produced
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
  // so `--owner` with nothing after it is a usage error rather than the literal
  // word "true" being recorded as the accountable owner of a corpus.
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

function requireClassification(args: CommandArgs): Classification {
  const value = requireFlag(args, "classification");
  if (!CLASSIFICATIONS.includes(value as Classification)) {
    throw new InvalidInputError(
      `--classification must be one of ${CLASSIFICATIONS.join(", ")}; received "${value}".`,
      "classification",
    );
  }
  return value as Classification;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface KnowledgeCommandContext {
  readonly platform: Platform;
  /** The operator, as main.ts attributes them. Unverified, and marked `cli:`. */
  readonly actor: ActorRef;
  readonly correlationId?: string | undefined;
}

export async function commandKnowledge(
  args: CommandArgs,
  context: KnowledgeCommandContext,
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

async function dispatch(args: CommandArgs, context: KnowledgeCommandContext): Promise<number> {
  const sub = args.positional[1];
  switch (sub) {
    case "corpus":
      return await corpusVerb(args, context);
    case "ingest":
      return await ingestDocument(args, context);
    case "ask":
      return await askQuestion(args, context);
    case "freshness":
      return await listFreshness(args, context);
    case "review":
      return await recordReview(args, context);
    default:
      note(`Unknown knowledge subcommand: ${sub ?? "(none)"}\n`);
      note(KNOWLEDGE_USAGE);
      return 2;
  }
}

/**
 * Resolve a corpus from a name or an id.
 *
 * Operators think in names, the store thinks in ids. The name is tried first and
 * exactly — never case-insensitively — because the name is the handle a workflow
 * refers to, and matching loosely would act on the wrong body of authority.
 */
async function resolveCorpus(platform: Platform, reference: string | undefined): Promise<Corpus> {
  if (reference === undefined || reference.length === 0) {
    throw new InvalidInputError("A corpus is required: its name, or its identifier.", "corpus");
  }
  const byName = await platform.knowledgeStore.findCorpusByName(reference);
  if (byName) return byName;
  const byId = await platform.knowledgeStore.getCorpus(reference as Id<"corpus">);
  if (byId) return byId;
  throw new DeniedError(
    "record.unavailable",
    `No corpus "${reference}" in the knowledge store.`,
    { corpus: reference },
  );
}

// ---------------------------------------------------------------------------
// corpus create — a setup helper, deliberately not a governed action
// ---------------------------------------------------------------------------

async function corpusVerb(args: CommandArgs, context: KnowledgeCommandContext): Promise<number> {
  const verb = args.positional[2];
  if (verb !== "create") {
    note(`Unknown corpus subcommand: ${verb ?? "(none)"}. Try: create.`);
    return 2;
  }
  return await createCorpus(args, context);
}

async function createCorpus(args: CommandArgs, context: KnowledgeCommandContext): Promise<number> {
  const { platform } = context;

  const corpus = await platform.ingestion.createCorpus({
    name: requireFlag(args, "name"),
    owner: requireFlag(args, "owner"),
    classification: requireClassification(args),
    reviewCadenceDays: requireInt(args, "review-cadence-days"),
    accessScope: many(args, "scope"),
    // The clock is the reference point, so a corpus created without an explicit
    // last-review date is not immediately stale; a deployment restoring history
    // can name an earlier one.
    lastReviewedAt: first(args, "last-reviewed-at") ?? platform.clock.nowIso(),
  });

  note(
    `Defined corpus "${corpus.name}" (${corpus.id}) owned by ${corpus.owner}, ${corpus.classification}, reviewed every ${corpus.reviewCadenceDays} day(s), readable by ${
      corpus.accessScope.length === 0 ? "every authenticated reader" : `holders of ${corpus.accessScope.map((scope) => `scope:${scope}`).join(", ")}`
    }. Defining a corpus is a deploy-time fact, not a governed action; ingesting into it is what is governed.`,
  );

  if (args.json) {
    emit(
      {
        corpusId: corpus.id,
        name: corpus.name,
        owner: corpus.owner,
        classification: corpus.classification,
        reviewCadenceDays: corpus.reviewCadenceDays,
        accessScope: corpus.accessScope,
        lastReviewedAt: corpus.lastReviewedAt,
      },
      args,
    );
    return 0;
  }
  // The answer, alone on stdout: the corpus id the next verb takes.
  console.log(corpus.id);
  return 0;
}

// ---------------------------------------------------------------------------
// ingest — the governed boundary
// ---------------------------------------------------------------------------

/**
 * The document body, from a file or the command line.
 *
 * `--file` fingerprints and screens the artifact on disk; `--text` is the same
 * for a short body typed inline. One is required: an ingestion with no text is
 * nothing to screen and nothing to cite.
 */
function documentText(args: CommandArgs): string {
  const inline = first(args, "text");
  if (inline !== undefined) return inline;
  const file = first(args, "file");
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      throw new InvalidInputError(
        `Could not read the document at ${file}: ${error instanceof Error ? error.message : String(error)}`,
        "file",
      );
    }
  }
  throw new InvalidInputError(
    "A document needs a body: --file <path> to read and screen a file, or --text <text> for a short body inline.",
    "text",
  );
}

async function ingestDocument(args: CommandArgs, context: KnowledgeCommandContext): Promise<number> {
  const { platform } = context;
  const corpus = await resolveCorpus(platform, first(args, "corpus"));

  // The chokepoint. A refusal — an unauthorised actor, or a poisoned document
  // stopped at the boundary screen — raises a DeniedError, which is deliberately
  // not caught here: it propagates to main.ts, which prints its reason and exits
  // 1. Nothing entered the corpus on that path.
  const result = await platform.ingestion.ingest({
    corpusId: corpus.id,
    title: requireFlag(args, "title"),
    version: requireFlag(args, "version"),
    effectiveFrom: requireFlag(args, "effective-from") as IsoDate,
    // Absent means still in force. The service reads null as an open window, so
    // this maps a missing flag to it rather than to "no window recorded".
    effectiveTo: (first(args, "effective-to") ?? null) as IsoDate | null,
    jurisdiction: requireFlag(args, "jurisdiction"),
    sourceUri: requireFlag(args, "source-uri"),
    text: documentText(args),
    actor: context.actor,
    // `knowledge.ingest_document` is sensitive, which shadow mode does not
    // permit; supervised is the mode a deliberate ingestion is made in.
    mode: "supervised",
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  });

  note(
    result.replayed
      ? `Recognised an identical ingestion of "${result.document.title}" already in ${corpus.name} — not stored again. The document id is ${result.document.id}.`
      : `Ingested "${result.document.title}" v${result.document.version} into ${corpus.name} as ${result.document.id}: screened ${result.screenVerdict}, ${result.document.chunkCount} chunk(s), in force ${result.document.effectiveFrom} → ${result.document.effectiveTo ?? "current"}. Its audit receipt is ${result.document.receiptId ?? "(pending)"}.`,
  );
  if (result.screenSignals.length > 0) {
    note(`  screen signals: ${result.screenSignals.join(", ")}`);
  }

  if (args.json) {
    emit(
      {
        documentId: result.document.id,
        corpusId: corpus.id,
        version: result.document.version,
        chunkCount: result.document.chunkCount,
        screenVerdict: result.screenVerdict,
        screenSignals: result.screenSignals,
        replayed: result.replayed,
        receiptId: result.document.receiptId ?? null,
      },
      args,
    );
    return 0;
  }
  // The answer, alone on stdout: the document id and its chunk count.
  console.log(`${result.document.id} ${result.document.chunkCount}`);
  return 0;
}

// ---------------------------------------------------------------------------
// ask — grounded, or refused
// ---------------------------------------------------------------------------

async function askQuestion(args: CommandArgs, context: KnowledgeCommandContext): Promise<number> {
  const { platform } = context;

  // Names resolve to ids before the query, because the retriever compares the
  // requested corpora by id: a name passed through unresolved would be refused
  // as a corpus this actor may not read, which is a true statement about the
  // wrong thing.
  const requested = many(args, "corpus");
  const corpusIds: Id<"corpus">[] = [];
  for (const reference of requested) {
    corpusIds.push((await resolveCorpus(platform, reference)).id);
  }

  const jurisdictions = many(args, "jurisdiction");

  // The refusal path raises a DeniedError — `knowledge.no_grounding`,
  // `knowledge.stale_authority`, or an entitlement `authorization.*` — which is
  // deliberately not caught: it propagates to main.ts and exits 1 with its
  // reason. No answer was produced on that path, and the refusal is recorded.
  const answer = await platform.groundedAnswers.groundedAnswer({
    question: requireFlag(args, "question"),
    asOf: requireFlag(args, "as-of") as IsoDate,
    actor: context.actor,
    // A question is regulated unless the operator says otherwise; --unregulated
    // is the only way to let a stale-but-relevant passage answer instead of
    // refusing, and it is a deliberate, visible choice.
    regulated: !flagPresent(args, "unregulated"),
    ...(corpusIds.length > 0 ? { corpusIds } : {}),
    ...(jurisdictions.length > 0 ? { jurisdictions } : {}),
    ...(flagPresent(args, "max-citations") ? { maxCitations: requireInt(args, "max-citations") } : {}),
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  });

  if (args.json) {
    emit(answer, args);
    return 0;
  }

  printAnswer(answer);
  return 0;
}

/**
 * Print a grounded answer: its provenance on stderr, its citations on stdout.
 *
 * The reasoning — what was asked, as of when, how many passages were considered
 * — is the reviewer's material, so it goes to stderr. The citations are the
 * answer, so they go to stdout: this module composes no prose, and the cited
 * passages with their provenance are exactly what a compliance reviewer acts on.
 */
function printAnswer(answer: GroundedAnswer): void {
  note(`question          ${answer.question}`);
  note(`as of             ${answer.asOf}`);
  note(`passages searched ${answer.candidatesConsidered}`);
  note(`confidence        ${answer.confidence.toFixed(3)} (floor ${answer.relevanceFloor})`);
  if (answer.staleAuthority) {
    note(
      "WARNING: a cited corpus is past its review cadence. This answer was allowed through because the question was marked --unregulated; a regulated question would have been refused.",
    );
  }
  note("");

  answer.citations.forEach((citation, index) => {
    console.log(citationHeading(citation, index));
    for (const line of citation.excerpt.split("\n")) console.log(`     ${line}`);
    console.log("");
  });
  note(
    `${answer.citations.length} citation(s). Every claim above is a cited passage; this module retrieves and cites, it does not compose prose.`,
  );
}

function citationHeading(citation: Citation, index: number): string {
  const window = `${citation.effectiveFrom} → ${citation.effectiveTo ?? "current"}`;
  return `[${index + 1}] ${citation.documentTitle}  (v${citation.version}, ${citation.jurisdiction}, in force ${window}, score ${citation.score.toFixed(3)})\n     source ${citation.sourceUri}  chunk ${citation.chunkId}`;
}

// ---------------------------------------------------------------------------
// freshness — review status, worst overdue first
// ---------------------------------------------------------------------------

async function listFreshness(args: CommandArgs, context: KnowledgeCommandContext): Promise<number> {
  const { platform } = context;
  const onlyStale = flagPresent(args, "stale");
  const entries = onlyStale
    ? await platform.freshness.listStale()
    : await platform.freshness.list();

  if (args.json) {
    emit(entries, args);
    return 0;
  }

  if (entries.length === 0) {
    note(
      onlyStale
        ? "No corpus is past its review cadence. Nothing needs attention."
        : "No corpus is defined. `pv knowledge corpus create` defines one.",
    );
    return 0;
  }

  console.log(
    `${"STATUS".padEnd(6)} ${"CORPUS".padEnd(30)} ${"OWNER".padEnd(22)} ${"DUE".padEnd(24)} ${"OVERDUE".padEnd(9)} LAST REVIEWED`,
  );
  for (const entry of entries) {
    console.log(
      `${(entry.stale ? "STALE" : "ok").padEnd(6)} ${entry.name.padEnd(30)} ${entry.owner.padEnd(22)} ${entry.dueAt.padEnd(24)} ${(entry.stale ? `${entry.daysOverdue}d` : "-").padEnd(9)} ${entry.lastReviewedAt}`,
    );
  }
  const stale = entries.filter((entry: CorpusFreshness) => entry.stale).length;
  note(
    `${entries.length} corpus/corpora, ${stale} stale. A stale corpus refuses regulated questions rather than citing unreviewed authority; \`pv knowledge review\` resets its cadence.`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// review — the governed attestation
// ---------------------------------------------------------------------------

/**
 * Refuse to invent a step-up the platform cannot observe.
 *
 * The command line cannot verify who is typing — main.ts says so where it builds
 * the actor. `--reauthenticated` is the reviewer asserting they have just
 * re-authenticated to this host, and it is required rather than assumed:
 * recording a review is the obvious thing to reach for when the platform is
 * refusing to answer from a stale corpus and someone is in a hurry, so a
 * quietly-satisfied step-up would make the requirement decorative on exactly the
 * path it guards. The audit record shows the attestation came from the CLI, so
 * the assertion is visible to whoever reviews it.
 */
function reviewerStepUpSeconds(args: CommandArgs): number {
  if (!flagPresent(args, "reauthenticated")) {
    throw new DeniedError(
      "authorization.step_up_required",
      "Recording a corpus review requires a fresh re-authentication. The command line cannot verify one, so it is asserted: re-authenticate to this host and pass --reauthenticated.",
      { action: RECORD_CORPUS_REVIEW_ACTION },
    );
  }
  return 0;
}

async function recordReview(args: CommandArgs, context: KnowledgeCommandContext): Promise<number> {
  const { platform } = context;
  const corpus = await resolveCorpus(platform, first(args, "corpus"));
  const stepUp = reviewerStepUpSeconds(args);

  // The chokepoint. `knowledge.record_corpus_review` requires the reviewer's
  // role, the corpus's data scope, and the step-up asserted above; a refusal
  // raises a DeniedError that propagates to main.ts and exits 1.
  const reviewed = await platform.freshness.recordReview({
    corpusId: corpus.id,
    actor: context.actor,
    // Sensitive, which shadow mode does not permit; supervised is the mode a
    // deliberate attestation is made in.
    mode: "supervised",
    secondsSinceAuthentication: stepUp,
    ...(first(args, "reviewed-at") !== undefined ? { reviewedAt: requireFlag(args, "reviewed-at") } : {}),
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
  });

  const freshness = await platform.freshness.freshnessOf(reviewed.id);
  note(
    `Recorded a review of "${reviewed.name}" (${reviewed.id}), effective ${reviewed.lastReviewedAt}. Next review falls due ${freshness.dueAt}; it is ${freshness.stale ? "STILL stale" : "current"} and will ${freshness.stale ? "still refuse" : "no longer refuse"} regulated questions on that ground.`,
  );

  if (args.json) {
    emit(
      {
        corpusId: reviewed.id,
        name: reviewed.name,
        lastReviewedAt: reviewed.lastReviewedAt,
        dueAt: freshness.dueAt,
        stale: freshness.stale,
      },
      args,
    );
    return 0;
  }
  // The answer, alone on stdout: the corpus id.
  console.log(reviewed.id);
  return 0;
}
