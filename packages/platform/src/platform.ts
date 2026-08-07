import pg from "pg";
import { FixedClock, SystemClock, type Clock } from "./kernel/clock.js";
import { RandomIdGenerator, SeededIdGenerator, type IdGenerator } from "./kernel/ids.js";
import { createLogger, type Logger } from "./kernel/logger.js";
import { describeConfig, type Config } from "./kernel/config.js";
import { createPool, MemoryDb, PgDb, type Db } from "./store/db.js";
import { ALL_MIGRATIONS } from "./store/registry.js";
import { migrationStatus, runMigrations, type MigrationStatus } from "./store/migrate.js";
import { MemoryRunStore } from "./record/store.memory.js";
import { PgRunStore } from "./record/store.pg.js";
import type { RunStore } from "./record/port.js";
import { MemoryAuditStore } from "./audit/store.memory.js";
import { PgAuditStore } from "./audit/store.pg.js";
import { AuditLog } from "./audit/log.js";
import { MemoryApprovalStore, MemoryContainmentStore } from "./guard/store.memory.js";
import { PgApprovalStore, PgContainmentStore } from "./guard/store.pg.js";
import { ApprovalService } from "./guard/approvals.js";
import { CeilingEnforcer } from "./guard/ceilings.js";
import { ContainmentController } from "./guard/containment.js";
import { ActionRegistry } from "./guard/registry.js";
import { Authorizer } from "./guard/authorize.js";
import { createSandbox, type Sandbox } from "./guard/sandbox.js";
import { buildExternalPlane, type ExternalPlane } from "./external/plane.js";
import type { Connector } from "./external/connectors.js";
import type { SecretResolver } from "./external/credentials.js";
import { MemoryObservationStore } from "./improve/store.memory.js";
import { PgObservationStore } from "./improve/store.pg.js";
import { ObservationHarvester } from "./improve/harvest.js";
import { WorkflowCatalogue } from "./engine/definition.js";
import { MemoryWorkflowStore } from "./engine/store.memory.js";
import { PgWorkflowStore } from "./engine/store.pg.js";
import { StepHandlerRegistry, WorkflowEngine } from "./engine/runner.js";
import { DiscoveryCollector } from "./discovery/collect.js";
import { MemoryDiscoveryStore } from "./discovery/store.memory.js";
import { PgDiscoveryStore } from "./discovery/store.pg.js";
import { effectiveRetentionDays } from "./discovery/retention.js";
import { RetentionPurgeJob, buildRetentionRules } from "./retention.js";
import { PLATFORM_ACTIONS } from "./actions.js";

/**
 * The composition root.
 *
 * Every dependency in this platform is injected, which is what makes the
 * controls testable and the demo reproducible — but injection is only half the
 * story. Something has to decide, once, which concrete implementation each
 * port gets. That decision lives here and nowhere else.
 *
 * Two consequences worth stating, because both are load-bearing:
 *
 * Modules never construct their own adapters. A module that reached for a
 * Postgres client directly would be untestable and would quietly bypass the
 * configuration that decides whether this deployment is even allowed to use
 * one. Everything arrives through a constructor.
 *
 * The choice between the real and the fake implementation is made from
 * configuration that has already been validated. `loadConfig` refuses the
 * in-memory store and the fake model provider in staging and production before
 * this function runs, so there is no code path here that can accidentally
 * assemble a production platform out of test doubles.
 */

export interface Platform {
  readonly config: Config;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly runs: RunStore;
  readonly audit: AuditLog;
  readonly approvals: ApprovalService;
  readonly containment: ContainmentController;
  readonly ceilings: CeilingEnforcer;
  readonly registry: ActionRegistry;
  readonly authorizer: Authorizer;
  readonly sandbox: Sandbox;
  /**
   * Governance for agents running outside this platform.
   *
   * Always composed, whatever `PV_EXTERNAL_AGENTS_ENABLED` says. The flag
   * decides whether the inbound surface answers, not whether the controls
   * exist: a plane assembled only when enabled would be a plane whose first
   * exercise happened in production on the day somebody switched it on.
   */
  readonly external: ExternalPlane;
  /**
   * Stage one of the improvement loop: where a human disagreement is recorded.
   *
   * Only the harvester is composed here, and that is the whole intent rather
   * than an unfinished job. The console's "correct this" control needs a place
   * to put a correction, and a correction is inert evidence tied to a run. The
   * stages that turn evidence into a behaviour change — propose, evaluate,
   * approve, apply — are deliberately *not* reachable from the request path,
   * so nothing an operator clicks in a browser is one call away from changing
   * what the platform does. ADR 0011.
   */
  readonly observations: ObservationHarvester;
  /**
   * The retention policy, enforced.
   *
   * Composed always, and deliberately not behind a flag. `retention.purged` was
   * a declared audit event type with no producer, `PV_AUDIT_RETENTION_DAYS` was
   * a configured period nothing read, and the assurance document describing the
   * purge stated in the present tense that it ran daily. A deployment that
   * composed the job only when somebody remembered to would reproduce that gap
   * one environment at a time.
   *
   * `pv worker` drives it. Nothing else does: a purge triggered from a request
   * path would be a deletion an operator could cause by clicking.
   */
  readonly retention: RetentionPurgeJob;
  /**
   * Settings every statutory-deadline computation must be given.
   *
   * Composed here rather than passed at each call site, because the one that
   * matters — refusing to derive a deadline from an unverified rule — was a
   * documented production control that nothing could set. A caller that has to
   * remember to pass it is a caller that will one day forget, and forgetting
   * produces a plausible legal date rather than a refusal.
   */
  readonly timeline: TimelineSettings;
  /**
   * The workflow engine, composed rather than merely available.
   *
   * It was written, tested, and never built by any composition root — so
   * `serve`, the CLI and the console all ran on a platform with no engine
   * object at all, and the sweep that fires statutory deadline timers had
   * nothing to call it. A capability nothing can reach is not a capability.
   *
   * It starts with an empty catalogue and an empty handler registry: a
   * deployment publishes the definitions it has agreed and registers the
   * handlers it has implemented. Empty is the honest state for a platform whose
   * first business workflow has not been signed off, and it is very different
   * from absent.
   */
  readonly engine: WorkflowEngine;
  /** Step implementations. A deployment registers what it has built. */
  readonly handlers: StepHandlerRegistry;
  /** Published workflow definitions. */
  readonly catalogue: WorkflowCatalogue;
  /** Present only when the Postgres store is in use. */
  readonly db?: Db;
  /** Release connections. Safe to call more than once. */
  close(): Promise<void>;
}

export interface TimelineSettings {
  /** When true, an unverified rule denies instead of answering. */
  readonly requireVerifiedRules: boolean;
}

export interface BuildOptions {
  /**
   * Override the clock. The demo passes a `FixedClock` so its output is
   * byte-identical on every run.
   */
  readonly clock?: Clock;
  /** Override id generation. The demo passes a `SeededIdGenerator`. */
  readonly ids?: IdGenerator;
  readonly logger?: Logger;
  /** Reuse an existing in-memory database, for tests that inspect it. */
  readonly memoryDb?: MemoryDb;
  /**
   * Governed operations external agents may be granted.
   *
   * Empty by default. A deployment that has not decided which systems an
   * external agent may reach through this platform should expose none, rather
   * than a plausible-looking set nobody approved.
   */
  readonly connectors?: readonly Connector[];
  /** Resolves HMAC secrets by name at verify time. */
  readonly secrets?: SecretResolver;
}

export async function buildPlatform(
  config: Config,
  options: BuildOptions = {},
): Promise<Platform> {
  const clock = options.clock ?? new SystemClock();
  const ids =
    options.ids ??
    (config.environment === "development" && config.store === "memory"
      ? new RandomIdGenerator()
      : new RandomIdGenerator());
  const logger =
    options.logger ??
    createLogger({
      level: config.logLevel,
      serviceName: config.serviceName,
      environment: config.environment,
    });

  let runs: RunStore;
  let auditLog: AuditLog;
  let approvals: ApprovalService;
  let containment: ContainmentController;
  let observationStore: MemoryObservationStore | PgObservationStore;
  let db: Db | undefined;
  let memoryDb: MemoryDb | undefined;
  let pool: pg.Pool | undefined;

  if (config.store === "postgres") {
    if (!config.databaseUrl) {
      // Unreachable: loadConfig refuses this combination. Kept as a guard
      // because "unreachable" and "unchecked" are different things.
      throw new Error("PV_STORE=postgres requires PV_DATABASE_URL");
    }
    // The logger is handed in so a lost idle connection is reported rather than
    // swallowed. It must never be fatal: see `createPool`.
    pool = createPool(config.databaseUrl, config.databasePoolSize, (error) => {
      logger.error("database connection lost while idle", {
        error,
        note: "Actions will refuse until the database is reachable. The pool reconnects on the next query.",
      });
    });
    db = new PgDb(pool);

    runs = new PgRunStore(db, clock, ids);
    const auditStore = new PgAuditStore(db);
    auditLog = new AuditLog(auditStore, clock, ids);
    approvals = new ApprovalService(new PgApprovalStore(db), clock, ids, auditLog);
    containment = new ContainmentController(new PgContainmentStore(db), clock, auditLog);
    observationStore = new PgObservationStore(db);
  } else {
    const memory = options.memoryDb ?? new MemoryDb();
    memoryDb = memory;
    runs = new MemoryRunStore(memory, clock, ids);
    auditLog = new AuditLog(new MemoryAuditStore(memory), clock, ids);
    approvals = new ApprovalService(new MemoryApprovalStore(memory), clock, ids, auditLog);
    containment = new ContainmentController(new MemoryContainmentStore(memory), clock, auditLog);
    observationStore = new MemoryObservationStore(memory);
  }

  const ceilings = new CeilingEnforcer(
    {
      runSpendUsd: config.runSpendCeilingUsd,
      dailySpendUsd: config.dailySpendCeilingUsd,
      runWallClockMs: config.runWallClockCeilingMs,
      modelCallsPerMinute: config.modelCallsPerMinute,
    },
    clock,
    runs,
  );

  const registry = new ActionRegistry(PLATFORM_ACTIONS);

  const authorizer = new Authorizer(
    registry,
    containment,
    ceilings,
    approvals,
    auditLog,
    clock,
    config.stepUpMaxAgeSeconds,
  );

  const catalogue = new WorkflowCatalogue();
  const handlers = new StepHandlerRegistry();
  const workflowStore =
    db instanceof PgDb ? new PgWorkflowStore(db) : new MemoryWorkflowStore(memoryDb ?? new MemoryDb());

  const sandbox = createSandbox(config.sandboxMode, {
    timeoutMs: config.sandboxTimeoutMs,
    clock,
  });

  // Constructed after the authorizer, because recording a correction passes
  // the same chokepoint as any other action: `improvement.observe` is a
  // registered action and an actor without it is refused.
  const observations = new ObservationHarvester({
    observations: observationStore,
    runs,
    authorizer,
    audit: auditLog,
    clock,
    ids,
  });

  const engine = new WorkflowEngine({
    catalogue,
    store: workflowStore,
    runs,
    audit: auditLog,
    registry,
    authorizer,
    containment,
    approvals,
    ceilings,
    handlers,
    clock,
    ids,
    logger,
    timeline: { requireVerifiedRules: config.requireVerifiedStatutoryRules },
  });

  // Composed for its purge, not for its collector.
  //
  // Work discovery ships disabled and stays disabled, but the observations it
  // may already have written are the most sensitive rows this platform can
  // hold, and their thirty-day ceiling is a promise made to MVW in writing. The
  // purge has to be reachable whatever the flag says, because switching the
  // feature off must not be what preserves the data.
  //
  // Settings are built through the clamp rather than through
  // `discoverySettings`, which refuses an over-long period: startup is the
  // wrong place to discover that, and a configured value past the ceiling is
  // supposed to result in a *shorter* purge, not in no purge at all.
  const discoveryStore =
    db instanceof PgDb
      ? new PgDiscoveryStore(db)
      : new MemoryDiscoveryStore(memoryDb ?? new MemoryDb());
  const discovery = new DiscoveryCollector(
    discoveryStore,
    clock,
    ids,
    {
      enabled: config.discoveryEnabled,
      retentionDays: effectiveRetentionDays(config.discoveryRetentionDays),
    },
  );

  const retention = new RetentionPurgeJob(
    buildRetentionRules({ config, clock, observations: observationStore, discovery }),
    auditLog,
    clock,
  );

  const external = buildExternalPlane({
    config,
    clock,
    ids,
    audit: auditLog,
    record: runs,
    approvals,
    authorizer,
    containment,
    db,
    memoryDb,
    ...(options.connectors ? { connectors: options.connectors } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  });

  // The startup banner is not decoration. An operator must be able to see, at a
  // glance, whether the sandbox is contained and whether employee observation
  // is switched on — without reading the environment.
  logger.info("platform starting", {
    store: config.store,
    sandboxMode: config.sandboxMode,
    sandboxContained: sandbox.isContained,
    discoveryEnabled: config.discoveryEnabled,
    modelProvider: config.modelProvider,
    externalAgentsEnabled: config.externalAgentsEnabled,
    requireVerifiedStatutoryRules: config.requireVerifiedStatutoryRules,
  });
  for (const warning of config.warnings) logger.warn(warning);

  return {
    config,
    clock,
    ids,
    logger,
    runs,
    audit: auditLog,
    approvals,
    containment,
    ceilings,
    registry,
    authorizer,
    sandbox,
    external,
    timeline: { requireVerifiedRules: config.requireVerifiedStatutoryRules },
    engine,
    handlers,
    catalogue,
    observations,
    retention,
    db,
    async close() {
      if (pool) await pool.end();
    },
  };
}

/**
 * Build a platform wired for reproducible output.
 *
 * Used by the seeded demonstration and by tests that assert on exact values.
 * The fixed clock and seeded id generator are the whole reason `pnpm demo`
 * produces identical bytes on two cold starts, which CI checks by running it
 * twice and diffing.
 */
export function buildDeterministicPlatform(
  config: Config,
  startInstant: string,
  seed: string,
): Promise<{ platform: Platform; clock: FixedClock }> {
  const clock = new FixedClock(startInstant);
  return buildPlatform(config, { clock, ids: new SeededIdGenerator(seed) }).then((platform) => ({
    platform,
    clock,
  }));
}

/** Apply pending migrations. Returns what was applied. */
export async function migrate(platform: Platform): Promise<{ applied: readonly string[] }> {
  if (!platform.db) {
    // The in-memory store has no schema; saying so is better than silently
    // succeeding and letting someone believe a migration ran.
    throw new Error(
      "Migrations apply to the Postgres store only. Set PV_STORE=postgres and PV_DATABASE_URL.",
    );
  }
  const result = await runMigrations(platform.db, ALL_MIGRATIONS);
  return { applied: result.applied };
}

/**
 * What this deployment's schema is, against what this build expects.
 *
 * Null when the store has no schema at all, which is a different answer from
 * "nothing is pending" and has to stay distinguishable: an operator who runs
 * this against a memory-backed process and reads "up to date" has been told
 * something false about a database that does not exist.
 */
export async function migrationState(platform: Platform): Promise<MigrationStatus | null> {
  if (!platform.db) return null;
  return migrationStatus(platform.db, ALL_MIGRATIONS);
}

export { describeConfig };
