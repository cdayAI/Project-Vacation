import { useId, useMemo, useState, type ReactNode } from "react";
import { useClient } from "../api/ClientProvider";
import type { HealthView as HealthViewModel } from "../api/contract";
import { useResource } from "../api/useResource";
import { formatCount, formatDateTime, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import { Badge, Callout, Panel } from "../ui";

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

interface DefinitionItem {
  readonly term: string;
  readonly description: ReactNode;
}

/**
 * A real `<dl>`, with each pair wrapped in a `<div>` so the grid can lay it out
 * without breaking the term/description association. Screen readers announce
 * "definition list, N items" and pair each term with its description, which a
 * two-column grid of divs does not.
 */
function DefinitionList({ items }: { readonly items: readonly DefinitionItem[] }) {
  return (
    <dl className="pv-dl">
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.description}</dd>
        </div>
      ))}
    </dl>
  );
}

interface Column<T> {
  readonly key: string;
  readonly header: string;
  /** Right-aligned and tabular-figured. Use for money, counts, durations. */
  readonly numeric?: boolean;
  /** Supply to make the column sortable. Omit and the header is plain text. */
  readonly sortValue?: (row: T) => string | number;
  /** Exactly one column should set this: it becomes the row's `<th scope="row">`. */
  readonly rowHeader?: boolean;
  readonly render: (row: T) => ReactNode;
}

type SortDirection = "ascending" | "descending";

interface SortState {
  readonly columnKey: string;
  readonly direction: SortDirection;
}

function compareCells(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * A sortable document table, inlined rather than reached for.
 *
 * The design system's `ui/surfaces/Table` is the wrong instrument here, not a
 * missing feature. It is a `role="grid"` — a keyboard widget that promises
 * arrow-key cell reading and row selection — and it virtualizes, mounting only
 * the rows in view. This screen wants the opposite of both: a plain document
 * table a screen reader reads as prose, every row present, and — the part with
 * no equivalent on the grid — a whole stopped row painted in the denied tone
 * via `rowClassName`. A stopped switch is a refusal, and the refusal has to be
 * legible as the row it is, not as a badge buried in one cell. So the semantic
 * table lives here, keeping its `<caption>`, `<th scope>` on both axes, and
 * `aria-sort` — none of which survive being rebuilt out of the grid.
 */
function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowClassName,
  defaultSort,
}: {
  /** Always rendered. A table without a caption is one nobody can identify out of context. */
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly rowClassName?: (row: T) => string | undefined;
  readonly defaultSort?: SortState;
}) {
  const captionId = useId();
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null);

  const sortedRows = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((candidate) => candidate.key === sort.columnKey);
    if (column?.sortValue === undefined) return rows;
    const sortValue = column.sortValue;
    const direction = sort.direction === "ascending" ? 1 : -1;
    // Decorated so the sort is stable: equal keys keep their original order,
    // which is what keeps engaged switches grouped without scrambling the order
    // the platform reported them in.
    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const result = compareCells(sortValue(left.row), sortValue(right.row));
        return result !== 0 ? result * direction : left.index - right.index;
      })
      .map((entry) => entry.row);
  }, [rows, columns, sort]);

  function toggleSort(columnKey: string): void {
    setSort((current) => {
      if (current?.columnKey !== columnKey) return { columnKey, direction: "ascending" };
      return {
        columnKey,
        direction: current.direction === "ascending" ? "descending" : "ascending",
      };
    });
  }

  return (
    <div className="pv-dt-scroll" tabIndex={0} role="region" aria-labelledby={captionId}>
      <table className="pv-dt">
        <caption id={captionId}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const isSorted = sort?.columnKey === column.key;
              const className = column.numeric === true ? "pv-dt-numeric" : undefined;

              if (column.sortValue === undefined) {
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className={
                      className === undefined
                        ? "pv-dt-plain-header"
                        : `pv-dt-plain-header ${className}`
                    }
                  >
                    {column.header}
                  </th>
                );
              }

              const nextDirection =
                isSorted && sort.direction === "ascending" ? "descending" : "ascending";

              return (
                <th
                  key={column.key}
                  scope="col"
                  className={className}
                  aria-sort={isSorted ? sort.direction : "none"}
                >
                  <button
                    type="button"
                    className="pv-dt-sort"
                    onClick={() => toggleSort(column.key)}
                  >
                    {column.header}
                    <span className="pv-dt-sort-indicator" aria-hidden="true">
                      {isSorted ? (sort.direction === "ascending" ? "▲" : "▼") : "↕"}
                    </span>
                    <span className="pv-sr-only">
                      {isSorted
                        ? `, sorted ${sort.direction}. Activate to sort ${nextDirection}.`
                        : `, not sorted. Activate to sort ascending.`}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={rowKey(row)} className={rowClassName?.(row)}>
              {columns.map((column) => {
                const className = column.numeric === true ? "pv-dt-numeric" : undefined;
                if (column.rowHeader === true) {
                  return (
                    <th key={column.key} scope="row" className={className}>
                      {column.render(row)}
                    </th>
                  );
                }
                return (
                  <td key={column.key} className={className}>
                    {column.render(row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
            <Badge tone="success">
              Contained — code the platform runs is isolated from this host
            </Badge>
          ) : (
            <Badge tone="danger">
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
          <Badge tone="warning">Enabled</Badge>
          <span>
            It ships disabled, so somebody switched this on deliberately.{" "}
            <Link to="/discovery">See what it is collecting and why it ships off</Link>.
          </span>
        </span>
      ) : (
        <span className="pv-stack-tight">
          <Badge tone="neutral">Disabled — the shipped state</Badge>
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
          <Badge tone="danger">Stopped</Badge>
        ) : (
          <Badge tone="success">Running</Badge>
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

      <Panel title={status.label}>
        <p className="pv-lede-text">{status.sentence}</p>
      </Panel>

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

      <Panel title="Configuration">
        <DefinitionList items={configurationItems} />
      </Panel>

      {/* ---------------------------------------------------------------
          The audit chain
          --------------------------------------------------------------- */}
      <Panel title="Audit record">
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
              <Badge tone="success">Verified intact</Badge> All{" "}
              {formatCount(verification.entriesChecked)} entries checked link correctly to the entry
              before them.
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
      </Panel>

      {/* ---------------------------------------------------------------
          External agents — the four rows an operator needs unasked
          --------------------------------------------------------------- */}
      <ExternalAgentHealth externalAgents={health.externalAgents} />

      {/* ---------------------------------------------------------------
          Containment
          --------------------------------------------------------------- */}
      <Panel title="Containment switches">
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
            {/* The local semantic table above, not the design system's grid.
                `rowClassName` paints a stopped row in the denied tone with a
                bar down its leading edge; pushing that into a cell would be a
                weaker claim, because the whole row is what reads as stopped. */}
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
      </Panel>
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
    <Panel title="External agents">
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
          <Badge tone="neutral">Not enabled — the shipped state</Badge>{" "}
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
              <Badge tone="success">Enabled</Badge>{" "}
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
                      <Badge tone="danger">
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
                      <Badge tone="danger">
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
                      <Badge tone="warning">
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
    </Panel>
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
