/**
 * What this operator actually uses.
 *
 * Specification §5 asks the palette to learn frequency, and the reason is
 * narrow and worth stating: an operator who approves rescission notices forty
 * times a day should not scroll past "Export the audit chain" to reach it. The
 * palette's first screen — before a single character is typed — is the part of
 * it people use most, and a first screen that never changes is a menu.
 *
 * Two decisions:
 *
 * **Count and recency, not just count.** A pure count freezes: the command
 * somebody ran two hundred times last quarter outranks the one they have run
 * ten times this week, forever. A recency term lets the ordering follow the work
 * as it moves without throwing the history away.
 *
 * **It stays on the machine.** This is a record of what an operator does, at
 * keystroke resolution, and it is exactly the kind of thing that becomes an
 * employee-observation dataset the moment it is sent anywhere. It is
 * localStorage and nothing else, it is capped, and there is a way to clear it.
 */

export const COMMAND_USE_STORAGE_KEY = "pv.console.command-use";

export interface CommandUse {
  readonly count: number;
  /** Epoch milliseconds of the last run. */
  readonly at: number;
}

export type CommandUseMap = Readonly<Record<string, CommandUse>>;

/**
 * How many commands are remembered.
 *
 * Unbounded growth in localStorage is a slow leak that eventually throws a
 * quota error on an unrelated write — usually the theme preference, which then
 * appears to be the broken thing.
 */
export const COMMAND_USE_LIMIT = 200;

/** A week. Past this, recency stops distinguishing two commands at all. */
const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ceiling on the count's contribution.
 *
 * Without one, a command run three hundred times sits at the top of the list
 * forever regardless of what is typed, and a search stops being a search.
 */
const COUNT_CEILING = 12;

function isUse(value: unknown): value is CommandUse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { count?: unknown; at?: unknown };
  return (
    typeof candidate.count === "number" &&
    Number.isFinite(candidate.count) &&
    candidate.count > 0 &&
    typeof candidate.at === "number" &&
    Number.isFinite(candidate.at)
  );
}

/**
 * Storage is guarded everywhere, the same way theme/preferences.ts guards it: a
 * private window, a locked-down profile, or a full quota must cost the operator
 * a worse palette ordering, never a thrown error on the keystroke that ran the
 * command.
 */
export function readCommandUse(): CommandUseMap {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(COMMAND_USE_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const cleaned: Record<string, CommandUse> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isUse(value)) cleaned[id] = { count: value.count, at: value.at };
    }
    return cleaned;
  } catch {
    // Written by an older build, or corrupted. An unreadable history is the
    // same as no history — it must never be the reason the palette fails to
    // open.
    return {};
  }
}

export function writeCommandUse(uses: CommandUseMap): void {
  try {
    window.localStorage.setItem(COMMAND_USE_STORAGE_KEY, JSON.stringify(uses));
  } catch {
    // Losing the ordering is acceptable. Throwing on the keystroke is not.
  }
}

/** Drops the least useful entries once the map is over the limit. */
export function pruneCommandUse(uses: CommandUseMap, limit = COMMAND_USE_LIMIT): CommandUseMap {
  const entries = Object.entries(uses);
  if (entries.length <= limit) return uses;

  entries.sort(([, left], [, right]) => right.at - left.at || right.count - left.count);
  return Object.fromEntries(entries.slice(0, limit));
}

export function recordCommandUse(
  id: string,
  options: { readonly now?: number } = {},
): CommandUseMap {
  const now = options.now ?? Date.now();
  const current = readCommandUse();
  const previous = current[id];
  const next = pruneCommandUse({
    ...current,
    [id]: { count: (previous?.count ?? 0) + 1, at: now },
  });
  writeCommandUse(next);
  return next;
}

export function clearCommandUse(): void {
  try {
    window.localStorage.removeItem(COMMAND_USE_STORAGE_KEY);
  } catch {
    // See writeCommandUse.
  }
}

/**
 * How strongly this command should be pulled toward the top, 0–100.
 *
 * Kept as a bounded number rather than a raw count so that search relevance
 * always outranks habit: a typed query scores in the hundreds, and familiarity
 * breaks ties inside it rather than overriding it.
 */
export function familiarity(use: CommandUse | undefined, now: number): number {
  if (use === undefined) return 0;

  const repetition = Math.min(use.count, COUNT_CEILING) / COUNT_CEILING;
  const age = Math.max(0, now - use.at);
  const recency = age >= RECENCY_WINDOW_MS ? 0 : 1 - age / RECENCY_WINDOW_MS;

  // Weighted toward repetition: what somebody does often matters more than what
  // they happened to do last, and an ordering driven mainly by recency shuffles
  // itself every few minutes, which is worse than one that never moves.
  return Math.round((repetition * 0.7 + recency * 0.3) * 100);
}
