import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations } from "../test/axe";
import {
  KeyboardProvider,
  useCommandSource,
  useSuspendShortcuts,
} from "./KeyboardProvider";
import { CommandRegistry, type CommandDefinition } from "./registry";

afterEach(() => {
  window.localStorage.clear();
});

/**
 * A screen, in miniature: it registers commands and offers somewhere to type.
 * Everything asserted below is asserted through a real key press on a real
 * document, because a shortcut model that is only tested through its own
 * matcher is a shortcut model that has never met an input field.
 */
function Screen({
  commands,
  suspended = false,
}: {
  readonly commands: readonly CommandDefinition[];
  readonly suspended?: boolean;
}) {
  useCommandSource(commands);
  useSuspendShortcuts(suspended);
  return (
    <main>
      <label htmlFor="reason">Reason</label>
      <input id="reason" />
      <label htmlFor="notes">Notes</label>
      <textarea id="notes" />
      <button type="button">Somewhere to stand</button>
    </main>
  );
}

function mount(commands: readonly CommandDefinition[], options: { readonly suspended?: boolean } = {}) {
  const registry = new CommandRegistry();
  const result = render(
    <KeyboardProvider registry={registry}>
      <Screen commands={commands} suspended={options.suspended ?? false} />
    </KeyboardProvider>,
  );
  return { registry, ...result };
}

describe("the keyboard dispatcher", () => {
  it("runs the command bound to a verb", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    mount([{ id: "next", label: "Next item", kind: "action", shortcut: "nextItem", run }]);

    await user.keyboard("j");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a verb nobody has bound", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    mount([{ id: "next", label: "Next item", kind: "action", shortcut: "nextItem", run }]);

    await user.keyboard("a");
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps approve and reject to the screens that offer them", async () => {
    // Specification §5 marks A and R "approval context only". They are bound
    // by the approval screen and by nothing else, so on a queue they are two
    // letters that do nothing rather than two letters that do the wrong thing.
    const user = userEvent.setup();
    const approve = vi.fn();
    mount([{ id: "approve", label: "Approve", kind: "action", shortcut: "approve", run: approve }]);

    await user.keyboard("a");
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("completes a two-key sequence", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    mount([{ id: "queue", label: "Work queue", kind: "navigate", shortcut: "goQueue", run }]);

    await user.keyboard("gq");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not fire the second half of a sequence on its own", async () => {
    const user = userEvent.setup();
    const queue = vi.fn();
    const approvals = vi.fn();
    mount([
      { id: "queue", label: "Work queue", kind: "navigate", shortcut: "goQueue", run: queue },
      { id: "approvals", label: "Approvals", kind: "navigate", shortcut: "goApprovals", run: approvals },
    ]);

    await user.keyboard("q");
    expect(queue).not.toHaveBeenCalled();
    await user.keyboard("ga");
    expect(approvals).toHaveBeenCalledTimes(1);
  });

  it("runs the palette from a modifier chord", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    mount([
      { id: "palette", label: "Command palette", kind: "action", shortcut: "commandPalette", run },
    ]);

    await user.keyboard("{Control>}k{/Control}");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses a command that is disabled", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    mount([
      {
        id: "approve",
        label: "Approve",
        kind: "action",
        shortcut: "approve",
        disabled: true,
        disabledReason: "your role cannot approve at this tier",
        run,
      },
    ]);

    await user.keyboard("a");
    expect(run).not.toHaveBeenCalled();
  });

  it("remembers that a command was run, so the palette can learn", async () => {
    const user = userEvent.setup();
    mount([{ id: "next", label: "Next item", kind: "action", shortcut: "nextItem", run: () => {} }]);

    await user.keyboard("j");
    const stored = window.localStorage.getItem("pv.console.command-use");
    expect(stored).not.toBeNull();
    expect(stored).toContain("next");
  });

  it("stops entirely while something else owns the keyboard", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    mount([{ id: "next", label: "Next item", kind: "action", shortcut: "nextItem", run }], {
      suspended: true,
    });

    await user.keyboard("j");
    expect(run).not.toHaveBeenCalled();
  });
});

/**
 * The defect this whole module exists to prevent, tested on its own.
 *
 * An approver types a rejection reason containing the word "extract". Without
 * the guard the x, the a and the c each do something to the screen behind the
 * field, it looks like data loss, and it is infuriating.
 */
describe("shortcuts while the operator is typing", () => {
  const verbs: readonly { readonly key: string; readonly id: string; readonly shortcut: CommandDefinition["shortcut"] }[] = [
    { key: "j", id: "next", shortcut: "nextItem" },
    { key: "k", id: "previous", shortcut: "previousItem" },
    { key: "x", id: "select", shortcut: "toggleSelection" },
    { key: "a", id: "approve", shortcut: "approve" },
    { key: "r", id: "reject", shortcut: "reject" },
    { key: "c", id: "copilot", shortcut: "focusCopilot" },
    { key: "/", id: "search", shortcut: "search" },
    { key: "?", id: "reference", shortcut: "shortcutReference" },
  ];

  it("fires none of the bare-letter verbs inside a text input", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    mount(
      verbs.map((verb) => ({
        id: verb.id,
        label: verb.id,
        kind: "action" as const,
        shortcut: verb.shortcut,
        run,
      })),
    );

    await user.click(screen.getByLabelText("Reason"));
    await user.keyboard("extract a jar / ?");
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Reason")).toHaveValue("extract a jar / ?");
  });

  it("fires none of them inside a textarea either", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    mount(
      verbs.map((verb) => ({
        id: verb.id,
        label: verb.id,
        kind: "action" as const,
        shortcut: verb.shortcut,
        run,
      })),
    );

    await user.click(screen.getByLabelText("Notes"));
    await user.keyboard("rejected: extract already sent");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not start a G sequence from inside a field", async () => {
    const user = userEvent.setup();
    const queue = vi.fn();
    mount([{ id: "queue", label: "Work queue", kind: "navigate", shortcut: "goQueue", run: queue }]);

    await user.click(screen.getByLabelText("Reason"));
    await user.keyboard("gq");
    expect(queue).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Reason")).toHaveValue("gq");
  });

  it("still opens the palette from inside a field, because that is how you leave one", async () => {
    const user = userEvent.setup();
    const palette = vi.fn();
    mount([
      { id: "palette", label: "Command palette", kind: "action", shortcut: "commandPalette", run: palette },
    ]);

    await user.click(screen.getByLabelText("Reason"));
    await user.keyboard("{Control>}k{/Control}");
    expect(palette).toHaveBeenCalledTimes(1);
  });

  it("still submits a form from inside the field being typed into", async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    mount([{ id: "submit", label: "Submit", kind: "action", shortcut: "submit", run: submit }]);

    await user.click(screen.getByLabelText("Notes"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("lets a command decline a verb the verb itself allows while typing", async () => {
    // Escape is `whileTyping` because escaping a field is what it has always
    // meant. "Escape goes back to the queue" must not fire from inside a
    // half-written rejection reason, which is improvement signal (§3.2).
    const user = userEvent.setup();
    const back = vi.fn();
    mount([
      {
        id: "back",
        label: "Back to approvals",
        kind: "navigate",
        shortcut: "dismiss",
        whileTyping: false,
        run: back,
      },
    ]);

    await user.click(screen.getByLabelText("Reason"));
    await user.keyboard("{Escape}");
    expect(back).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Somewhere to stand" }));
    await user.keyboard("{Escape}");
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("has no accessibility violations", async () => {
    const { container } = mount([]);
    await expectNoAccessibilityViolations(container);
  });
});
