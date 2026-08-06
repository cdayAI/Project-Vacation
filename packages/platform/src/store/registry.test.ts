import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_MIGRATIONS } from "./registry.js";

/**
 * Migration registry tests.
 *
 * The registry is a hand-maintained list, which makes it the one place in the
 * schema story that can silently fall behind. A module can ship a perfectly
 * good `migrations.ts`, pass all of its own tests against the in-memory
 * adapter, and still have no tables in Postgres — because nothing imported it.
 *
 * That failure is invisible until a real deployment, and it looks like a
 * mysterious "relation does not exist" a long way from its cause. So the test
 * below walks the source tree and fails if any module's migrations are missing
 * from the registry. Adding a module and forgetting the registry entry becomes
 * a red build instead of a production incident.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("migration registry", () => {
  it("includes every module that ships migrations", () => {
    const modulesWithMigrations = readdirSync(SRC, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(SRC, name, "migrations.ts")))
      .sort();

    const registered = new Set(
      ALL_MIGRATIONS.map((migration) => migration.id.replace(/^\d+_/, "")),
    );

    const missing = modulesWithMigrations.filter((moduleName) => {
      // Match on the module name appearing in some migration id, which is the
      // convention the ids follow (`0006_knowledge`).
      return ![...registered].some((id) => id === moduleName || id.startsWith(moduleName));
    });

    expect(
      missing,
      `These modules ship a migrations.ts that store/registry.ts does not import, so their tables would never be created in Postgres: ${missing.join(", ")}. Add an import and an entry to SOURCES.`,
    ).toEqual([]);
  });

  it("has no duplicate migration ids", () => {
    const ids = ALL_MIGRATIONS.map((migration) => migration.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(
      duplicates,
      `Two modules claim the same migration id, which would make one of them silently skipped: ${duplicates.join(", ")}`,
    ).toEqual([]);
  });

  it("is ordered by id", () => {
    const ids = ALL_MIGRATIONS.map((migration) => migration.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("gives every migration non-empty SQL", () => {
    for (const migration of ALL_MIGRATIONS) {
      expect(migration.sql.trim().length, `${migration.id} has empty SQL`).toBeGreaterThan(0);
    }
  });
});
