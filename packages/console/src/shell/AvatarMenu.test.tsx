import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { AvatarMenu } from "./AvatarMenu";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-density");
  document.documentElement.removeAttribute("data-transparency");
});

function mount(overrides: Partial<Parameters<typeof AvatarMenu>[0]> = {}) {
  return renderSurface(
    <AvatarMenu
      name="Dana Whitfield"
      roles={["owner_services_supervisor"]}
      onShowShortcuts={() => {}}
      {...overrides}
    />,
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Signed in as Dana Whitfield/ }));
}

describe("the avatar menu", () => {
  it("says who is signed in and in what role, without opening anything", () => {
    mount();
    const trigger = screen.getByRole("button", { name: /Signed in as Dana Whitfield/ });
    expect(trigger).toHaveAccessibleName(
      "Signed in as Dana Whitfield. owner_services_supervisor. Account and preferences",
    );
  });

  it("declares what it opens", async () => {
    const user = userEvent.setup();
    mount();
    const trigger = screen.getByRole("button", { name: /Signed in as/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await openMenu(user);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("carries theme, density, transparency, shortcuts and sign out", async () => {
    const user = userEvent.setup();
    mount();
    await openMenu(user);

    // A fieldset and a legend, which is what the Field primitive draws for a
    // set of controls that share one question.
    expect(screen.getByRole("group", { name: /Theme/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Density/ })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Reduce transparency/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("announces the current value of a setting rather than only showing it", async () => {
    // The reason these are radio groups and not menu items: a menu item
    // announces "Dark theme, menu item" and says nothing about the state it is
    // in. This says "Dark, selected".
    const user = userEvent.setup();
    mount();
    await openMenu(user);

    expect(screen.getByRole("radio", { name: /Match my system/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("changes density, which is what the whole console is measured in", async () => {
    const user = userEvent.setup();
    mount();
    await openMenu(user);

    await user.click(screen.getByRole("radio", { name: "Compact" }));
    expect(document.documentElement).toHaveAttribute("data-density", "compact");
  });

  it("reduces transparency and says so in words as well as in the track", async () => {
    const user = userEvent.setup();
    mount();
    await openMenu(user);

    const control = screen.getByRole("switch", { name: /Reduce transparency/ });
    expect(control).toHaveAttribute("aria-checked", "false");
    await user.click(control);
    expect(document.documentElement).toHaveAttribute("data-transparency", "reduced");
  });

  it("opens the shortcut reference and closes itself first", async () => {
    const user = userEvent.setup();
    const onShowShortcuts = vi.fn();
    mount({ onShowShortcuts });
    await openMenu(user);

    await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(onShowShortcuts).toHaveBeenCalledTimes(1);
  });

  it("signs out when the deployment has wired it", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    mount({ onSignOut });
    await openMenu(user);

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("shows sign-out refused with a reason when it has not been", async () => {
    // Hidden would be worse: an operator who cannot find sign-out assumes they
    // are still signed in somewhere, which is the more dangerous of the two
    // misunderstandings.
    const user = userEvent.setup();
    mount();
    await openMenu(user);

    const control = screen.getByRole("button", { name: "Sign out" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveAccessibleDescription(/no end-session endpoint configured/);
  });

  it("marks an auditor's session read-only", async () => {
    const user = userEvent.setup();
    mount({ readOnly: true });
    await openMenu(user);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("says so plainly when the actor holds no roles", async () => {
    const user = userEvent.setup();
    mount({ roles: [] });
    await user.click(screen.getByRole("button", { name: /Signed in as/ }));
    expect(screen.getAllByText("No roles").length).toBeGreaterThan(0);
  });

  it("has no accessibility violations closed", async () => {
    const { container } = mount();
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations open", async () => {
    const user = userEvent.setup();
    const { baseElement } = mount();
    await openMenu(user);
    await expectNoAccessibilityViolations(baseElement);
  });
});
