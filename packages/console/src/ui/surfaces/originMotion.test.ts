import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORIGIN_VARIABLES,
  captureOriginRect,
  originTransformVariables,
  prefersReducedMotion,
  readTransitionDurationMs,
  type OriginRect,
} from "./originMotion";

function rect(value: OriginRect): OriginRect {
  return value;
}

function elementWithRect(value: OriginRect | null): Element {
  const element = document.createElement("div");
  element.getBoundingClientRect = () =>
    ({
      top: value?.top ?? 0,
      left: value?.left ?? 0,
      width: value?.width ?? 0,
      height: value?.height ?? 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("captureOriginRect", () => {
  it("reads the element's box", () => {
    const element = elementWithRect(rect({ top: 240, left: 320, width: 900, height: 52 }));
    expect(captureOriginRect(element)).toEqual({
      top: 240,
      left: 320,
      width: 900,
      height: 52,
    });
  });

  it("answers null for an element with no layout", () => {
    // A zero-area rect means detached, display:none, or an environment with no
    // layout engine. Animating from a point is animating from nowhere.
    expect(captureOriginRect(elementWithRect(null))).toBeNull();
    expect(captureOriginRect(null)).toBeNull();
    expect(captureOriginRect(undefined)).toBeNull();
  });
});

describe("originTransformVariables", () => {
  const target = rect({ top: 0, left: 560, width: 720, height: 900 });
  const row = rect({ top: 300, left: 260, width: 900, height: 52 });

  it("translates the surface onto the row it came from", () => {
    const variables = originTransformVariables(row, target);

    expect(variables[ORIGIN_VARIABLES.offsetX]).toBe("-300px");
    expect(variables[ORIGIN_VARIABLES.offsetY]).toBe("300px");
  });

  it("clamps the scale so text does not smear during the transition", () => {
    // A 52px row against a 900px sheet is a scale of 0.058. Reproducing that
    // literally reads as a zoom, not as continuity.
    const variables = originTransformVariables(row, target);

    expect(Number(variables[ORIGIN_VARIABLES.scaleY])).toBeCloseTo(0.72, 5);
    // The row is wider than the sheet, so the horizontal scale is capped at 1
    // rather than growing the surface beyond its final size.
    expect(Number(variables[ORIGIN_VARIABLES.scaleX])).toBe(1);
  });

  it("uses a real scale when the origin is close to the target size", () => {
    const card = rect({ top: 100, left: 100, width: 600, height: 720 });
    const variables = originTransformVariables(card, target);

    expect(Number(variables[ORIGIN_VARIABLES.scaleX])).toBeCloseTo(600 / 720, 4);
    expect(Number(variables[ORIGIN_VARIABLES.scaleY])).toBeCloseTo(0.8, 4);
  });

  it("produces nothing under a reduced-motion request", () => {
    // motion.css can shorten a transform but cannot turn it into a fade, so
    // the transform has to not exist. What is left is the opacity change,
    // which is exactly what the preference asks for.
    expect(originTransformVariables(row, target, { reducedMotion: true })).toEqual({});
  });

  it("produces nothing when either box is missing or unmeasurable", () => {
    expect(originTransformVariables(null, target)).toEqual({});
    expect(originTransformVariables(row, null)).toEqual({});
    expect(originTransformVariables(row, rect({ top: 0, left: 0, width: 0, height: 0 }))).toEqual(
      {},
    );
  });
});

describe("prefersReducedMotion", () => {
  it("answers false when the environment cannot express a preference", () => {
    const original = window.matchMedia;
    // @ts-expect-error deliberately removing the API to exercise the branch.
    delete window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
    window.matchMedia = original;
  });

  it("reports the operator's request", () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    expect(prefersReducedMotion()).toBe(true);
    window.matchMedia = original;
  });
});

describe("readTransitionDurationMs", () => {
  it("answers zero when styles cannot be computed", () => {
    // No animation is a correct outcome. An overlay still on screen after the
    // operator dismissed it is not, which is why this never guesses a duration.
    expect(readTransitionDurationMs(null)).toBe(0);
  });

  it("takes the longest duration in a transition list", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const view = element.ownerDocument.defaultView;
    if (view === null) throw new Error("no window");

    const original = view.getComputedStyle;
    view.getComputedStyle = (() =>
      ({ transitionDuration: "0.12s, 240ms" }) as unknown as CSSStyleDeclaration) as typeof view.getComputedStyle;

    expect(readTransitionDurationMs(element)).toBe(240);
    view.getComputedStyle = original;
  });

  it("ignores an unresolved custom property", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const view = element.ownerDocument.defaultView;
    if (view === null) throw new Error("no window");

    const original = view.getComputedStyle;
    view.getComputedStyle = (() =>
      ({ transitionDuration: "var(--pv-motion-surface)" }) as unknown as CSSStyleDeclaration) as typeof view.getComputedStyle;

    expect(readTransitionDurationMs(element)).toBe(0);
    view.getComputedStyle = original;
  });
});
