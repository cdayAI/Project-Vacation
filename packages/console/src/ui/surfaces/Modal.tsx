import { useId, type ReactNode, type RefObject } from "react";
import { Button } from "../primitives/Button";
import { IconCross } from "../primitives/icons";
import { DialogHost } from "./dialogHost";
import { withScrim } from "./glassSurface";
import { ReadOnlyChip } from "./ReadOnlyChip";
import { SurfaceState } from "./SurfaceState";
import "./Modal.css";

/**
 * A modal: the interface asking a question it will not proceed without an
 * answer to.
 *
 * Modals are expensive — they stop everything — so the product uses very few of
 * them, and the specification is explicit about one place they must *not*
 * appear: rejecting an approval expands an inline reason selector, never a
 * modal (§3.2). What is left is destructive confirmation, which §6 says must
 * state the consequence and whether it is reversible:
 *
 *   > **Revoke credentials for `sf-quotebot`?**
 *   > It stops working immediately, including three runs in flight. You can
 *   > issue new credentials at any time, but the current ones cannot be
 *   > restored.
 *
 * That is the shape this component is built around: a question as the title, a
 * consequence as the body, and two buttons the same size — because a
 * confirmation where the safe answer is styled as the easy path is a
 * confirmation nobody reads.
 *
 * `tone="danger"` switches the role to `alertdialog`, which interrupts a screen
 * reader mid-sentence. That is correct for "this cannot be undone" and wrong
 * for everything else, so it is tied to the tone rather than offered as a free
 * choice.
 */

export type ModalSize = "sm" | "md" | "lg";

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;

  /** The question or the task, in plain language. Not a noun phrase. */
  readonly title: string;
  /** One line under the title, in the same voice. */
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** Buttons. The safe answer and the consequential one are the same size. */
  readonly actions?: ReactNode;

  readonly size?: ModalSize;
  /** `danger` announces as an alert. For irreversible actions only. */
  readonly tone?: "default" | "danger";

  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  readonly readOnly?: boolean;

  /** The control this modal grew out of, so it collapses back into it. */
  readonly originRef?: RefObject<Element | null>;
  readonly originIdentity?: string;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;

  /** False when dismissal must be a deliberate button press. */
  readonly dismissOnOutsideClick?: boolean;
  readonly dismissOnEscape?: boolean;
  /** Hides the header's close control. The actions must then include a way out. */
  readonly hideCloseButton?: boolean;
  readonly closeLabel?: string;
  readonly className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  size = "md",
  tone = "default",
  loading = false,
  error,
  empty,
  readOnly = false,
  originRef,
  originIdentity,
  initialFocusRef,
  dismissOnOutsideClick = true,
  dismissOnEscape = true,
  hideCloseButton = false,
  closeLabel = "Close",
  className,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <DialogHost
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={description === undefined ? undefined : descriptionId}
      role={tone === "danger" ? "alertdialog" : "dialog"}
      containerClassName="pv-modal-host"
      surfaceClassName={
        className === undefined
          ? `pv-modal pv-modal-${size}`
          : `pv-modal pv-modal-${size} ${className}`
      }
      originRef={originRef}
      originIdentity={originIdentity}
      initialFocusRef={initialFocusRef}
      dismissOnOutsideClick={dismissOnOutsideClick}
      dismissOnEscape={dismissOnEscape}
    >
      {(surface) => (
        <>
          <div className={withScrim("pv-modal-header", surface.scrimClassName)}>
            <div className="pv-modal-heading-group">
              {/* Focusable so the operator hears the question before the
                  buttons that answer it. Not a tab stop. */}
              <h2 className="pv-modal-title" id={titleId} tabIndex={-1}>
                {title}
              </h2>
              {description === undefined ? null : (
                <p className="pv-modal-description" id={descriptionId}>
                  {description}
                </p>
              )}
            </div>
            <div className="pv-modal-header-trailing">
              {readOnly ? <ReadOnlyChip /> : null}
              {hideCloseButton ? null : (
                <Button iconOnly variant="ghost" size="sm" label={closeLabel} onClick={onClose}>
                  <IconCross />
                </Button>
              )}
            </div>
          </div>

          <div className={withScrim("pv-modal-body", surface.scrimClassName)}>
            <SurfaceState loading={loading} error={error} empty={empty}>
              {children}
            </SurfaceState>
          </div>

          {actions === undefined ? null : (
            <div className={withScrim("pv-modal-actions", surface.scrimClassName)}>{actions}</div>
          )}
        </>
      )}
    </DialogHost>
  );
}
