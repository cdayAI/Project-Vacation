import { useId, type ReactNode } from "react";

export interface FieldControlProps {
  /** Put this on the control. The label's `htmlFor` already points at it. */
  readonly id: string;
  /** Put this on the control, or the hint and error are invisible to screen readers. */
  readonly describedBy: string | undefined;
  /** True when an error is showing; set `aria-invalid` from it. */
  readonly invalid: boolean;
}

export interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: (control: FieldControlProps) => ReactNode;
}

/**
 * Label, hint, error, and the wiring between them.
 *
 * The control is supplied by the caller through a render function rather than
 * cloned from `children`. Cloning props onto an unknown element is the kind of
 * thing that silently stops working when someone wraps the input in a div, and
 * the wiring it would be dropping — `id`, `aria-describedby`, `aria-invalid` —
 * is exactly the wiring that a screen-reader user depends on.
 */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedByParts: string[] = [];
  if (hint !== undefined) describedByParts.push(hintId);
  if (error !== undefined) describedByParts.push(errorId);
  const describedBy = describedByParts.length > 0 ? describedByParts.join(" ") : undefined;

  return (
    <div className="pv-field">
      <label className="pv-field-label" htmlFor={id}>
        {label}
      </label>
      {hint !== undefined && (
        <span className="pv-field-hint" id={hintId}>
          {hint}
        </span>
      )}
      {children({ id, describedBy, invalid: error !== undefined })}
      {error !== undefined && (
        <span className="pv-field-error" id={errorId}>
          {error}
        </span>
      )}
    </div>
  );
}
