import { useClient } from "../api/ClientProvider";
import type {
  ExecutiveMetricView,
  ExecutiveView as ExecutiveViewModel,
} from "../api/contract";
import { useResource } from "../api/useResource";
import { Callout, DefinitionList, EmptyState } from "../components";
import { formatCount, formatDateTime, formatUsd } from "../format";
import { ResourceView } from "../ResourceView";

/**
 * The executive view.
 *
 * Tied to the metrics MVW's management named in its Q2 2026 earnings release,
 * because a platform that reports on numbers nobody committed to publicly is
 * reporting on itself.
 *
 * Three rules, and each of them exists because the obvious version of this
 * screen would mislead.
 *
 * **Every tile states where its number came from.** Some of these figures are
 * MVW's own reported results and some are measured by this platform. A view
 * that ran them together would invite the platform to be credited for movement
 * it had nothing to do with — contract sales grew 22% before any of this
 * existed. `sourceNote` is required on the view model rather than optional for
 * exactly that reason, and this screen renders it on every tile without
 * exception.
 *
 * **Colour never implies the wrong direction.** A metric carries whether an
 * increase is a good thing. A receivable reserve rising is not the same kind of
 * event as contract sales rising, and painting both green because the arrow
 * points up would be a reporting error rendered in CSS. Where the view model
 * does not say which direction is good, no judgement is drawn at all — the
 * arrow is stated, and the reader decides.
 *
 * **Savings carry their caveat wherever they appear.** An estimated saving
 * printed in a large typeface beside measured figures becomes a measured one in
 * the retelling. The caveat is rendered beside the number, not filed in a
 * footnote.
 */

type ChangeTone = "good" | "bad" | "neutral";

/**
 * Whether a movement is in the direction its owner wants.
 *
 * Returns "neutral" whenever the view model has not said which direction is
 * good. Guessing would produce a green tile for a rising loan-loss reserve.
 */
function changeTone(metric: ExecutiveMetricView): ChangeTone {
  if (metric.direction === undefined || metric.direction === "flat") return "neutral";
  if (metric.increaseIsGood === undefined) return "neutral";
  const rising = metric.direction === "up";
  return rising === metric.increaseIsGood ? "good" : "bad";
}

const DIRECTION_GLYPH: Readonly<Record<"up" | "down" | "flat", string>> = {
  up: "▲",
  down: "▼",
  flat: "▬",
};

const DIRECTION_WORD: Readonly<Record<"up" | "down" | "flat", string>> = {
  up: "Up",
  down: "Down",
  flat: "Unchanged",
};

const TONE_WORD: Readonly<Record<ChangeTone, string>> = {
  good: "in the direction management wants",
  bad: "in the direction management does not want",
  neutral: "",
};

function MetricTile({ metric }: { readonly metric: ExecutiveMetricView }) {
  const tone = changeTone(metric);
  const direction = metric.direction;

  return (
    <li className={`pv-metric pv-metric-${tone}`}>
      <h3 className="pv-metric-label">{metric.label}</h3>
      <p className="pv-metric-value">{metric.value}</p>

      {metric.comparison !== undefined && (
        <p className={`pv-metric-change pv-metric-change-${tone}`}>
          {direction !== undefined && (
            <span className="pv-metric-glyph" aria-hidden="true">
              {DIRECTION_GLYPH[direction]}
            </span>
          )}
          {metric.comparison}
          {/* The written direction is always present, so meaning never depends
              on the arrow or on the tint. */}
          {direction !== undefined && (
            <span className="pv-sr-only">
              {` (${DIRECTION_WORD[direction]}${tone === "neutral" ? "" : `, ${TONE_WORD[tone]}`}.)`}
            </span>
          )}
        </p>
      )}

      {tone !== "neutral" && (
        <p className="pv-metric-judgement">
          Moving {TONE_WORD[tone]}.
        </p>
      )}

      {/* Required on every tile. See the note at the top of this file. */}
      <p className="pv-metric-source">
        <span className="pv-metric-source-label">Source: </span>
        {metric.sourceNote}
      </p>
    </li>
  );
}

export interface ExecutiveProps {
  readonly executive: ExecutiveViewModel;
}

export function ExecutiveView({ executive }: ExecutiveProps) {
  const showsSavings =
    executive.humanHoursSaved !== undefined || executive.costPerCaseUsd !== undefined;

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>Executive view</h1>
        <p className="pv-page-lede">
          As at <time dateTime={executive.asOf}>{formatDateTime(executive.asOf)}</time>. Business
          results are MVW&rsquo;s own reported figures. Platform figures are measured here. The two
          are kept apart on purpose.
        </p>
      </div>

      <Callout tone="info" title="Read the source line on every tile">
        <p>
          Nothing on this page asserts that this platform caused a business result. Contract sales
          and volume per guest moved for reasons of MVW&rsquo;s own, and this platform did not exist
          for most of the period they moved in. What it can claim is on the record: the work it
          completed, what that cost, and what it refused.
        </p>
      </Callout>

      <section className="pv-panel" aria-labelledby="executive-business">
        <h2 className="pv-panel-heading" id="executive-business">
          What MVW reported
        </h2>
        {executive.businessMetrics.length === 0 ? (
          <EmptyState
            title="No business metrics are configured"
            body="Nothing has been tied to MVW's reported figures yet. An executive view with no business context measures only itself."
          />
        ) : (
          <ul className="pv-metrics">
            {executive.businessMetrics.map((metric) => (
              <MetricTile key={metric.key} metric={metric} />
            ))}
          </ul>
        )}
      </section>

      <section className="pv-panel" aria-labelledby="executive-platform">
        <h2 className="pv-panel-heading" id="executive-platform">
          What this platform did
        </h2>
        {executive.platformMetrics.length === 0 ? (
          <EmptyState
            title="No platform metrics are available"
            body="The operating record has produced no figures yet. That is expected before the platform has run any work."
          />
        ) : (
          <ul className="pv-metrics">
            {executive.platformMetrics.map((metric) => (
              <MetricTile key={metric.key} metric={metric} />
            ))}
          </ul>
        )}
      </section>

      <section className="pv-panel" aria-labelledby="executive-effort">
        <h2 className="pv-panel-heading" id="executive-effort">
          Work completed, cost, and estimated effort
        </h2>

        <DefinitionList
          items={[
            {
              term: "Runs completed",
              description: `${formatCount(executive.runsCompleted)} — counted from the operating record`,
            },
            {
              term: "Cost per case",
              description:
                executive.costPerCaseUsd === undefined ? (
                  <span className="pv-meta">Not calculated</span>
                ) : (
                  <span>
                    {formatUsd(executive.costPerCaseUsd)} — model, retrieval, and integration spend
                    divided by cases completed. This is a measured cost, not an estimate.
                  </span>
                ),
            },
            {
              term: "Estimated human hours saved",
              description:
                executive.humanHoursSaved === undefined ? (
                  <span className="pv-meta">
                    Not claimed. No saving is asserted, which is a more useful statement than an
                    unverified one.
                  </span>
                ) : (
                  <span>
                    {formatCount(executive.humanHoursSaved)} hours &mdash;{" "}
                    <strong>an estimate, not a measurement.</strong> {executive.measurementCaveat}
                  </span>
                ),
            },
          ]}
        />

        {showsSavings && (
          <div className="pv-space-above">
            <Callout tone="warning" title="How the savings figure should be read">
              <p>{executive.measurementCaveat}</p>
            </Callout>
          </div>
        )}
      </section>
    </div>
  );
}

/** Route-level container. */
export function ExecutiveViewRoute() {
  const client = useClient();
  const resource = useResource((signal) => client.executive({ signal }), [client]);

  return (
    <ResourceView resource={resource} attempted="the executive view">
      {(executive) => <ExecutiveView executive={executive} />}
    </ResourceView>
  );
}
