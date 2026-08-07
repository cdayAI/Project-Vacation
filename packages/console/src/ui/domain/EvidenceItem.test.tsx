import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { EvidenceItem } from "./EvidenceItem";

const PASSAGE =
  "The purchaser may cancel the contract until midnight of the tenth calendar day.";

describe("EvidenceItem", () => {
  it("opens the passage in place rather than navigating away", async () => {
    // An approver who has to leave the screen to check a citation stops
    // checking citations — around item six of forty.
    const user = userEvent.setup();
    renderSurface(
      <EvidenceItem source="Florida Statutes §721.10" kind="retrieved" passage={PASSAGE} />,
    );

    const toggle = screen.getByRole("button", { name: /Florida Statutes §721.10/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(PASSAGE)).not.toBeVisible();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(PASSAGE)).toBeVisible();
  });

  it("is operable from the keyboard", async () => {
    const user = userEvent.setup();
    renderSurface(
      <EvidenceItem source="Florida Statutes §721.10" kind="retrieved" passage={PASSAGE} />,
    );

    await user.tab();
    const toggle = screen.getByRole("button", { name: /Florida Statutes §721.10/ });
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the version and the effective date beside the source", () => {
    // The question is never "what does the rule say", it is "what did the rule
    // say on the day we acted".
    renderSurface(
      <EvidenceItem
        source="Florida Statutes §721.10"
        version="rev 2025-07-01"
        effectiveDate="Effective 1 Jul 2025"
        kind="retrieved"
      />,
    );
    expect(screen.getByText("rev 2025-07-01")).toBeInTheDocument();
    expect(screen.getByText("Effective 1 Jul 2025")).toBeInTheDocument();
  });

  it("shows the provenance before anything is expanded", () => {
    renderSurface(<EvidenceItem source="Owner statement" kind="asserted" passage={PASSAGE} />);
    expect(screen.getByText("Asserted")).toBeInTheDocument();
  });

  it("quotes the passage as a quotation", () => {
    // The semantics are what tell a screen-reader user that these are somebody
    // else's words rather than the platform's summary of them.
    const { container } = renderSurface(
      <EvidenceItem
        source="Florida Statutes §721.10"
        kind="retrieved"
        passage={PASSAGE}
        href="/knowledge/fl-721-10"
        defaultExpanded
      />,
    );
    const quote = container.querySelector("blockquote");
    expect(quote).toHaveTextContent(PASSAGE);
    expect(quote).toHaveAttribute("cite", "/knowledge/fl-721-10");
  });

  it("warns that the source link leaves the screen", () => {
    renderSurface(
      <EvidenceItem
        source="Florida Statutes §721.10"
        kind="retrieved"
        passage={PASSAGE}
        href="/knowledge/fl-721-10"
        defaultExpanded
      />,
    );
    expect(
      screen.getByRole("link", { name: "Open the source (opens the full document)" }),
    ).toBeInTheDocument();
  });

  it("can be driven from outside for an expand-all control", async () => {
    const onExpandedChange = vi.fn();
    const user = userEvent.setup();
    renderSurface(
      <EvidenceItem
        source="Florida Statutes §721.10"
        kind="retrieved"
        passage={PASSAGE}
        expanded={false}
        onExpandedChange={onExpandedChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Florida Statutes §721.10/ }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    // Controlled means controlled: the item does not move until the caller says so.
    expect(screen.getByText(PASSAGE)).not.toBeVisible();
  });

  it("offers no disclosure when there is no passage to show", () => {
    renderSurface(<EvidenceItem source="Computed from the contract" kind="computed" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Computed from the contract")).toBeInTheDocument();
  });

  it("drops its actions when read-only", () => {
    renderSurface(
      <EvidenceItem
        source="Florida Statutes §721.10"
        kind="retrieved"
        readOnly
        actions={<button type="button">Flag as wrong</button>}
      />,
    );
    expect(screen.queryByRole("button", { name: "Flag as wrong" })).toBeNull();
  });

  it("has no accessibility violations in either state", async () => {
    const { container } = renderSurface(
      <>
        <EvidenceItem
          source="Florida Statutes §721.10"
          version="rev 2025-07-01"
          effectiveDate="Effective 1 Jul 2025"
          kind="retrieved"
          summary="Sets the rescission window at ten calendar days."
          passage={PASSAGE}
          href="/knowledge/fl-721-10"
          defaultExpanded
        />
        <EvidenceItem source="Owner statement, 12 Jun" kind="asserted" passage={PASSAGE} />
        <EvidenceItem source="Window closes 22 Jun" kind="computed" readOnly />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });
});
