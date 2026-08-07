import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Pass 6 — stop a worker mid-step: who notices?
 *
 * The design's answer is good. A commit interrupted between starting an
 * outbound write and recording its result is left in `committing`;
 * `ExecutionService.sweepStaleCommits` (`external/execute.ts:570`) later finds
 * it, moves it to `indeterminate`, and never retries it, so a person is asked
 * to check the system of record. The `EXTERNAL-ACTION-INDETERMINATE` runbook is
 * written entirely around that state existing.
 *
 * Nothing runs the sweeper. It has no caller outside its own tests, and neither
 * does `WorkflowRunner.sweep` (`engine/runner.ts:442`), the loop that advances
 * every due workflow instance and fires statutory timers. There is no worker
 * process in this repository: `serve` starts Fastify and then blocks forever on
 * a promise that never resolves (`cli/main.ts:448`), and `buildPlatform`
 * composes no engine at all — `platform.ts` does not mention it.
 *
 * So in a deployment, nothing advances work over time. Every time-based
 * mechanism in the platform has an implementation and no runner:
 *
 *   - workflow steps that are due, and statutory deadline timers with them;
 *   - stale commits becoming `indeterminate` for a human;
 *   - parked approvals expiring rather than sitting granted forever;
 *   - live external runs being reclaimed after their heartbeat lapses.
 *
 * This was confirmed against a running deployment, not only by reading: with
 * the plane enabled and the operating record populated,
 * `agents parked --status indeterminate` — the first command in the runbook —
 * answers "No parked actions match", and would continue to whatever a dead
 * worker left behind.
 *
 * Two of those consequences are severe on their own. `STATUTORY-TIMER-LATE`
 * pages at SEV1 for a deadline timer that did not fire, and no timer fires. And
 * a stranded commit that is never marked stays invisible: the one state the
 * platform says it cannot resolve for you is also the one it will never tell
 * you about.
 *
 * The check below is a reachability check, in the same shape as Pass 0's: a
 * mechanism whose only callers are its own tests is not shipped, however well
 * it is written and however thoroughly it is tested.
 */

const here = fileURLToPath(import.meta.url);
const srcRoot = here.slice(0, here.indexOf("/review/"));

function shippedSources(directory: string, into: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = `${directory}/${entry}`;
    if (statSync(path).isDirectory()) {
      shippedSources(path, into);
      continue;
    }
    // Tests are excluded on purpose: the question is whether anything a
    // deployment runs reaches these, and a test is not a deployment.
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) into.push(path);
  }
  return into;
}

/** Files that call `name(` on something, other than the file that defines it. */
function callersOf(name: string, definedIn: string): string[] {
  const pattern = new RegExp(`\\.\\s*${name}\\s*\\(`);
  return shippedSources(srcRoot)
    .filter((path) => !path.endsWith(definedIn))
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(srcRoot.length + 1));
}

describe("the mechanisms that advance work over time", () => {
  it("has something that runs the stale-commit sweeper", () => {
    // Without a caller, a commit abandoned by a dead worker stays `committing`
    // forever: never retried, which is right, but also never surfaced, which
    // leaves the effect unresolved and nobody told.
    expect(callersOf("sweepStaleCommits", "external/execute.ts")).not.toEqual([]);
  });

  it("has something that runs the workflow sweep", () => {
    // This is what fires statutory deadline timers. `STATUTORY-TIMER-LATE` is
    // a SEV1 page precisely because a deadline that does not fire is a legal
    // exposure rather than a delayed job.
    expect(callersOf("sweep", "engine/runner.ts")).not.toEqual([]);
  });

  it("composes the workflow engine into the platform a deployment runs", () => {
    // `serve`, the CLI and the console all run on whatever `buildPlatform`
    // returns. If the engine is not in it, no route, verb or screen can reach a
    // workflow at all.
    const platformSource = readFileSync(`${srcRoot}/platform.ts`, "utf8");
    expect(platformSource).toMatch(/engine/i);
  });
});
