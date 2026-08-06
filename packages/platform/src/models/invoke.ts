import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { CeilingEnforcer } from "../guard/ceilings.js";
import { screen, type ScreenOptions, type ScreenVerdict } from "../guard/screen.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { RunStore } from "../record/port.js";
import type { ActorRef } from "../record/types.js";
import type { ModelInventory } from "./inventory.js";
import type { ModelInvocationStore } from "./port.js";
import {
  approximateTokens,
  isDegradable,
  ProviderError,
  type ModelProvider,
  type ProviderRegistry,
} from "./provider.js";
import { renderTemplate, type PromptTemplateRegistry } from "./templates.js";
import { roundUsd, type ModelBinding, type ModelInvocation } from "./types.js";

/**
 * The model gateway.
 *
 * Every model call in the platform goes through `invoke`. It is one function
 * for the same reason the authorization chokepoint is: the controls below only
 * hold if there is nowhere else to call a model from.
 *
 * The order of operations is the design:
 *
 *   1. Resolve the task through the inventory. An unresolved task is refused
 *      before anything is screened, rendered, spent, or recorded.
 *   2. Open a step in the operating record, so a call that fails in any later
 *      stage is still visible as work that was attempted.
 *   3. Screen the untrusted input. This happens *before* a provider is
 *      reached, not after — a screen that runs on the way back has already let
 *      the crafted text into the model.
 *   4. Check the ceilings with `isModelCall`, reserving the estimate.
 *   5. Call, retrying with jittered backoff, then walking the fallback chain.
 *   6. Record actual cost and *consume* the ceiling with the real figure.
 *   7. Record the invocation and a `model.invoked` audit entry carrying prompt
 *      and response digests and no text at all.
 *
 * When every option in the chain fails it throws `model.provider_unavailable`
 * rather than returning something worse. A gateway that quietly answers from a
 * degraded model without saying so turns an outage into a silent quality
 * regression, which is the failure mode nobody finds until a customer does.
 */

export interface ModelInput {
  /** Values for the prompt template's declared variables. */
  readonly variables: Readonly<Record<string, string>>;
  /**
   * Variables the caller asserts are platform-generated and need no screening.
   *
   * The default is that **everything is screened**. Naming a variable here is
   * a deliberate exemption and is recorded on the step, so skipping the screen
   * is a visible choice rather than the consequence of forgetting to opt in.
   */
  readonly trustedVariables?: readonly string[];
}

export interface InvocationContext {
  readonly runId: Id<"run">;
  readonly actor: ActorRef;
  /** Stable step name within the calling workflow. */
  readonly stepName: string;
  readonly correlationId?: string | undefined;
  /** Opaque references describing what this call is about. Never owner data. */
  readonly subject?: Readonly<Record<string, string>> | undefined;
  /**
   * Deduplication key, when the caller has one that survives a restart.
   *
   * Its presence is what permits retrying a call that may have an external
   * effect: only the caller knows whether its key is stable across a crash, so
   * the gateway will not invent one and then retry on the strength of it.
   */
  readonly idempotencyKey?: string | undefined;
  /**
   * Set when this call can cause something to happen outside the platform —
   * a provider-side tool, a webhook, anything with a consequence.
   */
  readonly mayHaveExternalEffect?: boolean | undefined;
}

export interface ModelInvocationResult {
  readonly text: string;
  readonly stepId: Id<"step">;
  readonly invocation: ModelInvocation;
  readonly screenVerdict: ScreenVerdict;
  /** Names of the secret patterns redacted out of the input before the call. */
  readonly redacted: readonly string[];
  /** True when the answer came from a fallback rather than the task's primary model. */
  readonly degraded: boolean;
}

export interface ModelGatewayDependencies {
  readonly inventory: ModelInventory;
  readonly providers: ProviderRegistry;
  readonly templates: PromptTemplateRegistry;
  readonly runs: RunStore;
  readonly invocations: ModelInvocationStore;
  readonly audit: AuditLog;
  readonly ceilings: CeilingEnforcer;
  readonly clock: Clock;
}

export interface ModelGatewayOptions {
  /** Attempts against one model before moving down the chain. Default 3. */
  readonly maxAttemptsPerModel?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Returns a value in [0, 1). Injected so backoff is deterministic in tests. */
  readonly jitter?: () => number;
  /** Injected so tests do not wait. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly screenOptions?: ScreenOptions;
}

/** Redaction patterns that indicate owner personal data rather than a credential. */
const OWNER_DATA_PATTERNS: readonly string[] = ["ssn", "pan"];

const DEFAULTS = {
  maxAttemptsPerModel: 3,
  baseBackoffMs: 250,
  maxBackoffMs: 8_000,
} as const;

export class ModelGateway {
  private readonly maxAttemptsPerModel: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitter: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly screenOptions: ScreenOptions;

  constructor(
    private readonly deps: ModelGatewayDependencies,
    options: ModelGatewayOptions = {},
  ) {
    this.maxAttemptsPerModel = options.maxAttemptsPerModel ?? DEFAULTS.maxAttemptsPerModel;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    // allow-random: jitter. Retry delays are spread so that a rate limit or an
    // outage does not make every worker retry in lockstep and re-create the
    // burst that caused it. Nothing else in this module reads randomness.
    this.jitter = options.jitter ?? (() => Math.random());
    this.sleep =
      options.sleep ??
      ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.screenOptions = options.screenOptions ?? {};
  }

  /**
   * Invoke the model bound to a logical task.
   *
   * @throws {DeniedError} `model.not_in_inventory` for an unknown task,
   *   `screen.injection_detected` or `screen.unavailable` when the input is
   *   refused, `ceiling.*` when a budget is passed, `config.missing` when the
   *   resolved provider is not configured, and `model.provider_unavailable`
   *   when every model in the chain fails.
   */
  async invoke(
    task: string,
    input: ModelInput,
    context: InvocationContext,
  ): Promise<ModelInvocationResult> {
    // 1. Resolution first. Refusing an unknown task before anything else means
    //    a typo in a task name never reaches a provider, a budget, or a record.
    const entry = this.deps.inventory.resolve(task);
    const template = this.deps.templates.require(entry.promptTemplateId);

    const requestDigest = digestValue({ task, variables: input.variables });
    const effectiveKey =
      context.idempotencyKey && context.idempotencyKey.trim().length > 0
        ? context.idempotencyKey
        : `${context.runId}:${context.stepName}:${requestDigest}`;

    const step = await this.deps.runs.appendStep({
      runId: context.runId,
      kind: "model_call",
      name: context.stepName,
      idempotencyKey: effectiveKey,
      status: "running",
      inputDigest: requestDigest,
      detail: {
        task,
        provider: entry.provider,
        modelId: entry.modelId,
        modelVersion: entry.modelVersion,
        promptTemplateId: template.id,
        promptTemplateVersion: template.version,
        maySeeOwnerData: entry.maySeeOwnerData,
        dataRetention: entry.dataRetention,
      },
    });

    let stepClosed = false;
    const startedAt = this.deps.clock.now();

    try {
      // 2. Screen every variable the caller did not explicitly exempt. This
      //    runs before the prompt is rendered and long before a provider is
      //    reached: the point of a boundary screen is that nothing crosses the
      //    boundary until it has passed.
      const trusted = input.trustedVariables ?? [];
      const screened: Record<string, string> = {};
      const redacted = new Set<string>();
      let verdict: ScreenVerdict = "clean";

      for (const [name, value] of Object.entries(input.variables)) {
        if (trusted.includes(name)) {
          screened[name] = value;
          continue;
        }
        const result = screen(value, this.screenOptions);
        screened[name] = result.text;
        for (const pattern of result.redacted) redacted.add(pattern);
        if (result.verdict === "suspicious") verdict = "suspicious";
      }

      // A task classified as never seeing owner data, being handed something
      // that looks like owner data, is a scope violation whichever way it
      // happened. Redaction has already blanked the value, so nothing would
      // leak — but the classification is now wrong, and a wrong classification
      // is what the data inventory and the DPA are built on.
      const ownerDataSeen = [...redacted].filter((pattern) =>
        OWNER_DATA_PATTERNS.includes(pattern),
      );
      if (!entry.maySeeOwnerData && ownerDataSeen.length > 0) {
        throw new DeniedError(
          "authorization.data_scope_violation",
          `Task "${task}" is declared as never seeing owner data, but its input matched ${ownerDataSeen.join(", ")}. Refusing rather than reclassifying the task at runtime.`,
          { task, patterns: ownerDataSeen.join(",") },
        );
      }

      const prompt = renderTemplate(template, screened);
      const promptTokens = approximateTokens(`${prompt.system}\n${prompt.user}`);

      // 3. Walk the chain. The primary first, then each declared fallback.
      const chain: readonly ModelBinding[] = this.deps.inventory.chain(task);
      const retriesAllowed = !context.mayHaveExternalEffect || Boolean(context.idempotencyKey);
      let lastFailure: ProviderError | undefined;
      let totalAttempts = 0;

      for (let index = 0; index < chain.length; index += 1) {
        const binding = chain[index];
        if (!binding) continue;
        const degraded = index > 0;
        // A provider named in the inventory but absent from this deployment is
        // a configuration failure, not an outage. It is refused rather than
        // degraded past, so the misconfiguration surfaces now.
        const provider: ModelProvider = this.deps.providers.require(binding.provider);

        const estimate = roundUsd(
          promptTokens * binding.costPerInputTokenUsd +
            binding.maxOutputTokens * binding.costPerOutputTokenUsd,
        );

        // 4. Pre-flight, with the estimate reserved against the run so two
        //    concurrent steps cannot both pass against the same headroom.
        await this.deps.ceilings.check(context.runId, {
          estimatedCostUsd: estimate,
          isModelCall: true,
        });

        const maxAttempts = retriesAllowed ? this.maxAttemptsPerModel : 1;
        let failure: ProviderError | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          totalAttempts += 1;
          const attemptStartedAt = this.deps.clock.now();
          try {
            const response = await provider.invoke({
              task,
              modelId: binding.modelId,
              modelVersion: binding.modelVersion,
              system: prompt.system,
              user: prompt.user,
              maxOutputTokens: binding.maxOutputTokens,
              timeoutMs: binding.timeoutMs,
              idempotencyKey: effectiveKey,
            });

            const latencyMs = Math.max(0, this.deps.clock.now() - attemptStartedAt);
            const costUsd = roundUsd(
              response.inputTokens * binding.costPerInputTokenUsd +
                response.outputTokens * binding.costPerOutputTokenUsd,
            );
            const responseDigest = digestValue({ text: response.text });

            const invocation: ModelInvocation = {
              stepId: step.id,
              runId: context.runId,
              task,
              provider: binding.provider,
              modelId: binding.modelId,
              modelVersion: binding.modelVersion,
              promptTemplateId: prompt.templateId,
              promptTemplateVersion: prompt.templateVersion,
              promptDigest: prompt.digest,
              responseDigest,
              inputTokens: response.inputTokens,
              outputTokens: response.outputTokens,
              costUsd,
              latencyMs,
              attempt,
              degraded,
              outcome: "succeeded",
              invokedAt: this.deps.clock.nowIso(),
            };

            // 5. Cost is recorded before the ceiling is consumed, because
            //    `consume` re-reads the operating record to decide whether the
            //    budget has now been passed. Recording after it would let a
            //    run spend past its ceiling one step at a time.
            await this.deps.runs.recordCost({
              runId: context.runId,
              stepId: step.id,
              category: "model",
              amountUsd: costUsd,
              units: response.inputTokens + response.outputTokens,
              modelId: binding.modelId,
              recordedAt: invocation.invokedAt,
              detail: { task, provider: binding.provider, attempt },
            });
            await this.deps.invocations.recordInvocation(invocation);
            await this.recordInvokedEntry(context, invocation, {
              verdict,
              redacted: [...redacted],
            });

            await this.deps.runs.patchStep(step.id, {
              status: "succeeded",
              endedAt: this.deps.clock.nowIso(),
              outputDigest: responseDigest,
              detail: {
                task,
                provider: binding.provider,
                modelId: binding.modelId,
                attempts: totalAttempts,
                degraded,
                latencyMs,
                costUsd,
                inputTokens: response.inputTokens,
                outputTokens: response.outputTokens,
                screenVerdict: verdict,
                redactedPatterns: [...redacted].sort().join(","),
                trustedVariables: [...trusted].sort().join(","),
              },
            });
            stepClosed = true;

            // 6. Consumption. This throws when the run has now passed its
            //    ceiling, and the throw is the point: the spend is already
            //    recorded, so what this stops is the next call. The answer is
            //    discarded rather than returned, because a run past its
            //    ceiling must stop rather than continue on a fresh result.
            await this.deps.ceilings.consume(context.runId, costUsd, estimate);

            return {
              text: response.text,
              stepId: step.id,
              invocation,
              screenVerdict: verdict,
              redacted: [...redacted].sort(),
              degraded,
            };
          } catch (error) {
            if (error instanceof DeniedError) throw error;
            const providerError = toProviderError(error, binding);
            failure = providerError;
            lastFailure = providerError;

            const canRetry =
              providerError.retryable && attempt < maxAttempts && isDegradable(providerError.kind);
            if (!canRetry) break;
            await this.sleep(this.backoffMs(attempt));
          }
        }

        // The attempt failed and nothing was spent on it, so the reservation
        // is released rather than held against the run for the rest of its life.
        this.deps.ceilings.release(context.runId, estimate);

        if (!failure) break;

        const nextBinding = chain[index + 1];
        // A refusal or a malformed request is not an availability problem: the
        // next model would decline the same content or reject the same request
        // for the same reason. Walking the chain there would spend three times
        // to fail three times.
        if (!isDegradable(failure.kind) || !nextBinding) break;

        await this.deps.audit.record(
          auditDecision({
            eventType: "model.degraded",
            actorId: context.actor.actorId,
            actorKind: context.actor.kind,
            actorRoles: context.actor.roles,
            runId: context.runId,
            correlationId: context.correlationId,
            subject: { ...(context.subject ?? {}), task, stepId: step.id },
            inputDigests: { prompt: prompt.digest },
            decision: {
              task,
              fromModelId: binding.modelId,
              toModelId: nextBinding.modelId,
              reason: failure.kind,
              attempts: totalAttempts,
            },
          }),
        );
      }

      // 7. Every option failed. Record what was attempted, then refuse.
      const failedInvocation: ModelInvocation = {
        stepId: step.id,
        runId: context.runId,
        task,
        provider: entry.provider,
        modelId: lastFailure?.modelId ?? entry.modelId,
        modelVersion: entry.modelVersion,
        promptTemplateId: prompt.templateId,
        promptTemplateVersion: prompt.templateVersion,
        promptDigest: prompt.digest,
        responseDigest: undefined,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: Math.max(0, this.deps.clock.now() - startedAt),
        attempt: totalAttempts,
        degraded: chain.length > 1,
        outcome: "failed",
        failureKind: lastFailure?.kind ?? "unavailable",
        invokedAt: this.deps.clock.nowIso(),
      };
      await this.deps.invocations.recordInvocation(failedInvocation);
      await this.recordInvokedEntry(context, failedInvocation, {
        verdict,
        redacted: [...redacted],
      });

      throw new DeniedError(
        "model.provider_unavailable",
        `Every model for task "${task}" failed (${failedInvocation.failureKind ?? "unavailable"}) after ${totalAttempts} attempt(s) across ${chain.length} model(s). Refusing rather than answering from something worse.`,
        {
          task,
          attempts: totalAttempts,
          models: chain.length,
          reason: failedInvocation.failureKind ?? "unavailable",
        },
      );
    } catch (error) {
      // The step is closed here so a refusal is visible in the operating
      // record as a refusal, with its reason, rather than as a step that
      // started and never finished. Denials are re-raised untouched.
      if (!stepClosed) {
        stepClosed = true;
        const denied = error instanceof DeniedError;
        await this.deps.runs.patchStep(step.id, {
          // A refusal and a malfunction are different things and the record
          // keeps them apart: `denied` carries a policy reason an operator can
          // act on, `failed` is a bug for an engineer.
          status: denied ? "denied" : "failed",
          endedAt: this.deps.clock.nowIso(),
          error: error instanceof Error ? error.message.slice(0, 500) : String(error),
          ...(denied ? { denialReason: error.reason } : {}),
        });
      }
      throw error;
    }
  }

  /**
   * Write the `model.invoked` entry.
   *
   * Digests only. The prompt and the response are the two things most likely
   * to contain owner material, and the audit log is retained for seven years —
   * so what goes in is the fingerprint that proves which prompt produced which
   * answer, and a reviewer who is entitled to the text fetches it from the
   * system of record instead.
   */
  private async recordInvokedEntry(
    context: InvocationContext,
    invocation: ModelInvocation,
    screening: { readonly verdict: ScreenVerdict; readonly redacted: readonly string[] },
  ): Promise<void> {
    const inputDigests: Record<string, Digest> = { prompt: invocation.promptDigest };
    if (invocation.responseDigest) inputDigests["response"] = invocation.responseDigest;

    await this.deps.audit.record(
      auditDecision({
        eventType: "model.invoked",
        actorId: context.actor.actorId,
        actorKind: context.actor.kind,
        actorRoles: context.actor.roles,
        runId: context.runId,
        correlationId: context.correlationId,
        subject: { ...(context.subject ?? {}), task: invocation.task, stepId: invocation.stepId },
        inputDigests,
        decision: {
          task: invocation.task,
          provider: invocation.provider,
          modelId: invocation.modelId,
          modelVersion: invocation.modelVersion,
          promptTemplateId: invocation.promptTemplateId,
          promptTemplateVersion: invocation.promptTemplateVersion,
          inputTokens: invocation.inputTokens,
          outputTokens: invocation.outputTokens,
          costUsd: invocation.costUsd,
          latencyMs: invocation.latencyMs,
          attempts: invocation.attempt,
          degraded: invocation.degraded,
          outcome: invocation.outcome,
          screenVerdict: screening.verdict,
          redactedPatterns: [...screening.redacted].sort().join(","),
          ...(invocation.failureKind ? { failureKind: invocation.failureKind } : {}),
        },
      }),
    );
  }

  /** Exponential backoff, jittered between half and all of the capped delay. */
  private backoffMs(attempt: number): number {
    const capped = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (attempt - 1));
    return Math.round(capped * (0.5 + 0.5 * this.jitter()));
  }
}

/**
 * Normalise anything a provider throws into a classified failure.
 *
 * A provider that throws a bare `Error` is treated as unavailable — the
 * degradable class — because an unclassified failure from a remote service is
 * far more often an outage than a permanent rejection, and the chain will
 * establish which within one more call.
 */
function toProviderError(error: unknown, binding: ModelBinding): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof InvalidInputError) {
    return new ProviderError(
      "invalid_request",
      binding.provider,
      binding.modelId,
      error.message,
      false,
    );
  }
  return new ProviderError(
    "unavailable",
    binding.provider,
    binding.modelId,
    error instanceof Error ? error.message : String(error),
  );
}
