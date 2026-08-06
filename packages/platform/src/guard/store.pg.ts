import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import type { ActorRef } from "../record/types.js";
import { storeUnavailable, type Db } from "../store/db.js";
import type { ApprovalStore, ContainmentStore } from "./port.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalStatus,
  ContainmentScope,
  ContainmentSwitch,
} from "./types.js";

/**
 * Postgres approvals and containment switches.
 *
 * The two operations that matter are written as single atomic statements
 * rather than as a read followed by a write, because the properties they
 * provide are properties under concurrency:
 *
 *   `recordApprovalDecision` locks the approval row, then inserts the decision
 *   guarded by a NOT EXISTS on the same actor. The unique index over
 *   `(approval_id, actor_id)` stands behind that: even if the row lock were
 *   somehow bypassed, a second decision from the same person cannot land.
 *
 *   `consumeApproval` is `UPDATE ... WHERE status = 'granted' RETURNING *`.
 *   Postgres serialises the concurrent updates of a single row, so exactly one
 *   caller sees a row come back and every other caller gets nothing. That is
 *   the difference between an approval that is single-use and an approval that
 *   is single-use unless two workers pick it up in the same second.
 */

type ApprovalRow = {
  id: string;
  action: string;
  status: string;
  proposal_digest: string;
  summary: string;
  requested_by: ActorRef;
  requested_at: string;
  expires_at: string;
  run_id: string | null;
  correlation_id: string | null;
  subject: Record<string, string>;
  approvals_required: number;
  eligible_roles: string[];
  consumed_at: string | null;
  consumed_by_run_id: string | null;
};

type DecisionRow = {
  approval_id: string;
  actor: ActorRef;
  decision: string;
  decided_at: string;
  note: string | null;
  stepped_up: boolean;
};

type SwitchRow = {
  scope: string;
  target: string;
  engaged: boolean;
  engaged_by: string | null;
  engaged_at: string | null;
  reason: string | null;
};

const APPROVAL_COLUMNS = `id, action, status, proposal_digest, summary, requested_by,
  requested_at, expires_at, run_id, correlation_id, subject, approvals_required,
  eligible_roles, consumed_at, consumed_by_run_id`;

const DECISION_COLUMNS = `approval_id, actor, decision, decided_at, note, stepped_up`;

const SWITCH_COLUMNS = `scope, target, engaged, engaged_by, engaged_at, reason`;

export class PgApprovalStore implements ApprovalStore {
  constructor(private readonly db: Db) {}

  async createApproval(request: ApprovalRequest): Promise<ApprovalRequest> {
    assertIsoUtc("requestedAt", request.requestedAt);
    assertIsoUtc("expiresAt", request.expiresAt);
    assertOptionalIsoUtc("consumedAt", request.consumedAt);
    for (const entry of request.decisions) assertIsoUtc("decidedAt", entry.decidedAt);

    return this.guard("createApproval", () =>
      this.db.transaction(async (tx) => {
        const inserted = await tx.query<ApprovalRow>(
          `INSERT INTO approval (${APPROVAL_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (id) DO NOTHING
           RETURNING ${APPROVAL_COLUMNS}`,
          [
            request.id,
            request.action,
            request.status,
            request.proposalDigest,
            request.summary,
            request.requestedBy,
            request.requestedAt,
            request.expiresAt,
            request.runId ?? null,
            request.correlationId ?? null,
            request.subject,
            request.approvalsRequired,
            JSON.stringify([...request.eligibleRoles]),
            request.consumedAt ?? null,
            request.consumedByRunId ?? null,
          ],
        );
        if (inserted.length === 0) {
          throw new InvalidInputError(
            `Approval ${request.id} already exists. Reusing an approval id would let a spent decision be presented as a fresh one.`,
            "id",
          );
        }

        for (const entry of request.decisions) {
          await tx.query(
            `INSERT INTO approval_decision (${DECISION_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              request.id,
              entry.actor,
              entry.decision,
              entry.decidedAt,
              entry.note ?? null,
              entry.steppedUp,
            ],
          );
        }

        return this.require(tx, request.id);
      }),
    );
  }

  async getApproval(id: Id<"approval">): Promise<ApprovalRequest | null> {
    return this.guard("getApproval", async () => {
      const rows = await this.db.query<ApprovalRow>(
        `SELECT ${APPROVAL_COLUMNS} FROM approval WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      const decisions = await this.decisionsFor(this.db, [id]);
      return toApproval(row, decisions.get(id) ?? []);
    });
  }

  async listApprovals(
    filter: {
      readonly status?: readonly ApprovalStatus[];
      readonly action?: string;
      readonly runId?: Id<"run">;
      readonly limit?: number;
    } = {},
  ): Promise<readonly ApprovalRequest[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.status && filter.status.length > 0) {
      values.push([...filter.status]);
      clauses.push(`status = ANY($${values.length}::text[])`);
    }
    if (filter.action !== undefined) {
      values.push(filter.action);
      clauses.push(`action = $${values.length}`);
    }
    if (filter.runId !== undefined) {
      values.push(filter.runId);
      clauses.push(`run_id = $${values.length}`);
    }
    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page = ` LIMIT $${values.length}`;
    }

    return this.guard("listApprovals", async () => {
      // Oldest first: this is a human work queue, and newest-first with a
      // limit would starve whatever has been waiting longest.
      const rows = await this.db.query<ApprovalRow>(
        `SELECT ${APPROVAL_COLUMNS} FROM approval
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY requested_at ASC, ordinal ASC${page}`,
        values,
      );
      const decisions = await this.decisionsFor(
        this.db,
        rows.map((row) => row.id),
      );
      return rows.map((row) => toApproval(row, decisions.get(row.id) ?? []));
    });
  }

  async recordApprovalDecision(
    id: Id<"approval">,
    decision: ApprovalDecision,
    nextStatus: ApprovalStatus,
  ): Promise<ApprovalRequest> {
    assertIsoUtc("decidedAt", decision.decidedAt);

    return this.guard("recordApprovalDecision", () =>
      this.db.transaction(async (tx) => {
        const current = (
          await tx.query<ApprovalRow>(
            `SELECT ${APPROVAL_COLUMNS} FROM approval WHERE id = $1 FOR UPDATE`,
            [id],
          )
        )[0];
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

        // Guarded insert. The unique index over (approval_id, actor_id) is the
        // real enforcement; the NOT EXISTS is here so the refusal arrives as a
        // denial an operator can read rather than a constraint violation.
        const inserted = await tx.query<{ approval_id: string }>(
          `INSERT INTO approval_decision (${DECISION_COLUMNS})
           SELECT $1::text, $2::jsonb, $3::text, $4::text, $5::text, $6::boolean
           WHERE NOT EXISTS (
             SELECT 1 FROM approval_decision WHERE approval_id = $1 AND actor_id = $7
           )
           RETURNING approval_id`,
          [
            id,
            decision.actor,
            decision.decision,
            decision.decidedAt,
            decision.note ?? null,
            decision.steppedUp,
            decision.actor.actorId,
          ],
        );
        if (inserted.length === 0) {
          throw new DeniedError(
            "approval.insufficient_approvers",
            `${decision.actor.actorId} has already decided on approval ${id}. A second decision from the same person does not add an approver.`,
            { approvalId: id, actorId: decision.actor.actorId },
          );
        }

        await tx.query("UPDATE approval SET status = $2 WHERE id = $1", [id, nextStatus]);
        return this.require(tx, id);
      }),
    );
  }

  async consumeApproval(
    id: Id<"approval">,
    consumedAt: string,
    consumedByRunId?: Id<"run">,
  ): Promise<ApprovalRequest | null> {
    assertIsoUtc("consumedAt", consumedAt);

    return this.guard("consumeApproval", () =>
      this.db.transaction(async (tx) => {
        // The compare-and-set. Postgres serialises concurrent updates of one
        // row, so of N callers holding the same approval id exactly one finds
        // it in `granted` and the rest match nothing.
        const rows = await tx.query<ApprovalRow>(
          `UPDATE approval
           SET status = 'consumed', consumed_at = $2, consumed_by_run_id = $3
           WHERE id = $1 AND status = 'granted'
           RETURNING ${APPROVAL_COLUMNS}`,
          [id, consumedAt, consumedByRunId ?? null],
        );
        const row = rows[0];
        if (!row) return null;
        const decisions = await this.decisionsFor(tx, [id]);
        return toApproval(row, decisions.get(id) ?? []);
      }),
    );
  }

  async expireApprovals(now: string): Promise<readonly ApprovalRequest[]> {
    assertIsoUtc("now", now);

    return this.guard("expireApprovals", () =>
      this.db.transaction(async (tx) => {
        // Strictly past its expiry, matching the check the approval service
        // makes before accepting a decision: an approval is still live at the
        // instant it expires.
        const rows = await tx.query<ApprovalRow>(
          `UPDATE approval SET status = 'expired'
           WHERE status = 'pending' AND expires_at < $1
           RETURNING ${APPROVAL_COLUMNS}`,
          [now],
        );
        if (rows.length === 0) return [];
        const decisions = await this.decisionsFor(
          tx,
          rows.map((row) => row.id),
        );
        return rows
          .map((row) => toApproval(row, decisions.get(row.id) ?? []))
          .sort((left, right) =>
            left.requestedAt === right.requestedAt
              ? left.id < right.id
                ? -1
                : 1
              : left.requestedAt < right.requestedAt
                ? -1
                : 1,
          );
      }),
    );
  }

  private async require(db: Db, id: string): Promise<ApprovalRequest> {
    const rows = await db.query<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM approval WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new DeniedError("approval.required", `Approval ${id} does not exist.`, {
        approvalId: id,
      });
    }
    const decisions = await this.decisionsFor(db, [id]);
    return toApproval(row, decisions.get(id) ?? []);
  }

  private async decisionsFor(
    db: Db,
    ids: readonly string[],
  ): Promise<Map<string, ApprovalDecision[]>> {
    const out = new Map<string, ApprovalDecision[]>();
    if (ids.length === 0) return out;
    const rows = await db.query<DecisionRow>(
      `SELECT ${DECISION_COLUMNS} FROM approval_decision
       WHERE approval_id = ANY($1::text[]) ORDER BY ordinal ASC`,
      [[...ids]],
    );
    for (const row of rows) {
      const list = out.get(row.approval_id) ?? [];
      list.push({
        actor: row.actor,
        decision: row.decision as ApprovalDecision["decision"],
        decidedAt: row.decided_at,
        note: row.note ?? undefined,
        steppedUp: row.stepped_up,
      });
      out.set(row.approval_id, list);
    }
    return out;
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

export class PgContainmentStore implements ContainmentStore {
  constructor(private readonly db: Db) {}

  async getSwitch(scope: ContainmentScope, target: string): Promise<ContainmentSwitch | null> {
    const rows = await this.guard("getSwitch", () =>
      this.db.query<SwitchRow>(
        `SELECT ${SWITCH_COLUMNS} FROM containment_switch WHERE scope = $1 AND target = $2`,
        [scope, target],
      ),
    );
    const row = rows[0];
    return row ? toSwitch(row) : null;
  }

  async setSwitch(next: ContainmentSwitch): Promise<ContainmentSwitch> {
    assertOptionalIsoUtc("engagedAt", next.engagedAt);
    const rows = await this.guard("setSwitch", () =>
      this.db.query<SwitchRow>(
        `INSERT INTO containment_switch (${SWITCH_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (scope, target) DO UPDATE
           SET engaged = EXCLUDED.engaged,
               engaged_by = EXCLUDED.engaged_by,
               engaged_at = EXCLUDED.engaged_at,
               reason = EXCLUDED.reason
         RETURNING ${SWITCH_COLUMNS}`,
        [
          next.scope,
          next.target,
          next.engaged,
          next.engagedBy ?? null,
          next.engagedAt ?? null,
          next.reason ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new DeniedError(
        "containment.global_pause",
        `Containment switch ${next.scope}:${next.target} could not be written, so it must be treated as unknown.`,
        { scope: next.scope, target: next.target },
      );
    }
    return toSwitch(row);
  }

  async listSwitches(): Promise<readonly ContainmentSwitch[]> {
    const rows = await this.guard("listSwitches", () =>
      this.db.query<SwitchRow>(
        `SELECT ${SWITCH_COLUMNS} FROM containment_switch ORDER BY scope ASC, target ASC`,
      ),
    );
    return rows.map(toSwitch);
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

function toApproval(row: ApprovalRow, decisions: readonly ApprovalDecision[]): ApprovalRequest {
  return {
    id: row.id as Id<"approval">,
    action: row.action,
    status: row.status as ApprovalStatus,
    proposalDigest: row.proposal_digest as Digest,
    summary: row.summary,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    runId: row.run_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    subject: row.subject,
    approvalsRequired: row.approvals_required,
    eligibleRoles: row.eligible_roles,
    decisions: [...decisions],
    consumedAt: row.consumed_at ?? undefined,
    consumedByRunId: row.consumed_by_run_id ?? undefined,
  };
}

function toSwitch(row: SwitchRow): ContainmentSwitch {
  return {
    scope: row.scope as ContainmentScope,
    target: row.target,
    engaged: row.engaged,
    engagedBy: row.engaged_by ?? undefined,
    engagedAt: row.engaged_at ?? undefined,
    reason: row.reason ?? undefined,
  };
}
