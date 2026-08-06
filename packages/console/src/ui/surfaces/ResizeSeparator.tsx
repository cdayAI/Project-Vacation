import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import "./ResizeSeparator.css";

/**
 * The draggable divider behind a resizable column and a resizable panel.
 *
 * Resizing is the affordance most often shipped as pointer-only, and the reason
 * is that a `<div>` with an `onMouseDown` works on the reviewer's machine. It
 * is also the affordance an operator with a tremor, a trackpad they dislike, or
 * no pointer at all needs most: a column too narrow to read its own contents is
 * not a cosmetic problem.
 *
 * So this is a focusable `separator` — the window-splitter pattern — with a
 * value, bounds, and arrow keys, and the pointer drag is the second way to
 * operate it rather than the only one.
 *
 * Value is owned by the caller. A separator that keeps its own width would let
 * a persisted layout and a rendered layout disagree, and the disagreement
 * surfaces as a column that snaps back after a reload.
 */

export interface ResizeSeparatorProps {
  /**
   * The accessible name. Name the thing being resized, not the control:
   * "Owner column width", not "Resize handle" — a screen reader reads it in a
   * list of ten identical handles.
   */
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** Keyboard increment. Shift multiplies it — see LARGE_STEP_MULTIPLIER. */
  readonly step?: number;
  /**
   * 1 when dragging toward larger coordinates grows the value (a handle on the
   * right edge of a column), -1 when it shrinks it (a handle on the leading
   * edge of a right-hand panel).
   */
  readonly direction?: 1 | -1;
  readonly onChange: (value: number) => void;
  /** Called once when a drag or a keypress finishes, for persistence. */
  readonly onCommit?: (value: number) => void;
  readonly disabled?: boolean;
  /** Extra class for the owning component to place and size the hit area. */
  readonly className?: string;
}

/**
 * One press moves 8px — the spacing scale's smallest useful step, and small
 * enough to land on a specific width. Shift moves 40px so crossing a 400px
 * column does not take fifty presses.
 */
const DEFAULT_STEP = 8;
const LARGE_STEP_MULTIPLIER = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function ResizeSeparator({
  label,
  value,
  min,
  max,
  step = DEFAULT_STEP,
  direction = 1,
  onChange,
  onCommit,
  disabled = false,
  className,
}: ResizeSeparatorProps) {
  const drag = useRef<{ readonly origin: number; readonly startValue: number } | null>(null);
  const latest = useRef(value);
  latest.current = value;

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (disabled || event.button !== 0) return;
    // Pointer capture is what makes a drag survive the pointer leaving the 6px
    // handle, which it does immediately on any real drag.
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { origin: event.clientX, startValue: value };
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const active = drag.current;
    if (active === null) return;
    const delta = (event.clientX - active.origin) * direction;
    onChange(clamp(Math.round(active.startValue + delta), min, max));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>): void {
    if (drag.current === null) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit?.(latest.current);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;

    const amount = event.shiftKey ? step * LARGE_STEP_MULTIPLIER : step;
    let next: number | null = null;

    switch (event.key) {
      case "ArrowRight":
        next = value + amount * direction;
        break;
      case "ArrowLeft":
        next = value - amount * direction;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }

    event.preventDefault();
    const clamped = clamp(Math.round(next), min, max);
    onChange(clamped);
    // Committed per keypress rather than on blur: an operator who resizes with
    // the keyboard and then navigates away with the keyboard never blurs this
    // element in a way we would see, and would lose the change.
    onCommit?.(clamped);
  }

  return (
    <div
      className={className === undefined ? "pv-resize-separator" : `pv-resize-separator ${className}`}
      role="separator"
      // A separator is horizontal by default in ARIA. This one is a vertical
      // bar the operator moves horizontally, and saying so is what makes a
      // screen reader read the arrow keys as the right axis.
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${value} pixels`}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      // Stops a drag that starts on the handle from being read as a click on
      // the header behind it, which would sort the column mid-resize.
      onClick={(event) => event.stopPropagation()}
    >
      <span className="pv-resize-separator-grip" aria-hidden="true" />
    </div>
  );
}
