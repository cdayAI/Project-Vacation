import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import type { MemoryDb } from "../store/db.js";
import type { ApprovalStore, ContainmentStore } from "./port.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ContainmentScope,
  ContainmentSwitch,
} from "./types.js";

/**
 * In-memory approvals and containment switches.
 *
 * Both operations that carry a concurrency requirement take the lock, because
 * the guarantees they exist to provide are guarantees about racing callers:
 *
 *   - `recordApprovalDecision` — one approver, one decision. Read-then-write
 *     without the lock lets one person click twice and satisfy a 2-of-M
 *     requirement alone.
 *   - `consumeApproval` — one caller wins. Read-then-write without the lock
 *     lets two executions both observe `granted` and both proceed, which is a
 *     replay of a human decision that was made once.
 *
 * The contract suite runs ten concurrent callers at each of these against this
 * adapter and against Postgres, and expects exactly one to succeed.
 */

const APPROVALS = "approval";
const SWITCHES = "containment_switch";

export class MemoryApprovalStore implements ApprovalStore {
  constructor(private readonly db: MemoryDb) {}

  async createApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    assertIsoUtc("requestedAt", request.requestedAt);
    assertIsoUtc("expiresAt", request.expiresAt);
    assertOptionalIsoUtc("consumedAt", request.consumedAt);
    for (const entry of request.decisions) assertIsoUtc("decidedAt", entry.decidedAt);

    return this.db.withLock(`approval:${request.id}`, async () => {
      const table = this.db.table<ApprovalRequest>(APPROVALS);
      if (table.has(request.id)) {
        throw new InvalidInputError(
          `Approval ${request.id} already exists. Reusing an approval id would let a spent decision be presented as a fresh one.`,
          "id",
        );
      }
      table.set(request.id, structuredClone(request));
      return structuredClone(request);
    });
  }

  async getApproval(id: Id<"approval">): Promise<ApprovalRequest | null> {
    const found = this.db.table<ApprovalRequest>(APPROVALS).get(id);
    return found ? structuredClone(found) : null;
  }

  async listApprovals(
    filter: {
      readonly status?: readonly ApprovalRequest["status"][];
      readonly action?: string;
      readonly runId?: Id<"run">;
      readonly limit?: number;
    } = {},
  ): Promise<readonly ApprovalRequest[]> {
    const rows = this.db.rows<ApprovalRequest>(APPROVALS);
    const ordinals = new Map(rows.map((request, index) => [request.id, index]));
    const matched = rows.filter((request) => {
      if (filter.status && !filter.status.includes(request.status)) return false;
      if (filter.action !== undefined && request.action !== filter.action) return false;
      if (filter.runId !== undefined && request.runId !== filter.runId) return false;
      return true;
    });

    // Oldest first. This is a work queue for humans; newest-first with a limit
    // would starve the request that has been waiting longest.
    matched.sort((left, right) => {
      if (left.requestedAt !== right.requestedAt) return left.requestedAt < right.requestedAt ? -1 : 1;
      return (ordinals.get(left.id) ?? 0) - (ordinals.get(right.id) ?? 0);
    });

    const limited = filter.limit === undefined ? matched : matched.slice(0, filter.limit);
    return limited.map((request) => structuredClone(request));
  }

  async recordApprovalDecision(
    id: Id<"approval">,
    decision: ApprovalDecision,
    nextStatus: ApprovalRequest["status"],
  ): Promise<ApprovalRequest> {
    assertIsoUtc("decidedAt", decision.decidedAt);

    return this.db.withLock(`approval:${id}`, async () => {
      const table = this.db.table<ApprovalRequest>(APPROVALS);
      const current = table.get(id);
      if (!current) {
        throw new DeniedError("approval.required", `Approval ${id} does not exist.`, {
          approvalId: id,
        });
      }

      if (current.status !== "pending") {
        throw new DeniedError(
          current.status === "expired" ? "approval.expired" : "approval.already_used",
          `Approval ${id} is ${current.status} and can no longer be decided.`,
          { approvalId: id, status: current.status },
        );
      }

      if (current.decisions.some((entry) => entry.actor.actorId === decision.actor.actorId)) {
        // N-of-M means N distinct people. A second decision from someone who
        // has already decided adds no independent judgement, so it is refused
        // rather than counted.
        throw new DeniedError(
          "approval.insufficient_approvers",
          `${decision.actor.actorId} has already decided on approval ${id}. A second decision from the same person does not add an approver.`,
          { approvalId: id, actorId: decision.actor.actorId },
        );
      }

      const next: ApprovalRequest = {
        ...current,
        status: nextStatus,
        decisions: [...current.decisions, structuredClone(decision)],
      };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async consumeApproval(
    id: Id<"approval">,
    consumedAt: string,
    consumedByRunId?: Id<"run">,
  ): Promise<ApprovalRequest | null> {
    assertIsoUtc("consumedAt", consumedAt);

    return this.db.withLock(`approval:${id}`, async () => {
      const table = this.db.table<ApprovalRequest>(APPROVALS);
      const current = table.get(id);
      // Compare and set. Anything other than `granted` — already consumed,
      // still pending, rejected, expired — loses, and the caller reads the
      // null as a replay.
      if (!current || current.status !== "granted") return null;

      const next: ApprovalRequest = {
        ...current,
        status: "consumed",
        consumedAt,
        consumedByRunId,
      };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async expireApprovals(now: string): Promise<readonly ApprovalRequest[]> {
    assertIsoUtc("now", now);

    return this.db.withLock("approval:expiry", async () => {
      const table = this.db.table<ApprovalRequest>(APPROVALS);
      const expired: ApprovalRequest[] = [];
      for (const [id, request] of table) {
        // Strictly past its expiry, matching the check the approval service
        // makes before it accepts a decision. An approval is still live at the
        // instant it expires.
        if (request.status !== "pending" || !(request.expiresAt < now)) continue;
        const next: ApprovalRequest = { ...request, status: "expired" };
        table.set(id, structuredClone(next));
        expired.push(structuredClone(next));
      }
      expired.sort((left, right) =>
        left.requestedAt === right.requestedAt
          ? left.id < right.id
            ? -1
            : 1
          : left.requestedAt < right.requestedAt
            ? -1
            : 1,
      );
      return expired;
    });
  }
}

export class MemoryContainmentStore implements ContainmentStore {
  constructor(private readonly db: MemoryDb) {}

  async getSwitch(scope: ContainmentScope, target: string): Promise<ContainmentSwitch | null> {
    const found = this.db.table<ContainmentSwitch>(SWITCHES).get(switchKey(scope, target));
    return found ? structuredClone(found) : null;
  }

  async setSwitch(next: ContainmentSwitch): Promise<ContainmentSwitch> {
    assertOptionalIsoUtc("engagedAt", next.engagedAt);
    return this.db.withLock(`containment:${switchKey(next.scope, next.target)}`, async () => {
      this.db.table<ContainmentSwitch>(SWITCHES).set(
        switchKey(next.scope, next.target),
        structuredClone(next),
      );
      return structuredClone(next);
    });
  }

  async listSwitches(): Promise<readonly ContainmentSwitch[]> {
    return this.db
      .rows<ContainmentSwitch>(SWITCHES)
      .slice()
      .sort((left, right) =>
        switchKey(left.scope, left.target) < switchKey(right.scope, right.target) ? -1 : 1,
      )
      .map((entry) => structuredClone(entry));
  }
}

function switchKey(scope: ContainmentScope, target: string): string {
  return `${scope}:${target}`;
}
