import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENV_KEYS } from "../kernel/config.js";

/**
 * Pass 2, group five — the configuration surface, listed in full.
 *
 * `kernel/config.ts` ends with "Configuration comes from the environment. See
 * .env.example.", and the CLI's usage text says the same. That makes
 * `.env.example` the documented surface, not a convenience: it is where an
 * operator looks to find out what they can set and what the safe value is.
 *
 * A key that exists in the loader and not in that file is a control nobody can
 * find. The eleven that were missing when this test was written all governed
 * the external-agent plane, including the switch that opens its inbound surface
 * and the one that decides whether a bearer token is still accepted from an
 * agent holding a signing key.
 *
 * Two directions, because both drift. A documented key the loader does not read
 * is worse than an undocumented one: an operator sets it, sees no error, and
 * believes a limit is in force.
 */

const ENV_EXAMPLE = fileURLToPath(new URL("../../../../.env.example", import.meta.url));

/** Keys the loader does not read, but which belong in the file anyway. */
const TEST_ONLY_KEYS = new Set(["PV_TEST_DATABASE_URL"]);

function documentedKeys(): ReadonlySet<string> {
  const text = readFileSync(ENV_EXAMPLE, "utf8");
  // Commented-out entries count as documented: `# PV_ANTHROPIC_API_KEY=` tells
  // an operator the key exists and that it is deliberately unset.
  return new Set([...text.matchAll(/^#?\s*(PV_[A-Z0-9_]+)=/gm)].map((match) => match[1] as string));
}

describe("the documented configuration surface", () => {
  it("documents every environment variable the loader reads", () => {
    const documented = documentedKeys();
    const missing = Object.values(ENV_KEYS).filter((key) => !documented.has(key));
    expect(missing).toEqual([]);
  });

  it("reads every environment variable it documents", () => {
    const declared = new Set<string>(Object.values(ENV_KEYS));
    const stale = [...documentedKeys()].filter(
      (key) => !declared.has(key) && !TEST_ONLY_KEYS.has(key),
    );
    expect(stale).toEqual([]);
  });
});
