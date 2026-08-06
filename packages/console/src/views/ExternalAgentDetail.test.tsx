import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ExternalAgentDetailView } from "../api/contract";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import {
  externalAgentDetail,
  externalAgentDetailHealthy,
  externalAgentOverBudget,
  externalAgentRevoked,
} from "../test/fixtures";
import { ExternalAgentDetail, denialPresentation } from "./ExternalAgentDetail";

function panel(name: string): HTMLElement {
  return screen.getByRole("region", { name }) as HTMLElement;
}

describe("ExternalAgentDetail", () => {
  it("names the agent, where it runs, and who is accountable for it", () => {
    renderSurface(<ExternalAgentDetail detail={externalAgentDetail} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "titling-deed-checker" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/runs on titling-vendor-cloud/)).toBeInTheDocument();
    expect(
      screen.getByText("marcus.oyelaran@example.invalid — Title and Closing"),
    ).toBeInTheDocument();
  });

  it("says a contained agent is contained, why, and who stopped it", () => {
    renderSurface(<ExternalAgentDetail detail={externalAgentDetail} />);

    expect(
      screen.getByText("This agent is contained and is being refused everything"),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/five refused writes to the titling system/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/Stopped by act_7f3a91c2/)).toBeInTheDocument();
    // The heartbeat is the only way containment reaches somebody else's system,
    // and an operator who does not know that will expect an instant stop.
    expect(screen.getByText(/nothing here can interrupt its process/)).toBeInTheDocument();
  });

  it("explains a refusal in words a supervisor can act on, keeping the code beside it", () => {
    renderSurface(<ExternalAgentDetail detail={externalAgentDetail} />);

    expect(screen.getByText("It asked to use a tool it was not granted")).toBeInTheDocument();
    expect(
      screen.getByText("The action was riskier than this agent is allowed to be"),
    ).toBeInTheDocument();
    // The code stays visible for whoever is asked next.
    expect(screen.getByText("authorization.action_not_permitted")).toBeInTheDocument();
    expect(screen.getByText("role.ceiling_exceeded")).toBeInTheDocument();
    // And what the platform actually said at the time is preserved verbatim.
    expect(
      screen.getByText(/titling-deed-checker is not permitted to use "titling.write_deed"/),
    ).toBeInTheDocument();
  });

  it("separates refusals the agent caused from refusals this platform caused", () => {
    renderSurface(<ExternalAgentDetail detail={externalAgentDetail} />);

    const denials = panel("What was refused");
    expect(
      within(denials).getByRole("heading", { name: "Refusals caused by the agent" }),
    ).toBeInTheDocument();
    expect(
      within(denials).getByRole("heading", { name: "Refusals caused by this platform" }),
    ).toBeInTheDocument();
    // Our own screen failing is not the vendor's fault and does not count
    // toward automatic containment.
    expect(
      screen.getByText("This platform could not screen the text, so it refused"),
    ).toBeInTheDocument();
  });

  it("refuses to invent an explanation for a code nobody has worded", () => {
    const presentation = denialPresentation("some.unwritten_reason");
    expect(presentation.explanation).toMatch(/No plain-language explanation has been written/);
    // A confident-sounding gloss on a refusal nobody worded would be believed.
    expect(presentation.explanation).not.toMatch(/probably|likely|may have/);
  });

  it("shows every run with its outcome and cost, linked to the operating record", () => {
    renderSurface(<ExternalAgentDetail detail={externalAgentDetail} />);

    const runs = panel("What it has been doing");
    expect(within(runs).getAllByRole("link", { name: "Open the run record" })).toHaveLength(3);
    expect(within(runs).getByText("Stopped by this platform")).toBeInTheDocument();
    expect(within(runs).getByText("Finished")).toBeInTheDocument();
    // "Reclaimed" is not "failed", and the difference is stated rather than
    // left to a status word nobody outside this codebase knows.
    expect(within(runs).getByText("Stopped answering")).toBeInTheDocument();
    expect(
      within(runs).getByText(/Nobody heard from it, which is not the same as it having failed/),
    ).toBeInTheDocument();
  });

  it("reports spend for the current period against the ceiling, and by period", () => {
    renderSurface(<ExternalAgentDetail detail={externalAgentDetail} />);

    const spend = panel("What it has cost");
    expect(within(spend).getByText(/\$3\.21 of \$100\.00/)).toBeInTheDocument();
    expect(within(spend).getByText(/period 2026-08/)).toBeInTheDocument();
    expect(within(spend).getByText("$88.51")).toBeInTheDocument();
    expect(within(spend).getByText(/118 in total/)).toBeInTheDocument();
  });

  it("lists credential kinds and labels, and never a value", () => {
    const { container } = renderSurface(<ExternalAgentDetail detail={externalAgentDetail} />);

    const credentials = panel("Credentials it holds");
    expect(within(credentials).getByText("titling vendor production")).toBeInTheDocument();
    expect(within(credentials).getAllByText("Bearer token")).toHaveLength(2);
    expect(within(credentials).getByText("Revoked")).toBeInTheDocument();
    expect(within(credentials).getByText(/rotated — a replacement has been minted/)).toBeInTheDocument();
    // A bearer token proves possession of a string, which is a weaker claim
    // than a signed request, and the difference is stated.
    expect(within(credentials).getAllByText("Proves possession of a string")).toHaveLength(2);

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/pvx_/);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it("marks a strong credential as proving possession of a key", () => {
    renderSurface(<ExternalAgentDetail detail={externalAgentDetailHealthy} />);
    expect(screen.getByText("Proves possession of a key")).toBeInTheDocument();
  });

  it("shows the containment history, and which stop was automatic", () => {
    renderSurface(<ExternalAgentDetail detail={externalAgentDetail} />);

    const history = panel("Every time it has been stopped");
    expect(within(history).getAllByText("Stopped")).toHaveLength(2);
    expect(within(history).getByText("Allowed to run again")).toBeInTheDocument();
    expect(within(history).getByText("Automatic, after repeated refusals")).toBeInTheDocument();
    expect(within(history).getAllByText("A person decided this")).toHaveLength(2);
  });

  it("makes an indeterminate action loud, because a retry might duplicate a real effect", () => {
    renderSurface(<ExternalAgentDetail detail={externalAgentDetail} />);

    expect(screen.getByText("1 action may or may not have happened")).toBeInTheDocument();
    expect(
      screen.getByText("Indeterminate — somebody has to go and look"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing retries it automatically/)).toBeInTheDocument();
  });

  it("says an over-budget agent is refused on spend, and that no meter can be cleared", () => {
    const detail: ExternalAgentDetailView = {
      ...externalAgentDetailHealthy,
      agent: externalAgentOverBudget,
    };
    renderSurface(<ExternalAgentDetail detail={detail} />);

    expect(screen.getByText("This agent has reached its spend ceiling")).toBeInTheDocument();
    expect(screen.getByText(/no operation anywhere in this platform that clears a spend meter/)).toBeInTheDocument();
  });

  it("says revocation is terminal rather than a pause", () => {
    const detail: ExternalAgentDetailView = {
      ...externalAgentDetailHealthy,
      agent: externalAgentRevoked,
      credentials: [],
    };
    renderSurface(<ExternalAgentDetail detail={detail} />);

    expect(screen.getByText("This enrollment has been ended permanently")).toBeInTheDocument();
    expect(screen.getByText(/Bringing it back is a fresh enrollment/)).toBeInTheDocument();
    // A revoked agent holding no credential is not worth warning about.
    expect(screen.queryByText("This agent holds no live credential")).not.toBeInTheDocument();
  });

  it("warns when an agent holds no live credential and therefore cannot act", () => {
    const detail: ExternalAgentDetailView = { ...externalAgentDetailHealthy, credentials: [] };
    renderSurface(<ExternalAgentDetail detail={detail} />);

    expect(screen.getByText("This agent holds no live credential")).toBeInTheDocument();
    expect(screen.getByText(/it is doing nothing whatever else this page says/)).toBeInTheDocument();
  });

  it("says plainly when a clean agent has been refused nothing", () => {
    renderSurface(<ExternalAgentDetail detail={externalAgentDetailHealthy} />);

    expect(
      screen.getByText(/Nothing has been refused\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This agent has never been contained or revoked/),
    ).toBeInTheDocument();
  });

  it("lists tools and scopes in full rather than behind a control", () => {
    renderSurface(<ExternalAgentDetail detail={externalAgentDetail} />);

    const authority = panel("What it is permitted to do");
    expect(within(authority).getByText("titling.read_deed")).toBeInTheDocument();
    expect(within(authority).getByText("contracts.metadata")).toBeInTheDocument();
    // The operator's rating overriding the agent's declaration is the single
    // most surprising rule here, so it is stated on the screen that shows the
    // grant rather than left in documentation.
    expect(
      within(authority).getByText(/overrides whatever the agent declares/),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<ExternalAgentDetail detail={externalAgentDetail} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations for a healthy agent with nothing to report", async () => {
    const { container } = renderSurface(
      <ExternalAgentDetail detail={externalAgentDetailHealthy} />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
