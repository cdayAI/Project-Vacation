import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ExternalAgentView } from "../api/contract";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import {
  externalAgentContained,
  externalAgentHealthy,
  externalAgentOverBudget,
  externalAgents,
} from "../test/fixtures";
import { ExternalAgents } from "./ExternalAgents";

describe("ExternalAgents", () => {
  it("lists every enrolled agent with a link to its detail", () => {
    renderSurface(<ExternalAgents agents={externalAgents} total={externalAgents.length} />);

    expect(screen.getByRole("link", { name: "crm-owner-reply" })).toHaveAttribute(
      "href",
      "/external-agents/eag_01k4a2m7p3",
    );
    expect(screen.getByRole("link", { name: "titling-deed-checker" })).toHaveAttribute(
      "href",
      "/external-agents/eag_01k4a3c9r8",
    );
  });

  it("shows who owns each agent, and where it actually runs", () => {
    renderSurface(<ExternalAgents agents={externalAgents} />);

    expect(screen.getByText("priya.raghunathan@example.invalid")).toBeInTheDocument();
    expect(screen.getByText("vendor-crm")).toBeInTheDocument();
    expect(screen.getByText("titling-vendor-cloud")).toBeInTheDocument();
    // Once in the table, once as an option in the department filter.
    expect(screen.getAllByText("Title and Closing")).toHaveLength(2);
  });

  it("states containment in words and counts it, not in colour alone", () => {
    const { container } = renderSurface(<ExternalAgents agents={externalAgents} />);

    // Once as the row's state, once as an option in the state filter.
    expect(screen.getAllByText("Contained")).toHaveLength(2);
    expect(screen.getByText("1 agent is contained")).toBeInTheDocument();
    // The reason travels with the state, so a reader does not have to open the
    // detail view to learn why an agent was stopped.
    expect(
      screen.getAllByText(/five refused writes to the titling system/).length,
    ).toBeGreaterThan(0);
    // A second, redundant channel for a sighted operator scanning the table.
    expect(container.querySelectorAll("tr.pv-row-denied")).toHaveLength(2);
  });

  it("states over budget in words, against the current period's ceiling", () => {
    const { container } = renderSurface(<ExternalAgents agents={externalAgents} />);

    expect(screen.getByText("Over ceiling")).toBeInTheDocument();
    expect(screen.getByText("1 agent is over budget")).toBeInTheDocument();
    expect(screen.getByText("$512.44 of $400.00")).toBeInTheDocument();
    // The period is named, so a monthly ceiling is never read against a
    // lifetime total.
    expect(screen.getAllByText("Period 2026-08").length).toBeGreaterThan(0);
    expect(screen.getByText("Lifetime")).toBeInTheDocument();
    expect(container.querySelectorAll("tr.pv-row-breached")).toHaveLength(1);
  });

  it("names which credential kinds are held and never a value", () => {
    renderSurface(<ExternalAgents agents={externalAgents} />);

    expect(screen.getByText("Signed request")).toBeInTheDocument();
    expect(screen.getByText("Signed assertion")).toBeInTheDocument();
    expect(screen.getByText("Signed envelope")).toBeInTheDocument();
    expect(screen.getByText("Bearer token")).toBeInTheDocument();
    // An agent holding none cannot authenticate, which is worth saying rather
    // than leaving as a blank cell.
    expect(screen.getByText("None held")).toBeInTheDocument();
  });

  it("calls out a live agent that holds no credential, and stays quiet about a revoked one", () => {
    // The revoked agent in the roster also holds none, and warning about it
    // would be noise: it is never going to authenticate again by design.
    renderSurface(<ExternalAgents agents={externalAgents} />);
    expect(screen.queryByText(/agents? holds? no credential/)).not.toBeInTheDocument();

    const uncredentialled: ExternalAgentView = {
      ...externalAgentHealthy,
      agentId: "eag_nocreds",
      name: "just-enrolled",
      credentialKinds: [],
    };
    renderSurface(<ExternalAgents agents={[uncredentialled]} />);
    expect(screen.getByText("1 agent holds no credential")).toBeInTheDocument();
  });

  it("makes an expired enrollment prominent even though the record still says active", () => {
    const expired: ExternalAgentView = {
      ...externalAgentHealthy,
      agentId: "eag_expired",
      name: "lapsed-agent",
      expiresAt: "2026-07-01T00:00:00.000Z",
      expired: true,
    };
    renderSurface(<ExternalAgents agents={[...externalAgents, expired]} />);

    expect(screen.getByText("Enrollment expired")).toBeInTheDocument();
    expect(screen.getByText("1 enrollment has expired")).toBeInTheDocument();
  });

  it("shows last seen, and says so plainly when an agent has never called", () => {
    const silent: ExternalAgentView = {
      ...externalAgentHealthy,
      agentId: "eag_silent",
      name: "never-called",
      lastSeenAt: undefined,
    };
    renderSurface(<ExternalAgents agents={[silent]} />);

    expect(screen.getByText("Never")).toBeInTheDocument();
  });

  it("filters to one enrollment state", async () => {
    const user = userEvent.setup();
    renderSurface(<ExternalAgents agents={externalAgents} />);

    await user.selectOptions(screen.getByLabelText("Enrollment state"), "contained");

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2); // header plus one
    expect(screen.getByRole("link", { name: "titling-deed-checker" })).toBeInTheDocument();
  });

  it("filters to one department", async () => {
    const user = userEvent.setup();
    renderSurface(<ExternalAgents agents={externalAgents} />);

    await user.selectOptions(screen.getByLabelText("Department"), "Owner Services");

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "crm-owner-reply" })).toBeInTheDocument();
  });

  it("filters to everything that needs a person", async () => {
    const user = userEvent.setup();
    renderSurface(<ExternalAgents agents={externalAgents} />);

    await user.click(
      screen.getByLabelText("Only agents that are contained, over budget, or expired"),
    );

    const table = screen.getByRole("table");
    // The contained one and the over-budget one; the healthy and revoked ones
    // are not conditions anybody has to act on.
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });

  it("is sortable by how close an agent is to its ceiling", async () => {
    const user = userEvent.setup();
    renderSurface(
      <ExternalAgents agents={[externalAgentHealthy, externalAgentOverBudget]} />,
    );

    await user.click(screen.getByRole("button", { name: /Spend this period/ }));

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    // Ascending: the agent with the most headroom first. A small agent at 99%
    // of its budget must not sort below a large one at 20%.
    expect(rows[1]).toHaveTextContent("crm-owner-reply");
    expect(rows[2]).toHaveTextContent("board-pack-assembler");
  });

  it("says an empty roster is a claim this deployment has not earned", () => {
    renderSurface(<ExternalAgents agents={[]} total={0} />);

    expect(
      screen.getByRole("heading", { name: "No external agent is enrolled" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/a zero this deployment has not earned/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("distinguishes an empty roster from an over-tight filter", async () => {
    const user = userEvent.setup();
    renderSurface(<ExternalAgents agents={[externalAgentHealthy]} />);

    await user.selectOptions(screen.getByLabelText("Enrollment state"), "revoked");

    expect(
      screen.getByRole("heading", { name: "No agent matches these filters" }),
    ).toBeInTheDocument();
  });

  it("announces the filtered count so a filter is heard and not only seen", async () => {
    const user = userEvent.setup();
    renderSurface(<ExternalAgents agents={externalAgents} />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Showing 4 agents");

    await user.selectOptions(screen.getByLabelText("Enrollment state"), "contained");
    expect(screen.getByRole("status")).toHaveTextContent("Showing 1 agent");
    expect(screen.getByRole("status")).toHaveTextContent("filtered");
  });

  it("never renders anything that looks like a credential value", () => {
    const { container } = renderSurface(<ExternalAgents agents={externalAgents} />);

    const text = container.textContent ?? "";
    // The mint prefix, and a 64-character hex string, are the two shapes a
    // leaked bearer token or its stored hash would take.
    expect(text).not.toMatch(/pvx_/);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(
      <ExternalAgents agents={externalAgents} total={externalAgents.length} />,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when the roster is empty", async () => {
    const { container } = renderSurface(<ExternalAgents agents={[]} total={0} />);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations with an agent in every alarming state", async () => {
    const { container } = renderSurface(
      <ExternalAgents agents={[externalAgentContained, externalAgentOverBudget]} />,
    );
    await expectNoAccessibilityViolations(container);
  });
});
