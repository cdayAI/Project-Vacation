import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import {
  PROVENANCE_KINDS,
  PROVENANCE_MEANINGS,
  PROVENANCE_WORDS,
  ProvenanceMark,
} from "./ProvenanceMark";

describe("ProvenanceMark", () => {
  it("says the word for every kind", () => {
    // The distinction is the platform's whole claim. It is never carried by a
    // glyph alone, and never by a colour at all.
    renderSurface(
      <p>
        {PROVENANCE_KINDS.map((kind) => (
          <ProvenanceMark key={kind} kind={kind} />
        ))}
      </p>,
    );

    for (const kind of PROVENANCE_KINDS) {
      expect(screen.getByText(PROVENANCE_WORDS[kind])).toBeInTheDocument();
    }
  });

  it("carries a third channel in the data attribute the rule style keys off", () => {
    // Solid, dashed, dotted. The channel that still works when a scan of the
    // audit pack has lost the marks to compression.
    const { container } = renderSurface(<ProvenanceMark kind="computed" />);
    expect(container.querySelector(".pv-provenance")).toHaveAttribute("data-kind", "computed");
  });

  it("explains itself on request and stays quiet otherwise", () => {
    const quiet = renderSurface(<ProvenanceMark kind="asserted" />);
    expect(quiet.queryByText(PROVENANCE_MEANINGS.asserted)).toBeNull();

    renderSurface(<ProvenanceMark kind="asserted" describe />);
    expect(screen.getByText(PROVENANCE_MEANINGS.asserted)).toBeInTheDocument();
  });

  it("borrows no status tone", () => {
    // An asserted value is not a warning and a computed one is not a success.
    // Reusing the status palette here would teach the operator a meaning that
    // does not exist.
    const { container } = renderSurface(<ProvenanceMark kind="retrieved" />);
    const element = container.querySelector(".pv-provenance");
    expect(element?.getAttribute("style")).toBeNull();
  });

  it("has no accessibility violations in any kind or size", async () => {
    const { container } = renderSurface(
      <p>
        {PROVENANCE_KINDS.map((kind) => (
          <ProvenanceMark key={kind} kind={kind} size="md" describe />
        ))}
      </p>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
