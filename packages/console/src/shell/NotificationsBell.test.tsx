import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { NotificationsBell, type ShellNotification } from "./NotificationsBell";

const NOTIFICATIONS: readonly ShellNotification[] = [
  {
    id: "n1",
    title: "Approval 4182 has been waiting two hours.",
    detail: "State rescission notice · high risk · policy R-14.",
    when: "2h ago",
    unread: true,
    tone: "warning",
    toneWord: "Ageing",
  },
  {
    id: "n2",
    title: "Run run_01k3r2m8k5 failed at the document step.",
    when: "09:41",
    unread: false,
  },
];

describe("the notifications bell", () => {
  it("spells the count out in its name, not only in a badge", () => {
    // A badge is a visual affordance. A screen-reader user hears the name, and
    // a bare "3" beside a glyph tells them nothing.
    renderSurface(<NotificationsBell notifications={NOTIFICATIONS} />);
    expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeInTheDocument();
  });

  it("draws no badge at all when nothing is unread", () => {
    // An empty badge, a dash, or a grey nought all read as "something is here".
    const { container } = renderSurface(<NotificationsBell notifications={[]} />);
    expect(container.querySelector(".pv-bell-count")).toBeNull();
    expect(screen.getByRole("button", { name: "Notifications, nothing unread" })).toBeInTheDocument();
  });

  it("caps the badge rather than letting a number widen the top bar", () => {
    const many = Array.from({ length: 14 }, (_unused, index) => ({
      id: `n${index}`,
      title: `Something ${index}`,
      when: "now",
      unread: true,
    }));
    renderSurface(<NotificationsBell notifications={many} />);
    expect(screen.getByText("9+")).toBeInTheDocument();
    // The exact number survives in the accessible name.
    expect(screen.getByRole("button", { name: "Notifications, 14 unread" })).toBeInTheDocument();
  });

  it("lists what happened, when, and what it means", async () => {
    const user = userEvent.setup();
    renderSurface(<NotificationsBell notifications={NOTIFICATIONS} />);
    await user.click(screen.getByRole("button", { name: /Notifications/ }));

    const panel = within(screen.getByRole("dialog"));
    expect(panel.getByText("Approval 4182 has been waiting two hours.")).toBeInTheDocument();
    expect(panel.getByText("State rescission notice · high risk · policy R-14.")).toBeInTheDocument();
    expect(panel.getByText("2h ago")).toBeInTheDocument();
  });

  it("marks an unread item with a word as well as a mark", async () => {
    const user = userEvent.setup();
    renderSurface(<NotificationsBell notifications={NOTIFICATIONS} />);
    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(screen.getByText("Unread")).toBeInTheDocument();
  });

  it("names a tone in words beside its colour", async () => {
    const user = userEvent.setup();
    renderSurface(<NotificationsBell notifications={NOTIFICATIONS} />);
    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(screen.getByText("Ageing")).toBeInTheDocument();
  });

  it("draws a designed empty state on a healthy morning", async () => {
    const user = userEvent.setup();
    renderSurface(<NotificationsBell />);
    await user.click(screen.getByRole("button", { name: /Notifications/ }));

    expect(screen.getByText("Nothing new.")).toBeInTheDocument();
    expect(screen.getByText(/a digest of the day lands at 9:00/i)).toBeInTheDocument();
  });

  it("opens an item and closes itself", async () => {
    const user = userEvent.setup();
    const onOpenNotification = vi.fn();
    renderSurface(
      <NotificationsBell notifications={NOTIFICATIONS} onOpenNotification={onOpenNotification} />,
    );
    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    await user.click(within(screen.getByRole("dialog")).getAllByRole("button", { name: "Open" })[0]!);

    expect(onOpenNotification).toHaveBeenCalledWith(NOTIFICATIONS[0]);
  });

  it("closes on Escape and gives focus back to the bell", async () => {
    const user = userEvent.setup();
    renderSurface(<NotificationsBell notifications={NOTIFICATIONS} />);
    const bell = screen.getByRole("button", { name: /Notifications/ });
    await user.click(bell);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bell).toHaveFocus();
  });

  it("has no accessibility violations closed", async () => {
    const { container } = renderSurface(<NotificationsBell notifications={NOTIFICATIONS} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations open", async () => {
    const user = userEvent.setup();
    const { baseElement } = renderSurface(<NotificationsBell notifications={NOTIFICATIONS} />);
    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    await expectNoAccessibilityViolations(baseElement);
  });

  it("has no accessibility violations in its empty state", async () => {
    const user = userEvent.setup();
    const { baseElement } = renderSurface(<NotificationsBell />);
    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    await expectNoAccessibilityViolations(baseElement);
  });
});
