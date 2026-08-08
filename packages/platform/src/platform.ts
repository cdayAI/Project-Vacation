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
import { RESCISSION_INTAKE_WORKFLOW } from "./workflows/rescission-intake.js";
import { buildRescissionIntakeHandlers } from "./workflows/handlers.js";
import { DiscoveryCollector } from "./discovery/collect.js";
import { MemoryDiscoveryStore } from "./discovery/store.memory.js";
import { PgDiscoveryStore } from "./discovery/store.pg.js";
import { effectiveRetentionDays } from "./discovery/retention.js";
import { RetentionPurgeJob, buildRetentionRules } from "./retention.js";
import { PLATFORM_ACTIONS } from "./actions.js";
import { defaultInventory, type ModelInventory } from "./models/inventory.js";
import { PromptTemplateRegistry } from "./models/templates.js";
import { MemoryEvaluationStore, MemoryRoleStore } from "./roles/store.memory.js";
import { PgEvaluationStore, PgRoleStore } from "./roles/store.pg.js";
import { RoleRegistry } from "./roles/registry.js";
import { RolePromotionService } from "./roles/promotion.js";
import { ROLE_ACTIONS } from "./roles/actions.js";
import type { EvaluationStore, RoleStore } from "./roles/port.js";
import { MemoryContactStore } from "./contact/store.memory.js";
import { PgContactStore } from "./contact/store.pg.js";
import { ConsentLedger } from "./contact/consent.js";
import { ContactGate } from "./contact/gate.js";
import { CONTACT_ACTIONS } from "./contact/actions.js";
import type { ContactStore } from "./contact/port.js";
import { MemoryKnowledgeStore } from "./knowledge/store.memory.js";
import { PgKnowledgeStore } from "./knowledge/store.pg.js";
import { IngestionService } from "./knowledge/ingest.js";
import { Retriever } from "./knowledge/retrieve.js";
import { GroundedAnswerService } from "./knowledge/answer.js";
import { FreshnessMonitor } from "./knowledge/freshness.js";
import { KNOWLEDGE_ACTIONS } from "./knowledge/actions.js";
import type { KnowledgeStore } from "./knowledge/port.js";
import { MemoryDocumentStore } from "./documents/store.memory.js";
import { PgDocumentStore } from "./documents/store.pg.js";
import { TemplateRegistry } from "./documents/templates.js";
import { DocumentGenerator } from "./documents/generate.js";
import { DOCUMENT_ACTIONS } from "./documents/actions.js";
import type { DocumentStore } from "./documents/port.js";

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
   * It ships exactly one built-in workflow — the rescission-packet intake, the
   * platform's flagship flow — published into the catalogue below with its
   * handlers registered, so `pv workflow start` runs real work through the real
   * engine and the human-task-and-timer durability gate is demonstrable rather
   * than only proven in a test. One is the honest count: a deployment publishes
   * the further definitions it has agreed and registers the handlers it has
   * implemented, and the catalogue is meant to grow that way rather than to
   * arrive full.
   */
  readonly engine: WorkflowEngine;
  /** Step implementations. A deployment registers what it has built. */
  readonly handlers: StepHandlerRegistry;
  /** Published workflow definitions. */
  readonly catalogue: WorkflowCatalogue;
  /**
   * The role factory, composed rather than merely written.
   *
   * `RoleRegistry`, `RolePromotionService`, and the two stores below were built,
   * tested, and reachable from no composition root: `draftRole`, the registry,
   * the promotion service, and the fairness analysis had no caller outside
   * tests, no CLI verb, and no API route, so no role could ever be authored or
   * promoted and `pv evaluate --ci` reported that nothing in the registry had
   * been evaluated because nothing could be. These fields are the wiring that
   * makes the factory reachable end to end. A capability nothing can reach is
   * not a capability.
   *
   * The properties the factory guarantees — versioned, diffable, attributable,
   * evidenced, approved, revertible, instantly disableable — live in the modules
   * below; exposing them here is what lets one instance serve the CLI and the
   * API rather than each surface building its own and drifting.
   */
  readonly roles: RoleRegistry;
  /** The role store the registry and promotion service share. Read for the harness and the console. */
  readonly roleStore: RoleStore;
  /** Golden sets and recorded evaluation runs — the evidence a promotion is checked against. */
  readonly evaluations: EvaluationStore;
  /** The only path from a definition to a role that may act: evidence plus a human approval. */
  readonly rolePromotion: RolePromotionService;
  /** The model inventory a role's task resolves through. Read on the promotion drift check. */
  readonly inventory: ModelInventory;
  /** The prompt templates a role references. Read on the promotion drift check and by the harness. */
  readonly templates: PromptTemplateRegistry;
  /**
   * The outbound contact-compliance gate, composed rather than merely written.
   *
   * `ContactGate` and `ConsentLedger` were built, tested, and reachable from no
   * composition root: they were constructed only inside their own tests, so the
   * gate had never gated a message outside them. There was no CLI verb, no API
   * route, and no consent-recording surface, which made §10 of the design — one
   * chokepoint verifying consent, revocation, do-not-call, quiet hours and
   * frequency caps, with the evidence stored beside the message — a proof rather
   * than a capability. A control nothing can reach refuses nothing. These three
   * fields are the wiring that makes the gate reachable end to end.
   *
   * The gate and the ledger share one store on purpose: a consent recorded
   * through the ledger has to be the consent the gate reads, and two instances
   * over two stores would answer the same question differently on the day it
   * mattered most.
   */
  readonly contactGate: ContactGate;
  /** Records consent grants, revocations, and do-not-call entries. The gate reads what it writes. */
  readonly consentLedger: ConsentLedger;
  /** The contact store the gate and the ledger share. Exposed for the console and evidence. */
  readonly contactStore: ContactStore;
  /**
   * The knowledge layer, composed rather than merely written.
   *
   * `IngestionService`, `Retriever`, `GroundedAnswerService`, and
   * `FreshnessMonitor` were built, tested, and reachable from no composition
   * root: the only place they were ever constructed together was the seeded
   * demonstration, which builds its own instances. So an operator could not
   * ingest a document, ask a regulated question, or record a corpus review in
   * the product — a demo could, and nothing else. A control nothing can reach
   * answers nothing, and "no grounding, no answer" is not a promise the platform
   * keeps if no caller can put the question to it. These fields are the wiring
   * that makes the layer reachable end to end.
   *
   * All four services share one store on purpose: the passage a `Retriever`
   * ranks must be the passage `IngestionService` screened and stored, and the
   * review a `FreshnessMonitor` records must be the one `GroundedAnswerService`
   * reads when it decides whether to refuse a stale corpus. Two stores would be
   * two answers to the same question on the day it mattered most.
   */
  readonly ingestion: IngestionService;
  /** Point-in-time lexical retrieval over the corpora an actor is entitled to read. */
  readonly retriever: Retriever;
  /** The `knowledge.retrieve` path: a cited answer, or a refusal that is routed to a human. */
  readonly groundedAnswers: GroundedAnswerService;
  /** Corpus review cadence — what the console shows and what the answer path refuses on. */
  readonly freshness: FreshnessMonitor;
  /** The knowledge store the four services above share. Exposed for the console and evidence. */
  readonly knowledgeStore: KnowledgeStore;
  /**
   * The document factory, composed rather than merely written.
   *
   * `DocumentGenerator` and `TemplateRegistry` were built, tested, and
   * reachable from no composition root: the generator was constructed only
   * inside its own tests, so §9 — a template version is a governed artifact,
   * generation is an action, and anything an owner will read passes the contact
   * gate — was a proof rather than a capability. No CLI verb and no route could
   * register a template, approve one, or generate a document, so the whole
   * subsystem was inert. A capability nothing can reach is not a capability.
   * These three fields are the wiring that makes the factory reachable end to
   * end.
   *
   * The generator is handed the platform's one `contactGate`, not a second one:
   * an owner-facing document is refused for an owner who revoked because the
   * gate the generator consults is the gate the consent ledger writes to, and
   * two gates over two stores would answer the same question differently on the
   * day it mattered most. The registry and the generator share one store for
   * the same reason the knowledge services do — the template a generation
   * renders has to be the exact version the registry approved.
   */
  readonly documents: DocumentGenerator;
  /** Register, approve, and retire template versions. The generator renders only what this approved. */
  readonly documentTemplates: TemplateRegistry;
  /** The document store the registry and the generator share. Exposed for the console and evidence. */
  readonly documentStore: DocumentStore;
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

  // The shipped catalogue plus the role, contact, knowledge, and document
  // lifecycle actions. `role.promote`, `consent.record`,
  // `contact.send_owner_message`, `knowledge.ingest_document`,
  // `document.generate_internal` and `document.generate_owner_facing` are
  // already in the catalogue; the rest — `role.propose`, `role.evaluate`,
  // `role.revert`, `contact.send_high_risk_message`,
  // `contact.record_do_not_call`, `knowledge.record_corpus_review`,
  // `document.register_template`, `document.approve_template`,
  // `document.retire_template` — live in their modules' `actions.ts` and are
  // spliced in here so the one chokepoint can resolve them. Without this the
  // promotion service's `propose`, the harness's evaluate, the registry's
  // `revert`, the elevated send path, a do-not-call write, a corpus review
  // attestation, and every template register/approve/retire would each be
  // refused with an "unknown action" the moment they were reached — which is
  // why they never were. Filtered by name so the day those move into
  // `src/actions.ts`, where they belong, this keeps working rather than failing
  // on a duplicate registration.
  const registry = new ActionRegistry([
    ...PLATFORM_ACTIONS,
    ...ROLE_ACTIONS.filter((action) => !PLATFORM_ACTIONS.some((entry) => entry.name === action.name)),
    ...CONTACT_ACTIONS.filter((action) => !PLATFORM_ACTIONS.some((entry) => entry.name === action.name)),
    ...KNOWLEDGE_ACTIONS.filter((action) => !PLATFORM_ACTIONS.some((entry) => entry.name === action.name)),
    ...DOCUMENT_ACTIONS.filter((action) => !PLATFORM_ACTIONS.some((entry) => entry.name === action.name)),
  ]);

  const authorizer = new Authorizer(
    registry,
    containment,
    ceilings,
    approvals,
    auditLog,
    clock,
    config.stepUpMaxAgeSeconds,
  );

  // The workflow catalogue and handler registry the engine reads.
  //
  // No longer empty: this deployment ships exactly one built-in flow, the
  // rescission-packet intake. Publishing it here — and registering the handlers
  // its two effecting steps name — is what makes `engine.start`,
  // `completeHumanTask`, `signalEvent`, and the sweep that fires statutory
  // timers reachable from the product instead of only from a test. The handlers
  // are seeded deterministically so the flow's model call reproduces byte for
  // byte. A deployment adds its own definitions and handlers alongside this one.
  const catalogue = new WorkflowCatalogue([RESCISSION_INTAKE_WORKFLOW]);
  const handlers = new StepHandlerRegistry();
  for (const [name, handler] of Object.entries(
    buildRescissionIntakeHandlers({ seed: config.demoSeed }),
  )) {
    handlers.register(name, handler);
  }
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

  // The role factory, composed here so the CLI and the API reach one instance.
  //
  // The stores mirror every other adapter above: the concrete implementation is
  // chosen from validated configuration and nowhere else. The inventory and the
  // template registry are the two the promotion service reads to refuse evidence
  // that describes a model or prompt that is no longer what would run — so they
  // are constructed once here rather than at each call site, where one caller
  // resolving them differently is how a drift check quietly stops checking.
  const inventory = defaultInventory(config.modelProvider);
  const templates = new PromptTemplateRegistry();
  const roleStore =
    db instanceof PgDb ? new PgRoleStore(db) : new MemoryRoleStore(memoryDb ?? new MemoryDb());
  const evaluations =
    db instanceof PgDb
      ? new PgEvaluationStore(db)
      : new MemoryEvaluationStore(memoryDb ?? new MemoryDb());
  const roles = new RoleRegistry(roleStore, registry, clock, ids, auditLog, authorizer);
  const rolePromotion = new RolePromotionService({
    roles: roleStore,
    evaluations,
    actions: registry,
    authorizer,
    approvals,
    containment,
    inventory,
    templates,
    audit: auditLog,
    clock,
  });

  // The contact-compliance gate, composed here so the CLI and the API reach one
  // instance.
  //
  // The store mirrors every other adapter above: the concrete implementation is
  // chosen from validated configuration and nowhere else. The ledger and the
  // gate are handed the same store deliberately — the gate reads consent the
  // ledger wrote, and two stores would be two answers. Both take the platform's
  // authorizer, so recording a consent, suppressing a destination, and clearing
  // a send each pass the one chokepoint: `consent.record`,
  // `contact.record_do_not_call` and `contact.send_owner_message` are registered
  // actions, and an actor without them is refused. The gate is given no policy
  // override, so it measures against the shipped artifact in `contact/policy.ts`.
  const contactStore =
    db instanceof PgDb ? new PgContactStore(db) : new MemoryContactStore(memoryDb ?? new MemoryDb());
  const consentLedger = new ConsentLedger(contactStore, authorizer, auditLog, clock, ids);
  const contactGate = new ContactGate(contactStore, authorizer, auditLog, clock, ids);

  // The document factory, composed here — after the contact gate, because it
  // depends on it — so the CLI and the API reach one generator over one store.
  //
  // The store mirrors every other adapter above: the concrete implementation is
  // chosen from validated configuration and nowhere else. The registry and the
  // generator are handed that one store deliberately — a generation renders the
  // exact template version the registry approved, and two stores would let a
  // draft be rendered as though approved. Both take the platform's authorizer,
  // so registering, approving and retiring a template, and generating a
  // document, each pass the one chokepoint: `document.register_template`,
  // `document.approve_template`, `document.retire_template`,
  // `document.generate_internal` and `document.generate_owner_facing` are
  // registered actions, and an actor without them is refused. The generator is
  // given the platform's own `contactGate`, not a second one — an owner-facing
  // document must be refused for an owner who revoked using the same gate the
  // consent ledger writes to. The registry is given `config.stepUpMaxAgeSeconds`
  // so approving a template measures step-up against the same window the rest of
  // the platform does.
  const documentStore =
    db instanceof PgDb ? new PgDocumentStore(db) : new MemoryDocumentStore(memoryDb ?? new MemoryDb());
  const documentTemplates = new TemplateRegistry(
    documentStore,
    authorizer,
    auditLog,
    clock,
    ids,
    config.stepUpMaxAgeSeconds,
  );
  const documents = new DocumentGenerator(
    documentStore,
    documentTemplates,
    authorizer,
    approvals,
    runs,
    contactGate,
    auditLog,
    clock,
    ids,
  );

  // The knowledge layer, composed here so the CLI and the API reach one set of
  // instances over one store.
  //
  // The store mirrors every other adapter above: the concrete implementation is
  // chosen from validated configuration and nowhere else. The four services are
  // handed that one store deliberately — a passage the retriever ranks has to be
  // the passage the ingestion service screened, and a review the freshness
  // monitor records has to be the one the answer path reads before it decides
  // whether to refuse stale authority; two stores would answer differently. The
  // ingestion service and the freshness monitor take the platform's authorizer,
  // so ingesting a document and attesting a corpus review each pass the one
  // chokepoint: `knowledge.ingest_document` and `knowledge.record_corpus_review`
  // are registered actions, and an actor without them is refused. The grounded
  // answer service is given the retriever and the store, and enforces its own
  // rule with no help — no grounding, no answer; stale authority, no answer.
  const knowledgeStore =
    db instanceof PgDb ? new PgKnowledgeStore(db) : new MemoryKnowledgeStore(memoryDb ?? new MemoryDb());
  const ingestion = new IngestionService(knowledgeStore, authorizer, auditLog, clock, ids);
  const retriever = new Retriever(knowledgeStore);
  const groundedAnswers = new GroundedAnswerService(retriever, knowledgeStore, auditLog, clock);
  const freshness = new FreshnessMonitor(knowledgeStore, clock, authorizer);

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
    roles,
    roleStore,
    evaluations,
    rolePromotion,
    inventory,
    templates,
    contactGate,
    consentLedger,
    contactStore,
    ingestion,
    retriever,
    groundedAnswers,
    freshness,
    knowledgeStore,
    documents,
    documentTemplates,
    documentStore,
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
