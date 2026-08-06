import type {
  ApprovalView,
  DenialView,
  HealthView,
  OperatingMode,
  Page,
  RunDetailView,
  RunStatus,
  SessionView,
  WorkQueueItem,
} from "./contract";

/**
 * The console's HTTP client.
 *
 * Two rules shape this file, and both of them come from the platform's
 * posture rather than from anything about HTTP.
 *
 * **A denial is a value, not an exception.** A response whose body carries
 * `denied: true` resolves — it does not throw — because a refused action is
 * the platform working correctly and the console's job is to render it as an
 * outcome with a reason and a next step. Only a genuine fault (a network
 * failure, a 5xx, a body that is not the shape we asked for) throws. This is
 * the console-side half of the `DeniedError` distinction described in
 * docs/architecture.md §4.1: anything that treats a refusal as breakage is a
 * bug in both halves.
 *
 * **Writes are never retried automatically.** The platform gets correctness of
 * external effects from idempotency keys checked against the operating record
 * (ADR 0007), and a client that quietly re-sends a POST on a timeout is
 * gambling that the key made it through. A visible failure the operator can
 * act on is better than a duplicate action nobody chose. Reads are not
 * retried either — the views expose a reload control, which puts the decision
 * with the person watching the screen.
 *
 * Runtime validation of response bodies is deliberately limited to the denial
 * discriminator. The console trusts the API to honour the contract in
 * api/contract.ts; the API is where inbound validation lives. That trade is
 * recorded in the handover notes rather than left implicit.
 */

/** Either the value asked for, or a refusal to produce it. */
export type Outcome<T> = T | DenialView;

export function isDenial<T>(outcome: Outcome<T>): outcome is DenialView {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    (outcome as { readonly denied?: unknown }).denied === true
  );
}

/** A fault: the request did not complete, or completed as something unusable. */
export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly detail: string;

  constructor(
    message: string,
    options: { readonly status: number; readonly url: string; readonly detail?: string },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.url = options.url;
    this.detail = options.detail ?? "";
  }
}

export interface ListQuery {
  readonly limit?: number;
  readonly offset?: number;
}

export interface WorkQueueQuery extends ListQuery {
  readonly status?: readonly RunStatus[];
  readonly mode?: readonly OperatingMode[];
}

export interface ApprovalDecision {
  readonly decision: "granted" | "rejected";
  readonly note?: string;
  /**
   * Supplied by the caller, not generated here, so that a retry the *operator*
   * chooses reuses the same key and cannot double-apply.
   */
  readonly idempotencyKey: string;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface ConsoleClient {
  session(options?: RequestOptions): Promise<Outcome<SessionView>>;
  health(options?: RequestOptions): Promise<Outcome<HealthView>>;
  workQueue(query?: WorkQueueQuery, options?: RequestOptions): Promise<Outcome<Page<WorkQueueItem>>>;
  approvals(query?: ListQuery, options?: RequestOptions): Promise<Outcome<Page<ApprovalView>>>;
  approval(approvalId: string, options?: RequestOptions): Promise<Outcome<ApprovalView>>;
  decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    options?: RequestOptions,
  ): Promise<Outcome<ApprovalView>>;
  run(runId: string, options?: RequestOptions): Promise<Outcome<RunDetailView>>;
}

export interface ClientOptions {
  /** Defaults to "/api" — the console is served from the same origin as the API. */
  readonly baseUrl?: string;
  /** Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

function buildQuery(query: Readonly<Record<string, unknown>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, String(entry));
      continue;
    }
    params.set(key, String(value));
  }
  const serialised = params.toString();
  return serialised.length > 0 ? `?${serialised}` : "";
}

export function createConsoleClient(options: ClientOptions = {}): ConsoleClient {
  const baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function send<T>(
    path: string,
    init: RequestInit,
    requestOptions?: RequestOptions,
  ): Promise<Outcome<T>> {
    const url = `${baseUrl}${path}`;

    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        // The session is a cookie. Never send it cross-origin.
        credentials: "same-origin",
        headers: { Accept: "application/json", ...(init.headers ?? {}) },
        ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
      });
    } catch (cause) {
      // A transport failure is a fault, not a refusal, and it is not retried:
      // see the note at the top of this file.
      throw new ApiError("The console could not reach the platform API.", {
        status: 0,
        url,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }

    const text = await response.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = undefined;
      }
    }

    // Checked before the status, on purpose. The API returns a denial with a
    // 4xx status, and the status alone cannot tell "you may not do this" apart
    // from "that request was malformed".
    if (isDenial(body as Outcome<T>)) return body as DenialView;

    if (!response.ok) {
      throw new ApiError(`The platform API returned ${response.status} for ${path}.`, {
        status: response.status,
        url,
        detail: text.slice(0, 500),
      });
    }

    if (body === undefined) {
      throw new ApiError("The platform API returned a response the console could not read.", {
        status: response.status,
        url,
        detail: text.slice(0, 500),
      });
    }

    return body as T;
  }

  function get<T>(path: string, requestOptions?: RequestOptions): Promise<Outcome<T>> {
    return send<T>(path, { method: "GET" }, requestOptions);
  }

  function post<T>(
    path: string,
    payload: unknown,
    idempotencyKey: string,
    requestOptions?: RequestOptions,
  ): Promise<Outcome<T>> {
    return send<T>(
      path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Bound to the operator's decision, not to this attempt, so that a
          // resubmission of the same decision is recognised as the same one.
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      },
      requestOptions,
    );
  }

  return {
    session: (requestOptions) => get<SessionView>("/session", requestOptions),
    health: (requestOptions) => get<HealthView>("/health", requestOptions),

    workQueue: (query = {}, requestOptions) =>
      get<Page<WorkQueueItem>>(
        `/work${buildQuery({
          status: query.status,
          mode: query.mode,
          limit: query.limit,
          offset: query.offset,
        })}`,
        requestOptions,
      ),

    approvals: (query = {}, requestOptions) =>
      get<Page<ApprovalView>>(
        `/approvals${buildQuery({ limit: query.limit, offset: query.offset })}`,
        requestOptions,
      ),

    approval: (approvalId, requestOptions) =>
      get<ApprovalView>(`/approvals/${encodeURIComponent(approvalId)}`, requestOptions),

    decideApproval: (approvalId, decision, requestOptions) =>
      post<ApprovalView>(
        `/approvals/${encodeURIComponent(approvalId)}/decisions`,
        { decision: decision.decision, note: decision.note },
        decision.idempotencyKey,
        requestOptions,
      ),

    run: (runId, requestOptions) =>
      get<RunDetailView>(`/runs/${encodeURIComponent(runId)}`, requestOptions),
  };
}

/**
 * Extension point for the second agent: the remaining surfaces (workflows,
 * roles, improvements, discovery, audit, executive) add their methods to
 * ConsoleClient and to the object returned above. Nothing else in this file
 * needs to change.
 */
