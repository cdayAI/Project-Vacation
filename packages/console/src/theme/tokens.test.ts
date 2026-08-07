import { describe, expect, it } from "vitest";
import glassSource from "./glass.css?raw";
import motionSource from "./motion.css?raw";
import tokensSource from "./tokens.css?raw";
import {
  ALL_TOKEN_NAMES,
  SPACE_STEPS,
  STATUS_TONES,
  TYPE_AXES,
  TYPE_STEPS,
  spaceToken,
  statusBorderToken,
  statusSurfaceToken,
  statusToken,
  typeToken,
} from "./tokens";

/**
 * The design system, verified against the stylesheets the application ships.
 *
 * The stylesheets are parsed rather than duplicated here: a test carrying its
 * own copy of the palette passes forever after someone edits the real one.
 * Change a value in tokens.css and this file either agrees or fails.
 *
 * What is checked:
 *   - every text/surface pair reaches 4.5:1 and every meaningful boundary 3:1,
 *     in both themes (WCAG 2.2 1.4.3 and 1.4.11);
 *   - the glass composite — text measured against glass over the page, not
 *     against the glass token. Measuring against the panel token is how a glass
 *     interface passes review and fails an audit, so it is the highest-value
 *     assertion in this file;
 *   - the light and dark sets declare exactly the same token names, so a token
 *     added to one theme and forgotten in the other fails instead of silently
 *     falling back;
 *   - dark glass is a separate value set rather than inverted light glass;
 *   - the categorical chart palette survives greyscale, which is what a printed
 *     regulator export and a monochromat both see;
 *   - every token name exported by tokens.ts actually exists in the CSS.
 *
 * Two exemptions are asserted explicitly rather than left implicit, so that
 * they stay decisions on the record: the specification's two border hairlines
 * sit below 3:1 on purpose, and the chart palette is not held to 3:1 against
 * the plot background.
 */

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

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

/** What a translucent layer actually looks like over an opaque one. */
function composite(layer: Rgba, backgroundHex: string): string {
  const background = backgroundHex.replace("#", "");
  const mixed = [0, 2, 4].map((offset) => {
    const base = channel(background, offset);
    const top = offset === 0 ? layer.r : offset === 2 ? layer.g : layer.b;
    return Math.round(top * layer.a + base * (1 - layer.a));
  });
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Palette = Readonly<Record<string, string>>;

/** Strips comments so a ratio written in a comment cannot be read as a value. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Pulls the nth declaration block that follows a selector.
 *
 * Written by hand rather than with a CSS parser: adding a parser dependency to
 * read a dozen declaration blocks would be a worse trade than forty lines of
 * string handling that these tests themselves prove works.
 */
function blockAfter(css: string, selectorWithBrace: string, occurrence = 1): string {
  if (!selectorWithBrace.endsWith("{")) {
    throw new Error("blockAfter expects the selector text up to and including its opening brace");
  }
  let start = -1;
  for (let found = 0; found < occurrence; found += 1) {
    start = css.indexOf(selectorWithBrace, start + 1);
    if (start === -1) {
      throw new Error(
        `the stylesheet no longer contains occurrence ${occurrence} of ${selectorWithBrace}`,
      );
    }
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

/** Every custom property declared in a block, whatever the value looks like. */
function declaredNames(block: string): readonly string[] {
  const names: string[] = [];
  const pattern = /(--pv-[a-z0-9-]+)\s*:/g;
  let match = pattern.exec(block);
  while (match !== null) {
    names.push(match[1] as string);
    match = pattern.exec(block);
  }
  return names;
}

/** Only the properties whose value is a plain six-digit hex colour. */
function hexTokens(block: string): Palette {
  const palette: Record<string, string> = {};
  const pattern = /(--pv-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
  let match = pattern.exec(block);
  while (match !== null) {
    palette[match[1] as string] = (match[2] as string).toLowerCase();
    match = pattern.exec(block);
  }
  return palette;
}

/** Only the properties whose whole value is a single rgba() colour. */
function rgbaTokens(block: string): Readonly<Record<string, Rgba>> {
  const parsed: Record<string, Rgba> = {};
  const pattern = /(--pv-[a-z0-9-]+)\s*:\s*rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)\s*;/g;
  let match = pattern.exec(block);
  while (match !== null) {
    parsed[match[1] as string] = {
      r: Number.parseInt(match[2] as string, 10),
      g: Number.parseInt(match[3] as string, 10),
      b: Number.parseInt(match[4] as string, 10),
      a: Number.parseFloat(match[5] as string),
    };
    match = pattern.exec(block);
  }
  return parsed;
}

function colour(palette: Palette, token: string): string {
  const value = palette[token];
  if (value === undefined) throw new Error(`${token} is not declared as a hex colour`);
  return value;
}

function translucent(parsed: Readonly<Record<string, Rgba>>, token: string): Rgba {
  const value = parsed[token];
  if (value === undefined) throw new Error(`${token} is not declared as an rgba() colour`);
  return value;
}

const tokens = withoutComments(tokensSource);
const glass = withoutComments(glassSource);
const motion = withoutComments(motionSource);
const everything = `${tokens}\n${glass}\n${motion}`;

// The light colour set is the first :root block and the theme-independent
// scales are the second. tokens.css says so and a test below pins it.
const lightBlock = blockAfter(tokens, ":root {", 1);
const scalesBlock = blockAfter(tokens, ":root {", 2);
const darkFromMediaQuery = blockAfter(tokens, ':root:not([data-theme="light"]) {');
const darkFromExplicitChoice = blockAfter(tokens, ':root[data-theme="dark"] {');

const light = hexTokens(lightBlock);
const dark = hexTokens(darkFromExplicitChoice);
const scales = hexTokens(scalesBlock);

const lightTranslucent = rgbaTokens(lightBlock);
const darkTranslucent = rgbaTokens(darkFromExplicitChoice);

const glassLight = rgbaTokens(blockAfter(glass, ":root {", 1));
const glassDark = rgbaTokens(blockAfter(glass, ':root[data-theme="dark"] {'));

interface ThemeCase {
  readonly name: string;
  readonly palette: Palette;
  readonly translucentTokens: Readonly<Record<string, Rgba>>;
  readonly glassTokens: Readonly<Record<string, Rgba>>;
}

const THEMES: readonly ThemeCase[] = [
  { name: "light", palette: light, translucentTokens: lightTranslucent, glassTokens: glassLight },
  { name: "dark", palette: dark, translucentTokens: darkTranslucent, glassTokens: glassDark },
];

// ---------------------------------------------------------------------------
// The pairs under test
// ---------------------------------------------------------------------------

const SURFACES = [
  "--pv-bg-base",
  "--pv-bg-subtle",
  "--pv-surface",
  "--pv-surface-raised",
] as const;

const TEXT_ON_SURFACE = [
  "--pv-content-primary",
  "--pv-content-secondary",
  "--pv-content-tertiary",
  "--pv-accent",
  "--pv-accent-hover",
] as const;

const BODY_TEXT = 4.5;
const BOUNDARY = 3;

// ---------------------------------------------------------------------------

describe("token set structure", () => {
  it("declares exactly two :root blocks, in the order the parser depends on", () => {
    // The contrast tests find the light value set by taking the first :root
    // block and the scales by taking the second. If a third appears, or the
    // order changes, every ratio below would be measured against the wrong
    // thing and still pass. This is what stops that.
    const rootBlocks = tokens.match(/:root \{/g) ?? [];
    expect(rootBlocks).toHaveLength(2);
    expect(light["--pv-surface"]).toBeDefined();
    expect(scales["--pv-chart-1"]).toBeDefined();
    expect(scales["--pv-surface"]).toBeUndefined();
  });

  it("declares the same token names in every value set", () => {
    const lightNames = [...declaredNames(lightBlock)].sort();
    expect([...declaredNames(darkFromExplicitChoice)].sort()).toEqual(lightNames);
    expect([...declaredNames(darkFromMediaQuery)].sort()).toEqual(lightNames);
  });

  it("keeps the two dark value sets identical", () => {
    // Dark is declared twice — once for the system preference and once for an
    // explicit choice — so that an explicit light choice can win over a dark
    // system preference without a specificity fight. The cost of that is two
    // copies, and this is what stops them diverging.
    expect(hexTokens(darkFromMediaQuery)).toEqual(hexTokens(darkFromExplicitChoice));
    expect(rgbaTokens(darkFromMediaQuery)).toEqual(rgbaTokens(darkFromExplicitChoice));
    expect(darkFromMediaQuery.replace(/\s+/g, " ").trim()).toEqual(
      darkFromExplicitChoice.replace(/\s+/g, " ").trim(),
    );
  });

  it("lets an explicit choice override the media query in both directions", () => {
    expect(tokens).toMatch(/^:root \{/m);
    // Dark by system preference steps aside for an explicit light choice.
    expect(tokens).toContain(':root:not([data-theme="light"])');
    // Dark by explicit choice beats a light system preference: higher
    // specificity than :root, and later in the file.
    expect(tokens).toContain(':root[data-theme="dark"]');
    expect(tokens.indexOf(':root[data-theme="dark"]')).toBeGreaterThan(tokens.indexOf(":root {"));
  });

  it("declares no third theme", () => {
    const themeSelectors = everything.match(/\[data-theme="[a-z-]+"\]/g) ?? [];
    expect([...new Set(themeSelectors)].sort()).toEqual([
      '[data-theme="dark"]',
      '[data-theme="light"]',
    ]);
  });

  it("declares every token name that tokens.ts exports", () => {
    // The typed module is what components code against. A token renamed in CSS
    // and not in TypeScript resolves to nothing on screen and throws nowhere.
    const missing = ALL_TOKEN_NAMES.filter((name) => !everything.includes(`${name}:`));
    expect(missing).toEqual([]);
  });

  it("declares no spacing step outside the scale", () => {
    const declared = declaredNames(scalesBlock).filter((name) => name.startsWith("--pv-space-"));
    expect([...declared].sort()).toEqual([...SPACE_STEPS.map(spaceToken)].sort());
  });

  it("declares all four axes of all nine type steps and nothing else", () => {
    const declared = declaredNames(scalesBlock).filter((name) => name.startsWith("--pv-type-"));
    const expected = TYPE_STEPS.flatMap((step) => TYPE_AXES.map((axis) => typeToken(step, axis)));
    expect([...declared].sort()).toEqual([...expected].sort());
  });
});

describe.each(THEMES.map((theme) => [theme.name, theme] as const))(
  "%s theme contrast",
  (_name, theme) => {
    const palette = theme.palette;

    it("puts every text colour at 4.5:1 or better on every surface", () => {
      for (const text of TEXT_ON_SURFACE) {
        for (const surface of SURFACES) {
          const ratio = contrastRatio(colour(palette, text), colour(palette, surface));
          expect(
            ratio,
            `${text} on ${surface} is ${ratio.toFixed(2)}:1, below the 4.5:1 of WCAG 1.4.3`,
          ).toBeGreaterThanOrEqual(BODY_TEXT);
        }
      }
    });

    it("puts text on the accent fill at 4.5:1 or better", () => {
      // The accent is a placeholder for MVW's brand colour. This is the
      // assertion a brand value has to survive before it can be merged.
      for (const fill of ["--pv-accent", "--pv-accent-hover"] as const) {
        const ratio = contrastRatio(colour(palette, "--pv-accent-contrast"), colour(palette, fill));
        expect(
          ratio,
          `--pv-accent-contrast on ${fill} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(BODY_TEXT);
      }
    });

    it("puts every status colour at 4.5:1 on its own tint and on every surface", () => {
      for (const tone of STATUS_TONES) {
        const foreground = colour(palette, statusToken(tone));
        const tint = colour(palette, statusSurfaceToken(tone));

        const onOwnTint = contrastRatio(foreground, tint);
        expect(
          onOwnTint,
          `${statusToken(tone)} on its own tint is ${onOwnTint.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(BODY_TEXT);

        for (const surface of SURFACES) {
          const ratio = contrastRatio(foreground, colour(palette, surface));
          expect(
            ratio,
            `${statusToken(tone)} on ${surface} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(BODY_TEXT);
        }

        // Body text sits on the tint inside a callout, so it has to clear too.
        for (const text of ["--pv-content-primary", "--pv-content-secondary"] as const) {
          const ratio = contrastRatio(colour(palette, text), tint);
          expect(
            ratio,
            `${text} on ${statusSurfaceToken(tone)} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(BODY_TEXT);
        }
      }
    });

    it("puts every status boundary at 3:1 on its own tint and on the surfaces", () => {
      for (const tone of STATUS_TONES) {
        const boundary = colour(palette, statusBorderToken(tone));

        const onOwnTint = contrastRatio(boundary, colour(palette, statusSurfaceToken(tone)));
        expect(
          onOwnTint,
          `${statusBorderToken(tone)} on its own tint is ${onOwnTint.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(BOUNDARY);

        for (const surface of SURFACES) {
          const ratio = contrastRatio(boundary, colour(palette, surface));
          expect(
            ratio,
            `${statusBorderToken(tone)} on ${surface} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(BOUNDARY);
        }
      }
    });

    it("puts the control boundary at 3:1 on every surface", () => {
      // WCAG 1.4.11: the border is the only thing identifying an input or an
      // unfilled button, so it is information, not decoration.
      for (const surface of SURFACES) {
        const ratio = contrastRatio(colour(palette, "--pv-border-control"), colour(palette, surface));
        expect(
          ratio,
          `--pv-border-control on ${surface} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(BOUNDARY);
      }
    });

    it("keeps the focus ring distinguishable from every surface it can appear over", () => {
      // WCAG 2.2 2.4.13 wants the indicator to contrast with adjacent colours.
      // The ring is drawn with a 2px offset, so the adjacent colour on both
      // sides is the surface the control sits on, not the control's own fill —
      // which is also why the ring can be a single colour rather than one per
      // fill it might surround.
      for (const surface of SURFACES) {
        const ratio = contrastRatio(colour(palette, "--pv-focus-ring"), colour(palette, surface));
        expect(
          ratio,
          `--pv-focus-ring on ${surface} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(BOUNDARY);
      }
    });

    it("holds the two specified border hairlines below 3:1, deliberately", () => {
      // Not an oversight. The specification's border alphas composite to about
      // 1.2:1 and 1.6:1; they draw structure that carries no information, and
      // raising them to boundary strength would turn every dense table into a
      // grid of boxes. Anything that must be perceived to be used carries
      // --pv-border-control instead, which is asserted above.
      for (const hairline of ["--pv-border-subtle", "--pv-border-strong"] as const) {
        const composited = composite(
          translucent(theme.translucentTokens, hairline),
          colour(palette, "--pv-surface"),
        );
        expect(contrastRatio(composited, colour(palette, "--pv-surface"))).toBeLessThan(BOUNDARY);
      }
    });
  },
);

describe.each(THEMES.map((theme) => [theme.name, theme] as const))(
  "%s glass composite",
  (_name, theme) => {
    const palette = theme.palette;
    // What the operator's eye actually receives: the glass tint over whatever
    // the page put behind it. Measuring text against --pv-glass-bg instead is
    // the single most common way a glass interface fails an accessibility
    // audit it thought it had passed.
    const backdrops = ["--pv-bg-base", "--pv-surface"] as const;

    it("keeps text legible against glass over the page, not against the glass token", () => {
      for (const backdrop of backdrops) {
        const composited = composite(
          translucent(theme.glassTokens, "--pv-glass-bg"),
          colour(palette, backdrop),
        );
        for (const text of TEXT_ON_SURFACE) {
          const ratio = contrastRatio(colour(palette, text), composited);
          expect(
            ratio,
            `${text} on glass over ${backdrop} composites to ${composited} and is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(BODY_TEXT);
        }
      }
    });

    it("keeps every status colour legible against the same composite", () => {
      // Toasts and the decision bar are glass, and both of them carry status.
      for (const backdrop of backdrops) {
        const composited = composite(
          translucent(theme.glassTokens, "--pv-glass-bg"),
          colour(palette, backdrop),
        );
        for (const tone of STATUS_TONES) {
          const ratio = contrastRatio(colour(palette, statusToken(tone)), composited);
          expect(
            ratio,
            `${statusToken(tone)} on glass over ${backdrop} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(BODY_TEXT);
        }
      }
    });

    it("keeps the focus ring visible on glass", () => {
      for (const backdrop of backdrops) {
        const composited = composite(
          translucent(theme.glassTokens, "--pv-glass-bg"),
          colour(palette, backdrop),
        );
        const ratio = contrastRatio(colour(palette, "--pv-focus-ring"), composited);
        expect(ratio, `--pv-focus-ring on glass over ${backdrop} is ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(BOUNDARY);
      }
    });

    it("keeps text legible on the scrim a glass panel puts its text on", () => {
      // The scrim is the solid child text belongs in. It is still translucent,
      // so it is still composited rather than trusted.
      for (const backdrop of backdrops) {
        const glassOverPage = composite(
          translucent(theme.glassTokens, "--pv-glass-bg"),
          colour(palette, backdrop),
        );
        const scrimmed = composite(translucent(theme.glassTokens, "--pv-glass-scrim"), glassOverPage);
        for (const text of TEXT_ON_SURFACE) {
          const ratio = contrastRatio(colour(palette, text), scrimmed);
          expect(
            ratio,
            `${text} on the scrim over ${backdrop} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(BODY_TEXT);
        }
      }
    });

    it("keeps the scrim at 92% opacity or more", () => {
      // Below that the page starts showing through the one container that is
      // supposed to be the reason the measured contrast is trustworthy.
      expect(translucent(theme.glassTokens, "--pv-glass-scrim").a).toBeGreaterThanOrEqual(0.92);
    });
  },
);

describe("glass recipe", () => {
  it("declares the same glass tokens in both themes", () => {
    const lightNames = [...declaredNames(blockAfter(glass, ":root {", 1))].sort();
    expect([...declaredNames(blockAfter(glass, ':root[data-theme="dark"] {'))].sort()).toEqual(
      lightNames,
    );
    expect(
      [...declaredNames(blockAfter(glass, ':root:not([data-theme="light"]) {'))].sort(),
    ).toEqual(lightNames);
  });

  it("gives dark glass its own tint, opacity, blur, and highlight", () => {
    // Dark glass is not light glass inverted. If someone ever "simplifies" this
    // by deriving one from the other, the dark theme gets a grey fog with a
    // white rim and this fails.
    const lightBg = translucent(glassLight, "--pv-glass-bg");
    const darkBg = translucent(glassDark, "--pv-glass-bg");
    expect(darkBg.a).not.toEqual(lightBg.a);
    expect([darkBg.r, darkBg.g, darkBg.b]).not.toEqual([255 - lightBg.r, 255 - lightBg.g, 255 - lightBg.b]);

    const lightBlur = /--pv-glass-blur:\s*([^;]+);/.exec(blockAfter(glass, ":root {", 1));
    const darkBlur = /--pv-glass-blur:\s*([^;]+);/.exec(
      blockAfter(glass, ':root[data-theme="dark"] {'),
    );
    expect(lightBlur?.[1]).toBe("blur(32px) saturate(200%)");
    expect(darkBlur?.[1]).toBe("blur(36px) saturate(150%)");
  });

  it("swaps glass for a designed solid under either transparency signal", () => {
    // The reduced variant is surface-raised + border-subtle + elevation 2 —
    // a surface someone designed, not a glass panel with its blur removed.
    const fromMediaQuery = blockAfter(glass, ':root[data-theme="light"] {');
    const fromPreference = blockAfter(glass, ':root[data-transparency="reduced"] {');

    for (const block of [fromMediaQuery, fromPreference]) {
      expect(block).toContain("--pv-glass-bg: var(--pv-surface-raised);");
      expect(block).toContain("--pv-glass-blur: none;");
      expect(block).toContain("--pv-glass-border-color: var(--pv-border-subtle);");
      // Not `none`: the highlight is one item of a box-shadow list, and `none`
      // inside a list is invalid and would take the elevation down with it.
      expect(block).toContain("--pv-glass-highlight: inset 0 0 0 0 transparent;");
    }
    expect(fromMediaQuery.replace(/\s+/g, " ").trim()).toEqual(
      fromPreference.replace(/\s+/g, " ").trim(),
    );

    expect(glass).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(blockAfter(glass, ".pv-glass {")).toContain("var(--pv-elevation-2)");
  });

  it("lets the system transparency preference beat an explicit theme choice", () => {
    // :root[data-theme="dark"] has two selector components. A bare :root inside
    // the reduced-transparency media query has one and would lose to it, so an
    // operator on dark who asked their OS for reduced transparency would still
    // get glass. The media query therefore names all three theme selectors and
    // comes later in the file.
    const reducedAt = glass.indexOf("@media (prefers-reduced-transparency: reduce)");
    expect(reducedAt).toBeGreaterThan(glass.indexOf(':root[data-theme="dark"] {'));
    const reducedBlock = glass.slice(reducedAt, reducedAt + 200);
    expect(reducedBlock).toContain(':root[data-theme="dark"]');
    expect(reducedBlock).toContain(':root[data-theme="light"]');
  });

  it("offers no way to force transparency back on", () => {
    // Reduction is a floor. There is no [data-transparency="full"] selector to
    // undo an operating-system accessibility preference.
    const transparencySelectors = everything.match(/\[data-transparency="[a-z-]+"\]/g) ?? [];
    expect([...new Set(transparencySelectors)]).toEqual(['[data-transparency="reduced"]']);
  });

  it("falls back to the solid surface where backdrop-filter does not exist", () => {
    // A tint with no blur behind it is less legible than the solid surface, not
    // more: 72% white over arbitrary content is a smear.
    expect(glass).toContain("@supports not ((backdrop-filter: blur(1px))");
  });
});

describe("chart palette", () => {
  const entries = Array.from({ length: 8 }, (_, index) => colour(scales, `--pv-chart-${index + 1}`));

  it("declares eight categorical entries", () => {
    expect(entries).toHaveLength(8);
    expect(new Set(entries).size).toBe(8);
  });

  it("stays readable in greyscale", () => {
    // §1.4 requires verifying the palette in greyscale. This is that check, and
    // it is not decorative: an audit pack is printed, a projector washes out
    // hue before it washes out lightness, and a monochromat sees only this.
    // Adjacent entries are the ones that end up beside each other in a legend
    // and in a stacked bar.
    for (let index = 1; index < entries.length; index += 1) {
      const previous = relativeLuminance(entries[index - 1] as string);
      const current = relativeLuminance(entries[index] as string);
      const separation =
        (Math.max(previous, current) + 0.05) / (Math.min(previous, current) + 0.05);
      expect(
        separation,
        `chart entries ${index} and ${index + 1} differ by only ${separation.toFixed(3)} in greyscale`,
      ).toBeGreaterThanOrEqual(1.15);
    }
  });

  it("is not held to 3:1 against the plot background, and says so", () => {
    // Recorded rather than silently skipped. Several of the specified hues
    // cannot reach 3:1 on a white plot area without becoming different hues, so
    // charts carry direct labels and position encoding instead (spec §3.5).
    // If a future palette does clear it everywhere, delete this and raise the
    // bar rather than leaving a weaker rule in place.
    const worst = Math.min(
      ...entries.map((entry) => contrastRatio(entry, colour(light, "--pv-surface"))),
    );
    expect(worst).toBeLessThan(BOUNDARY);
    expect(worst).toBeGreaterThan(2.5);
  });

  it("derives the sequential ramp from the accent so a brand change reaches it", () => {
    expect(scalesBlock).toContain("--pv-sequential-5: var(--pv-accent);");
    expect(scalesBlock).toContain("color-mix(in oklab, var(--pv-accent)");
  });

  it("centres the diverging ramp on neutral, between danger and success", () => {
    expect(scalesBlock).toContain("--pv-diverging-1: var(--pv-status-danger);");
    expect(scalesBlock).toContain("--pv-diverging-4: var(--pv-status-neutral);");
    expect(scalesBlock).toContain("--pv-diverging-7: var(--pv-status-success);");
  });
});

describe("motion", () => {
  const block = blockAfter(motion, ":root {", 1);

  it("declares the four durations and two easings from the specification", () => {
    expect(block).toContain("--pv-motion-micro: 120ms;");
    expect(block).toContain("--pv-motion-standard: 180ms;");
    expect(block).toContain("--pv-motion-surface: 240ms;");
    expect(block).toContain("--pv-motion-page: 280ms;");
    expect(block).toContain("--pv-ease-entry: cubic-bezier(0.2, 0, 0, 1);");
    expect(block).toContain("--pv-ease-exit: cubic-bezier(0.4, 0, 1, 1);");
  });

  it("derives every exit from the entry rather than hard-coding it", () => {
    // An exit duration typed by hand is an exit duration that stops being 0.7
    // of its entry the first time someone tunes the entry.
    expect(block).toContain("--pv-motion-exit-multiplier: 0.7;");
    for (const step of ["micro", "standard", "surface", "page"] as const) {
      expect(block).toContain(
        `--pv-motion-${step}-exit: calc(var(--pv-motion-${step}) * var(--pv-motion-exit-multiplier));`,
      );
    }
  });

  it("collapses to opacity at 80ms under prefers-reduced-motion", () => {
    expect(motion).toContain("@media (prefers-reduced-motion: reduce)");
    const reduced = motion.slice(motion.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("--pv-motion-reduced");
    expect(reduced).toContain("transition-property: opacity !important;");
    expect(reduced).toContain("transition-duration: var(--pv-motion-reduced) !important;");
    expect(reduced).toContain("animation-iteration-count: 1 !important;");
    expect(block).toContain("--pv-motion-reduced: 80ms;");
  });

  it("neutralises the exit multiplier under reduced motion", () => {
    // Otherwise an exit becomes 56ms, which is short enough to read as a glitch
    // rather than as a dismissal.
    const reduced = motion.slice(motion.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("--pv-motion-exit-multiplier: 1;");
  });
});
