import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { ApiError } from "./api/client";
import { expectNoAccessibilityViolations, renderShell } from "./test/axe";
import { createFakeClient } from "./test/fakeClient";
import { alarmingPlatform, auditorSession, healthyPlatform, session } from "./test/fixtures";

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
    renderShell(<App />, createFakeClient({ session: () => Promise.resolve(auditorSession) }));
    expect(await screen.findByText("Read-only")).toBeInTheDocument();
  });

  it("carries the theme toggle in the header", async () => {
    renderShell(<App />, createFakeClient());
    expect(await screen.findByRole("button", { name: /dark theme/i })).toBeInTheDocument();
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
