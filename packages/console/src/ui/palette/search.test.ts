import { describe, expect, it } from "vitest";
import type { CommandDefinition } from "../../keyboard/registry";
import { normalize, rankCommands, scoreCommand, splitOnMatch, subsequenceMatches } from "./search";

function command(
  id: string,
  label: string,
  overrides: Partial<CommandDefinition> = {},
): CommandDefinition {
  return { id, label, kind: "action", run: () => {}, ...overrides };
}

const COMMANDS: readonly CommandDefinition[] = [
  command("approve", "Approve"),
  command("approve-next", "Approve and open the next item"),
  command("audit", "Go to audit and evidence", { kind: "navigate", keywords: ["evidence", "chain"] }),
  command("queue", "Go to the work queue", { kind: "navigate" }),
  command("export", "Export the audit chain as a regulator pack", {
    hint: "CSV and a print-ready PDF with a cover sheet",
  }),
  command("case", "Case 41823 · Delgado rescission", { kind: "record" }),
];

function labels(query: string, options: Parameters<typeof rankCommands>[2] = {}): string[] {
  return rankCommands(COMMANDS, query, options).map((entry) => entry.command.label);
}

describe("scoring one command", () => {
  it("puts an exact label above a prefix above a contained match", () => {
    const exact = scoreCommand(command("a", "Approve"), "approve").score;
    const prefix = scoreCommand(command("a", "Approve and open the next item"), "approve").score;
    const contained = scoreCommand(command("a", "Bulk approve"), "approve").score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(contained);
  });

  it("treats a word start as better than a match in the middle of a word", () => {
    const wordStart = scoreCommand(command("a", "Go to audit and evidence"), "audit").score;
    const midWord = scoreCommand(command("a", "Reaudited cases"), "audit").score;
    expect(wordStart).toBeGreaterThan(midWord);
  });

  it("finds a command by a keyword that is not in its label", () => {
    const scored = scoreCommand(
      command("a", "Go to audit and evidence", { keywords: ["chain"] }),
      "chain",
    );
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.match).toBeNull();
  });

  it("finds a command by its hint", () => {
    expect(scoreCommand(COMMANDS[4] as CommandDefinition, "regulator").score).toBeGreaterThan(0);
  });

  it("accepts letters typed in order and scores them lowest", () => {
    const spread = scoreCommand(command("a", "Go to audit and evidence"), "gaud");
    expect(spread.score).toBeGreaterThan(0);
    expect(spread.score).toBeLessThan(
      scoreCommand(command("a", "Go to audit and evidence"), "audit").score,
    );
  });

  it("scores nothing for a query the command has no answer to", () => {
    expect(scoreCommand(command("a", "Approve"), "rescission").score).toBe(0);
  });

  it("keeps every command when nothing has been typed", () => {
    expect(scoreCommand(command("a", "Approve"), "").score).toBeGreaterThan(0);
  });

  it("reports where the match sits, for highlighting", () => {
    expect(scoreCommand(command("a", "Go to the work queue"), "work").match).toEqual({
      start: 10,
      end: 14,
    });
  });
});

describe("ranking the list", () => {
  it("filters out what does not match at all", () => {
    expect(labels("approve")).toEqual(["Approve", "Approve and open the next item"]);
  });

  it("prefers the shorter of two labels that matched equally well", () => {
    // "Approve" over "Approve and open the next item": the shorter label is
    // the more specific answer to what was typed.
    expect(labels("approve")[0]).toBe("Approve");
  });

  it("lets what you typed beat what you use", () => {
    // Familiarity settles ties inside a query; it never overrides one. A
    // palette where habit outranks the search argues with the operator.
    const uses = { export: { count: 500, at: Date.now() } };
    expect(labels("approve", { uses })[0]).toBe("Approve");
  });

  it("puts the most familiar first when nothing has been typed", () => {
    const now = Date.now();
    const uses = { case: { count: 20, at: now }, queue: { count: 3, at: now } };
    const ordered = rankCommands(COMMANDS, "", { uses, now });
    expect(ordered[0]?.command.id).toBe("case");
    expect(ordered[1]?.command.id).toBe("queue");
  });

  it("orders an untouched list by kind, so actions come before records", () => {
    const ordered = rankCommands(COMMANDS, "", { uses: {} });
    expect(ordered[0]?.command.kind).toBe("action");
    expect(ordered[ordered.length - 1]?.command.kind).toBe("record");
  });

  it("returns the same order for the same query, twice", () => {
    // A list that reshuffles between two identical searches is a list nobody
    // trusts. Every tie has a deterministic break.
    expect(labels("go")).toEqual(labels("go"));
  });

  it("caps how many rows it returns", () => {
    const many = Array.from({ length: 200 }, (_unused, index) =>
      command(`c${index}`, `Command ${index}`),
    );
    expect(rankCommands(many, "", { limit: 25 })).toHaveLength(25);
  });

  it("ignores surrounding whitespace and case", () => {
    expect(labels("  APPROVE ")).toEqual(labels("approve"));
  });
});

describe("helpers", () => {
  it("normalizes for comparison", () => {
    expect(normalize("  Go To Audit  ")).toBe("go to audit");
  });

  it("finds letters in order", () => {
    expect(subsequenceMatches("go to audit and evidence", "gaud")).toBe(true);
    expect(subsequenceMatches("go to audit", "zzz")).toBe(false);
    expect(subsequenceMatches("anything", "")).toBe(true);
  });

  it("splits a label around its match", () => {
    expect(splitOnMatch("Go to the work queue", { start: 10, end: 14 })).toEqual({
      before: "Go to the ",
      matched: "work",
      after: " queue",
    });
  });

  it("returns the whole label when there is nothing to highlight", () => {
    expect(splitOnMatch("Approve", null)).toEqual({
      before: "Approve",
      matched: "",
      after: "",
    });
  });

  it("refuses a range that does not fit the label rather than slicing nonsense", () => {
    expect(splitOnMatch("Approve", { start: 2, end: 99 }).before).toBe("Approve");
  });
});
