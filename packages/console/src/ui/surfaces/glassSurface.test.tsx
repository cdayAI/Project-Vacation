import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations } from "../../test/axe";
import {
  GLASS_BUDGET_CAPACITY,
  GLASS_PRIORITY,
  GlassBudgetProvider,
  SOLID_SURFACE_CLASS,
  useGlassSurface,
  useVirtualScrollerRegistration,
  type GlassPriority,
} from "./glassSurface";

function Surface({
  name,
  priority,
  locksBackdrop = false,
  wantsBlur = true,
}: {
  readonly name: string;
  readonly priority: GlassPriority;
  readonly locksBackdrop?: boolean;
  readonly wantsBlur?: boolean;
}) {
  const glass = useGlassSurface({ priority, locksBackdrop, wantsBlur });
  return (
    <div data-testid={name} className={glass.surfaceClassName} data-blurred={glass.blurred}>
      <div className={glass.scrimClassName}>{name}</div>
    </div>
  );
}

function Scroller() {
  useVirtualScrollerRegistration();
  return <div data-testid="scroller" />;
}

function blurred(name: string): boolean {
  return screen.getByTestId(name).dataset.blurred === "true";
}

describe("useGlassSurface", () => {
  it("grants blur while the budget has room", () => {
    render(
      <GlassBudgetProvider>
        <Surface name="one" priority={GLASS_PRIORITY.chrome} />
        <Surface name="two" priority={GLASS_PRIORITY.chrome} />
        <Surface name="three" priority={GLASS_PRIORITY.chrome} />
      </GlassBudgetProvider>,
    );

    expect(blurred("one")).toBe(true);
    expect(blurred("two")).toBe(true);
    expect(blurred("three")).toBe(true);
    expect(GLASS_BUDGET_CAPACITY).toBe(3);
  });

  it("refuses the fourth concurrent blur", () => {
    render(
      <GlassBudgetProvider>
        <Surface name="one" priority={GLASS_PRIORITY.chrome} />
        <Surface name="two" priority={GLASS_PRIORITY.chrome} />
        <Surface name="three" priority={GLASS_PRIORITY.chrome} />
        <Surface name="four" priority={GLASS_PRIORITY.chrome} />
      </GlassBudgetProvider>,
    );

    expect(blurred("four")).toBe(false);
    expect(screen.getByTestId("four")).toHaveClass(SOLID_SURFACE_CLASS);
  });

  it("takes a slot from chrome for a modal rather than leaving the modal solid", () => {
    // The shell claims all three slots the moment the console loads. Arrival
    // order would mean no modal in the product ever blurs.
    render(
      <GlassBudgetProvider>
        <Surface name="rail" priority={GLASS_PRIORITY.chrome} />
        <Surface name="topBar" priority={GLASS_PRIORITY.chrome} />
        <Surface name="panel" priority={GLASS_PRIORITY.chrome} />
        <Surface name="modal" priority={GLASS_PRIORITY.modal} locksBackdrop />
      </GlassBudgetProvider>,
    );

    expect(blurred("modal")).toBe(true);
    // Equal priorities resolve oldest-first, so the newest piece of chrome is
    // the one that yields — and at that moment the modal's scrim is covering
    // it, so nobody sees it happen.
    expect(blurred("panel")).toBe(false);
    expect(blurred("rail")).toBe(true);
    expect(blurred("topBar")).toBe(true);
  });

  it("releases the slot when a surface unmounts", () => {
    const { rerender } = render(
      <GlassBudgetProvider capacity={1}>
        <Surface name="first" priority={GLASS_PRIORITY.chrome} />
        <Surface name="second" priority={GLASS_PRIORITY.chrome} />
      </GlassBudgetProvider>,
    );

    expect(blurred("first")).toBe(true);
    expect(blurred("second")).toBe(false);

    rerender(
      <GlassBudgetProvider capacity={1}>
        <Surface name="second" priority={GLASS_PRIORITY.chrome} />
      </GlassBudgetProvider>,
    );

    expect(blurred("second")).toBe(true);
  });

  it("never blurs an anchored surface while a virtualized list is mounted", () => {
    // Spec §1.5: never blur behind a scrolling virtualized list. A dropdown
    // cannot lock the list underneath it, so it renders solid.
    render(
      <GlassBudgetProvider>
        <Scroller />
        <Surface name="dropdown" priority={GLASS_PRIORITY.anchored} />
      </GlassBudgetProvider>,
    );

    expect(blurred("dropdown")).toBe(false);
  });

  it("allows blur over a virtualized list for a surface that locks the backdrop", () => {
    // A sheet makes the page behind it inert and unscrollable before it paints,
    // so there is nothing moving under the blur.
    render(
      <GlassBudgetProvider>
        <Scroller />
        <Surface name="sheet" priority={GLASS_PRIORITY.sheet} locksBackdrop />
      </GlassBudgetProvider>,
    );

    expect(blurred("sheet")).toBe(true);
  });

  it("returns the blur to anchored surfaces once the list unmounts", () => {
    const { rerender } = render(
      <GlassBudgetProvider>
        <Scroller />
        <Surface name="dropdown" priority={GLASS_PRIORITY.anchored} />
      </GlassBudgetProvider>,
    );
    expect(blurred("dropdown")).toBe(false);

    rerender(
      <GlassBudgetProvider>
        <Surface name="dropdown" priority={GLASS_PRIORITY.anchored} />
      </GlassBudgetProvider>,
    );
    expect(blurred("dropdown")).toBe(true);
  });

  it("spends no budget on a surface that did not ask for glass", () => {
    render(
      <GlassBudgetProvider capacity={1}>
        <Surface name="plain" priority={GLASS_PRIORITY.chrome} wantsBlur={false} />
        <Surface name="glass" priority={GLASS_PRIORITY.chrome} />
      </GlassBudgetProvider>,
    );

    expect(blurred("plain")).toBe(false);
    expect(blurred("glass")).toBe(true);
  });

  it("gives a solid surface no scrim, because a scrim on a solid is a second fill", () => {
    render(
      <GlassBudgetProvider capacity={0}>
        <Surface name="solid" priority={GLASS_PRIORITY.chrome} />
      </GlassBudgetProvider>,
    );

    expect(screen.getByTestId("solid").firstElementChild?.className).toBe("");
  });

  it("has no accessibility consequences either way", async () => {
    const { container } = render(
      <main>
        <GlassBudgetProvider capacity={1}>
          <Surface name="glass" priority={GLASS_PRIORITY.chrome} />
          <Surface name="solid" priority={GLASS_PRIORITY.chrome} />
        </GlassBudgetProvider>
      </main>,
    );

    await expectNoAccessibilityViolations(container);
  });
});
