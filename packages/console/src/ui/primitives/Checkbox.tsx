import { useEffect, useId, useRef, type ComponentPropsWithRef, type ReactNode } from "react";
import { cx } from "./classes";
import { IconAlert, IconCheck, IconDash } from "./icons";
import "./Checkbox.css";

/**
 * Checkbox — one independent yes/no.
 *
 * Built on the real input rather than on a div with `role="checkbox"`, because
 * the platform gives away for free the four things a hand-built one gets wrong:
 * the announcement of "checked", the indeterminate state, Space, and the form
 * value. What we draw is a picture layered over the input, and `:checked` and
 * `:indeterminate` in CSS decide which mark shows — so React never holds a
 * second copy of a state the DOM already owns.
 *
 * `indeterminate` exists only as a DOM property; there is no attribute for it,
 * which is why it is applied in an effect rather than in JSX. It is what a
 * "select all" checkbox shows above a partially selected queue.
 */

export interface CheckboxProps
  extends Omit<
    ComponentPropsWithRef<"input">,
    "type" | "className" | "children" | "size" | "aria-describedby"
  > {
  readonly label: ReactNode;
  /** What choosing this actually does. Read before the box is ticked. */
  readonly hint?: string;
  readonly error?: string;
  /** Partially selected — some of what this box covers, not all. */
  readonly indeterminate?: boolean;
  /**
   * Designed read-only: the mark and the word, no box and no affordance.
   * Distinct from `disabled`, which means "you could change this, but not now".
   */
  readonly readOnly?: boolean;
  readonly className?: string;
}

export function Checkbox({
  label,
  hint,
  error,
  indeterminate = false,
  readOnly = false,
  disabled = false,
  className,
  id,
  checked,
  defaultChecked,
  ...rest
}: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inputRef.current !== null) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const described = [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
    .filter((part): part is string => part !== null)
    .join(" ");

  const marks = (
    <span className="pv-ui-checkbox-box">
      <IconCheck className="pv-ui-checkbox-mark pv-ui-checkbox-mark-check" size="sm" />
      <IconDash className="pv-ui-checkbox-mark pv-ui-checkbox-mark-dash" size="sm" />
    </span>
  );

  if (readOnly) {
    const selected = checked ?? defaultChecked ?? false;
    return (
      <div className={cx("pv-ui-checkbox", className)} data-readonly="true">
        <span className="pv-ui-checkbox-control">
          {indeterminate ? (
            <span className="pv-ui-checkbox-box">
              <IconDash className="pv-ui-checkbox-mark" size="sm" />
            </span>
          ) : selected ? (
            <span className="pv-ui-checkbox-box">
              <IconCheck className="pv-ui-checkbox-mark" size="sm" />
            </span>
          ) : (
            <span className="pv-ui-checkbox-box" />
          )}
        </span>
        <span className="pv-ui-checkbox-body">
          <span className="pv-ui-checkbox-label">
            {label}
            {/* The word, not the tint. This is what an auditor reads, and what
                survives the pack being printed in black and white. */}
            <span className="pv-ui-checkbox-state">
              {indeterminate ? "Partly selected" : selected ? "Selected" : "Not selected"}
            </span>
          </span>
          {hint !== undefined && <span className="pv-ui-checkbox-hint">{hint}</span>}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cx("pv-ui-checkbox", className)}
      data-disabled={disabled ? "true" : undefined}
    >
      <span className="pv-ui-checkbox-control">
        <input
          {...rest}
          ref={inputRef}
          id={inputId}
          type="checkbox"
          className="pv-ui-checkbox-input"
          checked={checked}
          defaultChecked={defaultChecked}
          disabled={disabled}
          aria-describedby={described.length > 0 ? described : undefined}
          aria-invalid={error !== undefined ? true : undefined}
        />
        {marks}
      </span>
      <span className="pv-ui-checkbox-body">
        <label className="pv-ui-checkbox-label" htmlFor={inputId}>
          {label}
        </label>
        {hint !== undefined && (
          <span className="pv-ui-checkbox-hint" id={hintId}>
            {hint}
          </span>
        )}
        {error !== undefined && (
          <span className="pv-ui-checkbox-error" id={errorId}>
            <IconAlert size="sm" />
            {error}
          </span>
        )}
      </span>
    </div>
  );
}
