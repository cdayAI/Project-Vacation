import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { containmentClear, containmentGlobalPaused, spendCeilingDenial } from "../test/fixtures";
import { ContainmentControls } from "./ContainmentControls";

describe("ContainmentControls", () => {
  it("states the global state unambiguously when nothing is stopped", () => {
    renderSurface(<ContainmentControls switches={containmentClear} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "The platform is running" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stop everything/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Release the global pause" })).not.toBeInTheDocument();
  });

  it("states the global state unambiguously when everything is stopped", () => {
    renderSurface(<ContainmentControls switches={containmentGlobalPaused} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Everything is stopped" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/will take no action of any kind until an operator releases it/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Release the global pause" }),
    ).toBeInTheDocument();
    // Who stopped it and why, without going to the audit log for it. Stated in
    // the panel and again in the switch table.
    expect(
      screen.getAllByText(
        "Statutory rules corpus republished mid-quarter; stopping until it is re-verified.",
      ),
    ).toHaveLength(2);
  });

  it("lists what else is stopped, so an operator does not release the wrong thing", () => {
    renderSurface(<ContainmentControls switches={containmentGlobalPaused} />);

    expect(screen.getByText("2 things are stopped individually")).toBeInTheDocument();
    expect(
      screen.getByText(/Releasing the global pause does not release anything else/),
    ).toBeInTheDocument();
  });

  it("makes the global pause an explicit confirmation that says what it stops", async () => {
    const user = userEvent.setup();
    renderSurface(<ContainmentControls switches={containmentClear} />);

    await user.click(screen.getByRole("button", { name: /Stop everything/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Stop everything?");
    expect(within(dialog).getByText("This stops the whole platform")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/only compensating steps are allowed to finish/),
    ).toBeInTheDocument();
  });

  it("requires a typed reason before anything is engaged", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<ContainmentControls switches={containmentClear} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Stop everything/ }));
    await user.click(screen.getByRole("button", { name: "Stop everything now" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Say why\./)).toBeInTheDocument();
    // The dialog stays open so the operator can supply it without starting over.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("engages the global pause in one confirmation once a reason is given", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<ContainmentControls switches={containmentClear} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Stop everything/ }));
    await user.type(
      screen.getByLabelText("Why are you doing this?"),
      "Rules corpus republished without review.",
    );
    await user.click(screen.getByRole("button", { name: "Stop everything now" }));

    expect(onChange).toHaveBeenCalledWith({
      scope: "global",
      target: "",
      engaged: true,
      reason: "Rules corpus republished without review.",
    });
  });

  it("requires a reason to release as well as to engage", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<ContainmentControls switches={containmentGlobalPaused} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Release the global pause" }));
    await user.type(screen.getByLabelText("Why are you doing this?"), "Corpus re-verified.");
    await user.click(screen.getByRole("button", { name: "Release it now" }));

    expect(onChange).toHaveBeenCalledWith({
      scope: "global",
      target: "",
      engaged: false,
      reason: "Corpus re-verified.",
    });
  });

  it("stops one named thing that has never been stopped before", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<ContainmentControls switches={containmentClear} onChange={onChange} />);

    await user.selectOptions(screen.getByLabelText("What kind of thing"), "role");
    await user.type(screen.getByLabelText("Its name"), "role_owner_services_drafting");
    await user.click(screen.getByRole("button", { name: "Stop it" }));
    await user.type(screen.getByLabelText("Why are you doing this?"), "Below threshold since v7.");
    await user.click(screen.getByRole("button", { name: "Stop it now" }));

    expect(onChange).toHaveBeenCalledWith({
      scope: "role",
      target: "role_owner_services_drafting",
      engaged: true,
      reason: "Below threshold since v7.",
    });
  });

  it("refuses to submit an unnamed target", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSurface(<ContainmentControls switches={containmentClear} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Stop it" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Name what you want to stop.")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows every switch on record with its state in words", () => {
    const { container } = renderSurface(
      <ContainmentControls switches={containmentGlobalPaused} />,
    );

    const table = screen.getByRole("table", { name: /Containment switches/ });
    expect(within(table).getAllByRole("row")).toHaveLength(5); // header plus four
    expect(within(table).getAllByText("Stopped")).toHaveLength(3);
    expect(within(table).getAllByText("Running")).toHaveLength(1);
    // A second channel for a sighted operator scanning the table.
    expect(container.querySelectorAll("tr.pv-row-denied")).toHaveLength(3);
  });

  it("renders a refused change as an outcome, not as a red error", () => {
    renderSurface(
      <ContainmentControls switches={containmentClear} changeDenial={spendCeilingDenial} />,
    );

    expect(
      screen.getByRole("heading", { name: "Refused: changing a containment switch" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ceiling.spend_exceeded")).toBeInTheDocument();
  });

  it("says a change failed without claiming anything happened", () => {
    renderSurface(
      <ContainmentControls switches={containmentClear} changeError="The console could not reach the platform API." />,
    );

    expect(screen.getByText("The change was not recorded")).toBeInTheDocument();
    expect(screen.getByText(/Nothing changed\./)).toBeInTheDocument();
  });

  it("explains an unavailable control instead of hiding it", () => {
    renderSurface(<ContainmentControls switches={containmentClear} mayEngage={false} />);

    const stop = screen.getByRole("button", { name: /Stop everything/ });
    expect(stop).toHaveAttribute("aria-disabled", "true");
    expect(stop).toHaveAttribute("aria-describedby", "containment-not-permitted");
    expect(
      screen.getByText(/This is a courtesy of the console, not a control/),
    ).toBeInTheDocument();
  });

  it("says so when no switch has ever been set", () => {
    renderSurface(<ContainmentControls switches={[]} />);

    expect(
      screen.getByText("No switch has ever been set. Nothing is stopped."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<ContainmentControls switches={containmentClear} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations while everything is stopped", async () => {
    const { container } = renderSurface(
      <ContainmentControls switches={containmentGlobalPaused} />,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations with the confirmation dialog open", async () => {
    const user = userEvent.setup();
    const { container } = renderSurface(<ContainmentControls switches={containmentClear} />);

    await user.click(screen.getByRole("button", { name: /Stop everything/ }));

    await expectNoAccessibilityViolations(container);
  });
});
