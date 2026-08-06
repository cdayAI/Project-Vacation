import { createHash } from "node:crypto";
import { z } from "zod";
import { DeniedError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import type { ProviderName } from "./types.js";

/**
 * Model providers.
 *
 * The gateway talks to this interface and nothing else, which is what lets the
 * seeded demo and the whole test suite run with no network and still exercise
 * the real degradation, cost, and audit paths.
 *
 * Two implementations ship:
 *
 *   `FakeProvider`      deterministic and scriptable. Given a seed and the same
 *                       call sequence it produces byte-identical output, which
 *                       is what makes "the demo runs twice identically" true.
 *   `AnthropicProvider` real HTTP against the Messages API, with a timeout on
 *                       every attempt and a key that is never logged.
 *
 * Failures are classified rather than thrown as bare errors, because the
 * gateway's decisions depend on the class: a timeout or an outage is worth
 * degrading to another model, a malformed request or a content refusal is not
 * — the next model would refuse the same request for the same reason, so
 * walking the chain would just spend money to fail three times.
 */

export type ProviderFailureKind =
  /** The attempt exceeded its timeout. */
  | "timeout"
  /** The provider asked us to slow down. */
  | "rate_limited"
  /** The provider is down, overloaded, or unreachable. */
  | "unavailable"
  /** The provider declined to answer this content. Not an availability problem. */
  | "refused"
  /** We sent something the provider will not accept. A bug on our side. */
  | "invalid_request";

/** Failure classes worth trying a different model for. */
const DEGRADABLE: readonly ProviderFailureKind[] = ["timeout", "rate_limited", "unavailable"];

export function isDegradable(kind: ProviderFailureKind): boolean {
  return DEGRADABLE.includes(kind);
}

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly provider: ProviderName;
  readonly modelId: string;
  /** Whether the same call is worth repeating against the same model. */
  readonly retryable: boolean;

  constructor(
    kind: ProviderFailureKind,
    provider: ProviderName,
    modelId: string,
    message: string,
    retryable = isDegradable(kind),
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.provider = provider;
    this.modelId = modelId;
    this.retryable = retryable;
  }
}

export interface ModelRequest {
  /** The logical task, carried through for scripting and provider-side attribution. */
  readonly task: string;
  readonly modelId: string;
  readonly modelVersion: string;
  /** Fixed instructions. Never contains caller-supplied text. */
  readonly system: string;
  /** The screened, redacted body. This is the only place untrusted text appears. */
  readonly user: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /**
   * Deduplication key for a call that may have an external effect.
   *
   * Present means a repeat is safe. Absent means the gateway must not retry.
   */
  readonly idempotencyKey?: string | undefined;
}

export interface ModelResponse {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** What the provider says it ran, which may differ from what we asked for. */
  readonly modelId: string;
}

export interface ModelProvider {
  readonly name: ProviderName;
  /** @throws {ProviderError} on any failure, classified. */
  invoke(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * Providers available to this deployment, by name.
 *
 * A binding naming a provider that is not registered is a configuration
 * failure, not an outage: it is refused outright rather than degraded past,
 * because degrading past a misconfiguration would hide it until the fallback
 * also broke.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, ModelProvider>();

  constructor(providers: readonly ModelProvider[] = []) {
    for (const provider of providers) this.providers.set(provider.name, provider);
  }

  register(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** @throws {DeniedError} `config.missing` when the provider is not configured. */
  require(name: ProviderName): ModelProvider {
    const found = this.providers.get(name);
    if (!found) {
      throw new DeniedError(
        "config.missing",
        `The model inventory names provider "${name}", which this deployment has not configured. Refusing rather than substituting another provider.`,
        { provider: name },
      );
    }
    return found;
  }

  names(): readonly ProviderName[] {
    return [...this.providers.keys()];
  }
}

/**
 * Rough token count from character length.
 *
 * Deliberately approximate and only ever used for the pre-flight cost
 * estimate. The number that matters is the provider's reported usage, which is
 * what the ceiling consumes after the call — which is precisely why the
 * ceiling is enforced at consumption rather than trusting an estimate like
 * this one.
 */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One scripted behaviour for the fake. First match wins. */
export interface FakeBehaviour {
  /** Match on the resolved model id. Omitted matches every model. */
  readonly modelId?: string;
  /** Match on the logical task. Omitted matches every task. */
  readonly task?: string;
  /** Fail this many consecutive matching calls before behaving normally. */
  readonly failures?: number;
  readonly failureKind?: ProviderFailureKind;
  /** Fixed response text instead of the seeded one. */
  readonly text?: string;
  /** Milliseconds to charge to the injected clock, so latency is observable without waiting. */
  readonly latencyMs?: number;
}

export interface FakeCall {
  readonly task: string;
  readonly modelId: string;
  readonly promptDigest: string;
  readonly idempotencyKey?: string | undefined;
}

/**
 * Deterministic, scriptable provider.
 *
 * The output is a pure function of the seed and the request — no counter, no
 * clock, no randomness — so the seeded demo reproduces byte for byte and a
 * retry of an identical prompt produces an identical answer. That second
 * property is worth having: it means a retried call after a crash cannot
 * silently change the answer a person already approved.
 *
 * It is a test double and the configuration loader refuses it outside
 * development for that reason.
 */
export class FakeProvider implements ModelProvider {
  readonly name: ProviderName = "fake";
  private readonly behaviours: FakeBehaviour[] = [];
  private readonly failureCounts = new Map<number, number>();
  private readonly recorded: FakeCall[] = [];

  constructor(
    private readonly seed: string,
    /** Optional test clock the fake charges scripted latency to. */
    private readonly clock?: { advance(milliseconds: number): void },
  ) {}

  /** Add a behaviour. Behaviours are matched in the order they were added. */
  script(behaviour: FakeBehaviour): this {
    this.behaviours.push(behaviour);
    return this;
  }

  /** Every call the fake has been asked to make, for assertions about ordering. */
  get calls(): readonly FakeCall[] {
    return this.recorded;
  }

  reset(): void {
    this.behaviours.length = 0;
    this.failureCounts.clear();
    this.recorded.length = 0;
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const promptDigest = digestValue({ system: request.system, user: request.user });
    this.recorded.push({
      task: request.task,
      modelId: request.modelId,
      promptDigest,
      idempotencyKey: request.idempotencyKey,
    });

    const index = this.behaviours.findIndex(
      (behaviour) =>
        (behaviour.modelId === undefined || behaviour.modelId === request.modelId) &&
        (behaviour.task === undefined || behaviour.task === request.task),
    );
    const behaviour = index >= 0 ? this.behaviours[index] : undefined;

    if (behaviour?.latencyMs !== undefined) this.clock?.advance(behaviour.latencyMs);

    if (behaviour && behaviour.failures !== undefined && behaviour.failures > 0) {
      const used = this.failureCounts.get(index) ?? 0;
      if (used < behaviour.failures) {
        this.failureCounts.set(index, used + 1);
        const kind = behaviour.failureKind ?? "unavailable";
        throw new ProviderError(
          kind,
          this.name,
          request.modelId,
          `Scripted ${kind} from the fake provider for ${request.modelId}.`,
        );
      }
    }

    const text =
      behaviour?.text ??
      `[${request.task}] ${createHash("sha256")
        .update(`${this.seed}:${request.task}:${request.modelId}:${promptDigest}`)
        .digest("hex")
        .slice(0, 32)}`;

    return {
      text,
      inputTokens: approximateTokens(`${request.system}\n${request.user}`),
      outputTokens: approximateTokens(text),
      modelId: request.modelId,
    };
  }
}

/**
 * Shape of the Messages API response, parsed rather than asserted.
 *
 * A provider response is data from outside the platform, so it goes through a
 * schema on the way in. Anything unexpected becomes a classified failure the
 * gateway can act on instead of a `TypeError` several frames later.
 */
const messagesResponse = z.object({
  model: z.string().optional(),
  stop_reason: z.string().nullish(),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .default([]),
  usage: z
    .object({
      input_tokens: z.number().nonnegative().optional(),
      output_tokens: z.number().nonnegative().optional(),
    })
    .default({}),
});

export interface AnthropicProviderOptions {
  /** Read from configuration. Held here, sent as a header, never logged or recorded. */
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Injected for tests. Defaults to the runtime's global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** API version header. Pinned so a server-side change cannot alter our request shape. */
  readonly apiVersion?: string;
}

/**
 * Real HTTP against the Messages API.
 *
 * Two things about this class are governance rather than plumbing.
 *
 * **The key never leaves this object.** It is read from configuration into a
 * private field, sent only in the request header, and never placed in an
 * error, a log line, an audit entry, or a thrown message. Errors below quote
 * the status code and the provider's message, never the request headers.
 *
 * **The deployed model identifiers must be confirmed with the customer**
 * before production use, and the provider's terms — zero data retention and no
 * training on customer data — must be recorded in writing before any customer
 * material is sent through here. Neither is assumed anywhere in this codebase:
 * the inventory ships every entry marked `unconfirmed` and raises a warning
 * until someone changes it deliberately.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name: ProviderName = "anthropic";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;

  constructor(options: AnthropicProviderOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new DeniedError(
        "config.missing",
        "The model provider was configured without an API key, so no call can be made. Refusing at construction rather than at the first request.",
        {},
      );
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiVersion = options.apiVersion ?? "2023-06-01";
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    // Every attempt is bounded. A provider that has not answered within the
    // binding's timeout has failed, and the gateway would rather degrade to
    // another model than hold a run open indefinitely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": this.apiVersion,
        "x-api-key": this.apiKey,
      };
      if (request.idempotencyKey) headers["idempotency-key"] = request.idempotencyKey;

      const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: request.modelId,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
        }),
      });

      if (!response.ok) {
        throw this.classifyStatus(response.status, await this.safeBody(response), request.modelId);
      }

      const parsed = messagesResponse.safeParse(await response.json());
      if (!parsed.success) {
        throw new ProviderError(
          "invalid_request",
          this.name,
          request.modelId,
          `The provider returned a response this platform could not parse: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          false,
        );
      }

      const body = parsed.data;
      if (body.stop_reason === "refusal") {
        // A content refusal is a decision, not an outage. Another model would
        // very likely refuse the same material, so this must not degrade.
        throw new ProviderError(
          "refused",
          this.name,
          request.modelId,
          `The provider declined to answer for ${request.modelId}.`,
          false,
        );
      }

      const text = body.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .join("");

      return {
        text,
        inputTokens: body.usage.input_tokens ?? approximateTokens(request.user),
        outputTokens: body.usage.output_tokens ?? approximateTokens(text),
        modelId: body.model ?? request.modelId,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError(
          "timeout",
          this.name,
          request.modelId,
          `No answer from ${request.modelId} within ${request.timeoutMs}ms.`,
        );
      }
      // A transport failure — DNS, TLS, a reset connection — is an outage from
      // the caller's point of view and is worth degrading for.
      throw new ProviderError(
        "unavailable",
        this.name,
        request.modelId,
        `Could not reach the model provider for ${request.modelId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private classifyStatus(status: number, detail: string, modelId: string): ProviderError {
    if (status === 429) {
      return new ProviderError(
        "rate_limited",
        this.name,
        modelId,
        `The provider rate-limited ${modelId} (429).`,
      );
    }
    if (status === 408) {
      return new ProviderError("timeout", this.name, modelId, `The provider timed out (408).`);
    }
    if (status === 401 || status === 403) {
      // Not an outage: every fallback would present the same credential and
      // fail identically. Refusing loudly is the only useful behaviour.
      return new ProviderError(
        "invalid_request",
        this.name,
        modelId,
        `The model provider rejected this deployment's credential (${status}). Check the configured key; it is not logged anywhere.`,
        false,
      );
    }
    if (status >= 500) {
      return new ProviderError(
        "unavailable",
        this.name,
        modelId,
        `The provider returned ${status} for ${modelId}.`,
      );
    }
    return new ProviderError(
      "invalid_request",
      this.name,
      modelId,
      `The provider rejected the request for ${modelId} (${status}): ${detail}`,
      false,
    );
  }

  /**
   * Read an error body without letting a broken body mask the status code.
   *
   * Truncated hard: an error body is provider prose, and a large one has no
   * business travelling into an exception message that may be logged.
   */
  private async safeBody(response: Response): Promise<string> {
    try {
      return (await response.text()).slice(0, 200);
    } catch {
      return "(no readable body)";
    }
  }
}
