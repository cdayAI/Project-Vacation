import { ConfigError, DeniedError } from "../kernel/errors.js";
import type { ModelBinding, ModelEntry, ProviderName } from "./types.js";

/**
 * The model inventory.
 *
 * This is the single place a logical task becomes a concrete model, and the
 * single place a concrete model identifier is allowed to appear (an
 * architecture test enforces the second half). Everything downstream —
 * `ModelGateway`, the console, the cost report, the model-inventory assurance
 * artifact — reads from here, so there is exactly one answer to "what serves
 * this task" and changing it is a reviewable diff.
 *
 * An unknown task is refused with `model.not_in_inventory` rather than falling
 * back to a default model. A default would mean a task nobody classified —
 * nobody decided whether it may see owner data, nobody set its ceiling, nobody
 * evaluated it — quietly running against whatever model was cheapest to reach.
 * Refusing is the whole point of having an inventory.
 */

/**
 * Deployed model identifiers must be confirmed with the customer before use,
 * and the provider's terms — zero data retention and no training on customer
 * data — must be recorded in writing before any production call is made.
 * Neither is assumed here: every default entry ships with
 * `dataRetention: "unconfirmed"`, which raises an inventory warning that the
 * console and the assurance artifact both surface.
 *
 * The identifiers below are floating aliases, so `modelVersion` is `unpinned`.
 * An alias moves to a new revision without any change on our side, which
 * defeats the purpose of an inventory; before production each entry must name
 * the dated snapshot the customer approved.
 */
const UNPINNED = "unpinned";

/** Deepest reasoning, highest cost. For extraction and drafting that a person will sign. */
const DEEP: ModelBinding = {
  provider: "anthropic",
  modelId: "claude-opus-5",
  modelVersion: UNPINNED,
  costPerInputTokenUsd: 0.000005,
  costPerOutputTokenUsd: 0.000025,
  maxOutputTokens: 8_000,
  timeoutMs: 120_000,
};

/** The working default: near-deep quality at a third of the cost. */
const BALANCED: ModelBinding = {
  provider: "anthropic",
  modelId: "claude-sonnet-5",
  modelVersion: UNPINNED,
  costPerInputTokenUsd: 0.000003,
  costPerOutputTokenUsd: 0.000015,
  maxOutputTokens: 8_000,
  timeoutMs: 90_000,
};

/** Cheap and fast. For classification and other short, bounded judgements. */
const FAST: ModelBinding = {
  provider: "anthropic",
  modelId: "claude-haiku-4-5",
  modelVersion: UNPINNED,
  costPerInputTokenUsd: 0.000001,
  costPerOutputTokenUsd: 0.000005,
  maxOutputTokens: 4_000,
  timeoutMs: 60_000,
};

/**
 * The shipped inventory.
 *
 * Every fallback chain degrades toward a cheaper, faster model rather than a
 * different provider. That is a deliberate limitation and it is stated in the
 * handover notes: a single-provider outage takes every task with it. A second
 * provider is a contracting decision, not an engineering one, and adding one
 * here without the terms confirmed would be worse than the outage.
 */
export const DEFAULT_MODEL_ENTRIES: readonly ModelEntry[] = [
  {
    ...DEEP,
    task: "rescission.extract_contract_facts",
    purpose:
      "Extract dates, parties, and statutory triggers from a rescission packet so the deadline calculation has structured input.",
    fallbacks: [BALANCED],
    maySeeOwnerData: true,
    dataRetention: "unconfirmed",
    promptTemplateId: "rescission.extract_contract_facts",
  },
  {
    ...DEEP,
    task: "rescission.draft_owner_letter",
    purpose:
      "Draft the acknowledgement letter an owner receives, for a person to review and approve before it is sent.",
    fallbacks: [BALANCED],
    maySeeOwnerData: true,
    dataRetention: "unconfirmed",
    promptTemplateId: "rescission.draft_owner_letter",
  },
  {
    ...BALANCED,
    task: "knowledge.answer_with_citations",
    purpose:
      "Answer a policy question strictly from retrieved passages, citing each one, so an answer without grounding is visibly absent.",
    fallbacks: [FAST],
    maySeeOwnerData: false,
    dataRetention: "unconfirmed",
    promptTemplateId: "knowledge.answer_with_citations",
  },
  {
    ...FAST,
    task: "contact.classify_owner_intent",
    purpose:
      "Classify an inbound owner message into a routing category. High volume, short output, no consequential effect on its own.",
    fallbacks: [BALANCED],
    maySeeOwnerData: true,
    dataRetention: "unconfirmed",
    promptTemplateId: "contact.classify_owner_intent",
  },
  {
    ...BALANCED,
    task: "documents.summarise_for_reviewer",
    purpose:
      "Summarise a generated document so the approver reads a short, faithful description of what they are signing.",
    fallbacks: [FAST],
    maySeeOwnerData: true,
    dataRetention: "unconfirmed",
    promptTemplateId: "documents.summarise_for_reviewer",
  },
  {
    ...BALANCED,
    task: "improve.cluster_correction_notes",
    purpose:
      "Group operator corrections into candidate improvement proposals for a person to evaluate. Never applies anything.",
    fallbacks: [FAST],
    maySeeOwnerData: false,
    dataRetention: "unconfirmed",
    promptTemplateId: "improve.cluster_correction_notes",
  },
];

export class ModelInventory {
  private readonly byTask: ReadonlyMap<string, ModelEntry>;
  private readonly entries: readonly ModelEntry[];
  /** Entries that are usable but not yet safe to assume anything about. */
  readonly warnings: readonly string[];

  /** @throws {ConfigError} if the inventory is structurally unusable. */
  constructor(entries: readonly ModelEntry[]) {
    const byTask = new Map<string, ModelEntry>();
    const warnings: string[] = [];

    for (const entry of entries) {
      if (typeof entry.task !== "string" || entry.task.trim().length === 0) {
        throw new ConfigError("A model inventory entry has no task name.", {});
      }
      if (byTask.has(entry.task)) {
        // Two entries for one task means "which model serves this" has two
        // answers, and the one that wins depends on array order. That is
        // exactly the ambiguity an inventory exists to remove.
        throw new ConfigError(
          `Task "${entry.task}" appears twice in the model inventory. A task resolves to exactly one model.`,
          { task: entry.task },
        );
      }
      for (const binding of [entry, ...entry.fallbacks]) {
        assertBinding(entry.task, binding);
      }
      byTask.set(entry.task, entry);

      if (entry.dataRetention === "unconfirmed") {
        warnings.push(
          `MODEL: task "${entry.task}" runs on ${entry.modelId} with data-retention terms UNCONFIRMED. Confirm zero data retention and no training on customer data in writing before production use.`,
        );
      }
      if (entry.modelVersion === UNPINNED) {
        warnings.push(
          `MODEL: task "${entry.task}" names the floating alias ${entry.modelId} rather than a dated revision, so the model can change underneath the inventory. Pin the confirmed snapshot before production.`,
        );
      }
      if (entry.fallbacks.length === 0) {
        warnings.push(
          `MODEL: task "${entry.task}" has no fallback. A provider outage refuses this task outright rather than degrading.`,
        );
      }
    }

    this.entries = [...entries];
    this.byTask = byTask;
    this.warnings = Object.freeze(warnings);
  }

  /**
   * Resolve a logical task to its model.
   *
   * @throws {DeniedError} `model.not_in_inventory` for any task that was not
   *   declared. There is no default model.
   */
  resolve(task: string): ModelEntry {
    const found = this.byTask.get(task);
    if (!found) {
      throw new DeniedError(
        "model.not_in_inventory",
        `Task "${task}" is not in the model inventory, so no model was resolved and nothing was called. Add the task to the inventory as a reviewed change.`,
        { task },
      );
    }
    return found;
  }

  has(task: string): boolean {
    return this.byTask.has(task);
  }

  /**
   * The chain to walk: the primary first, then each declared fallback.
   *
   * Returned as plain bindings so the gateway cannot accidentally treat a
   * fallback as though it carried the task's governance fields.
   */
  chain(task: string): readonly ModelBinding[] {
    const entry = this.resolve(task);
    return [toBinding(entry), ...entry.fallbacks];
  }

  /** Every entry, for the console and the model-inventory assurance artifact. */
  list(): readonly ModelEntry[] {
    return this.entries;
  }

  /** Tasks whose input may include owner personal data, for the data inventory. */
  tasksSeeingOwnerData(): readonly string[] {
    return this.entries.filter((entry) => entry.maySeeOwnerData).map((entry) => entry.task);
  }
}

/**
 * Build the shipped inventory for a configured provider.
 *
 * When the deployment is configured for the deterministic fake, every binding
 * is rewritten to name the fake explicitly — `fake/<model id>` — rather than
 * leaving the real identifier in place. An inventory that claimed a production
 * model while a test double answered would make the audit record a false
 * statement, and the whole value of the record is that it is not one.
 */
export function defaultInventory(provider: ProviderName = "anthropic"): ModelInventory {
  if (provider === "anthropic") return new ModelInventory(DEFAULT_MODEL_ENTRIES);

  return new ModelInventory(
    DEFAULT_MODEL_ENTRIES.map((entry) => ({
      ...entry,
      ...asFake(entry),
      fallbacks: entry.fallbacks.map((binding) => ({ ...binding, ...asFake(binding) })),
    })),
  );
}

function asFake(binding: ModelBinding): Pick<ModelBinding, "provider" | "modelId"> {
  return { provider: "fake", modelId: `fake/${binding.modelId}` };
}

function toBinding(entry: ModelEntry): ModelBinding {
  return {
    provider: entry.provider,
    modelId: entry.modelId,
    modelVersion: entry.modelVersion,
    costPerInputTokenUsd: entry.costPerInputTokenUsd,
    costPerOutputTokenUsd: entry.costPerOutputTokenUsd,
    maxOutputTokens: entry.maxOutputTokens,
    timeoutMs: entry.timeoutMs,
  };
}

function assertBinding(task: string, binding: ModelBinding): void {
  if (typeof binding.modelId !== "string" || binding.modelId.trim().length === 0) {
    throw new ConfigError(`Task "${task}" has a model binding with no model id.`, { task });
  }
  for (const [field, value] of [
    ["costPerInputTokenUsd", binding.costPerInputTokenUsd],
    ["costPerOutputTokenUsd", binding.costPerOutputTokenUsd],
  ] as const) {
    // A negative or unstated per-token cost makes the spend ceiling a
    // decoration: the estimate it checks against would be free, and the actual
    // it consumes would be wrong in the direction that never refuses.
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new ConfigError(
        `Task "${task}" binding ${binding.modelId} has an unusable ${field}: ${String(value)}.`,
        { task, modelId: binding.modelId },
      );
    }
  }
  if (!Number.isInteger(binding.maxOutputTokens) || binding.maxOutputTokens <= 0) {
    throw new ConfigError(
      `Task "${task}" binding ${binding.modelId} needs a positive maxOutputTokens.`,
      { task, modelId: binding.modelId },
    );
  }
  if (!Number.isInteger(binding.timeoutMs) || binding.timeoutMs <= 0) {
    // Without a timeout a hung provider holds the run open until the
    // wall-clock ceiling notices, which is minutes of an operator's confusion
    // for a failure the provider could have reported in seconds.
    throw new ConfigError(
      `Task "${task}" binding ${binding.modelId} needs a positive timeoutMs.`,
      { task, modelId: binding.modelId },
    );
  }
}
