import { describe, expect, it } from "vitest";
import screensSource from "./screens.css?raw";

/**
 * The rules the screens stylesheet has to keep, checked against the file.
 *
 * Glass is applied here by selector list rather than by a class a view adds,
 * which makes it very easy to widen by one line and very hard to notice that
 * the line was a row. These tests are the noticing.
 */

/** Strip comments so a rule described in prose is not read as a rule. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const css = withoutComments(screensSource);

/** Every selector that carries a `backdrop-filter` other than `none`. */
function blurredSelectors(source: string): readonly string[] {
  const found: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rule.exec(source)) !== null) {
    const [, selector = "", body = ""] = match;
    const declaration = /(?:^|[\s;])backdrop-filter:\s*([^;]+);/.exec(body);
    if (declaration === null) continue;
    if (declaration[1]?.trim() === "none") continue;
    found.push(selector.replace(/\s+/g, " ").trim());
  }
  return found;
}

describe("screens.css", () => {
  it("takes every colour and every size from a token", () => {
    // A raw hex or a raw pixel size is right in one theme and wrong in the
    // other, at one density and wrong at the other, and nothing else catches
    // it.
    const hexes = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    // `#000` is a mask stop, not a colour: it is the opaque end of a
    // `mask-composite` gradient and never reaches a pixel an operator sees.
    const nonMaskHexes = hexes.filter((hex) => hex.toLowerCase() !== "#000");
    expect(nonMaskHexes, `raw colours: ${nonMaskHexes.join(", ")}`).toEqual([]);

    // Hairlines are exempt and nothing else is. A 1px border and a 3px accent
    // bar are structural — they are the same thickness at every density and on
    // every display, which is exactly what a spacing token is not for.
    const HAIRLINE_MAX = 3;
    const pixels = (css.match(/\b(\d+)px\b/g) ?? []).filter(
      (value) => Number.parseInt(value, 10) > HAIRLINE_MAX,
    );
    expect(pixels, `raw pixel sizes: ${pixels.join(", ")}`).toEqual([]);
  });

  it("never puts a blurred backdrop on something that repeats per row", () => {
    // The whole performance argument for glass on this console rests on this.
    // A backdrop-filter is a full-surface repaint; the work queue renders a
    // row per open case and the audit screen renders one per chain entry, so a
    // filter on a row, a cell, or a badge is paid ten thousand times.
    const repeating = new Set([
      "tr",
      "td",
      "th",
      "li",
      "tbody",
      "thead",
      ".pv-badge",
      ".pv-token",
      ".pv-row-breached",
      ".pv-row-denied",
    ]);

    for (const selector of blurredSelectors(css)) {
      // Compared as whole selector components, never as substrings: ".pv-metric"
      // contains the letters "tr" and is not a table row.
      for (const one of selector.split(",")) {
        const subject = one.trim().split(/\s+|>/).filter(Boolean).pop() ?? "";
        // Drop any pseudo-element or pseudo-class: `tr:hover` is still a row.
        const bare = subject.split(":")[0] ?? "";
        expect(
          repeating.has(bare),
          `"${one.trim()}" carries a backdrop-filter and is drawn once per row`,
        ).toBe(false);
      }
    }
  });

  it("drops the filter on nested glass rather than blurring twice", () => {
    // Two stacked backdrop-filters cost two full-surface repaints for a
    // difference nobody can see.
    expect(css).toMatch(/\.pv-panel \.pv-step[^{]*\{[^}]*backdrop-filter:\s*none;/);
  });

  it("removes the decorative layers under both reduced-transparency signals", () => {
    // Reduction is a floor. A rim and a sheen drawn over a designed solid is
    // exactly the shimmer the preference exists to remove, and the two signals
    // — the OS media query and the in-app attribute — have to agree.
    expect(css).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(css).toContain(':root[data-transparency="reduced"] .pv-panel::before');

    const mediaAt = css.indexOf("@media (prefers-reduced-transparency: reduce)");
    const media = css.slice(mediaAt, css.indexOf("}\n}", mediaAt));
    for (const layer of [".pv-panel::before", ".pv-panel::after", ".pv-dialog::after"]) {
      expect(media, `${layer} survives reduced transparency`).toContain(layer);
    }
  });

  it("removes them again where the browser cannot blur at all", () => {
    // A rim highlight over an opaque panel reads as a rendering artefact.
    expect(css).toContain(
      "@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))",
    );
  });

  it("keeps every decorative layer out of the pointer's way", () => {
    // A layer that covers the panel and intercepts a click is a control an
    // operator cannot press. Every ::before and ::after that draws a full-inset
    // box declares pointer-events: none.
    const decorative = css.match(/::(?:before|after)[^{]*\{[^}]*\}/g) ?? [];
    const insetLayers = decorative.filter((rule) => /inset:\s*0/.test(rule));
    expect(insetLayers.length).toBeGreaterThan(0);
    for (const rule of insetLayers) {
      expect(rule, `a full-inset layer without pointer-events: none: ${rule.slice(0, 80)}`).toContain(
        "pointer-events: none",
      );
    }
  });

  it("does not animate anything on load, on data, or on a timer", () => {
    // A governance console that shimmers while somebody reads a refusal is a
    // console that makes people distrust it. The only motion here is a hover
    // transition, and it is inside a reduced-motion guard.
    expect(css).not.toMatch(/animation:/);
    const transitions = css.match(/transition:[^;]+;/g) ?? [];
    for (const transition of transitions) {
      expect(transition, `a transition on something other than opacity: ${transition}`).toContain(
        "opacity",
      );
    }
    const guarded = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference)"));
    for (const transition of transitions) {
      expect(guarded, `${transition} is declared outside the reduced-motion guard`).toContain(
        transition,
      );
    }
  });
});
