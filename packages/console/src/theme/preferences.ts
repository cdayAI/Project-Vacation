/**
 * The three console preferences: theme, density, transparency.
 *
 * Each one persists per user in localStorage, each has a documented default,
 * and each is expressed as a data attribute on the root element. The attribute
 * is the point: CSS responds to a preference change without a component tree
 * re-rendering, so switching density on a 10,000-row virtualised table is a
 * repaint rather than a rebuild.
 *
 * This module is deliberately free of React. The storage and resolution rules
 * are the part worth testing hard, and they are testable here without mounting
 * anything. ThemeProvider is the thin React shell over it.
 */

/** system = follow the OS. Not a third theme — the absence of a stored choice. */
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** What is actually painted, once the system preference has been consulted. */
export type ResolvedTheme = "light" | "dark";

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

/**
 * There is no "full" here on purpose. Reduced transparency is a floor, not a
 * toggle: an operator can ask for less transparency than their OS asks for,
 * never for more. An application that can override an accessibility preference
 * upward will eventually do it by accident, and the person it happens to is the
 * person least able to work around it.
 */
export const TRANSPARENCY_PREFERENCES = ["system", "reduced"] as const;
export type TransparencyPreference = (typeof TRANSPARENCY_PREFERENCES)[number];

export interface Preferences {
  readonly theme: ThemePreference;
  readonly density: Density;
  readonly transparency: TransparencyPreference;
}

/**
 * Defaults, and why each one is what it is:
 *
 *   theme        system     — the operator has already told their OS how they
 *                             want to read a screen; asking again is rude.
 *   density      comfortable— the first screen someone sees should be the
 *                             legible one. Compact is a choice made once the
 *                             data is familiar, not one made by default.
 *   transparency system     — honour prefers-reduced-transparency, and let the
 *                             in-app control add reduction on top of it.
 */
export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  density: "comfortable",
  transparency: "system",
};

/** The theme key predates the other two and keeps its name; stored choices survive. */
export const PREFERENCE_STORAGE_KEYS = {
  theme: "pv.console.theme",
  density: "pv.console.density",
  transparency: "pv.console.transparency",
} as const;

export const PREFERENCE_ATTRIBUTES = {
  theme: "data-theme",
  density: "data-density",
  transparency: "data-transparency",
} as const;

export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
export const SYSTEM_REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

function isThemePreference(value: string): value is ThemePreference {
  return (THEME_PREFERENCES as readonly string[]).includes(value);
}

function isDensity(value: string): value is Density {
  return (DENSITIES as readonly string[]).includes(value);
}

function isTransparencyPreference(value: string): value is TransparencyPreference {
  return (TRANSPARENCY_PREFERENCES as readonly string[]).includes(value);
}

/**
 * Storage can be unavailable — private browsing, a locked-down profile, a
 * quota that is already full. A console that cannot remember a preference still
 * has to work, so every access is guarded and every failure falls back to the
 * default rather than propagating.
 */
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
    // Losing the preference is acceptable. Throwing on the click that set it
    // is not.
  }
}

/**
 * Reads all three, falling back to the default for anything missing or
 * unrecognised. Unrecognised matters: a value written by an older build, or by
 * a preference we have since removed, must not resurrect a mode that no longer
 * exists — it reads as the default instead.
 */
export function readPreferences(): Preferences {
  const theme = readStored(PREFERENCE_STORAGE_KEYS.theme);
  const density = readStored(PREFERENCE_STORAGE_KEYS.density);
  const transparency = readStored(PREFERENCE_STORAGE_KEYS.transparency);

  return {
    theme: theme !== null && isThemePreference(theme) ? theme : DEFAULT_PREFERENCES.theme,
    density: density !== null && isDensity(density) ? density : DEFAULT_PREFERENCES.density,
    transparency:
      transparency !== null && isTransparencyPreference(transparency)
        ? transparency
        : DEFAULT_PREFERENCES.transparency,
  };
}

export function writePreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  writeStored(PREFERENCE_STORAGE_KEYS[key], value);
}

/**
 * Writes the preferences onto the root element.
 *
 * `theme: "system"` removes the attribute rather than writing "system". That
 * absence is what lets the `prefers-color-scheme` media query in tokens.css
 * govern; writing a third value would need a third set of selectors and a third
 * value set, which is exactly the drift the two-selector arrangement avoids.
 *
 * Transparency removes its attribute for the same reason. Density always writes
 * one, because there is no system signal for density and therefore no media
 * query for an absent attribute to defer to.
 */
export function applyPreferences(root: Element, preferences: Preferences): void {
  if (preferences.theme === "system") root.removeAttribute(PREFERENCE_ATTRIBUTES.theme);
  else root.setAttribute(PREFERENCE_ATTRIBUTES.theme, preferences.theme);

  root.setAttribute(PREFERENCE_ATTRIBUTES.density, preferences.density);

  if (preferences.transparency === "system") {
    root.removeAttribute(PREFERENCE_ATTRIBUTES.transparency);
  } else {
    root.setAttribute(PREFERENCE_ATTRIBUTES.transparency, preferences.transparency);
  }
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

/** Either signal is enough. Reduction is a floor — see TRANSPARENCY_PREFERENCES. */
export function resolveReducedTransparency(
  preference: TransparencyPreference,
  systemReducesTransparency: boolean,
): boolean {
  return preference === "reduced" || systemReducesTransparency;
}

/**
 * jsdom has no matchMedia and an embedded webview may not either. Treating an
 * absent implementation as "no preference expressed" is the only honest answer:
 * it is not the same as the operator having asked for light, and the stored
 * preference still applies on top of it.
 */
export function matchesMediaQuery(query: string): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(query).matches;
}
