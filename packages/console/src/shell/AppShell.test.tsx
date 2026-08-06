import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { KeyboardProvider } from "../keyboard/KeyboardProvider";
import { ROUTES, breadcrumbFor, visibleZones } from "../routes";
import { ThemeProvider } from "../theme/ThemeProvider";
import { expectNoAccessibilityViolations } from "../test/axe";
import { session } from "../test/fixtures";
import { AppShell, useShellLayout } from "./AppShell";
import { SHELL_STORAGE_KEYS } from "./shellPreferences";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-density");
});

function Frame({
  routeId = "work",
  children = <h1>Work queue</h1>,
  contextPanel,
}: {
  readonly routeId?: string;
  readonly children?: ReactNode;
  readonly contextPanel?: ReactNode;
}) {
  const mainRef = useRef<HTMLElement | null>(null);
  const route = ROUTES.find((entry) => entry.id === routeId) ?? null;

  return (
    <ThemeProvider>
      <KeyboardProvider>
        <AppShell
          zones={visibleZones(session)}
          breadcrumb={breadcrumbFor(route, {})}
          routeId={routeId}
          actorName={session.actor.displayName}
          actorRoles={session.actor.roles}
          mainRef={mainRef}
          {...(contextPanel === undefined ? {} : { contextPanel })}
        >
          {children}
        </AppShell>
      </KeyboardProvider>
    </ThemeProvider>
  );
}

describe("the app shell", () => {
  it("puts a skip link first, so one press reaches the content", () => {
    render(<Frame />);
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveAttribute("href", "#main-content");
    expect(document.querySelector("a")).toBe(skip);
  });

  it("exposes exactly one main landmark", () => {
    render(<Frame />);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("carries the banner outside main, so a route change does not re-announce it", () => {
    render(
      <ThemeProvider>
        <KeyboardProvider>
          <Shell banner={<p>The execution sandbox is not contained.</p>} />
        </KeyboardProvider>
      </ThemeProvider>,
    );
    const banner = screen.getByText("The execution sandbox is not contained.");
    expect(screen.getByRole("main").contains(banner)).toBe(false);
  });

  it("draws the top bar, the rail, and the context panel", () => {
    render(<Frame />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    // The panel names what it is showing; with no route content given it falls
    // back to the neutral heading rather than to nothing.
    expect(screen.getByRole("heading", { name: /Context/, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Work queue" })).toBeInTheDocument();
  });

  describe("the command palette", () => {
    it("opens on the palette chord and closes on Escape, giving focus back", async () => {
      const user = userEvent.setup();
      render(<Frame />);
      const trigger = screen.getByRole("button", { name: "Search or run a command" });

      await user.keyboard("{Control>}k{/Control}");
      const field = await screen.findByRole("combobox", {
        name: "Search actions, records and saved views",
      });
      await waitFor(() => expect(field).toHaveFocus());

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();
    });

    it("opens from the trigger as well as from the keyboard", async () => {
      const user = userEvent.setup();
      render(<Frame />);
      await user.click(screen.getByRole("button", { name: "Search or run a command" }));
      expect(
        await screen.findByRole("combobox", { name: "Search actions, records and saved views" }),
      ).toBeInTheDocument();
    });

    it("offers every navigation item, so everything reachable by mouse is reachable here", async () => {
      const user = userEvent.setup();
      render(<Frame />);
      await user.keyboard("{Control>}k{/Control}");
      const field = await screen.findByRole("combobox");

      await user.type(field, "audit");
      expect(screen.getByRole("option", { name: /Audit and evidence/ })).toBeInTheDocument();
    });

    it("navigates from the palette", async () => {
      const user = userEvent.setup();
      render(<Frame />);
      await user.keyboard("{Control>}k{/Control}");
      const field = await screen.findByRole("combobox");

      await user.type(field, "audit and evidence");
      await user.keyboard("{Enter}");
      expect(window.location.pathname).toBe("/audit");
    });

    it("offers the console's own preferences as commands", async () => {
      const user = userEvent.setup();
      render(<Frame />);
      await user.keyboard("{Control>}k{/Control}");
      const field = await screen.findByRole("combobox");

      await user.type(field, "compact");
      await user.keyboard("{Enter}");
      expect(document.documentElement).toHaveAttribute("data-density", "compact");
    });
  });

  describe("the keyboard model", () => {
    it("goes to the queue on G then Q", async () => {
      const user = userEvent.setup();
      window.history.replaceState(null, "", "/audit");
      render(<Frame routeId="audit" />);

      await user.keyboard("gq");
      expect(window.location.pathname).toBe("/work");
    });

    it("goes to approvals on G then A", async () => {
      const user = userEvent.setup();
      render(<Frame />);
      await user.keyboard("ga");
      expect(window.location.pathname).toBe("/approvals");
    });

    it("goes to evidence on G then E", async () => {
      const user = userEvent.setup();
      render(<Frame />);
      await user.keyboard("ge");
      expect(window.location.pathname).toBe("/audit");
    });

    it("lands G then S on the first administration surface this role can open", async () => {
      // The console has no single settings screen — configuration lives across
      // the Admin zone — so the verb goes somewhere real rather than nowhere.
      const user = userEvent.setup();
      render(<Frame />);
      await user.keyboard("gs");
      expect(window.location.pathname).toBe("/roles");
    });

    it("opens the shortcut reference on ?", async () => {
      const user = userEvent.setup();
      render(<Frame />);
      await user.keyboard("?");
      expect(
        await screen.findByRole("heading", { name: "Keyboard shortcuts" }),
      ).toBeInTheDocument();
    });

    it("puts the cursor in the copilot on C", async () => {
      const user = userEvent.setup();
      render(<Frame contextPanel={<textarea aria-label="Ask the copilot" />} />);

      await user.keyboard("c");
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "Ask the copilot" })).toHaveFocus(),
      );
    });

    it("opens the copilot's panel first when it is closed", async () => {
      const user = userEvent.setup();
      render(<Frame contextPanel={<textarea aria-label="Ask the copilot" />} />);

      await user.click(screen.getByRole("button", { name: "Hide the context panel" }));
      expect(screen.queryByRole("textbox", { name: "Ask the copilot" })).not.toBeInTheDocument();

      await user.keyboard("c");
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "Ask the copilot" })).toHaveFocus(),
      );
    });

    it("fires nothing while the operator is typing in the content", async () => {
      const user = userEvent.setup();
      render(
        <Frame>
          <>
            <h1>Work queue</h1>
            <label htmlFor="reason">Reason</label>
            <input id="reason" />
          </>
        </Frame>,
      );

      await user.click(screen.getByLabelText("Reason"));
      await user.keyboard("go again, case c");
      expect(window.location.pathname).not.toBe("/approvals");
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Reason")).toHaveValue("go again, case c");
    });
  });

  describe("what the shell remembers", () => {
    it("keeps the rail collapsed for this operator", async () => {
      const user = userEvent.setup();
      render(<Frame />);

      await user.click(screen.getByRole("button", { name: "Collapse navigation" }));
      expect(window.localStorage.getItem(SHELL_STORAGE_KEYS.rail)).toBe("true");
      expect(screen.getByRole("navigation", { name: "Primary" })).toHaveAttribute(
        "data-collapsed",
        "true",
      );
    });

    it("starts collapsed when that is what the operator left it as", () => {
      window.localStorage.setItem(SHELL_STORAGE_KEYS.rail, "true");
      render(<Frame />);
      expect(screen.getByRole("navigation", { name: "Primary" })).toHaveAttribute(
        "data-collapsed",
        "true",
      );
    });

    it("keeps the context panel's state per route, not per console", async () => {
      // On an approval the panel holds the record and stays open; on the
      // executive view it is a third of a chart. One shared setting loses that
      // argument on one of the two screens every time.
      const user = userEvent.setup();
      const { unmount } = render(<Frame routeId="executive" />);
      await user.click(screen.getByRole("button", { name: "Hide the context panel" }));
      unmount();

      render(<Frame routeId="approval-detail" />);
      expect(screen.getByRole("button", { name: "Hide the context panel" })).toBeInTheDocument();

      const stored = window.localStorage.getItem(SHELL_STORAGE_KEYS.panel) ?? "";
      expect(stored).toContain("executive");
      expect(stored).not.toContain("approval-detail");
    });
  });

  it("tells a screen which layout it is being drawn into", () => {
    // Two of §2's rungs change what a *screen* renders rather than only what
    // the frame looks like — below 900 the guidance is read-only layouts only —
    // so a screen has to be able to ask, and get the same answer the frame
    // acted on.
    function Reporter() {
      const layout = useShellLayout();
      return <p>{`${layout.rail} · ${layout.panel} · ${layout.dataEntry ? "entry" : "read-only"}`}</p>;
    }

    render(<Frame>{<Reporter />}</Frame>);
    expect(screen.getByText(/expanded · narrow · entry/)).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { baseElement } = render(<Frame />);
    await expectNoAccessibilityViolations(baseElement);
  });

  it("has no accessibility violations with the rail collapsed", async () => {
    window.localStorage.setItem(SHELL_STORAGE_KEYS.rail, "true");
    const { baseElement } = render(<Frame />);
    await expectNoAccessibilityViolations(baseElement);
  });

  it("has no accessibility violations with the palette open", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<Frame />);
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("combobox");
    await expectNoAccessibilityViolations(baseElement);
  });
});

/** A frame that takes a banner, for the one test that needs one. */
function Shell({ banner }: { readonly banner: ReactNode }) {
  const mainRef = useRef<HTMLElement | null>(null);
  const route = ROUTES.find((entry) => entry.id === "work") ?? null;
  return (
    <AppShell
      zones={visibleZones(session)}
      breadcrumb={breadcrumbFor(route, {})}
      routeId="work"
      actorName={session.actor.displayName}
      actorRoles={session.actor.roles}
      banner={banner}
      mainRef={mainRef}
    >
      <h1>Work queue</h1>
    </AppShell>
  );
}
