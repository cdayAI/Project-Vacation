import { useState, type ChangeEvent, type ComponentPropsWithRef } from "react";
import { cx } from "./classes";
import { Field } from "./Field";
import type { ControlSize } from "./Input";
import "./control.css";
import "./Textarea.css";

/**
 * Textarea — a rejection reason, a correction, a note on the record.
 *
 * The native `maxlength` attribute is deliberately not set. It truncates a
 * paste silently: an operator pastes a two-paragraph reason, the field keeps
 * the first paragraph, and nothing anywhere says so. `maxLength` here counts
 * instead — the counter turns and the field goes invalid with a sentence
 * saying how far over it is, so the operator can edit rather than discover
 * later that half their reasoning was dropped.
 *
 * The counter is announced at thresholds rather than on every keystroke.
 * Wording is fixed per threshold so the live region has three states, not
 * two hundred; a region whose text changes with every character is a region
 * that reads the whole field back as you type.
 */

/** Characters left at which the counter starts warning. */
const WARN_WITHIN = 20;

export interface TextareaProps
  extends Omit<
    ComponentPropsWithRef<"textarea">,
    "className" | "children" | "maxLength" | "aria-invalid" | "aria-describedby"
  > {
  readonly label: string;
  readonly labelHidden?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly size?: ControlSize;
  /** Counted and reported, never enforced by truncation. */
  readonly maxLength?: number;
  readonly fieldClassName?: string;
}

export function Textarea({
  label,
  labelHidden,
  hint,
  error,
  size = "md",
  maxLength,
  fieldClassName,
  required,
  readOnly,
  disabled,
  rows = 4,
  id,
  value,
  defaultValue,
  onChange,
  ...rest
}: TextareaProps) {
  const controlled = value !== undefined;
  const [uncontrolledLength, setUncontrolledLength] = useState<number>(
    () => String(defaultValue ?? "").length,
  );
  const used = controlled ? String(value).length : uncontrolledLength;

  const remaining = maxLength === undefined ? undefined : maxLength - used;
  const over = remaining !== undefined && remaining < 0;
  const nearLimit = remaining !== undefined && remaining >= 0 && remaining <= WARN_WITHIN;

  // The caller's error wins: it is about the content, and being over the limit
  // is something the operator can already see in the counter.
  const shownError =
    error ??
    (over
      ? `This is ${Math.abs(remaining ?? 0).toLocaleString()} characters over the limit of ${(
          maxLength ?? 0
        ).toLocaleString()}. Shorten it before saving.`
      : undefined);

  const announcement = over
    ? "Over the character limit."
    : remaining !== undefined && remaining <= WARN_WITHIN
      ? `Fewer than ${WARN_WITHIN.toLocaleString()} characters left.`
      : "";

  const counter =
    maxLength === undefined ? undefined : (
      <>
        <span
          className={cx("pv-ui-textarea-count")}
          data-near-limit={nearLimit || over ? "true" : undefined}
          // Announced through the threshold region beside it, not on every
          // keystroke. A counter that speaks each character is unusable.
          aria-hidden="true"
        >
          {used.toLocaleString()} / {maxLength.toLocaleString()}
        </span>
        <span className="pv-sr-only" role="status">
          {announcement}
        </span>
      </>
    );

  return (
    <Field
      label={label}
      labelHidden={labelHidden}
      hint={hint}
      error={shownError}
      required={required === true}
      readOnly={readOnly === true}
      footer={counter}
      id={id}
      className={fieldClassName}
    >
      {(control) => (
        <div
          className="pv-ui-control"
          data-size={size}
          data-multiline="true"
          data-invalid={control.invalid ? "true" : undefined}
          data-readonly={control.readOnly ? "true" : undefined}
          data-disabled={disabled === true ? "true" : undefined}
        >
          <textarea
            {...rest}
            id={control.id}
            className="pv-ui-control-field pv-ui-textarea-field"
            rows={rows}
            value={value}
            defaultValue={defaultValue}
            aria-describedby={control.describedBy}
            aria-invalid={control.invalid ? true : undefined}
            required={control.required}
            readOnly={control.readOnly}
            disabled={disabled}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
              if (!controlled) setUncontrolledLength(event.target.value.length);
              onChange?.(event);
            }}
          />
        </div>
      )}
    </Field>
  );
}
