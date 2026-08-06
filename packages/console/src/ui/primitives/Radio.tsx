import { createContext, useContext, useId, type ReactNode } from "react";
import { cx } from "./classes";
import { Field } from "./Field";
import "./Radio.css";

/**
 * RadioGroup and Radio — one of several, and exactly one.
 *
 * The group is a `<fieldset>` with a `<legend>`, which is what makes the
 * question ("Reason for rejection") part of every option's announcement instead
 * of five unexplained words. The options are native inputs sharing a `name`, so
 * the arrow-key navigation, the single tab stop, and the "3 of 5" position come
 * from the platform rather than from a keyboard handler that will be almost
 * right.
 *
 * The relationship travels through context rather than through cloned children.
 * Cloning breaks the first time somebody wraps two options in a div for layout,
 * and it breaks silently — the radios keep rendering, they just stop sharing a
 * name and the operator can then select two answers to a single question.
 */

interface RadioGroupContextValue {
  readonly name: string;
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  readonly readOnly: boolean;
  readonly disabled: boolean;
  readonly invalid: boolean;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps {
  readonly label: string;
  readonly labelHidden?: boolean;
  readonly hint?: string;
  readonly error?: string;
  /** Shared by every option in the group. Generated when not supplied. */
  readonly name?: string;
  /** Controlled. `null` means no option is chosen yet. */
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  readonly orientation?: "vertical" | "horizontal";
  readonly required?: boolean;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function RadioGroup({
  label,
  labelHidden,
  hint,
  error,
  name,
  value,
  onChange,
  orientation = "vertical",
  required = false,
  readOnly = false,
  disabled = false,
  className,
  children,
}: RadioGroupProps) {
  const generatedName = useId();

  return (
    <Field
      label={label}
      labelHidden={labelHidden}
      hint={hint}
      error={error}
      required={required}
      readOnly={readOnly}
      group
      className={className}
    >
      {() => (
        <RadioGroupContext.Provider
          value={{
            name: name ?? generatedName,
            value,
            onChange,
            readOnly,
            disabled,
            invalid: error !== undefined,
          }}
        >
          <div className="pv-ui-radio-group" data-orientation={orientation}>
            {children}
          </div>
        </RadioGroupContext.Provider>
      )}
    </Field>
  );
}

export interface RadioProps {
  readonly value: string;
  readonly label: ReactNode;
  /** The consequence of choosing this one. */
  readonly description?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function Radio({ value, label, description, disabled = false, className }: RadioProps) {
  const group = useContext(RadioGroupContext);
  if (group === null) {
    throw new Error("Radio must be rendered inside a RadioGroup.");
  }

  const generatedId = useId();
  const descriptionId = `${generatedId}-description`;
  const selected = group.value === value;
  const isDisabled = disabled || group.disabled;

  const body = (
    <span className="pv-ui-radio-body">
      {group.readOnly ? (
        <span className="pv-ui-radio-label">
          {label}
          {/* Named, not merely tinted: this is the line an auditor reads to
              learn which answer was given. */}
          {selected && <span className="pv-ui-radio-state">Selected</span>}
        </span>
      ) : (
        <label className="pv-ui-radio-label" htmlFor={generatedId}>
          {label}
        </label>
      )}
      {description !== undefined && (
        <span className="pv-ui-radio-description" id={descriptionId}>
          {description}
        </span>
      )}
    </span>
  );

  if (group.readOnly) {
    return (
      <div
        className={cx("pv-ui-radio", className)}
        data-readonly="true"
        data-selected={selected ? "true" : undefined}
      >
        <span className="pv-ui-radio-control">
          <span className="pv-ui-radio-box">
            <span className="pv-ui-radio-dot" />
          </span>
        </span>
        {body}
      </div>
    );
  }

  return (
    <div
      className={cx("pv-ui-radio", className)}
      data-disabled={isDisabled ? "true" : undefined}
    >
      <span className="pv-ui-radio-control">
        <input
          id={generatedId}
          type="radio"
          className="pv-ui-radio-input"
          name={group.name}
          value={value}
          checked={selected}
          disabled={isDisabled}
          aria-describedby={description !== undefined ? descriptionId : undefined}
          aria-invalid={group.invalid ? true : undefined}
          onChange={() => group.onChange(value)}
        />
        <span className="pv-ui-radio-box">
          <span className="pv-ui-radio-dot" />
        </span>
      </span>
      {body}
    </div>
  );
}
