import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture tests.
 *
 * These check properties a type checker and a linter cannot see, and that
 * matter enough that discovering a violation in review is too late.
 *
 * The theme running through all of them: several of this platform's guarantees
 * are structural rather than local. "Every action passes one chokepoint" is
 * only true if nothing can route around `guard/`. "The demo reproduces byte for
 * byte" is only true if nothing reads the wall clock. "Employee observations
 * never reach a model provider" is only true if `discovery/` cannot import
 * `models/`. Each of those is one careless import away from becoming false, and
 * would fail silently — the tests would still pass, the types would still
 * check, and the claim in the assurance documentation would quietly stop being
 * true. So they are asserted here.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

/**
 * Module layers.
 *
 * A module may import from its own layer or any lower one, never higher.
 * `kernel` and `store` are utilities every layer may use.
 *
 * Two placements are deliberate and worth explaining:
 *
 *   `timeline` sits at layer 0, below the governance machinery, even though it
 *   is domain logic. Statutory deadlines are the highest-consequence
 *   computation here and must be testable in complete isolation; putting it
 *   low guarantees it cannot grow a dependency on anything stateful.
 *
 *   `discovery` sits above `models` in the ordering but is additionally
 *   forbidden from importing it outright (see the dedicated test below).
 *   Layering alone would permit that import; the privacy guarantee does not.
 */
const LAYERS: Readonly<Record<string, number>> = {
  kernel: -1,
  store: -1,
  record: 0,
  audit: 0,
  timeline: 0,
  guard: 1,
  models: 1,
  identity: 1,
  knowledge: 2,
  integrations: 2,
  contact: 2,
  documents: 3,
  roles: 3,
  engine: 3,
  // The external-agent plane governs actors running outside this platform. It
  // needs the record, the audit log and the guard, and it performs outbound
  // work through governed integrations — so it sits above all of those and
  // below the workflows, which may enlist an external agent but are never
  // enlisted by one.
  external: 3,
  improve: 4,
  discovery: 4,
  workflows: 5,
  // The demonstration composes everything below it into a scenario. The
  // entrypoints sit above it, because the CLI runs the demo and not the other
  // way round — and the CLI runs the API too, so it is the outermost thing.
  demo: 6,
  api: 7,
  cli: 8,
};

/**
 * Per-file overrides.
 *
 * `store/` holds two different kinds of thing. `db.ts` and `migrate.ts` are
 * genuine utilities that know nothing about the domain. `registry.ts` is a
 * composition root: its whole job is to gather every module's migrations into
 * one ordered list, which necessarily means importing all of them. Treating it
 * as a utility would either fail this test forever or force the layering to be
 * relaxed for everything — so it is placed where it actually belongs.
 */
const FILE_LAYERS: Readonly<Record<string, number>> = {
  [join("store", "registry.ts")]: 5,
};

interface SourceFile {
  readonly path: string;
  readonly relative: string;
  readonly module: string;
  readonly text: string;
  readonly isTest: boolean;
}

function walk(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) found.push(full);
  }
  return found;
}

const FILES: readonly SourceFile[] = walk(SRC).map((path) => {
  const rel = relative(SRC, path);
  const parts = rel.split(sep);
  return {
    path,
    relative: rel,
    module: parts.length > 1 ? (parts[0] ?? "") : "",
    text: readFileSync(path, "utf8"),
    isTest: rel.endsWith(".test.ts") || rel.endsWith(".test.tsx"),
  };
});

/** Every relative import specifier in a file. */
function importsOf(file: SourceFile): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?[^"';]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^"';]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of file.text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Extract the full body of every catch block, matching braces.
 *
 * A fixed-width regex window was the obvious approach and is wrong: it
 * truncates long catch blocks, so a block that re-raises on its last line reads
 * as one that swallows. That produces false positives on exactly the careful
 * code the check exists to protect, which is the fastest way to get an
 * architecture test deleted. Brace matching costs a few lines and is correct.
 */
function catchBlockBodies(text: string): string[] {
  const bodies: string[] = [];
  const opener = /catch\s*(?:\([^)]*\))?\s*\{/g;

  for (const match of text.matchAll(opener)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let index = start;
    while (index < text.length && depth > 0) {
      const character = text[index];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      index += 1;
    }
    bodies.push(text.slice(start, index - 1));
  }
  return bodies;
}

/** Resolve a relative import to the module directory it lands in, if any. */
function targetModule(file: SourceFile, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromDir = file.relative.split(sep).slice(0, -1);
  const parts = [...fromDir];
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  const head = parts[0];
  if (!head) return null;
  // A single-segment path is a sibling file at the src root, not a module.
  return parts.length > 1 ? head : null;
}

describe("module layering", () => {
  it("declares a layer for every module directory present", () => {
    const modules = new Set(FILES.map((file) => file.module).filter((name) => name !== ""));
    const undeclared = [...modules].filter((name) => !(name in LAYERS));
    expect(
      undeclared,
      `These module directories have no declared layer. Add them to LAYERS in this file, deliberately, after deciding where they belong: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });

  it("never imports upward", () => {
    const violations: string[] = [];

    for (const file of FILES) {
      // Tests are exempt. Layering protects the runtime dependency graph, and a
      // test naturally reaches for whatever it exercises — a contract-test
      // suite for three modules' adapters has to import all three. Applying the
      // rule to tests would force the layering to be loosened for shipped code,
      // which is the opposite of what it is for.
      if (file.isTest) continue;
      if (file.module === "" || !(file.module in LAYERS)) continue;
      const fromLayer = FILE_LAYERS[file.relative] ?? LAYERS[file.module];
      if (fromLayer === undefined) continue;

      for (const specifier of importsOf(file)) {
        const target = targetModule(file, specifier);
        if (!target || target === file.module) continue;
        const toLayer = LAYERS[target];
        if (toLayer === undefined) continue;
        // Utilities (layer -1) are importable from anywhere.
        if (toLayer === -1) continue;
        if (toLayer > fromLayer) {
          violations.push(
            `${file.relative} (layer ${fromLayer}) imports ${target} (layer ${toLayer}) via "${specifier}"`,
          );
        }
      }
    }

    expect(
      violations,
      `Upward imports break the platform's structural guarantees — most importantly that every action passes through guard/. If a lower layer genuinely needs something from a higher one, invert the dependency with a port rather than relaxing this test.\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

describe("determinism", () => {
  /**
   * Statutory deadlines are computed from the clock, the seeded demo must
   * reproduce byte for byte, and workflow timers must be testable without
   * waiting. All three fail if any module reads the wall clock directly.
   */
  it("reads the wall clock only through kernel/clock.ts", () => {
    const offenders: string[] = [];
    const allowed = new Set([join("kernel", "clock.ts")]);

    for (const file of FILES) {
      if (allowed.has(file.relative) || file.isTest) continue;
      // Strip comments so prose about Date.now() does not trip the check.
      const code = file.text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      if (/\bDate\.now\s*\(/.test(code)) {
        offenders.push(`${file.relative}: Date.now()`);
      }
      // `new Date()` with no argument means "now". With an argument it is a
      // conversion, which is fine.
      if (/\bnew\s+Date\s*\(\s*\)/.test(code)) {
        offenders.push(`${file.relative}: new Date()`);
      }
    }

    expect(
      offenders,
      `Inject a Clock from kernel/clock.js instead. Direct wall-clock reads break the seeded demo's reproducibility and make timer behaviour untestable.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("uses randomness only where identifiers are generated", () => {
    const offenders: string[] = [];
    const allowed = new Set([join("kernel", "ids.ts")]);

    for (const file of FILES) {
      if (allowed.has(file.relative) || file.isTest) continue;
      const code = file.text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Retry jitter is a legitimate use, so it is permitted where a comment
      // marks it. Everything else must come from an injected generator.
      if (/\bMath\.random\s*\(/.test(code) && !/allow-random:\s*jitter/.test(file.text)) {
        offenders.push(file.relative);
      }
    }

    expect(
      offenders,
      `Use an injected IdGenerator, or mark a genuine jitter use with an "allow-random: jitter" comment.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("privacy and containment boundaries", () => {
  /**
   * The work-discovery module observes employees. Its controlling promise is
   * that observations stay inside the deployment's data boundary and are never
   * sent to a model provider. An import of models/ would make that promise
   * false without any test failing, so the import itself is forbidden.
   */
  it("keeps work-discovery observations away from model providers", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file.module !== "discovery") continue;
      for (const specifier of importsOf(file)) {
        const target = targetModule(file, specifier);
        if (target === "models") {
          offenders.push(`${file.relative} imports models via "${specifier}"`);
        }
      }
    }
    expect(
      offenders,
      `Work-discovery observations must never reach a model provider. See docs/adr/0012-work-discovery-default-off.md.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * `AuditLog.record` applies three guarantees every caller depends on:
   * correct chaining, refusal of payload-shaped content, and failing closed
   * when the write does not land. A module writing to the store directly
   * bypasses all three.
   */
  it("writes audit entries only through AuditLog", () => {
    const offenders: string[] = [];
    const allowed = new Set([
      join("audit", "log.ts"),
      join("audit", "store.memory.ts"),
      join("audit", "store.pg.ts"),
    ]);

    for (const file of FILES) {
      if (file.isTest || allowed.has(file.relative)) continue;
      if (file.module === "audit" || file.module === "store") continue;
      if (/\.appendEntry\s*\(/.test(file.text)) {
        offenders.push(file.relative);
      }
    }

    expect(
      offenders,
      `Call AuditLog.record() instead of the store's appendEntry directly — it is where hashing, payload refusal, and fail-closed behaviour are applied.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("model governance", () => {
  /**
   * "Never hard-code a model in business logic — resolve from configuration."
   * Concrete model identifiers belong in the inventory defaults and in
   * deployment configuration, nowhere else, so that the inventory is a true
   * record and a model change is a reviewable change (ADR 0013).
   */
  it("names concrete models only in the inventory and configuration", () => {
    const offenders: string[] = [];
    const allowed = new Set([
      join("models", "inventory.ts"),
      join("models", "provider.ts"),
      join("models", "types.ts"),
      join("kernel", "config.ts"),
    ]);
    const modelIdPattern = /["'](?:claude|gpt|gemini|llama|mistral)-[a-z0-9.-]+["']/i;

    for (const file of FILES) {
      if (file.isTest || allowed.has(file.relative)) continue;
      const code = file.text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (modelIdPattern.test(code)) offenders.push(file.relative);
    }

    expect(
      offenders,
      `Resolve a logical task name through the model inventory instead. See docs/adr/0013-models-resolved-from-configuration.md.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("fail-closed discipline", () => {
  /**
   * A caught DeniedError that does not re-raise turns a refusal into a
   * permission. This scan is heuristic — it looks for a catch block that names
   * DeniedError and contains no throw — so it will not catch every instance,
   * but it catches the shape that appears when someone adds a well-meaning
   * try/catch around a control.
   */
  it("does not swallow denials", () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      if (file.isTest) continue;
      for (const body of catchBlockBodies(file.text)) {
        if (!/DeniedError/.test(body)) continue;
        // Inside a Promise executor, reject() is the throw. Treating it as a
        // swallow would push authors toward a marker comment on code that is
        // already propagating the failure correctly.
        const propagates = /\bthrow\b/.test(body) || /\breject\s*\(/.test(body);
        // A catch that returns a denial has converted the refusal, not
        // swallowed it: the caller is still refused and the reason still
        // travels. The outer condition has already established that the block
        // inspects the DeniedError, so this cannot match a block that discards
        // the error and happens to return something unrelated.
        const converts = /\breturn\b[\s\S]*?\bdeny\s*\(/.test(body);
        const deliberate = /allow-swallow:/.test(body);
        if (!propagates && !converts && !deliberate) {
          offenders.push(file.relative);
        }
      }
    }

    expect(
      offenders,
      `A catch block that recognises a DeniedError and neither re-raises nor converts it turns a refusal into a permission. If swallowing is genuinely correct, mark it with an "allow-swallow:" comment explaining why.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("import hygiene", () => {
  it("uses explicit .js extensions on relative imports, as NodeNext requires", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file.path.endsWith(".tsx")) continue;
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith(".")) continue;
        if (specifier.endsWith(".js") || specifier.endsWith(".json")) continue;
        if (specifier.endsWith(".css")) continue;
        offenders.push(`${file.relative}: "${specifier}"`);
      }
    }
    expect(offenders, `Relative imports need a .js extension under NodeNext.\n${offenders.join("\n")}`).toEqual([]);
  });
});
