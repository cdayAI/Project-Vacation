import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyChain, formatVerificationResult } from "../audit/chain.js";

/**
 * Pass 10 — the honesty audit, as tests.
 *
 * The premise of this pass is that in a governance product the most serious
 * defect available is a place where the software says it did something it did
 * not do, because the entire value proposition is that the record is true. The
 * same standard applies to what the project says about itself: a README that
 * instructs a sequence which cannot work is the product asserting a capability
 * it does not have, to the first person who reads it.
 *
 * Documentation drifts because nothing fails when it does. These cases are the
 * things that must fail. Each derives its expectation from the source rather
 * than restating it, so the test cannot be satisfied by editing the test.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PLATFORM_ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(PLATFORM_ROOT, "src");

function readRepoFile(...parts: readonly string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), "utf8");
}

describe("what the audit verifier tells an operator", () => {
  /**
   * The renderer is the whole operator-facing surface of chain verification.
   * `pv audit verify` prints this string and nothing else; the structured
   * result is only reachable behind `--json`. So a break that the verifier
   * finds and the renderer does not print is a break nobody sees.
   */
  it("does not report an erased chain as an empty one", () => {
    // The chain reached 34 entries — as the seeded demonstration's does — and
    // every one of them has been deleted. `verifyChain` catches this, because
    // the durable watermark says how far the chain had got.
    const result = verifyChain([], undefined, { maxSeq: 34, headHash: "sha256:whatever" });
    expect(result.intact).toBe(false);
    expect(result.breaks.map((problem) => problem.kind)).toContain("chain_truncated");

    const rendered = formatVerificationResult(result);

    // "Nothing to verify" is what a system with no history says. A system whose
    // history was deleted must not say the same words: it is the difference
    // between "we have no evidence yet" and "our evidence has been destroyed",
    // and an operator reading the second as the first stands down.
    expect(rendered).not.toBe("Audit chain is empty. Nothing to verify.");
    expect(rendered).toMatch(/BROKEN/);
    expect(rendered).toContain("chain_truncated");
    expect(rendered).toContain("Every entry has been deleted");
  });

  /**
   * The counterpart, and the reason the case above is a renderer fix rather
   * than a message change: on a genuinely fresh deployment an empty chain is
   * correct and must not read as an alarm. What it must also not read as is a
   * verification that succeeded.
   */
  it("says plainly that an empty chain was not verified, rather than implying it passed", () => {
    const result = verifyChain([], undefined, null);
    expect(result.intact).toBe(true);

    const rendered = formatVerificationResult(result);

    expect(rendered).not.toMatch(/BROKEN/);
    expect(rendered).not.toMatch(/INTACT/);
    // The failure this closes: `pnpm audit:verify` after `pnpm demo` printed
    // "Audit chain is empty. Nothing to verify." and exited zero, which a
    // reader following the README took for a passing verification of the chain
    // the demonstration had just written. Nothing had been verified at all.
    expect(rendered.toLowerCase()).toContain("nothing was verified");
  });
});

describe("what the README instructs", () => {
  const readme = readRepoFile("README.md");

  /**
   * Every fenced command a reader is told to run, pulled out of the document
   * rather than listed here, so a newly-added instruction is covered the day it
   * is added.
   */
  function pnpmScriptsInvoked(markdown: string): readonly string[] {
    const found = new Set<string>();
    for (const match of markdown.matchAll(/(?:^|[\s`|])pnpm ([a-z][a-z0-9:_-]*)/gm)) {
      const name = match[1];
      if (name !== undefined) found.add(name);
    }
    return [...found].sort();
  }

  it("names only pnpm scripts that exist", () => {
    const rootScripts = JSON.parse(readRepoFile("package.json")).scripts as Record<string, string>;
    // `pnpm install` and `pnpm -r <script>` are pnpm's own verbs, not scripts.
    const pnpmOwnVerbs = new Set(["install", "exec", "run", "add", "why", "licenses", "audit"]);

    const missing = pnpmScriptsInvoked(readme).filter(
      (name) => !pnpmOwnVerbs.has(name) && !(name in rootScripts),
    );

    expect(missing, `The README instructs pnpm scripts that package.json does not define: ${missing.join(", ")}`).toEqual([]);
  });

  it("names only ADRs that exist", () => {
    const adrs = new Set(
      readdirSync(join(REPO_ROOT, "docs", "adr")).map((file) => file.slice(0, 4)),
    );
    const cited = [...readme.matchAll(/ADR (\d{4})/g)].map((match) => match[1] ?? "");
    const missing = [...new Set(cited)].filter((number) => !adrs.has(number));

    expect(missing, `The README cites ADRs that do not exist: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * Undocumented surface area is a defect in its own right — Pass 0's rule.
   * The README's tree is the map a new engineer reads before anything else, and
   * a module missing from it is a module they will not know to look for. The
   * external-agent plane was missing from it, which is the largest single
   * surface in the platform.
   */
  it("maps every module directory in the platform source", () => {
    const modules = readdirSync(SRC, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // `review/` is this verification pass's own tests, not product surface.
      .filter((name) => name !== "review")
      .sort();

    const undocumented = modules.filter((name) => !readme.includes(`  ${name}/`));

    expect(
      undocumented,
      `These module directories exist in packages/platform/src and are absent from the README's map: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });
});

describe("what the architecture document states", () => {
  const architecture = readRepoFile("docs", "architecture.md");
  const architectureTest = readFileSync(join(SRC, "architecture.test.ts"), "utf8");

  /**
   * The layering table is presented as a description of an enforced rule. If it
   * drifts from the rule, it stops being a description and becomes a claim —
   * and a reader deciding where to put a new module would be misled by it.
   */
  it("lists every module the layering test enforces", () => {
    const declared = [...architectureTest.matchAll(/^\s{2}([a-z]+): (-?\d+),$/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(declared.length).toBeGreaterThan(15);

    // Read only the fenced layering table, not the surrounding prose — the word
    // "review" appears in §4.2 as "a compliance reviewer", which would make a
    // whole-document search pass on a table that never mentions the layer.
    const table = /```\n(layer[\s\S]*?)```/.exec(architecture)?.[1];
    expect(table, "docs/architecture.md §2 no longer contains a fenced layering table").toBeTruthy();

    const missing = declared.filter((name) => !(table ?? "").includes(name));

    expect(
      missing,
      `docs/architecture.md §2 omits modules the architecture test places in the layering: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
