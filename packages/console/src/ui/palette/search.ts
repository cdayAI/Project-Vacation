import { familiarity, type CommandUseMap } from "../../keyboard/frequency";
import type { CommandDefinition } from "../../keyboard/registry";

/**
 * Ranking for the command palette.
 *
 * Specification §5 asks for one list holding actions, records and saved views
 * together, and §7 says typing is never blocked, filtered, or debounced past
 * 120ms. Those two together rule out anything clever: this is a linear pass with
 * a handful of integer comparisons, run synchronously on every keystroke against
 * a list that is tens of entries long, and it is faster than the debounce it
 * replaces.
 *
 * The scoring is arranged so that **what you typed always beats what you use**.
 * Match quality is worth hundreds; familiarity is worth at most a hundred and
 * only ever settles ties. A palette where habit outranks the query is a palette
 * that argues with the operator, and the operator is six items into a queue of
 * forty.
 *
 * The scale, top to bottom:
 *
 *   1000  the label is exactly what was typed
 *    600  the label starts with it
 *    420  a word in the label starts with it
 *    260  the label contains it
 *    200  a keyword starts with it
 *    150  a keyword or the hint contains it
 *     90  the letters appear in order, spread out ("aq" → "Approve queue")
 */

export interface RankedCommand {
  readonly command: CommandDefinition;
  readonly score: number;
  /** Where the query sits in the label, for highlighting. Null when it does not. */
  readonly match: MatchRange | null;
}

export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

/** Kinds in the order they break a tie. Actions first: they are why people type. */
const KIND_ORDER: Readonly<Record<CommandDefinition["kind"], number>> = {
  action: 0,
  navigate: 1,
  record: 2,
  view: 3,
};

export function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Do `query`'s characters appear in `text`, in order?
 *
 * This is the loosest match the palette accepts, and it exists for the way
 * people actually type into one of these: "gaud" for "Go to audit and
 * evidence". It scores low so it never outranks a real prefix.
 */
export function subsequenceMatches(text: string, query: string): boolean {
  if (query.length === 0) return true;
  let cursor = 0;
  for (const character of text) {
    if (character === query[cursor]) {
      cursor += 1;
      if (cursor === query.length) return true;
    }
  }
  return false;
}

/** The first word boundary at or after which `query` begins, or -1. */
function wordStartIndex(text: string, query: string): number {
  let from = 0;
  while (from <= text.length - query.length) {
    const index = text.indexOf(query, from);
    if (index < 0) return -1;
    if (index === 0 || /[\s\-/·—(]/.test(text.charAt(index - 1))) return index;
    from = index + 1;
  }
  return -1;
}

export function scoreCommand(
  command: CommandDefinition,
  query: string,
): { readonly score: number; readonly match: MatchRange | null } {
  const label = normalize(command.label);
  const trimmed = normalize(query);

  if (trimmed.length === 0) return { score: 1, match: null };

  if (label === trimmed) return { score: 1000, match: { start: 0, end: trimmed.length } };
  if (label.startsWith(trimmed)) return { score: 600, match: { start: 0, end: trimmed.length } };

  const wordStart = wordStartIndex(label, trimmed);
  if (wordStart >= 0) {
    return { score: 420, match: { start: wordStart, end: wordStart + trimmed.length } };
  }

  const contained = label.indexOf(trimmed);
  if (contained >= 0) {
    return { score: 260, match: { start: contained, end: contained + trimmed.length } };
  }

  for (const keyword of command.keywords ?? []) {
    const normalized = normalize(keyword);
    if (normalized.startsWith(trimmed)) return { score: 200, match: null };
    if (normalized.includes(trimmed)) return { score: 150, match: null };
  }

  if (command.hint !== undefined && normalize(command.hint).includes(trimmed)) {
    return { score: 150, match: null };
  }

  // Spaces are dropped before the subsequence test so that "goaudit" and "go
  // audit" behave the same. Somebody typing fast does not always hit the space.
  if (subsequenceMatches(label, trimmed.replace(/\s+/g, ""))) return { score: 90, match: null };

  return { score: 0, match: null };
}

export interface RankOptions {
  readonly uses?: CommandUseMap;
  readonly now?: number;
  /**
   * How many rows to return. The palette renders every row it is given, and a
   * thousand-row list is both slow to paint and useless to read.
   */
  readonly limit?: number;
}

/**
 * Orders commands for the palette.
 *
 * With an empty query this is the "what do you usually do" list, which is the
 * screen operators see most and the one worth getting right. With a query it is
 * relevance, tie-broken by familiarity, then by kind, then by label so the
 * ordering is stable rather than dependent on registration order — a list that
 * reshuffles between two identical searches is a list nobody trusts.
 */
export function rankCommands(
  commands: readonly CommandDefinition[],
  query: string,
  options: RankOptions = {},
): readonly RankedCommand[] {
  const uses = options.uses ?? {};
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 50;
  const trimmed = normalize(query);

  const ranked: RankedCommand[] = [];
  for (const command of commands) {
    const { score, match } = scoreCommand(command, trimmed);
    if (score === 0) continue;
    ranked.push({ command, score, match });
  }

  ranked.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;

    const leftUse = familiarity(uses[left.command.id], now);
    const rightUse = familiarity(uses[right.command.id], now);
    if (leftUse !== rightUse) return rightUse - leftUse;

    const leftKind = KIND_ORDER[left.command.kind];
    const rightKind = KIND_ORDER[right.command.kind];
    if (leftKind !== rightKind) return leftKind - rightKind;

    // A shorter label that matched as well as a longer one is the more specific
    // answer: "Approve" over "Approve and open the next item".
    if (left.command.label.length !== right.command.label.length) {
      return left.command.label.length - right.command.label.length;
    }
    return left.command.label.localeCompare(right.command.label);
  });

  return ranked.slice(0, limit);
}

/**
 * Splits a label around the matched range, for highlighting.
 *
 * Returned as three strings rather than as markup so the palette decides how to
 * draw emphasis, and so this stays testable without rendering anything.
 */
export function splitOnMatch(
  label: string,
  match: MatchRange | null,
): { readonly before: string; readonly matched: string; readonly after: string } {
  if (match === null || match.start < 0 || match.end > label.length || match.start >= match.end) {
    return { before: label, matched: "", after: "" };
  }
  return {
    before: label.slice(0, match.start),
    matched: label.slice(match.start, match.end),
    after: label.slice(match.end),
  };
}
