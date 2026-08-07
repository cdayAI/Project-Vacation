import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import {
  IconAlert,
  IconBlocked,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCircle,
  IconCross,
  IconDash,
  IconDot,
  IconInfo,
  IconLock,
} from "./icons";

const ICONS = [
  IconAlert,
  IconBlocked,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCircle,
  IconCross,
  IconDash,
  IconDot,
  IconInfo,
  IconLock,
];

describe("icons", () => {
  it("carries no accessibility violations", async () => {
    const { container } = renderSurface(
      <p>
        {ICONS.map((Icon, index) => (
          <Icon key={index} />
        ))}
      </p>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("hides every icon from assistive technology", () => {
    const { container } = renderSurface(
      <p>
        {ICONS.map((Icon, index) => (
          <Icon key={index} />
        ))}
      </p>,
    );
    const drawings = [...container.querySelectorAll("svg")];
    expect(drawings).toHaveLength(ICONS.length);
    for (const drawing of drawings) {
      // An icon in this system is always the second channel beside a word, so
      // it has nothing to add to the accessibility tree.
      expect(drawing).toHaveAttribute("aria-hidden", "true");
      // Older engines put an SVG in the tab order without this.
      expect(drawing).toHaveAttribute("focusable", "false");
    }
  });

  it("draws in the current colour, so an icon inherits its context", () => {
    const { container } = renderSurface(<IconCheck />);
    const drawing = container.querySelector("svg");
    expect(drawing).toHaveAttribute("stroke", "currentColor");
    expect(drawing).toHaveAttribute("fill", "none");
  });

  it("takes its size from the scale rather than from a number", () => {
    const { container } = renderSurface(
      <>
        <IconCheck />
        <IconCheck size="sm" />
      </>,
    );
    const [medium, small] = [...container.querySelectorAll("svg")];
    expect(medium?.getAttribute("class")).toBe("pv-ui-icon");
    expect(small?.getAttribute("class")).toBe("pv-ui-icon pv-ui-icon-sm");
  });
});
