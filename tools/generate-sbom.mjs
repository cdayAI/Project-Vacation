#!/usr/bin/env node
/**
 * CycloneDX SBOM generator.
 *
 * Written rather than taken off the shelf for a specific reason:
 * `@cyclonedx/cyclonedx-npm` shells out to `npm ls`, which cannot read a pnpm
 * workspace — pnpm's content-addressed `node_modules/.pnpm` layout is not what
 * `npm ls` expects, and the tool fails with "failed to parse npm-ls response".
 * Shipping a command that fails is worse than shipping thirty lines that work,
 * and an SBOM the build cannot produce is an assurance artifact in name only.
 *
 * Source of truth is `pnpm licenses list --json`, which enumerates every
 * resolved package in the workspace with its version, license, and homepage.
 *
 * Honest scope: this records the *dependency inventory* — what is installed,
 * at which version, under which license. It does not currently emit the
 * dependency graph (which package depends on which) or per-package integrity
 * hashes. Both are available from the lockfile and are worth adding before an
 * assessment that asks for full provenance; the gap is recorded in
 * docs/handover/not-production-grade.md rather than glossed over.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const OUTPUT = process.argv[2] ?? "sbom.json";

function readWorkspaceMetadata() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  return {
    name: pkg.name ?? "project-vacation",
    version: pkg.version ?? "0.0.0",
    description: pkg.description ?? "",
  };
}

function collectPackages() {
  let raw;
  try {
    raw = execFileSync("pnpm", ["licenses", "list", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    console.error(
      `Could not enumerate dependencies: ${error?.message ?? error}\n` +
        "Run `pnpm install` first.",
    );
    process.exit(1);
  }

  const byLicense = JSON.parse(raw);
  const components = [];

  for (const [license, entries] of Object.entries(byLicense)) {
    for (const entry of entries) {
      for (const version of entry.versions ?? []) {
        components.push({
          type: "library",
          "bom-ref": `pkg:npm/${entry.name}@${version}`,
          name: entry.name,
          version,
          purl: `pkg:npm/${encodeURIComponent(entry.name).replace("%40", "@")}@${version}`,
          scope: "required",
          ...(entry.description ? { description: entry.description.slice(0, 500) } : {}),
          ...(license && license !== "Unknown"
            ? { licenses: [{ license: { id: license } }] }
            : {}),
          ...(entry.homepage ? { externalReferences: [{ type: "website", url: entry.homepage }] } : {}),
        });
      }
    }
  }

  // Deterministic ordering. An SBOM that reorders between builds produces a
  // meaningless diff, which is how people stop reading them.
  components.sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
  return components;
}

function main() {
  const workspace = readWorkspaceMetadata();
  const components = collectPackages();

  // The serial number must be stable for identical input, so that two builds of
  // the same tree produce the same document. A random UUID here would make
  // every SBOM look like a change.
  const fingerprint = createHash("sha256")
    .update(components.map((c) => c["bom-ref"]).join("\n"))
    .digest("hex");
  const serialNumber = `urn:uuid:${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-4${fingerprint.slice(13, 16)}-a${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`;

  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber,
    version: 1,
    metadata: {
      // Deliberately no timestamp: it would change on every build and defeat
      // the stable-diff property above. Build time is recorded by CI alongside
      // the artifact, where it belongs.
      tools: [{ vendor: "project-vacation", name: "generate-sbom", version: "1.0.0" }],
      component: {
        type: "application",
        "bom-ref": `pkg:npm/${workspace.name}@${workspace.version}`,
        name: workspace.name,
        version: workspace.version,
        description: workspace.description,
      },
    },
    components,
  };

  writeFileSync(OUTPUT, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
  console.error(
    `SBOM written to ${OUTPUT}: ${components.length} components, CycloneDX ${bom.specVersion}.`,
  );
}

main();
