#!/usr/bin/env node
/**
 * Accessibility coverage check.
 *
 * The console's WCAG assertions live inside its ordinary test suite, which
 * means they can stop running without anything failing: delete the assertion,
 * or add a new view and forget one, and the suite still goes green. That is the
 * exact way an accessibility gate rots — quietly, while the badge stays green.
 *
 * This check closes that gap. It walks the console's view components and
 * asserts that each one has a corresponding automated accessibility assertion.
 * A new view with no axe assertion fails the build.
 *
 * It verifies coverage, not correctness. The assertions themselves are what
 * check WCAG conformance, and neither this script nor those assertions replace
 * a manual keyboard-only and screen-reader pass — automated tooling catches
 * roughly the machine-detectable half of WCAG 2.2 AA. See ADR 0014.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

const VIEWS_DIR = "packages/console/src/views";
const TEST_GLOB_DIRS = ["packages/console/src"];

/** Files that are not user-facing views and therefore need no axe assertion. */
const EXEMPT = new Set(["index.ts", "index.tsx", "types.ts"]);

async function collectFiles(dir, predicate, found = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(full, predicate, found);
    else if (predicate(entry.name)) found.push(full);
  }
  return found;
}

async function main() {
  if (!existsSync(VIEWS_DIR)) {
    console.error(
      `accessibility coverage: ${VIEWS_DIR} does not exist yet — nothing to check.`,
    );
    // Not a failure: the console may not be built out yet. It becomes a
    // failure the moment a view exists without an assertion.
    return;
  }

  const views = (
    await collectFiles(VIEWS_DIR, (name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
  ).filter((path) => !EXEMPT.has(basename(path)));

  if (views.length === 0) {
    console.error("accessibility coverage: no view components found — nothing to check.");
    return;
  }

  const testFiles = [];
  for (const dir of TEST_GLOB_DIRS) {
    testFiles.push(...(await collectFiles(dir, (name) => name.endsWith(".test.tsx") || name.endsWith(".test.ts"))));
  }

  const testSources = await Promise.all(
    testFiles.map(async (path) => ({ path, text: await readFile(path, "utf8") })),
  );

  // A view is covered when some test file both names it and runs an axe check.
  const axePattern = /\baxe\s*\(|toHaveNoViolations|expectNoAccessibilityViolations/;
  const uncovered = [];

  for (const view of views) {
    const name = basename(view, extname(view));
    const covered = testSources.some(
      (source) => source.text.includes(name) && axePattern.test(source.text),
    );
    if (!covered) uncovered.push(view);
  }

  const total = views.length;
  const covered = total - uncovered.length;

  if (uncovered.length > 0) {
    console.error(
      `accessibility coverage: ${covered}/${total} views have an automated accessibility assertion.\n` +
        `The following views have none. Add one before merging — see ADR 0014.\n` +
        uncovered.map((path) => `  - ${path}`).join("\n"),
    );
    process.exit(1);
  }

  console.error(
    `accessibility coverage: ${covered}/${total} console views carry an automated accessibility assertion.`,
  );
}

main().catch((error) => {
  console.error(`accessibility coverage check failed: ${error?.message ?? error}`);
  process.exit(1);
});
