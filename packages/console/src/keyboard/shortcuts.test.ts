import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  SHORTCUT_LIST,
  SHORTCUT_SECTIONS,
  chordMatches,
  displaySequence,
  formatSequence,
  isModifierPress,
  isTypingTarget,
  resolveKeyPress,
  shortcutById,
  type KeyPress,
  type ShortcutDefinition,
} from "./shortcuts";

function press(key: string, modifiers: Partial<Omit<KeyPress, "key">> = {}): KeyPress {
  return {
    key,
    metaKey: modifiers.metaKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    altKey: modifiers.altKey ?? false,
  };
}

const ALL: readonly ShortcutDefinition[] = SHORTCUT_LIST;

describe("the shortcut table", () => {
  it("carries every row of specification §5", () => {
    // Named individually rather than counted: a count passes when somebody
    // deletes one row and adds another.
    expect(Object.keys(SHORTCUTS).sort()).toEqual(
      [
        "approve",
        "commandPalette",
        "dismiss",
        "focusCopilot",
        "goApprovals",
        "goEvidence",
        "goQueue",
        "goSettings",
        "nextItem",
        "openItem",
        "previewItem",
        "previousItem",
        "reject",
        "search",
        "shortcutReference",
        "submit",
        "toggleSelection",
      ].sort(),
    );
  });

  it("gives every row a unique id that matches its key in the table", () => {
    for (const [key, definition] of Object.entries(SHORTCUTS)) {
      expect(definition.id).toBe(key);
    }
    expect(new Set(ALL.map((definition) => definition.id)).size).toBe(ALL.length);
  });

  it("gives every row a label, a description, and at least one way to press it", () => {
    for (const definition of ALL) {
      expect(definition.label.length, `${definition.id} has no label`).toBeGreaterThan(0);
      expect(definition.description.length, `${definition.id} has no description`).toBeGreaterThan(0);
      expect(definition.sequences.length, `${definition.id} has no keys`).toBeGreaterThan(0);
      expect(SHORTCUT_SECTIONS).toContain(definition.section);
    }
  });

  it("lets only the three verbs that must fire while typing do so", () => {
    const whileTyping = ALL.filter((definition) => definition.whileTyping === true).map(
      (definition) => definition.id,
    );
    // Every other verb is a bare letter, and a bare letter that fires
    // mid-sentence is the defect the guard exists to prevent.
    expect(whileTyping.sort()).toEqual(["commandPalette", "dismiss", "submit"]);
  });

  it("does not bind two verbs to the same single chord", () => {
    const seen = new Map<string, string>();
    for (const definition of ALL) {
      for (const sequence of definition.sequences) {
        if (sequence.length !== 1) continue;
        const chord = sequence[0];
        if (chord === undefined) continue;
        const signature = `${chord.key.toLowerCase()}|${chord.meta ?? false}|${chord.ctrl ?? false}|${chord.alt ?? false}`;
        const existing = seen.get(signature);
        expect(existing, `${definition.id} collides with ${existing ?? ""}`).toBeUndefined();
        seen.set(signature, definition.id);
      }
    }
  });

  it("looks a row up by id", () => {
    expect(shortcutById("approve").label).toBe("Approve");
  });
});

describe("chord matching", () => {
  it("matches a letter case-insensitively, so Caps Lock is not a different key", () => {
    expect(chordMatches({ key: "j" }, press("j"))).toBe(true);
    expect(chordMatches({ key: "j" }, press("J"))).toBe(true);
  });

  it("refuses a letter that arrives with Shift held", () => {
    // Shift+J is the table's range-select. A plain J that also fired on it
    // would move the cursor while extending a selection.
    expect(chordMatches({ key: "j" }, press("j", { shiftKey: true }))).toBe(false);
  });

  it("ignores Shift for a printable character that needs it on some layouts", () => {
    expect(chordMatches({ key: "?", shift: "any" }, press("?", { shiftKey: true }))).toBe(true);
    expect(chordMatches({ key: "?", shift: "any" }, press("?"))).toBe(true);
  });

  it("requires the modifier a chord names and refuses the one it does not", () => {
    expect(chordMatches({ key: "k", meta: true }, press("k", { metaKey: true }))).toBe(true);
    expect(chordMatches({ key: "k", meta: true }, press("k"))).toBe(false);
    expect(chordMatches({ key: "k" }, press("k", { metaKey: true }))).toBe(false);
  });

  it("knows a modifier held on its own is not a keystroke", () => {
    expect(isModifierPress(press("Meta"))).toBe(true);
    expect(isModifierPress(press("Shift"))).toBe(true);
    expect(isModifierPress(press("g"))).toBe(false);
  });
});

describe("resolving a key press", () => {
  it("matches a single chord", () => {
    const result = resolveKeyPress(ALL, [], press("k", { metaKey: true }));
    expect(result.kind).toBe("match");
    if (result.kind === "match") expect(result.shortcut.id).toBe("commandPalette");
  });

  it("accepts either half of an alternative, so ⌘K and Ctrl+K are one verb", () => {
    const meta = resolveKeyPress(ALL, [], press("k", { metaKey: true }));
    const control = resolveKeyPress(ALL, [], press("k", { ctrlKey: true }));
    expect(meta.kind).toBe("match");
    expect(control.kind).toBe("match");
  });

  it("holds a sequence open after its first key and completes it on the second", () => {
    const first = resolveKeyPress(ALL, [], press("g"));
    expect(first.kind).toBe("pending");
    if (first.kind !== "pending") return;

    const second = resolveKeyPress(ALL, first.pressed, press("q"));
    expect(second.kind).toBe("match");
    if (second.kind === "match") expect(second.shortcut.id).toBe("goQueue");
  });

  it("abandons a sequence whose second key belongs to nothing", () => {
    const first = resolveKeyPress(ALL, [], press("g"));
    if (first.kind !== "pending") throw new Error("expected G to open a sequence");
    expect(resolveKeyPress(ALL, first.pressed, press("z")).kind).toBe("none");
  });

  it("does not open a sequence whose verb nobody has bound", () => {
    // The whole reason `available` is the bound subset: a G that opens a
    // sequence on a screen where no destination exists eats the next key, and
    // a keyboard that eats keystrokes is the worst way this pattern fails.
    const withoutNavigation = ALL.filter((definition) => !definition.id.startsWith("go"));
    expect(resolveKeyPress(withoutNavigation, [], press("g")).kind).toBe("none");
  });

  it("carries a held modifier through without clearing a half-typed sequence", () => {
    const first = resolveKeyPress(ALL, [], press("g"));
    if (first.kind !== "pending") throw new Error("expected G to open a sequence");

    const holdingMeta = resolveKeyPress(ALL, first.pressed, press("Meta"));
    expect(holdingMeta.kind).toBe("pending");
    if (holdingMeta.kind === "pending") expect(holdingMeta.pressed).toEqual(first.pressed);
  });

  it("returns none for a key nothing wants", () => {
    expect(resolveKeyPress(ALL, [], press("z")).kind).toBe("none");
  });
});

describe("the typing guard", () => {
  function element(html: string): Element {
    const host = document.createElement("div");
    host.innerHTML = html;
    const child = host.firstElementChild;
    if (child === null) throw new Error("no element");
    document.body.append(host);
    return child;
  }

  it("treats a text input, a textarea, and a select as typing", () => {
    expect(isTypingTarget(element("<input />"))).toBe(true);
    expect(isTypingTarget(element('<input type="search" />'))).toBe(true);
    expect(isTypingTarget(element("<textarea></textarea>"))).toBe(true);
    expect(isTypingTarget(element("<select></select>"))).toBe(true);
  });

  it("treats contenteditable as typing, including a node inside one", () => {
    const editor = element('<div contenteditable="true"><span>text</span></div>');
    expect(isTypingTarget(editor)).toBe(true);
    expect(isTypingTarget(editor.querySelector("span"))).toBe(true);
  });

  it("does not treat contenteditable=false as typing", () => {
    expect(isTypingTarget(element('<div contenteditable="false">text</div>'))).toBe(false);
  });

  it("does not treat a checkbox or a radio as typing", () => {
    // A queue operator's focus lives on a row's selection box. Treating it as
    // typing would stop J and K working exactly where they are needed.
    expect(isTypingTarget(element('<input type="checkbox" />'))).toBe(false);
    expect(isTypingTarget(element('<input type="radio" />'))).toBe(false);
    expect(isTypingTarget(element('<input type="button" />'))).toBe(false);
  });

  it("treats an ARIA text field as typing", () => {
    expect(isTypingTarget(element('<div role="textbox"></div>'))).toBe(true);
    expect(isTypingTarget(element('<div role="combobox"></div>'))).toBe(true);
  });

  it("does not treat a button, a link, or the body as typing", () => {
    expect(isTypingTarget(element("<button>Go</button>"))).toBe(false);
    expect(isTypingTarget(element('<a href="/work">Queue</a>'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("printing a shortcut", () => {
  it("spells out the modifier away from Apple platforms", () => {
    expect(formatSequence([{ key: "k", meta: true }], { apple: false })).toBe("Meta K");
    expect(formatSequence([{ key: "k", ctrl: true }], { apple: false })).toBe("Ctrl K");
  });

  it("uses the glyphs on an Apple platform", () => {
    expect(formatSequence([{ key: "k", meta: true }], { apple: true })).toBe("⌘K");
  });

  it("writes a sequence as the two keys, in order", () => {
    expect(formatSequence([{ key: "g" }, { key: "q" }], { apple: false })).toBe("G then Q");
  });

  it("names the keys that have no glyph", () => {
    expect(formatSequence([{ key: " " }], { apple: false })).toBe("Space");
    expect(formatSequence([{ key: "Escape" }], { apple: false })).toBe("Esc");
  });

  it("picks the half of an alternative that applies to this platform", () => {
    // A row reading "⌘K or Ctrl K" makes the operator work out which half is
    // theirs. Pick the one that is.
    expect(displaySequence(SHORTCUTS.commandPalette, { apple: true })).toBe("⌘K");
    expect(displaySequence(SHORTCUTS.commandPalette, { apple: false })).toBe("Ctrl K");
  });
});
