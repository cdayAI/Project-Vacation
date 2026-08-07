import type { ReactNode } from "react";
import { ReadOnlyChip } from "../surfaces/ReadOnlyChip";
import { SurfaceState } from "../surfaces/SurfaceState";
import { MarkAdded, MarkChanged, MarkRemoved } from "./marks";
import "./DiffView.css";

/**
 * Current beside draft, with every difference named.
 *
 * Spec §3.7 makes a Diff tab mandatory before any configuration is published,
 * which means this component is the last thing standing between an operator and
 * a change to how the platform behaves for thousands of owners. It is built for
 * that moment rather than for looking like a code review.
 *
 * **Difference is never carried by colour.** Every changed row states the
 * change in a word — Added, Removed, Changed — beside a mark whose shape says
 * the same thing, and removed values are struck through as well. Three
 * channels, because the fourth one, colour, is missing entirely from the
 * printed change record that goes in the pack, and is unreliable for the
 * roughly one operator in twelve who cannot separate red from green.
 *
 * **Unchanged rows are hidden by default.** A diff of two hundred settings with
 * three changes in it is not a diff, it is a haystack. They stay available,
 * because "what else is in this config" is a fair question, but the default
 * answers the question the operator actually opened the tab with.
 *
 * **It is a table, not two panels.** Two scrolling columns force the reader to
 * do the alignment themselves, and the value of a diff is entirely in the
 * alignment. A row per field means current and draft are always on the same
 * line, at every width, in every print.
 */

export type DiffChange = "added" | "removed" | "changed" | "unchanged";

const CHANGE_WORDS: Readonly<Record<DiffChange, string>> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  unchanged: "Unchanged",
};

const CHANGE_MARKS = {
  added: MarkAdded,
  removed: MarkRemoved,
  changed: MarkChanged,
  unchanged: null,
} as const;

export interface DiffRow {
  readonly id: string;
  /** The field. "Escalation threshold", "Notice template". */
  readonly label: string;
  /** The live value. Absent on an addition. */
  readonly current?: ReactNode;
  /** The proposed value. Absent on a removal. */
  readonly draft?: ReactNode;
  readonly change: DiffChange;
  /** Renders both values as a monospace block, for templates and expressions. */
  readonly multiline?: boolean;
}

export interface DiffViewProps {
  /** Names the table. "Changes to policy R-14", not "Diff". */
  readonly label: string;
  readonly rows: readonly DiffRow[];
  readonly currentLabel?: string;
  readonly draftLabel?: string;
  /** Shows the rows that did not change. Off by default. */
  readonly showUnchanged?: boolean;
  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  /** Says once that this draft cannot be edited from here. */
  readonly readOnly?: boolean;
  readonly className?: string;
}

export function DiffView({
  label,
  rows,
  currentLabel = "Current",
  draftLabel = "Draft",
  showUnchanged = false,
  loading = false,
  error,
  empty,
  readOnly = false,
  className,
}: DiffViewProps) {
  const changed = rows.filter((row) => row.change !== "unchanged");
  const shown = showUnchanged ? rows : changed;

  return (
    <div className={className === undefined ? "pv-diff" : `pv-diff ${className}`}>
      <div className="pv-diff-header">
        {/* The count first. An operator about to publish wants to know how big
            this is before they know what it is. */}
        <p className="pv-diff-summary">{summarize(rows)}</p>
        {readOnly ? <ReadOnlyChip /> : null}
      </div>

      <SurfaceState
        loading={loading}
        error={error}
        empty={empty ?? "The draft matches what is live. There is nothing to publish."}
        skeletonLines={3}
      >
        {shown.length === 0 ? null : (
          <div className="pv-diff-scroll">
            <table className="pv-diff-table">
              <caption className="pv-sr-only">{label}</caption>
              <thead>
                <tr>
                  <th scope="col">Change</th>
                  <th scope="col">Field</th>
                  <th scope="col">{currentLabel}</th>
                  <th scope="col">{draftLabel}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  const Mark = CHANGE_MARKS[row.change];
                  return (
                    <tr key={row.id} className="pv-diff-row" data-change={row.change}>
                      <td className="pv-diff-change">
                        <span className="pv-diff-change-mark">
                          {Mark === null ? null : <Mark size="sm" />}
                          {CHANGE_WORDS[row.change]}
                        </span>
                      </td>
                      <th scope="row" className="pv-diff-field">
                        {row.label}
                      </th>
                      <td className="pv-diff-value" data-side="current" data-block={row.multiline}>
                        {row.current === undefined ? (
                          <span className="pv-diff-absent">Not set</span>
                        ) : (
                          <span className="pv-diff-current">{row.current}</span>
                        )}
                      </td>
                      <td className="pv-diff-value" data-side="draft" data-block={row.multiline}>
                        {row.draft === undefined ? (
                          // Not the word "Removed" again: that word is already
                          // in the Change column on this row, and a value that
                          // repeats its own row's label teaches nothing.
                          <span className="pv-diff-absent">Not in the draft</span>
                        ) : (
                          row.draft
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SurfaceState>
    </div>
  );
}

function summarize(rows: readonly DiffRow[]): string {
  const counts = {
    added: rows.filter((row) => row.change === "added").length,
    removed: rows.filter((row) => row.change === "removed").length,
    changed: rows.filter((row) => row.change === "changed").length,
  };
  const total = counts.added + counts.removed + counts.changed;
  if (total === 0) return "No changes.";

  const parts: string[] = [];
  if (counts.added > 0) parts.push(`${counts.added} added`);
  if (counts.removed > 0) parts.push(`${counts.removed} removed`);
  if (counts.changed > 0) parts.push(`${counts.changed} changed`);
  return `${total} ${total === 1 ? "change" : "changes"}: ${parts.join(", ")}.`;
}
