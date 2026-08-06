import type { AuditEntry } from "../audit/types.js";
import { budgetPeriodKey } from "../external/enrollment.js";
import type { AgentCredential, EnrolledAgent, ExternalAgentId } from "../external/types.js";
import { STRONG_CREDENTIAL_KINDS } from "../external/types.js";
import type { Platform } from "../platform.js";

/**
 * The operator's view of the external-agent plane.
 *
 * Deliberately separate from `api/external.ts`. That file is the surface
 * external agents themselves call, authenticated with agent credentials; this
 * one is read by a human holding a console session, and the two must not share
 * a namespace or an authentication path. Putting the roster one path segment
 * away from the inbound API would be an invitation to wire the wrong middleware
 * to the wrong one.
 *
 * **No credential value ever appears here.** The roster says *which kinds* an
 * agent holds. A bearer token is shown once, at mint, and is stored as a hash;
 * there is no code path that could render one, and this file must never grow
 * one.
 */

export interface ExternalAgentRow {
  readonly agentId: string;
  readonly name: string;
  readonly owner: string;
  readonly department: string;
  readonly hostPlatform: string;
  readonly purpose: string;
  readonly status: EnrolledAgent["status"];
  readonly statusReason?: string | undefined;
  readonly statusChangedAt?: string | undefined;
  readonly statusChangedBy?: string | undefined;
  readonly riskCeiling: EnrolledAgent["riskCeiling"];
  readonly budgetPeriod: EnrolledAgent["budgetPeriod"];
  readonly periodKey: string;
  readonly spentUsd: number;
  readonly spendCeilingUsd: number;
  readonly overBudget: boolean;
  readonly allowedTools: readonly string[];
  readonly dataScopes: readonly string[];
  readonly credentialKinds: readonly AgentCredential["kind"][];
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly lastSeenAt?: string | undefined;
}

/**
 * Build one roster row.
 *
 * The spend figure is for the *current period*, not all time. A lifetime figure
 * against a monthly ceiling would show every long-lived agent as permanently
 * over budget, and a column an operator learns to ignore is worse than no
 * column.
 */
export async function rosterRow(
  platform: Platform,
  agent: EnrolledAgent,
  nowIso: string,
): Promise<ExternalAgentRow> {
  const periodKey = budgetPeriodKey(agent.budgetPeriod, nowIso);
  const [meter, credentials] = await Promise.all([
    platform.external.stores.spend.getMeter(agent.id, periodKey),
    platform.external.stores.credentials.listCredentials(agent.id),
  ]);
  const spentUsd = meter?.spentUsd ?? 0;

  return {
    agentId: agent.id,
    name: agent.name,
    owner: agent.owner,
    department: agent.department,
    hostPlatform: agent.hostPlatform,
    purpose: agent.purpose,
    status: agent.status,
    statusReason: agent.statusReason,
    statusChangedAt: agent.statusChangedAt,
    statusChangedBy: agent.statusChangedBy,
    riskCeiling: agent.riskCeiling,
    budgetPeriod: agent.budgetPeriod,
    periodKey,
    spentUsd,
    spendCeilingUsd: agent.spendCeilingUsd,
    overBudget: spentUsd >= agent.spendCeilingUsd,
    allowedTools: agent.allowedTools.map((grant) => grant.tool),
    dataScopes: [...agent.dataScopes],
    // Kinds only. Never a value, never a hash, never a secret reference.
    credentialKinds: [
      ...new Set(
        credentials
          .filter((credential) => !credential.revokedAt)
          .map((credential) => credential.kind),
      ),
    ],
    expiresAt: agent.expiresAt,
    expired: agent.expiresAt <= nowIso,
    lastSeenAt: agent.lastSeenAt,
  };
}

function credentialRow(credential: AgentCredential): {
  readonly credentialId: string;
  readonly kind: AgentCredential["kind"];
  readonly label: string;
  readonly strong: boolean;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt?: string | undefined;
  readonly revokedAt?: string | undefined;
  readonly revokedBy?: string | undefined;
  readonly revokedReason?: string | undefined;
  readonly lastUsedAt?: string | undefined;
} {
  return {
    credentialId: credential.id,
    kind: credential.kind,
    label: credential.label,
    strong: (STRONG_CREDENTIAL_KINDS as readonly string[]).includes(credential.kind),
    createdAt: credential.createdAt,
    createdBy: credential.createdBy,
    expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt,
    revokedBy: credential.revokedBy,
    revokedReason: credential.revokedReason,
    lastUsedAt: credential.lastUsedAt,
  };
}

/**
 * A denial, as it was recorded.
 *
 * `reason` stays the machine code and `message` stays what the platform said at
 * the time; neither is rewritten into plainer language here. The console does
 * that at render time, from the code, so the wording can be written for the
 * supervisor reading it without changing what the record says.
 */
function denialRow(entry: AuditEntry): {
  readonly entryId: string;
  readonly recordedAt: string;
  readonly reason: string;
  readonly message?: string | undefined;
  readonly tool?: string | undefined;
  readonly operation?: string | undefined;
  readonly runId?: string | undefined;
  readonly countedTowardContainment: boolean;
} {
  const decision = entry.decision;
  const reason = typeof decision["reason"] === "string" ? decision["reason"] : "unknown";
  const message = typeof decision["message"] === "string" ? decision["message"] : undefined;
  // Our own failures do not count. Showing which refusals were the agent's
  // fault and which were ours is the difference between "this vendor is
  // misbehaving" and "we had an outage".
  const denialClass =
    typeof decision["denialClass"] === "string" ? decision["denialClass"] : undefined;

  return {
    entryId: entry.id,
    recordedAt: entry.recordedAt,
    reason,
    message,
    tool: entry.subject["tool"],
    operation: entry.subject["operation"],
    runId: entry.runId,
    countedTowardContainment: denialClass === "misbehaviour",
  };
}

function containmentRow(entry: AuditEntry): {
  readonly at: string;
  readonly change: "contained" | "released" | "revoked";
  readonly by: string;
  readonly automatic: boolean;
  readonly reason?: string | undefined;
  readonly previousStatus?: string | undefined;
} {
  const status = entry.subject["status"] ?? entry.decision["status"];
  const change: "contained" | "released" | "revoked" =
    status === "revoked" ? "revoked" : status === "active" ? "released" : "contained";
  const by = entry.actor.actorId;

  return {
    at: entry.recordedAt,
    change,
    by,
    // A containment nobody pressed a button to cause. Worth distinguishing:
    // "the rate limiter did this at 3am" and "your colleague did this" lead an
    // operator to different next steps.
    automatic: by.startsWith("system:"),
    reason: typeof entry.decision["reason"] === "string" ? entry.decision["reason"] : undefined,
    previousStatus:
      typeof entry.decision["previousStatus"] === "string"
        ? entry.decision["previousStatus"]
        : undefined,
  };
}

export async function externalAgentDetail(
  platform: Platform,
  agentId: ExternalAgentId,
  nowIso: string,
): Promise<unknown | null> {
  const agent = await platform.external.stores.agents.getAgent(agentId);
  if (!agent) return null;

  const [row, credentials, runs, parked, meters, entries] = await Promise.all([
    rosterRow(platform, agent, nowIso),
    platform.external.stores.credentials.listCredentials(agent.id),
    platform.external.stores.runs.listExternalRuns({ agentId: agent.id, limit: 100 }),
    platform.external.stores.parked.listParkedActions({ agentId: agent.id, limit: 100 }),
    platform.external.stores.spend.listMeters(agent.id),
    // One audit log. The agent's denials and its containment history are read
    // out of the same chain that carries native work, filtered by principal —
    // not out of a second table that would have to be kept in step.
    platform.audit.list({ subject: { externalAgentId: agent.id }, limit: 200 }),
  ]);

  return {
    agent: row,
    credentials: credentials.map(credentialRow),
    runs: runs.map((run) => ({
      externalRunId: run.id,
      runId: run.runId,
      goal: run.goal,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      outcome: run.outcome,
      costUsd: run.costUsd,
    })),
    runsTotal: runs.length,
    denials: entries.filter((entry) => entry.eventType === "authorization.denied").map(denialRow),
    containmentHistory: entries
      .filter(
        (entry) =>
          entry.eventType === "containment.engaged" || entry.eventType === "containment.released",
      )
      .map(containmentRow),
    parkedActions: parked.map((action) => ({
      parkedActionId: action.id,
      integration: action.integration,
      operation: action.operation,
      status: action.status,
      createdAt: action.createdAt,
      expiresAt: action.expiresAt,
      committedAt: action.committedAt,
      resultSummary: action.resultSummary,
      approvalId: action.approvalId,
    })),
    spendMeters: meters.map((meter) => ({
      periodKey: meter.periodKey,
      spentUsd: meter.spentUsd,
      updatedAt: meter.updatedAt,
    })),
  };
}
