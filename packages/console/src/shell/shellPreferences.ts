import { PANEL_WIDTH_DEFAULT, clampPanelWidth } from "./layout";

/**
 * What the shell remembers about how this operator works.
 *
 * Two things, stored separately because they have different lifetimes:
 *
 *   **The rail** is one boolean for the whole console. Somebody who works in a
 *   collapsed rail wants it collapsed everywhere; a rail that reopened on every
 *   route would be a rail they close forty times a day.
 *
 *   **The context panel** is per route (spec §2). This is the less obvious
 *   half, and it is the one that matters: on an approval the panel holds the
 *   record and stays open, on the executive view it is in the way. One shared
 *   setting means every operator loses that argument on one of the two screens.
 *
 * Guarded the way theme/preferences.ts is guarded, for the same reasons — a
 * private window, a locked-down profile, a full quota. A console that cannot
 * remember a layout still has to open.
 */

export const SHELL_STORAGE_KEYS = {
  rail: "pv.console.rail-collapsed",
  panel: "pv.console.context-panel",
} as const;

export interface PanelPreference {
  readonly collapsed: boolean;
  readonly width: number;
}

export const DEFAULT_PANEL_PREFERENCE: PanelPreference = {
  collapsed: false,
  width: PANEL_WIDTH_DEFAULT,
};

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Losing the layout is acceptable. Throwing on the click that changed it
    // is not.
  }
}

export function readRailCollapsed(): boolean {
  return readStored(SHELL_STORAGE_KEYS.rail) === "true";
}

export function writeRailCollapsed(collapsed: boolean): void {
  writeStored(SHELL_STORAGE_KEYS.rail, collapsed ? "true" : "false");
}

export type PanelPreferences = Readonly<Record<string, PanelPreference>>;

function isPanelPreference(value: unknown): value is PanelPreference {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { collapsed?: unknown; width?: unknown };
  return typeof candidate.collapsed === "boolean" && typeof candidate.width === "number";
}

export function readPanelPreferences(): PanelPreferences {
  const raw = readStored(SHELL_STORAGE_KEYS.panel);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const cleaned: Record<string, PanelPreference> = {};
    for (const [routeId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isPanelPreference(value)) continue;
      // Clamped on the way in, not only on the way out: a width written by a
      // build with different bounds, or edited by hand, must not be able to
      // produce a 4000px panel that hides the content behind it.
      cleaned[routeId] = { collapsed: value.collapsed, width: clampPanelWidth(value.width) };
    }
    return cleaned;
  } catch {
    return {};
  }
}

export function readPanelPreference(routeId: string): PanelPreference {
  return readPanelPreferences()[routeId] ?? DEFAULT_PANEL_PREFERENCE;
}

export function writePanelPreference(routeId: string, preference: PanelPreference): void {
  const next: Record<string, PanelPreference> = {
    ...readPanelPreferences(),
    [routeId]: { collapsed: preference.collapsed, width: clampPanelWidth(preference.width) },
  };
  writeStored(SHELL_STORAGE_KEYS.panel, JSON.stringify(next));
}
