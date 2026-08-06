import type { ConsoleClient, Outcome } from "../api/client";
import type { ApprovalDetailView, ContainmentView, CorrectionView, Page } from "../api/contract";
import {
  approvalAwaitingDecision,
  approvalQueue,
  auditEntries,
  auditVerificationIntact,
  containmentClear,
  correctionRecorded,
  discoveryCandidates,
  executiveSnapshot,
  externalAgentDetail,
  externalAgents,
  healthyPlatform,
  improvementClusters,
  improvementProposal,
  improvementProposals,
  rescissionRoleVersions,
  roles,
  runWithRefusedStep,
  session,
  workflowInstanceStuck,
  workQueue,
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
    workQueue: () => Promise.resolve(workQueue),
    approvals: () => Promise.resolve(page(approvalQueue)),
    approval: () => Promise.resolve(approvalAwaitingDecision),
    decideApproval: (): Promise<Outcome<ApprovalDetailView>> =>
      Promise.resolve(approvalAwaitingDecision),
    run: () => Promise.resolve(runWithRefusedStep),
    correctStep: (): Promise<Outcome<CorrectionView>> => Promise.resolve(correctionRecorded),

    workflowInstance: () => Promise.resolve(workflowInstanceStuck),

    roles: () => Promise.resolve(page(roles)),
    roleVersions: () => Promise.resolve(page(rescissionRoleVersions)),

    improvementClusters: () => Promise.resolve(page(improvementClusters)),
    improvementProposals: () => Promise.resolve(page(improvementProposals)),
    improvementProposal: () => Promise.resolve(improvementProposal),

    auditEntries: () => Promise.resolve(page(auditEntries)),
    auditVerification: () => Promise.resolve(auditVerificationIntact),

    containment: () => Promise.resolve(page(containmentClear)),
    setContainment: (change): Promise<Outcome<ContainmentView>> =>
      Promise.resolve({
        scope: change.scope,
        target: change.target,
        engaged: change.engaged,
        engagedBy: session.actor.actorId,
        engagedAt: "2026-08-06T10:00:00.000Z",
        reason: change.reason,
      }),

    discoveryCandidates: () => Promise.resolve(page(discoveryCandidates)),

    externalAgents: () => Promise.resolve(page(externalAgents)),
    externalAgent: () => Promise.resolve(externalAgentDetail),

    executive: () => Promise.resolve(executiveSnapshot),
  };
  return { ...base, ...overrides };
}
