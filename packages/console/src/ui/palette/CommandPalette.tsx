import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { readCommandUse, type CommandUseMap } from "../../keyboard/frequency";
import {
  useCommandRegistry,
  useCommandRevision,
  useRunCommand,
  useSuspendShortcuts,
} from "../../keyboard/KeyboardProvider";
import { COMMAND_KIND_WORDS, type CommandDefinition } from "../../keyboard/registry";
import { SHORTCUTS, displaySequence, shortcutById, type ShortcutId } from "../../keyboard/shortcuts";
import { ReadOnlyChip } from "../surfaces/ReadOnlyChip";
import { wrapTabFocus } from "../surfaces/focusScope";
import { GLASS_PRIORITY, useGlassSurface, withScrim } from "../surfaces/glassSurface";
import { readTransitionDurationMs } from "../surfaces/originMotion";
import { SurfaceState } from "../surfaces/SurfaceState";
import { rankCommands, splitOnMatch } from "./search";
import "./CommandPalette.css";

/**
 * The command palette — primary navigation, not a bonus.
 *
 * Specification §5 is explicit: it searches actions, records and saved views in
 * one list, shows each item's shortcut, learns frequency, and everything
 * reachable by mouse is reachable here. Which means this is not a power-user
 * accelerator bolted onto a menu — it is the fastest route to anything, and it
 * is the route an operator six items into a queue of forty will use.
 *
 * -----------------------------------------------------------------------------
 * WHY IT DOES NOT USE DialogHost
 *
 * Every other overlay in the console does, and this one deliberately does not,
 * for one reason: focus restoration order.
 *
 * DialogHost restores focus to whatever opened it when it finishes unmounting,
 * which is right for a modal and wrong here. Half the commands in the palette
 * navigate, and a route change moves focus to the main landmark. If the palette
 * restored focus afterwards, the operator would be pulled back to the ⌘K button
 * a fifth of a second after arriving somewhere new — focus in one place, eyes in
 * another, and no way to tell what happened.
 *
 * So restoration happens here, synchronously, at the moment of dismissal and
 * *before* the command runs. The command then decides where focus belongs and
 * nothing takes it back. Everything else — the Tab trap, the blur lease, the
 * solid fallback, the exit timing — is the shared machinery from `surfaces/`.
 *
 * -----------------------------------------------------------------------------
 * THE TYPING PATH
 *
 * Nothing between a keystroke and the list is deferred, debounced, or
 * scheduled (spec §7: never past 120ms). Ranking is a linear pass over tens of
 * commands and is far cheaper than the timer it would take to delay it. The
 * frequency map is read once per opening rather than per keystroke, because
 * localStorage is synchronous and reading it inside the render path is the one
 * thing here that could actually be slow.
 */

export type PalettePhase = "closed" | "entering" | "open" | "exiting";

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;

  /**
   * Commands that are not in the registry — records fetched for the current
   * query. Ranked in the same list as everything else, per §5's "one list".
   */
  readonly results?: readonly CommandDefinition[];
  /** A record search is still in flight. The list stays usable while it is. */
  readonly loading?: boolean;
  /** What happened, what it means, what to do. Never "Something went wrong". */
  readonly error?: ReactNode;
  /** The control it grew out of. Focus returns here on dismissal. */
  readonly triggerRef?: RefObject<HTMLElement | null>;
  readonly onQueryChange?: (query: string) => void;
  /** Auditor session: mutating commands arrive already refused, with reasons. */
  readonly readOnly?: boolean;
  readonly placeholder?: string;
}

const DEFAULT_PLACEHOLDER = "Search actions, records and views";

export function CommandPalette({
  open,
  onClose,
  results,
  loading = false,
  error,
  triggerRef,
  onQueryChange,
  readOnly = false,
  placeholder = DEFAULT_PLACEHOLDER,
}: CommandPaletteProps) {
  const registry = useCommandRegistry();
  const revision = useCommandRevision();
  const run = useRunCommand();

  const inputId = useId();
  const listId = useId();
  const hintId = useId();

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * Where focus was when the palette opened.
   *
   * Held as the element rather than as `captureFocusOrigin`'s restore closure
   * because the decision below has to *inspect* it: `<body>` is a connected
   * HTMLElement and focusing it is not a restoration, it is losing the
   * operator's place. The closure hides that distinction.
   */
  const focusOrigin = useRef<HTMLElement | null>(null);

  const [phase, setPhase] = useState<PalettePhase>(open ? "entering" : "closed");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // Read once per opening: localStorage is synchronous, and re-reading it on
  // every keystroke would put storage access on the typing path.
  const [uses, setUses] = useState<CommandUseMap>({});

  // While the palette is open it owns the keyboard. Without this, `J` typed
  // into the field would also move the row in the list behind it and the
  // operator would return to a queue standing somewhere they never went.
  useSuspendShortcuts(phase !== "closed");

  useLayoutEffect(() => {
    if (open) {
      setPhase("entering");
      return;
    }
    setPhase((current) => (current === "closed" ? "closed" : "exiting"));
  }, [open]);

  const closed = phase === "closed";

  // One run per opening: remember where focus was, read the history, clear the
  // query. Keyed on "is it closed" so it does not re-run mid-entrance and
  // capture the focus origin from inside the palette itself.
  useLayoutEffect(() => {
    if (closed) return;
    const active = document.activeElement;
    focusOrigin.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setQuery("");
    setActiveIndex(0);
    setUses(readCommandUse());

    // An attribute rather than an inline style, so this cannot fight the
    // inline `overflow` that DialogHost sets and restores for modals and
    // sheets. Whichever of the two is still open keeps the page still.
    document.documentElement.setAttribute("data-palette", "open");
    return () => {
      document.documentElement.removeAttribute("data-palette");
    };
  }, [closed]);

  const entering = phase === "entering";

  useEffect(() => {
    if (!entering) return;
    // The field, not the title: the palette has no title, and an operator who
    // pressed ⌘K is already typing.
    inputRef.current?.focus();
    const frame = requestAnimationFrame(() => setPhase("open"));
    return () => cancelAnimationFrame(frame);
  }, [entering]);

  // Unmount only once the exit has finished, and read how long that is from the
  // element rather than from a number typed next to a token.
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

  const glass = useGlassSurface({
    priority: GLASS_PRIORITY.modal,
    wantsBlur: !closed,
    // True and honest: the scrim covers the page and the page cannot scroll
    // while it is up, so nothing is moving underneath the blur.
    locksBackdrop: true,
  });

  const ranked = useMemo(() => {
    // `revision` is the dependency that matters — the registry rebuilds its
    // list on every read, so the array identity says nothing.
    void revision;
    const available = [
      // `hidden` is how the palette's own opener stays out of its own list.
      ...registry.commands().filter((command) => command.hidden !== true),
      ...(results ?? []),
    ];
    return rankCommands(available, query, { uses });
  }, [registry, revision, results, query, uses]);

  const clampedIndex = ranked.length === 0 ? 0 : Math.min(activeIndex, ranked.length - 1);
  const active = ranked[clampedIndex];

  /**
   * Put focus back where it was, then let the caller close.
   *
   * Called before a command runs, never after: see the note at the top of this
   * file about why the usual order is wrong here.
   *
   * "Where it was" first and the trigger second, because they are usually not
   * the same place. An operator who presses ⌘K standing on a queue row belongs
   * back on that row, not on a button in the top bar they never touched. The
   * trigger is the fallback for the case where focus was nowhere in particular
   * — straight after a route change, say.
   */
  const restoreAndClose = useCallback(() => {
    const origin = focusOrigin.current;
    focusOrigin.current = null;
    if (origin !== null && origin.isConnected) origin.focus();
    else triggerRef?.current?.focus();
    onClose();
  }, [onClose, triggerRef]);

  function choose(command: CommandDefinition): void {
    if (command.disabled === true) return;
    restoreAndClose();
    run(command);
  }

  function move(delta: number): void {
    if (ranked.length === 0) return;
    const next = (((clampedIndex + delta) % ranked.length) + ranked.length) % ranked.length;
    setActiveIndex(next);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        restoreAndClose();
        return;
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        event.preventDefault();
        setActiveIndex(Math.max(0, ranked.length - 1));
        return;
      case "Enter": {
        event.preventDefault();
        if (active !== undefined) choose(active.command);
        return;
      }
      default:
        break;
    }

    const element = surfaceRef.current;
    if (element !== null && wrapTabFocus(element, event.nativeEvent)) event.preventDefault();
  }

  if (closed) return null;

  const countLabel =
    ranked.length === 1 ? "1 result" : `${ranked.length.toLocaleString()} results`;

  return createPortal(
    <div
      className="pv-palette-host"
      data-state={phase}
      // A press that began inside and ended on the scrim is a selection that ran
      // off the edge, not a dismissal.
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) restoreAndClose();
      }}
    >
      <div
        ref={surfaceRef}
        className={`pv-palette ${glass.surfaceClassName}`}
        data-state={phase}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className={withScrim("pv-palette-search", glass.scrimClassName)}>
          <label className="pv-sr-only" htmlFor={inputId}>
            Search actions, records and saved views
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className="pv-palette-input"
            type="text"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={query}
            // Both track whether a list is actually on screen. Pointing
            // `aria-controls` at an id that is not in the document is a broken
            // reference some screen readers announce and others ignore, which
            // is worse than either.
            aria-expanded={ranked.length > 0}
            aria-controls={ranked.length > 0 ? listId : undefined}
            aria-describedby={hintId}
            aria-activedescendant={active === undefined ? undefined : optionId(listId, clampedIndex)}
            onChange={(event) => {
              // Synchronous, undeferred, unthrottled. Spec §7.
              setQuery(event.target.value);
              setActiveIndex(0);
              onQueryChange?.(event.target.value);
            }}
          />
          {readOnly ? <ReadOnlyChip /> : null}
          <kbd className="pv-palette-key">Esc</kbd>
        </div>

        {error === undefined ? null : (
          <div className={withScrim("pv-palette-notice", glass.scrimClassName)}>
            <SurfaceState error={error} />
          </div>
        )}

        <div className={withScrim("pv-palette-results", glass.scrimClassName)}>
          {/* Announced politely so a screen-reader user knows the list changed
              under them as they type, without the count interrupting a word. */}
          <p className="pv-sr-only" role="status">
            {ranked.length === 0 ? "No results" : countLabel}
          </p>

          {loading ? (
            <p className="pv-palette-loading" role="status">
              Still searching records
            </p>
          ) : null}

          {ranked.length === 0 ? (
            <div className="pv-palette-empty">
              <p className="pv-palette-empty-title">
                {query.trim().length === 0
                  ? "Nothing is available here yet."
                  : `Nothing matches “${query.trim()}”.`}
              </p>
              <p className="pv-palette-empty-body">
                Try a case reference, an owner&rsquo;s name, or a verb such as approve, export, or
                go to.
              </p>
            </div>
          ) : (
            <ul className="pv-palette-list" id={listId} role="listbox" aria-label="Results">
              {ranked.map((entry, index) => (
                <PaletteRow
                  key={entry.command.id}
                  id={optionId(listId, index)}
                  command={entry.command}
                  match={entry.match}
                  active={index === clampedIndex}
                  onHover={() => setActiveIndex(index)}
                  onChoose={() => choose(entry.command)}
                />
              ))}
            </ul>
          )}
        </div>

        <p className={withScrim("pv-palette-footer", glass.scrimClassName)} id={hintId}>
          <span>
            <kbd className="pv-palette-key">↑</kbd>
            <kbd className="pv-palette-key">↓</kbd> to move
          </span>
          <span>
            <kbd className="pv-palette-key">Enter</kbd> to run
          </span>
          <span>
            <kbd className="pv-palette-key">{displaySequence(SHORTCUTS.shortcutReference)}</kbd> for
            all shortcuts
          </span>
        </p>
      </div>
    </div>,
    document.body,
  );
}

function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

function PaletteRow({
  id,
  command,
  match,
  active,
  onHover,
  onChoose,
}: {
  readonly id: string;
  readonly command: CommandDefinition;
  readonly match: { readonly start: number; readonly end: number } | null;
  readonly active: boolean;
  readonly onHover: () => void;
  readonly onChoose: () => void;
}) {
  const parts = splitOnMatch(command.label, match);
  const disabled = command.disabled === true;
  const keys = command.shortcut === undefined ? null : displayFor(command.shortcut);

  return (
    <li
      id={id}
      className="pv-palette-row"
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      data-active={active ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      onPointerEnter={onHover}
      onPointerMove={(event: ReactPointerEvent<HTMLLIElement>) => {
        // Only a real pointer move claims the active row. Without this, the row
        // under a stationary cursor steals selection back from the arrow keys.
        if (event.movementX !== 0 || event.movementY !== 0) onHover();
      }}
      onClick={onChoose}
    >
      <span className="pv-palette-row-text">
        <span className="pv-palette-row-label">
          {parts.matched === "" ? (
            command.label
          ) : (
            <>
              {parts.before}
              <mark className="pv-palette-mark">{parts.matched}</mark>
              {parts.after}
            </>
          )}
        </span>
        {command.hint === undefined ? null : (
          <span className="pv-palette-row-hint">{command.hint}</span>
        )}
        {disabled && command.disabledReason !== undefined ? (
          <span className="pv-palette-row-hint" data-refused="true">
            Unavailable: {command.disabledReason}
          </span>
        ) : null}
      </span>

      {/* The kind as a word, never as a colour: this list is printed into
          handover packs and read by people who cannot separate two tints. */}
      <span className="pv-palette-row-kind">{COMMAND_KIND_WORDS[command.kind]}</span>
      {keys === null ? null : <kbd className="pv-palette-key">{keys}</kbd>}
    </li>
  );
}

function displayFor(shortcut: ShortcutId): string {
  return displaySequence(shortcutById(shortcut));
}
