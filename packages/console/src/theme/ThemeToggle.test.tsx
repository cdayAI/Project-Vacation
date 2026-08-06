import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setSystemPrefersDark } from "../test/media";
import { ThemeProvider } from "./ThemeProvider";
import { ThemeToggle } from "./ThemeToggle";

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe("ThemeToggle", () => {
  it("announces its state through aria-pressed rather than only through colour", () => {
    renderToggle();
    const toggle = screen.getByRole("button", { name: /dark theme/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("follows the system preference until the operator chooses", () => {
    setSystemPrefersDark(true);
    renderToggle();

    expect(screen.getByRole("button", { name: /dark theme/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // No explicit choice yet, so the attribute stays off the root element and
    // the media query in tokens.css governs.
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("lets an explicit dark choice win over a light system preference", async () => {
    const user = userEvent.setup();
    setSystemPrefersDark(false);
    renderToggle();

    await user.click(screen.getByRole("button", { name: /dark theme/i }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: /dark theme/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("lets an explicit light choice win over a dark system preference", async () => {
    const user = userEvent.setup();
    setSystemPrefersDark(true);
    renderToggle();

    await user.click(screen.getByRole("button", { name: /dark theme/i }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(screen.getByRole("button", { name: /dark theme/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("persists the choice", async () => {
    const user = userEvent.setup();
    renderToggle();

    await user.click(screen.getByRole("button", { name: /dark theme/i }));
    expect(window.localStorage.getItem("pv.console.theme")).toBe("dark");
  });

  it("restores a persisted choice on the next visit", () => {
    window.localStorage.setItem("pv.console.theme", "dark");
    renderToggle();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: /dark theme/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reacts to the system preference changing while no choice is stored", () => {
    renderToggle();
    expect(screen.getByRole("button", { name: /dark theme/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    act(() => setSystemPrefersDark(true));

    expect(screen.getByRole("button", { name: /dark theme/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
