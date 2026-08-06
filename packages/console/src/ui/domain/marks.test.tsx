import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import {
  MarkAction,
  MarkAdded,
  MarkAsserted,
  MarkChanged,
  MarkComputed,
  MarkExternal,
  MarkFilter,
  MarkHuman,
  MarkModel,
  MarkRemoved,
  MarkRetrieval,
  MarkRetrieved,
  MarkTrendDown,
  MarkTrendFlat,
  MarkTrendUp,
  MarkUndo,
  MarkWait,
} from "./marks";

const ALL = [
  MarkAction,
  MarkAdded,
  MarkAsserted,
  MarkChanged,
  MarkComputed,
  MarkExternal,
  MarkFilter,
  MarkHuman,
  MarkModel,
  MarkRemoved,
  MarkRetrieval,
  MarkRetrieved,
  MarkTrendDown,
  MarkTrendFlat,
  MarkTrendUp,
  MarkUndo,
  MarkWait,
];

describe("domain marks", () => {
  it("hides every mark from assistive technology", () => {
    // A mark in this system is always beside a word. Exposing one produces a
    // second announcement of something the label already said.
    const { container } = renderSurface(
      <>
        {ALL.map((Mark, index) => (
          <Mark key={index} />
        ))}
      </>,
    );

    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(ALL.length);
    for (const svg of svgs) {
      expect(svg).toHaveAttribute("aria-hidden", "true");
      // Older engines put an SVG in the tab order without this.
      expect(svg).toHaveAttribute("focusable", "false");
    }
  });

  it("draws in currentColor so it survives a monochrome print", () => {
    const { container } = renderSurface(<MarkModel />);
    expect(container.querySelector("svg")).toHaveAttribute("stroke", "currentColor");
  });

  it("takes its size from the scale rather than from a font size", () => {
    const { container } = renderSurface(<MarkTrendUp size="sm" />);
    expect(container.querySelector("svg")).toHaveClass("pv-mark", "pv-mark-sm");
  });

  it("separates the two trend directions by shape, not by colour", () => {
    // The arrows must be distinguishable on a greyscale printout, which means
    // their geometry has to differ rather than their fill.
    const up = renderSurface(<MarkTrendUp />).container.querySelector("path")?.getAttribute("d");
    const down = renderSurface(<MarkTrendDown />)
      .container.querySelector("path")
      ?.getAttribute("d");
    expect(up).toBeTruthy();
    expect(down).toBeTruthy();
    expect(up).not.toEqual(down);
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <p>
        Retrieved <MarkRetrieved /> asserted <MarkAsserted /> computed <MarkComputed />
      </p>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
