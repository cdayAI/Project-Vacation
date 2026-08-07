import { useState } from "react";
import { useClient } from "../api/ClientProvider";
import type { DiscoveryCandidateView } from "../api/contract";
import { useResource } from "../api/useResource";
import { formatCount, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import {
  Badge,
  Callout,
  EmptyState,
  Panel,
  Table,
  type TableColumn,
  type TableSort,
} from "../ui";

/**
 * The work discovery backlog.
 *
 * Work discovery observes how repetitive work actually flows, so that an
 * automation backlog can be chosen from evidence rather than from whoever is
 * loudest. It also observes employees, which makes it the most legally
 * sensitive thing in the product, and it therefore ships switched off.
 *
 * Two rules govern this screen, and both are structural rather than stylistic.
 *
 * **When the feature is off, this page explains why rather than showing an
 * empty table.** An empty table reads as "nothing found", which is a different
 * and far more reassuring statement than "nothing is being looked for". The
 * off state is the shipped state and it is a decision somebody made.
 *
 * **When the feature is on, there is no activation control of any kind.** Not
 * a disabled one, not one behind a permission check — none, anywhere in this
 * file. Discovery may draft; it may never execute, save, schedule, or activate.
 * A candidate reaches production only by being written up as an agent role and
 * a process and going through the same governance as everything else, which
 * means human approval and an evaluation against a curated set.
 *
 * The table brings controls of its own — a sort control per column and a column
 * chooser — and they are not an exception to that rule. They change what this
 * operator is looking at and nothing else; neither reaches the platform, and no
 * ordering of a list has ever started a run.
 */

/**
 * Order the rows the table has been told it is showing.
 *
 * The table sorts for itself only while it owns the sort state, and it starts
 * that state at "unsorted" — which would list candidates in whatever order the
 * server returned while `aria-sort` said nothing was sorted at all. Holding the
 * state here is what lets the screen open on the most-repeated work *and* say
 * so. The comparison matches the table's own: numbers numerically, everything
 * else with a numeric case-insensitive collation, ties broken by original
 * position so the order is stable.
 */
function orderBy<T>(
  rows: readonly T[],
  columns: readonly TableColumn<T>[],
  sort: TableSort | null,
): readonly T[] {
  const sortValue =
    sort === null ? undefined : columns.find((column) => column.key === sort.columnKey)?.sortValue;
  if (sort === null || sortValue === undefined) return rows;

  const direction = sort.direction === "ascending" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const a = sortValue(left.row);
      const b = sortValue(right.row);
      const result =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
      return result !== 0 ? result * direction : left.index - right.index;
    })
    .map((entry) => entry.row);
}

/** Most-repeated work first. That ranking is the whole point of the list. */
const INITIAL_SORT: TableSort = { columnKey: "occurrences", direction: "descending" };

export interface DiscoveryBacklogProps {
  readonly enabled: boolean;
  readonly candidates: readonly DiscoveryCandidateView[];
}

export function DiscoveryBacklog({ enabled, candidates }: DiscoveryBacklogProps) {
  const [sort, setSort] = useState<TableSort | null>(INITIAL_SORT);

  if (!enabled) {
    return <DiscoveryDisabled />;
  }

  const totalMinutes = candidates.reduce(
    (sum, candidate) => sum + candidate.occurrences * candidate.estimatedMinutesPerOccurrence,
    0,
  );

  const columns: readonly TableColumn<DiscoveryCandidateView>[] = [
    {
      key: "summary",
      header: "Repeated work observed",
      rowHeader: true,
      alwaysVisible: true,
      width: 360,
      sortValue: (candidate) => candidate.summary,
      cell: (candidate) => (
        <span className="pv-stack-tight">
          <span>{candidate.summary}</span>
          <span className="pv-meta pv-mono">{candidate.candidateId}</span>
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      width: 160,
      // Not sortable, because every row says the same thing and always will.
      // The badge is on every row rather than in the caption alone so that a
      // row read out of context still says what it is.
      cell: () => <Badge tone="denied">Draft only</Badge>,
    },
    {
      key: "occurrences",
      header: "Times observed",
      numeric: true,
      width: 150,
      sortValue: (candidate) => candidate.occurrences,
      cell: (candidate) => <span>{formatCount(candidate.occurrences)}</span>,
    },
    {
      key: "minutes",
      header: "Estimated minutes each",
      numeric: true,
      width: 200,
      sortValue: (candidate) => candidate.estimatedMinutesPerOccurrence,
      cell: (candidate) => <span>{candidate.estimatedMinutesPerOccurrence}</span>,
    },
    {
      key: "applications",
      header: "Applications involved",
      width: 260,
      sortValue: (candidate) => candidate.applications.join(", "),
      cell: (candidate) =>
        candidate.applications.length === 0 ? (
          <span className="pv-meta">None recorded</span>
        ) : (
          <ul className="pv-token-list">
            {candidate.applications.map((application) => (
              <li className="pv-token" key={application}>
                <span className="pv-mono">{application}</span>
              </li>
            ))}
          </ul>
        ),
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>Work discovery backlog</h1>
        <p className="pv-page-lede">
          Repetitive work the platform has observed. Every entry here is a draft and nothing more.
        </p>
      </div>

      <Callout tone="warning" title="Work discovery is switched on">
        <p>
          This feature ships disabled because it observes employees. It is running here, which means
          somebody enabled it deliberately. Confirm that advance written notice, any works-council
          consultation, and enrolment are all in place — several of those obligations apply
          regardless of individual consent.
        </p>
      </Callout>

      <Callout tone="denied" title="Everything below is inert">
        <p>
          These are observations, not automations. Nothing here runs, and nothing here can be made
          to run from this screen: there is no activation control on this page because the platform
          has no method that would activate one.
        </p>
        <p>
          A candidate becomes real work only by being written up as an agent role and a process and
          going through the same governance as everything else &mdash; a human decision, a curated
          evaluation, and a risk ceiling.
        </p>
      </Callout>

      <p role="status" className="pv-meta">
        {pluralise(candidates.length, "candidate", "candidates")}, covering an estimated{" "}
        {formatCount(Math.round(totalMinutes / 60))} hours of repeated work observed. The estimate
        is arithmetic on observed counts, not a measured saving.
      </p>

      {candidates.length === 0 ? (
        <EmptyState
          title="Nothing has been observed often enough to list"
          body="Discovery is running and has not yet seen a pattern repeat enough times to draft a candidate. Observations are held briefly and computed on demand rather than accumulated."
          headingLevel={2}
        />
      ) : (
        <Table
          caption={`Work discovery candidates, ${pluralise(candidates.length, "candidate", "candidates")}. All are drafts.`}
          tableId="discovery-backlog"
          columns={columns}
          rows={orderBy(candidates, columns, sort)}
          rowKey={(candidate) => candidate.candidateId}
          rowNoun="candidates"
          sort={sort}
          onSortChange={setSort}
          // Selection exists to feed bulk actions, and this screen has none to
          // feed. Read-only also drops `X` from the row cursor, so there is no
          // keystroke that puts a candidate into a set waiting to be acted on.
          readOnly
        />
      )}
    </div>
  );
}

/**
 * The shipped state.
 *
 * Written as an explanation rather than as an empty result, because the reason
 * this is off is the interesting part and because "no candidates" would imply
 * the platform looked and found none.
 */
function DiscoveryDisabled() {
  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>Work discovery backlog</h1>
        <p className="pv-page-lede">
          Work discovery is switched off. This page explains why rather than showing you an empty
          table.
        </p>
      </div>

      <Callout tone="info" title="This feature is built, and it ships disabled">
        <p>
          Work discovery observes how repetitive work actually flows, so that an automation backlog
          can be chosen from evidence instead of from opinion. It is genuinely useful, and it
          observes employees, which makes it the most legally sensitive component in this platform.
        </p>
      </Callout>

      <Panel title="Why it is off">
        <p>
          The obligations that attach to observing staff are not uniform and not optional, and they
          have not been answered in writing for this deployment:
        </p>
        <ul className="pv-prose-list">
          <li>
            Several US states require advance written notice of electronic monitoring, with
            different requirements and different penalties in each.
          </li>
          <li>
            Staff outside the US bring works-council consultation and data-protection obligations.
            In several jurisdictions, monitoring without consultation is unlawful regardless of
            whether the individual consented.
          </li>
          <li>Union agreements and collective agreements may impose further constraints.</li>
          <li>
            Contact-centre staff, already recorded for quality assurance, may or may not be treated
            differently from corporate staff.
          </li>
        </ul>
        <p>
          Until those are answered, the safe default is off, and the default is off in code rather
          than in a deployment setting.
        </p>
      </Panel>

      <Panel title="What is in place for when it is switched on">
        <ul className="pv-prose-list">
          <li>
            <strong>Three independent gates.</strong> The feature enabled in configuration, a named
            owner and device enrolled with a positive application allowlist, and a collector started
            deliberately. An empty allowlist observes nothing.
          </li>
          <li>
            <strong>Structural exclusions, not settings.</strong> Screen contents, window titles,
            keystrokes, clipboard, web addresses, document contents, form values, message bodies,
            and customer records cannot be represented in an observation at all. There is no setting
            that turns them on.
          </li>
          <li>
            <strong>A floor that policy cannot lower.</strong> Communication tools and systems of
            record are permanently excluded, and that exclusion always beats an enrolment allowlist.
          </li>
          <li>
            <strong>Short retention, and no second store.</strong> Candidates are computed on demand
            rather than accumulated.
          </li>
          <li>
            <strong>No egress.</strong> Observations never reach a model provider or any third
            party.
          </li>
          <li>
            <strong>The observed person is in control.</strong> Pause, stop, withdraw, and erase, at
            any time, without asking an administrator.
          </li>
          <li>
            <strong>Output is inert.</strong> Discovery may draft a process and a role. It may never
            execute, save, schedule, or activate either, and no method exists that would.
          </li>
        </ul>
      </Panel>

      <Panel title="What happens instead">
        <p>
          The automation backlog for this release is chosen from interviews and process metrics.
          That is slower and less rigorous than observation, and it is the right trade while the
          questions above are open. If the answer turns out to be &ldquo;never&rdquo;, this module
          is deleted and nothing else in the platform changes, because nothing depends on it.
        </p>
      </Panel>
    </div>
  );
}

/**
 * Route-level container.
 *
 * Whether the feature is enabled comes from the platform's own health report
 * rather than from a console setting, so the page cannot claim discovery is off
 * while the collector is running.
 */
export function DiscoveryBacklogRoute() {
  const client = useClient();
  const health = useResource((signal) => client.health({ signal }), [client]);
  const candidates = useResource((signal) => client.discoveryCandidates({}, { signal }), [client]);

  return (
    <ResourceView resource={health} attempted="the platform's discovery setting">
      {(platform) =>
        platform.discoveryEnabled ? (
          <ResourceView resource={candidates} attempted="the discovery backlog">
            {(page) => <DiscoveryBacklog enabled candidates={page.items} />}
          </ResourceView>
        ) : (
          <DiscoveryBacklog enabled={false} candidates={[]} />
        )
      }
    </ResourceView>
  );
}
