import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition, type Placement } from "./anchoredSurface";
import { captureFocusOrigin, focusInitialElement, wrapTabFocus } from "./focusScope";
import { GLASS_PRIORITY, useGlassSurface, withScrim } from "./glassSurface";
import { ReadOnlyChip } from "./ReadOnlyChip";
import { SurfaceState } from "./SurfaceState";
import "./Popover.css";

/**
 * A popover: a small surface attached to the control that opened it.
 *
 * Non-modal — the page behind stays live and readable, which is the whole
 * difference between this and a Modal. Use it for a filter builder, a column
 * chooser, a definition of the number under the cursor. Never for a decision
 * that must be answered.
 *
 * -----------------------------------------------------------------------------
 * WHY IT IS PORTALLED, AND WHY THAT FORCES A FOCUS TRAP
 *
 * The surface renders at the end of `<body>`. It has to: a glass panel applies
 * `backdrop-filter`, which makes it a containing block for `position: fixed`
 * descendants, so a popover left in place inside the context panel is clipped
 * by it — and the popover on a table header is clipped by the table's own
 * scroll container.
 *
 * Portalling breaks the one thing that made the DOM order useful, which is that
 * Tab goes somewhere sensible. So focus moves into the surface on open, Tab
 * cycles within it, and Escape returns focus to the trigger. Without the trap a
 * keyboard operator tabs out of the popover and lands at the end of the
 * document, which is not a bug they can diagnose.
 *
 * -----------------------------------------------------------------------------
 * WHY IT WILL OFTEN BE SOLID
 *
 * It asks the blur budget for glass at `anchored` priority, which is the lowest
 * of the overlays and — deliberately — is refused outright whenever a
 * virtualized table is on screen. A popover cannot make the list underneath it
 * stop scrolling, and spec §1.5 says never blur behind a scrolling virtualized
 * list. So a popover over the work queue is solid. That is the designed
 * variant, not a downgrade.
 */

export interface PopoverProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The control this is attached to. Also where focus returns. */
  readonly anchorRef: RefObject<HTMLElement | null>;
  /**
   * Must match the `id` given to `popoverTriggerProps`, so the trigger's
   * `aria-controls` points at something real.
   */
  readonly id: string;

  /** A visible heading. Supply this or `label`. */
  readonly title?: string;
  /** An accessible name when the content needs no visible heading. */
  readonly label?: string;

  readonly placement?: Placement;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;

  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  readonly readOnly?: boolean;
  readonly className?: string;
}

/**
 * The attributes the trigger owes the popover.
 *
 * Returned rather than injected, because the trigger is the screen's button and
 * cloning somebody else's element to staple props onto it breaks the moment
 * they wrap it in anything. Spread this and the relationship is complete.
 */
export function popoverTriggerProps(
  id: string,
  open: boolean,
): {
  readonly "aria-haspopup": "dialog";
  readonly "aria-expanded": boolean;
  readonly "aria-controls": string | undefined;
} {
  return {
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    // Only while it exists: pointing at an absent id is a broken reference that
    // some screen readers announce and others ignore, which is worse than both.
    "aria-controls": open ? id : undefined,
  };
}

export function Popover({
  open,
  onClose,
  anchorRef,
  id,
  title,
  label,
  placement = "bottom-start",
  children,
  footer,
  loading = false,
  error,
  empty,
  readOnly = false,
  className,
}: PopoverProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<(() => void) | null>(null);
  const titleId = useId();

  const glass = useGlassSurface({
    priority: GLASS_PRIORITY.anchored,
    wantsBlur: open,
    // False, and truthfully so: a popover cannot stop the list underneath it
    // from scrolling, so it must not blur over one.
    locksBackdrop: false,
  });

  const position = useAnchoredPosition({ open, anchorRef, surfaceRef, placement });

  // Focus in on open, back to the trigger on close.
  useEffect(() => {
    if (!open) return;
    const element = surfaceRef.current;
    if (element === null) return;

    restoreFocus.current = captureFocusOrigin(element.ownerDocument);
    focusInitialElement(element, null);

    return () => {
      restoreFocus.current?.();
      restoreFocus.current = null;
    };
  }, [open]);

  // Escape and outside-press are listened for on the document rather than on
  // the surface: focus can legitimately be elsewhere — the operator clicked the
  // page behind, which is allowed for a non-modal surface — and the popover
  // still has to close.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const element = surfaceRef.current;
      if (element !== null && wrapTabFocus(element, event)) event.preventDefault();
    };

    const onPointerDown = (event: Event): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (surfaceRef.current?.contains(target) === true) return;
      // A press on the trigger is the trigger's business — closing here as well
      // would fight its own toggle and the popover would never reopen.
      if (anchorRef.current?.contains(target) === true) return;
      onClose();
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const named = title !== undefined ? { "aria-labelledby": titleId } : { "aria-label": label };

  return createPortal(
    <div
      ref={surfaceRef}
      id={id}
      role="dialog"
      className={
        className === undefined
          ? `pv-popover ${glass.surfaceClassName}`
          : `pv-popover ${glass.surfaceClassName} ${className}`
      }
      // Rendered off-screen until measured. At 0,0 it would flash in the corner
      // of the window on every open — cheap to avoid, impossible to unsee.
      data-state={position === null ? "measuring" : "open"}
      data-placement={position?.placement ?? placement}
      style={
        position === null
          ? undefined
          : { top: `${position.top}px`, left: `${position.left}px` }
      }
      {...named}
    >
      {title === undefined && !readOnly ? null : (
        <div className={withScrim("pv-popover-header", glass.scrimClassName)}>
          {title === undefined ? null : (
            <h2 className="pv-popover-title" id={titleId}>
              {title}
            </h2>
          )}
          {readOnly ? <ReadOnlyChip /> : null}
        </div>
      )}

      <div className={withScrim("pv-popover-body", glass.scrimClassName)}>
        <SurfaceState loading={loading} error={error} empty={empty}>
          {children}
        </SurfaceState>
      </div>

      {footer === undefined ? null : (
        <div className={withScrim("pv-popover-footer", glass.scrimClassName)}>{footer}</div>
      )}
    </div>,
    document.body,
  );
}

