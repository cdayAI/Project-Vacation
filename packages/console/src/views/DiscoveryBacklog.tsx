import { useClient } from "../api/ClientProvider";
import type { DiscoveryCandidateView } from "../api/contract";
import { useResource } from "../api/useResource";
import { Badge, Callout, DataTable, EmptyState, type Column } from "../components";
import { formatCount, pluralise } from "../format";
import { ResourceView } from "../ResourceView";

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
 */

export interface DiscoveryBacklogProps {
  readonly enabled: boolean;
  readonly candidates: readonly DiscoveryCandidateView[];
}

export function DiscoveryBacklog({ enabled, candidates }: DiscoveryBacklogProps) {
  if (!enabled) {
    return <DiscoveryDisabled />;
  }

  const totalMinutes = candidates.reduce(
    (sum, candidate) => sum + candidate.occurrences * candidate.estimatedMinutesPerOccurrence,
    0,
  );

  const columns: readonly Column<DiscoveryCandidateView>[] = [
    {
      key: "summary",
      header: "Repeated work observed",
      rowHeader: true,
      sortValue: (candidate) => candidate.summary,
      render: (candidate) => (
        <span className="pv-stack-tight">
          <span>{candidate.summary}</span>
          <span className="pv-meta pv-mono">{candidate.candidateId}</span>
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      render: () => (
        <Badge tone="denied" glyph="⊟">
          Draft only
        </Badge>
      ),
    },
    {
      key: "occurrences",
      header: "Times observed",
      numeric: true,
      sortValue: (candidate) => candidate.occurrences,
      render: (candidate) => <span>{formatCount(candidate.occurrences)}</span>,
    },
    {
      key: "minutes",
      header: "Estimated minutes each",
      numeric: true,
      sortValue: (candidate) => candidate.estimatedMinutesPerOccurrence,
      render: (candidate) => <span>{candidate.estimatedMinutesPerOccurrence}</span>,
    },
    {
      key: "applications",
      header: "Applications involved",
      sortValue: (candidate) => candidate.applications.join(", "),
      render: (candidate) =>
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
        <DataTable
          caption={`Work discovery candidates, ${pluralise(candidates.length, "candidate", "candidates")}. All are drafts.`}
          columns={columns}
          rows={candidates}
          rowKey={(candidate) => candidate.candidateId}
          defaultSort={{ columnKey: "occurrences", direction: "descending" }}
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

      <section className="pv-panel" aria-labelledby="discovery-why">
        <h2 className="pv-panel-heading" id="discovery-why">
          Why it is off
        </h2>
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
      </section>

      <section className="pv-panel" aria-labelledby="discovery-controls">
        <h2 className="pv-panel-heading" id="discovery-controls">
          What is in place for when it is switched on
        </h2>
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
      </section>

      <section className="pv-panel" aria-labelledby="discovery-meanwhile">
        <h2 className="pv-panel-heading" id="discovery-meanwhile">
          What happens instead
        </h2>
        <p>
          The automation backlog for this release is chosen from interviews and process metrics.
          That is slower and less rigorous than observation, and it is the right trade while the
          questions above are open. If the answer turns out to be &ldquo;never&rdquo;, this module
          is deleted and nothing else in the platform changes, because nothing depends on it.
        </p>
      </section>
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
