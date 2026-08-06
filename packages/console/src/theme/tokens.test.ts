import { describe, expect, it } from "vitest";
import tokensSource from "./tokens.css?raw";

/**
 * Contrast, verified against the stylesheet the application actually ships.
 *
 * The token file is parsed rather than duplicated here on purpose: a test that
 * carries its own copy of the palette passes forever after someone edits the
 * real one. Change a colour in tokens.css and this test either agrees or fails.
 *
 * What is checked:
 *   - every text-on-surface pair reaches 4.5:1 (WCAG 1.4.3), in both themes;
 *   - every boundary that identifies a control or a state reaches 3:1
 *     (WCAG 1.4.11), in both themes;
 *   - the two value sets declare exactly the same token names, so a token
 *     cannot be added to one theme and forgotten in the other;
 *   - the two copies of the dark value set have not drifted apart.
 *
 * What is deliberately not checked: --pv-divider. It draws decorative row
 * rules that carry no information and 1.4.11 does not apply to it. That is
 * asserted explicitly below so the exemption is a decision on the record
 * rather than an omission nobody noticed.
 */

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

function channel(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(offset, offset + 2), 16);
}

function relativeLuminance(hex: string): number {
  const normalised = hex.replace("#", "");
  const components = [0, 2, 4].map((offset) => {
    const value = channel(normalised, offset) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * components[0] + 0.7152 * components[1] + 0.0722 * components[2];
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Palette = Readonly<Record<string, string>>;

/** Strips comments so a ratio written in a comment cannot be mistaken for a value. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Pulls the declaration block that follows a selector.
 *
 * Written by hand rather than with a CSS parser: adding a parser dependency to
 * check four colour blocks would be a worse trade than forty lines of string
 * handling that this test itself proves works.
 */
function blockAfter(css: string, selectorWithBrace: string): string {
  if (!selectorWithBrace.endsWith("{")) {
    throw new Error("blockAfter expects the selector text up to and including its opening brace");
  }
  const start = css.indexOf(selectorWithBrace);
  if (start === -1) {
    throw new Error(`tokens.css no longer contains the selector ${selectorWithBrace}`);
  }
  const open = start + selectorWithBrace.length - 1;
  let depth = 1;
  let index = open + 1;
  while (index < css.length && depth > 0) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") depth -= 1;
    index += 1;
  }
  return css.slice(open + 1, index - 1);
}

function colourTokens(block: string): Palette {
  const palette: Record<string, string> = {};
  const pattern = /(--pv-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
  let match = pattern.exec(block);
  while (match !== null) {
    palette[match[1] as string] = (match[2] as string).toLowerCase();
    match = pattern.exec(block);
  }
  return palette;
}

const source = withoutComments(tokensSource);

const light = colourTokens(blockAfter(source, ":root {"));
const darkFromMediaQuery = colourTokens(
  blockAfter(source, ':root:not([data-theme="light"]) {'),
);
const darkFromExplicitChoice = colourTokens(blockAfter(source, ':root[data-theme="dark"] {'));

const THEMES: readonly (readonly [string, Palette])[] = [
  ["light", light],
  ["dark", darkFromExplicitChoice],
];

// ---------------------------------------------------------------------------
// The pairs under test
// ---------------------------------------------------------------------------

const SURFACES = ["--pv-surface", "--pv-surface-raised", "--pv-surface-sunken"] as const;

const TEXT_ON_SURFACE = ["--pv-text", "--pv-text-muted", "--pv-accent"] as const;

const TONES = ["success", "warning", "danger", "info", "denied"] as const;

const BOUNDARIES = ["--pv-border", "--pv-border-strong", "--pv-focus-ring"] as const;

describe("token set", () => {
  it("declares the same token names in every value set", () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(darkFromExplicitChoice).sort());
    expect(Object.keys(light).sort()).toEqual(Object.keys(darkFromMediaQuery).sort());
  });

  it("keeps the two dark value sets identical", () => {
    // Dark is declared twice — once for the system preference and once for an
    // explicit choice — so that an explicit light choice can win over a dark
    // system preference without a specificity fight. The cost of that is two
    // copies, and this is what stops them diverging.
    expect(darkFromMediaQuery).toEqual(darkFromExplicitChoice);
  });

  it("lets an explicit choice override the media query in both directions", () => {
    // Light is on :root, so it applies unless something more specific wins.
    expect(source).toMatch(/^:root \{/m);
    // Dark by system preference steps aside for an explicit light choice.
    expect(source).toContain(':root:not([data-theme="light"])');
    // Dark by explicit choice beats a light system preference: higher
    // specificity than :root, and later in the file.
    expect(source).toContain(':root[data-theme="dark"]');
    expect(source.indexOf(':root[data-theme="dark"]')).toBeGreaterThan(source.indexOf(":root {"));
  });

  it("declares no third theme", () => {
    const themeSelectors = source.match(/\[data-theme="[a-z-]+"\]/g) ?? [];
    const distinct = new Set(themeSelectors);
    expect([...distinct].sort()).toEqual(['[data-theme="dark"]', '[data-theme="light"]']);
  });
});

describe.each(THEMES)("%s theme contrast", (_themeName, palette) => {
  it("puts every text colour at 4.5:1 or better on every surface", () => {
    for (const text of TEXT_ON_SURFACE) {
      for (const surface of SURFACES) {
        const ratio = contrastRatio(palette[text] as string, palette[surface] as string);
        expect(
          ratio,
          `${text} on ${surface} is ${ratio.toFixed(2)}:1, below the 4.5:1 required by WCAG 1.4.3`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("puts text on the accent fill at 4.5:1 or better", () => {
    for (const fill of ["--pv-accent", "--pv-accent-hover"] as const) {
      const ratio = contrastRatio(palette["--pv-accent-text"] as string, palette[fill] as string);
      expect(ratio, `--pv-accent-text on ${fill} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("puts every semantic tone at 4.5:1 on its own tint and on every surface", () => {
    for (const tone of TONES) {
      const foreground = palette[`--pv-${tone}-text`] as string;
      const tint = palette[`--pv-${tone}-bg`] as string;

      const onOwnTint = contrastRatio(foreground, tint);
      expect(onOwnTint, `--pv-${tone}-text on --pv-${tone}-bg is ${onOwnTint.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(4.5);

      for (const surface of SURFACES) {
        const ratio = contrastRatio(foreground, palette[surface] as string);
        expect(ratio, `--pv-${tone}-text on ${surface} is ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(4.5);
      }

      // Body text sits on the tint inside a callout, so it has to clear too.
      const bodyOnTint = contrastRatio(palette["--pv-text"] as string, tint);
      expect(bodyOnTint, `--pv-text on --pv-${tone}-bg is ${bodyOnTint.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(4.5);

      const mutedOnTint = contrastRatio(palette["--pv-text-muted"] as string, tint);
      expect(mutedOnTint, `--pv-text-muted on --pv-${tone}-bg is ${mutedOnTint.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it("puts every meaningful boundary at 3:1 or better on every surface", () => {
    for (const boundary of BOUNDARIES) {
      for (const surface of SURFACES) {
        const ratio = contrastRatio(palette[boundary] as string, palette[surface] as string);
        expect(
          ratio,
          `${boundary} on ${surface} is ${ratio.toFixed(2)}:1, below the 3:1 required by WCAG 1.4.11`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("puts every tone boundary at 3:1 on its own tint and on the base surfaces", () => {
    for (const tone of TONES) {
      const boundary = palette[`--pv-${tone}-border`] as string;
      const tint = palette[`--pv-${tone}-bg`] as string;

      const onOwnTint = contrastRatio(boundary, tint);
      expect(onOwnTint, `--pv-${tone}-border on --pv-${tone}-bg is ${onOwnTint.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(3);

      for (const surface of ["--pv-surface", "--pv-surface-raised"] as const) {
        const ratio = contrastRatio(boundary, palette[surface] as string);
        expect(ratio, `--pv-${tone}-border on ${surface} is ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps the focus ring distinguishable from every surface it can appear over", () => {
    // WCAG 2.2 2.4.13 wants the indicator to contrast with adjacent colours.
    // The ring is drawn with a 2px offset, so the adjacent colour is whichever
    // surface the control sits on rather than the control's own fill.
    for (const surface of SURFACES) {
      const ratio = contrastRatio(palette["--pv-focus-ring"] as string, palette[surface] as string);
      expect(ratio, `--pv-focus-ring on ${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  it("holds the decorative divider below 3:1, deliberately", () => {
    // Not an oversight. --pv-divider draws row rules that carry no meaning; if
    // it ever climbs to boundary strength, the tables stop reading as dense
    // data and start reading as a grid of boxes. The assertion is here so the
    // choice is visible rather than merely true.
    const ratio = contrastRatio(palette["--pv-divider"] as string, palette["--pv-surface"] as string);
    expect(ratio).toBeLessThan(3);
  });
});
