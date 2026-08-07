import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cx } from "./classes";
import "./Tooltip.css";

/**
 * Tooltip — the second sentence.
 *
 * Not a place for anything an operator needs in order to decide. A tooltip
 * cannot be reached on a touch screen, does not exist in a printed evidence
 * pack, and is missing from every screenshot pasted into a ticket. What belongs
 * here is supplementary: the absolute timestamp behind a relative one, the unit
 * behind a number, the identifier behind a name.
 *
 * Three behaviours WCAG 2.2 1.4.13 requires, and one that is only good sense:
 *
 *   Reachable on focus, not only on hover — otherwise it does not exist for a
 *   keyboard.
 *   Dismissible with Escape without moving the pointer or the focus.
 *   Hoverable: the pointer can travel into the bubble without it vanishing,
 *   which is what makes a long tooltip readable.
 *
 * And the one that is judgement: the bubble is *always in the DOM*, screen-
 * reader-only until it is shown. `aria-describedby` therefore points at
 * something real at all times, so the description is announced with the control
 * whether or not anyone hovered — which is the opposite of how most tooltips
 * behave, where the description exists only for people using a mouse.
 */

/** Hover has to be deliberate. Focus does not wait — it is already deliberate. */
export const TOOLTIP_HOVER_DELAY_MS = 300;

export interface TooltipProps {
  /** Supplementary detail. Never the only carrier of a meaning. */
  readonly content: ReactNode;
  readonly placement?: "top" | "bottom";
  readonly delayMs?: number;
  /** Exactly one element, and it must be able to take focus. */
  readonly children: ReactElement;
  readonly className?: string;
}

interface TriggerProps {
  readonly "aria-describedby"?: string;
  readonly onFocus?: (event: FocusEvent<HTMLElement>) => void;
  readonly onBlur?: (event: FocusEvent<HTMLElement>) => void;
  readonly onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  readonly onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}

export function Tooltip({
  content,
  placement = "top",
  delayMs = TOOLTIP_HOVER_DELAY_MS,
  children,
  className,
}: TooltipProps) {
  const tipId = useId();
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancel() {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  useEffect(() => cancel, []);

  function showAfterDelay() {
    cancel();
    timer.current = setTimeout(() => setShown(true), delayMs);
  }

  function hide() {
    cancel();
    setShown(false);
  }

  const trigger = children as ReactElement<TriggerProps>;
  const existing = trigger.props;

  const described = [existing["aria-describedby"], tipId]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");

  const wired = cloneElement<TriggerProps>(trigger, {
    "aria-describedby": described,
    onFocus: (event: FocusEvent<HTMLElement>) => {
      existing.onFocus?.(event);
      // No delay on focus: the operator is already there on purpose, and a
      // keyboard user waiting 300ms for a description reads as a stutter.
      cancel();
      setShown(true);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      existing.onBlur?.(event);
      hide();
    },
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      existing.onMouseEnter?.(event);
      showAfterDelay();
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      existing.onMouseLeave?.(event);
      hide();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      existing.onKeyDown?.(event);
      // WCAG 2.2 1.4.13: dismissible without moving the pointer or the focus.
      if (event.key === "Escape" && shown) {
        event.stopPropagation();
        hide();
      }
    },
  });

  return (
    <span className={cx("pv-ui-tooltip", className)}>
      {wired}
      <span
        id={tipId}
        role="tooltip"
        // Screen-reader-only rather than unmounted when hidden, so
        // `aria-describedby` always points at something and the description is
        // read with the control even when nobody hovered.
        className={shown ? "pv-ui-tooltip-bubble" : "pv-sr-only"}
        data-placement={shown ? placement : undefined}
        // 1.4.13 again: the pointer must be able to travel into the bubble
        // without it disappearing on the way.
        onMouseEnter={cancel}
        onMouseLeave={hide}
      >
        {content}
      </span>
    </span>
  );
}
