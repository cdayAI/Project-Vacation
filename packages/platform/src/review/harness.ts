import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { MemoryDb } from "../store/db.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { AuditLog } from "../audit/log.js";
import { MemoryRunStore } from "../record/store.memory.js";
import { MemoryApprovalStore, MemoryContainmentStore } from "../guard/store.memory.js";
import { ApprovalService } from "../guard/approvals.js";
import { ContainmentController } from "../guard/containment.js";
import { AdmissionService } from "../external/admission.js";
import { ConnectorRouter, InMemorySwitchboard, type Connector } from "../external/connectors.js";
import { ExecutionService } from "../external/execute.js";
import {
  MemoryEnrollmentStore,
  MemoryParkedActionStore,
  MemorySpendStore,
  MemoryUsedApprovalLedger,
} from "../external/store.memory.js";
import type { RateLimiterLike } from "../external/ratelimit-port.js";
import type { DenialClass, EnrolledAgent, ExternalAgentId, ToolGrant } from "../external/types.js";

/**
 * A governed-execution harness wired from the real adapters.
 *
 * The existing `external/execute.test.ts` builds its own fakes for the parked
 * store, the used-approval ledger and the outbound integration. That is fine
 * for the behaviours it asserts, but it means several defects cannot appear
 * there: the fake integration accepts any mode, and the fake ledger is not the
 * one the composition root wires. This harness uses `ConnectorRouter`,
 * `MemoryParkedActionStore` and `MemoryUsedApprovalLedger` — the same objects
 * `buildExternalPlane` assembles — so what the tests exercise is what ships.
 */

export const REVIEW_AGENT = "eag_review" as ExternalAgentId;
export const REVIEW_NOW = "2026-08-06T12:00:00.000Z";

/** A rate limiter that never refuses, so denials are attributable to the chain. */
export class PermissiveRateLimiter implements RateLimiterLike {
  readonly denials: DenialClass[] = [];
  async check() {
    return { allowed: true, count: 1 };
  }
  async recordDenial(_agentId: ExternalAgentId, denialClass: DenialClass) {
    this.denials.push(denialClass);
  }
}

/** Records every outbound call the router actually let through. */
export interface CallLog {
  readonly calls: { operation: string; idempotencyKey: string }[];
}

export interface ReviewHarnessOptions {
  readonly tools: readonly ToolGrant[];
  readonly connectors: readonly {
    readonly integration: string;
    readonly operations: readonly {
      readonly operation: string;
      readonly mode: "read" | "write";
      /** Awaited inside the outbound call, so a commit can be held in flight. */
      readonly gate?: () => Promise<void>;
    }[];
  }[];
  readonly ledger?: MemoryUsedApprovalLedger;
}

/** A promise a test can resolve, for holding an outbound call open. */
export function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function buildReviewHarness(options: ReviewHarnessOptions) {
  const clock = new FixedClock(REVIEW_NOW);
  const ids = new SeededIdGenerator("review");
  const db = new MemoryDb();
  const audit = new AuditLog(new MemoryAuditStore(db), clock, ids);
  const runs = new MemoryRunStore(db, clock, ids);
  const approvals = new ApprovalService(new MemoryApprovalStore(db), clock, ids, audit);
  const containment = new ContainmentController(new MemoryContainmentStore(db), clock, audit, 0);

  const agents = new MemoryEnrollmentStore(db);
  const agent: EnrolledAgent = {
    id: REVIEW_AGENT,
    name: "review-agent",
    owner: "dana",
    department: "owner services",
    hostPlatform: "customer relationship system",
    purpose: "exercise the governed execution path",
    allowedTools: options.tools,
    riskCeiling: "high_consequence",
    spendCeilingUsd: 100,
    budgetPeriod: "monthly",
    wallClockCeilingMs: 60_000,
    dataScopes: ["owner_services"],
    expiresAt: "2027-01-01T00:00:00.000Z",
    status: "active",
    enrolledBy: "admin",
    enrolledAt: REVIEW_NOW,
    updatedAt: REVIEW_NOW,
  };
  await agents.createAgent(agent);

  const log: CallLog = { calls: [] };
  const connectors: Connector[] = options.connectors.map((connector) => ({
    integration: connector.integration,
    description: `${connector.integration} for review`,
    operations: connector.operations.map((operation) => ({
      operation: operation.operation,
      mode: operation.mode,
      description: `${operation.operation} for review`,
      async perform(input: { request: Record<string, unknown>; idempotencyKey: string }) {
        log.calls.push({ operation: operation.operation, idempotencyKey: input.idempotencyKey });
        if (operation.gate) await operation.gate();
        return { ok: true, echoed: input.request };
      },
    })),
  }));

  const switchboard = new InMemorySwitchboard();
  const router = new ConnectorRouter(connectors, switchboard);

  const spend = new MemorySpendStore(db);
  const rateLimiter = new PermissiveRateLimiter();
  const parked = new MemoryParkedActionStore(db);
  const ledger = options.ledger ?? new MemoryUsedApprovalLedger(db);

  const admission = new AdmissionService(
    agents,
    spend,
    rateLimiter,
    approvals,
    audit,
    clock,
    { approvalThreshold: "high_consequence" },
    containment,
  );

  const execution = new ExecutionService(
    admission,
    parked,
    ledger,
    approvals,
    agents,
    router,
    containment,
    runs,
    rateLimiter,
    audit,
    clock,
    ids,
  );

  return {
    clock,
    ids,
    db,
    audit,
    runs,
    approvals,
    containment,
    agents,
    spend,
    rateLimiter,
    parked,
    ledger,
    router,
    switchboard,
    admission,
    execution,
    log,
  };
}

export type ReviewHarness = Awaited<ReturnType<typeof buildReviewHarness>>;

/** Park an action and have a supervisor grant it. */
export async function parkAndApprove(
  harness: ReviewHarness,
  request: Parameters<ReviewHarness["execution"]["execute"]>[0],
) {
  const outcome = await harness.execution.execute(request);
  if (outcome.kind !== "approval_required") {
    throw new Error(`expected the action to park, received ${outcome.kind}`);
  }
  await harness.approvals.decide({
    approvalId: outcome.approvalId,
    actor: { actorId: "dana", kind: "human", roles: ["supervisor"] },
    decision: "granted",
    requiresStepUp: false,
  });
  return outcome;
}
