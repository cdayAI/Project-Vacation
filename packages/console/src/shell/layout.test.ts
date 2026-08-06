import { describe, expect, it } from "vitest";
import { BREAKPOINTS } from "../theme/tokens";
import {
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  clampPanelWidth,
  resolveShellLayout,
} from "./layout";

const OPEN = { railCollapsed: false, panelWidth: PANEL_WIDTH_DEFAULT };

describe("the panel's bounds", () => {
  it("holds a width inside 320 and 520", () => {
    expect(clampPanelWidth(400)).toBe(400);
    expect(clampPanelWidth(100)).toBe(PANEL_WIDTH_MIN);
    expect(clampPanelWidth(9000)).toBe(PANEL_WIDTH_MAX);
  });

  it("rounds a dragged width to a whole pixel", () => {
    expect(clampPanelWidth(400.6)).toBe(401);
  });

  it("falls back to the default for a value that is not a number", () => {
    expect(clampPanelWidth(Number.NaN)).toBe(PANEL_WIDTH_DEFAULT);
  });
});

describe("the shell layout at each breakpoint", () => {
  it("gives the full three columns at 1440 and above", () => {
    const layout = resolveShellLayout(BREAKPOINTS.full, OPEN);
    expect(layout).toMatchObject({
      rail: "expanded",
      railIsChoice: true,
      panel: "docked",
      panelWidth: PANEL_WIDTH_DEFAULT,
      dataEntry: true,
    });
  });

  it("keeps the full layout between 1280 and 1440", () => {
    expect(resolveShellLayout(1360, OPEN).panel).toBe("docked");
  });

  it("narrows the panel to its minimum below 1280", () => {
    const layout = resolveShellLayout(BREAKPOINTS.panelNarrow - 1, OPEN);
    expect(layout.panel).toBe("narrow");
    expect(layout.panelWidth).toBe(PANEL_WIDTH_MIN);
  });

  it("ignores a stored width once the panel has narrowed", () => {
    // Otherwise a panel dragged to 520 on a desktop follows the operator onto a
    // 1200px window and takes nearly half of it.
    const layout = resolveShellLayout(1200, { railCollapsed: false, panelWidth: 520 });
    expect(layout.panelWidth).toBe(PANEL_WIDTH_MIN);
  });

  it("collapses the rail to icons below 1024, whatever the operator prefers", () => {
    const layout = resolveShellLayout(BREAKPOINTS.railCollapse - 1, OPEN);
    expect(layout.rail).toBe("icons");
    // And says the collapse is not theirs to undo here, so the toggle can
    // explain itself rather than silently doing nothing.
    expect(layout.railIsChoice).toBe(false);
  });

  it("turns the panel into an overlay below 900, and stops offering data entry", () => {
    const layout = resolveShellLayout(BREAKPOINTS.panelOverlay - 1, OPEN);
    expect(layout.panel).toBe("overlay");
    expect(layout.dataEntry).toBe(false);
  });

  it("still offers data entry at exactly 900", () => {
    expect(resolveShellLayout(BREAKPOINTS.panelOverlay, OPEN).dataEntry).toBe(true);
  });

  it("honours a collapsed rail wherever there is room to expand it", () => {
    const layout = resolveShellLayout(BREAKPOINTS.full, {
      railCollapsed: true,
      panelWidth: PANEL_WIDTH_DEFAULT,
    });
    expect(layout.rail).toBe("icons");
    expect(layout.railIsChoice).toBe(true);
  });

  it("assumes the full layout for a width it cannot read", () => {
    // A viewport of NaN is a browser that has not laid out yet. Guessing the
    // narrowest layout would flash an overlay sheet on every desktop load.
    expect(resolveShellLayout(Number.NaN, OPEN).panel).toBe("docked");
  });
});
