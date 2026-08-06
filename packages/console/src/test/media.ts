/**
 * A controllable `window.matchMedia`.
 *
 * jsdom does not implement matchMedia at all, so without this the theme code
 * would be exercised only on its "no media query support" branch and the
 * prefers-color-scheme behaviour — half of the two-theme requirement — would
 * go untested.
 */

type Listener = (event: MediaQueryListEvent) => void;

const DARK_QUERY = "prefers-color-scheme: dark";

let prefersDark = false;
const listeners = new Set<Listener>();

export function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      media: query,
      matches: query.includes(DARK_QUERY) ? prefersDark : false,
      onchange: null,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => false,
    }),
  });
}

export function setSystemPrefersDark(value: boolean): void {
  prefersDark = value;
  const event = { matches: value, media: `(${DARK_QUERY})` } as MediaQueryListEvent;
  for (const listener of listeners) listener(event);
}

export function resetMediaPreferences(): void {
  prefersDark = false;
  listeners.clear();
}
