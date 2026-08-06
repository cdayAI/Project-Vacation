import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HealthView } from "../api/contract";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { alarmingPlatform, containmentGlobalPaused, healthyPlatform } from "../test/fixtures";
import { Health } from "./Health";

const withContainment: HealthView = {
  ...healthyPlatform,
  containment: containmentGlobalPaused,
};

const neverVerified: HealthView = { ...healthyPlatform };
delete (neverVerified as { lastAuditVerification?: unknown }).lastAuditVerification;

describe("Health", () => {
  it("reports the environment, store, and model provider", () => {
    renderSurface(<Health health={healthyPlatform} />);

    const configuration = screen.getByRole("region", { name: "Configuration" });
    expect(within(configuration).getByText("staging")).toBeInTheDocument();
    expect(within(configuration).getByText("postgres")).toBeInTheDocument();
    expect(within(configuration).getByText("configured-inventory")).toBeInTheDocument();
  });

  it("states sandbox containment as a sentence, not as a mode string alone", () => {
    renderSurface(<Health health={healthyPlatform} />);

    expect(screen.getByText("container-isolated")).toBeInTheDocument();
    expect(
      screen.getByText("Contained — code the platform runs is isolated from this host"),
    ).toBeInTheDocument();
  });

  it("raises an uncontained sandbox rather than leaving it in a field", () => {
    renderSurface(<Health health={alarmingPlatform} />);

    expect(screen.getByText("The execution sandbox is not contained")).toBeInTheDocument();
    expect(
      screen.getByText("Not contained — code the platform runs is not isolated from this host"),
    ).toBeInTheDocument();
  });

  it("reports the discovery state and links to the explanation either way", () => {
    const { unmount } = renderSurface(<Health health={healthyPlatform} />);
    expect(screen.getByText("Disabled — the shipped state")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Why it ships off" })).toHaveAttribute(
      "href",
      "/discovery",
    );
    unmount();

    renderSurface(<Health health={alarmingPlatform} />);
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText(/somebody switched this on deliberately/)).toBeInTheDocument();
  });

  it("reports the audit head and the last verification", () => {
    renderSurface(<Health health={healthyPlatform} />);

    expect(
      screen.getByText("Entry 41,882 is the most recent entry in the record."),
    ).toBeInTheDocument();
    expect(screen.getByText("Verified intact")).toBeInTheDocument();
    expect(
      screen.getByText("5f2b8c1de4a70936bb1c4f8a2d0e77c3a9451bd6e8f302447cbb19de5a6027f18"),
    ).toBeInTheDocument();
  });

  it("distinguishes never verified from verified and intact", () => {
    renderSurface(<Health health={neverVerified} />);

    expect(screen.getByText("The audit chain has not been verified")).toBeInTheDocument();
    expect(
      screen.getByText(/That is not the same as it being intact/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Verified intact")).not.toBeInTheDocument();
  });

  it("lists every break when verification failed", () => {
    renderSurface(<Health health={alarmingPlatform} />);

    expect(screen.getByText("Verification failed in 1 place")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Entry 18,204, hash mismatch: Recomputed entry hash does not match the stored value\./,
      ),
    ).toBeInTheDocument();
  });

  it("surfaces the startup warnings rather than leaving them in a log", () => {
    renderSurface(<Health health={alarmingPlatform} />);

    expect(screen.getByText("1 configuration warning from startup")).toBeInTheDocument();
    expect(
      screen.getByText("Model inventory is using a development configuration file."),
    ).toBeInTheDocument();
  });

  it("shows the containment switches and how many are engaged", () => {
    renderSurface(<Health health={withContainment} />);

    expect(screen.getByText(/3 switches are engaged/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: /Containment switches/ });
    expect(within(table).getAllByRole("row")).toHaveLength(5); // header plus four
    expect(within(table).getAllByText("Stopped")).toHaveLength(3);
  });

  it("says so when nothing has ever been stopped", () => {
    renderSurface(<Health health={healthyPlatform} />);

    expect(
      screen.getByText(/No switch has ever been set on this deployment, so nothing is stopped\./),
    ).toBeInTheDocument();
  });

  it("states the overall status in a sentence, not only as a word", () => {
    const { unmount } = renderSurface(<Health health={healthyPlatform} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Operating normally" }),
    ).toBeInTheDocument();
    unmount();

    renderSurface(<Health health={alarmingPlatform} />);
    expect(screen.getByRole("heading", { level: 2, name: "Degraded" })).toBeInTheDocument();
    expect(
      screen.getByText(/Work may be refused rather than completed\./),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<Health health={healthyPlatform} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when the platform is in a bad state", async () => {
    const { container } = renderSurface(<Health health={alarmingPlatform} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations with containment engaged", async () => {
    const { container } = renderSurface(<Health health={withContainment} />);
    await expectNoAccessibilityViolations(container);
  });
});
