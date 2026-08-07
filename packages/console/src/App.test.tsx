import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { ApiError } from "./api/client";
import { expectNoAccessibilityViolations, renderShell } from "./test/axe";
import { createFakeClient } from "./test/fakeClient";
import { alarmingPlatform, auditorSession, healthyPlatform, session } from "./test/fixtures";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-density");
});

describe("App shell", () => {
  it("puts a skip link first, so a keyboard user can reach the content in one press", async () => {
    renderShell(<App />, createFakeClient());
    const skip = await screen.findByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveAttribute("href", "#main-content");
    expect(document.querySelector("a")).toBe(skip);
  });

  it("exposes one main landmark and names the primary navigation", async () => {
    renderShell(<App />, createFakeClient());

    expect(await screen.findByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("shows the signed-in actor and their roles", async () => {
    renderShell(<App />, createFakeClient());

    const header = within(await screen.findByRole("banner"));
    expect(header.getByText(session.actor.displayName)).toBeInTheDocument();
    expect(header.getByText("owner_services_supervisor")).toBeInTheDocument();
  });

  it("marks an auditor session read-only", async () => {
    const user = userEvent.setup();
    renderShell(<App />, createFakeClient({ session: () => Promise.resolve(auditorSession) }));

    await user.click(await screen.findByRole("button", { name: /Signed in as/ }));
    expect(screen.getAllByText("Read-only").length).toBeGreaterThan(0);
  });

  it("carries the theme control in the account menu", async () => {
    const user = userEvent.setup();
    renderShell(<App />, createFakeClient());

    await user.click(await screen.findByRole("button", { name: /Signed in as/ }));
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("sends the operator to the work queue from the root path", async () => {
    renderShell(<App />, createFakeClient());

    expect(await screen.findByRole("heading", { level: 1, name: "Work queue" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/work");
  });

  it("marks the current navigation item", async () => {
    renderShell(<App />, createFakeClient());
    const workLink = await screen.findByRole("link", { name: "Work queue" });
    expect(workLink).toHaveAttribute("aria-current", "page");
  });

  it("navigates to approvals without a document load", async () => {
    const user = userEvent.setup();
    renderShell(<App />, createFakeClient());

    await user.click(await screen.findByRole("link", { name: "Approvals" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Approvals" })).toBeInTheDocument();
    expect(document.title).toBe("Approvals — Operator console");
  });

  it("says where you are, from the zone down", async () => {
    const user = userEvent.setup();
    renderShell(<App />, createFakeClient());
    await user.click(await screen.findByRole("link", { name: "Audit and evidence" }));

    const trail = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(trail).toHaveTextContent("Oversight");
    expect(trail).toHaveTextContent("Audit and evidence");
  });

  it("opens the command palette from anywhere in the console", async () => {
    const user = userEvent.setup();
    renderShell(<App />, createFakeClient());
    await screen.findByRole("heading", { level: 1, name: "Work queue" });

    await user.keyboard("{Control>}k{/Control}");
    expect(
      await screen.findByRole("combobox", { name: "Search actions, records and saved views" }),
    ).toBeInTheDocument();
  });

  it("navigates from the command palette, which is primary navigation and not a bonus", async () => {
    const user = userEvent.setup();
    renderShell(<App />, createFakeClient());
    await screen.findByRole("heading", { level: 1, name: "Work queue" });

    await user.keyboard("{Control>}k{/Control}");
    // By name: a screen may have comboboxes of its own, and this is the
    // palette's field.
    await user.type(
      await screen.findByRole("combobox", { name: "Search actions, records and saved views" }),
      "improvements",
    );
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("heading", { level: 1, name: "Improvements" })).toBeInTheDocument();
  });

  it("reaches the design gallery, which is the review surface", async () => {
    const user = userEvent.setup();
    renderShell(<App />, createFakeClient());
    await user.click(await screen.findByRole("link", { name: "Design system" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Design system gallery" }),
    ).toBeInTheDocument();
  });

  it("steps back one level on Escape from a detail route", async () => {
    window.history.replaceState(null, "", "/approvals/apr_01k3r2m8k5");
    const user = userEvent.setup();
    renderShell(<App />, createFakeClient());
    await screen.findByRole("navigation", { name: "Breadcrumb" });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(window.location.pathname).toBe("/approvals"));
  });

  it("stays quiet when the platform state is unremarkable", async () => {
    renderShell(<App />, createFakeClient());

    await screen.findByRole("heading", { level: 1, name: "Work queue" });
    expect(screen.queryByText("Platform state needs your attention")).not.toBeInTheDocument();
  });

  it("states the three facts an operator must never go looking for", async () => {
    renderShell(<App />, createFakeClient({ health: () => Promise.resolve(alarmingPlatform) }));

    expect(await screen.findByText("Platform state needs your attention")).toBeInTheDocument();
    expect(screen.getByText(/The execution sandbox is not contained/)).toBeInTheDocument();
    expect(screen.getByText(/Work discovery is enabled/)).toBeInTheDocument();
    expect(screen.getByText(/Audit verification failed/)).toBeInTheDocument();
    // Startup warnings surface here too rather than only in a log nobody reads.
    expect(
      screen.getByText("Model inventory is using a development configuration file."),
    ).toBeInTheDocument();
  });

  it("distinguishes an unverified audit chain from an intact one", async () => {
    const neverVerified = { ...healthyPlatform };
    delete (neverVerified as { lastAuditVerification?: unknown }).lastAuditVerification;

    renderShell(<App />, createFakeClient({ health: () => Promise.resolve(neverVerified) }));

    expect(await screen.findByText(/The audit chain has not been verified/)).toBeInTheDocument();
  });

  it("says so when it cannot read the platform state at all", async () => {
    renderShell(
      <App />,
      createFakeClient({
        health: () =>
          Promise.reject(new ApiError("unreachable", { status: 0, url: "/api/health" })),
      }),
    );

    expect(await screen.findByText("Platform state is unknown")).toBeInTheDocument();
    expect(screen.getByText(/Treat those three as unconfirmed until this clears/)).toBeInTheDocument();
  });

  it("renders an unknown address as a page, not a blank screen", async () => {
    window.history.replaceState(null, "", "/nowhere-at-all");
    renderShell(<App />, createFakeClient());

    expect(
      await screen.findByRole("heading", { level: 1, name: "That page does not exist" }),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderShell(<App />, createFakeClient());
    await screen.findByRole("heading", { level: 1, name: "Work queue" });
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations while the platform-state banner is showing", async () => {
    const { container } = renderShell(
      <App />,
      createFakeClient({ health: () => Promise.resolve(alarmingPlatform) }),
    );
    await screen.findByText("Platform state needs your attention");
    await expectNoAccessibilityViolations(container);
  });
});
