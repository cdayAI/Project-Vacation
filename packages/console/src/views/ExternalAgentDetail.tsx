import { useClient } from "../api/ClientProvider";
import type {
  ExternalAgentDenialView,
  ExternalAgentDetailView,
  ExternalAgentRunView,
  ExternalContainmentEventView,
  ExternalCredentialView,
  ExternalParkedActionView,
  ExternalRunStatus,
} from "../api/contract";
import { useResource } from "../api/useResource";
import {
  Badge,
  Callout,
  DataTable,
  DefinitionList,
  EmptyState,
  RiskPill,
  type Column,
  type DefinitionItem,
} from "../components";
import { NOT_RECORDED, formatDateTime, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import { agentState, credentialKindLabel } from "./ExternalAgents";

/**
 * One external agent, in full.
 *
 * This is the screen somebody opens when a vendor says "our agent has stopped
 * working" or when a supervisor is asked what an agent has been doing. It has
 * to answer both questions from the record: what it ran, what that cost, what
 * it was refused and why, and every time it has been stopped or let go again.
 *
 * The refusals table is the reason this screen exists, and the reason it is
 * written the way it is. A denial arrives as a code — `role.ceiling_exceeded`,
 * `authorization.data_scope_violation` — which is exactly right for a log and
 * useless to the supervisor who has to decide whether a team is misbehaving or
 * whether somebody set a ceiling too low. So every code is rendered as a
 * sentence about what happened and what it means, with the code kept beside it
 * for the engineer who will be asked next. Where a code has no written
 * explanation the console says so plainly rather than inventing one: a
 * confident-sounding gloss on a refusal nobody has worded is worse than the raw
 * code, because it will be believed.
 *
 * Denials the platform caused are separated from denials the agent caused.
 * Only misbehaviour counts toward automatic containment — our own store being
 * briefly unreachable does not — and a table that mixed the two would read as a
 * vendor with a compliance problem when the truth was an outage on our side.
 */

interface DenialPresentation {
  readonly title: string;
  readonly explanation: string;
}

/**
 * Refusal codes, written for a supervisor.
 *
 * Each says what the platform did and what a person might do about it. Kept in
 * the console rather than on the wire so the wording can be improved without
 * changing what the audit record says — the record holds the code and the
 * message the platform produced at the time, and neither is rewritten here.
 */
const DENIAL_PRESENTATION: Readonly<Record<string, DenialPresentation>> = {
  "authorization.action_not_permitted": {
    title: "It asked to use a tool it was not granted",
    explanation:
      "The agent asked for something outside the tool list it was enrolled with. Either it has been changed since it was enrolled, or the grant is too narrow for what it is now being asked to do. Both are conversations with its owner.",
  },
  "authorization.data_scope_violation": {
    title: "It asked for data it is not entitled to",
    explanation:
      "The agent asked to reach records outside the data scopes on its enrollment. Nothing was returned. Widening a scope is a re-enrollment and a deliberate decision about what this vendor may see.",
  },
  "authorization.step_up_required": {
    title: "A person had not re-authenticated recently enough",
    explanation:
      "This action needs a human who has proved who they are within the last few minutes. Nobody had.",
  },
  "role.ceiling_exceeded": {
    title: "The action was riskier than this agent is allowed to be",
    explanation:
      "The tool is rated above the agent's risk ceiling. Note that the operator's rating of a tool overrides whatever the agent declared — an agent calling a refund tool may describe it as routine, and the registry decides.",
  },
  "ceiling.spend_exceeded": {
    title: "It had reached its spend ceiling",
    explanation:
      "The agent has spent its budget for the current period. It will be refused until the period rolls over or its owner raises the ceiling. Nothing clears a spend meter.",
  },
  "ceiling.rate_exceeded": {
    title: "It was asking too often",
    explanation:
      "The agent exceeded the request rate it is allowed. Usually a retry loop on the vendor's side; occasionally a sign that something has gone wrong there.",
  },
  "containment.role_disabled": {
    title: "It was contained at the time",
    explanation:
      "Somebody had stopped this agent, or the platform stopped it automatically after repeated refusals. Everything it asked for while contained was refused.",
  },
  "containment.global_pause": {
    title: "The whole platform was stopped",
    explanation:
      "A global containment switch was engaged, so no work of any kind was proceeding. This refusal is not about the agent.",
  },
  "screen.injection_detected": {
    title: "The text it sent looked like an instruction to this platform",
    explanation:
      "Text arriving from outside is screened before anything reads it. This one contained something shaped like an instruction rather than content. Worth looking at: it may be a customer pasting something odd, and it may not.",
  },
  "screen.unavailable": {
    title: "This platform could not screen the text, so it refused",
    explanation:
      "Our own screening could not answer, and a screen that cannot answer has not answered \"clean\". This is our failure, not the agent's, and it does not count against it.",
  },
  "approval.required": {
    title: "It needed a person to approve and none had",
    explanation:
      "The action was above the threshold at which a human decides. An approval was parked for someone to read.",
  },
  "approval.expired": {
    title: "The approval it was holding had run out",
    explanation:
      "A person approved this, and the agent did not act within the window. Approvals are time-bound so that a decision made about today's circumstances is not spent next month.",
  },
  "approval.already_used": {
    title: "It tried to spend an approval twice",
    explanation:
      "Approvals are single-use. Either the agent retried after succeeding, or it is replaying a request. The first is common and harmless; the second is not.",
  },
  "approval.digest_mismatch": {
    title: "What it tried to do was not what was approved",
    explanation:
      "An approval is bound to a fingerprint of the exact request. This one did not match, so the action was refused rather than performed in a form nobody agreed to.",
  },
  "integration.credential_missing": {
    title: "It could not be authenticated",
    explanation:
      "The credential it presented could not be verified — revoked, expired, or not one this platform holds. The agent's owner needs a new one minted.",
  },
  "record.unavailable": {
    title: "This platform could not record what was happening",
    explanation:
      "Work that cannot be written down does not happen here. This is our failure, not the agent's, and it does not count against it.",
  },
  "config.missing": {
    title: "This platform was not configured to do it",
    explanation:
      "Something the action needed is not set up in this deployment. Ours to fix.",
  },
};

export function denialPresentation(reason: string): DenialPresentation {
  const known = DENIAL_PRESENTATION[reason];
  if (known !== undefined) return known;
  // Deliberately not a guess. A plausible-sounding explanation for a code
  // nobody has worded will be believed and repeated, and this screen is read by
  // people deciding whether a vendor is behaving.
  return {
    title: "Refused",
    explanation:
      "No plain-language explanation has been written for this refusal code yet. The code and the message the platform produced at the time are shown beside it.",
  };
}

const RUN_STATE: Readonly<
  Record<ExternalRunStatus, { readonly label: string; readonly tone: "neutral" | "success" | "warning" | "danger" | "info"; readonly glyph: string }>
> = {
  running: { label: "Running now", tone: "info", glyph: "◐" },
  finished: { label: "Finished", tone: "success", glyph: "✓" },
  failed: { label: "Failed", tone: "danger", glyph: "✕" },
  stopped: { label: "Stopped by this platform", tone: "warning", glyph: "⊘" },
  reclaimed: { label: "Stopped answering", tone: "warning", glyph: "▲" },
};

export interface ExternalAgentDetailProps {
  readonly detail: ExternalAgentDetailView;
}

export function ExternalAgentDetail({ detail }: ExternalAgentDetailProps) {
  const { agent } = detail;
  const state = agentState(agent);

  const liveCredentials = detail.credentials.filter(
    (credential) => credential.revokedAt === undefined,
  );
  const agentDenials = detail.denials.filter((denial) => denial.countedTowardContainment);
  const platformDenials = detail.denials.filter((denial) => !denial.countedTowardContainment);
  const indeterminate = detail.parkedActions.filter((action) => action.status === "indeterminate");
  const sampledCost = detail.runs.reduce((sum, run) => sum + run.costUsd, 0);
  const currentMeter = detail.spendMeters.find((meter) => meter.periodKey === agent.periodKey);

  const definitionItems: DefinitionItem[] = [
    { term: "Identifier", description: <span className="pv-mono">{agent.agentId}</span> },
    { term: "What it is for", description: agent.purpose },
    {
      term: "Runs on",
      description: (
        <span>
          <span className="pv-mono">{agent.hostPlatform}</span> — this platform governs it and can
          stop it; it does not run it
        </span>
      ),
    },
    {
      term: "Accountable owner",
      description: (
        <span>
          {agent.owner} — {agent.department}
        </span>
      ),
    },
    { term: "Risk ceiling", description: <RiskPill risk={agent.riskCeiling} /> },
    {
      term: "Enrollment expires",
      description: (
        <span className="pv-stack-tight">
          <time dateTime={agent.expiresAt}>{formatDateTime(agent.expiresAt)}</time>
          {agent.expired && (
            <Badge tone="warning" glyph="▲">
              Expired — everything it asks for is refused
            </Badge>
          )}
        </span>
      ),
    },
    {
      term: "Last heard from",
      description:
        agent.lastSeenAt === undefined ? (
          <span className="pv-meta">Never. This agent has not contacted the platform.</span>
        ) : (
          <time dateTime={agent.lastSeenAt}>{formatDateTime(agent.lastSeenAt)}</time>
        ),
    },
  ];

  const credentialColumns: readonly Column<ExternalCredentialView>[] = [
    {
      key: "label",
      header: "Credential",
      rowHeader: true,
      sortValue: (credential) => credential.label,
      render: (credential) => (
        <span className="pv-stack-tight">
          <span>{credential.label}</span>
          <span className="pv-meta pv-mono">{credential.credentialId}</span>
        </span>
      ),
    },
    {
      key: "kind",
      header: "How it authenticates",
      sortValue: (credential) => credential.kind,
      render: (credential) => (
        <span className="pv-stack-tight">
          <span>{credentialKindLabel(credential.kind)}</span>
          {credential.strong ? (
            <Badge tone="success" glyph="✓">
              Proves possession of a key
            </Badge>
          ) : (
            <Badge tone="warning" glyph="▲">
              Proves possession of a string
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      sortValue: (credential) => (credential.revokedAt === undefined ? 1 : 0),
      render: (credential) =>
        credential.revokedAt === undefined ? (
          <Badge tone="success" glyph="✓">
            Live
          </Badge>
        ) : (
          <span className="pv-stack-tight">
            <Badge tone="neutral" glyph="⊘">
              Revoked
            </Badge>
            {credential.revokedReason !== undefined && (
              <span className="pv-meta">{credential.revokedReason}</span>
            )}
          </span>
        ),
    },
    {
      key: "expiresAt",
      header: "Expires",
      sortValue: (credential) => credential.expiresAt ?? "￿",
      render: (credential) =>
        credential.expiresAt === undefined ? (
          <span className="pv-meta">No expiry set</span>
        ) : (
          <time dateTime={credential.expiresAt}>{formatDateTime(credential.expiresAt)}</time>
        ),
    },
    {
      key: "lastUsedAt",
      header: "Last used",
      sortValue: (credential) => credential.lastUsedAt ?? "",
      render: (credential) =>
        credential.lastUsedAt === undefined ? (
          <span className="pv-meta">Never used</span>
        ) : (
          <time dateTime={credential.lastUsedAt}>{formatDateTime(credential.lastUsedAt)}</time>
        ),
    },
  ];

  const runColumns: readonly Column<ExternalAgentRunView>[] = [
    {
      key: "goal",
      header: "What it was doing",
      rowHeader: true,
      sortValue: (run) => run.goal,
      render: (run) => (
        <span className="pv-stack-tight">
          <span>{run.goal}</span>
          <Link to={`/runs/${run.runId}`}>Open the run record</Link>
        </span>
      ),
    },
    {
      key: "status",
      header: "How it ended",
      sortValue: (run) => RUN_STATE[run.status].label,
      render: (run) => {
        const presentation = RUN_STATE[run.status];
        return (
          <span className="pv-stack-tight">
            <Badge tone={presentation.tone} glyph={presentation.glyph}>
              {presentation.label}
            </Badge>
            {run.status === "reclaimed" && (
              <span className="pv-meta">
                Nobody heard from it, which is not the same as it having failed.
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "outcome",
      header: "Outcome recorded",
      sortValue: (run) => run.outcome ?? "",
      render: (run) =>
        run.outcome === undefined ? (
          <span className="pv-meta">{NOT_RECORDED}</span>
        ) : (
          <span>{run.outcome}</span>
        ),
    },
    {
      key: "startedAt",
      header: "Started",
      sortValue: (run) => run.startedAt,
      render: (run) => <time dateTime={run.startedAt}>{formatDateTime(run.startedAt)}</time>,
    },
    {
      key: "costUsd",
      header: "Cost",
      numeric: true,
      sortValue: (run) => run.costUsd,
      render: (run) => <span>{formatUsd(run.costUsd)}</span>,
    },
  ];

  const denialColumns: readonly Column<ExternalAgentDenialView>[] = [
    {
      key: "reason",
      header: "What was refused, and why",
      rowHeader: true,
      sortValue: (denial) => denialPresentation(denial.reason).title,
      render: (denial) => {
        const presentation = denialPresentation(denial.reason);
        return (
          <span className="pv-stack-tight">
            <span>{presentation.title}</span>
            <span>{presentation.explanation}</span>
            <span className="pv-meta pv-mono">{denial.reason}</span>
          </span>
        );
      },
    },
    {
      key: "tool",
      header: "Tool",
      sortValue: (denial) => denial.tool ?? "",
      render: (denial) =>
        denial.tool === undefined ? (
          <span className="pv-meta">Not a tool call</span>
        ) : (
          <span className="pv-mono">{denial.tool}</span>
        ),
    },
    {
      key: "message",
      header: "What the platform said at the time",
      sortValue: (denial) => denial.message ?? "",
      render: (denial) =>
        denial.message === undefined ? (
          <span className="pv-meta">{NOT_RECORDED}</span>
        ) : (
          <span className="pv-meta">{denial.message}</span>
        ),
    },
    {
      key: "recordedAt",
      header: "When",
      sortValue: (denial) => denial.recordedAt,
      render: (denial) => (
        <time dateTime={denial.recordedAt}>{formatDateTime(denial.recordedAt)}</time>
      ),
    },
  ];

  const containmentColumns: readonly Column<ExternalContainmentEventView>[] = [
    {
      key: "change",
      header: "What happened",
      rowHeader: true,
      sortValue: (event) => event.change,
      render: (event) => (
        <span className="pv-stack-tight">
          <Badge
            tone={event.change === "released" ? "success" : "danger"}
            glyph={event.change === "released" ? "✓" : "⊘"}
          >
            {event.change === "contained"
              ? "Stopped"
              : event.change === "released"
                ? "Allowed to run again"
                : "Enrollment ended"}
          </Badge>
          {event.change === "revoked" && (
            <span className="pv-meta">
              Terminal. This agent never acts again; bringing it back is a fresh enrollment.
            </span>
          )}
        </span>
      ),
    },
    {
      key: "by",
      header: "Decided by",
      sortValue: (event) => event.by,
      render: (event) => (
        <span className="pv-stack-tight">
          <span className="pv-mono">{event.by}</span>
          {event.automatic ? (
            <Badge tone="warning" glyph="▲">
              Automatic, after repeated refusals
            </Badge>
          ) : (
            <span className="pv-meta">A person decided this</span>
          )}
        </span>
      ),
    },
    {
      key: "reason",
      header: "Reason given",
      sortValue: (event) => event.reason ?? "",
      render: (event) =>
        event.reason === undefined ? (
          <span className="pv-meta">No reason recorded</span>
        ) : (
          <span>{event.reason}</span>
        ),
    },
    {
      key: "at",
      header: "When",
      sortValue: (event) => event.at,
      render: (event) => <time dateTime={event.at}>{formatDateTime(event.at)}</time>,
    },
  ];

  const parkedColumns: readonly Column<ExternalParkedActionView>[] = [
    {
      key: "operation",
      header: "Action it asked us to take",
      rowHeader: true,
      sortValue: (action) => `${action.integration}.${action.operation}`,
      render: (action) => (
        <span className="pv-stack-tight">
          <span className="pv-mono">
            {action.integration}.{action.operation}
          </span>
          <span className="pv-meta pv-mono">{action.parkedActionId}</span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Where it got to",
      sortValue: (action) => action.status,
      render: (action) =>
        action.status === "indeterminate" ? (
          <span className="pv-stack-tight">
            <Badge tone="danger" glyph="▲">
              Indeterminate — somebody has to go and look
            </Badge>
            <span className="pv-meta">
              The worker stopped between starting this and recording it. It may or may not have
              landed, and only the other system knows.
            </span>
          </span>
        ) : (
          <Badge tone={action.status === "committed" ? "success" : "neutral"}>
            {action.status}
          </Badge>
        ),
    },
    {
      key: "createdAt",
      header: "Parked",
      sortValue: (action) => action.createdAt,
      render: (action) => (
        <time dateTime={action.createdAt}>{formatDateTime(action.createdAt)}</time>
      ),
    },
    {
      key: "expiresAt",
      header: "Expires",
      sortValue: (action) => action.expiresAt,
      render: (action) => (
        <time dateTime={action.expiresAt}>{formatDateTime(action.expiresAt)}</time>
      ),
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <p className="pv-meta">
          <Link to="/external-agents">External agents</Link>
        </p>
        <h1>{agent.name}</h1>
        <p className="pv-page-lede pv-mono">
          {agent.agentId} · runs on {agent.hostPlatform}
        </p>
      </div>

      {agent.status === "contained" && (
        <Callout tone="danger" title="This agent is contained and is being refused everything">
          <p>
            {agent.statusReason ?? "No reason was recorded."}
            {agent.statusChangedBy !== undefined ? ` Stopped by ${agent.statusChangedBy}` : ""}
            {agent.statusChangedAt !== undefined
              ? ` on ${formatDateTime(agent.statusChangedAt)}.`
              : "."}
          </p>
          <p>
            It is refused at every admission check and told to stop the next time it asks this
            platform for anything. That heartbeat is the only way containment reaches an agent
            running on somebody else&rsquo;s system — nothing here can interrupt its process.
          </p>
        </Callout>
      )}

      {agent.status === "revoked" && (
        <Callout tone="denied" title="This enrollment has been ended permanently">
          <p>
            {agent.statusReason ?? "No reason was recorded."} Revocation is terminal: this agent
            never acts again, and its seat has returned to the deployment&rsquo;s cap. Bringing it
            back is a fresh enrollment, which is another approved decision.
          </p>
        </Callout>
      )}

      {agent.overBudget && (
        <Callout tone="danger" title="This agent has reached its spend ceiling">
          <p>
            It has spent {formatUsd(agent.spentUsd)} of {formatUsd(agent.spendCeilingUsd)} for{" "}
            {agent.budgetPeriod === "lifetime"
              ? "its lifetime budget"
              : `period ${agent.periodKey}`}
            , so it is refused on spend until the period rolls over or its owner raises the
            ceiling. There is no operation anywhere in this platform that clears a spend meter.
          </p>
        </Callout>
      )}

      {indeterminate.length > 0 && (
        <Callout
          tone="danger"
          title={`${pluralise(indeterminate.length, "action", "actions")} may or may not have happened`}
        >
          <p>
            A worker stopped between starting an action this agent asked for and recording the
            result. Nothing retries it automatically, because a retry might duplicate a real
            effect. Somebody has to look in the other system and reconcile it by hand.
          </p>
        </Callout>
      )}

      {liveCredentials.length === 0 && agent.status !== "revoked" && (
        <Callout tone="warning" title="This agent holds no live credential">
          <p>
            It cannot authenticate, so it is doing nothing whatever else this page says. That is
            normal immediately after enrollment and worth a question at any other time.
          </p>
        </Callout>
      )}

      <section className="pv-panel" aria-labelledby="agent-definition">
        <h2 className="pv-panel-heading" id="agent-definition">
          What this agent is
        </h2>
        <p className="pv-meta">
          Current state: <strong>{state === "active" ? "running" : state}</strong>.
        </p>
        <DefinitionList items={definitionItems} />
      </section>

      <section className="pv-panel" aria-labelledby="agent-authority">
        <h2 className="pv-panel-heading" id="agent-authority">
          What it is permitted to do
        </h2>

        <h3>Tools it may call</h3>
        <p className="pv-meta">
          Anything not listed is refused. The operator&rsquo;s risk rating for a tool overrides
          whatever the agent declares, so a tool an agent calls &ldquo;routine&rdquo; is treated as
          whatever this platform rated it.
        </p>
        {agent.allowedTools.length === 0 ? (
          <p>No tool is granted. This agent can call nothing at all.</p>
        ) : (
          <ul className="pv-token-list">
            {agent.allowedTools.map((tool) => (
              <li className="pv-token" key={tool}>
                <span className="pv-mono">{tool}</span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="pv-space-above-wide">Data it may reach</h3>
        {agent.dataScopes.length === 0 ? (
          <p>No data scope is granted. This agent can reach no records.</p>
        ) : (
          <ul className="pv-token-list">
            {agent.dataScopes.map((scope) => (
              <li className="pv-token" key={scope}>
                <span className="pv-mono">{scope}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pv-panel" aria-labelledby="agent-spend">
        <h2 className="pv-panel-heading" id="agent-spend">
          What it has cost
        </h2>
        <DefinitionList
          items={[
            {
              term: "Current period",
              description: (
                <span>
                  {formatUsd(currentMeter?.spentUsd ?? agent.spentUsd)} of{" "}
                  {formatUsd(agent.spendCeilingUsd)}{" "}
                  {agent.budgetPeriod === "lifetime"
                    ? "(lifetime budget)"
                    : `(period ${agent.periodKey})`}
                </span>
              ),
            },
            {
              term: "Across the runs shown below",
              description: `${formatUsd(sampledCost)} over ${pluralise(detail.runs.length, "run", "runs")}`,
            },
            {
              term: "Runs on the record",
              description: `${detail.runsTotal} in total. External work is recorded in the same place as everything else, so it appears in the ordinary cost report too.`,
            },
          ]}
        />
        {detail.spendMeters.length > 1 && (
          <DataTable
            caption={`Spend by budget period for ${agent.name}, ${pluralise(detail.spendMeters.length, "period", "periods")}.`}
            columns={[
              {
                key: "periodKey",
                header: "Period",
                rowHeader: true,
                sortValue: (meter) => meter.periodKey,
                render: (meter) => <span className="pv-mono">{meter.periodKey}</span>,
              },
              {
                key: "spentUsd",
                header: "Spent",
                numeric: true,
                sortValue: (meter) => meter.spentUsd,
                render: (meter) => <span>{formatUsd(meter.spentUsd)}</span>,
              },
              {
                key: "updatedAt",
                header: "Last movement",
                sortValue: (meter) => meter.updatedAt,
                render: (meter) => (
                  <time dateTime={meter.updatedAt}>{formatDateTime(meter.updatedAt)}</time>
                ),
              },
            ]}
            rows={detail.spendMeters}
            rowKey={(meter) => meter.periodKey}
            defaultSort={{ columnKey: "periodKey", direction: "descending" }}
          />
        )}
      </section>

      <section className="pv-panel" aria-labelledby="agent-credentials">
        <h2 className="pv-panel-heading" id="agent-credentials">
          Credentials it holds
        </h2>
        <p className="pv-meta">
          Which kinds, never any value. A bearer token is shown once when it is minted and stored
          only as a hash; an HMAC secret is stored as the name of a secret-manager entry. There is
          nothing here that could be copied and used.
        </p>
        {detail.credentials.length === 0 ? (
          <p>None. This agent cannot authenticate.</p>
        ) : (
          <DataTable
            caption={`Credentials held by ${agent.name}, ${pluralise(detail.credentials.length, "credential", "credentials")}.`}
            columns={credentialColumns}
            rows={detail.credentials}
            rowKey={(credential) => credential.credentialId}
            rowClassName={(credential) =>
              credential.revokedAt === undefined ? undefined : "pv-row-denied"
            }
            defaultSort={{ columnKey: "state", direction: "descending" }}
          />
        )}
      </section>

      <section className="pv-panel" aria-labelledby="agent-runs">
        <h2 className="pv-panel-heading" id="agent-runs">
          What it has been doing
        </h2>
        {detail.runs.length === 0 ? (
          <EmptyState
            title="No runs recorded"
            body="This agent has not reported any work and has not started a live run. If its owner believes it is running, either it is not reporting to this platform or it has never authenticated."
            headingLevel={3}
          />
        ) : (
          <DataTable
            caption={`Runs by ${agent.name}, showing ${pluralise(detail.runs.length, "run", "runs")} of ${detail.runsTotal}.`}
            columns={runColumns}
            rows={detail.runs}
            rowKey={(run) => run.externalRunId}
            rowClassName={(run) =>
              run.status === "failed" || run.status === "stopped" || run.status === "reclaimed"
                ? "pv-row-breached"
                : undefined
            }
            defaultSort={{ columnKey: "startedAt", direction: "descending" }}
          />
        )}
      </section>

      <section className="pv-panel" aria-labelledby="agent-denials">
        <h2 className="pv-panel-heading" id="agent-denials">
          What was refused
        </h2>
        {detail.denials.length === 0 ? (
          <p>
            Nothing has been refused. Every request this agent has made was within its grants, its
            ceilings, and its scopes.
          </p>
        ) : (
          <div className="pv-stack">
            <h3>Refusals caused by the agent</h3>
            <p className="pv-meta">
              These count toward automatic containment: enough of them inside the window and the
              platform stops the agent without waiting for a person.
            </p>
            {agentDenials.length === 0 ? (
              <p>None. Every refusal below was this platform&rsquo;s own doing.</p>
            ) : (
              <DataTable
                caption={`Refusals caused by ${agent.name}, ${pluralise(agentDenials.length, "refusal", "refusals")}.`}
                columns={denialColumns}
                rows={agentDenials}
                rowKey={(denial) => denial.entryId}
                defaultSort={{ columnKey: "recordedAt", direction: "descending" }}
              />
            )}

            <h3 className="pv-space-above-wide">Refusals caused by this platform</h3>
            <p className="pv-meta">
              Our own failures — a screen that could not answer, a record that could not be
              written. They are refusals, and they are not the agent&rsquo;s fault, so they do not
              count against it. Containing a team because our database blinked would teach them
              this platform is unreliable rather than strict.
            </p>
            {platformDenials.length === 0 ? (
              <p>None.</p>
            ) : (
              <DataTable
                caption={`Refusals caused by this platform while serving ${agent.name}, ${pluralise(platformDenials.length, "refusal", "refusals")}.`}
                columns={denialColumns}
                rows={platformDenials}
                rowKey={(denial) => denial.entryId}
                defaultSort={{ columnKey: "recordedAt", direction: "descending" }}
              />
            )}
          </div>
        )}
      </section>

      <section className="pv-panel" aria-labelledby="agent-actions">
        <h2 className="pv-panel-heading" id="agent-actions">
          Actions it asked this platform to take
        </h2>
        <p className="pv-meta">
          A write an external agent wants performed is parked with a preview a person reads, and
          committed only after somebody approves it. The agent re-sends the identical request to
          commit; anything different voids it.
        </p>
        {detail.parkedActions.length === 0 ? (
          <p>None. This agent has not asked the platform to perform a write on its behalf.</p>
        ) : (
          <DataTable
            caption={`Actions ${agent.name} asked this platform to take, ${pluralise(detail.parkedActions.length, "action", "actions")}.`}
            columns={parkedColumns}
            rows={detail.parkedActions}
            rowKey={(action) => action.parkedActionId}
            rowClassName={(action) =>
              action.status === "indeterminate" ? "pv-row-denied" : undefined
            }
            defaultSort={{ columnKey: "createdAt", direction: "descending" }}
          />
        )}
      </section>

      <section className="pv-panel" aria-labelledby="agent-containment">
        <h2 className="pv-panel-heading" id="agent-containment">
          Every time it has been stopped
        </h2>
        {detail.containmentHistory.length === 0 ? (
          <p>
            This agent has never been contained or revoked. It has run under its enrollment
            throughout.
          </p>
        ) : (
          <DataTable
            caption={`Containment history for ${agent.name}, ${pluralise(detail.containmentHistory.length, "event", "events")}.`}
            columns={containmentColumns}
            rows={detail.containmentHistory}
            rowKey={(event) => `${event.at}-${event.change}`}
            rowClassName={(event) => (event.change === "released" ? undefined : "pv-row-denied")}
            defaultSort={{ columnKey: "at", direction: "descending" }}
          />
        )}
      </section>
    </div>
  );
}

/** Route-level container. */
export function ExternalAgentDetailRoute({ agentId }: { readonly agentId: string }) {
  const client = useClient();
  const resource = useResource(
    (signal) => client.externalAgent(agentId, { signal }),
    [client, agentId],
  );

  return (
    <ResourceView resource={resource} attempted="this external agent">
      {(detail) => <ExternalAgentDetail detail={detail} />}
    </ResourceView>
  );
}
