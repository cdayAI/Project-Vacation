import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition, type Placement } from "./anchoredSurface";
import { captureFocusOrigin } from "./focusScope";
import { GLASS_PRIORITY, useGlassSurface, withScrim } from "./glassSurface";
import { SurfaceState } from "./SurfaceState";
import "./Dropdown.css";

/**
 * A dropdown menu: a list of actions attached to the control that opened it.
 *
 * Items are data rather than children, and that is the important decision here.
 * A menu built from arbitrary children has to guess which of them are items in
 * order to give them roving focus, arrow keys, and type-ahead — and it guesses
 * wrong the first time somebody wraps an item in a tooltip. Given the list, the
 * menu can be correct about all three without guessing anything, and a caller
 * cannot accidentally put a heading inside a `role="menu"` where it is invalid.
 *
 * Behaviour follows the platform menu conventions an operator already has in
 * their hands: arrows move, Home and End jump, typing jumps to a matching item,
 * Enter and Space choose, Escape closes and puts focus back on the trigger.
 * Tab also closes and returns focus, rather than walking into a surface that
 * lives at the end of the document — see Popover.tsx for why it lives there.
 *
 * Dismissal is instant. A menu that fades out after a choice delays the action
 * the operator has already made, and the entrance is the only part of a menu
 * anybody wants to watch.
 */

export interface DropdownItem {
  readonly id: string;
  readonly label: string;
  /** A second line. Use it to say what the action will do, not to repeat it. */
  readonly description?: string;
  /** Rendered as a key hint, right-aligned. Not a binding — the screen owns that. */
  readonly shortcut?: string;
  readonly disabled?: boolean;
  /** Why it is disabled. Read by assistive technology; keep it short. */
  readonly disabledReason?: string;
  /**
   * An action that removes or stops something. Marked with a word and a rule
   * above it, never with colour alone.
   */
  readonly destructive?: boolean;
  /** A hairline above this item. For separating a destructive tail. */
  readonly separatorBefore?: boolean;
  readonly onSelect: () => void;
}

export interface DropdownProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorRef: RefObject<HTMLElement | null>;
  /** Must match the id given to `dropdownTriggerProps`. */
  readonly id: string;
  /** Names the menu. "Row actions", not "Menu". */
  readonly label: string;
  readonly items: readonly DropdownItem[];
  readonly placement?: Placement;

  readonly loading?: boolean;
  readonly error?: ReactNode;
  /** Shown when `items` is empty. Say why there is nothing, not "No items". */
  readonly empty?: ReactNode;
  readonly className?: string;
}

/** The attributes the trigger owes the menu. Spread them onto your button. */
export function dropdownTriggerProps(
  id: string,
  open: boolean,
): {
  readonly "aria-haspopup": "menu";
  readonly "aria-expanded": boolean;
  readonly "aria-controls": string | undefined;
} {
  return {
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
  };
}

/** How long a run of keystrokes counts as one type-ahead query. */
const TYPE_AHEAD_WINDOW_MS = 600;

export function Dropdown({
  open,
  onClose,
  anchorRef,
  id,
  label,
  items,
  placement = "bottom-start",
  loading = false,
  error,
  empty,
  className,
}: DropdownProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocus = useRef<(() => void) | null>(null);
  const typeAhead = useRef<{ query: string; at: number }>({ query: "", at: 0 });
  const [activeIndex, setActiveIndex] = useState(0);

  const glass = useGlassSurface({
    priority: GLASS_PRIORITY.anchored,
    wantsBlur: open,
    locksBackdrop: false,
  });

  const position = useAnchoredPosition({ open, anchorRef, surfaceRef, placement });

  // Focus the first item on open — a menu you have to arrow into once before
  // the arrows do anything is a menu that feels broken — and return focus to
  // the trigger on close.
  useEffect(() => {
    if (!open) return;
    const element = surfaceRef.current;
    if (element === null) return;

    restoreFocus.current = captureFocusOrigin(element.ownerDocument);
    setActiveIndex(0);
    const first = items[0];
    if (first !== undefined) itemRefs.current.get(first.id)?.focus();

    return () => {
      restoreFocus.current?.();
      restoreFocus.current = null;
    };
    // Deliberately only on open: re-running when `items` changes would drag
    // focus back to the top while the operator is partway down the list.
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: Event): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (surfaceRef.current?.contains(target) === true) return;
      // A press on the trigger is the trigger's business — closing here too
      // would fight its own toggle and the menu would never reopen.
      if (anchorRef.current?.contains(target) === true) return;
      onClose();
    };

    // Escape is listened for on the document because a menu that is still
    // loading has nothing to focus, so the keystroke would never reach the
    // surface's own handler.
    const onDocumentKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
    };
  }, [open, onClose, anchorRef]);

  function focusItem(index: number): void {
    if (items.length === 0) return;
    const bounded = ((index % items.length) + items.length) % items.length;
    const item = items[bounded];
    if (item === undefined) return;
    setActiveIndex(bounded);
    itemRefs.current.get(item.id)?.focus();
  }

  function choose(item: DropdownItem): void {
    if (item.disabled === true) return;
    // Close first so focus is already back on the trigger when the action runs
    // — an action that opens a sheet must not fight the menu for focus.
    onClose();
    item.onSelect();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case "ArrowDown":
        focusItem(activeIndex + 1);
        break;
      case "ArrowUp":
        focusItem(activeIndex - 1);
        break;
      case "Home":
        focusItem(0);
        break;
      case "End":
        focusItem(items.length - 1);
        break;
      case "Tab":
        // Closes and hands focus back to the trigger, rather than letting the
        // browser walk into whatever happens to follow a surface that lives at
        // the end of the document. The operator's next Tab then continues from
        // the trigger, which is where they were.
        onClose();
        break;
      default: {
        if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return;
        const now = Date.now();
        const previous = typeAhead.current;
        const query =
          now - previous.at > TYPE_AHEAD_WINDOW_MS
            ? event.key.toLowerCase()
            : previous.query + event.key.toLowerCase();
        typeAhead.current = { query, at: now };

        const start = query.length === 1 ? activeIndex + 1 : activeIndex;
        for (let step = 0; step < items.length; step += 1) {
          const candidate = items[(start + step) % items.length];
          if (candidate !== undefined && candidate.label.toLowerCase().startsWith(query)) {
            focusItem((start + step) % items.length);
            break;
          }
        }
        break;
      }
    }

    // Every key handled above is handled completely, Tab included: letting the
    // browser also move focus would race the close and land the operator
    // somewhere neither of us chose.
    event.preventDefault();
  }

  if (!open) return null;

  const hasItems = items.length > 0;

  return createPortal(
    <div
      ref={surfaceRef}
      id={id}
      className={
        className === undefined
          ? `pv-dropdown ${glass.surfaceClassName}`
          : `pv-dropdown ${glass.surfaceClassName} ${className}`
      }
      data-state={position === null ? "measuring" : "open"}
      data-placement={position?.placement ?? placement}
      style={position === null ? undefined : { top: `${position.top}px`, left: `${position.left}px` }}
      onKeyDown={onKeyDown}
    >
      {hasItems && !loading && error === undefined ? (
        <div className={withScrim("pv-dropdown-list", glass.scrimClassName)} role="menu" aria-label={label}>
          {items.map((item, index) => (
            <ItemRow
              key={item.id}
              item={item}
              active={index === activeIndex}
              register={(element) => {
                if (element === null) itemRefs.current.delete(item.id);
                else itemRefs.current.set(item.id, element);
              }}
              onChoose={() => choose(item)}
              onHover={() => setActiveIndex(index)}
            />
          ))}
        </div>
      ) : (
        <div className={withScrim("pv-dropdown-state", glass.scrimClassName)}>
          <SurfaceState loading={loading} error={error} empty={empty ?? "No actions available."} />
        </div>
      )}
    </div>,
    document.body,
  );
}

function ItemRow({
  item,
  active,
  register,
  onChoose,
  onHover,
}: {
  readonly item: DropdownItem;
  readonly active: boolean;
  readonly register: (element: HTMLButtonElement | null) => void;
  readonly onChoose: () => void;
  readonly onHover: () => void;
}) {
  const disabled = item.disabled === true;
  return (
    <>
      {item.separatorBefore === true ? <div className="pv-dropdown-separator" role="separator" /> : null}
      <button
        type="button"
        role="menuitem"
        ref={register}
        className="pv-dropdown-item"
        data-destructive={item.destructive === true || undefined}
        // Disabled items stay focusable so their reason can be read. A control
        // an operator cannot reach is a control they cannot find out about.
        aria-disabled={disabled || undefined}
        tabIndex={active ? 0 : -1}
        onClick={onChoose}
        onPointerEnter={onHover}
      >
        <span className="pv-dropdown-item-text">
          <span className="pv-dropdown-item-label">
            {item.label}
            {item.destructive === true ? (
              // The word, because the tone is a colour and the audit pack is
              // printed in black and white.
              <span className="pv-sr-only">, destructive</span>
            ) : null}
            {disabled && item.disabledReason !== undefined ? (
              <span className="pv-sr-only">, unavailable: {item.disabledReason}</span>
            ) : null}
          </span>
          {item.description === undefined ? null : (
            <span className="pv-dropdown-item-description">{item.description}</span>
          )}
        </span>
        {item.shortcut === undefined ? null : (
          <kbd className="pv-dropdown-item-shortcut">{item.shortcut}</kbd>
        )}
      </button>
    </>
  );
}

