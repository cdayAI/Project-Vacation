import { describe, expect, it } from "vitest";
import { SPACE_STEPS } from "../../theme/tokens";
import {
  ANCHOR_GAP,
  VIEWPORT_PADDING,
  anchorBox,
  positionAnchoredSurface,
  surfaceSize,
  type Box,
} from "./anchoredSurface";

const VIEWPORT = { width: 1440, height: 900 };
const TRIGGER: Box = { top: 200, left: 400, width: 160, height: 32 };
const MENU = { width: 240, height: 300 };

describe("the geometry constants", () => {
  it("sit on the spacing scale", () => {
    // A position is computed rather than declared, so these cannot be tokens.
    // This is what stops them quietly becoming 7.
    expect(SPACE_STEPS).toContain(ANCHOR_GAP);
    expect(SPACE_STEPS).toContain(VIEWPORT_PADDING);
  });
});

describe("positionAnchoredSurface", () => {
  it("opens below the trigger, aligned to its left edge", () => {
    const position = positionAnchoredSurface({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
    });

    expect(position).toEqual({ top: 200 + 32 + ANCHOR_GAP, left: 400, placement: "bottom-start" });
  });

  it("aligns to the trigger's right edge when asked", () => {
    const position = positionAnchoredSurface({
      anchor: TRIGGER,
      surface: MENU,
      viewport: VIEWPORT,
      placement: "bottom-end",
    });

    expect(position.left).toBe(400 + 160 - 240);
  });

  it("flips above the trigger rather than opening into the void", () => {
    // The defect this exists to prevent only appears on a short viewport,
    // which is to say on the laptop the operator uses.
    const position = positionAnchoredSurface({
      anchor: { top: 700, left: 400, width: 160, height: 32 },
      surface: MENU,
      viewport: VIEWPORT,
    });

    expect(position.placement).toBe("top-start");
    expect(position.top).toBe(700 - 300 - ANCHOR_GAP);
  });

  it("flips back down when the requested top placement is the cramped one", () => {
    const position = positionAnchoredSurface({
      anchor: { top: 40, left: 400, width: 160, height: 32 },
      surface: MENU,
      viewport: VIEWPORT,
      placement: "top-start",
    });

    expect(position.placement).toBe("bottom-start");
  });

  it("stays put when the requested side fits", () => {
    const position = positionAnchoredSurface({
      anchor: TRIGGER,
      surface: { width: 240, height: 100 },
      viewport: VIEWPORT,
      placement: "top-end",
    });

    expect(position.placement).toBe("top-end");
  });

  it("shifts a surface that would run off the right edge back into view", () => {
    const position = positionAnchoredSurface({
      anchor: { top: 200, left: 1380, width: 40, height: 32 },
      surface: MENU,
      viewport: VIEWPORT,
    });

    expect(position.left).toBe(1440 - 240 - VIEWPORT_PADDING);
  });

  it("shifts a surface that would run off the left edge back into view", () => {
    const position = positionAnchoredSurface({
      anchor: { top: 200, left: 8, width: 40, height: 32 },
      surface: MENU,
      viewport: VIEWPORT,
      placement: "bottom-end",
    });

    expect(position.left).toBe(VIEWPORT_PADDING);
  });

  it("keeps a surface taller than the viewport partly on screen", () => {
    // Partly visible and scrollable is recoverable. Off-screen is not.
    const position = positionAnchoredSurface({
      anchor: { top: 400, left: 400, width: 160, height: 32 },
      surface: { width: 240, height: 1200 },
      viewport: VIEWPORT,
    });

    expect(position.top).toBe(VIEWPORT_PADDING);
    expect(position.left).toBe(400);
  });

  it("chooses the roomier side when neither side fits", () => {
    const position = positionAnchoredSurface({
      anchor: { top: 700, left: 400, width: 160, height: 32 },
      surface: { width: 240, height: 1000 },
      viewport: VIEWPORT,
    });

    // 700 above versus 168 below.
    expect(position.placement).toBe("top-start");
  });
});

describe("measurement", () => {
  it("answers null for an element with no box", () => {
    expect(anchorBox(null)).toBeNull();
    expect(anchorBox(document.createElement("div"))).toBeNull();
  });

  it("reads a laid-out anchor", () => {
    const element = document.createElement("button");
    element.getBoundingClientRect = () =>
      ({ top: 10, left: 20, width: 100, height: 32 }) as DOMRect;
    expect(anchorBox(element)).toEqual({ top: 10, left: 20, width: 100, height: 32 });
  });

  it("reports zero size in an environment with no layout engine", () => {
    expect(surfaceSize(document.createElement("div"))).toEqual({ width: 0, height: 0 });
    expect(surfaceSize(null)).toEqual({ width: 0, height: 0 });
  });
});
