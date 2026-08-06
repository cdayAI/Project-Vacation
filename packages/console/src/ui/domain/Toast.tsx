import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StatusTone } from "../../theme/tokens";
import { Button } from "../primitives/Button";
import { IconAlert, IconBlocked, IconCheck, IconCross, IconDot, IconInfo } from "../primitives/icons";
import { toneVariables, TONE_WORDS } from "../primitives/tone";
import { GLASS_PRIORITY, useGlassSurface, withScrim } from "../surfaces/glassSurface";
import { MarkUndo } from "./marks";
import "./Toast.css";

/**
 * A toast: confirmation of something that already happened.
 *
 * Four rules, and every one of them is a defect this component exists to stop.
 *
 * **A toast is never the only record.** It is the receipt, not the ledger.
 * Anything consequential is in the operating record and reachable from the
 * screen, which is why `record` is here: a link to the permanent copy of what
 * this toast is about. An operator who blinks and misses a toast must lose
 * nothing at all.
 *
 * **It never steals focus.** Approvals advance automatically after a decision
 * (spec §3.2), so a toast appears while the operator is already reading the
 * next item. Moving focus there would cost them their place and, on a keyboard,
 * their next keystroke. Nothing in this file calls `focus()`.
 *
 * **It is announced politely.** The live region belongs to `ToastRegion`, which
 * stays mounted for the life of the application — a live region created at the
 * same moment as its content is a live region that announces nothing, because
 * assistive technology has to be watching the node before the change happens.
 *
 * **It can always be dismissed, and it waits while you are reading it.** The
 * dismissal timer pauses on hover and while focus is inside the toast (WCAG
 * 2.2.1). Without that, the undo button an operator is reaching for disappears
 * under their cursor, which is worse than no undo at all.
 *
 * The 2-second undo window from spec §3.2 is the *whole* lifetime of an undo
 * toast rather than a phase of it. A toast that survives its own undo button is
 * a control vanishing out of a box that stays put, and the operator has no way
 * to know the difference between "you were too slow" and "it moved".
 */

/** Spec §3.2: decide, advance, and offer two seconds to take it back. */
export const UNDO_WINDOW_MS = 2_000;

/** A toast with no action gets long enough to read twice. */
export const TOAST_DURATION_MS = 6_000;

const MARKS: Readonly<Record<StatusTone, ReactNode>> = {
  success: <IconCheck size="sm" />,
  warning: <IconAlert size="sm" />,
  danger: <IconCross size="sm" />,
  info: <IconInfo size="sm" />,
  neutral: <IconDot size="sm" />,
  denied: <IconBlocked size="sm" />,
};

export interface ToastUndo {
  readonly onUndo: () => void;
  /** Defaults to "Undo". Say what is undone where the toast title is ambiguous. */
  readonly label?: string;
}

export interface ToastRecord {
  readonly href: string;
  /** Defaults to "See the record". */
  readonly label?: string;
}

export interface ToastProps {
  /** What happened, in the past tense. "Approved. Letter queued for 3 owners." */
  readonly title: string;
  readonly description?: ReactNode;
  readonly tone?: StatusTone;
  /** Renders Undo and shortens the toast to the undo window. */
  readonly undo?: ToastUndo;
  /** Where the permanent copy lives. A toast is a receipt, not the ledger. */
  readonly record?: ToastRecord;
  /**
   * How long before it dismisses itself. Defaults to the undo window when an
   * undo is offered and to the reading duration otherwise. `null` keeps it up
   * until the operator dismisses it — for a failure they must acknowledge.
   */
  readonly durationMs?: number | null;
  readonly onDismiss: () => void;
  /** Defaults to `Dismiss: <title>`, so a row of toasts has distinct buttons. */
  readonly dismissLabel?: string;
  readonly className?: string;
}

export function Toast({
  title,
  description,
  tone = "info",
  undo,
  record,
  durationMs,
  onDismiss,
  dismissLabel,
  className,
}: ToastProps) {
  const duration =
    durationMs === undefined ? (undo === undefined ? TOAST_DURATION_MS : UNDO_WINDOW_MS) : durationMs;

  const [held, setHeld] = useState(false);
  const remaining = useRef<number>(duration ?? 0);
  const startedAt = useRef<number | null>(null);

  // The callback lives in a ref so the timer effect does not depend on its
  // identity. A parent that re-creates `onDismiss` every render would otherwise
  // restart the countdown on every render, and the toast would never leave.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (duration === null || held) return;
    if (remaining.current <= 0) return;
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => dismiss.current(), remaining.current);
    return () => {
      window.clearTimeout(timer);
      if (startedAt.current !== null) {
        remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
        startedAt.current = null;
      }
    };
  }, [duration, held]);

  const glass = useGlassSurface({ priority: GLASS_PRIORITY.anchored });

  return (
    <div
      className={
        className === undefined
          ? `pv-toast ${glass.surfaceClassName}`
          : `pv-toast ${glass.surfaceClassName} ${className}`
      }
      data-tone={tone}
      style={toneVariables(tone)}
      // Pointer and keyboard both hold the countdown. focusin/focusout rather
      // than focus/blur so that focus landing on the undo button inside counts.
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
      }}
    >
      <div className={withScrim("pv-toast-body", glass.scrimClassName)}>
        <span className="pv-toast-mark" aria-hidden="true">
          {MARKS[tone]}
        </span>
        <div className="pv-toast-text">
          <p className="pv-toast-title">
            {/* The tone in words. The tint and the mark say nothing to a screen
                reader, and this text is what the live region announces. */}
            <span className="pv-sr-only">{TONE_WORDS[tone]}: </span>
            {title}
          </p>
          {description === undefined ? null : (
            <p className="pv-toast-description">{description}</p>
          )}
          {record === undefined ? null : (
            <a className="pv-toast-record" href={record.href}>
              {record.label ?? "See the record"}
            </a>
          )}
        </div>
        <div className="pv-toast-actions">
          {undo === undefined ? null : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                undo.onUndo();
                onDismiss();
              }}
            >
              <MarkUndo size="sm" />
              {undo.label ?? "Undo"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            label={dismissLabel ?? `Dismiss: ${title}`}
            onClick={onDismiss}
          >
            <IconCross size="sm" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface ToastRegionProps {
  /** Names the region. "Notifications" unless the surface has a better word. */
  readonly label?: string;
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * Where toasts live: one polite live region, mounted for the life of the
 * application whether or not anything is in it.
 *
 * Mounting it empty is the point. Assistive technology announces *changes* to a
 * live region it is already watching; a region that arrives with its content
 * already inside is announced by almost nothing. This is the single most common
 * reason a toast is silent to a screen reader while looking perfect on screen.
 *
 * `aria-atomic="false"` so that adding a second toast announces the second
 * toast rather than re-reading the first.
 */
export function ToastRegion({ label = "Notifications", children, className }: ToastRegionProps) {
  return (
    <div
      className={className === undefined ? "pv-toast-region" : `pv-toast-region ${className}`}
      role="region"
      aria-label={label}
      aria-live="polite"
      aria-atomic="false"
    >
      {children}
    </div>
  );
}
