import { canonicalJson } from "../kernel/canonical.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import { isDigest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc } from "../record/migrations.js";
import { storeUnavailable, type Db } from "../store/db.js";
import type { ModelInvocationStore } from "./port.js";
import type {
  ModelInvocation,
  ModelInvocationFilter,
  ModelOutcome,
  ProviderName,
  TaskUsage,
} from "./types.js";

/**
 * Postgres model invocations.
 *
 * The idempotent write is a single `INSERT ... ON CONFLICT (step_id) DO
 * NOTHING RETURNING step_id`, not a read followed by a write. Postgres
 * serialises concurrent inserts of the same key, so of N callers recovering
 * the same step exactly one inserts and the rest see no returned row — which
 * is what makes "one step, one invocation" true under concurrency rather than
 * merely likely. Only when nothing was inserted does this read the existing
 * row back, to decide whether the caller is repeating itself harmlessly or
 * claiming a step that already belongs to a different call.
 *
 * `numeric` and `bigint` columns arrive from `pg` as strings so that large
 * values do not lose precision in transit. They are converted explicitly on
 * the way out; letting a numeric column reach a spend comparison as a string
 * would make `"10" > 9` false.
 */

type InvocationRow = {
  step_id: string;
  run_id: string;
  task: string;
  provider: string;
  model_id: string;
  model_version: string;
  prompt_template_id: string;
  prompt_template_version: number;
  prompt_digest: string;
  response_digest: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
  latency_ms: number;
  attempt: number;
  degraded: boolean;
  outcome: string;
  failure_kind: string | null;
  invoked_at: string;
};

type UsageRow = {
  task: string;
  model_id: string;
  calls: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string;
};

const COLUMNS = `step_id, run_id, task, provider, model_id, model_version,
  prompt_template_id, prompt_template_version, prompt_digest, response_digest,
  input_tokens, output_tokens, cost_usd, latency_ms, attempt, degraded,
  outcome, failure_kind, invoked_at`;

export class PgModelInvocationStore implements ModelInvocationStore {
  constructor(private readonly db: Db) {}

  async recordInvocation(invocation: ModelInvocation): Promise<void> {
    assertInvocation(invocation);

    await this.guard("recordInvocation", async () => {
      const inserted = await this.db.query<{ step_id: string }>(
        `INSERT INTO model_invocation (${COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (step_id) DO NOTHING
         RETURNING step_id`,
        [
          invocation.stepId,
          invocation.runId,
          invocation.task,
          invocation.provider,
          invocation.modelId,
          invocation.modelVersion,
          invocation.promptTemplateId,
          invocation.promptTemplateVersion,
          invocation.promptDigest,
          invocation.responseDigest ?? null,
          invocation.inputTokens,
          invocation.outputTokens,
          invocation.costUsd,
          invocation.latencyMs,
          invocation.attempt,
          invocation.degraded,
          invocation.outcome,
          invocation.failureKind ?? null,
          invocation.invokedAt,
        ],
      );
      if (inserted.length > 0) return;

      // Nothing was inserted, so a row already exists. A repeat of the same
      // write is the crash-then-recover path and is allowed through; anything
      // else means two calls claimed one step.
      const rows = await this.db.query<InvocationRow>(
        `SELECT ${COLUMNS} FROM model_invocation WHERE step_id = $1`,
        [invocation.stepId],
      );
      const existing = rows[0];
      if (existing && canonicalJson(toInvocation(existing)) === canonicalJson(invocation)) return;
      throw new DeniedError(
        "record.unavailable",
        `Step ${invocation.stepId} already has a different model invocation recorded against it. Two calls cannot share one step without making the cost report a guess.`,
        { stepId: invocation.stepId },
      );
    });
  }

  async getInvocation(stepId: Id<"step">): Promise<ModelInvocation | null> {
    const rows = await this.guard("getInvocation", () =>
      this.db.query<InvocationRow>(`SELECT ${COLUMNS} FROM model_invocation WHERE step_id = $1`, [
        stepId,
      ]),
    );
    const row = rows[0];
    return row ? toInvocation(row) : null;
  }

  async listInvocations(filter: ModelInvocationFilter = {}): Promise<readonly ModelInvocation[]> {
    const { where, values } = buildWhere(filter);
    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page += ` LIMIT $${values.length}`;
    }
    if (filter.offset !== undefined) {
      values.push(filter.offset);
      page += ` OFFSET $${values.length}`;
    }

    const rows = await this.guard("listInvocations", () =>
      this.db.query<InvocationRow>(
        `SELECT ${COLUMNS} FROM model_invocation ${where}
         ORDER BY invoked_at DESC, ordinal DESC${page}`,
        values,
      ),
    );
    return rows.map(toInvocation);
  }

  async countInvocations(filter: ModelInvocationFilter = {}): Promise<number> {
    const { where, values } = buildWhere(filter);
    const rows = await this.guard("countInvocations", () =>
      this.db.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM model_invocation ${where}`,
        values,
      ),
    );
    return Number(rows[0]?.total ?? 0);
  }

  async usageByTask(since?: string): Promise<readonly TaskUsage[]> {
    if (since !== undefined) assertIsoUtc("since", since);
    const values: unknown[] = [];
    let where = "";
    if (since !== undefined) {
      values.push(since);
      where = `WHERE invoked_at >= $${values.length}`;
    }

    const rows = await this.guard("usageByTask", () =>
      this.db.query<UsageRow>(
        `SELECT task,
                model_id,
                count(*)::text          AS calls,
                sum(input_tokens)::text  AS input_tokens,
                sum(output_tokens)::text AS output_tokens,
                sum(cost_usd)::text      AS cost_usd
         FROM model_invocation ${where}
         GROUP BY task, model_id
         ORDER BY task ASC, model_id ASC`,
        values,
      ),
    );

    return rows.map((row) => ({
      task: row.task,
      modelId: row.model_id,
      calls: Number(row.calls),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      costUsd: Number(Number(row.cost_usd).toFixed(10)),
    }));
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DeniedError || error instanceof InvalidInputError) throw error;
      throw storeUnavailable(operation, error);
    }
  }
}

function buildWhere(filter: ModelInvocationFilter): { where: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (filter.runId !== undefined) {
    values.push(filter.runId);
    clauses.push(`run_id = $${values.length}`);
  }
  if (filter.task !== undefined) {
    values.push(filter.task);
    clauses.push(`task = $${values.length}`);
  }
  if (filter.modelId !== undefined) {
    values.push(filter.modelId);
    clauses.push(`model_id = $${values.length}`);
  }
  if (filter.outcome !== undefined) {
    values.push(filter.outcome);
    clauses.push(`outcome = $${values.length}`);
  }
  if (filter.degradedOnly === true) clauses.push("degraded");
  if (filter.invokedAfter !== undefined) {
    values.push(filter.invokedAfter);
    clauses.push(`invoked_at > $${values.length}`);
  }
  if (filter.invokedBefore !== undefined) {
    values.push(filter.invokedBefore);
    clauses.push(`invoked_at < $${values.length}`);
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

function toInvocation(row: InvocationRow): ModelInvocation {
  return {
    stepId: row.step_id as Id<"step">,
    runId: row.run_id as Id<"run">,
    task: row.task,
    provider: row.provider as ProviderName,
    modelId: row.model_id,
    modelVersion: row.model_version,
    promptTemplateId: row.prompt_template_id,
    promptTemplateVersion: row.prompt_template_version,
    promptDigest: row.prompt_digest as Digest,
    responseDigest: row.response_digest ?? undefined,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    // numeric arrives as a string; comparing it as one against a spend ceiling
    // would compare lexicographically and silently permit an overrun.
    costUsd: Number(row.cost_usd),
    latencyMs: Number(row.latency_ms),
    attempt: Number(row.attempt),
    degraded: row.degraded,
    outcome: row.outcome as ModelOutcome,
    failureKind: row.failure_kind ?? undefined,
    invokedAt: row.invoked_at,
  };
}

function assertInvocation(invocation: ModelInvocation): void {
  assertIsoUtc("invokedAt", invocation.invokedAt);
  if (!isDigest(invocation.promptDigest)) {
    throw new InvalidInputError(
      "promptDigest must be a sha256 digest, not a value: this table records fingerprints, never prompts.",
      "promptDigest",
    );
  }
  if (invocation.responseDigest !== undefined && !isDigest(invocation.responseDigest)) {
    throw new InvalidInputError(
      "responseDigest must be a sha256 digest, not a value: this table records fingerprints, never responses.",
      "responseDigest",
    );
  }
  if (!Number.isFinite(invocation.costUsd) || invocation.costUsd < 0) {
    throw new InvalidInputError(
      `costUsd must be a non-negative number, received: ${String(invocation.costUsd)}`,
      "costUsd",
    );
  }
}
