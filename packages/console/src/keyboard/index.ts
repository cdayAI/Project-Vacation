/**
 * The keyboard model.
 *
 * Specification §5's table, the registry that binds commands to it, and the one
 * document listener that dispatches it. Screens contribute commands; nothing
 * outside this directory listens for a key.
 *
 * This is the keyboard barrel only. `src/ui/index.ts` is assembled centrally
 * once every part of the library has landed; nothing here writes to it.
 */

export {
  CHORD_TIMEOUT_MS,
  SHORTCUTS,
  SHORTCUT_LIST,
  SHORTCUT_SECTIONS,
  chordMatches,
  displaySequence,
  formatSequence,
  isApplePlatform,
  isModifierPress,
  isTypingTarget,
  resolveKeyPress,
  shortcutById,
} from "./shortcuts";
export type {
  KeyChord,
  KeyPress,
  KeyResolution,
  ShortcutDefinition,
  ShortcutId,
  ShortcutScope,
  ShortcutSection,
} from "./shortcuts";

export { COMMAND_KIND_WORDS, CommandRegistry } from "./registry";
export type { CommandDefinition, CommandKind, CommandSource } from "./registry";

export {
  KeyboardProvider,
  useCommandRegistry,
  useCommandRevision,
  useCommandSource,
  useRunCommand,
  useSuspendShortcuts,
} from "./KeyboardProvider";

export {
  COMMAND_USE_LIMIT,
  COMMAND_USE_STORAGE_KEY,
  clearCommandUse,
  familiarity,
  pruneCommandUse,
  readCommandUse,
  recordCommandUse,
  writeCommandUse,
} from "./frequency";
export type { CommandUse, CommandUseMap } from "./frequency";
