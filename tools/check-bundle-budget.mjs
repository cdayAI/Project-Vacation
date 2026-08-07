#!/usr/bin/env node
/**
 * The one performance budget from design-spec §7 that CI can actually measure.
 *
 * §7 asks for six: route change under 100ms, interaction-to-next-paint under
 * 200ms at p95, zero cumulative layout shift on the hot paths, skeletons only
 * past 300ms, typing never blocked past 120ms, and ten thousand rows without
 * jank. Every one of those is a measurement of a running browser under a
 * throttled network, and this repository has no harness for that — see
 * `docs/handover/not-production-grade.md`.
 *
 * **Transfer size is not a substitute for any of them, and it is not nothing.**
 * It is the one number that bounds all six from below: an operator on a
 * hotel-property network cannot have a 100ms route change if the route costs
 * 400KB to reach. So it is measured here, held to a ceiling, and the ceiling is
 * stated in the units a network delivers — gzipped bytes over the wire — rather
 * than in the units a bundler prints.
 *
 * A budget nobody can raise is a budget somebody will delete. Raising these is
 * a one-line change and it is meant to be: what it is not is silent, because
 * the number is in the diff and the reason belongs in the commit message.
 */

import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const DIST = "packages/console/dist/assets";

/**
 * Ceilings in gzipped kilobytes.
 *
 * Set from the measurement at the time of writing plus roughly 15% of headroom,
 * which is enough that an ordinary feature does not trip it and not enough that
 * a second copy of a component library arrives unnoticed.
 */
const BUDGETS = [
  { label: "JavaScript", extension: ".js", ceilingKb: 190 },
  { label: "CSS", extension: ".css", ceilingKb: 24 },
];

async function main() {
  let entries;
  try {
    entries = await readdir(DIST);
  } catch {
    console.error(
      `No build output at ${DIST}. Run \`pnpm --filter @pv/console build\` first.`,
    );
    process.exitCode = 1;
    return;
  }

  let failed = false;

  for (const budget of BUDGETS) {
    // Source maps are not served to an operator and are not counted.
    const files = entries.filter(
      (name) => name.endsWith(budget.extension) && !name.endsWith(".map"),
    );

    if (files.length === 0) {
      console.error(`No ${budget.label} in the build output. That is not a pass.`);
      failed = true;
      continue;
    }

    let total = 0;
    for (const file of files) {
      total += gzipSync(await readFile(join(DIST, file))).byteLength;
    }

    const kb = total / 1024;
    const within = kb <= budget.ceilingKb;
    const verdict = within ? "within" : "OVER";
    console.log(
      `${budget.label.padEnd(11)} ${kb.toFixed(1).padStart(6)} KB gzipped  ` +
        `(ceiling ${budget.ceilingKb} KB) — ${verdict}`,
    );
    if (!within) failed = true;
  }

  if (failed) {
    console.error(
      "\nOver budget. Either the growth is justified and the ceiling moves in " +
        "this commit with a reason, or something arrived that should not have.",
    );
    process.exitCode = 1;
  }
}

await main();
