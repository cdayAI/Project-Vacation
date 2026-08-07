import { afterEach, describe, expect, it, vi } from "vitest";
import tokenSource from "../theme/tokens.css?raw";
import { PANEL_WIDTH_DEFAULT, PANEL_WIDTH_MAX, PANEL_WIDTH_MIN } from "./layout";
import {
  DEFAULT_PANEL_PREFERENCE,
  SHELL_STORAGE_KEYS,
  readPanelPreference,
  readPanelPreferences,
  readRailCollapsed,
  writePanelPreference,
  writeRailCollapsed,
} from "./shellPreferences";

afterEach(() => {
  window.localStorage.clear();
});

describe("the rail's collapse", () => {
  it("starts expanded", () => {
    expect(readRailCollapsed()).toBe(false);
  });

  it("survives a round trip", () => {
    writeRailCollapsed(true);
    expect(readRailCollapsed()).toBe(true);
    writeRailCollapsed(false);
    expect(readRailCollapsed()).toBe(false);
  });

  it("is one setting for the whole console, not one per screen", () => {
    // Somebody who works in a collapsed rail wants it collapsed everywhere. A
    // per-route rail is a rail they close forty times a day.
    writeRailCollapsed(true);
    expect(window.localStorage.getItem(SHELL_STORAGE_KEYS.rail)).toBe("true");
    expect(Object.keys(window.localStorage)).toHaveLength(1);
  });

  it("does not throw when storage refuses to be written", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => writeRailCollapsed(true)).not.toThrow();
    setItem.mockRestore();
  });
});

describe("the context panel, remembered per route", () => {
  it("starts open at 380 on a route nobody has touched", () => {
    expect(readPanelPreference("work")).toEqual(DEFAULT_PANEL_PREFERENCE);
    expect(DEFAULT_PANEL_PREFERENCE.width).toBe(PANEL_WIDTH_DEFAULT);
  });

  it("keeps one route's answer separate from another's", () => {
    // The whole point of §2's "persists per route": on an approval the panel
    // holds the record and stays open, on the executive view it is a third of
    // a chart. One shared setting loses that argument on one of the two.
    writePanelPreference("approval-detail", { collapsed: false, width: 480 });
    writePanelPreference("executive", { collapsed: true, width: 380 });

    expect(readPanelPreference("approval-detail")).toEqual({ collapsed: false, width: 480 });
    expect(readPanelPreference("executive")).toEqual({ collapsed: true, width: 380 });
  });

  it("clamps a width on the way in as well as on the way out", () => {
    // A width written by a build with different bounds, or edited by hand, must
    // not be able to produce a panel that hides the content behind it.
    window.localStorage.setItem(
      SHELL_STORAGE_KEYS.panel,
      JSON.stringify({ work: { collapsed: false, width: 4000 } }),
    );
    expect(readPanelPreference("work").width).toBe(PANEL_WIDTH_MAX);
  });

  it("reads unparseable storage as no preferences rather than throwing", () => {
    window.localStorage.setItem(SHELL_STORAGE_KEYS.panel, "{not json");
    expect(readPanelPreferences()).toEqual({});
  });

  it("discards an entry that is the wrong shape and keeps the rest", () => {
    window.localStorage.setItem(
      SHELL_STORAGE_KEYS.panel,
      JSON.stringify({ work: { collapsed: false, width: 400 }, audit: { width: "wide" } }),
    );
    expect(Object.keys(readPanelPreferences())).toEqual(["work"]);
  });

  it("leaves other routes alone when one is written", () => {
    writePanelPreference("work", { collapsed: true, width: 320 });
    writePanelPreference("audit", { collapsed: false, width: 500 });
    expect(readPanelPreference("work")).toEqual({ collapsed: true, width: 320 });
  });
});

describe("the bounds the CSS and the JavaScript both use", () => {
  /**
   * The panel's three widths exist twice — as tokens for the stylesheet and as
   * numbers for the pointer arithmetic a drag needs. Two copies of a number is
   * two copies that drift, so this is the assertion that stops them.
   */
  function tokenPx(name: string): number {
    const match = new RegExp(`${name}:\\s*([0-9.]+)rem`).exec(tokenSource);
    if (match === null) throw new Error(`${name} is not declared in tokens.css`);
    return Number.parseFloat(match[1] ?? "0") * 16;
  }

  it("agrees with tokens.css", () => {
    expect(tokenPx("--pv-shell-panel-width")).toBe(PANEL_WIDTH_DEFAULT);
    expect(tokenPx("--pv-shell-panel-width-min")).toBe(PANEL_WIDTH_MIN);
    expect(tokenPx("--pv-shell-panel-width-max")).toBe(PANEL_WIDTH_MAX);
  });
});
