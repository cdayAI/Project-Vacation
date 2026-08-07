/**
 * The keyboard verbs, as data.
 *
 * Design specification §5 is a table of eleven rows. The obvious way to build it
 * is eleven `addEventListener` calls spread across the screens that care, and
 * that way fails three times over: the same key comes to mean two things on two
 * screens, a shortcut fires while somebody is typing their rejection reason, and
 * the shortcut reference drifts because it is a second hand-written list.
 *
 * So the table is declared once, here, as values. Everything downstream reads
 * it: the dispatcher matches against it, the command palette renders each row's
 * keys from it, and the `?` reference is generated from it. There is no second
 * list to keep in step, which is the only way a keyboard model stays true a year
 * after the person who wrote it has moved on.
 *
 * This module is deliberately free of React and of the DOM beyond a single
 * `Element` check. Key matching, the "G then Q" sequence machine, and the
 * typing guard are the parts most likely to be subtly wrong, and they are all
 * testable here without mounting anything.
 */

/**
 * Where a verb applies.
 *
 * This is documentation and palette grouping — it is *not* what gates a key.
 * A shortcut fires only when a command is bound to it (see registry.ts), and
 * the approve command exists only on an approval, so "approval context only"
 * is true by construction rather than by a second mechanism that can disagree
 * with the first.
 */
export type ShortcutScope = "global" | "list" | "approval" | "form";

export type ShortcutSection = "Getting around" | "Working a list" | "Deciding" | "Everywhere";

/** The order sections appear in the reference and in the palette's footer. */
export const SHORTCUT_SECTIONS: readonly ShortcutSection[] = [
  "Getting around",
  "Working a list",
  "Deciding",
  "Everywhere",
];

/**
 * One key press.
 *
 * `shift: "any"` exists because a printable character already encodes its own
 * shift state: `?` is only reachable with Shift on a US layout and without it on
 * others, so requiring or forbidding Shift would make the key work in one
 * country and not the next. Letters are the opposite case — `j` must not fire
 * on Shift+J, because Shift+J is the range-select the table owns — so they
 * leave `shift` unset and it defaults to "must be absent".
 */
export interface KeyChord {
  /** Compared against `KeyboardEvent.key`, case-insensitively. */
  readonly key: string;
  readonly meta?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean | "any";
  readonly alt?: boolean;
}

export interface ShortcutDefinition {
  /**
   * Typed as a plain string rather than as `ShortcutId`, which is derived from
   * this table: naming the derived type here would make the table's type refer
   * to itself. Callers use `ShortcutId`, which is exact.
   */
  readonly id: string;
  /** Imperative and plain. This is what the palette and the reference show. */
  readonly label: string;
  /** One sentence of consequence, for the reference. */
  readonly description: string;
  readonly section: ShortcutSection;
  readonly scope: ShortcutScope;
  /**
   * The ways to press it. Each entry is a *sequence* — one chord for `⌘K`, two
   * for "G then Q" — and multiple entries are alternatives, which is how
   * ⌘K and Ctrl+K are one verb rather than two.
   */
  readonly sequences: readonly (readonly KeyChord[])[];
  /**
   * Fires even while the operator is typing.
   *
   * True for exactly three verbs, and each one earns it: the palette is how you
   * leave a field you are stuck in, ⌘Enter submits the form you are typing into,
   * and Escape has meant "get me out" since before any of us started. Every
   * other verb is a bare letter, and a bare letter that fires mid-sentence is
   * the defect this flag exists to keep rare.
   */
  readonly whileTyping?: boolean;
}

/** The subset of a KeyboardEvent this module needs. Lets tests pass plain objects. */
export interface KeyPress {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * How long a half-finished sequence waits for its second key.
 *
 * Long enough that "G" then a moment's thought then "Q" still works, short
 * enough that a "G" typed and abandoned does not turn the next unrelated "A"
 * into a navigation. A second and a half is roughly where both stop being true.
 */
export const CHORD_TIMEOUT_MS = 1500;

/**
 * The table from specification §5, complete and in its order.
 *
 * `goSettings` is the one row that needed a decision. The console has no single
 * settings screen — configuration lives across the Admin zone — so the verb
 * lands on the first Admin surface the operator's role can open, and does
 * nothing when the role has none. Sending it to a screen that does not exist, or
 * dropping the row, would both have been worse than saying so.
 */
export const SHORTCUTS = {
  commandPalette: {
    id: "commandPalette",
    label: "Command palette",
    description: "Search actions, records and saved views in one list.",
    section: "Getting around",
    scope: "global",
    sequences: [[{ key: "k", meta: true }], [{ key: "k", ctrl: true }]],
    whileTyping: true,
  },
  search: {
    id: "search",
    label: "Search this screen",
    description: "Puts the cursor in the search field for whatever you are looking at.",
    section: "Getting around",
    scope: "global",
    sequences: [[{ key: "/", shift: "any" }]],
  },
  goQueue: {
    id: "goQueue",
    label: "Go to the work queue",
    description: "Everything waiting, across every workflow.",
    section: "Getting around",
    scope: "global",
    sequences: [[{ key: "g" }, { key: "q" }]],
  },
  goApprovals: {
    id: "goApprovals",
    label: "Go to approvals",
    description: "The decisions waiting on you.",
    section: "Getting around",
    scope: "global",
    sequences: [[{ key: "g" }, { key: "a" }]],
  },
  goEvidence: {
    id: "goEvidence",
    label: "Go to audit and evidence",
    description: "The record of what happened and what it was based on.",
    section: "Getting around",
    scope: "global",
    sequences: [[{ key: "g" }, { key: "e" }]],
  },
  goSettings: {
    id: "goSettings",
    label: "Go to settings",
    description: "The first administration surface your role can open.",
    section: "Getting around",
    scope: "global",
    sequences: [[{ key: "g" }, { key: "s" }]],
  },
  nextItem: {
    id: "nextItem",
    label: "Next item",
    description: "Moves down one row without opening it.",
    section: "Working a list",
    scope: "list",
    sequences: [[{ key: "j" }]],
  },
  previousItem: {
    id: "previousItem",
    label: "Previous item",
    description: "Moves up one row without opening it.",
    section: "Working a list",
    scope: "list",
    sequences: [[{ key: "k" }]],
  },
  openItem: {
    id: "openItem",
    label: "Open the focused item",
    description: "Opens the row you are standing on.",
    section: "Working a list",
    scope: "list",
    sequences: [[{ key: "Enter" }]],
  },
  previewItem: {
    id: "previewItem",
    label: "Preview the focused item",
    description: "Shows the row in the context panel without leaving the list.",
    section: "Working a list",
    scope: "list",
    sequences: [[{ key: " " }]],
  },
  toggleSelection: {
    id: "toggleSelection",
    label: "Select or deselect",
    description: "Adds the focused row to the selection, or takes it out.",
    section: "Working a list",
    scope: "list",
    sequences: [[{ key: "x" }]],
  },
  approve: {
    id: "approve",
    label: "Approve",
    description: "Records the decision and moves to the next item.",
    section: "Deciding",
    scope: "approval",
    sequences: [[{ key: "a" }]],
  },
  reject: {
    id: "reject",
    label: "Reject",
    description: "Opens the reason selector; the reason becomes improvement signal.",
    section: "Deciding",
    scope: "approval",
    sequences: [[{ key: "r" }]],
  },
  focusCopilot: {
    id: "focusCopilot",
    label: "Focus the copilot",
    description: "Puts the cursor in the copilot in the context panel.",
    section: "Everywhere",
    scope: "global",
    sequences: [[{ key: "c" }]],
  },
  submit: {
    id: "submit",
    label: "Submit",
    description: "Runs the primary action of the form you are in.",
    section: "Everywhere",
    scope: "form",
    sequences: [
      [{ key: "Enter", meta: true }],
      [{ key: "Enter", ctrl: true }],
    ],
    whileTyping: true,
  },
  dismiss: {
    id: "dismiss",
    label: "Close, cancel, or step back",
    description: "Closes what is open, or returns you one level.",
    section: "Everywhere",
    scope: "global",
    sequences: [[{ key: "Escape" }]],
    whileTyping: true,
  },
  shortcutReference: {
    id: "shortcutReference",
    label: "Keyboard shortcuts",
    description: "This list.",
    section: "Everywhere",
    scope: "global",
    sequences: [[{ key: "?", shift: "any" }]],
  },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** The table in declaration order. The reference and the palette both read this. */
export const SHORTCUT_LIST: readonly ShortcutDefinition[] = Object.values(SHORTCUTS);

export function shortcutById(id: ShortcutId): ShortcutDefinition {
  return SHORTCUTS[id];
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function sameKey(chordKey: string, pressed: string): boolean {
  // Letters arrive uppercase when Caps Lock is on, and the operator did not
  // mean something different by it.
  return chordKey.toLowerCase() === pressed.toLowerCase();
}

export function chordMatches(chord: KeyChord, press: KeyPress): boolean {
  if (!sameKey(chord.key, press.key)) return false;
  if ((chord.meta ?? false) !== press.metaKey) return false;
  if ((chord.ctrl ?? false) !== press.ctrlKey) return false;
  if ((chord.alt ?? false) !== press.altKey) return false;
  if (chord.shift === "any") return true;
  return (chord.shift ?? false) === press.shiftKey;
}

/**
 * Is this key press a modifier being held on its own?
 *
 * Holding Meta to reach ⌘K sends a `Meta` keydown first. Feeding that to the
 * sequence machine would clear a half-typed "G" every time somebody reached for
 * a modifier, so those presses are ignored outright.
 */
export function isModifierPress(press: KeyPress): boolean {
  return (
    press.key === "Meta" ||
    press.key === "Control" ||
    press.key === "Shift" ||
    press.key === "Alt" ||
    press.key === "CapsLock"
  );
}

export type KeyResolution =
  /** A complete verb. Run it. */
  | { readonly kind: "match"; readonly shortcut: ShortcutDefinition }
  /** The first half of a sequence. Hold it and wait for the next key. */
  | { readonly kind: "pending"; readonly pressed: readonly KeyPress[] }
  /** Nothing in the table wants this. Let the browser have it. */
  | { readonly kind: "none" };

/**
 * Resolves one key press against the table, given whatever is already half
 * typed.
 *
 * `available` is the subset of the table that currently has a command bound to
 * it. Passing the whole table would make "G then Q" swallow the Q on a screen
 * where the queue is not reachable, which reads as a keyboard that eats
 * keystrokes — the single most infuriating way this pattern fails.
 */
export function resolveKeyPress(
  available: readonly ShortcutDefinition[],
  pressed: readonly KeyPress[],
  press: KeyPress,
): KeyResolution {
  if (isModifierPress(press)) return { kind: "pending", pressed };

  const attempt = [...pressed, press];
  let anyPrefix = false;

  for (const definition of available) {
    for (const sequence of definition.sequences) {
      if (sequence.length < attempt.length) continue;

      let prefixHolds = true;
      for (let index = 0; index < attempt.length; index += 1) {
        const chord = sequence[index];
        const candidate = attempt[index];
        if (chord === undefined || candidate === undefined || !chordMatches(chord, candidate)) {
          prefixHolds = false;
          break;
        }
      }
      if (!prefixHolds) continue;

      if (sequence.length === attempt.length) return { kind: "match", shortcut: definition };
      anyPrefix = true;
    }
  }

  if (anyPrefix) return { kind: "pending", pressed: attempt };
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// The typing guard
// ---------------------------------------------------------------------------

/**
 * Input types that are not text entry.
 *
 * A checkbox or a radio is an `<input>` the operator is not typing into, and
 * treating it as one would mean `J` stops working the moment focus lands on a
 * row's selection box — which is exactly where a queue operator's focus lives.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * True when the operator is typing and a bare letter must not be a verb.
 *
 * This is the defect the whole module exists to prevent: an approver types a
 * rejection reason containing the word "extract", and the `x`, the `a`, and the
 * `c` each do something to the screen behind the field. It is infuriating, it
 * looks like data loss, and it is tested explicitly.
 *
 * `contenteditable` is detected by attribute rather than by `isContentEditable`
 * because jsdom does not implement the property — a guard that cannot be tested
 * is a guard that will be regressed.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof Element)) return false;

  if (target.closest('[contenteditable]:not([contenteditable="false"])') !== null) return true;

  const role = target.getAttribute("role");
  if (role === "textbox" || role === "searchbox" || role === "spinbutton") return true;
  // A combobox is a text field in every case this console builds one.
  if (role === "combobox") return true;

  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target.getAttribute("type") ?? "text").toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Whether to draw ⌘ or spell out Ctrl.
 *
 * Read from the user agent because there is no other signal, and read once per
 * call rather than cached so a test can change it. Anything that is not clearly
 * an Apple platform gets the spelled-out form, which is the safe direction: a
 * Windows operator shown ⌘ has to guess, a Mac operator shown Ctrl reads it as
 * an alternative that also works, and on a Mac it does.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const source = `${navigator.userAgent} ${(navigator as { platform?: string }).platform ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(source);
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  " ": "Space",
  Enter: "Enter",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function keyName(key: string): string {
  const named = KEY_NAMES[key];
  if (named !== undefined) return named;
  return key.length === 1 ? key.toUpperCase() : key;
}

/** `⌘ K`, `Ctrl K`, `G then Q`. One sequence, ready to print. */
export function formatSequence(
  sequence: readonly KeyChord[],
  options: { readonly apple?: boolean } = {},
): string {
  const apple = options.apple ?? isApplePlatform();
  return sequence
    .map((chord) => {
      const parts: string[] = [];
      if (chord.meta === true) parts.push(apple ? "⌘" : "Meta");
      if (chord.ctrl === true) parts.push(apple ? "⌃" : "Ctrl");
      if (chord.alt === true) parts.push(apple ? "⌥" : "Alt");
      if (chord.shift === true) parts.push(apple ? "⇧" : "Shift");
      parts.push(keyName(chord.key));
      return parts.join(apple ? "" : " ");
    })
    .join(" then ");
}

/**
 * The one sequence to show an operator, out of the alternatives.
 *
 * A row that reads "⌘K or Ctrl K" is a row that has told the operator to work
 * out which half applies to them. Pick the half that does.
 */
export function displaySequence(
  definition: ShortcutDefinition,
  options: { readonly apple?: boolean } = {},
): string {
  const apple = options.apple ?? isApplePlatform();
  const preferred =
    definition.sequences.find((sequence) =>
      sequence.some((chord) => (apple ? chord.meta === true : chord.ctrl === true)),
    ) ?? definition.sequences[0];
  return preferred === undefined ? "" : formatSequence(preferred, { apple });
}
