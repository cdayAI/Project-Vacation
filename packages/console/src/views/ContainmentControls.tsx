import { useRef, useState, type ReactNode } from "react";
import { isDenial } from "../api/client";
import { useClient } from "../api/ClientProvider";
import type { ContainmentView, DenialView } from "../api/contract";
import { useResource } from "../api/useResource";
// The switch table is the one thing on this screen still drawn by the old
// component layer. See the note above it: `ui/surfaces/Table` has no
// `rowClassName`, and that class is what makes a stopped row readable as
// stopped from across the room.
import { DataTable, type Column } from "../components";
import { formatDateTime, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Badge, Button, Callout, Input, Modal, Panel, Select, Textarea } from "../ui";
import { Denial } from "./Denial";

/**
 * The stop buttons.
 *
 * Four scopes: everything, one process, one agent role, one integration. This
 * is an incident control, so two properties matter more than anything else on
 * the screen.
 *
 * **The current state must be unmissable.** Whether the platform is running or
 * stopped is stated at the top in a sentence, in a panel that changes shape and
 * not merely colour, before any control. An operator arriving mid-incident
 * needs to know what is already stopped before they stop anything else.
 *
 * **Engaging must be deliberate but not slow.** Every change carries a typed
 * reason, because the reason is what the audit entry holds and what the next
 * operator reads when they find the platform stopped. The global pause adds one
 * confirmation step that spells out what it stops — and exactly one, because a
 * stop button that takes four clicks is a stop button that gets used too late.
 *
 * The controls are drawn based on a session capability. That is a rendering
 * hint and not an authorization decision: the platform re-checks entitlement at
 * the chokepoint when the change is submitted, and it would re-check it whether
 * or not this screen ever drew a button. Hiding a control here prevents
 * nothing.
 */

const SCOPE_LABEL: Readonly<Record<ContainmentView["scope"], string>> = {
  global: "Everything",
  workflow: "One process",
  role: "One agent role",
  integration: "One integration",
};

const SCOPE_HINT: Readonly<Record<ContainmentView["scope"], string>> = {
  global: "Every action the platform would take, across every process and role.",
  workflow: "Every step of one named process. Work already in flight stops at its next step.",
  role: "Everything one agent role would do. Anything that needs it is refused rather than run without it.",
  integration: "Every call to one external system. Steps that need it are refused.",
};

/**
 * The noun each scope takes inside a sentence.
 *
 * Used to give every row's control a distinct accessible name — "Stop the
 * process Rescission package assurance" rather than four buttons all announced
 * as "Stop".
 */
const SCOPE_NOUN: Readonly<Record<ContainmentView["scope"], string>> = {
  global: "the whole platform",
  workflow: "the process",
  role: "the agent role",
  integration: "the integration",
};

/** Scopes an operator can engage by naming a target. Global is its own control. */
const TARGETED_SCOPES: readonly ContainmentView["scope"][] = ["workflow", "role", "integration"];

/** The scope picker's options, in the order the labels above declare them. */
const SCOPE_OPTIONS = TARGETED_SCOPES.map((scope) => ({
  value: scope,
  label: SCOPE_LABEL[scope],
}));

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

export interface ContainmentChangeRequest {
  readonly scope: ContainmentView["scope"];
  readonly target: string;
  readonly engaged: boolean;
  readonly reason: string;
}

export interface ContainmentControlsProps {
  readonly switches: readonly ContainmentView[];
  readonly onChange?: (change: ContainmentChangeRequest) => void;
  readonly submitting?: boolean;
  /** A refusal of the change itself, rendered as an outcome rather than an error. */
  readonly changeDenial?: DenialView;
  readonly changeError?: string;
  /** A rendering hint from the session. Never an authorization decision. */
  readonly mayEngage?: boolean;
}

export function ContainmentControls({
  switches,
  onChange,
  submitting = false,
  changeDenial,
  changeError,
  mayEngage = true,
}: ContainmentControlsProps) {
  const [pending, setPending] = useState<Omit<ContainmentChangeRequest, "reason"> | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);

  const [newScope, setNewScope] = useState<ContainmentView["scope"]>("workflow");
  const [newTarget, setNewTarget] = useState("");
  const [targetError, setTargetError] = useState<string | undefined>(undefined);

  const globalSwitch = switches.find((entry) => entry.scope === "global");
  const globallyPaused = globalSwitch?.engaged === true;
  const engaged = switches.filter((entry) => entry.engaged);
  const targetedEngaged = engaged.filter((entry) => entry.scope !== "global");

  const controlsDescribedBy = !mayEngage
    ? "containment-not-permitted"
    : submitting
      ? "containment-submitting"
      : undefined;
  const controlsUnavailable = !mayEngage || submitting;

  function open(change: Omit<ContainmentChangeRequest, "reason">): void {
    setReason("");
    setReasonError(undefined);
    setPending(change);
  }

  function confirm(): void {
    if (pending === null) return;
    if (reason.trim() === "") {
      setReasonError(
        "Say why. The reason goes into the audit record and is what the next operator reads when they find this stopped.",
      );
      return;
    }
    onChange?.({ ...pending, reason: reason.trim() });
    setPending(null);
  }

  function stopNamedTarget(): void {
    if (newTarget.trim() === "") {
      setTargetError("Name what you want to stop.");
      return;
    }
    setTargetError(undefined);
    open({ scope: newScope, target: newTarget.trim(), engaged: true });
  }

  const columns: readonly Column<ContainmentView>[] = [
    {
      key: "target",
      header: "What it covers",
      rowHeader: true,
      sortValue: (entry) => `${entry.scope}:${entry.target}`,
      render: (entry) => (
        <span className="pv-stack-tight">
          <span>{entry.scope === "global" ? "Everything" : entry.target}</span>
          <span className="pv-meta">{SCOPE_LABEL[entry.scope]}</span>
        </span>
      ),
    },
    {
      key: "engaged",
      header: "State",
      sortValue: (entry) => (entry.engaged ? 0 : 1),
      render: (entry) =>
        entry.engaged ? <Badge tone="danger">Stopped</Badge> : <Badge tone="success">Running</Badge>,
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
      key: "engagedBy",
      header: "Last changed by",
      sortValue: (entry) => entry.engagedBy ?? "",
      render: (entry) =>
        entry.engagedBy === undefined ? (
          <span className="pv-meta">Never changed</span>
        ) : (
          <span className="pv-mono">{entry.engagedBy}</span>
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
    {
      key: "action",
      header: "Action",
      render: (entry) => (
        <Button
          variant={entry.engaged ? "secondary" : "danger"}
          unavailable={controlsUnavailable}
          describedBy={controlsDescribedBy}
          onClick={() =>
            open({ scope: entry.scope, target: entry.target, engaged: !entry.engaged })
          }
        >
          {entry.engaged ? "Release" : "Stop"}
          <span className="pv-sr-only">
            {` ${SCOPE_NOUN[entry.scope]}${entry.target === "" ? "" : ` ${entry.target}`}`}
          </span>
        </Button>
      ),
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>Containment controls</h1>
        <p className="pv-page-lede">
          Stop the platform, a process, an agent role, or an integration. A stop takes effect at the
          next action boundary, so work already running stops rather than finishing.
        </p>
      </div>

      {changeDenial !== undefined && (
        <Denial denial={changeDenial} attempted="changing a containment switch" headingLevel={2} />
      )}

      {changeError !== undefined && (
        <Callout tone="danger" title="The change was not recorded" live="polite">
          <p>{changeError}</p>
          <p className="pv-meta">
            Nothing changed. The switch is in whatever state the table below shows. Submitting again
            is safe: the request carries the same idempotency key.
          </p>
        </Callout>
      )}

      {/* ---------------------------------------------------------------
          Global state, stated before any control.
          --------------------------------------------------------------- */}
      <Panel title={globallyPaused ? "Everything is stopped" : "The platform is running"}>
        {globallyPaused ? (
          <div className="pv-stack">
            <p className="pv-lede-text">
              The global pause is engaged. The platform will take no action of any kind until an
              operator releases it. Work that was in flight stopped at its next step.
            </p>
            <DefinitionList
              items={[
                {
                  term: "Reason given",
                  description:
                    globalSwitch?.reason ?? (
                      <span className="pv-meta">No reason was recorded, which is unusual.</span>
                    ),
                },
                {
                  term: "Stopped by",
                  description:
                    globalSwitch?.engagedBy === undefined ? (
                      <span className="pv-meta">Not recorded</span>
                    ) : (
                      <span className="pv-mono">{globalSwitch.engagedBy}</span>
                    ),
                },
                {
                  term: "Stopped at",
                  description:
                    globalSwitch?.engagedAt === undefined ? (
                      <span className="pv-meta">Not recorded</span>
                    ) : (
                      <time dateTime={globalSwitch.engagedAt}>
                        {formatDateTime(globalSwitch.engagedAt)}
                      </time>
                    ),
                },
              ]}
            />
            <div className="pv-row">
              <Button
                variant="primary"
                unavailable={controlsUnavailable}
                describedBy={controlsDescribedBy}
                onClick={() => open({ scope: "global", target: "", engaged: false })}
              >
                Release the global pause
              </Button>
            </div>
            <p className="pv-meta">
              Releasing the global pause does not release anything else. Any process, role, or
              integration stopped on its own is still stopped.
            </p>
          </div>
        ) : (
          <div className="pv-stack">
            <p className="pv-lede-text">
              The global pause is not engaged. The platform will act where it is otherwise
              permitted to.
            </p>
            <div className="pv-row">
              <Button
                variant="danger"
                unavailable={controlsUnavailable}
                describedBy={controlsDescribedBy}
                onClick={() => open({ scope: "global", target: "", engaged: true })}
              >
                Stop everything
              </Button>
            </div>
            <p className="pv-meta">
              One confirmation, one typed reason, and it takes effect within seconds. Compensating
              steps are the single exception: an action that exists to undo a half-finished change
              is allowed to complete, because leaving the world half-changed is worse than the
              action.
            </p>
          </div>
        )}
      </Panel>

      {targetedEngaged.length > 0 && (
        <Callout
          tone="warning"
          title={`${pluralise(targetedEngaged.length, "thing is", "things are")} stopped individually`}
        >
          <ul className="pv-banner-list">
            {targetedEngaged.map((entry) => (
              <li key={`${entry.scope}:${entry.target}`}>
                {SCOPE_LABEL[entry.scope]}: <span className="pv-mono">{entry.target}</span>
                {entry.reason === undefined ? "" : ` — ${entry.reason}`}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {/* The id sits on a wrapper because `aria-describedby` needs an element to
          point at and the callout owns its own markup. Pointing at the wrapper
          rather than at the paragraph inside it is also what makes the whole
          explanation the description, title included. */}
      {!mayEngage && (
        <div id="containment-not-permitted">
          <Callout tone="info" title="These controls are drawn unavailable">
            <p>
              Your session is not showing the entitlement to change a containment switch. This is
              a courtesy of the console, not a control: the platform decides entitlement when a
              change is submitted.
            </p>
          </Callout>
        </div>
      )}

      {submitting && (
        <p id="containment-submitting" className="pv-meta" role="status">
          Recording the change. The controls are unavailable until the platform answers.
        </p>
      )}

      {/* ---------------------------------------------------------------
          Everything the platform knows about
          --------------------------------------------------------------- */}
      <Panel title="Every switch on record">
        <p className="pv-meta">
          {switches.length === 0
            ? "No switch has ever been set. Nothing is stopped."
            : `${pluralise(switches.length, "switch", "switches")} on record, ${engaged.length} engaged.`}
        </p>

        {/* Still the old DataTable, deliberately. `rowClassName` is what paints
            a stopped row in the denied tone with a bar down its leading edge,
            and `ui/surfaces/Table` has no equivalent: it hardcodes the row's
            class. Pushing the tone into a cell instead would be a weaker claim
            — the whole row is what reads as stopped. Swap this the moment Table
            takes a `rowClassName`. */}
        {switches.length > 0 && (
          <DataTable
            caption={`Containment switches, ${pluralise(switches.length, "switch", "switches")}.`}
            columns={columns}
            rows={switches}
            rowKey={(entry) => `${entry.scope}:${entry.target}`}
            rowClassName={(entry) => (entry.engaged ? "pv-row-denied" : undefined)}
            defaultSort={{ columnKey: "engaged", direction: "ascending" }}
          />
        )}
      </Panel>

      {/* ---------------------------------------------------------------
          Stop something that has never been stopped before
          --------------------------------------------------------------- */}
      <Panel title="Stop something not listed above">
        <p className="pv-meta">
          A switch appears in the table only once it has been set. To stop something for the first
          time, name it here.
        </p>

        <div className="pv-toolbar">
          <Select
            label="What kind of thing"
            hint={SCOPE_HINT[newScope]}
            options={SCOPE_OPTIONS}
            value={newScope}
            onChange={(scope) => setNewScope(scope as ContainmentView["scope"])}
          />

          <Input
            label="Its name"
            hint="The process name, agent role identifier, or integration name, exactly as the platform records it."
            error={targetError}
            value={newTarget}
            onChange={(event) => setNewTarget(event.target.value)}
          />

          <Button
            variant="danger"
            unavailable={controlsUnavailable}
            describedBy={controlsDescribedBy}
            onClick={stopNamedTarget}
          >
            Stop it
          </Button>
        </div>
      </Panel>

      <Modal
        open={pending !== null}
        title={
          pending === null
            ? ""
            : pending.scope === "global" && pending.engaged
              ? "Stop everything?"
              : pending.engaged
                ? `Stop ${SCOPE_LABEL[pending.scope].toLowerCase()}?`
                : "Release this stop?"
        }
        onClose={() => setPending(null)}
        // Cancel below is already the way out, and a second dismissal control
        // competing with it is one more thing to read while an incident runs.
        hideCloseButton
        // A stray click beside the dialog would throw away the typed reason,
        // and the reason is the only part of this the operator cannot get back
        // — it is what the audit entry holds and what the next operator reads.
        dismissOnOutsideClick={false}
        actions={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant={pending?.engaged === true ? "danger" : "primary"}
              onClick={confirm}
            >
              {pending === null
                ? ""
                : pending.scope === "global" && pending.engaged
                  ? "Stop everything now"
                  : pending.engaged
                    ? "Stop it now"
                    : "Release it now"}
            </Button>
          </>
        }
      >
        {pending !== null && pending.scope === "global" && pending.engaged && (
          <Callout tone="danger" title="This stops the whole platform">
            <p>
              No process will take another step. No agent role will act. No integration will be
              called. Anything mid-flight stops at its next action boundary, and only compensating
              steps are allowed to finish.
            </p>
          </Callout>
        )}

        {pending !== null && pending.scope !== "global" && (
          <p>
            {pending.engaged
              ? SCOPE_HINT[pending.scope]
              : "Whatever this covers will be able to run again, unless something broader is still stopped."}
          </p>
        )}

        {pending !== null && (
          <DefinitionList
            items={[
              { term: "Scope", description: SCOPE_LABEL[pending.scope] },
              {
                term: "Target",
                description:
                  pending.target === "" ? (
                    "The whole platform"
                  ) : (
                    <span className="pv-mono">{pending.target}</span>
                  ),
              },
              { term: "Change", description: pending.engaged ? "Stop it" : "Let it run again" },
            ]}
          />
        )}

        <Textarea
          label="Why are you doing this?"
          hint="Recorded in the audit log with your name, and shown to whoever finds this stopped."
          error={reasonError}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Modal>
    </div>
  );
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `console-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Route-level container. */
export function ContainmentControlsRoute() {
  const client = useClient();
  const resource = useResource((signal) => client.containment({ signal }), [client]);
  const sessionResource = useResource((signal) => client.session({ signal }), [client]);

  const [submitting, setSubmitting] = useState(false);
  const [changeError, setChangeError] = useState<string | undefined>(undefined);
  const [changeDenial, setChangeDenial] = useState<DenialView | undefined>(undefined);

  // A fresh key per change: each engage or release is its own decision, and a
  // resubmission after a network failure must carry the key of the change the
  // operator chose rather than of the attempt.
  const idempotencyKey = useRef<string>(newIdempotencyKey());

  const session =
    sessionResource.state.status === "ready" ? sessionResource.state.data : null;
  // A rendering hint. The server re-checks; see the note at the top of the file.
  // Errs toward showing: an operator who cannot see a stop button during an
  // incident is worse off than one who sees a refusal.
  const mayEngage =
    session === null ||
    session.capabilities.length === 0 ||
    session.capabilities.includes("containment.engage");

  async function change(request: ContainmentChangeRequest): Promise<void> {
    setSubmitting(true);
    setChangeError(undefined);
    setChangeDenial(undefined);
    idempotencyKey.current = newIdempotencyKey();
    try {
      const outcome = await client.setContainment({
        scope: request.scope,
        target: request.target,
        engaged: request.engaged,
        reason: request.reason,
        idempotencyKey: idempotencyKey.current,
      });
      if (isDenial(outcome)) setChangeDenial(outcome);
      else resource.reload();
    } catch (cause) {
      setChangeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ResourceView resource={resource} attempted="the containment controls">
      {(page) => (
        <ContainmentControls
          switches={page.items}
          submitting={submitting}
          changeError={changeError}
          changeDenial={changeDenial}
          mayEngage={mayEngage}
          onChange={(request) => {
            void change(request);
          }}
        />
      )}
    </ResourceView>
  );
}
