import type { ConsoleClient, Outcome } from "../api/client";
import type { ApprovalView, Page } from "../api/contract";
import {
  approvalAwaitingDecision,
  healthyPlatform,
  runWithRefusedStep,
  session,
  workQueueItems,
} from "./fixtures";

function page<T>(items: readonly T[]): Page<T> {
  return { items, total: items.length, limit: 50, offset: 0 };
}

/**
 * A hand-written client for tests.
 *
 * Not a mocking framework and not a generated double: a small object that
 * satisfies the same interface as the real one. It costs a few lines and it
 * makes every test say plainly what the platform returned.
 */
export function createFakeClient(overrides: Partial<ConsoleClient> = {}): ConsoleClient {
  const base: ConsoleClient = {
    session: () => Promise.resolve(session),
    health: () => Promise.resolve(healthyPlatform),
    workQueue: () => Promise.resolve(page(workQueueItems)),
    approvals: () => Promise.resolve(page([approvalAwaitingDecision])),
    approval: () => Promise.resolve(approvalAwaitingDecision),
    decideApproval: (): Promise<Outcome<ApprovalView>> =>
      Promise.resolve(approvalAwaitingDecision),
    run: () => Promise.resolve(runWithRefusedStep),
  };
  return { ...base, ...overrides };
}
