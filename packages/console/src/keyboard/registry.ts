import type { ShortcutDefinition, ShortcutId } from "./shortcuts";
import { SHORTCUT_LIST } from "./shortcuts";

/**
 * The verb registry.
 *
 * A command is a thing the console can do, described as data: what it is called,
 * what kind of thing it is, which keyboard verb it answers to, and the function
 * that does it. Screens contribute commands while they are mounted and take them
 * away when they leave.
 *
 * This is what makes the two halves of specification §5 one mechanism rather
 * than two. The dispatcher asks the registry "does anything answer to `A` right
 * now?", and the palette asks it "what can I do right now?" — the same list,
 * so a command that has a shortcut shows that shortcut in the palette without
 * anybody maintaining a mapping, and a key that appears in the reference but is
 * bound to nothing cannot silently pretend to work.
 *
 * -----------------------------------------------------------------------------
 * WHY SOURCES AND NOT COMMANDS
 *
 * A screen's commands close over its state — the row that is focused, the
 * approval being decided — so they are new function objects on every render.
 * Registering them individually means either re-registering the world on every
 * keystroke, or holding a stale closure that approves the item the operator was
 * looking at two renders ago. The second is a governance bug, not a UI bug.
 *
 * So a *source* is registered instead: a function that returns the current
 * commands. It is registered once when a screen mounts and read afresh whenever
 * the answer is needed, which makes staleness impossible rather than unlikely.
 *
 * -----------------------------------------------------------------------------
 * WHY LAST REGISTERED WINS
 *
 * The shell registers a fallback for `/` that opens the palette, because a
 * screen with no search of its own should still do something sensible. A screen
 * with a real search registers its own, and it mounts after the shell. Reading
 * sources in reverse registration order means the specific one wins without the
 * shell having to know which screens have search fields.
 */

export type CommandKind = "action" | "navigate" | "record" | "view";

/** How each kind is named to the operator. Words, never colour alone. */
export const COMMAND_KIND_WORDS: Readonly<Record<CommandKind, string>> = {
  action: "Action",
  navigate: "Go to",
  record: "Record",
  view: "Saved view",
};

export interface CommandDefinition {
  /**
   * Stable across renders and unique. Used as the palette's row key and as the
   * key the frequency history is kept under, so an id that changes with the
   * state it describes throws that operator's history away.
   */
  readonly id: string;
  /** Imperative, plain, and specific: "Approve and go to the next item". */
  readonly label: string;
  readonly kind: CommandKind;
  /** A second line: what it will do, not a restatement of the label. */
  readonly hint?: string;
  /** Words an operator might search for that are not in the label. */
  readonly keywords?: readonly string[];
  /** The verb from the §5 table this command answers to. */
  readonly shortcut?: ShortcutId;
  /**
   * Offered but refused, with the reason. Not hidden: a command that vanishes
   * teaches the operator it never existed, and the commonest question in an
   * operations console is "where has the approve button gone".
   */
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  /**
   * Bound to a verb, but not listed in the palette.
   *
   * For the handful of commands whose row would be noise: the one that opens
   * the palette, and the one `/` uses to fall back to it when a screen has no
   * search of its own. Both are real verbs that belong in the `?` reference and
   * neither is something an operator would ever want to pick out of a list they
   * are already looking at.
   */
  readonly hidden?: boolean;
  /**
   * Declines a verb while the operator is typing, even though the verb itself
   * allows it.
   *
   * Only ever narrows. Escape is `whileTyping` in the table because escaping a
   * field is what it has always meant — but "Escape goes back to the queue" must
   * not fire from inside a rejection-reason box, where Escape means "cancel what
   * I am typing". A command that would lose work says so here, and the screen
   * that owns the field registers its own Escape on top.
   */
  readonly whileTyping?: boolean;
  readonly run: () => void;
}

export type CommandSource = () => readonly CommandDefinition[];

/**
 * The registry.
 *
 * A plain class rather than a hook so that the dispatch logic and the ordering
 * rules can be tested without mounting React, and so the palette and the key
 * handler are demonstrably reading the same object.
 */
export class CommandRegistry {
  private readonly sources = new Map<string, CommandSource>();
  /** Registration order, so "last registered wins" is a fact and not a hope. */
  private order: string[] = [];
  private readonly listeners = new Set<() => void>();
  private suspensions = 0;
  /**
   * Bumped whenever the answer to `commands()` could have changed. Components
   * subscribe to this number rather than to the command array, because an array
   * rebuilt on every read would make `useSyncExternalStore` loop forever.
   */
  private revision = 0;

  registerSource(id: string, source: CommandSource): () => void {
    this.sources.set(id, source);
    this.order = [...this.order.filter((existing) => existing !== id), id];
    this.bump();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sources.delete(id);
      this.order = this.order.filter((existing) => existing !== id);
      this.bump();
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getRevision = (): number => this.revision;

  /**
   * Every command available right now, most recently registered source first.
   *
   * Duplicate ids collapse to the first seen, which — given the ordering — is
   * the most specific one. That is what lets a screen override a shell default
   * by using the same id.
   */
  commands(): readonly CommandDefinition[] {
    const seen = new Set<string>();
    const result: CommandDefinition[] = [];
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const sourceId = this.order[index];
      if (sourceId === undefined) continue;
      const source = this.sources.get(sourceId);
      if (source === undefined) continue;
      for (const command of source()) {
        if (seen.has(command.id)) continue;
        seen.add(command.id);
        result.push(command);
      }
    }
    return result;
  }

  /** The command bound to a verb, or undefined when nothing answers to it. */
  commandForShortcut(shortcut: ShortcutId): CommandDefinition | undefined {
    return this.commands().find((command) => command.shortcut === shortcut);
  }

  /**
   * The rows of the §5 table that would actually do something if pressed.
   *
   * The dispatcher matches against this rather than against the whole table, so
   * a half-typed "G" on a screen where the queue is unreachable does not swallow
   * the following key. A keyboard that eats keystrokes is the worst way this
   * pattern fails, because it is invisible.
   */
  availableShortcuts(): readonly ShortcutDefinition[] {
    const bound = new Set<string>();
    for (const command of this.commands()) {
      if (command.shortcut !== undefined && command.disabled !== true) bound.add(command.shortcut);
    }
    return SHORTCUT_LIST.filter((definition) => bound.has(definition.id));
  }

  /**
   * Stops the dispatcher until every suspension is released.
   *
   * An open palette, modal, or sheet suspends it. Without this, `J` typed into
   * the palette's own field would also move the row behind it, and the operator
   * would come back to a list standing somewhere they never went. A counter
   * rather than a flag because a sheet opening a confirmation modal is a real
   * flow and the modal closing must not resume the world underneath the sheet.
   */
  suspend(): () => void {
    this.suspensions += 1;
    this.bump();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.suspensions -= 1;
      this.bump();
    };
  }

  get suspended(): boolean {
    return this.suspensions > 0;
  }

  private bump(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}
