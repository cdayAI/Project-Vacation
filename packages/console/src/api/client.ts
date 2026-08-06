import type {
  ApprovalView,
  AuditEntryView,
  AuditVerificationView,
  ContainmentView,
  DenialView,
  DiscoveryCandidateView,
  ExecutiveView,
  HealthView,
  ImprovementClusterView,
  ImprovementProposalView,
  OperatingMode,
  Page,
  RoleView,
  RunDetailView,
  RunStatus,
  SessionView,
  WorkflowInstanceView,
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

/**
 * The audit filter set, as a compliance officer would ask for it.
 *
 * Filtering happens on the server rather than in the browser. The record runs
 * to tens of thousands of entries, and a filter applied to whichever page
 * happened to load would quietly answer a different question from the one that
 * was asked — "no entries of that type" when the truth is "none on this page".
 */
export interface AuditQuery extends ListQuery {
  readonly eventType?: string;
  readonly actorId?: string;
  readonly runId?: string;
  /** Matched against the entry's subject references, e.g. a contract id. */
  readonly subject?: string;
  /** ISO-8601 date, inclusive. */
  readonly from?: string;
  /** ISO-8601 date, inclusive. */
  readonly to?: string;
}

/**
 * A request to engage or release a containment switch.
 *
 * `reason` is required in the type, not merely validated in a form, because
 * the reason is what the audit entry carries and what the next operator reads
 * when they find the platform stopped.
 */
export interface ContainmentChange {
  readonly scope: ContainmentView["scope"];
  /** The workflow name, role id, or integration name. Empty for `global`. */
  readonly target: string;
  readonly engaged: boolean;
  readonly reason: string;
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

  workflowInstance(
    instanceId: string,
    options?: RequestOptions,
  ): Promise<Outcome<WorkflowInstanceView>>;

  roles(query?: ListQuery, options?: RequestOptions): Promise<Outcome<Page<RoleView>>>;
  /**
   * Every version of one role, newest first.
   *
   * A role's history is a list of the same view model rather than a separate
   * "history" type: each promotion, revert, and disable produced a version
   * record, and the current role is simply the highest-numbered one. Keeping it
   * that way means the detail view and the registry read the same fields, and
   * there is no second shape to keep in step with the first.
   */
  roleVersions(roleId: string, options?: RequestOptions): Promise<Outcome<Page<RoleView>>>;

  improvementClusters(
    query?: ListQuery,
    options?: RequestOptions,
  ): Promise<Outcome<Page<ImprovementClusterView>>>;
  improvementProposals(
    query?: ListQuery,
    options?: RequestOptions,
  ): Promise<Outcome<Page<ImprovementProposalView>>>;
  improvementProposal(
    proposalId: string,
    options?: RequestOptions,
  ): Promise<Outcome<ImprovementProposalView>>;

  auditEntries(
    query?: AuditQuery,
    options?: RequestOptions,
  ): Promise<Outcome<Page<AuditEntryView>>>;
  auditVerification(options?: RequestOptions): Promise<Outcome<AuditVerificationView>>;

  containment(options?: RequestOptions): Promise<Outcome<Page<ContainmentView>>>;
  /** Engages or releases one switch. A write, and therefore never retried here. */
  setContainment(
    change: ContainmentChange,
    options?: RequestOptions,
  ): Promise<Outcome<ContainmentView>>;

  discoveryCandidates(
    query?: ListQuery,
    options?: RequestOptions,
  ): Promise<Outcome<Page<DiscoveryCandidateView>>>;

  executive(options?: RequestOptions): Promise<Outcome<ExecutiveView>>;
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

    workflowInstance: (instanceId, requestOptions) =>
      get<WorkflowInstanceView>(
        `/workflows/${encodeURIComponent(instanceId)}`,
        requestOptions,
      ),

    roles: (query = {}, requestOptions) =>
      get<Page<RoleView>>(
        `/roles${buildQuery({ limit: query.limit, offset: query.offset })}`,
        requestOptions,
      ),

    roleVersions: (roleId, requestOptions) =>
      get<Page<RoleView>>(`/roles/${encodeURIComponent(roleId)}/versions`, requestOptions),

    improvementClusters: (query = {}, requestOptions) =>
      get<Page<ImprovementClusterView>>(
        `/improvements/clusters${buildQuery({ limit: query.limit, offset: query.offset })}`,
        requestOptions,
      ),

    improvementProposals: (query = {}, requestOptions) =>
      get<Page<ImprovementProposalView>>(
        `/improvements/proposals${buildQuery({ limit: query.limit, offset: query.offset })}`,
        requestOptions,
      ),

    improvementProposal: (proposalId, requestOptions) =>
      get<ImprovementProposalView>(
        `/improvements/proposals/${encodeURIComponent(proposalId)}`,
        requestOptions,
      ),

    auditEntries: (query = {}, requestOptions) =>
      get<Page<AuditEntryView>>(
        `/audit/entries${buildQuery({
          eventType: query.eventType,
          actorId: query.actorId,
          runId: query.runId,
          subject: query.subject,
          from: query.from,
          to: query.to,
          limit: query.limit,
          offset: query.offset,
        })}`,
        requestOptions,
      ),

    auditVerification: (requestOptions) =>
      get<AuditVerificationView>("/audit/verification", requestOptions),

    containment: (requestOptions) => get<Page<ContainmentView>>("/containment", requestOptions),

    setContainment: (change, requestOptions) =>
      post<ContainmentView>(
        "/containment",
        {
          scope: change.scope,
          target: change.target,
          engaged: change.engaged,
          reason: change.reason,
        },
        change.idempotencyKey,
        requestOptions,
      ),

    discoveryCandidates: (query = {}, requestOptions) =>
      get<Page<DiscoveryCandidateView>>(
        `/discovery/candidates${buildQuery({ limit: query.limit, offset: query.offset })}`,
        requestOptions,
      ),

    executive: (requestOptions) => get<ExecutiveView>("/executive", requestOptions),
  };
}
