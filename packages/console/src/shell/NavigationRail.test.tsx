import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ZONES, visibleZones } from "../routes";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { auditorSession, session } from "../test/fixtures";
import { NavigationRail } from "./NavigationRail";

function mount(options: { readonly collapsed?: boolean; readonly forSession?: typeof session | null } = {}) {
  return renderSurface(
    <NavigationRail
      zones={visibleZones(options.forSession === undefined ? session : options.forSession)}
      collapsed={options.collapsed ?? false}
      surfaceClassName="pv-glass"
    />,
  );
}

describe("the navigation rail", () => {
  it("names itself Primary", () => {
    mount();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("holds the four zones in the order specification §2 fixes them", () => {
    mount();
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["Work", "Oversight", "Improve", "Admin"]);
  });

  it("puts the day's work first and the quarterly configuration last", () => {
    // Not alphabetical and not by size: the order of the day. An operator whose
    // whole job is the first zone never scrolls past the fourth.
    expect(ZONES.map((zone) => zone.id)).toEqual(["work", "oversight", "improve", "admin"]);
  });

  it("groups each zone's items under its heading", () => {
    mount();
    const work = screen.getByRole("list", { name: "Work" });
    expect(within(work).getByRole("link", { name: "Work queue" })).toBeInTheDocument();
    expect(within(work).getByRole("link", { name: "Approvals" })).toBeInTheDocument();
  });

  it("drops a zone this role cannot use anything in, rather than drawing an empty heading", () => {
    // The auditor sees everything and changes nothing: containment is not
    // theirs, and a heading over nothing is a promise the console cannot keep.
    const zones = visibleZones(auditorSession);
    for (const zone of zones) expect(zone.items.length).toBeGreaterThan(0);
  });

  it("marks the current item, and marks it with more than a colour", () => {
    window.history.replaceState(null, "", "/approvals");
    mount();
    const current = screen.getByRole("link", { name: "Approvals" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Work queue" })).not.toHaveAttribute("aria-current");
  });

  it("marks the section as current while a detail route under it is open", () => {
    window.history.replaceState(null, "", "/approvals/apr_4182");
    mount();
    expect(screen.getByRole("link", { name: "Approvals" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps every link named when it is collapsed to icons", () => {
    // The label is moved, not removed: at 64px it is still in the
    // accessibility tree, so the rail is as usable to a screen reader
    // collapsed as it is expanded.
    mount({ collapsed: true });
    expect(screen.getByRole("link", { name: "Work queue" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Admin" })).toBeInTheDocument();
  });

  it("says it is collapsed, so the stylesheet has something to answer", () => {
    mount({ collapsed: true });
    expect(screen.getByRole("navigation", { name: "Primary" })).toHaveAttribute(
      "data-collapsed",
      "true",
    );
  });

  it("carries the design gallery, which needs no capability to reach", () => {
    // It holds no operating data, and it is how a designer or a reviewer
    // checks the system without an account that can see owner records.
    mount({ forSession: auditorSession });
    expect(screen.getByRole("link", { name: "Design system" })).toHaveAttribute("href", "/design");
  });

  it("shows every zone before the session has loaded", () => {
    // Hiding a link the operator can in fact use costs them their job with no
    // clue why. Erring toward showing costs one clear refusal screen.
    mount({ forSession: null });
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(4);
  });

  it("has no accessibility violations", async () => {
    const { container } = mount();
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations while collapsed", async () => {
    const { container } = mount({ collapsed: true });
    await expectNoAccessibilityViolations(container);
  });
});
