import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "main.ts");
const TSX = resolve(HERE, "../../node_modules/.bin/tsx");

/**
 * CLI tests.
 *
 * These run the command line as a subprocess rather than importing it, because
 * the properties worth testing are process-level and unobservable from inside:
 * the exit code, and the separation of stdout from stderr.
 *
 * Both matter operationally. `pv audit verify` is meant to run on a schedule,
 * so exiting zero while the chain is broken would be worse than not running it
 * at all. And `pv audit verify > evidence.txt` has to produce a file an auditor
 * can read, which means no log line may reach stdout.
 */
async function cli(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await run(TSX, [CLI, ...args], {
      env: { ...process.env, PV_ENV: "development", PV_STORE: "memory", ...env },
      timeout: 60_000,
    });
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

describe("operator command line", () => {
  it("prints usage and exits non-zero when given no command", async () => {
    const result = await cli([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Project Vacation — operator commands/);
  });

  it("exits non-zero on an unknown command rather than doing nothing quietly", async () => {
    const result = await cli(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Unknown command/);
  });

  it("lists the action registry with risk tiers", async () => {
    const result = await cli(["actions", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/contact\.send_owner_message\s+high_consequence/);
    expect(result.stdout).toMatch(/audit\.modify_entry\s+prohibited/);
  });

  it("keeps stdout clean so output can be redirected into an artifact", async () => {
    const result = await cli(["actions", "list", "--json"]);
    expect(result.code).toBe(0);
    // The whole of stdout must parse as JSON. A single log line would break it.
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    // A bare array, not an envelope: the CLI's consumer is `jq`, and
    // `pv actions list --json | jq '.[].name'` should just work. The HTTP API
    // wraps its lists because a browser client needs paging metadata; these are
    // different surfaces with different consumers, and matching them for the
    // sake of symmetry would make one of them worse.
    const parsed = JSON.parse(result.stdout) as { name: string }[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(10);
    expect(parsed.some((action) => action.name === "contact.send_owner_message")).toBe(true);
  });

  it("reports health, including whether the sandbox contains and discovery is on", async () => {
    const result = await cli(["health"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/sandbox\s+disabled \(contained\)/);
    expect(result.stdout).toMatch(/work discovery\s+disabled/);
  });

  it("surfaces the unsafe sandbox mode loudly", async () => {
    const result = await cli(["health"], { PV_SANDBOX_MODE: "subprocess" });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/NOT CONTAINED/);
    expect(result.stdout).toMatch(/NOT a security boundary/);
  });

  it("surfaces work discovery being enabled loudly", async () => {
    const result = await cli(["health"], { PV_DISCOVERY_ENABLED: "true" });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/work discovery\s+ENABLED/);
    expect(result.stdout).toMatch(/employee work-discovery observation is ENABLED/);
  });

  it("refuses to start on an invalid configuration, with the variable named", async () => {
    const result = await cli(["health"], { PV_HTTP_PORT: "not-a-port" });
    expect(result.code).toBe(78); // EX_CONFIG
    expect(result.stderr).toMatch(/PV_HTTP_PORT/);
  });

  it("refuses to start in production without single sign-on", async () => {
    const result = await cli(["health"], {
      PV_ENV: "production",
      PV_STORE: "postgres",
      PV_DATABASE_URL: "postgresql://localhost/x",
    });
    expect(result.code).toBe(78);
    expect(result.stderr).toMatch(/Single sign-on is required/);
  });

  it("reports an empty audit chain as empty rather than as verified", async () => {
    const result = await cli(["audit", "verify"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/empty/i);
  });

  it("requires a reason before engaging containment", async () => {
    const result = await cli(["containment", "engage", "--scope", "global"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--reason is required/);
  });

  it("rejects an unrecognised containment scope", async () => {
    const result = await cli([
      "containment",
      "engage",
      "--scope",
      "everything",
      "--reason",
      "x",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--scope must be one of/);
  });

  it("shows configuration without printing a secret", async () => {
    const result = await cli(["config", "show"], {
      PV_SESSION_SECRET: "supersecretvalue-supersecretvalue",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("supersecretvalue");
    expect(result.stdout).toMatch(/sandbox/);
  });

  it("refuses to migrate the in-memory store instead of pretending it worked", async () => {
    const result = await cli(["db", "migrate"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Postgres store only/);
  });

  it("runs the demonstration and exits zero with an intact chain", async () => {
    const result = await cli(["demo", "run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Audit chain INTACT/);
  }, 90_000);
});
