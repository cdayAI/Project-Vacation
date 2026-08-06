import { useId, type ReactNode, type RefObject } from "react";
import { Button } from "../primitives/Button";
import { IconCross } from "../primitives/icons";
import { GLASS_PRIORITY, withScrim } from "./glassSurface";
import { DialogHost } from "./dialogHost";
import { ReadOnlyChip } from "./ReadOnlyChip";
import { SurfaceState } from "./SurfaceState";
import "./Sheet.css";

/**
 * A sheet: a full-height surface docked to the side of the window.
 *
 * This is the evidence browser's surface. Spec §3.4 says selecting an audit row
 * opens a full-height sheet with the complete chain — inputs and their
 * fingerprints, sources with versions, decisions, approvals with approver
 * identity, and the chain verification badge. It is long, it is read rather
 * than filled in, and the operator goes back to the same row afterwards.
 *
 * Which is why the entrance matters more here than anywhere else in the
 * product. A sheet that fades in from nowhere makes the row you came from feel
 * gone; a sheet that grows out of that row makes it feel like you opened it,
 * and the row is still where you left it when you close. That continuity is
 * spec §1.6's whole argument, and it is what makes forty rows feel like a place
 * rather than forty separate screens.
 *
 * Pass `originRef` — the row's element — or `originIdentity`, and the sheet
 * expands from it and collapses back into it. Pass neither and it slides in
 * from the edge it is docked to, which is the right default and not a
 * consolation prize.
 */

export type SheetSize = "md" | "lg" | "full";

export interface SheetProps {
  readonly open: boolean;
  readonly onClose: () => void;

  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** Header actions. Suppressed when read-only. */
  readonly actions?: ReactNode;
  /** A docked footer — a decision bar, a pair of buttons. */
  readonly footer?: ReactNode;

  readonly size?: SheetSize;
  /** Which edge it docks to. `inline-end` is the default and the common case. */
  readonly side?: "inline-start" | "inline-end";

  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  readonly readOnly?: boolean;

  /** The row or card this sheet grew out of. */
  readonly originRef?: RefObject<Element | null>;
  readonly originIdentity?: string;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;

  readonly dismissOnOutsideClick?: boolean;
  readonly dismissOnEscape?: boolean;
  readonly closeLabel?: string;
  readonly className?: string;
}

export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  footer,
  size = "lg",
  side = "inline-end",
  loading = false,
  error,
  empty,
  readOnly = false,
  originRef,
  originIdentity,
  initialFocusRef,
  dismissOnOutsideClick = true,
  dismissOnEscape = true,
  closeLabel = "Close",
  className,
}: SheetProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <DialogHost
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={description === undefined ? undefined : descriptionId}
      containerClassName={`pv-sheet-host pv-sheet-host-${side === "inline-start" ? "start" : "end"}`}
      surfaceClassName={
        className === undefined
          ? `pv-sheet pv-sheet-${size}`
          : `pv-sheet pv-sheet-${size} ${className}`
      }
      // A sheet outranks an anchored surface for blur and yields to a modal,
      // which is the order they appear in on top of one another.
      priority={GLASS_PRIORITY.sheet}
      originRef={originRef}
      originIdentity={originIdentity}
      initialFocusRef={initialFocusRef}
      dismissOnOutsideClick={dismissOnOutsideClick}
      dismissOnEscape={dismissOnEscape}
    >
      {(surface) => (
        <>
          <div className={withScrim("pv-sheet-header", surface.scrimClassName)}>
            <div className="pv-sheet-heading-group">
              <h2 className="pv-sheet-title" id={titleId} tabIndex={-1}>
                {title}
              </h2>
              {description === undefined ? null : (
                <p className="pv-sheet-description" id={descriptionId}>
                  {description}
                </p>
              )}
            </div>
            <div className="pv-sheet-header-trailing">
              {readOnly ? <ReadOnlyChip /> : null}
              {readOnly ? null : actions}
              <Button iconOnly variant="ghost" size="sm" label={closeLabel} onClick={onClose}>
                <IconCross />
              </Button>
            </div>
          </div>

          <div className={withScrim("pv-sheet-body", surface.scrimClassName)}>
            <SurfaceState loading={loading} error={error} empty={empty} skeletonLines={6}>
              {children}
            </SurfaceState>
          </div>

          {footer === undefined ? null : (
            <div className={withScrim("pv-sheet-footer", surface.scrimClassName)}>{footer}</div>
          )}
        </>
      )}
    </DialogHost>
  );
}

