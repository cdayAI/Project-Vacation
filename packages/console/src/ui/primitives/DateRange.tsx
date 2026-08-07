import { cx } from "./classes";
import { compareIso, formatDate, fromIso } from "./dates";
import { DatePicker } from "./DatePicker";
import { Field } from "./Field";
import type { ControlSize } from "./Input";
import "./DateRange.css";

/**
 * DateRange — the two dates an audit filter, a statutory window, or a report
 * period is bounded by.
 *
 * Two DatePickers inside one `<fieldset>` rather than a bespoke two-headed
 * control. Everything that makes the single picker good — typing "12 Jun",
 * refusing a slashed date, the calendar, the read-only state — is had for free,
 * and there is one less keyboard model in the console for an operator to learn.
 *
 * What this adds is the part a pair of fields cannot do alone:
 *
 *   The end can never be before the start. Each field constrains the other, so
 *   the calendar shows the impossible days as unavailable rather than accepting
 *   them and complaining afterwards.
 *
 *   The span is written out. "14 days, 12 Jun to 25 Jun 2026" is the number the
 *   decision usually turns on, and two dates side by side do not give it.
 */

export interface DateRangeValue {
  readonly start: string | null;
  readonly end: string | null;
}

export interface DateRangeProps {
  readonly label: string;
  readonly labelHidden?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly value: DateRangeValue;
  readonly onChange: (value: DateRangeValue) => void;
  readonly startLabel?: string;
  readonly endLabel?: string;
  /** The outer bounds both ends are held inside. */
  readonly min?: string;
  readonly max?: string;
  readonly size?: ControlSize;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly className?: string;
}

/** Inclusive of both ends: 12 Jun to 12 Jun is one day, not zero. */
export function daysBetween(start: string, end: string): number {
  const from = fromIso(start);
  const to = fromIso(end);
  if (from === null || to === null) return 0;
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / 86_400_000) + 1;
}

export function describeRange(value: DateRangeValue): string | undefined {
  const { start, end } = value;
  if (start === null && end === null) return undefined;
  if (start !== null && end === null) return `From ${formatDate(start)}, with no end date.`;
  if (start === null && end !== null) return `Up to ${formatDate(end)}, with no start date.`;
  if (start === null || end === null) return undefined;
  if (compareIso(start, end) > 0) return undefined;
  const days = daysBetween(start, end);
  return `${days.toLocaleString()} ${days === 1 ? "day" : "days"}, ${formatDate(start)} to ${formatDate(end)}.`;
}

export function DateRange({
  label,
  labelHidden,
  hint,
  error,
  value,
  onChange,
  startLabel = "From",
  endLabel = "To",
  min,
  max,
  size = "md",
  required = false,
  disabled = false,
  readOnly = false,
  className,
}: DateRangeProps) {
  const { start, end } = value;
  const inverted = start !== null && end !== null && compareIso(start, end) > 0;

  const summary = describeRange(value);
  const shownError =
    error ??
    (inverted
      ? `The end date is before the start date. ${formatDate(end ?? "")} comes before ${formatDate(start ?? "")} — swap them, or change one.`
      : undefined);

  return (
    <Field
      label={label}
      labelHidden={labelHidden}
      hint={hint}
      error={shownError}
      required={required}
      readOnly={readOnly}
      group
      className={className}
      footer={
        summary === undefined ? undefined : (
          <span className="pv-ui-date-range-summary">{summary}</span>
        )
      }
    >
      {() => (
        <div className={cx("pv-ui-date-range")}>
          <DatePicker
            className="pv-ui-date-range-part"
            label={startLabel}
            value={start}
            onChange={(next) => onChange({ start: next, end })}
            min={min}
            // Each end constrains the other, so an impossible day is shown as
            // unavailable in the calendar rather than accepted and rejected
            // after the fact.
            max={end ?? max}
            size={size}
            required={required}
            disabled={disabled}
            readOnly={readOnly}
          />
          <DatePicker
            className="pv-ui-date-range-part"
            label={endLabel}
            value={end}
            onChange={(next) => onChange({ start, end: next })}
            min={start ?? min}
            max={max}
            size={size}
            required={required}
            disabled={disabled}
            readOnly={readOnly}
          />
        </div>
      )}
    </Field>
  );
}
