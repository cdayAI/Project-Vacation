import { useTheme } from "./ThemeProvider";

/**
 * The theme control.
 *
 * A native button with `aria-pressed` rather than a switch widget or a styled
 * checkbox. `aria-pressed` is announced by every screen reader without any
 * scripting on our part — "Dark theme, toggle button, pressed" — so the state
 * is conveyed rather than merely displayed, and the button keeps every keyboard
 * behaviour a button already has.
 *
 * The glyph is decorative and hidden from assistive technology: the label and
 * the pressed state already carry the meaning, and hearing "moon Dark theme
 * pressed" adds noise, not information.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="pv-button pv-button-quiet"
      aria-pressed={isDark}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      <span className="pv-badge-glyph" aria-hidden="true">
        {isDark ? "◒" : "◓"}
      </span>
      Dark theme
    </button>
  );
}
