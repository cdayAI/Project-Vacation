import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations } from "../../test/axe";
import { ReadOnlyChip } from "./ReadOnlyChip";

describe("ReadOnlyChip", () => {
  it("says read-only in words, not only with a colour and a padlock", () => {
    render(<ReadOnlyChip />);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("accepts a more specific label", () => {
    render(<ReadOnlyChip label="Read-only · audit" />);
    expect(screen.getByText("Read-only · audit")).toBeInTheDocument();
  });

  it("hides its mark from assistive technology, because the word already said it", () => {
    const { container } = render(<ReadOnlyChip />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <main>
        <ReadOnlyChip />
      </main>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
