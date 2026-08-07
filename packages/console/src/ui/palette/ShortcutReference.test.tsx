import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KeyboardProvider, useCommandSource } from "../../keyboard/KeyboardProvider";
import { CommandRegistry, type CommandDefinition } from "../../keyboard/registry";
import { SHORTCUT_LIST } from "../../keyboard/shortcuts";
import { expectNoAccessibilityViolations } from "../../test/axe";
import { ShortcutReference } from "./ShortcutReference";

function Source({ commands }: { readonly commands: readonly CommandDefinition[] }) {
  useCommandSource(commands);
  return null;
}

function mount({
  commands = [],
  onClose = () => {},
}: {
  readonly commands?: readonly CommandDefinition[];
  readonly onClose?: () => void;
} = {}) {
  const registry = new CommandRegistry();
  return render(
    <KeyboardProvider registry={registry}>
      <Source commands={commands} />
      <main>
        <ShortcutReference open onClose={onClose} />
      </main>
    </KeyboardProvider>,
  );
}

describe("the shortcut reference", () => {
  it("lists every verb in the table, so there is no second list to drift", () => {
    mount();
    const dialog = within(screen.getByRole("dialog"));
    for (const definition of SHORTCUT_LIST) {
      // getAllBy: the reference's own verb is called "Keyboard shortcuts" and
      // so is the dialog it is printed in.
      expect(
        dialog.getAllByText(definition.label).length,
        `${definition.id} is missing`,
      ).toBeGreaterThan(0);
    }
  });

  it("groups the verbs by when an operator reaches for them", () => {
    mount();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("heading", { name: "Getting around" })).toBeInTheDocument();
    expect(dialog.getByRole("heading", { name: "Working a list" })).toBeInTheDocument();
    expect(dialog.getByRole("heading", { name: "Deciding" })).toBeInTheDocument();
    expect(dialog.getByRole("heading", { name: "Everywhere" })).toBeInTheDocument();
  });

  it("prints the keys beside each verb", () => {
    mount();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Ctrl K")).toBeInTheDocument();
    expect(dialog.getByText("G then Q")).toBeInTheDocument();
    expect(dialog.getByText("Space")).toBeInTheDocument();
  });

  it("says which verbs do nothing on this screen", () => {
    // "I pressed A and nothing happened" becomes an answer rather than a bug
    // report. Nothing is bound here, so every row says so.
    mount();
    expect(screen.getAllByText(/not on this screen/).length).toBe(SHORTCUT_LIST.length);
  });

  it("stops saying so once a screen binds the verb", () => {
    mount({
      commands: [{ id: "approve", label: "Approve", kind: "action", shortcut: "approve", run: () => {} }],
    });
    // One fewer than the whole table: approve is now live.
    expect(screen.getAllByText(/not on this screen/).length).toBe(SHORTCUT_LIST.length - 1);
  });

  it("names where each verb applies, in words", () => {
    mount();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getAllByText(/On an approval/).length).toBeGreaterThan(0);
    expect(dialog.getAllByText(/In a list/).length).toBeGreaterThan(0);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mount({ onClose });

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("has no accessibility violations", async () => {
    const { baseElement } = mount();
    await expectNoAccessibilityViolations(baseElement);
  });
});
