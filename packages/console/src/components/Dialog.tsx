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
 * `showModal()` gives us, correctly and for free, the three things a hand-built
 * modal has to re-earn and usually gets wrong: focus is confined to the dialog,
 * everything behind it becomes inert to both pointer and assistive technology,
 * and Escape closes it.
 *
 * The dialog is mounted only while it is open. That is not an optimisation —
 * a closed dialog whose content is still in the document is content a screen
 * reader can wander into, and relying on the user-agent stylesheet to hide it
 * puts the accessibility of the page in the hands of `display: none`.
 *
 * The `open`-attribute path exists because jsdom does not implement
 * `showModal()`, so the tests exercise this same markup as a non-modal dialog.
 * No browser takes that path. Escape is handled here rather than only through
 * the native `cancel` event so both paths behave identically.
 */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <OpenDialog {...props} />;
}

function OpenDialog({ title, onClose, children, actions }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocusTo = document.activeElement as HTMLElement | null;
    if (dialog === null) return;

    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");

    // Focus the title rather than the first control: the operator should hear
    // what they are confirming before they hear the button that confirms it.
    titleRef.current?.focus();

    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      // Focus goes back where the operator left it, not to the top of the page.
      returnFocusTo?.focus();
    };
  }, []);

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
