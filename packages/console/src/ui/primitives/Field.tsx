import { useId, type ReactNode } from "react";
import { cx } from "./classes";
import { Chip } from "./Chip";
import { IconAlert, IconLock } from "./icons";
import "./Field.css";

/**
 * The label, hint, error, and read-only marker around a control — and, more
 * importantly, the wiring between them.
 *
 * The control is supplied through a render function rather than cloned from
 * `children`. Cloning props onto an unknown element quietly stops working the
 * moment somebody wraps the input in a div, and the props it would be dropping
 * — `id`, `aria-describedby`, `aria-invalid` — are exactly the ones a screen
 * reader user depends on. A render function cannot fail that way: the control
 * either takes the props or does not compile.
 *
 * Two shapes:
 *
 *   default   a `<label>` bound to one control by `htmlFor`.
 *   group     a `<fieldset>` and `<legend>` for a set of controls that share
 *             one question — radios, a date range. The description is applied
 *             to the fieldset here, because a group has no single control to
 *             hang it on.
 */

export interface FieldControlProps {
  /** Put this on the control. The label's `htmlFor` already points at it. */
  readonly id: string;
  /** Put this on the control, or the hint and the error are invisible to AT. */
  readonly describedBy: string | undefined;
  /** True while an error is showing. Set `aria-invalid` from it. */
  readonly invalid: boolean;
  readonly required: boolean;
  readonly readOnly: boolean;
}

export interface FieldProps {
  readonly label: string;
  /**
   * Hides the label visually and keeps it for assistive technology. For a
   * control whose purpose is obvious from its surroundings to someone who can
   * see them — a search box under a magnifier, a filter above its table.
   */
  readonly labelHidden?: boolean;
  /**
   * What the operator needs to know *before* typing: the accepted format, the
   * unit, the limit. Rendered above the control for that reason — a hint below
   * it is a hint read after the mistake.
   */
  readonly hint?: string;
  /** Present means invalid. The words say what to do, never just what is wrong. */
  readonly error?: string;
  readonly required?: boolean;
  /** Renders the read-only chip and passes `readOnly` down to the control. */
  readonly readOnly?: boolean;
  /** Renders a `<fieldset>`/`<legend>` instead of a `<label>`. */
  readonly group?: boolean;
  /** Below the control: a character counter, a resolved value, a footnote. */
  readonly footer?: ReactNode;
  /** Supply this to bind the field to a control the caller already owns. */
  readonly id?: string;
  readonly className?: string;
  readonly children: (control: FieldControlProps) => ReactNode;
}

export function Field({
  label,
  labelHidden = false,
  hint,
  error,
  required = false,
  readOnly = false,
  group = false,
  footer,
  id: providedId,
  className,
  children,
}: FieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const described = [
    hint !== undefined ? hintId : null,
    error !== undefined ? errorId : null,
  ].filter((part): part is string => part !== null);
  const describedBy = described.length > 0 ? described.join(" ") : undefined;

  // A span rather than a div: in group mode this sits inside a `<legend>`,
  // whose content model is phrasing content, and a div in there is invalid
  // markup that no accessibility test will catch.
  const headerContent = (
    <span className="pv-ui-field-header">
      {group ? (
        <span className="pv-ui-field-label">{label}</span>
      ) : (
        <label className="pv-ui-field-label" htmlFor={id}>
          {label}
        </label>
      )}
      {required && !readOnly && <span className="pv-ui-field-requirement">Required</span>}
      {readOnly && (
        <Chip size="sm" icon={<IconLock size="sm" />}>
          Read-only
        </Chip>
      )}
    </span>
  );

  // A `<legend>` names its group only while it is the fieldset's first child,
  // and it renders unpredictably as a flex container in more than one engine.
  // So the legend stays a plain first child and the layout happens one level in.
  const header = group ? (
    <legend className={cx(labelHidden && "pv-sr-only")}>{headerContent}</legend>
  ) : (
    <div className={cx(labelHidden && "pv-sr-only")}>{headerContent}</div>
  );

  const body = (
    <>
      {header}
      {hint !== undefined && (
        <span className="pv-ui-field-hint" id={hintId}>
          {hint}
        </span>
      )}
      {children({
        id,
        // A grouped field hangs its description on the fieldset, so passing it
        // down as well would have a screen reader read the hint twice.
        describedBy: group ? undefined : describedBy,
        invalid: error !== undefined,
        required,
        readOnly,
      })}
      <div className="pv-ui-field-message" aria-live="polite">
        {error !== undefined && (
          <span className="pv-ui-field-error" id={errorId}>
            <IconAlert className="pv-ui-field-error-icon" size="sm" />
            {error}
          </span>
        )}
      </div>
      {footer !== undefined && <div className="pv-ui-field-footer">{footer}</div>}
    </>
  );

  if (group) {
    return (
      <fieldset
        className={cx("pv-ui-field", className)}
        data-readonly={readOnly ? "true" : undefined}
        aria-describedby={describedBy}
        aria-invalid={error !== undefined ? true : undefined}
      >
        {body}
      </fieldset>
    );
  }

  return (
    <div
      className={cx("pv-ui-field", className)}
      data-readonly={readOnly ? "true" : undefined}
    >
      {body}
    </div>
  );
}
