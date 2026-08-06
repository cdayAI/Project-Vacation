import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** Buttons, rendered right-aligned below the body. */
  readonly actions: ReactNode;
}

/**
 * A modal built on the native `<dialog>` element.
 *
 * `showModal()` gives us, for free and correctly, the three things a hand-built
 * modal has to re-earn and usually gets wrong: focus is trapped inside the
 * dialog, everything behind it is inert to both pointer and assistive
 * technology, and Escape closes it.
 *
 * The fallback path — setting the `open` attribute — exists because jsdom does
 * not implement `showModal()`, so the tests exercise the same markup through a
 * non-modal dialog. It is not a path any browser takes. Escape is handled here
 * rather than only through the native `cancel` event so that both paths behave
 * the same, and focus is placed explicitly on the title for the same reason.
 */
export function Dialog({ open, title, onClose, children, actions }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    if (open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      if (typeof dialog.showModal === "function") {
        if (!dialog.open) dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
      titleRef.current?.focus();
      return;
    }

    if (typeof dialog.close === "function") {
      if (dialog.open) dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
    // Focus goes back where the operator left it, not to the top of the page.
    returnFocusRef.current?.focus();
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="pv-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="pv-dialog-body">
        <h2 className="pv-dialog-title" id={titleId} ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
        {children}
        <div className="pv-dialog-actions">{actions}</div>
      </div>
    </dialog>
  );
}
