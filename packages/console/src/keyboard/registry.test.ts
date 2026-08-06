import { describe, expect, it, vi } from "vitest";
import { CommandRegistry, type CommandDefinition } from "./registry";

function command(overrides: Partial<CommandDefinition> & { readonly id: string }): CommandDefinition {
  return {
    label: overrides.id,
    kind: "action",
    run: () => {},
    ...overrides,
  };
}

describe("the command registry", () => {
  it("holds nothing until a source is registered", () => {
    expect(new CommandRegistry().commands()).toEqual([]);
  });

  it("reads a source afresh rather than keeping the array it was given", () => {
    // The reason sources exist: a screen's commands close over the row that is
    // focused, so a registry holding the array from mount time would approve
    // whatever the operator was looking at when the screen loaded.
    const registry = new CommandRegistry();
    let label = "Approve case 1";
    registry.registerSource("screen", () => [command({ id: "approve", label })]);

    expect(registry.commands()[0]?.label).toBe("Approve case 1");
    label = "Approve case 2";
    expect(registry.commands()[0]?.label).toBe("Approve case 2");
  });

  it("drops a source's commands when it unregisters", () => {
    const registry = new CommandRegistry();
    const release = registry.registerSource("screen", () => [command({ id: "approve" })]);
    expect(registry.commands()).toHaveLength(1);
    release();
    expect(registry.commands()).toHaveLength(0);
  });

  it("is safe to release a source twice", () => {
    const registry = new CommandRegistry();
    const release = registry.registerSource("screen", () => [command({ id: "a" })]);
    release();
    release();
    expect(registry.commands()).toHaveLength(0);
  });

  it("lets the most recently registered source win a shared id", () => {
    // The shell registers a `/` that opens the palette; a screen with a real
    // search field registers the same id and mounts later.
    const registry = new CommandRegistry();
    registry.registerSource("shell", () => [command({ id: "search", label: "Open the palette" })]);
    registry.registerSource("screen", () => [command({ id: "search", label: "Filter the queue" })]);

    expect(registry.commands()).toHaveLength(1);
    expect(registry.commands()[0]?.label).toBe("Filter the queue");
  });

  it("finds the command bound to a verb", () => {
    const registry = new CommandRegistry();
    registry.registerSource("screen", () => [command({ id: "approve", shortcut: "approve" })]);
    expect(registry.commandForShortcut("approve")?.id).toBe("approve");
    expect(registry.commandForShortcut("reject")).toBeUndefined();
  });

  it("reports only the verbs something is actually bound to", () => {
    const registry = new CommandRegistry();
    registry.registerSource("screen", () => [
      command({ id: "approve", shortcut: "approve" }),
      command({ id: "next", shortcut: "nextItem" }),
    ]);

    expect(registry.availableShortcuts().map((definition) => definition.id).sort()).toEqual([
      "approve",
      "nextItem",
    ]);
  });

  it("does not report a verb whose command is refused", () => {
    // A disabled command must not make its key appear live in the reference,
    // or the operator presses it and concludes the keyboard is broken.
    const registry = new CommandRegistry();
    registry.registerSource("screen", () => [
      command({ id: "approve", shortcut: "approve", disabled: true }),
    ]);
    expect(registry.availableShortcuts()).toHaveLength(0);
  });

  it("notifies subscribers and moves its revision when the world changes", () => {
    const registry = new CommandRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const before = registry.getRevision();

    const release = registry.registerSource("screen", () => []);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getRevision()).toBeGreaterThan(before);

    release();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registry.registerSource("other", () => []);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("counts suspensions rather than flipping a flag", () => {
    // A sheet that opens a confirmation modal is a real flow, and the modal
    // closing must not resume global keys under a sheet that is still up.
    const registry = new CommandRegistry();
    expect(registry.suspended).toBe(false);

    const sheet = registry.suspend();
    const modal = registry.suspend();
    expect(registry.suspended).toBe(true);

    modal();
    expect(registry.suspended).toBe(true);
    sheet();
    expect(registry.suspended).toBe(false);
  });

  it("is safe to release a suspension twice", () => {
    const registry = new CommandRegistry();
    const release = registry.suspend();
    release();
    release();
    expect(registry.suspended).toBe(false);
  });
});
