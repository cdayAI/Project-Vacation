import { useClient } from "../api/ClientProvider";
import type { EvaluationView, ImprovementProposalView } from "../api/contract";
import { useResource } from "../api/useResource";
import {
  Badge,
  Callout,
  DefinitionList,
  EvaluationPill,
  type DefinitionItem,
} from "../components";
import { formatCount, formatDateTime, formatPercent, formatPercentagePoints, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";

/**
 * One improvement proposal, laid out for a decision that should take seconds.
 *
 * An approver needs three things and nothing else to decide: what exactly
 * changes, what the curated set says about the change, and how far the change
 * reaches. Those three are the first three sections, in that order, above every
 * piece of provenance and metadata.
 *
 * The before and after are rendered whole, as text, side by side. Not a diff
 * with the unchanged parts collapsed: a prompt is a paragraph, and an approver
 * who reads only the changed clause approves a sentence they have not read.
 *
 * The inertness statement appears here as well as on the queue. This is the
 * screen somebody lands on from a link, and it is the screen where an assumption
 * that "reviewing it" and "applying it" are the same act would do damage.
 */

export interface ImprovementProposalProps {
  readonly proposal: ImprovementProposalView;
}

export function ImprovementProposal({ proposal }: ImprovementProposalProps) {
  const before = proposal.evaluationBefore;
  const after = proposal.evaluationAfter;
  const delta = proposal.evaluationDelta;

  const regresses = delta !== undefined && delta < 0;
  const wouldFallBelowThreshold = after !== undefined && !after.meetsThreshold;

  const provenanceItems: DefinitionItem[] = [
    { term: "Proposal", description: <span className="pv-mono">{proposal.proposalId}</span> },
    { term: "Kind", description: <span className="pv-mono">{proposal.kind}</span> },
    { term: "State", description: <Badge tone="neutral">{proposal.status.replace(/_/g, " ")}</Badge> },
    {
      term: "Artifact it would change",
      description: (
        <span className="pv-mono">
          {proposal.artifactKind} · {proposal.artifactRef}
        </span>
      ),
    },
    {
      term: "Raised",
      description: <time dateTime={proposal.createdAt}>{formatDateTime(proposal.createdAt)}</time>,
    },
    {
      term: "Observations behind it",
      description: `${formatCount(proposal.observationCount)} recorded observations of the same problem`,
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <p className="pv-meta">
          <Link to="/improvements">Improvements</Link>
        </p>
        <h1>{proposal.title}</h1>
        <p className="pv-page-lede pv-mono">{proposal.proposalId}</p>
      </div>

      <Callout tone="info" title="This proposal is inert">
        <p>
          Nothing on this page has been applied, and reading it applies nothing. A proposal becomes
          a change only when a person approves it and the platform then verifies that the approval
          binds to this exact proposal. There is no auto-apply and no configuration that removes
          that step.
        </p>
      </Callout>

      {regresses && (
        <Callout tone="danger" title="This change made the measured result worse">
          <p>
            The curated set scored {formatPercentagePoints(delta)} lower after the change than
            before it. The improvement gate refuses a change that regresses measured quality; this
            proposal cannot be applied while that is true.
          </p>
        </Callout>
      )}

      {!regresses && wouldFallBelowThreshold && (
        <Callout tone="warning" title="Even after the change, the threshold is not met">
          <p>
            The result improves, and it still sits below the threshold the role&rsquo;s owner set.
            Approving this makes things better without making them adequate.
          </p>
        </Callout>
      )}

      {/* ---------------------------------------------------------------
          1. Exactly what changes
          --------------------------------------------------------------- */}
      <section className="pv-panel" aria-labelledby="proposal-change">
        <h2 className="pv-panel-heading" id="proposal-change">
          What would change
        </h2>

        <p>{proposal.rationale}</p>

        <div className="pv-compare pv-space-above">
          <section className="pv-compare-pane" aria-labelledby="proposal-before">
            <h3 id="proposal-before">Before — what runs today</h3>
            <p className="pv-artifact">{proposal.before}</p>
          </section>
          <section className="pv-compare-pane pv-compare-pane-after" aria-labelledby="proposal-after">
            <h3 id="proposal-after">After — what would run if approved</h3>
            <p className="pv-artifact">{proposal.after}</p>
          </section>
        </div>
      </section>

      {/* ---------------------------------------------------------------
          2. What the curated set says about it
          --------------------------------------------------------------- */}
      <section className="pv-panel" aria-labelledby="proposal-evaluation">
        <h2 className="pv-panel-heading" id="proposal-evaluation">
          Measured effect
        </h2>

        {delta === undefined ? (
          <p>
            This proposal has not been evaluated. Without a before and after against the curated
            set there is no evidence that it improves anything, and the gate has nothing to check.
          </p>
        ) : (
          <div className="pv-stack">
            <p className="pv-lede-text">
              <strong>{formatPercentagePoints(delta)}</strong> on the curated set
              {before !== undefined && after !== undefined
                ? `: ${formatPercent(before.accuracy)} before, ${formatPercent(after.accuracy)} after.`
                : "."}
            </p>

            <div className="pv-compare">
              <section className="pv-compare-pane" aria-labelledby="proposal-eval-before">
                <h3 id="proposal-eval-before">Before</h3>
                {before === undefined ? (
                  <p className="pv-meta">No evaluation was recorded before the change.</p>
                ) : (
                  <EvaluationFacts evaluation={before} />
                )}
              </section>
              <section
                className="pv-compare-pane pv-compare-pane-after"
                aria-labelledby="proposal-eval-after"
              >
                <h3 id="proposal-eval-after">After</h3>
                {after === undefined ? (
                  <p className="pv-meta">No evaluation was recorded after the change.</p>
                ) : (
                  <EvaluationFacts evaluation={after} />
                )}
              </section>
            </div>

            <p className="pv-meta">
              Both runs used the same curated set. A proposal may add cases to that set; it may
              never weaken, relabel, or delete one, because the cheapest way to improve a score is
              to move the goalposts.
            </p>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------
          3. How far it reaches
          --------------------------------------------------------------- */}
      <section className="pv-panel" aria-labelledby="proposal-blast-radius">
        <h2 className="pv-panel-heading" id="proposal-blast-radius">
          Blast radius
        </h2>

        <p className="pv-lede-text">
          Had this been in force for the last thirty days, it would have applied to{" "}
          <strong>{formatCount(proposal.blastRadius.runsInLastThirtyDays)}</strong> runs.
        </p>

        <DefinitionList
          items={[
            {
              term: "Roles affected",
              description:
                proposal.blastRadius.roles.length === 0 ? (
                  <span className="pv-meta">No role uses this artifact.</span>
                ) : (
                  <ul className="pv-token-list">
                    {proposal.blastRadius.roles.map((roleId) => (
                      <li className="pv-token" key={roleId}>
                        <Link to={`/roles/${roleId}`}>
                          <span className="pv-mono">{roleId}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ),
            },
            {
              term: "Workflows affected",
              description:
                proposal.blastRadius.workflows.length === 0 ? (
                  <span className="pv-meta">No workflow uses this artifact.</span>
                ) : (
                  <ul className="pv-token-list">
                    {proposal.blastRadius.workflows.map((workflow) => (
                      <li className="pv-token" key={workflow}>
                        {workflow}
                      </li>
                    ))}
                  </ul>
                ),
            },
            {
              term: "Runs in the last thirty days",
              description: `${formatCount(proposal.blastRadius.runsInLastThirtyDays)} — computed from the operating record, not estimated`,
            },
          ]}
        />
      </section>

      <section className="pv-panel" aria-labelledby="proposal-provenance">
        <h2 className="pv-panel-heading" id="proposal-provenance">
          Where this came from
        </h2>
        <DefinitionList items={provenanceItems} />
      </section>

      <section className="pv-panel" aria-labelledby="proposal-deciding">
        <h2 className="pv-panel-heading" id="proposal-deciding">
          Deciding this
        </h2>
        <p>
          Approval happens in the approvals queue, against the proposal digest, so that the artifact
          an approver read is provably the artifact their decision covers. There is no approve
          control on this page and there is not meant to be one.
        </p>
        <p>
          <Link to="/approvals">Go to the approvals queue</Link>
        </p>
      </section>
    </div>
  );
}

function EvaluationFacts({ evaluation }: { readonly evaluation: EvaluationView }) {
  return (
    <div className="pv-stack-tight">
      <EvaluationPill evaluation={evaluation} />
      <DefinitionList
        items={[
          { term: "Accuracy", description: formatPercent(evaluation.accuracy) },
          {
            term: "Passed",
            description: `${evaluation.passed} of ${pluralise(evaluation.caseCount, "case", "cases")}`,
          },
          { term: "Threshold", description: formatPercent(evaluation.threshold, 0) },
          {
            term: "Prompt version",
            description: <span className="pv-mono">{evaluation.promptVersion}</span>,
          },
          { term: "Model", description: <span className="pv-mono">{evaluation.modelId}</span> },
          {
            term: "Run at",
            description: <time dateTime={evaluation.ranAt}>{formatDateTime(evaluation.ranAt)}</time>,
          },
        ]}
      />
    </div>
  );
}

/** Route-level container. */
export function ImprovementProposalRoute({ proposalId }: { readonly proposalId: string }) {
  const client = useClient();
  const resource = useResource(
    (signal) => client.improvementProposal(proposalId, { signal }),
    [client, proposalId],
  );

  return (
    <ResourceView resource={resource} attempted="this improvement proposal">
      {(proposal) => <ImprovementProposal proposal={proposal} />}
    </ResourceView>
  );
}
