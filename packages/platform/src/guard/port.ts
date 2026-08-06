import type { Id } from "../kernel/ids.js";
import type { ApprovalDecision, ApprovalRequest, ContainmentScope, ContainmentSwitch } from "./types.js";

/**
 * Persistence ports for the governance controls.
 *
 * `recordApprovalDecision` and `consumeApproval` both carry concurrency
 * requirements that cannot be met by read-then-write in the caller, so they
 * are expressed as single atomic operations here and implemented as such in
 * each adapter:
 *
 *   - `recordApprovalDecision` must reject a second decision from the same
 *     actor even if two requests arrive simultaneously, otherwise one person
 *     could satisfy a 2-of-N requirement by double-clicking.
 *   - `consumeApproval` must succeed for exactly one caller. Approvals are
 *     single-use, and "single-use" enforced by a read followed by a write is
 *     a replay hole: two concurrent executions would both read `granted` and
 *     both proceed.
 */
export interface ApprovalStore {
  createApproval(request: ApprovalRequest): Promise<ApprovalRequest>;
  getApproval(id: Id<"approval">): Promise<ApprovalRequest | null>;
  listApprovals(filter?: {
    readonly status?: readonly ApprovalRequest["status"][];
    readonly action?: string;
    readonly runId?: Id<"run">;
    readonly limit?: number;
  }): Promise<readonly ApprovalRequest[]>;

  /**
   * Atomically append a decision.
   *
   * Returns the updated request. Must throw if the actor has already decided
   * on this request, or if the request is not `pending`.
   */
  recordApprovalDecision(
    id: Id<"approval">,
    decision: ApprovalDecision,
    nextStatus: ApprovalRequest["status"],
  ): Promise<ApprovalRequest>;

  /**
   * Atomically mark a granted approval as spent.
   *
   * Returns the updated request on success, or `null` if it was not in
   * `granted` state — which is how a replay is detected.
   */
  consumeApproval(
    id: Id<"approval">,
    consumedAt: string,
    consumedByRunId?: Id<"run">,
  ): Promise<ApprovalRequest | null>;

  /** Mark every pending approval past its expiry as expired. Returns those changed. */
  expireApprovals(now: string): Promise<readonly ApprovalRequest[]>;
}

export interface ContainmentStore {
  getSwitch(scope: ContainmentScope, target: string): Promise<ContainmentSwitch | null>;
  setSwitch(next: ContainmentSwitch): Promise<ContainmentSwitch>;
  listSwitches(): Promise<readonly ContainmentSwitch[]>;
}
