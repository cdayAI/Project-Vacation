import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "./axe";

/**
 * The gate, tested.
 *
 * Every view in this console is required to carry an accessibility assertion,
 * and CI fails if one is missing. None of that is worth anything if the
 * assertion itself cannot fail. This file plants known violations and checks
 * that the helper catches them — so a future change that quietly neuters the
 * rule set (a wrong tag list, a swallowed result, an `await` dropped from an
 * async assertion) is caught here rather than discovered by a user.
 */
describe("the accessibility assertion", () => {
  it("catches an image with no text alternative", async () => {
    const { container } = renderSurface(
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />,
    );

    await expect(expectNoAccessibilityViolations(container)).rejects.toThrow(/image-alt/);
  });

  it("catches a control with no accessible name", async () => {
    const { container } = renderSurface(<button type="button" />);

    await expect(expectNoAccessibilityViolations(container)).rejects.toThrow(/button-name/);
  });

  it("catches a form control with no label", async () => {
    const { container } = renderSurface(<input type="text" />);

    await expect(expectNoAccessibilityViolations(container)).rejects.toThrow(/label/);
  });

  it("catches a skipped heading level", async () => {
    const { container } = renderSurface(
      <div>
        <h1>A page</h1>
        <h4>A section three levels down</h4>
      </div>,
    );

    await expect(expectNoAccessibilityViolations(container)).rejects.toThrow(/heading-order/);
  });

  it("passes clean markup", async () => {
    const { container } = renderSurface(
      <div>
        <h1>A page</h1>
        <p>With a paragraph in it.</p>
      </div>,
    );

    await expectNoAccessibilityViolations(container);
  });
});
