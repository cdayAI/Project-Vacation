import { z } from "zod";
import { ConfigError } from "./errors.js";

/**
 * Configuration.
 *
 * Two rules shape this module.
 *
 * Fail closed: a missing or unparseable value is a startup failure, not a
 * default. The only settings with defaults are ones where the default is the
 * *safe* choice — execution disabled, discovery off, egress allowlist empty.
 * Nothing defaults to permissive.
 *
 * Loud about unsafe settings: some options are legitimate in development and
 * dangerous in production. Rather than forbidding them outright, the loader
 * collects them into `warnings`, which the startup banner prints and the
 * health check reports. An operator should never have to read the environment
 * to discover that the sandbox is not containing anything.
 */

const nonEmpty = z.string().trim().min(1);

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === "boolean") return value;
    const normalised = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalised)) return true;
    if (["0", "false", "no", "off", ""].includes(normalised)) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Not a boolean: ${value}` });
    return z.NEVER;
  });

const positiveInt = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === "number" ? value : Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Not a non-negative integer: ${value}` });
      return z.NEVER;
    }
    return parsed;
  });

const csv = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

/**
 * Sandbox containment modes (§ spine: "a sandbox for any code or command
 * execution, with the containment boundary configurable and the unsafe setting
 * loudly flagged").
 *
 *  - `disabled`   no execution is possible at all. The default, and the only
 *                 mode that is safe without external help.
 *  - `subprocess` a child process with resource limits. This constrains
 *                 accidents, not an adversary — it is NOT a security boundary.
 *  - `external`   execution is delegated to an isolation service the
 *                 deployment provides (gVisor, Firecracker, a container
 *                 sandbox). The only mode appropriate for untrusted code.
 */
export const SANDBOX_MODES = ["disabled", "subprocess", "external"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const STORE_KINDS = ["postgres", "memory"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

export const DEPLOY_ENVIRONMENTS = ["development", "test", "staging", "production"] as const;
export type DeployEnvironment = (typeof DEPLOY_ENVIRONMENTS)[number];

/**
 * Risk tiers, spelled out here rather than imported.
 *
 * The guard owns the concept; this module sits below it and may not import
 * upward. A duplicated four-item tuple is a smaller cost than inverting the
 * dependency, and `guard/guard.test.ts` asserts the two lists agree so they
 * cannot drift apart silently — a configured threshold naming a tier the guard
 * does not have would be a threshold that never fires.
 */
export const RISK_TIERS = ["routine", "sensitive", "high_consequence", "prohibited"] as const;

const schema = z.object({
  environment: z.enum(DEPLOY_ENVIRONMENTS).default("development"),
  serviceName: nonEmpty.default("project-vacation"),
  httpPort: positiveInt.default(8080),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  store: z.enum(STORE_KINDS).default("memory"),
  databaseUrl: z.string().optional(),
  databasePoolSize: positiveInt.default(10),

  // Identity. Absent in development; required in staging and production, which
  // is enforced in refine() below rather than by making the fields required.
  oidcIssuer: z.string().url().optional(),
  oidcClientId: z.string().optional(),
  oidcClientSecret: z.string().optional(),
  oidcRedirectUri: z.string().url().optional(),
  sessionSecret: z.string().optional(),
  stepUpMaxAgeSeconds: positiveInt.default(300),

  // Containment. Every one of these defaults to the safe setting.
  sandboxMode: z.enum(SANDBOX_MODES).default("disabled"),
  sandboxTimeoutMs: positiveInt.default(10_000),
  egressAllowlist: csv.default(""),

  // Work discovery ships off. See docs/adr/0012-work-discovery-default-off.md.
  discoveryEnabled: booleanish.default(false),
  discoveryRetentionDays: positiveInt.default(7),

  // Ceilings, enforced at consumption rather than only pre-flight.
  runSpendCeilingUsd: z.coerce.number().nonnegative().default(5),
  dailySpendCeilingUsd: z.coerce.number().nonnegative().default(500),
  runWallClockCeilingMs: positiveInt.default(15 * 60 * 1000),
  modelCallsPerMinute: positiveInt.default(120),

  // Model providers. Keys are read from the environment and never logged.
  modelProvider: z.enum(["fake", "anthropic"]).default("fake"),
  anthropicApiKey: z.string().optional(),
  anthropicBaseUrl: z.string().url().default("https://api.anthropic.com"),

  // The external-agent plane. It ships switched off, because turning it on
  // opens an inbound surface, and an inbound surface that nobody decided to
  // open is the kind of thing found later rather than chosen now. Nothing
  // about the switch is permissive: with the plane on, an unenrolled caller is
  // still refused, so enabling it grants no access by itself.
  externalAgentsEnabled: booleanish.default(false),
  /** Seats available to external agents. Enforced atomically at enrollment. */
  externalAgentSeatCap: positiveInt.default(25),
  externalAgentMaxEnrollmentDays: positiveInt.default(365),
  /** Tier at or above which a human must approve before an agent proceeds. */
  externalApprovalThreshold: z.enum(RISK_TIERS).default("high_consequence"),
  externalRequestsPerMinute: positiveInt.default(60),
  externalDenialsBeforeContainment: positiveInt.default(5),
  externalDenialWindowSeconds: positiveInt.default(300),
  /** Seconds without a heartbeat after which a live run is reclaimed. */
  externalRunReclaimAfterSeconds: positiveInt.default(120),
  externalAgentMaxSpendCeilingUsd: z.coerce.number().nonnegative().default(5_000),
  /**
   * Refuse plain bearer authentication from any agent holding a strong
   * credential. Defaults on: an agent that has been issued a signing key has no
   * reason to present a bearer token, and accepting one anyway would mean the
   * strong credential raised the ceiling without raising the floor.
   */
  externalRefuseBearerWhenStrong: booleanish.default(true),
  /**
   * Local JWKS file for verifying platform-native JWT assertions. Read from
   * disk at verify time — never fetched over the network, so an attacker who
   * can answer a JWKS URL cannot mint an identity.
   */
  externalJwksPath: z.string().optional(),

  auditRetentionDays: positiveInt.default(2555), // 7 years
  demoSeed: nonEmpty.default("project-vacation-demo-v1"),
});

export type Config = z.infer<typeof schema> & {
  /** Unsafe-but-permitted settings, surfaced at startup and in /health. */
  readonly warnings: readonly string[];
};

/**
 * The environment variable behind each setting.
 *
 * Exported so the documented surface — `.env.example`, which this file and the
 * CLI both point operators at — can be checked against it rather than kept in
 * step by hand. A control an operator cannot find in that file is a control
 * they do not know they have.
 */
export const ENV_KEYS: Record<keyof z.input<typeof schema>, string> = {
  environment: "PV_ENV",
  serviceName: "PV_SERVICE_NAME",
  httpPort: "PV_HTTP_PORT",
  logLevel: "PV_LOG_LEVEL",
  store: "PV_STORE",
  databaseUrl: "PV_DATABASE_URL",
  databasePoolSize: "PV_DATABASE_POOL_SIZE",
  oidcIssuer: "PV_OIDC_ISSUER",
  oidcClientId: "PV_OIDC_CLIENT_ID",
  oidcClientSecret: "PV_OIDC_CLIENT_SECRET",
  oidcRedirectUri: "PV_OIDC_REDIRECT_URI",
  sessionSecret: "PV_SESSION_SECRET",
  stepUpMaxAgeSeconds: "PV_STEP_UP_MAX_AGE_SECONDS",
  sandboxMode: "PV_SANDBOX_MODE",
  sandboxTimeoutMs: "PV_SANDBOX_TIMEOUT_MS",
  egressAllowlist: "PV_EGRESS_ALLOWLIST",
  discoveryEnabled: "PV_DISCOVERY_ENABLED",
  discoveryRetentionDays: "PV_DISCOVERY_RETENTION_DAYS",
  runSpendCeilingUsd: "PV_RUN_SPEND_CEILING_USD",
  dailySpendCeilingUsd: "PV_DAILY_SPEND_CEILING_USD",
  runWallClockCeilingMs: "PV_RUN_WALL_CLOCK_CEILING_MS",
  modelCallsPerMinute: "PV_MODEL_CALLS_PER_MINUTE",
  modelProvider: "PV_MODEL_PROVIDER",
  anthropicApiKey: "PV_ANTHROPIC_API_KEY",
  anthropicBaseUrl: "PV_ANTHROPIC_BASE_URL",
  externalAgentsEnabled: "PV_EXTERNAL_AGENTS_ENABLED",
  externalAgentSeatCap: "PV_EXTERNAL_AGENT_SEAT_CAP",
  externalAgentMaxEnrollmentDays: "PV_EXTERNAL_AGENT_MAX_ENROLLMENT_DAYS",
  externalApprovalThreshold: "PV_EXTERNAL_APPROVAL_THRESHOLD",
  externalRequestsPerMinute: "PV_EXTERNAL_REQUESTS_PER_MINUTE",
  externalDenialsBeforeContainment: "PV_EXTERNAL_DENIALS_BEFORE_CONTAINMENT",
  externalDenialWindowSeconds: "PV_EXTERNAL_DENIAL_WINDOW_SECONDS",
  externalRunReclaimAfterSeconds: "PV_EXTERNAL_RUN_RECLAIM_AFTER_SECONDS",
  externalAgentMaxSpendCeilingUsd: "PV_EXTERNAL_AGENT_MAX_SPEND_CEILING_USD",
  externalRefuseBearerWhenStrong: "PV_EXTERNAL_REFUSE_BEARER_WHEN_STRONG",
  externalJwksPath: "PV_EXTERNAL_JWKS_PATH",
  auditRetentionDays: "PV_AUDIT_RETENTION_DAYS",
  demoSeed: "PV_DEMO_SEED",
};

/**
 * Build configuration from an environment-variable map.
 *
 * @throws {ConfigError} on any missing required value or any unparseable one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw: Record<string, unknown> = {};
  for (const [field, envKey] of Object.entries(ENV_KEYS)) {
    const value = env[envKey];
    if (value !== undefined && value !== "") raw[field] = value;
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const field = issue.path[0];
        const envKey =
          typeof field === "string" ? (ENV_KEYS[field as keyof typeof ENV_KEYS] ?? field) : "?";
        return `${envKey}: ${issue.message}`;
      })
      .join("; ");
    throw new ConfigError(`Configuration is invalid: ${issues}`, { issues });
  }

  const config = parsed.data;
  const warnings: string[] = [];
  const isProductionLike = config.environment === "production" || config.environment === "staging";

  // Cross-field rules. These are the ones that make the difference between a
  // deployment that fails closed and one that quietly runs without a control.

  if (config.store === "postgres" && !config.databaseUrl) {
    throw new ConfigError(
      "PV_STORE=postgres requires PV_DATABASE_URL. Refusing to start without a durable operating record.",
      { store: config.store },
    );
  }

  if (isProductionLike) {
    if (config.store !== "postgres") {
      throw new ConfigError(
        `PV_STORE must be "postgres" in ${config.environment}. The in-memory store loses the operating record on restart.`,
        { environment: config.environment, store: config.store },
      );
    }
    const missingIdentity = (
      [
        ["oidcIssuer", config.oidcIssuer],
        ["oidcClientId", config.oidcClientId],
        ["oidcClientSecret", config.oidcClientSecret],
        ["oidcRedirectUri", config.oidcRedirectUri],
        ["sessionSecret", config.sessionSecret],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([field]) => ENV_KEYS[field]);

    if (missingIdentity.length > 0) {
      throw new ConfigError(
        `Single sign-on is required in ${config.environment}. Missing: ${missingIdentity.join(", ")}. There is no local password store.`,
        { environment: config.environment, missing: missingIdentity.join(",") },
      );
    }

    if ((config.sessionSecret ?? "").length < 32) {
      throw new ConfigError("PV_SESSION_SECRET must be at least 32 characters.", {});
    }

    if (config.modelProvider === "fake") {
      throw new ConfigError(
        `PV_MODEL_PROVIDER=fake is a test double and must not be used in ${config.environment}.`,
        { environment: config.environment },
      );
    }
  }

  if (config.modelProvider === "anthropic" && !config.anthropicApiKey) {
    throw new ConfigError("PV_MODEL_PROVIDER=anthropic requires PV_ANTHROPIC_API_KEY.", {});
  }

  // The external plane's controls are meaningless if they can be configured
  // away, so the two that would hollow it out are refused rather than warned
  // about.
  if (config.externalAgentsEnabled) {
    if (config.externalApprovalThreshold === "prohibited") {
      throw new ConfigError(
        'PV_EXTERNAL_APPROVAL_THRESHOLD=prohibited would mean no external agent action ever needs a human, because no action is registered above "prohibited". Set it to "high_consequence" or lower.',
        { threshold: config.externalApprovalThreshold },
      );
    }
    if (config.externalDenialsBeforeContainment < 1) {
      throw new ConfigError(
        "PV_EXTERNAL_DENIALS_BEFORE_CONTAINMENT must be at least 1. Zero would contain every agent on its first refusal, which operators would respond to by raising the value until it never fired.",
        { denialsBeforeContainment: config.externalDenialsBeforeContainment },
      );
    }
    if (config.externalRequestsPerMinute < 1) {
      throw new ConfigError(
        "PV_EXTERNAL_REQUESTS_PER_MINUTE must be at least 1. A limit of zero refuses every enrolled agent, which is containment by configuration rather than by decision.",
        { requestsPerMinute: config.externalRequestsPerMinute },
      );
    }
  }

  // Loud warnings for settings that are permitted but not safe.

  if (config.sandboxMode === "subprocess") {
    warnings.push(
      "SANDBOX: PV_SANDBOX_MODE=subprocess constrains accidents, not adversaries. It is NOT a security boundary. Untrusted code must not be executed in this mode.",
    );
  }
  if (config.sandboxMode !== "disabled" && isProductionLike && config.sandboxMode !== "external") {
    warnings.push(
      `SANDBOX: running with PV_SANDBOX_MODE=${config.sandboxMode} in ${config.environment}. Only "external" delegates to a real isolation boundary.`,
    );
  }
  if (config.store === "memory") {
    warnings.push(
      "STORE: the in-memory operating record is not durable. Every run, approval, and audit entry is lost on restart.",
    );
  }
  if (config.discoveryEnabled) {
    warnings.push(
      "DISCOVERY: employee work-discovery observation is ENABLED. Confirm employee notice, consent, state electronic-monitoring notice law, and works-council obligations are satisfied in writing. See docs/adr/0012-work-discovery-default-off.md.",
    );
  }
  if (config.egressAllowlist.length === 0) {
    warnings.push(
      "EGRESS: PV_EGRESS_ALLOWLIST is empty, so every outbound integration call will be refused.",
    );
  }
  if (config.externalAgentsEnabled && !config.externalRefuseBearerWhenStrong) {
    warnings.push(
      "EXTERNAL AGENTS: PV_EXTERNAL_REFUSE_BEARER_WHEN_STRONG is off, so an agent holding a signing key may still authenticate with a bearer token. A stolen token then works even though the agent was issued something better.",
    );
  }
  if (config.externalAgentsEnabled && !config.externalJwksPath) {
    warnings.push(
      "EXTERNAL AGENTS: no PV_EXTERNAL_JWKS_PATH is configured, so platform-native JWT assertions cannot be verified and agents can only hold bearer, HMAC, or pinned-key credentials.",
    );
  }
  if (!isProductionLike && !config.oidcIssuer) {
    warnings.push(
      "IDENTITY: no OIDC issuer configured. The development identity provider is in use and MUST NOT be enabled outside development.",
    );
  }

  return Object.freeze({ ...config, warnings: Object.freeze(warnings) });
}

/** Human-readable startup banner listing active containment settings. */
export function describeConfig(config: Config): string {
  const lines = [
    `environment       ${config.environment}`,
    `operating record  ${config.store}`,
    `identity          ${config.oidcIssuer ? `oidc (${config.oidcIssuer})` : "development provider"}`,
    `model provider    ${config.modelProvider}`,
    `sandbox           ${config.sandboxMode}`,
    `egress allowlist  ${config.egressAllowlist.length > 0 ? config.egressAllowlist.join(", ") : "(empty — all egress refused)"}`,
    `work discovery    ${config.discoveryEnabled ? "ENABLED" : "disabled"}`,
    `run spend ceiling  $${config.runSpendCeilingUsd.toFixed(2)}`,
  ];
  for (const warning of config.warnings) lines.push(`WARNING  ${warning}`);
  return lines.join("\n");
}
