import type { ComponentPropsWithRef, ReactNode } from "react";
import { Field } from "./Field";
import { Spinner } from "./Spinner";
import "./control.css";

/**
 * Input — one line of text, inside the shared control box.
 *
 * `type="number"` is deliberately not offered. A native number field changes
 * its value when the wheel is scrolled over it while focused, which in a
 * console full of currency amounts and thresholds is a silent data-integrity
 * failure: the operator scrolls the page, the amount changes, nothing announces
 * it. It also refuses to hold a partially typed value, so a field can read
 * empty while showing characters. Amounts use `inputMode="decimal"` on a text
 * field and are parsed and validated by the caller, where the rules and the
 * error message live.
 *
 * Every other state is here: hover, focus-visible, error, disabled, loading,
 * and the designed read-only that auditors spend their day in.
 */

export type ControlSize = "sm" | "md" | "lg";

export interface InputProps
  extends Omit<
    ComponentPropsWithRef<"input">,
    "className" | "size" | "type" | "children" | "aria-invalid" | "aria-describedby"
  > {
  readonly label: string;
  readonly labelHidden?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly size?: ControlSize;
  readonly type?: "text" | "email" | "tel" | "url" | "search" | "password";
  /** Decorative content before the value — a currency mark, a prefix. */
  readonly leading?: ReactNode;
  /** Decorative content after the value — a unit, a match count. */
  readonly trailing?: ReactNode;
  /** An in-flight check against the server: a duplicate, an availability. */
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  /** Below the control: a resolved value, a footnote, a counter. */
  readonly footer?: ReactNode;
  readonly fieldClassName?: string;
}

export function Input({
  label,
  labelHidden,
  hint,
  error,
  size = "md",
  type = "text",
  leading,
  trailing,
  loading = false,
  loadingLabel = "Checking",
  footer,
  fieldClassName,
  required,
  readOnly,
  disabled,
  id,
  ...rest
}: InputProps) {
  return (
    <Field
      label={label}
      labelHidden={labelHidden}
      hint={hint}
      error={error}
      required={required === true}
      readOnly={readOnly === true}
      footer={footer}
      id={id}
      className={fieldClassName}
    >
      {(control) => (
        <div
          className="pv-ui-control"
          data-size={size}
          data-invalid={control.invalid ? "true" : undefined}
          data-readonly={control.readOnly ? "true" : undefined}
          data-disabled={disabled === true ? "true" : undefined}
        >
          {leading !== undefined && (
            <span className="pv-ui-control-addon" aria-hidden="true">
              {leading}
            </span>
          )}
          <input
            {...rest}
            id={control.id}
            type={type}
            className="pv-ui-control-field"
            aria-describedby={control.describedBy}
            aria-invalid={control.invalid ? true : undefined}
            aria-busy={loading ? true : undefined}
            required={control.required}
            readOnly={control.readOnly}
            disabled={disabled}
          />
          {loading && (
            <span className="pv-ui-control-addon">
              <Spinner size="sm" label={loadingLabel} />
            </span>
          )}
          {trailing !== undefined && (
            <span className="pv-ui-control-addon" aria-hidden="true">
              {trailing}
            </span>
          )}
        </div>
      )}
    </Field>
  );
}
