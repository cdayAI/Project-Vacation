import { useId, useMemo, useState, type ReactNode } from "react";
import { useClient } from "../api/ClientProvider";
import type {
  CredentialKind,
  ExternalAgentStatus,
  ExternalAgentView,
  RiskTier,
} from "../api/contract";
import { useResource } from "../api/useResource";
import { formatDateTime, formatUsd, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import type { StatusTone } from "../theme/tokens";
import { Badge, Callout, EmptyState, Field, IconAlert } from "../ui";

/**
 * The roster of agents running outside this platform.
 *
 * MVW's teams and vendors are already building agents inside a CRM, inside a
 * cloud agent service, inside products that were bought rather than written.
 * This screen is the answer to "who is out there, whose is it, and what is it
 * allowed to spend" — and it is the first screen anybody opens when that
 * question is asked in an incident rather than in a planning meeting.
 *
 * Three presentation decisions carry the weight.
 *
 * **Contained and over budget are written in words.** Both are stated in their
 * own column as text, counted in a callout above the table, and marked on the
 * row. A tinted row is for the person scanning across a room; the words are
 * what survive greyscale, a screen reader, and a colour-vision deficiency
 * (WCAG 1.4.1). Neither condition is ever signalled by colour alone.
 *
 * **Spend is against the CURRENT period, and the period is named.** A monthly
 * ceiling compared against a lifetime total would show every long-lived agent
 * as permanently over budget, and a column an operator has learned to ignore is
 * a column that is no longer an alert.
 *
 * **Credentials are shown as kinds and never as values.** There is nothing to
 * show: a bearer token is stored as a hash and displayed exactly once at mint,
 * an HMAC secret is stored as a name resolved from a secret manager. What the
 * column tells an operator is whether an agent authenticates with a signed
 * request or with a string, which is a genuine difference in exposure, and
 * whether it holds any credential at all — an agent holding none cannot
 * authenticate and is therefore doing nothing, however healthy it looks.
 */

const STATUS_OPTIONS: readonly ExternalAgentStatus[] = ["active", "contained", "revoked"];

interface StatePresentation {
  readonly label: string;
  readonly tone: StatusTone;
}

/**
 * The four states an operator has to tell apart at a glance.
 *
 * "Expired" is not a status the record holds — an enrollment simply runs out,
 * and admission compares the expiry against the clock on every request. It is
 * presented as a state anyway, because from the operator's side "this agent is
 * refused everything" is the fact that matters, and discovering that only by
 * reading a date column is discovering it too late.
 */
const STATE: Readonly<Record<string, StatePresentation>> = {
  active: { label: "Running", tone: "success" },
  contained: { label: "Contained", tone: "danger" },
  revoked: { label: "Revoked", tone: "denied" },
  expired: { label: "Enrollment expired", tone: "warning" },
};

export function agentState(agent: ExternalAgentView): string {
  if (agent.status === "revoked") return "revoked";
  if (agent.status === "contained") return "contained";
  return agent.expired ? "expired" : "active";
}

function AgentStatePill({ agent }: { readonly agent: ExternalAgentView }) {
  const presentation = STATE[agentState(agent)] ?? STATE["active"];
  if (presentation === undefined) return null;
  // The tone contributes the mark; the word is the carrier. A state read only
  // from colour is no state at all to a monochrome export or a screen reader.
  return <Badge tone={presentation.tone}>{presentation.label}</Badge>;
}

/**
 * The risk ceiling, as a word.
 *
 * The design system's pill family lived in the legacy `components/` layer this
 * screen is being taken off; its `src/ui` successor is the `Badge` primitive
 * plus a per-screen map of the words and tone. `prohibited` is `denied` rather
 * than a shade of `danger` — a ceiling that forbids an action is the governance
 * holding, not a fault — matching the run vocabulary elsewhere in the console.
 */
const RISK: Readonly<Record<RiskTier, { readonly label: string; readonly tone: StatusTone }>> = {
  routine: { label: "Routine", tone: "neutral" },
  sensitive: { label: "Sensitive", tone: "info" },
  high_consequence: { label: "High consequence", tone: "danger" },
  prohibited: { label: "Prohibited", tone: "denied" },
};

function riskLabel(risk: RiskTier): string {
  return RISK[risk].label;
}

function RiskPill({ risk }: { readonly risk: RiskTier }) {
  const presentation = RISK[risk];
  return <Badge tone={presentation.tone}>{presentation.label} risk</Badge>;
}

const CREDENTIAL_LABEL: Readonly<Record<CredentialKind, string>> = {
  bearer: "Bearer token",
  jwt: "Signed assertion",
  hmac: "Signed request",
  envelope: "Signed envelope",
};

export function credentialKindLabel(kind: CredentialKind): string {
  return CREDENTIAL_LABEL[kind];
}

export interface ExternalAgentsProps {
  readonly agents: readonly ExternalAgentView[];
  /** Total on the server, which can exceed what this page holds. */
  readonly total?: number;
}

export function ExternalAgents({ agents, total }: ExternalAgentsProps) {
  const [status, setStatus] = useState<ExternalAgentStatus | "all">("all");
  const [department, setDepartment] = useState<string>("all");
  const [attentionOnly, setAttentionOnly] = useState(false);

  const departments = useMemo(
    () => [...new Set(agents.map((agent) => agent.department))].sort(),
    [agents],
  );

  const needsAttention = (agent: ExternalAgentView): boolean =>
    agent.status === "contained" || agent.overBudget || agent.expired;

  const visible = useMemo(
    () =>
      agents.filter((agent) => {
        if (status !== "all" && agent.status !== status) return false;
        if (department !== "all" && agent.department !== department) return false;
        if (attentionOnly && !needsAttention(agent)) return false;
        return true;
      }),
    [agents, status, department, attentionOnly],
  );

  const contained = agents.filter((agent) => agent.status === "contained");
  const overBudget = agents.filter((agent) => agent.overBudget);
  const expired = agents.filter((agent) => agent.expired && agent.status !== "revoked");
  const uncredentialled = agents.filter(
    (agent) => agent.status !== "revoked" && agent.credentialKinds.length === 0,
  );
  const isFiltered = status !== "all" || department !== "all" || attentionOnly;
  const periodSpend = visible.reduce((sum, agent) => sum + agent.spentUsd, 0);

  const columns: readonly Column<ExternalAgentView>[] = [
    {
      key: "name",
      header: "Agent",
      rowHeader: true,
      sortValue: (agent) => agent.name,
      render: (agent) => (
        <span className="pv-stack-tight">
          <Link to={`/external-agents/${agent.agentId}`}>{agent.name}</Link>
          <span className="pv-meta pv-mono">{agent.agentId}</span>
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      // Contained first, then expired, then over budget, then healthy. The
      // default sort uses this, so the roster opens on whatever needs a person.
      sortValue: (agent) =>
        agent.status === "contained"
          ? 0
          : agent.expired
            ? 1
            : agent.overBudget
              ? 2
              : agent.status === "revoked"
                ? 4
                : 3,
      render: (agent) => (
        <span className="pv-stack-tight">
          <AgentStatePill agent={agent} />
          {agent.statusReason !== undefined && (
            <span className="pv-meta">{agent.statusReason}</span>
          )}
        </span>
      ),
    },
    {
      key: "hostPlatform",
      header: "Runs on",
      sortValue: (agent) => agent.hostPlatform,
      render: (agent) => <span className="pv-mono">{agent.hostPlatform}</span>,
    },
    {
      key: "owner",
      header: "Accountable owner",
      sortValue: (agent) => agent.owner,
      render: (agent) => <span>{agent.owner}</span>,
    },
    {
      key: "department",
      header: "Department",
      sortValue: (agent) => agent.department,
      render: (agent) => <span>{agent.department}</span>,
    },
    {
      key: "spend",
      header: "Spend this period",
      numeric: true,
      // Sorted by how close to the ceiling, not by the raw amount: a small
      // agent at 99% of its budget is the one that is about to stop.
      sortValue: (agent) =>
        agent.spendCeilingUsd === 0 ? 0 : agent.spentUsd / agent.spendCeilingUsd,
      render: (agent) => (
        <span className="pv-stack-tight">
          <span>
            {formatUsd(agent.spentUsd)} of {formatUsd(agent.spendCeilingUsd)}
          </span>
          <span className="pv-meta">
            {agent.budgetPeriod === "lifetime" ? "Lifetime" : `Period ${agent.periodKey}`}
          </span>
          {agent.overBudget && (
            // The triangle rather than the tone's default cross: a cross reads
            // as "this failed", and a ceiling reached is a limit to weigh, not a
            // run that broke — the same reason the risk vocabulary warns with ▲.
            <Badge tone="danger" icon={<IconAlert size="sm" />}>
              Over ceiling
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: "riskCeiling",
      header: "Risk ceiling",
      sortValue: (agent) => riskLabel(agent.riskCeiling),
      render: (agent) => <RiskPill risk={agent.riskCeiling} />,
    },
    {
      key: "credentials",
      header: "Credentials held",
      sortValue: (agent) => agent.credentialKinds.join(","),
      render: (agent) =>
        agent.credentialKinds.length === 0 ? (
          <Badge tone="warning">None held</Badge>
        ) : (
          <span className="pv-stack-tight">
            {agent.credentialKinds.map((kind) => (
              <span key={kind}>{credentialKindLabel(kind)}</span>
            ))}
          </span>
        ),
    },
    {
      key: "lastSeenAt",
      header: "Last seen",
      sortValue: (agent) => agent.lastSeenAt ?? "",
      render: (agent) =>
        agent.lastSeenAt === undefined ? (
          <span className="pv-meta">Never</span>
        ) : (
          <time dateTime={agent.lastSeenAt}>{formatDateTime(agent.lastSeenAt)}</time>
        ),
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>External agents</h1>
        <p className="pv-page-lede">
          Agents this platform did not build and does not run, admitted under governance. Each one
          has a named owner, a spend ceiling, a risk ceiling, and an expiry, and each can be stopped
          from here. Spend is what the agent has used in its current budget period, not an estimate.
        </p>
      </div>

      <div className="pv-toolbar">
        <Field label="Enrollment state">
          {(control) => (
            <select
              id={control.id}
              className="pv-select"
              value={status}
              onChange={(event) => setStatus(event.target.value as ExternalAgentStatus | "all")}
            >
              <option value="all">All states</option>
              {STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {STATE[option]?.label ?? option}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Department">
          {(control) => (
            <select
              id={control.id}
              className="pv-select"
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
            >
              <option value="all">All departments</option>
              {departments.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          )}
        </Field>

        <div className="pv-checkbox-field">
          <input
            type="checkbox"
            className="pv-checkbox"
            id="external-agents-attention-only"
            checked={attentionOnly}
            onChange={(event) => setAttentionOnly(event.target.checked)}
          />
          <label htmlFor="external-agents-attention-only">
            Only agents that are contained, over budget, or expired
          </label>
        </div>
      </div>

      <p role="status" className="pv-meta">
        Showing {pluralise(visible.length, "agent", "agents")}
        {total !== undefined && total !== agents.length ? ` of ${total} on the server` : ""}
        {isFiltered ? ", filtered" : ""}. Spend shown totals {formatUsd(periodSpend)} for the
        current period.
      </p>

      {contained.length > 0 && (
        <Callout
          tone="danger"
          title={`${pluralise(contained.length, "agent is", "agents are")} contained`}
        >
          <p>
            {contained.map((agent) => agent.name).join(", ")}. A contained agent is refused at every
            admission check and is told to stop the next time it asks this platform for anything.
            It stays contained until a person releases it — nothing here clears itself.
          </p>
        </Callout>
      )}

      {overBudget.length > 0 && (
        <Callout
          tone="danger"
          title={`${pluralise(overBudget.length, "agent is", "agents are")} over budget`}
        >
          <p>
            {overBudget.map((agent) => agent.name).join(", ")}. An agent at its ceiling is refused
            on spend from that moment, which from the vendor&rsquo;s side looks the same as this
            platform being broken. Raising the ceiling is a decision for the agent&rsquo;s owner;
            there is no operation anywhere that clears a spend meter.
          </p>
        </Callout>
      )}

      {expired.length > 0 && (
        <Callout
          tone="warning"
          title={`${pluralise(expired.length, "enrollment has", "enrollments have")} expired`}
        >
          <p>
            {expired.map((agent) => agent.name).join(", ")}. An expired enrollment is refused
            everything, checked against the clock on each request rather than by a background job.
            Renewing it is a re-enrollment, which is a deliberate change to the term rather than a
            status flip.
          </p>
        </Callout>
      )}

      {uncredentialled.length > 0 && (
        <Callout
          tone="info"
          title={`${pluralise(uncredentialled.length, "agent holds", "agents hold")} no credential`}
        >
          <p>
            {uncredentialled.map((agent) => agent.name).join(", ")}. An agent with no credential
            cannot authenticate and is therefore doing nothing, whatever else its row says. That is
            normal immediately after enrollment and is worth a question at any other time.
          </p>
        </Callout>
      )}

      {visible.length === 0 ? (
        <EmptyState
          title={isFiltered ? "No agent matches these filters" : "No external agent is enrolled"}
          body={
            isFiltered
              ? "No agent matches the state, department, and attention filters currently set. Widen a filter to see the rest of the roster."
              : "Nothing is enrolled, so this platform is governing no external agents. If teams are running agents elsewhere, every external figure reported here is a zero this deployment has not earned — enrolling them is what makes those figures true."
          }
          headingLevel={2}
        />
      ) : (
        <AgentTable
          caption={`External agents, ${pluralise(visible.length, "agent", "agents")}.`}
          columns={columns}
          rows={visible}
          rowKey={(agent) => agent.agentId}
          // A second, redundant channel for a sighted operator scanning the
          // table. The words in the State and Spend columns are the carrier.
          rowClassName={(agent) =>
            agent.status === "contained" || agent.status === "revoked"
              ? "pv-row-denied"
              : agent.overBudget || agent.expired
                ? "pv-row-breached"
                : undefined
          }
          defaultSort={{ columnKey: "state", direction: "ascending" }}
        />
      )}
    </div>
  );
}

/** Route-level container: loads the roster and hands it to the view above. */
export function ExternalAgentsRoute() {
  const client = useClient();
  const resource = useResource((signal) => client.externalAgents({}, { signal }), [client]);

  return (
    <ResourceView resource={resource} attempted="the external agent roster">
      {(page) => <ExternalAgents agents={page.items} total={page.total} />}
    </ResourceView>
  );
}

// ---------------------------------------------------------------------------
// The roster's table
//
// A real `<table>`, hand-rolled in the view rather than drawn from the design
// system's `Table`. That component is a virtualized `role="grid"` cursor widget
// built for ten thousand rows, and it deliberately offers no per-row styling
// hook — but the roster's alarm signals need one. Containment, revocation, over
// budget and expiry are each carried in words in a cell AND in a tinted row, so
// a state survives greyscale, a screen reader, and a scan from across a room
// (WCAG 1.4.1); the tint is drawn from `rowClassName`. Reaching for the grid
// would drop that second channel, so the semantic table stays here, carrying
// the `<caption>`, `<th scope>` on both axes, and `aria-sort` a screen reader
// needs. The `pv-dt-` class prefix keeps its styles clear of `pv-table-`, which
// the grid owns.
// ---------------------------------------------------------------------------

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

interface SortState {
  readonly columnKey: string;
  readonly direction: "ascending" | "descending";
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function AgentTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowClassName,
  defaultSort,
}: {
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
    // which is what makes the default "contained first, then within a state the
    // order they arrived" actually behave that way.
    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const result = compare(sortValue(left.row), sortValue(right.row));
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
                      className === undefined ? "pv-dt-plain-header" : `pv-dt-plain-header ${className}`
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
                  {/* The button fills its header cell, so the hit target is the
                      whole header rather than a small glyph inside it (WCAG
                      2.2 2.5.8). */}
                  <button type="button" className="pv-dt-sort" onClick={() => toggleSort(column.key)}>
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
