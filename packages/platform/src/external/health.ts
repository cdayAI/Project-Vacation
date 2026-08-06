import type { CredentialStore, EnrollmentStore, SpendStore } from "./port.js";
import { budgetPeriodKey } from "./enrollment.js";
import type { AgentCredential, EnrolledAgent } from "./types.js";

/**
 * The four things an operator needs to know about the external-agent plane
 * without having to ask for them.
 *
 * Everything else about this plane is available by going and looking — the
 * roster, a run, a parked action. These four are different: each one is a
 * condition that is invisible until somebody happens to open the right screen,
 * and each one is quietly getting worse while nobody does.
 *
 *   **Enabled with nothing enrolled.** A governance plane that is switched on
 *   and empty looks identical, on every other display, to one that is working.
 *   It is the state in which the platform reports zero external spend, zero
 *   denials, and zero contained agents — a clean bill of health for an estate
 *   it is not watching. That is the single most misleading thing this plane can
 *   do, so it is reported as a condition rather than inferred from a zero.
 *
 *   **Contained agents.** Containment is the stop button and it is deliberately
 *   easy to press. What it is not is self-clearing: a contained agent stays
 *   contained until a person decides otherwise, and a team whose agent was
 *   stopped at 2am on Saturday should not discover it on Monday from their own
 *   error logs.
 *
 *   **Over budget.** An agent at its ceiling is refused on every admission
 *   check from that moment on. From the outside that is indistinguishable from
 *   the platform being broken, and the fix — raise the ceiling, or accept that
 *   the work stops — is a decision only an operator can make.
 *
 *   **Credentials nearing expiry.** An expiring credential is the one failure
 *   here with a deadline attached, and the only one that can be prevented
 *   entirely by acting a few days early. Reported before it lands rather than
 *   after, because afterwards it is an outage rather than a task.
 *
 * Nothing in this file reads a clock or a credential value. The instant is
 * passed in, so a health payload rendered twice from the same instant is
 * identical; the credential rows carry kind, label, and expiry, and never any
 * material.
 */

/** How close to expiry a credential has to be before it is worth reporting. */
export const DEFAULT_CREDENTIAL_EXPIRY_HORIZON_DAYS = 14;

/**
 * The read-side ports these rows need.
 *
 * Narrowed to the three reads actually performed, so an operator surface that
 * asked for health cannot reach a write through the object it was handed. Both
 * members are declared as their own minimal interfaces rather than as `Pick<>`
 * of a store, because the enrollment registry and the credential registry are
 * each reachable through two objects in the composed platform — a store and a
 * service — and this file does not care which one it is given.
 */
export interface AgentRosterReader {
  listAgents(): Promise<readonly EnrolledAgent[]>;
}

export interface CredentialReader {
  listCredentials(agentId: string): Promise<readonly AgentCredential[]>;
}

export interface ExternalHealthPorts {
  readonly agents: AgentRosterReader;
  readonly spend: Pick<SpendStore, "getMeter">;
  readonly credentials: CredentialReader;
}

export interface ContainedAgentRow {
  readonly agentId: string;
  readonly name: string;
  readonly owner: string;
  readonly department: string;
  readonly hostPlatform: string;
  /** Whatever the operator wrote when they pressed stop. */
  readonly reason?: string | undefined;
  readonly since?: string | undefined;
  readonly by?: string | undefined;
}

export interface OverBudgetAgentRow {
  readonly agentId: string;
  readonly name: string;
  readonly owner: string;
  readonly department: string;
  /** `lifetime`, or `YYYY-MM` — the period the figures below belong to. */
  readonly periodKey: string;
  readonly budgetPeriod: EnrolledAgent["budgetPeriod"];
  readonly spentUsd: number;
  readonly ceilingUsd: number;
  readonly overByUsd: number;
}

export interface ExpiringCredentialRow {
  readonly credentialId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly kind: AgentCredential["kind"];
  readonly label: string;
  readonly expiresAt: string;
  /** True when the deadline has already passed. Reported, not hidden. */
  readonly expired: boolean;
}

export interface ExternalAgentHealth {
  /** False when this deployment has no external-agent plane wired at all. */
  readonly planeEnabled: boolean;
  readonly enrolledCount: number;
  readonly activeCount: number;
  /**
   * The plane is on and the registry is empty.
   *
   * Reported as its own field rather than left to be inferred from
   * `enrolledCount === 0`, because the inference is only correct if the reader
   * also knows the plane is enabled — and the whole point of this row is that
   * they do not.
   */
  readonly enabledWithNothingEnrolled: boolean;
  readonly contained: readonly ContainedAgentRow[];
  readonly overBudget: readonly OverBudgetAgentRow[];
  readonly credentialsNearingExpiry: readonly ExpiringCredentialRow[];
  readonly expiryHorizonDays: number;
}

/** What every surface reports when no external-agent plane is configured. */
export const EXTERNAL_PLANE_DISABLED: ExternalAgentHealth = Object.freeze({
  planeEnabled: false,
  enrolledCount: 0,
  activeCount: 0,
  enabledWithNothingEnrolled: false,
  contained: Object.freeze([]),
  overBudget: Object.freeze([]),
  credentialsNearingExpiry: Object.freeze([]),
  expiryHorizonDays: DEFAULT_CREDENTIAL_EXPIRY_HORIZON_DAYS,
});

export interface ExternalHealthOptions {
  readonly credentialExpiryHorizonDays?: number;
  /**
   * Largest roster this will walk.
   *
   * A bound rather than a page: the rows are a summary, and a summary that
   * stops partway through without saying so would let a contained agent sit
   * unreported behind the cut. If the registry is larger than this the counts
   * still come from the whole registry — only the detail rows are capped, and
   * the counts are what the operator is alerted by.
   */
  readonly maxAgentsInspected?: number;
}

/**
 * Compute the four operator rows.
 *
 * `nowIso` is supplied rather than read, both because the architecture forbids
 * reading the wall clock outside `kernel/clock.ts` and because the budget
 * period key is derived from it — two callers rendering the same payload from
 * the same instant must land in the same month.
 */
export async function externalAgentHealth(
  ports: ExternalHealthPorts,
  nowIso: string,
  options: ExternalHealthOptions = {},
): Promise<ExternalAgentHealth> {
  const horizonDays = options.credentialExpiryHorizonDays ?? DEFAULT_CREDENTIAL_EXPIRY_HORIZON_DAYS;
  const cap = options.maxAgentsInspected ?? 500;

  const agents = await ports.agents.listAgents();
  const enrolledCount = agents.length;
  const activeCount = agents.filter((agent) => agent.status === "active").length;

  const horizon = new Date(Date.parse(nowIso) + horizonDays * 86_400_000).toISOString();

  const contained: ContainedAgentRow[] = [];
  const overBudget: OverBudgetAgentRow[] = [];
  const credentialsNearingExpiry: ExpiringCredentialRow[] = [];

  for (const agent of agents.slice(0, cap)) {
    if (agent.status === "contained") {
      contained.push({
        agentId: agent.id,
        name: agent.name,
        owner: agent.owner,
        department: agent.department,
        hostPlatform: agent.hostPlatform,
        reason: agent.statusReason,
        since: agent.statusChangedAt,
        by: agent.statusChangedBy,
      });
    }

    // A revoked agent is finished. Reporting its budget or its credentials
    // would fill an operator's alert list with entries that need no action and
    // teach them to skim past the ones that do.
    if (agent.status === "revoked") continue;

    const periodKey = budgetPeriodKey(agent.budgetPeriod, nowIso);
    const meter = await ports.spend.getMeter(agent.id, periodKey);
    const spentUsd = meter?.spentUsd ?? 0;
    if (spentUsd >= agent.spendCeilingUsd) {
      overBudget.push({
        agentId: agent.id,
        name: agent.name,
        owner: agent.owner,
        department: agent.department,
        periodKey,
        budgetPeriod: agent.budgetPeriod,
        spentUsd,
        ceilingUsd: agent.spendCeilingUsd,
        overByUsd: Math.max(0, spentUsd - agent.spendCeilingUsd),
      });
    }

    for (const credential of await ports.credentials.listCredentials(agent.id)) {
      if (credential.revokedAt !== undefined) continue;
      // A credential with no expiry never nears one. That is its own kind of
      // problem, and not this one — reporting it here would bury the rows that
      // have a date attached under rows that never will.
      if (credential.expiresAt === undefined) continue;
      if (credential.expiresAt > horizon) continue;
      credentialsNearingExpiry.push({
        credentialId: credential.id,
        agentId: agent.id,
        agentName: agent.name,
        kind: credential.kind,
        label: credential.label,
        expiresAt: credential.expiresAt,
        expired: credential.expiresAt <= nowIso,
      });
    }
  }

  // Soonest first: this is a list of deadlines, and the one that matters is the
  // one arriving next.
  credentialsNearingExpiry.sort((left, right) =>
    left.expiresAt < right.expiresAt ? -1 : left.expiresAt > right.expiresAt ? 1 : 0,
  );
  // Furthest past its ceiling first, for the same reason.
  overBudget.sort((left, right) => right.overByUsd - left.overByUsd);

  return {
    planeEnabled: true,
    enrolledCount,
    activeCount,
    enabledWithNothingEnrolled: enrolledCount === 0,
    contained,
    overBudget,
    credentialsNearingExpiry,
    expiryHorizonDays: horizonDays,
  };
}

/**
 * The read-side ports, from the plane's stores.
 *
 * A free function rather than a method on the plane, so that every surface that
 * reports these rows — the API's health payload, the console, the command line
 * — reads them through exactly one code path and cannot drift into telling
 * three slightly different stories about the same four conditions.
 */
export function externalHealthPorts(stores: {
  readonly agents: Pick<EnrollmentStore, "listAgents">;
  readonly spend: Pick<SpendStore, "getMeter">;
  readonly credentials: Pick<CredentialStore, "listCredentials">;
}): ExternalHealthPorts {
  return {
    agents: { listAgents: () => stores.agents.listAgents() },
    spend: stores.spend,
    credentials: { listCredentials: (agentId) => stores.credentials.listCredentials(agentId) },
  };
}
