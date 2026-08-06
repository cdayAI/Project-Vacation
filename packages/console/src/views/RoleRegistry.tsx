import { useMemo, useState } from "react";
import { useClient } from "../api/ClientProvider";
import type { RoleView } from "../api/contract";
import { useResource } from "../api/useResource";
import {
  Badge,
  Callout,
  DataTable,
  EmptyState,
  Field,
  RiskPill,
  RoleStatusPill,
  riskLabel,
  roleStatusLabel,
  type Column,
} from "../components";
import { formatDateTime, formatPercent, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";

/**
 * The role registry.
 *
 * An agent role is the unit of authority in this platform: it names what an
 * agent may do, over what data, up to what risk tier, and with what human
 * involvement. This screen is the answer to "what is allowed to run here", and
 * two facts have to survive a fast scan of it.
 *
 * **A disabled role.** Disabled means stopped, usually deliberately and usually
 * for a reason. It is stated in its own column, in words, and the row is
 * marked; it is never signalled by colour alone.
 *
 * **An evaluation that does not meet its threshold.** A role can be in service
 * and still be scoring below the bar its owner set for it — that is exactly the
 * situation somebody needs to notice — so the measured accuracy, the threshold,
 * and whether one clears the other are all shown rather than reduced to a tick.
 */

export interface RoleRegistryProps {
  readonly roles: readonly RoleView[];
  readonly total?: number;
}

export function RoleRegistry({ roles, total }: RoleRegistryProps) {
  const [showDisabled, setShowDisabled] = useState<"all" | "enabled" | "disabled">("all");

  const visible = useMemo(
    () =>
      roles.filter((role) => {
        if (showDisabled === "enabled") return !role.disabled;
        if (showDisabled === "disabled") return role.disabled;
        return true;
      }),
    [roles, showDisabled],
  );

  const disabledCount = roles.filter((role) => role.disabled).length;
  const belowThreshold = roles.filter(
    (role) => role.latestEvaluation !== undefined && !role.latestEvaluation.meetsThreshold,
  );
  const unevaluated = roles.filter((role) => role.latestEvaluation === undefined);

  const columns: readonly Column<RoleView>[] = [
    {
      key: "name",
      header: "Role",
      rowHeader: true,
      sortValue: (role) => role.name,
      render: (role) => (
        <span className="pv-stack-tight">
          <Link to={`/roles/${role.roleId}`}>{role.name}</Link>
          <span className="pv-meta pv-mono">{role.roleId}</span>
        </span>
      ),
    },
    {
      key: "availability",
      header: "Available",
      sortValue: (role) => (role.disabled ? 0 : 1),
      render: (role) =>
        role.disabled ? (
          <Badge tone="danger" glyph="⊘">
            Disabled
          </Badge>
        ) : (
          <span className="pv-meta">Available</span>
        ),
    },
    {
      key: "status",
      header: "Lifecycle",
      sortValue: (role) => roleStatusLabel(role.status),
      render: (role) => <RoleStatusPill status={role.status} />,
    },
    {
      key: "version",
      header: "Version",
      numeric: true,
      sortValue: (role) => role.version,
      render: (role) => <span>{role.version}</span>,
    },
    {
      key: "riskCeiling",
      header: "Risk ceiling",
      sortValue: (role) => riskLabel(role.riskCeiling),
      render: (role) => <RiskPill risk={role.riskCeiling} />,
    },
    {
      key: "evaluation",
      header: "Latest evaluation",
      sortValue: (role) => role.latestEvaluation?.accuracy ?? -1,
      render: (role) => {
        const evaluation = role.latestEvaluation;
        if (evaluation === undefined) {
          return <span className="pv-meta">Never evaluated</span>;
        }
        return (
          <span className="pv-stack-tight">
            <span>
              {formatPercent(evaluation.accuracy)} against a {formatPercent(evaluation.threshold, 0)}{" "}
              threshold
            </span>
            {evaluation.meetsThreshold ? (
              <span className="pv-meta">Meets threshold</span>
            ) : (
              <Badge tone="danger" glyph="▲">
                Below threshold
              </Badge>
            )}
          </span>
        );
      },
    },
    {
      key: "humanInvolvement",
      header: "Human involvement",
      sortValue: (role) => role.humanInvolvement,
      render: (role) => <span>{role.humanInvolvement}</span>,
    },
    {
      key: "updatedAt",
      header: "Last changed",
      sortValue: (role) => role.updatedAt,
      render: (role) => (
        <span className="pv-stack-tight">
          <time dateTime={role.updatedAt}>{formatDateTime(role.updatedAt)}</time>
          <span className="pv-meta">{role.updatedBy.displayName}</span>
        </span>
      ),
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>Agent roles</h1>
        <p className="pv-page-lede">
          Every role the platform can run, with what it is permitted to do, the data it may see,
          the risk tier it may not exceed, and how it last scored against its curated evaluation
          set.
        </p>
      </div>

      <div className="pv-toolbar">
        <Field label="Availability">
          {(control) => (
            <select
              id={control.id}
              className="pv-select"
              value={showDisabled}
              onChange={(event) =>
                setShowDisabled(event.target.value as "all" | "enabled" | "disabled")
              }
            >
              <option value="all">All roles</option>
              <option value="enabled">Available only</option>
              <option value="disabled">Disabled only</option>
            </select>
          )}
        </Field>
      </div>

      <p role="status" className="pv-meta">
        Showing {pluralise(visible.length, "role", "roles")}
        {total !== undefined && total !== roles.length ? ` of ${total} on the server` : ""}.
      </p>

      {disabledCount > 0 && (
        <Callout
          tone="warning"
          title={`${pluralise(disabledCount, "role is", "roles are")} disabled`}
        >
          <p>
            A disabled role will not run. Anything that depends on it stops rather than proceeds
            without it, which is the intended behaviour — but it is worth knowing whether the
            disabling was deliberate and whether anyone is waiting on it.
          </p>
        </Callout>
      )}

      {belowThreshold.length > 0 && (
        <Callout
          tone="danger"
          title={`${pluralise(belowThreshold.length, "role is", "roles are")} scoring below the threshold set for it`}
        >
          <p>
            {belowThreshold.map((role) => role.name).join(", ")}. A role below its threshold is
            still permitted to run if it is in service. Whether it should be is a decision for its
            owner, and the evaluation column is the evidence for it.
          </p>
        </Callout>
      )}

      {unevaluated.length > 0 && (
        <Callout
          tone="info"
          title={`${pluralise(unevaluated.length, "role has", "roles have")} never been evaluated`}
        >
          <p>
            {unevaluated.map((role) => role.name).join(", ")}. &ldquo;Not measured&rdquo; is a
            different statement from &ldquo;measured and adequate&rdquo;, and only one of them is
            reassuring.
          </p>
        </Callout>
      )}

      {visible.length === 0 ? (
        <EmptyState
          title={
            showDisabled === "all" ? "No roles are registered" : "No role matches this filter"
          }
          body={
            showDisabled === "all"
              ? "Nothing has been registered yet. Until a role exists, the platform has nothing it is permitted to run."
              : "Change the availability filter to see the rest of the registry."
          }
          headingLevel={2}
        />
      ) : (
        <DataTable
          caption={`Agent roles, ${pluralise(visible.length, "role", "roles")}.`}
          columns={columns}
          rows={visible}
          rowKey={(role) => role.roleId}
          rowClassName={(role) => (role.disabled ? "pv-row-denied" : undefined)}
          defaultSort={{ columnKey: "availability", direction: "ascending" }}
        />
      )}
    </div>
  );
}

/** Route-level container. */
export function RoleRegistryRoute() {
  const client = useClient();
  const resource = useResource((signal) => client.roles({}, { signal }), [client]);

  return (
    <ResourceView resource={resource} attempted="the role registry">
      {(page) => <RoleRegistry roles={page.items} total={page.total} />}
    </ResourceView>
  );
}
