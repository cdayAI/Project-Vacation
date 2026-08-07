import type { ReactNode } from "react";
import { useClient } from "../api/ClientProvider";
import type { EvaluationView, ImprovementProposalView } from "../api/contract";
import { useResource } from "../api/useResource";
import { formatCount, formatDateTime, formatPercent, formatPercentagePoints, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import { Badge, Callout, IconAlert, Panel } from "../ui";

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

interface DefinitionItem {
  readonly term: string;
  readonly description: ReactNode;
}

/**
 * A real `<dl>`: a screen reader announces "definition list, N items" and pairs
 * each term with its description, which a two-column grid of divs does not.
 * Each pair is wrapped in a `display: contents` div so the layout can take its
 * columns without severing that pairing.
 *
 * Local because `src/ui` has no definition list to give, and this screen wants
 * three of them.
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

/**
 * The verdict, with the number that produced it kept in the words.
 *
 * "Below the threshold" alone invites the next question and answers none of
 * it; the threshold is the role owner's decision and the badge is where a
 * reader meets it. A bare pass/fail chip here would be a downgrade.
 *
 * The failing side takes the warning mark rather than the `danger` tone's own
 * cross: the evaluation ran and reported, so nothing here failed — a result
 * under the bar is a thing to weigh, not a breakage.
 */
function EvaluationBadge({ evaluation }: { readonly evaluation: EvaluationView }) {
  const threshold = `${(evaluation.threshold * 100).toFixed(0)}% threshold`;
  return evaluation.meetsThreshold ? (
    <Badge tone="success">Meets the {threshold}</Badge>
  ) : (
    <Badge tone="danger" icon={<IconAlert size="sm" />}>
      Below the {threshold}
    </Badge>
  );
}

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
      <Panel title="What would change">
        <p>{proposal.rationale}</p>

        <div className="pv-compare pv-space-above">
          {/* Panels rather than plain blocks: each pane is a named region an
              approver can jump straight to, and that name is what a screen
              reader reads out before the artifact itself. The artifact stays a
              plain <p>, because it is the thing the digest is taken over and
              reflowing it would show something other than what is signed. */}
          <Panel title="Before — what runs today" titleLevel={3}>
            <p className="pv-artifact">{proposal.before}</p>
          </Panel>
          <Panel title="After — what would run if approved" titleLevel={3}>
            <p className="pv-artifact">{proposal.after}</p>
          </Panel>
        </div>
      </Panel>

      {/* ---------------------------------------------------------------
          2. What the curated set says about it
          --------------------------------------------------------------- */}
      <Panel title="Measured effect">
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
              <Panel title="Before" titleLevel={3}>
                {before === undefined ? (
                  <p className="pv-meta">No evaluation was recorded before the change.</p>
                ) : (
                  <EvaluationFacts evaluation={before} />
                )}
              </Panel>
              <Panel title="After" titleLevel={3}>
                {after === undefined ? (
                  <p className="pv-meta">No evaluation was recorded after the change.</p>
                ) : (
                  <EvaluationFacts evaluation={after} />
                )}
              </Panel>
            </div>

            <p className="pv-meta">
              Both runs used the same curated set. A proposal may add cases to that set; it may
              never weaken, relabel, or delete one, because the cheapest way to improve a score is
              to move the goalposts.
            </p>
          </div>
        )}
      </Panel>

      {/* ---------------------------------------------------------------
          3. How far it reaches
          --------------------------------------------------------------- */}
      <Panel title="Blast radius">
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
      </Panel>

      <Panel title="Where this came from">
        <DefinitionList items={provenanceItems} />
      </Panel>

      <Panel title="Deciding this">
        <p>
          Approval happens in the approvals queue, against the proposal digest, so that the artifact
          an approver read is provably the artifact their decision covers. There is no approve
          control on this page and there is not meant to be one.
        </p>
        <p>
          <Link to="/approvals">Go to the approvals queue</Link>
        </p>
      </Panel>
    </div>
  );
}

function EvaluationFacts({ evaluation }: { readonly evaluation: EvaluationView }) {
  return (
    <div className="pv-stack-tight">
      <EvaluationBadge evaluation={evaluation} />
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
