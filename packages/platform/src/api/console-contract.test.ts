import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../kernel/config.js";
import { FixedClock } from "../kernel/clock.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import { createNullLogger } from "../kernel/logger.js";
import { buildPlatform } from "../platform.js";
import { createServer } from "./server.js";

/**
 * Contract test between the console and the HTTP API.
 *
 * These are two packages, released together but written apart, and nothing in
 * the type system connects a path string in the console's client to a route
 * registration in Fastify. So they drifted — and drifted silently, because the
 * console's tests use a fake client and the API's tests use paths written from
 * the API's own perspective. Both suites were green while three endpoints did
 * not exist: `/api/health` (the server served `/health`), `/api/work` (the
 * server had `/api/runs`), and `/api/approvals/:id/decisions` (the server had
 * the singular).
 *
 * Nothing would have caught that except running the real console against the
 * real server, which no test does. This test does the next best thing: it reads
 * the console's client source, extracts every path it can construct, and asserts
 * each one is registered on the server.
 *
 * Reading the source rather than importing it is deliberate. Importing would
 * mean the platform package depending on the console package, which the layering
 * forbids and which would be the wrong direction anyway — the API does not
 * depend on its clients. Parsing a file is cruder and cannot be wrong in a way
 * that passes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_SOURCE = join(HERE, "../../../console/src/api/client.ts");

/**
 * Endpoints the console calls that the server does not serve yet.
 *
 * Every one of these belongs to a capability still being built. The list is
 * asserted to be *exact*: removing a gap without updating this list fails, and
 * — the point — adding a new unserved endpoint fails too. It is a ratchet, not
 * a suppression.
 */
const KNOWN_UNIMPLEMENTED = [
  "/api/discovery/candidates",
  "/api/executive",
  "/api/improvements/clusters",
  "/api/improvements/proposals",
  "/api/improvements/proposals/:param",
  "/api/roles",
  "/api/roles/:param/versions",
  "/api/workflows/:param",
] as const;

/**
 * Extract every path template the client builds, normalised to route syntax.
 *
 * Scanned character by character rather than matched with a regular
 * expression. A path in the client can be followed by an interpolated query
 * builder that spans several lines and contains nested braces — a regex either
 * stops at the first closing brace and yields a mangled path, or fails to match
 * and yields nothing. The second failure is the dangerous one: a path the test
 * silently never checked looks exactly like a path that passed.
 */
function extractClientPaths(text: string): string[] {
  const paths = new Set<string>();
  const PATH_CHARS = /[A-Za-z0-9/_.-]/;
  const source = withoutComments(text);

  for (let i = 0; i < source.length - 1; i += 1) {
    const quote = source[i];
    if (quote !== "`" && quote !== '"') continue;
    if (source[i + 1] !== "/") continue;

    let cursor = i + 1;
    let path = "";

    while (cursor < source.length) {
      const char = source[cursor];
      if (char === undefined) break;

      if (char === "$" && source[cursor + 1] === "{") {
        // An interpolation. Skip it with brace matching, and record it as a
        // route parameter — unless it is a query-string builder, which ends
        // the path rather than forming part of it.
        let depth = 1;
        let scan = cursor + 2;
        while (scan < source.length && depth > 0) {
          if (source[scan] === "{") depth += 1;
          else if (source[scan] === "}") depth -= 1;
          scan += 1;
        }
        const interpolated = source.slice(cursor + 2, scan - 1);
        if (/buildQuery|queryString|searchParams/.test(interpolated)) {
          cursor = scan;
          break;
        }
        path += ":param";
        cursor = scan;
        continue;
      }

      if (char === quote) break;
      if (!PATH_CHARS.test(char)) break;

      path += char;
      cursor += 1;
    }

    if (path.length < 2) continue;
    const full = path.startsWith("/api") ? path : `/api${path}`;
    // The client's own base-URL constant, not an endpoint.
    if (full === "/api") continue;
    paths.add(full);
  }

  return [...paths].sort();
}

/**
 * Blank out comments, preserving offsets.
 *
 * Prose about a path is not a call to it. A comment explaining that the roster
 * is "deliberately not under `/external`" was read as a call to `/api/external`
 * and demanded a route nothing invokes — which teaches the reader that this
 * test's failures are noise, and that is how a real drift gets waved through.
 *
 * String-aware, because `"https://…"` inside a literal is not the start of a
 * comment, and blanking from there would swallow the rest of the line.
 */
function withoutComments(source: string): string {
  const out: string[] = [];
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";

    if (quote) {
      out.push(char);
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out.push(char);
      continue;
    }

    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      out.push("\n");
      continue;
    }

    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let scan = i; scan < stop; scan += 1) {
        out.push(source[scan] === "\n" ? "\n" : " ");
      }
      i = stop - 1;
      continue;
    }

    out.push(char);
  }

  return out.join("");
}

/** Every route the server registers, as `METHOD /path`. */
async function registeredRoutes(): Promise<Set<string>> {
  const platform = await buildPlatform(loadConfig({ PV_ENV: "development" }), {
    clock: new FixedClock("2026-08-06T12:00:00.000Z"),
    ids: new SeededIdGenerator("contract"),
    logger: createNullLogger(),
  });
  const app = createServer({ platform });
  await app.ready();

  // Collected by an onRoute hook inside createServer, so this is exactly what
  // Fastify registered rather than a reassembly of its printed tree.
  const collected = (app as unknown as { registeredRoutes: Set<string> }).registeredRoutes;
  const routes = new Set(
    [...collected].map((route) => route.replace(/:[A-Za-z0-9_]+/g, ":param")),
  );

  await app.close();
  await platform.close();
  return routes;
}

describe("console to API contract", () => {
  it("serves every endpoint the console client calls, except the known gaps", async () => {
    const source = readFileSync(CLIENT_SOURCE, "utf8");
    const clientPaths = extractClientPaths(source);
    const routes = await registeredRoutes();
    const servedPaths = new Set([...routes].map((route) => route.split(" ")[1] ?? ""));

    expect(clientPaths.length).toBeGreaterThan(8);

    const unserved = clientPaths.filter((path) => !servedPaths.has(path)).sort();

    expect(
      unserved,
      "The console calls these paths and the server does not serve them. Either add the route, or — if the capability is genuinely still being built — add it to KNOWN_UNIMPLEMENTED with the reason.",
    ).toEqual([...KNOWN_UNIMPLEMENTED].sort());
  });

  it("keeps the known-gap list honest by failing when a gap is closed", async () => {
    // The other half of the ratchet. If a route lands and nobody removes it
    // from the list, this fails — so the list cannot quietly become a place
    // where finished work is still described as missing.
    const routes = await registeredRoutes();
    const servedPaths = new Set([...routes].map((route) => route.split(" ")[1] ?? ""));
    const staleEntries = KNOWN_UNIMPLEMENTED.filter((path) => servedPaths.has(path));

    expect(
      staleEntries,
      `These are now served but are still listed as unimplemented. Remove them from KNOWN_UNIMPLEMENTED: ${staleEntries.join(", ")}`,
    ).toEqual([]);
  });

  it("serves health at both the probe path and the console path", async () => {
    // Two paths, one handler. An infrastructure probe wants an unprefixed,
    // stable `/health`; the console wants everything under one base URL.
    const routes = await registeredRoutes();
    expect(routes.has("GET /health")).toBe(true);
    expect(routes.has("GET /api/health")).toBe(true);
  });

  it("accepts a decision at the path the console posts to", async () => {
    const routes = await registeredRoutes();
    expect(routes.has("POST /api/approvals/:param/decisions")).toBe(true);
  });
});
