import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  PREFERENCE_ATTRIBUTES,
  PREFERENCE_STORAGE_KEYS,
  applyPreferences,
  matchesMediaQuery,
  readPreferences,
  resolveReducedTransparency,
  resolveTheme,
  writePreference,
  type Preferences,
} from "./preferences";

/**
 * The preference layer, tested for what it refuses as much as for what it does.
 *
 * The refusals that matter: an unrecognised stored value must not resurrect a
 * mode, storage that throws must not take the console down with it, and no
 * combination of inputs may turn an operating-system accessibility preference
 * off.
 */

function element(): Element {
  return document.createElement("div");
}

describe("defaults", () => {
  it("follows the system for theme, comfortable for density, system for transparency", () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      theme: "system",
      density: "comfortable",
      transparency: "system",
    });
  });

  it("keeps the storage key the console already shipped", () => {
    // Renaming it would silently reset every operator's theme on deploy.
    expect(PREFERENCE_STORAGE_KEYS.theme).toBe("pv.console.theme");
  });

  it("reads the defaults when nothing is stored", () => {
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
});

describe("persistence", () => {
  it("round-trips all three preferences independently", () => {
    writePreference("theme", "dark");
    writePreference("density", "compact");
    writePreference("transparency", "reduced");

    expect(readPreferences()).toEqual({
      theme: "dark",
      density: "compact",
      transparency: "reduced",
    });
  });

  it("leaves the other two alone when one changes", () => {
    writePreference("density", "compact");
    expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES, density: "compact" });
  });

  it("falls back to the default for a value it does not recognise", () => {
    // A value written by an older build, or by a mode that has since been
    // removed, must read as the default rather than reviving anything.
    window.localStorage.setItem(PREFERENCE_STORAGE_KEYS.theme, "midnight");
    window.localStorage.setItem(PREFERENCE_STORAGE_KEYS.density, "cozy");
    window.localStorage.setItem(PREFERENCE_STORAGE_KEYS.transparency, "full");

    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("treats an empty string as absent rather than as a choice", () => {
    window.localStorage.setItem(PREFERENCE_STORAGE_KEYS.density, "");
    expect(readPreferences().density).toBe("comfortable");
  });

  it("reads the defaults when storage refuses to be read", () => {
    // Private browsing, a locked-down profile, a full quota. A console that
    // cannot remember a preference still has to render.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage is unavailable");
    });

    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("does not throw when storage refuses to be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => writePreference("theme", "dark")).not.toThrow();
  });
});

describe("root attributes", () => {
  it("leaves data-theme off entirely while the system governs", () => {
    // The absence of the attribute is what lets the prefers-color-scheme media
    // query in tokens.css apply. Writing "system" would need a third value set.
    const root = element();
    applyPreferences(root, DEFAULT_PREFERENCES);
    expect(root.hasAttribute(PREFERENCE_ATTRIBUTES.theme)).toBe(false);
  });

  it("writes an explicit theme choice", () => {
    const root = element();
    applyPreferences(root, { ...DEFAULT_PREFERENCES, theme: "light" });
    expect(root.getAttribute(PREFERENCE_ATTRIBUTES.theme)).toBe("light");
  });

  it("clears a previous choice when the operator goes back to system", () => {
    const root = element();
    applyPreferences(root, { ...DEFAULT_PREFERENCES, theme: "dark" });
    applyPreferences(root, { ...DEFAULT_PREFERENCES, theme: "system" });
    expect(root.hasAttribute(PREFERENCE_ATTRIBUTES.theme)).toBe(false);
  });

  it("always writes density, because there is no system signal to defer to", () => {
    const root = element();
    applyPreferences(root, DEFAULT_PREFERENCES);
    expect(root.getAttribute(PREFERENCE_ATTRIBUTES.density)).toBe("comfortable");

    applyPreferences(root, { ...DEFAULT_PREFERENCES, density: "compact" });
    expect(root.getAttribute(PREFERENCE_ATTRIBUTES.density)).toBe("compact");
  });

  it("writes data-transparency only to reduce, never to restore", () => {
    const root = element();
    applyPreferences(root, { ...DEFAULT_PREFERENCES, transparency: "reduced" });
    expect(root.getAttribute(PREFERENCE_ATTRIBUTES.transparency)).toBe("reduced");

    applyPreferences(root, { ...DEFAULT_PREFERENCES, transparency: "system" });
    // Absent, not "full": glass.css has no selector that would turn an
    // operating-system preference back off, and there must never be one.
    expect(root.hasAttribute(PREFERENCE_ATTRIBUTES.transparency)).toBe(false);
  });

  it("writes the same three attributes whatever the combination", () => {
    const combinations: readonly Preferences[] = [
      { theme: "system", density: "comfortable", transparency: "system" },
      { theme: "dark", density: "compact", transparency: "reduced" },
      { theme: "light", density: "compact", transparency: "system" },
    ];
    for (const preferences of combinations) {
      const root = element();
      applyPreferences(root, preferences);
      const written = root.getAttributeNames().sort();
      const expected = ["data-density"];
      if (preferences.theme !== "system") expected.push("data-theme");
      if (preferences.transparency !== "system") expected.push("data-transparency");
      expect(written).toEqual(expected.sort());
    }
  });
});

describe("resolution", () => {
  it("resolves system to whatever the operating system asks for", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("lets an explicit choice win in both directions", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("treats reduced transparency as a floor rather than a toggle", () => {
    // The in-app preference can add reduction. Nothing can remove it: an
    // application that could override an accessibility preference upward would
    // eventually do it by accident, to the person least able to work around it.
    expect(resolveReducedTransparency("system", true)).toBe(true);
    expect(resolveReducedTransparency("reduced", true)).toBe(true);
    expect(resolveReducedTransparency("reduced", false)).toBe(true);
    expect(resolveReducedTransparency("system", false)).toBe(false);
  });
});

describe("media queries", () => {
  it("reports no preference when the platform has no matchMedia", () => {
    // jsdom and some embedded webviews have none. "Absent" is not the same as
    // "the operator asked for light", and the stored preference still applies.
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
    try {
      expect(matchesMediaQuery("(prefers-color-scheme: dark)")).toBe(false);
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
    }
  });

  it("reports what matchMedia says when it exists", () => {
    expect(matchesMediaQuery("(prefers-reduced-transparency: reduce)")).toBe(false);
  });
});
