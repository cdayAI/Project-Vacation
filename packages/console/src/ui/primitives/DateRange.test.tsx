import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { DateRange, daysBetween, describeRange, type DateRangeValue } from "./DateRange";

function Harness({
  initial = { start: null, end: null },
  ...rest
}: {
  readonly initial?: DateRangeValue;
  readonly readOnly?: boolean;
  readonly min?: string;
  readonly max?: string;
  readonly label?: string;
}) {
  const [value, setValue] = useState<DateRangeValue>(initial);
  const { label = "Date range", ...others } = rest;
  return <DateRange label={label} value={value} onChange={setValue} {...others} />;
}

describe("DateRange", () => {
  it("carries no accessibility violations in any of its states", async () => {
    const { container } = renderSurface(
      <>
        <Harness />
        <Harness initial={{ start: "2026-06-12", end: "2026-06-25" }} />
        <Harness label="Inverted" initial={{ start: "2026-06-25", end: "2026-06-12" }} />
        <Harness label="Locked" initial={{ start: "2026-06-12", end: "2026-06-25" }} readOnly />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("is one question with two answers", () => {
    renderSurface(<Harness />);
    const group = screen.getByRole("group", { name: "Date range" });
    expect(group).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("To")).toBeInTheDocument();
  });

  it("writes out the span, which is the number the decision turns on", () => {
    renderSurface(<Harness initial={{ start: "2026-06-12", end: "2026-06-25" }} />);
    expect(screen.getByText("14 days, 12 Jun 2026 to 25 Jun 2026.")).toBeInTheDocument();
  });

  it("says which end is missing rather than showing nothing", () => {
    renderSurface(<Harness initial={{ start: "2026-06-12", end: null }} />);
    expect(screen.getByText("From 12 Jun 2026, with no end date.")).toBeInTheDocument();
  });

  it("names both dates when the end is before the start", () => {
    renderSurface(<Harness initial={{ start: "2026-06-25", end: "2026-06-12" }} />);
    expect(
      screen.getByText(/12 Jun 2026 comes before 25 Jun 2026 — swap them, or change one\./),
    ).toBeInTheDocument();
  });

  it("holds each end inside the other, so the calendar cannot offer an impossible day", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness initial={{ start: "2026-06-12", end: "2026-06-25" }} />);

    const triggers = screen.getAllByRole("button", { name: "Choose a date from the calendar" });
    await user.click(triggers[1] as HTMLElement);
    // The end calendar cannot offer a day before the start.
    expect(screen.getByRole("button", { name: "11 June 2026" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "13 June 2026" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("takes typed dates at either end", async () => {
    const user = userEvent.setup();
    renderSurface(<Harness />);
    await user.type(screen.getByLabelText("From"), "1 Jun 2026");
    await user.type(screen.getByLabelText("To"), "30 Jun 2026");
    expect(screen.getByText("30 days, 1 Jun 2026 to 30 Jun 2026.")).toBeInTheDocument();
  });

  it("reads as two read-only values with one marker on the question", () => {
    renderSurface(
      <Harness label="Recorded" initial={{ start: "2026-06-12", end: "2026-06-25" }} readOnly />,
    );
    expect(screen.getByLabelText("From")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("To")).toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: "Choose a date from the calendar" }),
    ).not.toBeInTheDocument();
  });
});

describe("daysBetween", () => {
  it("counts both ends, so one day is one day", () => {
    expect(daysBetween("2026-06-12", "2026-06-12")).toBe(1);
    expect(daysBetween("2026-06-12", "2026-06-13")).toBe(2);
  });

  it("counts across a month and a year boundary", () => {
    expect(daysBetween("2026-06-25", "2026-07-02")).toBe(8);
    expect(daysBetween("2026-12-30", "2027-01-02")).toBe(4);
  });

  it("counts across a daylight-saving change without losing an hour", () => {
    // Built from UTC parts on purpose: a range that spans a clock change is
    // 23 or 25 hours long in local time, and dividing that by 86,400,000 would
    // silently drop or add a day.
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(3);
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(3);
  });
});

describe("describeRange", () => {
  it("says nothing when there is nothing to say", () => {
    expect(describeRange({ start: null, end: null })).toBeUndefined();
  });

  it("uses the singular for a single day", () => {
    expect(describeRange({ start: "2026-06-12", end: "2026-06-12" })).toBe(
      "1 day, 12 Jun 2026 to 12 Jun 2026.",
    );
  });

  it("stays quiet about an inverted range, which the error already covers", () => {
    expect(describeRange({ start: "2026-06-25", end: "2026-06-12" })).toBeUndefined();
  });
});
