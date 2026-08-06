import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { Link, matchRoute, matchRoutes, navigate, useRouteChangeAnnouncement } from "./routing";
import type { RouteDefinition } from "./routing";

const routes: readonly RouteDefinition[] = [
  { id: "work", path: "/work", title: "Work queue", render: () => <p>Work queue body</p> },
  {
    id: "run",
    path: "/runs/:runId",
    title: "Run record",
    render: (params) => <p>Run {params["runId"]}</p>,
  },
];

function Harness() {
  const mainRef = useRef<HTMLElement | null>(null);
  useRouteChangeAnnouncement("Work queue — Operator console", mainRef);
  return (
    <div>
      <Link to="/runs/run_01k3m9x2p7">Open the run</Link>
      <main id="main-content" ref={mainRef} tabIndex={-1}>
        <h1>Content</h1>
      </main>
    </div>
  );
}

describe("routing", () => {
  it("matches a literal path", () => {
    expect(matchRoute("/work", "/work")).toEqual({});
    expect(matchRoute("/work", "/approvals")).toBeNull();
  });

  it("captures named parameters and decodes them", () => {
    expect(matchRoute("/runs/:runId", "/runs/run_01k3m9x2p7")).toEqual({
      runId: "run_01k3m9x2p7",
    });
    expect(matchRoute("/runs/:runId", "/runs/a%2Fb")).toEqual({ runId: "a/b" });
  });

  it("does not match a path with a different number of segments", () => {
    expect(matchRoute("/runs/:runId", "/runs")).toBeNull();
    expect(matchRoute("/runs/:runId", "/runs/a/b")).toBeNull();
  });

  it("selects the first matching route", () => {
    const match = matchRoutes(routes, "/runs/run_9");
    expect(match?.route.id).toBe("run");
    expect(match?.params).toEqual({ runId: "run_9" });
    expect(matchRoutes(routes, "/nowhere")).toBeNull();
  });

  it("renders links as real anchors so the browser's own affordances keep working", () => {
    render(<Harness />);
    const link = screen.getByRole("link", { name: "Open the run" });
    expect(link).toHaveAttribute("href", "/runs/run_01k3m9x2p7");
  });

  it("navigates on a plain click without a document load", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("link", { name: "Open the run" }));

    expect(window.location.pathname).toBe("/runs/run_01k3m9x2p7");
  });

  it("leaves modified clicks to the browser", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // Ctrl-click means "open in a new tab". Swallowing it would break a
    // browser behaviour operators rely on to compare two runs side by side.
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("link", { name: "Open the run" }));
    await user.keyboard("{/Control}");

    expect(window.location.pathname).toBe("/");
  });

  it("sets the document title and moves focus to main after a route change", () => {
    render(<Harness />);
    expect(document.title).toBe("Work queue — Operator console");

    // Focus is deliberately left alone on first render: the browser has just
    // loaded a document.
    expect(document.activeElement).not.toBe(screen.getByRole("main"));

    act(() => navigate("/runs/run_01k3m9x2p7"));

    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});
