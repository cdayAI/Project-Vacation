/**
 * The command palette and the shortcut reference.
 *
 * Both read the keyboard registry rather than a list of their own, which is
 * what keeps "every action reachable by mouse is reachable here" (spec §5) a
 * property of the system instead of a promise somebody has to keep by hand.
 *
 * This is the palette barrel only. `src/ui/index.ts` is assembled centrally
 * once every part of the library has landed; nothing here writes to it.
 */

export { CommandPalette } from "./CommandPalette";
export type { CommandPaletteProps, PalettePhase } from "./CommandPalette";

export { ShortcutReference } from "./ShortcutReference";
export type { ShortcutReferenceProps } from "./ShortcutReference";

export { normalize, rankCommands, scoreCommand, splitOnMatch, subsequenceMatches } from "./search";
export type { MatchRange, RankOptions, RankedCommand } from "./search";
