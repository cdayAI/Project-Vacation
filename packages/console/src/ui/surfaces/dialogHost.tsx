import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { captureFocusOrigin, focusInitialElement, wrapTabFocus } from "./focusScope";
import {
  GLASS_PRIORITY,
  useGlassSurface,
  type GlassPriority,
  type GlassSurface,
} from "./glassSurface";
import {
  captureOriginRect,
  identityAnchor,
  originTransformVariables,
  prefersReducedMotion,
  readTransitionDurationMs,
} from "./originMotion";
import "./dialogHost.css";

/**
 * Everything a Modal and a Sheet share, which is almost everything.
 *
 * A Modal and a Sheet differ in where they sit and how big they are. They are
 * identical in the parts that are hard: containing focus, restoring it, locking
 * the page behind them, dismissing on Escape and on an outside click but not on
 * a text selection that happened to end outside, leasing blur from the budget,
 * growing out of the thing that opened them, and unmounting only after they
 * have finished leaving. Writing that twice is writing two of them wrong.
 *
 * -----------------------------------------------------------------------------
 * WHY A NATIVE <dialog> AND OUR OWN TRAP
 *
 * The element is native because `showModal()` makes the rest of the page inert
 * to pointer, to Tab, and to assistive technology in one call, and no
 * hand-rolled sweep of `aria-hidden` across the document's children has ever
 * been as reliable.
 *
 * The trap is ours anyway, for two reasons. The fallback path is real —
 * `showModal` is missing in jsdom and in some embedded webviews, and there the
 * page behind stays reachable by Tab. And a trap that only runs where it cannot
 * be tested is a trap nobody can prove. Ours runs in both places, so the
 * behaviour is identical everywhere and the tests exercise the real thing;
 * where the platform also traps, ours simply gets there first and the platform
 * has nothing left to do.
 *
 * -----------------------------------------------------------------------------
 * WHY THE ELEMENT IS THE SCRIM
 *
 * The `<dialog>` fills the viewport and paints the scrim itself; `::backdrop`
 * is left alone. `::backdrop` sat in its own inheritance tree until recently,
 * so `var(--pv-scrim)` inside it silently resolves to nothing on older engines
 * — and a modal with no scrim looks fine to whoever built it and looks broken
 * to everyone else. Owning the scrim also gives us the outside-click target and
 * something to fade.
 */

export type DialogPhase = "closed" | "entering" | "open" | "exiting";

export interface DialogHostProps {
  readonly open: boolean;
  readonly onClose: () => void;

  /** Id of the element naming the dialog. One of this or `label` is required. */
  readonly labelledBy?: string;
  readonly label?: string;
  readonly describedBy?: string;
  /**
   * `alertdialog` only for a destructive confirmation the operator must answer.
   * It interrupts whatever a screen reader was saying; ordinary dialogs should
   * not.
   */
  readonly role?: "dialog" | "alertdialog";

  /** Classes for the full-viewport element that carries the scrim. */
  readonly containerClassName: string;
  /** Classes for the surface inside it. */
  readonly surfaceClassName: string;

  readonly glass?: boolean;
  readonly priority?: GlassPriority;

  /**
   * The element this surface grows out of and collapses back into — the row
   * that was activated, the card that expanded. Either a ref, or an identity
   * stamped by `Card` or `Panel`.
   */
  readonly originRef?: RefObject<Element | null>;
  readonly originIdentity?: string;

  /** Where focus lands on open. Defaults to the title, then the first control. */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;

  /** False for a dialog whose dismissal must be a deliberate button press. */
  readonly dismissOnOutsideClick?: boolean;
  /** False disables Escape too. Only where losing work is the alternative. */
  readonly dismissOnEscape?: boolean;

  readonly children: (surface: GlassSurface, phase: DialogPhase) => ReactNode;
}

/**
 * How many overlays are currently holding the page still.
 *
 * A counter rather than a boolean: a sheet opening a confirmation modal is a
 * real flow, and the modal closing must not hand scrolling back to a page the
 * sheet is still covering.
 */
let scrollLocks = 0;
let overflowBeforeLock = "";

function lockPageScroll(): () => void {
  const root = document.documentElement;
  if (scrollLocks === 0) {
    overflowBeforeLock = root.style.overflow;
    root.style.overflow = "hidden";
  }
  scrollLocks += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLocks -= 1;
    if (scrollLocks === 0) root.style.overflow = overflowBeforeLock;
  };
}

export function DialogHost({
  open,
  onClose,
  labelledBy,
  label,
  describedBy,
  role = "dialog",
  containerClassName,
  surfaceClassName,
  glass = true,
  priority = GLASS_PRIORITY.modal,
  originRef,
  originIdentity,
  initialFocusRef,
  dismissOnOutsideClick = true,
  dismissOnEscape = true,
  children,
}: DialogHostProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<(() => void) | null>(null);
  const pressStartedInside = useRef(false);
  const originRect = useRef<ReturnType<typeof captureOriginRect>>(null);

  // Read through a ref so the phase effect depends on `open` alone. Depending
  // on the origin as well would replay the entrance whenever a screen happened
  // to hand over a new ref object.
  const findOrigin = useRef<() => Element | null>(() => null);
  findOrigin.current = () => originRef?.current ?? identityAnchor(originIdentity);

  const [phase, setPhase] = useState<DialogPhase>(open ? "entering" : "closed");

  const surface = useGlassSurface({
    priority,
    // A closed dialog holds no lease. Three closed modals in one tree would
    // otherwise starve the shell of every slot it has.
    wantsBlur: glass && phase !== "closed",
    // True because this component genuinely does it: the page behind is inert
    // and unscrollable before the surface paints, so nothing is moving under
    // the blur. A surface that claims this without doing it is the exact defect
    // the budget exists to prevent.
    locksBackdrop: true,
  });

  // ---------------------------------------------------------------------------
  // Phase machine
  // ---------------------------------------------------------------------------

  // Declared first so the origin is measured before anything else in this
  // component touches layout, and before a scrim is painted over the row.
  useLayoutEffect(() => {
    if (open) {
      originRect.current = captureOriginRect(findOrigin.current());
      setPhase("entering");
      return;
    }
    setPhase((current) => (current === "closed" ? "closed" : "exiting"));
  }, [open]);

  const closed = phase === "closed";

  // One run per opening: show the element, lock the page, remember where focus
  // was, and put it back on the way out. Keyed on "is it closed" rather than on
  // the phase, because re-running it mid-entrance would capture the focus
  // origin from inside the dialog itself.
  useLayoutEffect(() => {
    if (closed) return;
    const dialog = dialogRef.current;
    if (dialog === null) return;

    restoreFocus.current = captureFocusOrigin(dialog.ownerDocument);

    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      // No `showModal` here, so the page behind stays reachable to a determined
      // Tab — which is why the trap in onKeyDown is installed unconditionally.
      dialog.setAttribute("open", "");
    }

    const releaseScroll = lockPageScroll();

    return () => {
      releaseScroll();
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      else dialog.removeAttribute("open");
      restoreFocus.current?.();
      restoreFocus.current = null;
    };
  }, [closed]);

  // Invert then play: measure the surface where it has landed, make it look
  // like the origin, and hand it back one frame later.
  useLayoutEffect(() => {
    if (phase !== "entering") return;
    const element = surfaceRef.current;
    if (element === null) return;

    const variables = originTransformVariables(originRect.current, captureOriginRect(element), {
      reducedMotion: prefersReducedMotion(),
    });
    for (const [name, value] of Object.entries(variables)) element.style.setProperty(name, value);

    const frame = requestAnimationFrame(() => setPhase("open"));
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  const entering = phase === "entering";

  // Focus lands on the title, so the operator hears what they are being asked
  // before they hear the buttons that answer it.
  useEffect(() => {
    if (!entering) return;
    const element = surfaceRef.current;
    if (element === null) return;
    const named =
      labelledBy === undefined
        ? null
        : (element.ownerDocument.getElementById(labelledBy) as HTMLElement | null);
    focusInitialElement(element, initialFocusRef?.current ?? named);
  }, [entering, labelledBy, initialFocusRef]);

  // Unmount only once the exit has finished, and read how long that is from the
  // element rather than from a number somebody typed next to a token.
  useEffect(() => {
    if (phase !== "exiting") return;
    const duration = readTransitionDurationMs(surfaceRef.current);
    if (duration <= 0) {
      setPhase("closed");
      return;
    }
    const timer = window.setTimeout(() => setPhase("closed"), duration);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // ---------------------------------------------------------------------------
  // Dismissal
  // ---------------------------------------------------------------------------

  function onKeyDown(event: ReactKeyboardEvent<HTMLDialogElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      if (dismissOnEscape) onClose();
      return;
    }

    const element = surfaceRef.current;
    if (element !== null && wrapTabFocus(element, event.nativeEvent)) event.preventDefault();
  }

  // A press that began inside and ended on the scrim is a text selection that
  // ran off the edge, not a dismissal. Closing on it throws away whatever the
  // operator was reading or drafting, and is the single most disliked thing a
  // modal can do.
  function onPointerDown(event: ReactPointerEvent<HTMLDialogElement>): void {
    pressStartedInside.current = surfaceRef.current?.contains(event.target as Node) === true;
  }

  function onClick(event: ReactMouseEvent<HTMLDialogElement>): void {
    if (!dismissOnOutsideClick) return;
    if (pressStartedInside.current) return;
    if (event.target !== event.currentTarget) return;
    onClose();
  }

  if (closed) return null;

  return (
    <dialog
      ref={dialogRef}
      className={`pv-dialog-host ${containerClassName}`}
      data-state={phase}
      role={role === "alertdialog" ? "alertdialog" : undefined}
      // Explicit rather than implied: on the fallback path this is not a modal
      // dialog as far as the platform is concerned, and this attribute is what
      // tells assistive technology it is one anyway.
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={labelledBy === undefined ? label : undefined}
      aria-describedby={describedBy}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissOnEscape) onClose();
      }}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      <div
        ref={surfaceRef}
        className={`pv-dialog-surface ${surfaceClassName} ${surface.surfaceClassName}`}
        data-state={phase}
      >
        {children(surface, phase)}
      </div>
    </dialog>
  );
}
