import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Theme state.
 *
 * There are exactly two themes. `prefers-color-scheme` decides which one an
 * operator gets until they choose, and their choice then persists and wins in
 * both directions. "System" is not a third theme — it is the absence of a
 * stored choice, and it is represented here by `data-theme` being absent from
 * the root element rather than by a third token set. See ADR 0014 and the
 * comment at the top of tokens.css.
 */
export type Theme = "light" | "dark";

const STORAGE_KEY = "pv.console.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
  /** The theme actually in force, whether chosen or inherited from the system. */
  readonly theme: Theme;
  /** True once the operator has chosen; false while the system preference governs. */
  readonly isExplicit: boolean;
  readonly setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    // Storage can be unavailable (private browsing, a locked-down profile).
    // A console that cannot remember a theme still has to work.
    return null;
  }
}

function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // See above. Losing the preference is acceptable; throwing is not.
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [stored, setStored] = useState<Theme | null>(() => readStoredTheme());
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());

  // Track the system preference for as long as no explicit choice exists. It
  // is still tracked after a choice is made, because clearing storage in
  // another tab should not leave this one stale.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const theme: Theme = stored ?? (prefersDark ? "dark" : "light");

  // The attribute is only written when a choice has been made. Leaving it
  // absent otherwise is what lets the media query in tokens.css govern.
  useEffect(() => {
    const root = document.documentElement;
    if (stored === null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", stored);
  }, [stored]);

  const setTheme = useCallback((next: Theme) => {
    writeStoredTheme(next);
    setStored(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, isExplicit: stored !== null, setTheme }),
    [theme, stored, setTheme],
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
