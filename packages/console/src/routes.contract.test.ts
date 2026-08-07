import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PRIMARY_NAVIGATION, isNavigationItemVisible } from "./routes";
import type { SessionView } from "./api/contract";

/**
 * The console's capability vocabulary, checked against the platform's.
 *
 * `SessionView.capabilities` is built from the platform's action registry and
 * from nothing else (`api/server.ts` fills it from `platform.registry`). A
 * navigation item that names a capability outside that vocabulary is not
 * "restrictive" — it is unreachable, because no actor is ever granted it.
 *
 * That is not hypothetical. The rail shipped naming an invented parallel
 * vocabulary — `work.read`, `approvals.read`, `roles.read`, six more — none of
 * which the platform emits. Every operator, including one holding every role
 * the platform defines, opened the console and found nine of eleven surfaces
 * missing. Two links, in an application with seventeen screens.
 *
 * The platform's source is read rather than imported because the console does
 * not depend on the platform package and should not start: this is a contract
 * between two independently-deployable things, and a compile-time coupling
 * would make the console un-buildable without the server.
 */

// Resolved from the Vitest root (packages/console) rather than from
// import.meta.url, which under the jsdom environment is not a file: URL.
const ACTIONS_SOURCE = resolve(process.cwd(), "../platform/src/actions.ts");

/** Every action name the platform can put in a session's capability list. */
function platformCapabilities(): ReadonlySet<string> {
  const source = readFileSync(ACTIONS_SOURCE, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s{4}name:\s*"([^"]+)",$/gm)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/**
 * A complete session. Built rather than cast, so that adding a field to
 * `SessionView` breaks this file instead of letting it keep asserting against
 * a shape the console no longer receives.
 */
function sessionWith(capabilities: readonly string[]): SessionView {
  return {
    actor: { actorId: "dev:local", displayName: "dev:local", roles: ["platform_admin"] },
    capabilities: [...capabilities],
    secondsSinceAuthentication: 0,
    readOnly: false,
  };
}

describe("navigation capabilities", () => {
  const capabilities = platformCapabilities();

  it("reads the platform's action registry", () => {
    // A guard on the parse itself. If the registry's shape changes and this
    // stops matching, every assertion below becomes vacuously true and the
    // check silently stops checking — which is the failure mode this whole
    // file exists to catch, one level up.
    expect(capabilities.size).toBeGreaterThan(20);
    expect(capabilities.has("record.read_run")).toBe(true);
    expect(capabilities.has("audit.read")).toBe(true);
  });

  it("names only capabilities the platform actually grants", () => {
    for (const item of PRIMARY_NAVIGATION) {
      if (item.capability === undefined) continue;
      expect(
        capabilities.has(item.capability),
        `"${item.label}" is gated on "${item.capability}", which the platform never puts in a session. The link would be hidden from every operator.`,
      ).toBe(true);
    }
  });

  it("shows every surface to an operator holding every capability", () => {
    // The case that was broken. Somebody with the whole registry sees the
    // whole console.
    const session = sessionWith([...capabilities]);

    const hidden = PRIMARY_NAVIGATION.filter((item) => !isNavigationItemVisible(item, session));
    expect(hidden.map((item) => item.label)).toEqual([]);
  });

  it("still hides a surface from an operator who lacks its capability", () => {
    // The check has to be capable of hiding something, or making it pass would
    // be as simple as deleting it.
    const gated = PRIMARY_NAVIGATION.filter((item) => item.capability !== undefined);
    expect(gated.length).toBeGreaterThan(0);

    for (const item of gated) {
      const withoutIt = sessionWith(
        [...capabilities].filter((name) => name !== item.capability),
      );
      expect(
        isNavigationItemVisible(item, withoutIt),
        `"${item.label}" stayed visible without "${item.capability ?? ""}"`,
      ).toBe(false);
    }
  });

  it("shows everything when the platform sent no capabilities at all", () => {
    // An unauthenticated or not-yet-loaded session must not render as a
    // console with no navigation. The server refuses the read; the rail does
    // not pre-empt it.
    const empty = sessionWith([]);

    for (const item of PRIMARY_NAVIGATION) {
      expect(isNavigationItemVisible(item, empty)).toBe(true);
    }
    for (const item of PRIMARY_NAVIGATION) {
      expect(isNavigationItemVisible(item, null)).toBe(true);
    }
  });
});
