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

  it("reports the schema rather than falling through, which its own help promised", async () => {
    // `db status` was advertised in USAGE and fell through to "Unknown db
    // subcommand". A command line that lies in its own help text is the first
    // thing an operator reads and the first thing that teaches them not to
    // trust the rest of it.
    const result = await cli(["db", "status"]);
    expect(result.code).toBe(78); // EX_CONFIG: no schema in this deployment
    expect(result.stderr).not.toMatch(/Unknown db subcommand/);
    // Not "up to date": there is no database here, which is a different answer.
    expect(result.stderr).toMatch(/no schema/);
    expect(result.stderr).toMatch(/PV_STORE/);
  });

  it("answers every command the runbooks send an operator to", async () => {
    // Each of these was "Unknown command" while a runbook told a woken
    // responder to run it. Asserted as processes rather than as source, because
    // the exit code and the stdout/stderr split are the properties that make
    // them usable during an incident, and neither is visible from inside.
    for (const command of [
      ["cost", "report"],
      ["approvals", "list"],
      ["models", "degradation"],
      ["engine", "timers", "--overdue"],
    ]) {
      const result = await cli(command);
      expect(result.stderr, command.join(" ")).not.toMatch(/Unknown command/);
      expect(result.code, command.join(" ")).toBe(0);
    }
  }, 60_000);

  it("keeps each report's stdout parseable so it can be filed as evidence", async () => {
    for (const command of [
      ["cost", "report", "--json"],
      ["approvals", "list", "--json"],
      ["models", "degradation", "--json"],
      ["engine", "timers", "--json"],
    ]) {
      const result = await cli(command);
      expect(() => JSON.parse(result.stdout), command.join(" ")).not.toThrow();
    }
  }, 60_000);

  it("runs the demonstration and exits zero with an intact chain", async () => {
    const result = await cli(["demo", "run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Audit chain INTACT/);
  }, 90_000);
});

describe("pv integrations — the governed path to the systems of record", () => {
  it("prints usage and exits non-zero when given no subcommand", async () => {
    const result = await cli(["integrations"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/pv integrations/);
  });

  it("lists the systems of record and states the shape is unconfirmed", async () => {
    const result = await cli(["integrations", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/contract-records/);
    expect(result.stdout).toMatch(/association-records/);
    // Every shape is an informed guess until MVW confirms it.
    expect(result.stdout).toMatch(/CONFIRMED/);
    expect(result.stdout).toMatch(/\bNO\b/);
  });

  it("names the egress allowlist that bounds every outbound call", async () => {
    const result = await cli(["integrations", "list"], {
      PV_EGRESS_ALLOWLIST: "contracts.partner.example.com",
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/contracts\.partner\.example\.com/);
    const empty = await cli(["integrations", "list"]);
    expect(empty.stderr).toMatch(/empty.*refused/i);
  });

  it("reads a seeded contract record through the port", async () => {
    const result = await cli(["integrations", "contract", "show", "ctr_fl_recent_complete"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/jurisdiction\s+FL/);
    expect(result.stdout).toMatch(/ctr_fl_recent_complete/);
  });

  it("reports a contract the system of record does not hold as absent, not as a fabrication", async () => {
    const result = await cli(["integrations", "contract", "show", "ctr_does_not_exist"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/No contract record/);
    expect(result.stdout).toBe("");
  });

  it("reads a seeded association and its budget through the port", async () => {
    const result = await cli([
      "integrations",
      "association",
      "show",
      "1042",
      "--fiscal-year",
      "2026",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Palm Grove/);
    expect(result.stdout).toMatch(/reserve/i);
  });

  it("refuses a governed egress call to a host the allowlist does not name", async () => {
    const result = await cli(
      [
        "integrations",
        "call",
        "--url",
        "https://evil.example/exfiltrate",
        "--integration",
        "contract-records",
        "--credential",
        "contract-records",
      ],
      { PV_EGRESS_ALLOWLIST: "contracts.partner.example.com" },
    );
    // Fail closed, refused before anything leaves the process.
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Refused \(integration\.host_not_allowlisted\)/);
  });

  it("refuses an allowlisted call whose credential is not configured", async () => {
    // The allowlist lets the host through; the credential control still refuses,
    // because no credential is configured for it. Fail closed at every gate.
    const result = await cli(
      [
        "integrations",
        "call",
        "--url",
        "https://contracts.partner.example.com/contracts/x",
        "--integration",
        "contract-records",
        "--credential",
        "contract-records",
      ],
      { PV_EGRESS_ALLOWLIST: "contracts.partner.example.com" },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Refused \(integration\.credential_missing\)/);
  });

  it("keeps a listing's stdout parseable so it can be filed as evidence", async () => {
    const result = await cli(["integrations", "list", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      egressAllowlist: string[];
      integrations: { name: string; shapeConfirmedWithMvw: boolean }[];
    };
    expect(Array.isArray(parsed.egressAllowlist)).toBe(true);
    expect(parsed.integrations.every((entry) => entry.shapeConfirmedWithMvw === false)).toBe(true);
  });
});
