import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "./classes";
import {
  DATE_FORMAT_HINT,
  addDays,
  addMonths,
  compareIso,
  daysInMonth,
  describeOutOfRange,
  describeParseFailure,
  formatDate,
  formatDateSpoken,
  formatMonth,
  fromIso,
  isWithin,
  monthGrid,
  parseDate,
  toIso,
  todayIso,
  weekdayOf,
  WEEKDAY_INITIALS,
  WEEKDAY_NAMES,
} from "./dates";
import { Field } from "./Field";
import { IconCalendar, IconChevronLeft, IconChevronRight } from "./icons";
import type { ControlSize } from "./Input";
import "./control.css";
import "./popup.css";
import "./DatePicker.css";

/**
 * DatePicker — a date an operator types, and a calendar for when typing cannot
 * answer the question.
 *
 * Typing is the primary path and the calendar is the secondary one, which is
 * the opposite of most date fields and is a deliberate choice: an operator six
 * items into a queue types "12 Jun" in about a second, and hunting the same
 * date in a grid takes four or five. So the field parses as you type and
 * commits the moment what is in it is unambiguously a date, and the calendar is
 * there for "which Monday is that" and "how close is that to the deadline".
 *
 * The accepted formats are written in the hint, never inferred from the
 * platform locale, and a slashed date is refused rather than guessed at — see
 * dates.ts for why that refusal is the safest thing this component does.
 *
 * The calendar is not a focus trap. It is rendered inline, so Tab walks out of
 * it in reading order; Escape closes it and puts focus back on the button that
 * opened it.
 */

export interface DatePickerProps {
  readonly label: string;
  readonly labelHidden?: boolean;
  /** Replaces the format hint. The format is still enforced. */
  readonly hint?: string;
  /** A caller-supplied error. Takes precedence over the parse message. */
  readonly error?: string;
  /** ISO `YYYY-MM-DD`, or null. Never a `Date` — see dates.ts. */
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly min?: string;
  readonly max?: string;
  /** The year a date typed without one belongs to. Defaults to today's. */
  readonly referenceDate?: string;
  readonly size?: ControlSize;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly placeholder?: string;
  readonly id?: string;
  readonly className?: string;
}

export function DatePicker({
  label,
  labelHidden,
  hint,
  error,
  value,
  onChange,
  min,
  max,
  referenceDate,
  size = "md",
  required = false,
  disabled = false,
  readOnly = false,
  placeholder = "12 Jun 2026",
  id,
  className,
}: DatePickerProps) {
  const generatedId = useId();
  const rootId = id ?? generatedId;
  const dialogId = `${rootId}-calendar`;

  const today = todayIso();
  const reference = referenceDate ?? value ?? today;
  const referenceYear = fromIso(reference)?.year ?? new Date().getFullYear();

  const [text, setText] = useState(value === null ? "" : formatDate(value));
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [typing, setTyping] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Follow an externally changed value — a linked field, a record arriving, a
  // reset. Adjusted during render rather than in an effect so the stale text is
  // never painted. Never while the operator is mid-keystroke: this field
  // commits as soon as what is typed reads as a date, and rewriting the box
  // from that commit would turn "12 Jun" into "12 Jun 2026" under their caret.
  const [seenValue, setSeenValue] = useState<string | null>(value);
  if (seenValue !== value) {
    setSeenValue(value);
    if (!typing) {
      setText(value === null ? "" : formatDate(value));
      setLocalError(undefined);
    }
  }

  /**
   * Parses, range-checks, and reports.
   *
   * Returns the committed value — `null` for a cleared field — or `undefined`
   * when nothing could be committed. Three outcomes rather than a boolean
   * because the caller needs to know what was stored in order to normalise the
   * text to it.
   */
  function commitText(raw: string, quiet: boolean): string | null | undefined {
    if (raw.trim().length === 0) {
      onChange(null);
      setLocalError(undefined);
      return null;
    }
    const result = parseDate(raw, referenceYear);
    if (!result.ok) {
      // Mid-typing, a half-written date is not an error: "12 J" is somebody in
      // the middle of a word, and correcting them on the keystroke is how a
      // field becomes unpleasant to use.
      if (!quiet) setLocalError(describeParseFailure(result.reason));
      return undefined;
    }
    if (!isWithin(result.value, min, max)) {
      if (!quiet) setLocalError(describeOutOfRange(min, max));
      return undefined;
    }
    setLocalError(undefined);
    onChange(result.value);
    return result.value;
  }

  function pick(iso: string) {
    if (!isWithin(iso, min, max)) return;
    setTyping(false);
    onChange(iso);
    setText(formatDate(iso));
    setLocalError(undefined);
    setOpen(false);
    // Back to the field, which is where the next keystroke belongs.
    inputRef.current?.focus();
  }

  function closeCalendar(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  return (
    <Field
      label={label}
      labelHidden={labelHidden}
      // The format hint is instruction for typing, so it goes away when there
      // is no typing to do. A read-only field that explains how to enter a date
      // is noise on a screen an auditor is reading, not filling in.
      hint={hint ?? (readOnly ? undefined : DATE_FORMAT_HINT)}
      error={error ?? localError}
      required={required}
      readOnly={readOnly}
      id={rootId}
      className={className}
    >
      {(control) => (
        <div className={cx("pv-ui-popup")}>
          <div
            className="pv-ui-control"
            data-size={size}
            data-invalid={control.invalid ? "true" : undefined}
            data-readonly={control.readOnly ? "true" : undefined}
            data-disabled={disabled ? "true" : undefined}
          >
            <input
              ref={inputRef}
              id={control.id}
              className="pv-ui-control-field"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              value={text}
              placeholder={control.readOnly ? undefined : placeholder}
              aria-describedby={control.describedBy}
              aria-invalid={control.invalid ? true : undefined}
              required={control.required}
              readOnly={control.readOnly}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value;
                setTyping(true);
                setText(next);
                // Quiet: commit as soon as it reads as a date, complain only
                // once the operator has finished.
                commitText(next, true);
                if (localError !== undefined) setLocalError(undefined);
              }}
              onBlur={() => {
                setTyping(false);
                const committed = commitText(text, false);
                // Normalise on the way out: whatever was typed, the field ends
                // up showing the one shape this console writes dates in.
                if (committed !== undefined) {
                  setText(committed === null ? "" : formatDate(committed));
                }
              }}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter") {
                  // A date that will not parse must not travel with a form
                  // submission, so Enter is swallowed only when it fails.
                  const committed = commitText(text, false);
                  if (committed === undefined) event.preventDefault();
                  else {
                    setTyping(false);
                    setText(committed === null ? "" : formatDate(committed));
                  }
                  return;
                }
                if (event.key === "Escape" && open) {
                  event.preventDefault();
                  closeCalendar(false);
                  return;
                }
                if (event.key === "ArrowDown" && event.altKey && !control.readOnly) {
                  event.preventDefault();
                  setOpen(true);
                }
              }}
            />
            {!control.readOnly && (
              <button
                ref={triggerRef}
                type="button"
                className="pv-ui-control-button"
                aria-label={open ? "Close the calendar" : "Choose a date from the calendar"}
                aria-expanded={open}
                aria-controls={open ? dialogId : undefined}
                aria-haspopup="dialog"
                disabled={disabled}
                onClick={() => setOpen((current) => !current)}
              >
                <IconCalendar size="sm" />
              </button>
            )}
          </div>

          {open && !control.readOnly && (
            <Calendar
              id={dialogId}
              label={label}
              selected={value}
              focusFrom={value ?? reference}
              today={today}
              min={min}
              max={max}
              onPick={pick}
              onDismiss={() => closeCalendar(true)}
              onLeave={() => setOpen(false)}
            />
          )}
        </div>
      )}
    </Field>
  );
}

interface CalendarProps {
  readonly id: string;
  readonly label: string;
  readonly selected: string | null;
  readonly focusFrom: string;
  readonly today: string;
  readonly min?: string;
  readonly max?: string;
  readonly onPick: (iso: string) => void;
  /** Escape: close and put focus back on the trigger. */
  readonly onDismiss: () => void;
  /** Focus left the calendar entirely: close without moving focus. */
  readonly onLeave: () => void;
}

/**
 * The month grid.
 *
 * Days are buttons with a roving tabindex, so the calendar is one tab stop and
 * the arrows move within it. Out-of-range days carry `aria-disabled` rather
 * than `disabled`: a natively disabled button cannot be focused, and a roving
 * tabindex that lands on one would strand the keyboard on a day it cannot
 * leave. They stay reachable, announced as unavailable, and refuse the click.
 */
function Calendar({
  id,
  label,
  selected,
  focusFrom,
  today,
  min,
  max,
  onPick,
  onDismiss,
  onLeave,
}: CalendarProps) {
  const [focused, setFocused] = useState(focusFrom);
  const gridRef = useRef<HTMLTableElement | null>(null);
  const parts = fromIso(focused) ?? fromIso(today);
  const year = parts?.year ?? new Date().getFullYear();
  const month = parts?.month ?? 1;

  useEffect(() => {
    const grid = gridRef.current;
    if (grid === null) return;
    const day = grid.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`);
    day?.focus();
  }, [focused]);

  function move(next: string) {
    setFocused(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        move(addDays(focused, -1));
        return;
      case "ArrowRight":
        event.preventDefault();
        move(addDays(focused, 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        move(addDays(focused, -7));
        return;
      case "ArrowDown":
        event.preventDefault();
        move(addDays(focused, 7));
        return;
      case "Home":
        event.preventDefault();
        move(addDays(focused, -weekdayOf(focused)));
        return;
      case "End":
        event.preventDefault();
        move(addDays(focused, 6 - weekdayOf(focused)));
        return;
      case "PageUp":
        event.preventDefault();
        move(addMonths(focused, event.shiftKey ? -12 : -1));
        return;
      case "PageDown":
        event.preventDefault();
        move(addMonths(focused, event.shiftKey ? 12 : 1));
        return;
      case "Escape":
        event.preventDefault();
        onDismiss();
        return;
      default:
        return;
    }
  }

  const cells = monthGrid(year, month);
  const weeks: string[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }

  const firstOfMonth = toIso({ year, month, day: 1 });
  const previousMonth = addMonths(firstOfMonth, -1);
  const nextMonth = addMonths(firstOfMonth, 1);
  // Blocked when no day of the neighbouring month could be chosen: the last day
  // before this month is already before `min`, or the first day after it is
  // already past `max`.
  const previousBlocked = min !== undefined && compareIso(addDays(firstOfMonth, -1), min) < 0;
  const nextBlocked =
    max !== undefined && compareIso(addDays(firstOfMonth, daysInMonth(year, month)), max) > 0;

  return (
    <div
      id={id}
      className="pv-ui-popup-layer pv-ui-calendar"
      data-fit="content"
      role="dialog"
      aria-label={`${label} calendar`}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Focus has gone somewhere outside the calendar: the operator tabbed
        // past it or clicked elsewhere. Closing without moving focus is what
        // keeps this from being a trap.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onLeave();
      }}
    >
      <div className="pv-ui-calendar-header">
        <button
          type="button"
          className="pv-ui-calendar-step"
          aria-label={`Previous month, ${formatMonth(fromIso(previousMonth)?.year ?? year, fromIso(previousMonth)?.month ?? month)}`}
          disabled={previousBlocked}
          onClick={() => move(addMonths(focused, -1))}
        >
          <IconChevronLeft size="sm" />
        </button>
        <span className="pv-ui-calendar-month" aria-hidden="true">
          {formatMonth(year, month)}
        </span>
        <button
          type="button"
          className="pv-ui-calendar-step"
          aria-label={`Next month, ${formatMonth(fromIso(nextMonth)?.year ?? year, fromIso(nextMonth)?.month ?? month)}`}
          disabled={nextBlocked}
          onClick={() => move(addMonths(focused, 1))}
        >
          <IconChevronRight size="sm" />
        </button>
      </div>

      <table ref={gridRef} className="pv-ui-calendar-grid">
        <caption className="pv-sr-only">{formatMonth(year, month)}</caption>
        <thead>
          <tr>
            {WEEKDAY_INITIALS.map((initial, index) => (
              <th key={WEEKDAY_NAMES[index]} scope="col" className="pv-ui-calendar-weekday">
                <span aria-hidden="true">{initial}</span>
                <span className="pv-sr-only">{WEEKDAY_NAMES[index]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((iso) => {
                const day = fromIso(iso);
                const outside = day?.month !== month;
                const allowed = isWithin(iso, min, max);
                const isToday = iso === today;
                return (
                  <td key={iso} className="pv-ui-calendar-cell">
                    <button
                      type="button"
                      className="pv-ui-calendar-day"
                      data-date={iso}
                      data-outside={outside ? "true" : undefined}
                      data-today={isToday ? "true" : undefined}
                      // One tab stop for the whole grid; the arrows do the rest.
                      tabIndex={iso === focused ? 0 : -1}
                      aria-pressed={iso === selected}
                      aria-disabled={allowed ? undefined : true}
                      aria-current={isToday ? "date" : undefined}
                      aria-label={`${formatDateSpoken(iso)}${isToday ? ", today" : ""}`}
                      onFocus={() => setFocused(iso)}
                      onClick={() => {
                        if (allowed) onPick(iso);
                      }}
                    >
                      {day?.day}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pv-ui-calendar-footer">
        <span className="pv-ui-calendar-hint">Today is {formatDate(today)}</span>
        <button
          type="button"
          className="pv-ui-calendar-step pv-ui-calendar-today"
          aria-label={`Go to today, ${formatDateSpoken(today)}`}
          onClick={() => move(today)}
        >
          Today
        </button>
      </div>
    </div>
  );
}
