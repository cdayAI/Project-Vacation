import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { Logger } from "../kernel/logger.js";
import { redactText } from "../kernel/redact.js";
import type { RunStore } from "../record/port.js";
import type { Step } from "../record/types.js";
import type { ContainmentController } from "../guard/containment.js";
import { credentialPermitsHost, hostMatches } from "./credentials.js";
import type { SecretProvider } from "./port.js";

/**
 * Outbound HTTP.
 *
 * Nothing in this platform calls `fetch` at an external system directly. Every
 * outbound call comes through here, because seven controls belong on that path
 * and putting them anywhere else means putting them in seven places:
 *
 *   *Host allowlist.* From configuration, and empty by default — a deployment
 *   that has not been told where it may talk to talks to nobody. This is the
 *   control that turns a prompt-injection payload containing a URL into a
 *   refusal rather than an exfiltration channel.
 *
 *   *Credential scoping.* Credentials are fetched per call from the secret
 *   provider and are scoped to hosts. A call to an allowlisted host that the
 *   credential is not for gets no credential and is refused, so one system's
 *   key cannot be presented to another.
 *
 *   *Per-host rate limiting.* A runaway loop against one partner's API is an
 *   incident with someone else's name on it.
 *
 *   *Timeouts.* Every attempt has one. A call with no timeout is a workflow
 *   step that never ends and a run that never releases its budget.
 *
 *   *Retry with backoff and idempotency keys.* Retries are the reason a
 *   transient failure is not an outage, and idempotency keys are the reason a
 *   retry is not a second effect. Neither is safe without the other, so this
 *   client refuses to retry an unsafe method that has no idempotency key.
 *
 *   *A recorded step.* Written to the operating record *before* the call goes
 *   out. If the record cannot be written the call does not happen: an external
 *   effect the platform cannot account for is exactly what the operating
 *   record exists to prevent.
 *
 *   *Containment, re-checked between attempts.* An operator who revokes an
 *   integration mid-retry stops the retry. A switch checked only at the start
 *   would let a call with a five-attempt backoff outrun the stop button by
 *   several minutes.
 *
 * What is deliberately *not* here: the response body is returned to the caller
 * untouched and untrusted. It has crossed a trust boundary and must pass
 * `guard/screen.ts` before it reaches a model or any other instruction
 * surface. Screening here would be the wrong place — a partner's JSON
 * legitimately contains text that the injection screen scores — so the
 * obligation sits with the adapter that interprets the body.
 */

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Methods with no external effect, and therefore safe to repeat. */
const SAFE_METHODS: readonly HttpMethod[] = ["GET", "HEAD"];

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * The HTTP surface, injected.
 *
 * Everything above this line is testable with no network, and the seeded demo
 * runs with a scripted client rather than reaching the internet.
 */
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export class FetchHttpClient implements HttpClient {
  async send(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        signal: controller.signal,
        // No automatic redirect following. A 302 to an unallowlisted host
        // would walk straight past the allowlist this client exists to
        // enforce; a redirect is surfaced to the caller as a status instead.
        redirect: "manual",
      });
      return { status: response.status, body: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * An outbound call that failed.
 *
 * Deliberately not a `DeniedError`. A denial means the platform refused and
 * the effect did not happen and must not be retried; a failure means the
 * effect may or may not have happened and the caller's degradation policy
 * decides what to do about it. `degrade.ts` depends on being able to tell them
 * apart, and queueing a refusal would retry a policy decision forever.
 */
export class IntegrationCallError extends Error {
  readonly integration: string;
  readonly status?: number | undefined;
  readonly attempts: number;
  readonly retryable: boolean;

  constructor(
    integration: string,
    message: string,
    options: {
      readonly status?: number | undefined;
      readonly attempts: number;
      readonly retryable: boolean;
    },
  ) {
    super(message);
    this.name = "IntegrationCallError";
    this.integration = integration;
    this.status = options.status;
    this.attempts = options.attempts;
    this.retryable = options.retryable;
  }
}

export interface EgressRequest {
  /** Integration name. Ties the call to its containment switch. */
  readonly integration: string;
  /** The run this call belongs to. Required: no run, no recorded step, no call. */
  readonly runId: Id<"run">;
  /** Step name within the workflow, e.g. `fetch_contract`. */
  readonly stepName: string;
  readonly method: HttpMethod;
  readonly url: string;
  /** Which credential to present. Resolved per call, never held. */
  readonly credentialReference: string;
  /**
   * Deduplication key for the external effect.
   *
   * Required for anything that is not GET or HEAD. Sent as `Idempotency-Key`
   * and reused across every retry of the same logical call, so the remote
   * system can collapse them.
   */
  readonly idempotencyKey?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly correlationId?: string | undefined;
  /** Opaque references describing the target, for the recorded step. */
  readonly subject?: Readonly<Record<string, string>> | undefined;
}

export type EgressOutcome =
  | {
      readonly kind: "sent";
      readonly status: number;
      /** Untrusted. Screen it before it reaches a model. */
      readonly body: string;
      readonly attempts: number;
      readonly durationMs: number;
      readonly stepId: Id<"step">;
      readonly responseDigest: Digest;
    }
  | {
      /**
       * A step with this idempotency key already completed.
       *
       * The effect happened; this call did not repeat it. The caller must not
       * treat the absence of a body as an absence of an effect — that is the
       * whole reason this is a separate variant rather than a flag.
       */
      readonly kind: "already_performed";
      readonly stepId: Id<"step">;
      readonly idempotencyKey: string;
    };

export interface EgressOptions {
  readonly allowlist: readonly string[];
  readonly runs: RunStore;
  readonly clock: Clock;
  readonly secrets: SecretProvider;
  readonly http: HttpClient;
  readonly containment?: ContainmentController | undefined;
  readonly logger?: Logger | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly defaultMaxAttempts?: number | undefined;
  readonly requestsPerMinutePerHost?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly baseBackoffMs?: number | undefined;
  /** Injected so retries do not make the test suite wait. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Backoff jitter in [0, 1).
   *
   * Defaults to a constant, which keeps the seeded demo byte-identical. A real
   * deployment passes `randomisedJitter` so that a fleet recovering from a
   * partner outage does not retry in lockstep.
   */
  readonly jitter?: (() => number) | undefined;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  requestsPerMinutePerHost: 120,
  maxResponseBytes: 2 * 1024 * 1024,
  baseBackoffMs: 250,
} as const;

/** Full jitter, for deployments. Not the default: the demo must reproduce. */
export function randomisedJitter(): number {
  // allow-random: jitter — spreading retries across a fleet is the one place
  // unpredictability is the point. Nothing derived from this is recorded.
  return Math.random();
}

export class EgressClient {
  private readonly allowlist: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly perMinute: number;
  private readonly maxResponseBytes: number;
  private readonly baseBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  /** Sliding request-time windows, per host. */
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly options: EgressOptions) {
    this.allowlist = options.allowlist.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    this.timeoutMs = options.defaultTimeoutMs ?? DEFAULTS.timeoutMs;
    this.maxAttempts = options.defaultMaxAttempts ?? DEFAULTS.maxAttempts;
    this.perMinute = options.requestsPerMinutePerHost ?? DEFAULTS.requestsPerMinutePerHost;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.jitter = options.jitter ?? (() => 0.5);
  }

  /**
   * Make one outbound call.
   *
   * @throws {DeniedError} when a control refuses: the host is not
   *   allowlisted, the credential is missing, revoked, or out of scope, the
   *   per-host rate ceiling is reached, or the integration is contained. The
   *   call did not happen and must not be retried by the caller.
   * @throws {IntegrationCallError} when the call was permitted and failed.
   *   The caller's `DegradationPolicy` decides what happens next.
   */
  async send(request: EgressRequest): Promise<EgressOutcome> {
    const target = this.resolveTarget(request);
    const idempotencyKey = this.resolveIdempotencyKey(request, target);

    // Containment before anything is recorded or reserved.
    if (this.options.containment) {
      await this.options.containment.assertClear({ integration: request.integration });
    }

    // Duplicate suppression for effectful methods. A completed step under this
    // key means the effect already landed; repeating it is the failure mode
    // idempotency keys exist to prevent.
    if (!SAFE_METHODS.includes(request.method)) {
      const existing = await this.options.runs.findStepByIdempotencyKey(idempotencyKey);
      if (existing && existing.status === "succeeded") {
        return {
          kind: "already_performed",
          stepId: existing.id,
          idempotencyKey,
        };
      }
    }

    const requestDigest = digestValue({
      method: request.method,
      url: request.url,
      body: request.body ?? null,
    });

    // Recorded before the call. If this throws, nothing goes out — which is
    // the intended behaviour, not an inconvenience: the operating record is
    // how an effect is accounted for, and an unaccountable effect is refused.
    const step = await this.options.runs.appendStep({
      runId: request.runId,
      kind: "integration_call",
      name: request.stepName,
      idempotencyKey,
      status: "running",
      inputDigest: requestDigest,
      detail: {
        integration: request.integration,
        method: request.method,
        host: target.host,
        // Path only. A query string is where tokens, signatures, and owner
        // identifiers travel, and the operating record is not the place for
        // any of them.
        path: target.path,
        ...(request.correlationId ? { correlationId: request.correlationId } : {}),
        ...Object.fromEntries(
          Object.entries(request.subject ?? {}).map(([key, value]) => [
            `subject_${key}`,
            String(value).slice(0, 128),
          ]),
        ),
      },
    });

    const startedAt = this.options.clock.now();
    const maxAttempts = Math.max(1, request.maxAttempts ?? this.maxAttempts);
    let attempts = 0;
    let lastError: IntegrationCallError | null = null;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        attempts = attempt;

        // Re-checked every attempt so a kill switch engaged mid-backoff stops
        // the next attempt rather than being noticed after the last one.
        if (this.options.containment) {
          await this.options.containment.assertClear({ integration: request.integration });
        }

        this.assertWithinRateCeiling(target.host, request.integration);

        // Fetched every attempt, so a credential revoked between attempts is
        // not still in this client's hand.
        const headers = await this.buildHeaders(request, target, idempotencyKey);

        let response: HttpResponse;
        try {
          response = await this.options.http.send({
            method: request.method,
            url: request.url,
            headers,
            body: request.body,
            timeoutMs: request.timeoutMs ?? this.timeoutMs,
          });
        } catch (error) {
          // Transport failures — connection reset, DNS, abort on timeout — are
          // the archetypal retryable case.
          lastError = new IntegrationCallError(
            request.integration,
            `Call to ${target.host} failed: ${redactText(error instanceof Error ? error.message : String(error)).text}`,
            { attempts: attempt, retryable: true },
          );
          if (attempt < maxAttempts) {
            await this.sleep(this.backoffFor(attempt));
            continue;
          }
          throw lastError;
        }

        if (response.body.length > this.maxResponseBytes) {
          // Refused rather than truncated. A truncated body parsed as though
          // it were complete is a wrong answer that looks like a right one.
          throw new IntegrationCallError(
            request.integration,
            `${target.host} returned ${response.body.length} bytes, past the ${this.maxResponseBytes}-byte ceiling. Oversized responses are refused rather than truncated.`,
            { status: response.status, attempts: attempt, retryable: false },
          );
        }

        if (response.status >= 200 && response.status < 300) {
          const responseDigest = digestValue({ status: response.status, body: response.body });
          await this.options.runs.patchStep(step.id, {
            status: "succeeded",
            endedAt: this.options.clock.nowIso(),
            outputDigest: responseDigest,
            detail: {
              ...step.detail,
              attempts: attempt,
              status: response.status,
              bytes: response.body.length,
            },
          });
          return {
            kind: "sent",
            status: response.status,
            body: response.body,
            attempts: attempt,
            durationMs: this.options.clock.now() - startedAt,
            stepId: step.id,
            responseDigest,
          };
        }

        const retryable = isRetryableStatus(response.status);
        lastError = new IntegrationCallError(
          request.integration,
          `${target.host} returned HTTP ${response.status}.`,
          { status: response.status, attempts: attempt, retryable },
        );
        // A 4xx that is not 429 will fail identically on the next attempt.
        // Retrying it spends the partner's rate budget to be refused again.
        if (!retryable || attempt >= maxAttempts) throw lastError;
        await this.sleep(this.backoffFor(attempt));
      }

      // Unreachable: the loop either returns or throws.
      throw lastError ?? new IntegrationCallError(request.integration, "No attempt was made.", {
        attempts,
        retryable: false,
      });
    } catch (error) {
      await this.recordFailure(step, error, attempts);
      throw error;
    }
  }

  /** Validate and decompose the target URL. */
  private resolveTarget(request: EgressRequest): {
    readonly url: URL;
    readonly host: string;
    readonly path: string;
  } {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new InvalidInputError(`"${request.url}" is not a URL.`, "url");
    }

    if (url.protocol !== "https:") {
      throw new DeniedError(
        "integration.host_not_allowlisted",
        `Outbound calls must use HTTPS. "${url.protocol}//" was refused.`,
        { integration: request.integration, protocol: url.protocol },
      );
    }

    // `https://api.partner.example@evil.net/` has hostname `evil.net`. The URL
    // parser gets this right; a string comparison against the raw URL would
    // not, which is why the check is on `hostname` and userinfo is refused
    // outright rather than merely ignored.
    if (url.username.length > 0 || url.password.length > 0) {
      throw new DeniedError(
        "integration.host_not_allowlisted",
        "Outbound URLs must not embed credentials. Credentials come from the secret provider.",
        { integration: request.integration },
      );
    }

    const host = url.hostname.toLowerCase();

    if (this.allowlist.length === 0) {
      // The default posture. A deployment that has not been told where it may
      // talk cannot be talked into talking somewhere.
      throw new DeniedError(
        "integration.host_not_allowlisted",
        `The egress allowlist is empty, so every outbound call is refused. Set PV_EGRESS_ALLOWLIST to the hosts this deployment may reach.`,
        { integration: request.integration, host },
      );
    }

    if (!this.allowlist.some((entry) => hostMatches(host, entry))) {
      throw new DeniedError(
        "integration.host_not_allowlisted",
        `"${host}" is not on the egress allowlist.`,
        { integration: request.integration, host },
      );
    }

    return { url, host, path: url.pathname.slice(0, 256) };
  }

  private resolveIdempotencyKey(
    request: EgressRequest,
    target: { readonly host: string; readonly path: string },
  ): string {
    if (request.idempotencyKey && request.idempotencyKey.trim().length > 0) {
      return request.idempotencyKey;
    }
    if (!SAFE_METHODS.includes(request.method)) {
      // Refusing is the point. A retried POST with no idempotency key is how
      // one payment, one letter, or one cancellation becomes two.
      throw new InvalidInputError(
        `A ${request.method} to ${target.host} needs an idempotency key. Without one, a retry after a timeout produces a second effect.`,
        "idempotencyKey",
      );
    }
    // Safe methods get a derived key so the step is still identifiable, but
    // they are never deduplicated: repeating a read is not an effect.
    return `egress:${digestValue({
      runId: request.runId,
      step: request.stepName,
      method: request.method,
      url: request.url,
    })}`;
  }

  private async buildHeaders(
    request: EgressRequest,
    target: { readonly host: string },
    idempotencyKey: string,
  ): Promise<Record<string, string>> {
    const credential = await this.options.secrets.get(request.credentialReference);
    if (!credential) {
      throw new DeniedError(
        "integration.credential_missing",
        `No credential is available for "${request.credentialReference}". It may never have been configured, or it may have been revoked.`,
        { integration: request.integration, credentialReference: request.credentialReference },
      );
    }
    if (credential.expiresAt && credential.expiresAt <= this.options.clock.nowIso()) {
      throw new DeniedError(
        "integration.credential_missing",
        `The credential "${request.credentialReference}" expired at ${credential.expiresAt}.`,
        { integration: request.integration, credentialReference: request.credentialReference },
      );
    }
    if (!credentialPermitsHost(credential, target.host)) {
      // Scoping. A credential for the contract system must not be presented to
      // the association system, however the URL came to point there.
      throw new DeniedError(
        "integration.credential_missing",
        `The credential "${request.credentialReference}" is not scoped to "${target.host}".`,
        { integration: request.integration, host: target.host },
      );
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      // Sent on every attempt of the same logical call, including retries, so
      // the remote system can collapse duplicates it has already applied.
      "idempotency-key": idempotencyKey,
      ...Object.fromEntries(
        Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      ),
    };
    if (request.body !== undefined) headers["content-type"] = "application/json";

    switch (credential.scheme) {
      case "bearer":
        headers["authorization"] = `Bearer ${credential.value}`;
        break;
      case "basic":
        headers["authorization"] = `Basic ${credential.value}`;
        break;
      case "header":
        headers[(credential.headerName ?? "x-api-key").toLowerCase()] = credential.value;
        break;
    }
    return headers;
  }

  private assertWithinRateCeiling(host: string, integration: string): void {
    const now = this.options.clock.now();
    const cutoff = now - 60_000;
    const window = (this.windows.get(host) ?? []).filter((at) => at > cutoff);
    if (window.length >= this.perMinute) {
      // Per host rather than per integration: two integrations behind one
      // partner's gateway share that partner's rate budget.
      throw new DeniedError(
        "ceiling.rate_exceeded",
        `${window.length} calls to ${host} in the last minute, at the ${this.perMinute} ceiling.`,
        { integration, host, callsInWindow: window.length, ceiling: this.perMinute },
      );
    }
    window.push(now);
    this.windows.set(host, window);
  }

  private backoffFor(attempt: number): number {
    // Exponential, with jitter so a fleet does not retry in lockstep.
    const exponential = this.baseBackoffMs * 2 ** (attempt - 1);
    return Math.round(exponential * (1 + this.jitter()));
  }

  /**
   * Close out the recorded step after a refusal or a failure.
   *
   * Swallows its own errors deliberately: the original refusal or failure is
   * the outcome the caller must see, and replacing it with a bookkeeping error
   * would hide why the call did not succeed.
   */
  private async recordFailure(step: Step, error: unknown, attempts: number): Promise<void> {
    try {
      const denied = error instanceof DeniedError;
      await this.options.runs.patchStep(step.id, {
        status: denied ? "denied" : "failed",
        endedAt: this.options.clock.nowIso(),
        error: redactText(error instanceof Error ? error.message : String(error)).text.slice(0, 1024),
        ...(denied ? { denialReason: (error as DeniedError).reason } : {}),
        detail: { ...step.detail, attempts },
      });
    } catch (recordingError) {
      // allow-swallow: the call's own outcome is already being thrown by the
      // caller of this method, and it is the outcome that matters. A failure
      // to annotate the step must not mask a DeniedError, which would turn a
      // refusal into an unexplained error. It is logged instead.
      this.options.logger?.error("could not record the outcome of an outbound call", {
        stepId: step.id,
        error: recordingError instanceof Error ? recordingError.message : String(recordingError),
      });
    }
  }
}

/**
 * Which HTTP statuses are worth trying again.
 *
 * 429 and 5xx are the transient shapes. Everything else in 4xx is a statement
 * about the request that will not change on repetition — retrying a 403 spends
 * the partner's rate budget to be refused three times instead of once.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  if (status === 408) return true;
  return status >= 500 && status < 600;
}
