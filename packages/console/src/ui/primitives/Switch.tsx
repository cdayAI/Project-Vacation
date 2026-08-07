import { useId } from "react";
import { cx } from "./classes";
import { IconAlert } from "./icons";
import "./Switch.css";

/**
 * Switch — a setting that takes effect the moment it is flipped.
 *
 * A `<button role="switch">` rather than a styled checkbox. `role="switch"` is
 * announced as "on"/"off" instead of "checked"/"unchecked", which is the
 * distinction that matters: a checkbox is an answer that gets saved with the
 * form, a switch is a change that has already happened. Using the wrong one is
 * how an operator comes to believe they turned containment off when they did
 * not.
 *
 * The state is also written beside the track in words. A switch is the control
 * people misread most — "is left on or off?" is a real question that gets asked
 * of real interfaces — and the answer costs one span.
 */

export interface SwitchProps {
  readonly label: string;
  /** What flipping it does, and when it takes effect. */
  readonly hint?: string;
  readonly error?: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly onLabel?: string;
  readonly offLabel?: string;
  readonly disabled?: boolean;
  /** Designed read-only: the shape and the word, no affordance. */
  readonly readOnly?: boolean;
  /** The id of a sentence explaining why it cannot be changed. */
  readonly describedBy?: string;
  readonly id?: string;
  readonly className?: string;
}

export function Switch({
  label,
  hint,
  error,
  checked,
  onChange,
  onLabel = "On",
  offLabel = "Off",
  disabled = false,
  readOnly = false,
  describedBy,
  id,
  className,
}: SwitchProps) {
  const generatedId = useId();
  const rootId = id ?? generatedId;
  const labelId = `${rootId}-label`;
  const hintId = `${rootId}-hint`;
  const errorId = `${rootId}-error`;

  const described = [
    hint !== undefined ? hintId : null,
    error !== undefined ? errorId : null,
    describedBy ?? null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  const stateWord = checked ? onLabel : offLabel;

  return (
    <div
      className={cx("pv-ui-switch", className)}
      data-readonly={readOnly ? "true" : undefined}
    >
      <span className="pv-ui-switch-body">
        <span className="pv-ui-switch-label" id={labelId}>
          {label}
        </span>
        {hint !== undefined && (
          <span className="pv-ui-switch-hint" id={hintId}>
            {hint}
          </span>
        )}
      </span>

      {/* Hidden from assistive technology because `aria-checked` already says
          it, and hearing "Auto-assign, On, switch, on" is noise, not detail.
          In read-only there is no switch to carry the state, so the word is
          the announcement. */}
      <span className="pv-ui-switch-state" aria-hidden={readOnly ? undefined : true}>
        {stateWord}
      </span>

      {readOnly ? (
        <span className="pv-ui-switch-track" data-checked={checked ? "true" : undefined}>
          <span className="pv-ui-switch-thumb" />
        </span>
      ) : (
        <button
          type="button"
          id={rootId}
          className="pv-ui-switch-track"
          role="switch"
          aria-checked={checked}
          aria-labelledby={labelId}
          aria-describedby={described.length > 0 ? described : undefined}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        >
          <span className="pv-ui-switch-thumb" />
        </button>
      )}

      {error !== undefined && (
        <span className="pv-ui-switch-error" id={errorId}>
          <IconAlert size="sm" />
          {error}
        </span>
      )}
    </div>
  );
}
