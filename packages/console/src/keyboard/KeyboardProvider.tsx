import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { recordCommandUse } from "./frequency";
import { CommandRegistry, type CommandDefinition } from "./registry";
import {
  CHORD_TIMEOUT_MS,
  isTypingTarget,
  resolveKeyPress,
  type KeyPress,
  type ShortcutDefinition,
} from "./shortcuts";

/**
 * The one keyboard listener in the console.
 *
 * Everything in specification §5 arrives through this single handler on the
 * document, resolved against the registry. There is deliberately no second
 * place a global key is handled: two listeners for the same key is how `A` comes
 * to mean approve on one screen and archive on another, and neither author ever
 * sees the conflict because each tested their own screen.
 *
 * The handler's whole job is four checks in order — is dispatch suspended, is
 * the operator typing, does anything answer to this key, and is it the second
 * half of a sequence — and it is short on purpose. The parts worth testing hard
 * live in shortcuts.ts and registry.ts, without React.
 */

interface KeyboardContextValue {
  readonly registry: CommandRegistry;
  /** Runs a command and remembers that it was run. The only way to run one. */
  readonly run: (command: CommandDefinition) => void;
}

const KeyboardContext = createContext<KeyboardContextValue | null>(null);

export function KeyboardProvider({
  children,
  registry: provided,
}: {
  readonly children: ReactNode;
  /** A registry to use instead of this provider's own. For tests. */
  readonly registry?: CommandRegistry;
}) {
  // One registry per provider, created once. A registry rebuilt on re-render
  // would drop every source a screen had registered against the previous one,
  // and the symptom is shortcuts that work until something above them updates.
  const ownRegistry = useMemo(() => new CommandRegistry(), []);
  const registry = provided ?? ownRegistry;

  const run = useCallback((command: CommandDefinition) => {
    if (command.disabled === true) return;
    // Recorded before running: a command that navigates away replaces this
    // page, and a write scheduled after it may never happen.
    recordCommandUse(command.id);
    command.run();
  }, []);

  // The half-typed sequence, held in a ref rather than in state: it changes on
  // a keystroke and must not cost a render, because it sits on the critical
  // typing path (spec §7).
  const pending = useRef<{ readonly presses: readonly KeyPress[]; readonly at: number }>({
    presses: [],
    at: 0,
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Somebody closer to the event already dealt with it — a listbox handling
      // its own arrows, a dialog handling its own Escape.
      if (event.defaultPrevented) return;
      if (registry.suspended) {
        pending.current = { presses: [], at: 0 };
        return;
      }

      // A key that is part of an IME composition is not a verb. Without this
      // check, composing Japanese or Korean text fires shortcuts on the way.
      if (event.isComposing) return;

      const press: KeyPress = {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      };

      const typing = isTypingTarget(event.target);
      const available: readonly ShortcutDefinition[] = registry
        .availableShortcuts()
        .filter((definition) => !typing || definition.whileTyping === true);

      if (available.length === 0) {
        pending.current = { presses: [], at: 0 };
        return;
      }

      // A sequence that has been sitting half finished for longer than the
      // window is abandoned, not continued: the "G" was a keystroke the
      // operator has since forgotten about.
      const now = Date.now();
      const carried =
        pending.current.presses.length > 0 && now - pending.current.at <= CHORD_TIMEOUT_MS
          ? pending.current.presses
          : [];

      const resolution = resolveKeyPress(available, carried, press);

      if (resolution.kind === "pending") {
        pending.current = { presses: resolution.pressed, at: now };
        // Prevented so the browser's own quick-find does not eat the "G" and
        // start a page search. Only ever a key that begins a real sequence.
        if (resolution.pressed.length > 0) event.preventDefault();
        return;
      }

      pending.current = { presses: [], at: 0 };
      if (resolution.kind === "none") return;

      // Compared by value rather than through `commandForShortcut`, whose
      // parameter is the exact `ShortcutId` union: a definition's own `id` is
      // widened to `string` to keep the table's type from referring to itself,
      // and a cast here would be a cast on the one path that must not be wrong.
      const command = registry
        .commands()
        .find((candidate) => candidate.shortcut === resolution.shortcut.id);
      if (command === undefined || command.disabled === true) return;
      // A command may decline a verb the verb itself allows while typing —
      // Escape is the case that matters, where "go back" must not fire from
      // inside a half-written rejection reason.
      if (typing && command.whileTyping === false) return;

      event.preventDefault();
      run(command);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [registry, run]);

  const value = useMemo<KeyboardContextValue>(() => ({ registry, run }), [registry, run]);

  return <KeyboardContext.Provider value={value}>{children}</KeyboardContext.Provider>;
}

function useKeyboard(): KeyboardContextValue {
  const value = useContext(KeyboardContext);
  if (value === null) {
    throw new Error("This hook was called outside KeyboardProvider.");
  }
  return value;
}

export function useCommandRegistry(): CommandRegistry {
  return useKeyboard().registry;
}

/** Runs a command and records that it was run. Use this, never `command.run`. */
export function useRunCommand(): (command: CommandDefinition) => void {
  return useKeyboard().run;
}

/**
 * Contributes commands for as long as this component is mounted.
 *
 * The array may be rebuilt on every render — that is expected and costs
 * nothing. What is registered is a function that reads the latest array, so a
 * command always acts on the state of the render the operator is looking at
 * rather than on the render it was registered in. Approving the wrong item
 * because a closure was one render stale is a governance failure, not a
 * cosmetic one.
 */
export function useCommandSource(commands: readonly CommandDefinition[]): void {
  const registry = useCommandRegistry();
  const sourceId = useId();
  const latest = useRef(commands);
  latest.current = commands;

  useEffect(() => registry.registerSource(sourceId, () => latest.current), [registry, sourceId]);
}

/**
 * Stops global shortcuts while something owns the keyboard.
 *
 * Any overlay with its own key handling — the palette, a modal, a sheet — holds
 * one of these open. Nothing else should.
 */
export function useSuspendShortcuts(active: boolean): void {
  const registry = useCommandRegistry();
  useEffect(() => {
    if (!active) return;
    return registry.suspend();
  }, [registry, active]);
}

/**
 * Re-renders when the set of available commands changes.
 *
 * Returns the registry's revision number rather than the commands themselves:
 * the command list is rebuilt on every read, and returning a fresh array from a
 * `useSyncExternalStore` snapshot is an infinite render loop.
 */
export function useCommandRevision(): number {
  const registry = useCommandRegistry();
  return useSyncExternalStore(registry.subscribe, registry.getRevision, registry.getRevision);
}
