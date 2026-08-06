import { useCallback, useEffect, useRef } from "react";

/**
 * The option-list logic shared by Select and Combobox.
 *
 * It lives apart from both because it is the part that is usually wrong, and
 * the part that is hardest to check by clicking around: what Home does when the
 * first option is disabled, what Down does on the last option, what happens
 * when an operator types "bo" quickly and "b" slowly. Pure functions over an
 * array can be tested exhaustively; the same rules spread across two components'
 * event handlers cannot.
 */

export interface ListOption {
  readonly value: string;
  readonly label: string;
  /** A second line — an account id, a role, a status. Never the only meaning. */
  readonly description?: string;
  readonly disabled?: boolean;
}

function isPickable(option: ListOption | undefined): option is ListOption {
  return option !== undefined && option.disabled !== true;
}

/** The first option an operator can actually choose, or −1. */
export function firstEnabledIndex(options: readonly ListOption[]): number {
  for (let index = 0; index < options.length; index += 1) {
    if (isPickable(options[index])) return index;
  }
  return -1;
}

export function lastEnabledIndex(options: readonly ListOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (isPickable(options[index])) return index;
  }
  return -1;
}

/**
 * Steps by `step`, skipping disabled options.
 *
 * Wrapping is the caller's decision, not a default. In a select of six
 * statuses, wrapping from the last to the first is what an operator expects
 * from every list they have ever used. At the end of a filtered result set,
 * stopping is what stops them overshooting.
 */
export function stepIndex(
  options: readonly ListOption[],
  current: number,
  step: number,
  wrap: boolean,
): number {
  if (options.length === 0) return -1;

  let index = current;
  for (let moved = 0; moved < options.length; moved += 1) {
    index += step;
    if (index < 0 || index >= options.length) {
      if (!wrap) return current >= 0 ? current : firstEnabledIndex(options);
      index = index < 0 ? options.length - 1 : 0;
    }
    if (isPickable(options[index])) return index;
  }
  // Every option is disabled: there is nowhere to go, and moving to a disabled
  // option would let Enter commit something the operator cannot choose.
  return -1;
}

export function indexOfValue(options: readonly ListOption[], value: string | null): number {
  if (value === null) return -1;
  return options.findIndex((option) => option.value === value);
}

/**
 * Type-ahead. Returns the index the buffer points at, or −1.
 *
 * A buffer of one character, or of the same character repeated, cycles through
 * the options starting with it — pressing `p` four times walks the four
 * statuses beginning with "p". A buffer of different characters narrows
 * instead, searching from the current option so that "pa" lands on "Parked"
 * rather than jumping back to the first "p".
 */
export function typeAheadIndex(
  options: readonly ListOption[],
  buffer: string,
  from: number,
): number {
  const query = buffer.toLowerCase();
  if (query.length === 0) return -1;

  const characters = [...query];
  const cycling = characters.every((character) => character === characters[0]);
  const needle = cycling ? (characters[0] ?? "") : query;
  const start = cycling ? from + 1 : Math.max(from, 0);

  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (((start + offset) % options.length) + options.length) % options.length;
    const option = options[index];
    if (!isPickable(option)) continue;
    if (option.label.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/**
 * How long a type-ahead buffer survives between keystrokes.
 *
 * The interval every platform's list controls have used for decades. Shorter
 * and a two-word option becomes unreachable for anyone who does not type fast;
 * longer and an unrelated later keystroke joins a buffer the operator has
 * forgotten about.
 */
export const TYPE_AHEAD_RESET_MS = 500;

export interface TypeAhead {
  /** Adds a character and returns the buffer to search with. */
  readonly push: (character: string) => string;
  readonly clear: () => void;
}

export function useTypeAhead(resetMs: number = TYPE_AHEAD_RESET_MS): TypeAhead {
  const buffer = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    buffer.current = "";
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // A pending timer holds a closure over this component after it unmounts —
  // harmless here, but it is also the kind of thing that keeps a test runner
  // alive after the suite has finished.
  useEffect(() => clear, [clear]);

  const push = useCallback(
    (character: string) => {
      buffer.current += character;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        buffer.current = "";
        timer.current = null;
      }, resetMs);
      return buffer.current;
    },
    [resetMs],
  );

  return { push, clear };
}

/**
 * A printable single character, as opposed to a named key like "Enter".
 *
 * Modified keystrokes are excluded: Ctrl+A is Select All and Meta+V is a paste,
 * and treating either as type-ahead would swallow a shortcut the operator
 * expects to work.
 */
export function isTypeAheadKey(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key.length === 1 && event.key !== " ";
}

/**
 * Keeps the active option inside the scroll box.
 *
 * `block: "nearest"` rather than "center": an option list that recentres on
 * every arrow press makes the whole list move under the operator's eyes, which
 * is far more disorienting than a list that only scrolls when it has to.
 */
export function useScrollActiveIntoView(
  listRef: { current: HTMLElement | null },
  activeIndex: number,
  open: boolean,
): void {
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const list = listRef.current;
    if (list === null) return;
    const option = list.children[activeIndex];
    // jsdom implements neither scrollIntoView nor layout, so this is a no-op in
    // tests rather than a crash.
    if (option instanceof HTMLElement && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [listRef, activeIndex, open]);
}
