import { useId } from "react";
import type { DenialView } from "../api/contract";

/**
 * A refusal, rendered as an outcome.
 *
 * This is not an error page and it must never become one. The platform refuses
 * rather than proceeds whenever a control cannot do its job, so a denial is the
 * system working as designed — and an operator who sees governance painted in
 * failure red learns, correctly, that the safe path looks like breakage.
 *
 * Four things, in this order, every time:
 *   what was refused, why, in plain language, and what the operator can do.
 *
 * There is no red toast anywhere in this console for a denial. A toast
 * disappears, and the reason a decision was refused is exactly the thing an
 * operator will be asked to explain later.
 *
 * The markup is written here rather than taken from `src/ui` on purpose. The
 * library's nearest shape is `ErrorState`, whose two tones are Error and
 * Degraded and which insists on a reference code — routing a refusal through it
 * would paint governance as breakage, which is the one thing this file exists to
 * prevent. A shared component would have to be locked to the denied tone and
 * would still never announce as an alert.
 */

/**
 * What to do next, by reason family.
 *
 * Keyed on the family rather than on all forty-odd reason codes because a
 * guess dressed up as guidance is worse than none: the codes are enumerated in
 * the platform's kernel/errors.ts, and a specific entry is added here only when
 * the next step genuinely differs from its family's.
 */
const NEXT_STEP_BY_REASON: Readonly<Record<string, string>> = {
  "authorization.step_up_required":
    "Re-authenticate, then try the action again. A recent sign-in is not enough for this one.",
  "approval.self_approval":
    "A different eligible approver has to decide this. You cannot approve a proposal you raised.",
  "approval.digest_mismatch":
    "The proposal changed after it was approved, so the approval no longer covers it. Raise a new proposal and have it approved again.",
  "approval.expired":
    "The approval window closed before the action ran. Raise the request again to start a fresh window.",
  "knowledge.no_grounding":
    "The platform found no cited source it was willing to rely on. Check that the relevant document is loaded and in effect for this date and jurisdiction.",
  "knowledge.stale_authority":
    "The source that would have been cited is past its review date. A knowledge owner has to review and re-date it before this can proceed.",
};

const NEXT_STEP_BY_FAMILY: Readonly<Record<string, string>> = {
  authorization:
    "You are not entitled to this action in this context. If you believe you should be, ask an administrator to check your roles and data scopes — do not retry.",
  approval:
    "This action needs a human decision that has not been given, or that no longer applies. Check the approvals queue.",
  ceiling:
    "A configured limit on spend, rate, or elapsed time was reached. The limit is doing its job; raising it is a deliberate decision, not a retry.",
  containment:
    "Something has been deliberately stopped — globally, or for this workflow, role, or integration. Check the containment state before doing anything else, and speak to whoever engaged it.",
  screen:
    "The boundary screen refused the input, or could not run. Untrusted content is not passed to a model when the screen is unavailable.",
  sandbox:
    "The execution sandbox refused to run this. Check the sandbox mode reported on the platform state banner.",
  contact:
    "Contact compliance refused this outbound message. Consent, quiet hours, frequency caps, and do-not-contact flags are checked before anything is sent, and none of them can be overridden from this console.",
  role: "The agent role is not in a state that permits this. Check the role's status and its risk ceiling.",
  model:
    "The requested model is not in the approved inventory, or its provider is unavailable. Model choice is configuration, not something to change here.",
  integration:
    "The integration refused, or was not configured to reach that host. An administrator has to change the allowlist or supply the credential.",
  improvement:
    "The improvement gate refused this change. It is not configurable, by design: a change that regresses measured quality does not ship.",
  discovery:
    "Work discovery refused. It ships disabled, its output is inert, and nothing it produces can be activated from here.",
  record: "The operating record was unavailable, so the platform refused to act rather than act unrecorded.",
  config: "Configuration is missing or unusable. This needs an operator with access to the deployment, not a retry.",
};

function nextStepFor(reason: string): string {
  const specific = NEXT_STEP_BY_REASON[reason];
  if (specific !== undefined) return specific;
  const family = reason.split(".")[0] ?? "";
  return (
    NEXT_STEP_BY_FAMILY[family] ??
    "Note the reason code above and pass it to whoever administers this platform. Repeating the action will produce the same refusal."
  );
}

export interface DenialProps {
  readonly denial: DenialView;
  /** What the operator was trying to do, in their words. */
  readonly attempted?: string;
  readonly headingLevel?: 1 | 2 | 3;
}

export function Denial({ denial, attempted, headingLevel = 2 }: DenialProps) {
  const Heading = `h${headingLevel}` as "h1" | "h2" | "h3";
  // Generated rather than fixed: a decision that is refused renders a second
  // Denial inside ApprovalDetail, and two elements sharing an id would leave
  // aria-labelledby pointing at whichever one the browser found first.
  const headingId = useId();

  const detailEntries = Object.entries(denial.detail);

  return (
    <section className="pv-denial" aria-labelledby={headingId}>
      <Heading className="pv-denial-heading" id={headingId}>
        {attempted === undefined ? "The platform refused this action" : `Refused: ${attempted}`}
      </Heading>

      <p>{denial.message}</p>

      <p>
        <strong>What you can do.</strong> {nextStepFor(denial.reason)}
      </p>

      <div className="pv-stack-tight">
        <p className="pv-meta">
          Reason code, for the audit record and for anyone you escalate to:
        </p>
        <p>
          <span className="pv-digest">{denial.reason}</span>
        </p>
      </div>

      {detailEntries.length > 0 && (
        <div className="pv-stack-tight">
          <p className="pv-meta">Details recorded with the refusal</p>
          {/* A real <dl>: a screen reader announces "definition list, N items"
              and pairs each key with its value, which a grid of divs does not.
              The pair wrapper carries `display: contents`, so the two-column
              layout does not sever that pairing to get its columns. */}
          <dl className="pv-dl">
            {detailEntries.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  <span className="pv-mono">{String(value)}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <p className="pv-meta">
        This refusal was recorded in the audit log. It is not a fault, and there is nothing to
        fix in the console: the platform declined to act because one of its controls said no.
      </p>
    </section>
  );
}
