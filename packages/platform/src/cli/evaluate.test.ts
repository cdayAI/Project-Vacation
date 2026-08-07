import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PromptTemplateRegistry } from "../models/templates.js";
import { assertGoldenSet, checkThreshold } from "../roles/evaluation.js";
import type { CaseResult } from "../roles/types.js";
import {
  BASELINE_GOLDEN_SET,
  BASELINE_ROLE_DEFINITION,
  SCREEN_REFUSAL,
  evaluateBaseline,
  exitCodeFor,
  type EvaluationOutcome,
} from "./evaluate.js";

/**
 * The golden-set evaluation gate.
 *
 * Two kinds of test, because the gate has two kinds of property.
 *
 * The unit tests hold the *claims the shipped fixture makes* still. It claims
 * six crafted packets are refused by the boundary screen and two ordinary ones
 * are not; if either half stopped being true the accuracy would stay plausible
 * while the set measured something else entirely, so both are asserted
 * case-by-case rather than through the aggregate.
 *
 * The subprocess tests hold the *gate* still: the exit code, and the separation
 * of the diagnostic banner from the answer. Neither is observable from inside
 * the process, and both are the whole reason continuous integration can rely on
 * this command.
 */

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "main.ts");
const TSX = resolve(HERE, "../../node_modules/.bin/tsx");

/**
 * Run the command line the way a cold continuous-integration checkout would.
 *
 * Every `PV_` variable is stripped rather than overridden, so the test cannot
 * pass because of something the developer happens to have exported — which is
 * exactly the difference between "works here" and "works in CI".
 */
async function cli(args: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("PV_") || value === undefined) continue;
    env[key] = value;
  }
  try {
    const result = await run(TSX, [CLI, ...args], { env, timeout: 60_000 });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

function caseNamed(results: readonly CaseResult[], id: string): CaseResult {
  const found = results.find((result) => result.caseId === id);
  if (!found) throw new Error(`The shipped golden set no longer contains a case "${id}".`);
  return found;
}

/**
 * A passing and a failing outcome, both built from one real run.
 *
 * Judging genuine results against a bar they cannot reach is a more honest
 * failing case than a hand-built stub: it exercises `checkThreshold` on real
 * data rather than asserting that a literal `false` is treated as false.
 */
async function realOutcomes(): Promise<{
  readonly passing: EvaluationOutcome;
  readonly failing: EvaluationOutcome;
}> {
  const outcome = await evaluateBaseline();
  return {
    passing: outcome,
    failing: { ...outcome, report: checkThreshold(outcome.run, { threshold: 1.5 }) },
  };
}

describe("the golden set shipped in source", () => {
  it("is structurally valid against the prompt template it names", () => {
    const template = new PromptTemplateRegistry().require(
      BASELINE_ROLE_DEFINITION.promptTemplateId,
      BASELINE_ROLE_DEFINITION.promptTemplateVersion,
    );
    // Catches the case that would otherwise surface as eight errored cases on
    // someone else's pull request: a prompt template gaining or losing a
    // variable and orphaning the fixture.
    expect(() => assertGoldenSet(BASELINE_GOLDEN_SET, template.variables)).not.toThrow();
  });

  it("measures the task the baseline role actually runs", () => {
    expect(BASELINE_GOLDEN_SET.task).toBe(BASELINE_ROLE_DEFINITION.modelTask);
    expect(BASELINE_GOLDEN_SET.id).toBe(BASELINE_ROLE_DEFINITION.evaluationSetId);
  });

  it("demands every case, because no case here turns on a model's judgement", () => {
    expect(BASELINE_GOLDEN_SET.threshold).toBe(1);
  });

  it("holds both halves: packets that must be refused and packets that must not", () => {
    const refusals = BASELINE_GOLDEN_SET.cases.filter(
      (entry) => entry.expected.kind === "refusal",
    );
    const clean = BASELINE_GOLDEN_SET.cases.filter((entry) => entry.expected.kind === "any");
    // A set made only of attacks passes just as well against a screen that
    // refuses everything, which is a broken screen. Both halves are required.
    expect(refusals.length).toBeGreaterThan(0);
    expect(clean.length).toBeGreaterThan(0);
    expect(refusals.length + clean.length).toBe(BASELINE_GOLDEN_SET.cases.length);
  });

  it("is marked synthetic and carries no protected-class attributes", () => {
    expect(BASELINE_GOLDEN_SET.synthetic).toBe(true);
    for (const entry of BASELINE_GOLDEN_SET.cases) {
      expect(entry.protectedAttributes).toBeUndefined();
    }
  });
});

describe("running the baseline", () => {
  it("clears its bar with no database, no key, and no network", async () => {
    const outcome = await evaluateBaseline();
    expect(outcome.run.caseCount).toBe(BASELINE_GOLDEN_SET.cases.length);
    expect(outcome.run.errored).toBe(0);
    expect(outcome.run.failed).toBe(0);
    expect(outcome.report.passed).toBe(true);
  });

  it("refuses every crafted packet at the boundary screen, on the stated ground", async () => {
    const outcome = await evaluateBaseline();
    const crafted = BASELINE_GOLDEN_SET.cases.filter(
      (entry) => entry.expected.kind === "refusal",
    );

    for (const entry of crafted) {
      const result = caseNamed(outcome.run.results, entry.id);
      // The denial reason is asserted, not just the pass. A case that refused
      // for some other reason — a ceiling, a missing template — would score as
      // a pass on the aggregate while proving nothing about the screen.
      expect(result.denialReason, `case ${entry.id} was not refused`).toBe(SCREEN_REFUSAL);
      expect(result.outcome, `case ${entry.id}`).toBe("passed");
    }
  });

  it("answers the ordinary packets rather than refusing them", async () => {
    const outcome = await evaluateBaseline();
    const clean = BASELINE_GOLDEN_SET.cases.filter((entry) => entry.expected.kind === "any");

    for (const entry of clean) {
      const result = caseNamed(outcome.run.results, entry.id);
      expect(result.denialReason, `case ${entry.id} was refused`).toBeUndefined();
      // A digest is only recorded when a provider actually answered, so this is
      // the evidence that the call went through rather than being short-circuited.
      expect(result.responseDigest, `case ${entry.id}`).toBeDefined();
      expect(result.outcome, `case ${entry.id}`).toBe("passed");
    }
  });

  it("reproduces exactly, so a failure can be reproduced from the commit alone", async () => {
    const first = await evaluateBaseline();
    const second = await evaluateBaseline();

    expect(second.run.id).toBe(first.run.id);
    expect(second.run.goldenSetDigest).toBe(first.run.goldenSetDigest);
    expect(second.run.accuracy).toBe(first.run.accuracy);
    expect(second.run.totalCostUsd).toBe(first.run.totalCostUsd);
    expect(second.run.results.map((entry) => entry.responseDigest)).toEqual(
      first.run.results.map((entry) => entry.responseDigest),
    );
  });

});

describe("the exit code", () => {
  it("is non-zero when a run does not clear the bar it is judged against", async () => {
    const { failing } = await realOutcomes();
    expect(failing.report.passed).toBe(false);
    expect(exitCodeFor([failing])).toBe(1);
  });

  it("is zero only when everything measured cleared its bar", async () => {
    const { passing, failing } = await realOutcomes();
    expect(exitCodeFor([passing, passing])).toBe(0);
    // One failure among passes must still fail. An aggregate that averaged
    // across roles would let a broken role hide behind a healthy one.
    expect(exitCodeFor([passing, failing])).toBe(1);
  });

  it("is non-zero when nothing was measured at all", () => {
    // The failure this whole command exists to prevent: a gate that passes
    // silently over an empty set passes forever and nobody notices.
    expect(exitCodeFor([])).toBe(1);
  });
});

describe("the command line", () => {
  it("passes the gate from a cold checkout with nothing configured", async () => {
    const result = await cli(["evaluate", "--ci"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/8\/8 passed/);
    expect(result.stdout).toMatch(/PASS/);
  });

  it("says loudly, on stderr, that the registry measured nothing", async () => {
    const result = await cli(["evaluate", "--ci"]);
    expect(result.stderr).toMatch(/NOTHING IN THIS DEPLOYMENT'S ROLE REGISTRY WAS EVALUATED/);
    expect(result.stderr).toMatch(/does NOT measure model accuracy/);
    // The banner is a diagnostic about the shape of the run, not the answer.
    // On stdout it would corrupt an evidence file and break `| jq`.
    expect(result.stdout).not.toMatch(/NOTHING IN THIS DEPLOYMENT/);
  });

  it("keeps stdout parseable so the result can be redirected into evidence", async () => {
    const result = await cli(["evaluate", "--ci", "--json"]);
    expect(result.code).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout) as {
      mode: string;
      registry: { evaluated: boolean; outcomes: unknown[] };
      baseline: { caseCount: number; meetsThreshold: boolean } | null;
      passed: boolean;
    };
    expect(parsed.mode).toBe("ci");
    expect(parsed.registry.evaluated).toBe(false);
    expect(parsed.registry.outcomes).toEqual([]);
    expect(parsed.baseline?.meetsThreshold).toBe(true);
    expect(parsed.passed).toBe(true);
  });

  it("without --ci reports the registry it can see and does not run the baseline", async () => {
    const result = await cli(["evaluate"]);
    // An operator asking "how are my roles doing" on a deployment with no
    // durable registry has been answered truthfully, which is not a failure.
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Nothing was evaluated/);
    expect(result.stdout).not.toMatch(/baseline/);
    expect(result.stderr).toMatch(/in-memory store/);
  });

  it("rejects a subcommand it does not have rather than ignoring it", async () => {
    const result = await cli(["evaluate", "everything"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/takes no subcommand/);
  });
});
