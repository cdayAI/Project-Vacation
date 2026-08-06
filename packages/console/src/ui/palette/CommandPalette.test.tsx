import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyboardProvider, useCommandSource } from "../../keyboard/KeyboardProvider";
import { CommandRegistry, type CommandDefinition } from "../../keyboard/registry";
import { expectNoAccessibilityViolations } from "../../test/axe";
import { CommandPalette } from "./CommandPalette";

afterEach(() => {
  window.localStorage.clear();
});

function Source({ commands }: { readonly commands: readonly CommandDefinition[] }) {
  useCommandSource(commands);
  return null;
}

/**
 * A page with a trigger and a palette, wired the way the shell wires them.
 * Everything below goes through the real open, the real field, and the real
 * keyboard, because the parts of a palette that go wrong — focus, restoration,
 * and what a keystroke reaches — are exactly the parts a shallow test skips.
 */
function Harness({
  commands = [],
  results,
  loading = false,
  error,
  readOnly = false,
}: {
  readonly commands?: readonly CommandDefinition[];
  readonly results?: readonly CommandDefinition[];
  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [registry] = useState(() => new CommandRegistry());

  return (
    <KeyboardProvider registry={registry}>
      <Source
        commands={[
          // The opener, bound the way the shell binds it: hidden from the list
          // and reachable from anywhere, including from inside a field.
          {
            id: "open-palette",
            label: "Command palette",
            kind: "action",
            shortcut: "commandPalette",
            hidden: true,
            run: () => setOpen(true),
          },
          ...commands,
        ]}
      />
      <main>
        <button type="button" onClick={() => setOpen(true)}>
          Search or run a command
        </button>
        <label htmlFor="filter">Filter the queue</label>
        <input id="filter" />
        <CommandPalette
          open={open}
          onClose={() => setOpen(false)}
          {...(results === undefined ? {} : { results })}
          loading={loading}
          {...(error === undefined ? {} : { error })}
          readOnly={readOnly}
        />
      </main>
    </KeyboardProvider>
  );
}

const COMMANDS: readonly CommandDefinition[] = [
  {
    id: "approve",
    label: "Approve this request",
    kind: "action",
    hint: "Records the decision and moves to the next item.",
    shortcut: "approve",
    run: () => {},
  },
  {
    id: "queue",
    label: "Work queue",
    kind: "navigate",
    shortcut: "goQueue",
    run: () => {},
  },
  {
    id: "evidence",
    label: "Audit and evidence",
    kind: "navigate",
    keywords: ["chain"],
    run: () => {},
  },
  { id: "hidden", label: "Command palette", kind: "action", hidden: true, run: () => {} },
];

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Search or run a command" }));
  return screen.findByRole("combobox", { name: "Search actions, records and saved views" });
}

describe("the command palette", () => {
  it("is not in the document until it is opened", () => {
    render(<Harness commands={COMMANDS} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens with the cursor already in the field", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    const field = await open(user);
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("lists actions, records and views in one list", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        commands={COMMANDS}
        results={[{ id: "case", label: "Case 41823", kind: "record", run: () => {} }]}
      />,
    );
    await open(user);

    const list = screen.getByRole("listbox", { name: "Results" });
    const options = within(list).getAllByRole("option");
    const labels = options.map((option) => option.textContent ?? "");
    expect(labels.some((label) => label.includes("Approve this request"))).toBe(true);
    expect(labels.some((label) => label.includes("Case 41823"))).toBe(true);
  });

  it("keeps its own opener out of its own list", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    await open(user);
    const list = screen.getByRole("listbox", { name: "Results" });
    expect(within(list).queryByText("Command palette")).not.toBeInTheDocument();
  });

  it("shows each row's shortcut, so the palette teaches the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    await open(user);

    const row = screen.getByRole("option", { name: /Approve this request/ });
    expect(within(row).getByText("A")).toBeInTheDocument();
  });

  it("names the kind of every row in words, never by colour alone", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    await open(user);

    expect(screen.getAllByText("Action").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Go to").length).toBeGreaterThan(0);
  });

  it("filters as each character arrives, with nothing deferred", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    const field = await open(user);

    await user.type(field, "audit");
    // Asserted with no timer advanced and no waitFor: specification §7 says
    // typing is never blocked, filtered, or debounced past 120ms, and the
    // cheapest way to keep that true is to do the work synchronously.
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Audit and evidence");
  });

  it("finds a command by a keyword that is not in its label", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    const field = await open(user);

    await user.type(field, "chain");
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Audit and evidence");
  });

  it("moves the active row with the arrow keys and says which one it is", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    const field = await open(user);

    const first = screen.getAllByRole("option")[0];
    expect(field).toHaveAttribute("aria-activedescendant", first?.id);

    await user.keyboard("{ArrowDown}");
    const second = screen.getAllByRole("option")[1];
    expect(field).toHaveAttribute("aria-activedescendant", second?.id);
    expect(second).toHaveAttribute("aria-selected", "true");
  });

  it("wraps from the last row back to the first", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    const field = await open(user);

    await user.keyboard("{ArrowUp}");
    const options = screen.getAllByRole("option");
    expect(field).toHaveAttribute("aria-activedescendant", options[options.length - 1]?.id);
  });

  it("runs the active command on Enter and closes", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(<Harness commands={[{ id: "a", label: "Approve", kind: "action", run }]} />);
    await open(user);

    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("runs a command on a click", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(<Harness commands={[{ id: "a", label: "Approve", kind: "action", run }]} />);
    await open(user);

    await user.click(screen.getByRole("option", { name: /Approve/ }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses a command that is unavailable, and says why", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <Harness
        commands={[
          {
            id: "a",
            label: "Approve",
            kind: "action",
            disabled: true,
            disabledReason: "your role cannot approve at this tier",
            run,
          },
        ]}
      />,
    );
    await open(user);

    const row = screen.getByRole("option", { name: /Approve/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent("your role cannot approve at this tier");

    await user.click(row);
    expect(run).not.toHaveBeenCalled();
  });

  it("remembers what was run, so the next opening is ordered by habit", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    await open(user);
    await user.click(screen.getByRole("option", { name: /Audit and evidence/ }));

    expect(window.localStorage.getItem("pv.console.command-use")).toContain("evidence");
  });

  it("closes on Escape and puts focus back on what opened it", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    const trigger = screen.getByRole("button", { name: "Search or run a command" });
    await open(user);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("puts focus back where the operator was, not on the trigger they never touched", async () => {
    // An operator who presses the chord standing in a field belongs back in
    // that field. The trigger is the fallback for when focus was nowhere in
    // particular — straight after a route change, say.
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    const field = screen.getByLabelText("Filter the queue");
    await user.click(field);

    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("combobox", { name: "Search actions, records and saved views" });
    await user.keyboard("{Escape}");

    await waitFor(() => expect(field).toHaveFocus());
  });

  it("keeps Tab inside itself", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    const dialog = await open(user).then(() => screen.getByRole("dialog"));

    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("says how many results there are, for a screen reader", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    const field = await open(user);

    await user.type(field, "audit");
    expect(screen.getByRole("status")).toHaveTextContent("1 result");
  });

  it("draws a designed empty state naming what was typed", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} />);
    const field = await open(user);

    await user.type(field, "zzzz");
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
    expect(screen.getByText(/Try a case reference/)).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps the list usable while records are still arriving", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} loading />);
    await open(user);

    expect(screen.getByText("Still searching records")).toBeInTheDocument();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });

  it("says the word Error when a record search failed", async () => {
    const user = userEvent.setup();
    render(
      <Harness commands={COMMANDS} error="We could not reach the record store. Reference 8f2a41." />,
    );
    await open(user);

    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText(/Reference 8f2a41/)).toBeInTheDocument();
  });

  it("marks an auditor's session read-only", async () => {
    const user = userEvent.setup();
    render(<Harness commands={COMMANDS} readOnly />);
    await open(user);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("does not let a global verb fire from its own field", async () => {
    // The palette owns the keyboard while it is open. Without that, J typed
    // into the field would also move the row in the list behind it and the
    // operator would come back to a queue standing somewhere they never went.
    const user = userEvent.setup();
    const next = vi.fn();
    render(
      <Harness
        commands={[
          { id: "next", label: "Next item", kind: "action", shortcut: "nextItem", run: next },
        ]}
      />,
    );
    const field = await open(user);

    await user.type(field, "jjj");
    expect(next).not.toHaveBeenCalled();
    expect(field).toHaveValue("jjj");
  });

  it("has no accessibility violations", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<Harness commands={COMMANDS} />);
    await open(user);
    await expectNoAccessibilityViolations(baseElement);
  });

  it("has no accessibility violations in its empty state", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<Harness commands={COMMANDS} />);
    const field = await open(user);
    await user.type(field, "zzzz");
    await expectNoAccessibilityViolations(baseElement);
  });
});
