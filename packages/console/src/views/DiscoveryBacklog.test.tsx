import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { discoveryCandidates } from "../test/fixtures";
import { DiscoveryBacklog } from "./DiscoveryBacklog";

describe("DiscoveryBacklog", () => {
  describe("when the feature is disabled", () => {
    it("explains why it ships off rather than showing an empty table", () => {
      renderSurface(<DiscoveryBacklog enabled={false} candidates={[]} />);

      // Both roles: the table this page must not show would be a `grid` now,
      // and a plain `table` must not appear either.
      expect(screen.queryByRole("grid")).not.toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(
        screen.getByText("This feature is built, and it ships disabled"),
      ).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Why it is off" })).toBeInTheDocument();
    });

    it("names the obligations that are unanswered", () => {
      renderSurface(<DiscoveryBacklog enabled={false} candidates={[]} />);

      expect(
        screen.getByText(/require advance written notice of electronic monitoring/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/works-council consultation and data-protection obligations/),
      ).toBeInTheDocument();
      expect(screen.getByText(/Union agreements and collective agreements/)).toBeInTheDocument();
    });

    it("says what is in place for when it is switched on", () => {
      renderSurface(<DiscoveryBacklog enabled={false} candidates={[]} />);

      expect(screen.getByText("Three independent gates.")).toBeInTheDocument();
      expect(screen.getByText("Structural exclusions, not settings.")).toBeInTheDocument();
      expect(screen.getByText("No egress.")).toBeInTheDocument();
      expect(screen.getByText("Output is inert.")).toBeInTheDocument();
    });

    it("offers no control of any kind", () => {
      renderSurface(<DiscoveryBacklog enabled={false} candidates={[]} />);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    });

    it("has no accessibility violations", async () => {
      const { container } = renderSurface(<DiscoveryBacklog enabled={false} candidates={[]} />);
      await expectNoAccessibilityViolations(container);
    });
  });

  describe("when the feature is enabled", () => {
    it("says loudly that somebody switched it on", () => {
      renderSurface(<DiscoveryBacklog enabled candidates={discoveryCandidates} />);

      expect(screen.getByText("Work discovery is switched on")).toBeInTheDocument();
      expect(
        screen.getByText(/somebody enabled it deliberately/),
      ).toBeInTheDocument();
    });

    it("renders every candidate as a draft", () => {
      renderSurface(<DiscoveryBacklog enabled candidates={discoveryCandidates} />);

      expect(screen.getAllByText("Draft only")).toHaveLength(discoveryCandidates.length);
      expect(
        screen.getByText(
          /Copying maintenance-fee arrears totals from the association ledger/,
        ),
      ).toBeInTheDocument();
    });

    it("states that the output is inert and must go through normal governance", () => {
      renderSurface(<DiscoveryBacklog enabled candidates={discoveryCandidates} />);

      expect(screen.getByText("Everything below is inert")).toBeInTheDocument();
      expect(
        screen.getByText(/there is no activation control on this page/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/going through the same governance as everything else/),
      ).toBeInTheDocument();
    });

    it("offers no activation control of any kind", () => {
      const { container } = renderSurface(
        <DiscoveryBacklog enabled candidates={discoveryCandidates} />,
      );

      // Every button on this screen belongs to the table's own view controls:
      // a sort control, or the column chooser. Both change what this operator
      // is looking at; neither activates a candidate, and no ordering of a
      // list has ever started a run.
      //
      // Matched on what each control announces rather than on a class name. An
      // activation control could be given any class; it could not pass this
      // without telling a screen-reader user it sorts a column.
      const buttons = screen.queryAllByRole("button");
      expect(buttons.length).toBeGreaterThan(0);

      const columnChoosers = buttons.filter((button) => button.textContent === "Columns");
      const sortControls = buttons.filter((button) =>
        /, (not sorted|sorted (ascending|descending))\. Activate to sort (ascending|descending)\.$/.test(
          button.textContent ?? "",
        ),
      );

      // One chooser, one table — and the two kinds account for every button on
      // the screen, so a third kind cannot arrive unnoticed.
      expect(columnChoosers).toHaveLength(1);
      expect(columnChoosers.length + sortControls.length).toBe(buttons.length);

      // The table also says in words that it is read-only, which is the claim
      // this whole screen is making.
      expect(screen.getByText("Read-only")).toBeInTheDocument();

      // And there is nothing else that could submit anything either.
      expect(container.querySelectorAll("form")).toHaveLength(0);
      expect(container.querySelectorAll("input, select, textarea")).toHaveLength(0);
    });

    it("labels the hours figure as arithmetic rather than as a measured saving", () => {
      renderSurface(<DiscoveryBacklog enabled candidates={discoveryCandidates} />);

      expect(
        screen.getByText(/The estimate is arithmetic on observed counts, not a measured saving\./),
      ).toBeInTheDocument();
    });

    it("says so when discovery is running but has seen no pattern", () => {
      renderSurface(<DiscoveryBacklog enabled candidates={[]} />);

      expect(
        screen.getByRole("heading", { name: "Nothing has been observed often enough to list" }),
      ).toBeInTheDocument();
    });

    it("has no accessibility violations", async () => {
      const { container } = renderSurface(
        <DiscoveryBacklog enabled candidates={discoveryCandidates} />,
      );
      await expectNoAccessibilityViolations(container);
    });

    it("has no accessibility violations with no candidates", async () => {
      const { container } = renderSurface(<DiscoveryBacklog enabled candidates={[]} />);
      await expectNoAccessibilityViolations(container);
    });
  });
});
