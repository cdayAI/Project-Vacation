import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HealthView } from "../api/contract";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { alarmingPlatform, healthyPlatform } from "../test/fixtures";
import { PlatformStateBanner } from "./PlatformStateBanner";

describe("the platform-state banner", () => {
  it("stays quiet when the platform state is unremarkable", () => {
    const { container } = renderSurface(
      <PlatformStateBanner health={healthyPlatform} unavailable={false} />,
    );
    expect(container.querySelector(".pv-platform-banner")).toBeNull();
  });

  it("states the three facts an operator must never go looking for", () => {
    renderSurface(<PlatformStateBanner health={alarmingPlatform} unavailable={false} />);

    expect(screen.getByText("Platform state needs your attention")).toBeInTheDocument();
    expect(screen.getByText(/The execution sandbox is not contained/)).toBeInTheDocument();
    expect(screen.getByText(/Work discovery is enabled/)).toBeInTheDocument();
    expect(screen.getByText(/Audit verification failed/)).toBeInTheDocument();
  });

  it("surfaces startup warnings here rather than only in a log nobody reads", () => {
    renderSurface(<PlatformStateBanner health={alarmingPlatform} unavailable={false} />);
    expect(
      screen.getByText("Model inventory is using a development configuration file."),
    ).toBeInTheDocument();
  });

  it("distinguishes an unverified audit chain from an intact one", () => {
    // "Nobody has checked" is a different statement from "it is intact", and
    // only one of them is reassuring.
    const neverVerified: HealthView = { ...healthyPlatform };
    delete (neverVerified as { lastAuditVerification?: unknown }).lastAuditVerification;

    renderSurface(<PlatformStateBanner health={neverVerified} unavailable={false} />);
    expect(screen.getByText(/The audit chain has not been verified/)).toBeInTheDocument();
  });

  it("says so when it cannot read the platform state at all", () => {
    renderSurface(<PlatformStateBanner health={null} unavailable />);
    expect(screen.getByText("Platform state is unknown")).toBeInTheDocument();
    expect(screen.getByText(/Treat those three as unconfirmed until this clears/)).toBeInTheDocument();
  });

  it("shows nothing at all while the health request is still in flight", () => {
    // A banner that flashes "unknown" on every load teaches operators to
    // ignore it.
    const { container } = renderSurface(<PlatformStateBanner health={null} unavailable={false} />);
    expect(container.querySelector(".pv-platform-banner")).toBeNull();
  });

  it("carries the word Warning beside its tint", () => {
    // This banner is the first thing in a printed handover pack, and the last
    // thing a colour-blind operator should have to guess at.
    renderSurface(<PlatformStateBanner health={alarmingPlatform} unavailable={false} />);
    expect(screen.getByText("Warning")).toBeInTheDocument();
  });

  it("is a labelled region, so a screen reader can find it and leave it", () => {
    renderSurface(<PlatformStateBanner health={alarmingPlatform} unavailable={false} />);
    expect(
      screen.getByRole("region", { name: "Platform state needs your attention" }),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <PlatformStateBanner health={alarmingPlatform} unavailable={false} />,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when the state is unknown", async () => {
    const { container } = renderSurface(<PlatformStateBanner health={null} unavailable />);
    await expectNoAccessibilityViolations(container);
  });
});
