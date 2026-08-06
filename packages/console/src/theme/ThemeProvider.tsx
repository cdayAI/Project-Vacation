import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyPreferences,
  matchesMediaQuery,
  readPreferences,
  resolveReducedTransparency,
  resolveTheme,
  writePreference,
  SYSTEM_DARK_QUERY,
  SYSTEM_REDUCED_TRANSPARENCY_QUERY,
  type Density,
  type Preferences,
  type ResolvedTheme,
  type ThemePreference,
  type TransparencyPreference,
} from "./preferences";

/**
 * The three console preferences, held in one provider.
 *
 * One provider rather than three because they are read together — the avatar
 * menu shows all three, and every one of them ends up as an attribute on the
 * same root element, so splitting them would mean three effects racing to write
 * to it.
 *
 * The provider does almost nothing itself. Storage, validation, defaults, and
 * the attribute rules live in preferences.ts where they can be tested without
 * mounting a tree; this is the part that keeps them in React state and keeps
 * the system media queries under observation.
 */

/** Kept for callers that only care what is painted, not how it was chosen. */
export type Theme = ResolvedTheme;

interface ThemeContextValue {
  /** The theme actually in force, whether chosen or inherited from the system. */
  readonly theme: ResolvedTheme;
  /** What the operator asked for, which may be "system". */
  readonly themePreference: ThemePreference;
  /** True once the operator has chosen; false while the system preference governs. */
  readonly isExplicit: boolean;
  /** Sets an explicit light or dark choice. */
  readonly setTheme: (theme: ResolvedTheme) => void;
  readonly setThemePreference: (preference: ThemePreference) => void;

  readonly density: Density;
  readonly setDensity: (density: Density) => void;

  readonly transparency: TransparencyPreference;
  readonly setTransparency: (transparency: TransparencyPreference) => void;
  /** True when transparency is reduced by either the OS or the in-app choice. */
  readonly reducedTransparency: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences());
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() =>
    matchesMediaQuery(SYSTEM_DARK_QUERY),
  );
  const [systemReducesTransparency, setSystemReducesTransparency] = useState<boolean>(() =>
    matchesMediaQuery(SYSTEM_REDUCED_TRANSPARENCY_QUERY),
  );

  // Both queries are re-read on change rather than taking the event's `matches`
  // at face value. A listener can be attached to more than one query, and an
  // event only tells you that something changed — reading the query back is
  // what keeps the two preferences from answering for each other.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;

    const dark = window.matchMedia(SYSTEM_DARK_QUERY);
    const transparency = window.matchMedia(SYSTEM_REDUCED_TRANSPARENCY_QUERY);

    const onChange = () => {
      setSystemPrefersDark(matchesMediaQuery(SYSTEM_DARK_QUERY));
      setSystemReducesTransparency(matchesMediaQuery(SYSTEM_REDUCED_TRANSPARENCY_QUERY));
    };

    dark.addEventListener("change", onChange);
    transparency.addEventListener("change", onChange);
    return () => {
      dark.removeEventListener("change", onChange);
      transparency.removeEventListener("change", onChange);
    };
  }, []);

  // The root element is the only thing the CSS reads. Writing it in an effect
  // rather than during render keeps the provider free of side effects in the
  // render path, which is what makes it safe under StrictMode's double render.
  useEffect(() => {
    applyPreferences(document.documentElement, preferences);
  }, [preferences]);

  const setThemePreference = useCallback((preference: ThemePreference) => {
    writePreference("theme", preference);
    setPreferences((current) => ({ ...current, theme: preference }));
  }, []);

  const setTheme = useCallback(
    (next: ResolvedTheme) => setThemePreference(next),
    [setThemePreference],
  );

  const setDensity = useCallback((density: Density) => {
    writePreference("density", density);
    setPreferences((current) => ({ ...current, density }));
  }, []);

  const setTransparency = useCallback((transparency: TransparencyPreference) => {
    writePreference("transparency", transparency);
    setPreferences((current) => ({ ...current, transparency }));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: resolveTheme(preferences.theme, systemPrefersDark),
      themePreference: preferences.theme,
      isExplicit: preferences.theme !== "system",
      setTheme,
      setThemePreference,
      density: preferences.density,
      setDensity,
      transparency: preferences.transparency,
      setTransparency,
      reducedTransparency: resolveReducedTransparency(
        preferences.transparency,
        systemReducesTransparency,
      ),
    }),
    [
      preferences,
      systemPrefersDark,
      systemReducesTransparency,
      setTheme,
      setThemePreference,
      setDensity,
      setTransparency,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme was called outside ThemeProvider.");
  }
  return value;
}
