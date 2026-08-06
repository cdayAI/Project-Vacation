import { useState, type FormEvent } from "react";
import { useClient } from "../api/ClientProvider";
import type { AuditEntryView, AuditVerificationView } from "../api/contract";
import { useResource } from "../api/useResource";
import {
  Badge,
  Button,
  Callout,
  DataTable,
  DefinitionList,
  EmptyState,
  Field,
  type Column,
  type DefinitionItem,
} from "../components";
import { formatCount, formatDateTime, pluralise } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";

/**
 * The audit and evidence view.
 *
 * The stated requirement for this screen is that a compliance officer can use
 * it unaided, so it is written for that reader rather than for the engineer who
 * built the log. Every label is the question the reader is actually asking:
 * "what happened", "who or what did it", "what it was about", not
 * `eventType`, `actor`, `subject`.
 *
 * Three things follow from that reader:
 *
 * **Verification is the first thing on the page.** Whether the record is intact
 * governs whether anything below it is worth reading. When it is not intact,
 * every break is listed with its kind and its sequence number — not a count,
 * not "verification failed", the actual breaks — because the first question
 * after "is it broken" is "where".
 *
 * **The fingerprint explanation is on the screen.** A compliance officer will
 * ask why the log does not contain the documents themselves. The answer is
 * short, it is a design decision with a defensible reason, and asking them to
 * find it in an architecture document is asking them to take it on trust.
 *
 * **Filtering happens on the server.** A filter applied to whichever page
 * happened to load would answer a different question from the one asked, and
 * "no entries of that type" is precisely the kind of wrong answer that ends up
 * in a report.
 */

/**
 * What each recorded event means, in the words a compliance officer would use.
 *
 * The raw code is shown alongside, never instead: a reader who is going to
 * quote an entry in a finding needs the identifier the platform actually used.
 * An unrecognised code falls through to the code itself rather than to a guess.
 */
const EVENT_LABEL: Readonly<Record<string, string>> = {
  "authorization.granted": "An action was allowed",
  "authorization.denied": "An action was refused",
  "approval.requested": "A human approval was requested",
  "approval.granted": "A person approved an action",
  "approval.rejected": "A person rejected an action",
  "approval.expired": "An approval expired before it was used",
  "approval.consumed": "An approval was used to authorise an action",
  "ceiling.exceeded": "A spending, rate, or time limit was reached",
  "containment.engaged": "An operator stopped something",
  "containment.released": "An operator released a stop",
  "screen.blocked": "Untrusted input was refused before it reached a model",
  "sandbox.rejected": "The execution sandbox refused to run something",
  "run.started": "A piece of work started",
  "run.ended": "A piece of work ended",
  "step.recorded": "A step of a piece of work was recorded",
  "workflow.instance_started": "A process started",
  "workflow.instance_ended": "A process ended",
  "workflow.definition_published": "A new version of a process was published",
  "model.invoked": "A model was called",
  "model.degraded": "A model call was degraded or fell back",
  "role.proposed": "A new version of an agent role was proposed",
  "role.promoted": "An agent role was put into service",
  "role.reverted": "An agent role was taken back to an earlier version",
  "role.disabled": "An agent role was disabled",
  "evaluation.completed": "An agent role was measured against its curated set",
  "corpus.ingested": "A governed document was loaded",
  "corpus.ingest_rejected": "A document was refused at loading",
  "knowledge.answer_grounded": "An answer was produced with cited sources",
  "knowledge.answer_refused": "An answer was refused for want of a citable source",
  "contact.gate_passed": "An outbound message passed contact compliance",
  "contact.gate_blocked": "An outbound message was blocked by contact compliance",
  "consent.recorded": "Consent was recorded",
  "consent.revoked": "Consent was withdrawn",
  "document.generated": "A document was produced",
  "improvement.observation_recorded": "An observation was recorded for the improvement loop",
  "improvement.proposal_created": "An improvement was proposed",
  "improvement.proposal_evaluated": "An improvement proposal was measured",
  "improvement.proposal_approved": "A person approved an improvement",
  "improvement.proposal_rejected": "A person rejected an improvement",
  "improvement.applied": "An approved improvement was applied",
  "improvement.reverted": "An applied improvement was taken back out",
  "improvement.refused": "An attempt to apply an improvement without approval was refused",
  "identity.session_started": "Somebody signed in",
  "identity.step_up_completed": "Somebody proved their identity again",
  "subject_rights.request_recorded": "A data subject rights request was recorded",
  "subject_rights.fulfilled": "A data subject rights request was fulfilled",
  "retention.purged": "Data was deleted under the retention policy",
  "discovery.enrolled": "Somebody enrolled in work discovery",
  "discovery.revoked": "Somebody withdrew from work discovery",
  "discovery.erased": "Work discovery observations were erased",
};

/** The families offered in the filter, in the order a reader would look for them. */
const EVENT_GROUPS: readonly {
  readonly label: string;
  readonly options: readonly string[];
}[] = [
  {
    label: "Governance decisions",
    options: [
      "authorization.granted",
      "authorization.denied",
      "approval.requested",
      "approval.granted",
      "approval.rejected",
      "approval.expired",
      "approval.consumed",
      "ceiling.exceeded",
      "containment.engaged",
      "containment.released",
      "screen.blocked",
      "sandbox.rejected",
    ],
  },
  {
    label: "Work",
    options: [
      "run.started",
      "run.ended",
      "step.recorded",
      "workflow.instance_started",
      "workflow.instance_ended",
      "workflow.definition_published",
    ],
  },
  {
    label: "Agent roles and models",
    options: [
      "role.proposed",
      "role.promoted",
      "role.reverted",
      "role.disabled",
      "evaluation.completed",
      "model.invoked",
      "model.degraded",
    ],
  },
  {
    label: "Documents and knowledge",
    options: [
      "corpus.ingested",
      "corpus.ingest_rejected",
      "knowledge.answer_grounded",
      "knowledge.answer_refused",
      "document.generated",
    ],
  },
  {
    label: "Owners and consumers",
    options: ["contact.gate_passed", "contact.gate_blocked", "consent.recorded", "consent.revoked"],
  },
  {
    label: "Improvements",
    options: [
      "improvement.proposal_created",
      "improvement.proposal_approved",
      "improvement.proposal_rejected",
      "improvement.applied",
      "improvement.reverted",
      "improvement.refused",
    ],
  },
  {
    label: "Identity and data rights",
    options: [
      "identity.session_started",
      "identity.step_up_completed",
      "subject_rights.request_recorded",
      "subject_rights.fulfilled",
      "retention.purged",
    ],
  },
];

export function eventLabel(eventType: string): string {
  return EVENT_LABEL[eventType] ?? eventType;
}

export interface AuditFilters {
  readonly eventType: string;
  readonly actorId: string;
  readonly runId: string;
  readonly subject: string;
  readonly from: string;
  readonly to: string;
}

export const NO_AUDIT_FILTERS: AuditFilters = {
  eventType: "",
  actorId: "",
  runId: "",
  subject: "",
  from: "",
  to: "",
};

function isFiltered(filters: AuditFilters): boolean {
  return Object.values(filters).some((value) => value !== "");
}

export interface AuditEvidenceProps {
  readonly entries: readonly AuditEntryView[];
  readonly verification: AuditVerificationView;
  readonly total?: number;
  readonly filters: AuditFilters;
  readonly onFiltersChange: (filters: AuditFilters) => void;
}

export function AuditEvidence({
  entries,
  verification,
  total,
  filters,
  onFiltersChange,
}: AuditEvidenceProps) {
  // The form holds a draft so that typing a contract id does not refetch the
  // record on every keystroke. Applying is an explicit act, which is also what
  // makes the filter set quotable: what is on screen is what was asked for.
  const [draft, setDraft] = useState<AuditFilters>(filters);

  function apply(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onFiltersChange(draft);
  }

  function clear(): void {
    setDraft(NO_AUDIT_FILTERS);
    onFiltersChange(NO_AUDIT_FILTERS);
  }

  const breakColumns: readonly Column<AuditVerificationView["breaks"][number]>[] = [
    {
      key: "seq",
      header: "Entry number",
      rowHeader: true,
      numeric: true,
      sortValue: (problem) => problem.seq,
      render: (problem) => <span>{formatCount(problem.seq)}</span>,
    },
    {
      key: "kind",
      header: "Kind of break",
      sortValue: (problem) => problem.kind,
      render: (problem) => (
        <Badge tone="danger" glyph="▲">
          {problem.kind.replace(/_/g, " ")}
        </Badge>
      ),
    },
    {
      key: "detail",
      header: "What it means",
      sortValue: (problem) => problem.detail,
      render: (problem) => <span>{problem.detail}</span>,
    },
  ];

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <h1>Audit and evidence</h1>
        <p className="pv-page-lede">
          Every decision this platform made, in the order it made them, in a record that cannot be
          altered after the fact without the alteration showing.
        </p>
      </div>

      {/* ---------------------------------------------------------------
          Is the record intact? Everything else depends on the answer.
          --------------------------------------------------------------- */}
      <section
        className={
          verification.intact
            ? "pv-panel pv-panel-verified"
            : "pv-panel pv-panel-alarm"
        }
        aria-labelledby="audit-verification"
      >
        <h2 className="pv-panel-heading" id="audit-verification">
          Is this record intact?
        </h2>

        {verification.intact ? (
          <>
            <p className="pv-lede-text">
              <Badge tone="success" glyph="✓">
                Verified intact
              </Badge>{" "}
              Every one of the {formatCount(verification.entriesChecked)} entries checked links
              correctly to the one before it. Nothing has been removed, inserted, back-dated, or
              altered since it was written.
            </p>
            <DefinitionList
              items={[
                {
                  term: "Last checked",
                  description: (
                    <time dateTime={verification.verifiedAt}>
                      {formatDateTime(verification.verifiedAt)}
                    </time>
                  ),
                },
                {
                  term: "Entries checked",
                  description: `${formatCount(verification.entriesChecked)} — entry ${
                    verification.firstSeq === null ? "none" : formatCount(verification.firstSeq)
                  } through ${
                    verification.lastSeq === null ? "none" : formatCount(verification.lastSeq)
                  }`,
                },
                {
                  term: "Fingerprint of the most recent entry",
                  description:
                    verification.headHash === null ? (
                      <span className="pv-meta">Not recorded</span>
                    ) : (
                      <span className="pv-digest">{verification.headHash}</span>
                    ),
                },
              ]}
            />
          </>
        ) : (
          <>
            <Callout tone="danger" title="This record does not verify">
              <p>
                The chain of entries is broken in {pluralise(verification.breaks.length, "place", "places")}.
                Until each break is explained, the entries at and after the first break cannot be
                relied on as evidence — and neither can a statement that the rest are fine.
              </p>
              <p className="pv-meta">
                A break is not proof that somebody tampered with the record. A restore from backup,
                a partial migration, or a clock moving backwards will each produce one. It does
                mean the record can no longer prove, by itself, that it was not tampered with.
              </p>
            </Callout>

            <div className="pv-space-above">
              <DataTable
                caption={`Breaks found in the record, ${pluralise(verification.breaks.length, "break", "breaks")}, earliest first.`}
                columns={breakColumns}
                rows={verification.breaks}
                rowKey={(problem) => `${problem.kind}-${problem.seq}`}
                defaultSort={{ columnKey: "seq", direction: "ascending" }}
              />
            </div>

            <p className="pv-meta pv-space-above">
              Checked{" "}
              <time dateTime={verification.verifiedAt}>
                {formatDateTime(verification.verifiedAt)}
              </time>{" "}
              across {formatCount(verification.entriesChecked)} entries.
            </p>
          </>
        )}
      </section>

      {/* ---------------------------------------------------------------
          The question every compliance officer asks about this log.
          --------------------------------------------------------------- */}
      <section className="pv-panel" aria-labelledby="audit-what-is-recorded">
        <h2 className="pv-panel-heading" id="audit-what-is-recorded">
          What this record contains, and what it does not
        </h2>
        <p>
          Each entry records the decision that was made, who or what made it, and a{" "}
          <strong>fingerprint</strong> of the information it was made from &mdash; a short code
          computed from the document or request, which changes completely if so much as a character
          of the original changes. The originals themselves are not copied here. That is deliberate:
          it lets this record prove which exact version of a contract, policy, or message a decision
          was based on, while keeping owner personal data in the systems that are entitled to hold
          it, so that a deletion request can be honoured without breaking the evidence trail. To see
          an original, fetch it from its system of record and check its fingerprint against the one
          recorded here; if they match, it is the document the decision was made from.
        </p>
      </section>

      {/* ---------------------------------------------------------------
          Filters
          --------------------------------------------------------------- */}
      <section className="pv-panel" aria-labelledby="audit-filters">
        <h2 className="pv-panel-heading" id="audit-filters">
          Find entries
        </h2>

        <form className="pv-filter-form" onSubmit={apply}>
          <div className="pv-toolbar">
            <Field label="What happened">
              {(control) => (
                <select
                  id={control.id}
                  className="pv-select"
                  value={draft.eventType}
                  onChange={(event) => setDraft({ ...draft, eventType: event.target.value })}
                >
                  <option value="">Anything</option>
                  {EVENT_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((option) => (
                        <option key={option} value={option}>
                          {eventLabel(option)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              )}
            </Field>

            <Field
              label="Who or what did it"
              hint="A person or agent identifier, such as act_7f3a91c2."
            >
              {(control) => (
                <input
                  id={control.id}
                  className="pv-input"
                  type="text"
                  aria-describedby={control.describedBy}
                  value={draft.actorId}
                  onChange={(event) => setDraft({ ...draft, actorId: event.target.value })}
                />
              )}
            </Field>

            <Field label="Piece of work" hint="A run identifier, such as run_01k3m9x2p7.">
              {(control) => (
                <input
                  id={control.id}
                  className="pv-input"
                  type="text"
                  aria-describedby={control.describedBy}
                  value={draft.runId}
                  onChange={(event) => setDraft({ ...draft, runId: event.target.value })}
                />
              )}
            </Field>

            <Field
              label="What it was about"
              hint="A contract, loan, association, or role identifier."
            >
              {(control) => (
                <input
                  id={control.id}
                  className="pv-input"
                  type="text"
                  aria-describedby={control.describedBy}
                  value={draft.subject}
                  onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
                />
              )}
            </Field>

            <Field label="Recorded on or after">
              {(control) => (
                <input
                  id={control.id}
                  className="pv-input"
                  type="date"
                  value={draft.from}
                  onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                />
              )}
            </Field>

            <Field label="Recorded on or before">
              {(control) => (
                <input
                  id={control.id}
                  className="pv-input"
                  type="date"
                  value={draft.to}
                  onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                />
              )}
            </Field>
          </div>

          <div className="pv-row">
            <Button variant="primary" type="submit">
              Apply these filters
            </Button>
            <Button variant="secondary" onClick={clear}>
              Clear all filters
            </Button>
          </div>
        </form>
      </section>

      <p role="status" className="pv-meta">
        Showing {pluralise(entries.length, "entry", "entries")}
        {total !== undefined && total !== entries.length
          ? ` of ${formatCount(total)} that match`
          : ""}
        {isFiltered(filters) ? ", filtered" : ", unfiltered"}.
      </p>

      {entries.length === 0 ? (
        <EmptyState
          title={
            isFiltered(filters) ? "No entry matches these filters" : "This record has no entries"
          }
          body={
            isFiltered(filters)
              ? "Nothing in the record matches what you asked for. Widen a filter — an empty result here means no matching entry exists, not that none was loaded."
              : "Nothing has been recorded yet. An empty record on a platform that has run is itself worth asking about."
          }
          headingLevel={2}
        />
      ) : (
        <ol className="pv-steps">
          {entries.map((entry) => (
            <AuditEntry entry={entry} key={entry.entryId} />
          ))}
        </ol>
      )}
    </div>
  );
}

function AuditEntry({ entry }: { readonly entry: AuditEntryView }) {
  const subjectEntries = Object.entries(entry.subject);
  const decisionEntries = Object.entries(entry.decision);
  const digestEntries = Object.entries(entry.inputDigests);

  const items: DefinitionItem[] = [
    {
      term: "When",
      description: <time dateTime={entry.recordedAt}>{formatDateTime(entry.recordedAt)}</time>,
    },
    {
      term: "Who or what did it",
      description: (
        <span>
          {entry.actor.displayName}
          {entry.actor.roles.length > 0 ? ` — ${entry.actor.roles.join(", ")}` : ""}{" "}
          <span className="pv-meta pv-mono">{entry.actor.actorId}</span>
        </span>
      ),
    },
    {
      term: "Piece of work",
      description:
        entry.runId === undefined ? (
          <span className="pv-meta">Not part of a run</span>
        ) : (
          <Link to={`/runs/${entry.runId}`}>
            <span className="pv-mono">{entry.runId}</span>
          </Link>
        ),
    },
    {
      term: "What it was about",
      description:
        subjectEntries.length === 0 ? (
          <span className="pv-meta">No subject recorded</span>
        ) : (
          <DefinitionList
            items={subjectEntries.map(([key, value]) => ({
              term: key,
              description: <span className="pv-mono">{value}</span>,
            }))}
          />
        ),
    },
    {
      term: "What was decided",
      description:
        decisionEntries.length === 0 ? (
          <span className="pv-meta">No decision detail recorded</span>
        ) : (
          <DefinitionList
            items={decisionEntries.map(([key, value]) => ({
              term: key,
              description: <span className="pv-mono">{String(value)}</span>,
            }))}
          />
        ),
    },
    {
      term: "Fingerprints of what it was decided from",
      description:
        digestEntries.length === 0 ? (
          <span className="pv-meta">
            This decision was made from no recorded input — for example, an operator throwing a
            switch.
          </span>
        ) : (
          <DefinitionList
            items={digestEntries.map(([key, value]) => ({
              term: key,
              description: <span className="pv-digest">{value}</span>,
            }))}
          />
        ),
    },
    {
      term: "This entry's own fingerprint",
      description: <span className="pv-digest">{entry.entryHash}</span>,
    },
    {
      term: "Fingerprint of the entry before it",
      description: <span className="pv-digest">{entry.previousHash}</span>,
    },
  ];

  return (
    <li className="pv-step">
      <div className="pv-step-heading">
        <span className="pv-step-seq">Entry {formatCount(entry.seq)}</span>
        <h3>{eventLabel(entry.eventType)}</h3>
        <Badge tone="neutral">
          <span className="pv-mono">{entry.eventType}</span>
        </Badge>
      </div>
      <DefinitionList items={items} stacked />
    </li>
  );
}

/**
 * Route-level container.
 *
 * Filter state lives here and is passed to the API, so a filtered view is the
 * record's answer rather than the browser's opinion about one page of it.
 */
export function AuditEvidenceRoute() {
  const client = useClient();
  const [filters, setFilters] = useState<AuditFilters>(NO_AUDIT_FILTERS);

  const entries = useResource(
    (signal) =>
      client.auditEntries(
        {
          ...(filters.eventType === "" ? {} : { eventType: filters.eventType }),
          ...(filters.actorId === "" ? {} : { actorId: filters.actorId }),
          ...(filters.runId === "" ? {} : { runId: filters.runId }),
          ...(filters.subject === "" ? {} : { subject: filters.subject }),
          ...(filters.from === "" ? {} : { from: filters.from }),
          ...(filters.to === "" ? {} : { to: filters.to }),
        },
        { signal },
      ),
    [client, filters],
  );

  const verification = useResource((signal) => client.auditVerification({ signal }), [client]);

  return (
    <ResourceView resource={verification} attempted="the record's verification status">
      {(verified) => (
        <ResourceView resource={entries} attempted="the audit record">
          {(page) => (
            <AuditEvidence
              entries={page.items}
              verification={verified}
              total={page.total}
              filters={filters}
              onFiltersChange={setFilters}
            />
          )}
        </ResourceView>
      )}
    </ResourceView>
  );
}
