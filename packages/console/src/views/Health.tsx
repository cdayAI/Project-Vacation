import { useClient } from "../api/ClientProvider";
import type { HealthView as HealthViewModel } from "../api/contract";
import { useResource } from "../api/useResource";
import {
  Badge,
  Callout,
  DataTable,
  DefinitionList,
  type Column,
  type DefinitionItem,
} from "../components";
import { formatCount, formatDateTime, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";

/**
 * Platform health and configuration.
 *
 * The shell already carries a banner for the three facts an operator must never
 * have to go looking for. This page is where they come to find out the rest,
 * and where they check the things the banner deliberately stays quiet about
 * because they are normal.
 *
 * Two presentation decisions worth keeping. Sandbox containment is stated as a
 * sentence rather than as a mode string: "container-isolated" tells an operator
 * nothing about whether code the platform runs is isolated from this host.
 * And an audit chain that has never been verified is reported differently from
 * one that verified clean — "nobody has checked" and "it is intact" are
 * different statements, and only one of them is reassuring.
 */

const STATUS_PRESENTATION: Readonly<
  Record<HealthViewModel["status"], { readonly label: string; readonly sentence: string }>
> = {
  ok: {
    label: "Operating normally",
    sentence: "Every component the platform depends on answered, and nothing is degraded.",
  },
  degraded: {
    label: "Degraded",
    sentence:
      "The platform is running, and something it depends on is not behaving as it should. Work may be refused rather than completed.",
  },
  unavailable: {
    label: "Unavailable",
    sentence:
      "The platform cannot serve work. Anything attempted now will be refused rather than half-completed.",
  },
};

export interface HealthProps {
  readonly health: HealthViewModel;
}

export function Health({ health }: HealthProps) {
  const status = STATUS_PRESENTATION[health.status];
  const verification = health.lastAuditVerification;
  const engagedSwitches = health.containment.filter((entry) => entry.engaged);

  const configurationItems: DefinitionItem[] = [
    { term: "Environment", description: <span className="pv-mono">{health.environment}</span> },
    {
      term: "Store",
      description: (
        <span>
          <span className="pv-mono">{health.store}</span> — where the operating record and the audit
          chain are kept
        </span>
      ),
    },
    {
      term: "Model provider",
      description: (
        <span>
          <span className="pv-mono">{health.modelProvider}</span> — which model serves which task is
          configuration, and is never decided by business logic
        </span>
      ),
    },
    {
      term: "Execution sandbox",
      description: (
        <span className="pv-stack-tight">
          <span>
            <span className="pv-mono">{health.sandboxMode}</span>
          </span>
          {health.sandboxIsContained ? (
            <Badge tone="success" glyph="✓">
              Contained — code the platform runs is isolated from this host
            </Badge>
          ) : (
            <Badge tone="danger" glyph="▲">
              Not contained — code the platform runs is not isolated from this host
            </Badge>
          )}
        </span>
      ),
    },
    {
      term: "Work discovery",
      description: health.discoveryEnabled ? (
        <span className="pv-stack-tight">
          <Badge tone="warning" glyph="▲">
            Enabled
          </Badge>
          <span>
            It ships disabled, so somebody switched this on deliberately.{" "}
            <Link to="/discovery">See what it is collecting and why it ships off</Link>.
          </span>
        </span>
      ) : (
        <span className="pv-stack-tight">
          <Badge tone="neutral" glyph="○">
            Disabled — the shipped state
          </Badge>
          <span>
            <Link to="/discovery">Why it ships off</Link>
          </span>
        </span>
      ),
    },
    {
      term: "Audit chain head",
      description:
        health.auditHeadSeq === null ? (
          <span className="pv-meta">No entries have been recorded.</span>
        ) : (
          <span>
            Entry {formatCount(health.auditHeadSeq)} is the most recent entry in the record.
          </span>
        ),
    },
  ];

  const containmentColumns: readonly Column<HealthViewModel["containment"][number]>[] = [
    {
      key: "target",
      header: "What it covers",
      rowHeader: true,
      sortValue: (entry) => `${entry.scope}:${entry.target}`,
      render: (entry) => (
        <span className="pv-stack-tight">
          <span>{entry.scope === "global" ? "Everything" : entry.target}</span>
          <span className="pv-meta pv-mono">{entry.scope}</span>
        </span>
      ),
    },
    {
      key: "engaged",
      header: "State",
      sortValue: (entry) => (entry.engaged ? 0 : 1),
      render: (entry) =>
        entry.engaged ? (
          <Badge tone="danger" glyph="⊘">
            Stopped
          </Badge>
        ) : (
          <Badge tone="success" glyph="✓">
            Running
          </Badge>
        ),
    },
    {
      key: "reason",
      header: "Reason given",
      sortValue: (entry) => entry.reason ?? "",
      render: (entry) =>
        entry.reason === undefined ? (
          <span className="pv-meta">No reason recorded</span>
        ) : (
          <span>{entry.reason}</span>
        ),
    },
    {
      key: "engagedAt",
      header: "Last changed",
      sortValue: (entry) => entry.engagedAt ?? "",
      render: (entry) =>
        entry.engagedAt === undefined ? (
          <span className="pv-meta">Never changed</span>
        ) : (
          <time dateTime={entry.engagedAt}>{formatDateTime(entry.engagedAt)}</time>
        ),
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>Platform health</h1>
        <p className="pv-page-lede">
          What this deployment is configured to do, what it is currently able to do, and everything
          it complained about at startup.
        </p>
      </div>

      <section
        className={health.status === "ok" ? "pv-panel pv-panel-verified" : "pv-panel pv-panel-alarm"}
        aria-labelledby="health-status"
      >
        <h2 className="pv-panel-heading" id="health-status">
          {status.label}
        </h2>
        <p className="pv-lede-text">{status.sentence}</p>
      </section>

      {health.warnings.length > 0 && (
        <Callout
          tone="warning"
          title={`${pluralise(health.warnings.length, "configuration warning", "configuration warnings")} from startup`}
        >
          <ul className="pv-banner-list">
            {health.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <p className="pv-meta">
            These were raised when the platform started. A warning nobody reads is a warning that
            was not raised, so they are repeated here rather than left in a log.
          </p>
        </Callout>
      )}

      {!health.sandboxIsContained && (
        <Callout tone="danger" title="The execution sandbox is not contained">
          <p>
            The sandbox is running in <span className="pv-mono">{health.sandboxMode}</span> mode,
            which does not isolate code the platform runs from this host. That is acceptable on a
            developer&rsquo;s machine and is not acceptable anywhere that handles real contracts or
            owner data.
          </p>
        </Callout>
      )}

      <section className="pv-panel" aria-labelledby="health-configuration">
        <h2 className="pv-panel-heading" id="health-configuration">
          Configuration
        </h2>
        <DefinitionList items={configurationItems} />
      </section>

      {/* ---------------------------------------------------------------
          The audit chain
          --------------------------------------------------------------- */}
      <section className="pv-panel" aria-labelledby="health-audit">
        <h2 className="pv-panel-heading" id="health-audit">
          Audit record
        </h2>

        {verification === undefined ? (
          <Callout tone="warning" title="The audit chain has not been verified">
            <p>
              Nobody has checked that the record is intact. That is not the same as it being
              intact, and it is not the same as it being broken — it means the check has not been
              run against this deployment.
            </p>
            <p>
              <Link to="/audit">Open the audit and evidence view</Link>
            </p>
          </Callout>
        ) : verification.intact ? (
          <div className="pv-stack">
            <p className="pv-lede-text">
              <Badge tone="success" glyph="✓">
                Verified intact
              </Badge>{" "}
              All {formatCount(verification.entriesChecked)} entries checked link correctly to the
              entry before them.
            </p>
            <DefinitionList
              items={[
                {
                  term: "Last verified",
                  description: (
                    <time dateTime={verification.verifiedAt}>
                      {formatDateTime(verification.verifiedAt)}
                    </time>
                  ),
                },
                {
                  term: "Range checked",
                  description: `Entry ${
                    verification.firstSeq === null ? "none" : formatCount(verification.firstSeq)
                  } through ${
                    verification.lastSeq === null ? "none" : formatCount(verification.lastSeq)
                  }`,
                },
                {
                  term: "Head fingerprint",
                  description:
                    verification.headHash === null ? (
                      <span className="pv-meta">Not recorded</span>
                    ) : (
                      <span className="pv-digest">{verification.headHash}</span>
                    ),
                },
              ]}
            />
            <p>
              <Link to="/audit">Open the audit and evidence view</Link>
            </p>
          </div>
        ) : (
          <Callout
            tone="danger"
            title={`Verification failed in ${pluralise(verification.breaks.length, "place", "places")}`}
          >
            <ul className="pv-banner-list">
              {verification.breaks.map((problem) => (
                <li key={`${problem.kind}-${problem.seq}`}>
                  Entry {formatCount(problem.seq)}, {problem.kind.replace(/_/g, " ")}:{" "}
                  {problem.detail}
                </li>
              ))}
            </ul>
            <p>
              The evidence trail cannot be relied on until each break is explained.{" "}
              <Link to="/audit">Open the audit and evidence view</Link>
            </p>
          </Callout>
        )}
      </section>

      {/* ---------------------------------------------------------------
          External agents — the four rows an operator needs unasked
          --------------------------------------------------------------- */}
      <ExternalAgentHealth externalAgents={health.externalAgents} />

      {/* ---------------------------------------------------------------
          Containment
          --------------------------------------------------------------- */}
      <section className="pv-panel" aria-labelledby="health-containment">
        <h2 className="pv-panel-heading" id="health-containment">
          Containment switches
        </h2>

        {health.containment.length === 0 ? (
          <p>
            No switch has ever been set on this deployment, so nothing is stopped.{" "}
            <Link to="/containment">Open the containment controls</Link>
          </p>
        ) : (
          <div className="pv-stack">
            <p className="pv-meta">
              {engagedSwitches.length === 0
                ? `${pluralise(health.containment.length, "switch", "switches")} on record, none engaged.`
                : `${pluralise(engagedSwitches.length, "switch is", "switches are")} engaged. Anything they cover is stopped.`}
            </p>
            <DataTable
              caption={`Containment switches known to the platform, ${pluralise(health.containment.length, "switch", "switches")}.`}
              columns={containmentColumns}
              rows={health.containment}
              rowKey={(entry) => `${entry.scope}:${entry.target}`}
              rowClassName={(entry) => (entry.engaged ? "pv-row-denied" : undefined)}
              defaultSort={{ columnKey: "engaged", direction: "ascending" }}
            />
            <p>
              <Link to="/containment">Open the containment controls</Link>
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * The four external-agent conditions, on the health page.
 *
 * Each is a state that is invisible until somebody opens the right screen, and
 * each is quietly getting worse while nobody does. They are stated in words and
 * counted, never signalled by colour alone.
 *
 * The order is the order they get worse in: a plane that is on and empty is
 * reporting zeros it has not earned, contained agents are stopped and staying
 * stopped, over-budget agents are being refused, and an expiring credential is
 * the one problem here that can still be prevented entirely.
 */
function ExternalAgentHealth({
  externalAgents,
}: {
  readonly externalAgents: HealthViewModel["externalAgents"];
}) {
  return (
    <section className="pv-panel" aria-labelledby="health-external-agents">
      <h2 className="pv-panel-heading" id="health-external-agents">
        External agents
      </h2>

      {externalAgents === undefined ? (
        <Callout tone="warning" title="This deployment does not report on external agents">
          <p>
            The health payload carries nothing about the external-agent plane. That is not the same
            as the plane being switched off, and it is not the same as nothing being enrolled — it
            means this console cannot tell you either way.
          </p>
        </Callout>
      ) : !externalAgents.planeEnabled ? (
        <p>
          <Badge tone="neutral" glyph="○">
            Not enabled — the shipped state
          </Badge>{" "}
          No agent running outside this platform is governed here. Nothing is being refused and
          nothing is being recorded, because there is nothing enrolled to refuse or record.
        </p>
      ) : (
        <div className="pv-stack">
          {externalAgents.enabledWithNothingEnrolled ? (
            <Callout tone="warning" title="The plane is enabled and nothing is enrolled">
              <p>
                Every external-agent figure this platform reports is therefore a zero it has not
                earned: no spend, no refusals, no contained agents. If teams or vendors are running
                agents elsewhere, they are running ungoverned and this page cannot see them.
                Enrolling them is what makes these figures true.
              </p>
              <p>
                <Link to="/external-agents">Open the external agent roster</Link>
              </p>
            </Callout>
          ) : (
            <p className="pv-lede-text">
              <Badge tone="success" glyph="✓">
                Enabled
              </Badge>{" "}
              {formatCount(externalAgents.enrolledCount)} enrolled,{" "}
              {formatCount(externalAgents.activeCount)} of them active.
            </p>
          )}

          <DefinitionList
            items={[
              {
                term: "Contained",
                description:
                  externalAgents.contained.length === 0 ? (
                    <span>
                      None. No external agent is stopped.
                    </span>
                  ) : (
                    <span className="pv-stack-tight">
                      <Badge tone="danger" glyph="⊘">
                        {pluralise(externalAgents.contained.length, "agent is", "agents are")}{" "}
                        contained
                      </Badge>
                      <ul className="pv-prose-list">
                        {externalAgents.contained.map((entry) => (
                          <li key={entry.agentId}>
                            <Link to={`/external-agents/${entry.agentId}`}>{entry.name}</Link> on{" "}
                            <span className="pv-mono">{entry.hostPlatform}</span>, owned by{" "}
                            {entry.owner}
                            {entry.since === undefined
                              ? ""
                              : `, stopped ${formatDateTime(entry.since)}`}
                            {entry.reason === undefined ? "" : ` — ${entry.reason}`}
                          </li>
                        ))}
                      </ul>
                      <span className="pv-meta">
                        A contained agent stays contained until a person releases it.
                      </span>
                    </span>
                  ),
              },
              {
                term: "Over budget",
                description:
                  externalAgents.overBudget.length === 0 ? (
                    <span>None. Every enrolled agent is inside its ceiling for the current period.</span>
                  ) : (
                    <span className="pv-stack-tight">
                      <Badge tone="danger" glyph="▲">
                        {pluralise(externalAgents.overBudget.length, "agent is", "agents are")} over
                        budget
                      </Badge>
                      <ul className="pv-prose-list">
                        {externalAgents.overBudget.map((entry) => (
                          <li key={entry.agentId}>
                            <Link to={`/external-agents/${entry.agentId}`}>{entry.name}</Link> has
                            spent {formatUsd(entry.spentUsd)} of {formatUsd(entry.ceilingUsd)}{" "}
                            {entry.budgetPeriod === "lifetime"
                              ? "(lifetime)"
                              : `for period ${entry.periodKey}`}
                            , owned by {entry.owner}
                          </li>
                        ))}
                      </ul>
                      <span className="pv-meta">
                        An agent at its ceiling is refused on spend, which from the vendor&rsquo;s
                        side looks the same as this platform being broken.
                      </span>
                    </span>
                  ),
              },
              {
                term: "Credentials nearing expiry",
                description:
                  externalAgents.credentialsNearingExpiry.length === 0 ? (
                    <span>
                      None within {pluralise(externalAgents.expiryHorizonDays, "day", "days")}.
                    </span>
                  ) : (
                    <span className="pv-stack-tight">
                      <Badge tone="warning" glyph="▲">
                        {pluralise(
                          externalAgents.credentialsNearingExpiry.length,
                          "credential expires",
                          "credentials expire",
                        )}{" "}
                        within {pluralise(externalAgents.expiryHorizonDays, "day", "days")}
                      </Badge>
                      <ul className="pv-prose-list">
                        {externalAgents.credentialsNearingExpiry.map((entry) => (
                          <li key={entry.credentialId}>
                            <Link to={`/external-agents/${entry.agentId}`}>{entry.agentName}</Link>
                            {": "}
                            {entry.label} ({entry.kind}){" "}
                            {entry.expired ? "EXPIRED" : "expires"}{" "}
                            <time dateTime={entry.expiresAt}>
                              {formatDateTime(entry.expiresAt)}
                            </time>
                          </li>
                        ))}
                      </ul>
                      <span className="pv-meta">
                        This is the one failure here with a deadline attached, and the only one
                        that can be prevented entirely by acting a few days early.
                      </span>
                    </span>
                  ),
              },
            ]}
          />

          <p>
            <Link to="/external-agents">Open the external agent roster</Link>
          </p>
        </div>
      )}
    </section>
  );
}

/** Route-level container. */
export function HealthRoute() {
  const client = useClient();
  const resource = useResource((signal) => client.health({ signal }), [client]);

  return (
    <ResourceView resource={resource} attempted="the platform's health">
      {(health) => <Health health={health} />}
    </ResourceView>
  );
}
