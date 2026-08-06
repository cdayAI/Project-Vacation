import type { Platform } from "../platform.js";
import type { CostEntry, Run, Step, StepKind } from "../record/types.js";

/**
 * The run detail timeline — one row per step.
 *
 * The screen's spine, and the place where this product either earns its claim
 * or does not. A supervisor reading a run has to be able to tell a **citation**
 * from a **claim**: what the platform *retrieved* from a governed source, what
 * it *asserted* on its own, and what it *computed* from rules and inputs. Those
 * three are different kinds of trust, and a timeline that renders them
 * identically is a timeline that teaches people to trust all three equally.
 *
 * So the distinction is modelled explicitly here — and so is the honesty about
 * where it comes from. Two levels:
 *
 *   **Recorded.** A step that wrote its own provenance under the reserved
 *   detail keys below. Authoritative: the step said what it did.
 *
 *   **Derived.** Everything else, read from the step's kind and the detail it
 *   happened to record. Useful, and clearly labelled as inference so nobody
 *   mistakes a guess about a step for the step's own testimony.
 *
 * The reserved keys exist so a step *can* record provenance without a schema
 * change. No writer in this deployment sets them yet, which is why `recorded`
 * is false on every step the platform produces today and why the console says
 * "derived from the step record" rather than presenting inference as evidence.
 */

/** The five types the timeline draws an icon for. */
export type StepType = "retrieval" | "model" | "action" | "human" | "wait";

/**
 * Reserved keys a step may set on its `detail` to record its own provenance.
 *
 * Flat scalars, because `Step.detail` is a flat scalar map — chosen when the
 * operating record was designed so that a step's detail could never become a
 * second copy of a payload. Lists are comma-separated.
 */
export const PROVENANCE_KEYS = {
  /** Comma-separated chunk ids the step cited. */
  cited: "provenance.cited",
  /** Comma-separated statements the step made without a citation. */
  asserted: "provenance.asserted",
  /** Comma-separated `label=value` pairs the step derived itself. */
  computed: "provenance.computed",
  /** How a computed value was reached, e.g. a statutory rule and its clock. */
  derivation: "provenance.derivation",
} as const;

const STEP_TYPE_BY_KIND: Readonly<Record<StepKind, StepType>> = {
  retrieval: "retrieval",
  model_call: "model",
  automated_action: "action",
  integration_call: "action",
  document_generation: "action",
  outbound_message: "action",
  compensation: "action",
  branch: "action",
  parallel: "action",
  human_task: "human",
  approval_gate: "wait",
  wait_for_event: "wait",
  timer: "wait",
};

export function stepTypeOf(kind: string): StepType {
  return STEP_TYPE_BY_KIND[kind as StepKind] ?? "action";
}

export interface CitationRow {
  readonly chunkId: string;
  readonly documentTitle: string;
  readonly documentVersion: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | undefined;
  readonly jurisdiction?: string | undefined;
  readonly excerpt: string;
  readonly sourceUri?: string | undefined;
  readonly stale: boolean;
}

export interface AssertedStatement {
  readonly text: string;
  /** Digest of the output the assertion belongs to, so it can be traced. */
  readonly outputDigest?: string | undefined;
}

export interface ComputedValue {
  readonly label: string;
  readonly value: string;
  /** How it was reached. Empty when the step did not record one. */
  readonly derivation: string;
}

export interface StepProvenance {
  readonly retrieved: readonly CitationRow[];
  readonly asserted: readonly AssertedStatement[];
  readonly computed: readonly ComputedValue[];
  /**
   * True when the step recorded this itself, false when it was derived from
   * the step's kind and detail. The console renders the two differently, and
   * it must: one is testimony and the other is inference.
   */
  readonly recorded: boolean;
  readonly basis: string;
}

export interface HumanStepDetail {
  readonly actor?: { readonly actorId: string; readonly displayName: string } | undefined;
  readonly actorUnknown?: string | undefined;
  /** How long the person took. Absent while the task is still open. */
  readonly tookMs?: number | undefined;
}

export interface StepFailureDetail {
  readonly what: string;
  readonly attempt: number;
  /** The retry or escalation that followed, in words. */
  readonly followedBy: string;
  readonly followedByStepId?: string | undefined;
}

export interface StepRow {
  readonly stepId: string;
  readonly seq: number;
  readonly name: string;
  /** The raw machine kind. Kept because an engineer reading a bug needs it. */
  readonly kind: string;
  /** The five-way type the timeline draws. */
  readonly type: StepType;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly costUsd: number;
  readonly attempt: number;
  readonly inputDigest?: string | undefined;
  readonly outputDigest?: string | undefined;
  readonly error?: string | undefined;
  readonly denialReason?: string | undefined;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
  readonly provenance?: StepProvenance | undefined;
  readonly human?: HumanStepDetail | undefined;
  readonly failure?: StepFailureDetail | undefined;
  readonly citations: readonly CitationRow[];
  /**
   * Whether "correct this" is offered.
   *
   * Only on steps where a correction means something: a model call or a
   * retrieval that produced an output a person can disagree with. Offering it
   * on a timer would collect signal nobody can act on, and the improvement
   * loop ranks by frequency — so noise there steers which real failure gets
   * a person's attention.
   */
  readonly correctable: boolean;
}

/**
 * Build the timeline for one run.
 *
 * Cost is attributed per step from the cost ledger rather than divided or
 * estimated. A step with no entry costs zero because nothing was recorded
 * against it, which is a different statement from "we did not measure it" —
 * and the run total is the sum of the ledger either way, so the column and the
 * header cannot disagree.
 */
export async function runTimeline(
  platform: Platform,
  run: Run,
): Promise<{
  readonly steps: readonly StepRow[];
  readonly totalCostUsd: number;
  readonly costByCategory: Readonly<Record<string, number>>;
  readonly elapsedMs?: number | undefined;
  readonly citations: readonly CitationRow[];
}> {
  const [steps, cost, entries] = await Promise.all([
    platform.runs.listSteps(run.id),
    platform.runs.costForRun(run.id),
    platform.runs.listCostEntries(run.id),
  ]);

  const costByStep = new Map<string, number>();
  for (const entry of entries as readonly CostEntry[]) {
    if (!entry.stepId) continue;
    costByStep.set(entry.stepId, (costByStep.get(entry.stepId) ?? 0) + entry.amountUsd);
  }

  const rows = steps.map((step, index) =>
    stepRow(step, costByStep.get(step.id) ?? 0, steps[index + 1]),
  );

  const citations = rows.flatMap((row) => row.citations);
  const startedAt = run.startedAt ?? run.createdAt;
  const elapsedMs = run.endedAt ? Date.parse(run.endedAt) - Date.parse(startedAt) : undefined;

  return {
    steps: rows,
    totalCostUsd: cost.totalUsd,
    costByCategory: cost.byCategory,
    elapsedMs: elapsedMs !== undefined && Number.isFinite(elapsedMs) ? elapsedMs : undefined,
    citations: dedupeCitations(citations),
  };
}

export function stepRow(step: Step, costUsd: number, next: Step | undefined): StepRow {
  const type = stepTypeOf(step.kind);
  const durationMs =
    step.endedAt === undefined ? undefined : Date.parse(step.endedAt) - Date.parse(step.startedAt);
  const provenance = provenanceFor(step, type);

  return {
    stepId: step.id,
    seq: step.seq,
    name: step.name,
    kind: step.kind,
    type,
    status: step.status,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
    durationMs: durationMs !== undefined && Number.isFinite(durationMs) ? durationMs : undefined,
    costUsd,
    attempt: step.attempt,
    inputDigest: step.inputDigest,
    outputDigest: step.outputDigest,
    error: step.error,
    denialReason: step.denialReason,
    detail: step.detail,
    provenance,
    human: type === "human" ? humanDetail(step, durationMs) : undefined,
    failure: failureDetail(step, next),
    citations: provenance?.retrieved ?? [],
    // A denied or failed step produced nothing to disagree with; a correction
    // there would be a complaint about a refusal, which belongs on the refusal.
    correctable:
      (type === "model" || type === "retrieval") &&
      step.status === "succeeded" &&
      step.denialReason === undefined,
  };
}

// ---------------------------------------------------------------------------
// Retrieved · asserted · computed
// ---------------------------------------------------------------------------

function provenanceFor(step: Step, type: StepType): StepProvenance | undefined {
  const recorded = recordedProvenance(step);
  if (recorded) return recorded;
  if (type === "model" || type === "retrieval") return derivedProvenance(step, type);
  if (type === "action") {
    const computed = derivedComputed(step);
    if (computed.length === 0) return undefined;
    return {
      retrieved: [],
      asserted: [],
      computed,
      recorded: false,
      basis:
        "Derived from the values this step recorded in its detail. The step did not declare its own provenance.",
    };
  }
  return undefined;
}

/** Provenance a step declared for itself, under the reserved detail keys. */
function recordedProvenance(step: Step): StepProvenance | undefined {
  const cited = list(step.detail[PROVENANCE_KEYS.cited]);
  const asserted = list(step.detail[PROVENANCE_KEYS.asserted]);
  const computed = list(step.detail[PROVENANCE_KEYS.computed]);
  if (cited.length === 0 && asserted.length === 0 && computed.length === 0) return undefined;

  const derivation = text(step.detail[PROVENANCE_KEYS.derivation]) ?? "";

  return {
    // A recorded chunk id is a pointer, not a passage. The passage itself
    // lives in the corpus and is resolved by the deployment that wires one;
    // showing the id with an empty excerpt is honest, showing invented text
    // would not be.
    retrieved: cited.map((chunkId) => ({
      chunkId,
      documentTitle: "",
      documentVersion: "",
      effectiveFrom: "",
      excerpt: "",
      stale: false,
    })),
    asserted: asserted.map((statement) => ({ text: statement, outputDigest: step.outputDigest })),
    computed: computed.map((pair) => {
      const separator = pair.indexOf("=");
      return separator > 0
        ? { label: pair.slice(0, separator), value: pair.slice(separator + 1), derivation }
        : { label: pair, value: "", derivation };
    }),
    recorded: true,
    basis: "Recorded by the step itself.",
  };
}

/**
 * What can be told from the step's kind and the detail it happened to keep.
 *
 * Deliberately conservative. A model step with no recorded citations produces
 * one asserted statement — "this step's output is unsourced" — rather than an
 * empty provenance block, because an empty block on a model step reads as
 * "nothing was claimed", and the whole point of the distinction is that an
 * unsourced claim is the thing a supervisor most needs to see.
 */
function derivedProvenance(step: Step, type: StepType): StepProvenance {
  const passages = number(step.detail.passages ?? step.detail.groundedPassages);
  const corpus = text(step.detail.corpus ?? step.detail.corpusId);

  const retrieved: CitationRow[] = [];
  const asserted: AssertedStatement[] = [];

  if (type === "retrieval") {
    // A retrieval step's own detail says how many passages it found and from
    // where. That is a real count from the record; the passages themselves are
    // not on the record and are not invented here.
    if (passages !== undefined && passages > 0) {
      retrieved.push({
        chunkId: "",
        documentTitle: corpus ? `${passages} passage(s) from ${corpus}` : `${passages} passage(s)`,
        documentVersion: "",
        effectiveFrom: "",
        excerpt: "",
        stale: false,
      });
    }
  } else if (step.status === "succeeded") {
    asserted.push({
      text:
        passages !== undefined && passages > 0
          ? `This model step recorded ${passages} grounded passage(s) but no citation ids, so its statements cannot be checked against a source from here.`
          : "This model step recorded no citations. Everything it produced is an assertion until a person checks it.",
      outputDigest: step.outputDigest,
    });
  }

  return {
    retrieved,
    asserted,
    computed: derivedComputed(step),
    recorded: false,
    basis:
      "Derived from the step's kind and the detail it recorded. The step did not declare its own provenance, so this is inference about the step rather than the step's own account of itself.",
  };
}

/** Values a step's detail shows it worked out, e.g. a statutory deadline. */
function derivedComputed(step: Step): readonly ComputedValue[] {
  const derivation = text(step.detail.citation ?? step.detail.rule) ?? "";
  const computed: ComputedValue[] = [];
  for (const [key, value] of Object.entries(step.detail)) {
    if (!COMPUTED_DETAIL_KEYS.includes(key)) continue;
    computed.push({ label: key, value: String(value), derivation });
  }
  return computed;
}

/**
 * Detail keys that name a derived value rather than an input.
 *
 * A closed list on purpose. Treating every numeric field as "computed" would
 * put a token count and a statutory deadline in the same column, which is
 * exactly the flattening this whole distinction exists to undo.
 */
const COMPUTED_DETAIL_KEYS: readonly string[] = [
  "deadline",
  "deadlineInstant",
  "rescissionDeadline",
  "expiresAt",
  "daysRemaining",
  "businessDays",
  "amountUsd",
  "balanceUsd",
];

// ---------------------------------------------------------------------------
// Human steps and failures
// ---------------------------------------------------------------------------

function humanDetail(step: Step, durationMs: number | undefined): HumanStepDetail {
  const actorId = text(step.detail.actorId ?? step.detail.assignee ?? step.detail.completedBy);
  return {
    actor: actorId ? { actorId, displayName: actorId } : undefined,
    actorUnknown: actorId
      ? undefined
      : "This step did not record who did it. A human task whose owner is unknown cannot be chased.",
    tookMs: durationMs,
  };
}

/**
 * What happened, and what followed.
 *
 * "What followed" is read from the next step rather than described in the
 * abstract: a retry is the next step with the same name and a higher attempt
 * number, and an escalation is the next step being a human task. Saying "it
 * was retried" when the record shows nothing followed would be the most
 * reassuring possible lie about a failure.
 */
function failureDetail(step: Step, next: Step | undefined): StepFailureDetail | undefined {
  if (step.status !== "failed" && step.status !== "denied") return undefined;

  const what = step.denialReason ?? step.error ?? `The step ended as ${step.status}.`;

  if (next && next.name === step.name && next.attempt > step.attempt) {
    return {
      what,
      attempt: step.attempt,
      followedBy: `Retried as attempt ${next.attempt}.`,
      followedByStepId: next.id,
    };
  }
  if (next && next.kind === "human_task") {
    return {
      what,
      attempt: step.attempt,
      followedBy: `Escalated to a person: "${next.name}".`,
      followedByStepId: next.id,
    };
  }
  if (next) {
    return {
      what,
      attempt: step.attempt,
      followedBy: `The run continued to "${next.name}".`,
      followedByStepId: next.id,
    };
  }
  return {
    what,
    attempt: step.attempt,
    followedBy: "Nothing followed. The run stopped here.",
  };
}

// ---------------------------------------------------------------------------

function dedupeCitations(rows: readonly CitationRow[]): readonly CitationRow[] {
  const seen = new Set<string>();
  const kept: CitationRow[] = [];
  for (const row of rows) {
    const key = `${row.chunkId}|${row.documentTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return kept;
}

function list(value: string | number | boolean | undefined): readonly string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function text(value: string | number | boolean | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: string | number | boolean | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
