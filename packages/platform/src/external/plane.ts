import type { Clock } from "../kernel/clock.js";
import type { Config } from "../kernel/config.js";
import type { IdGenerator } from "../kernel/ids.js";
import type { AuditLog } from "../audit/log.js";
import type { RunStore } from "../record/port.js";
import type { OperatingMode } from "../record/types.js";
import type { ApprovalService } from "../guard/approvals.js";
import type { Authorizer } from "../guard/authorize.js";
import type { ContainmentController } from "../guard/containment.js";
import type { Db, MemoryDb } from "../store/db.js";
import { PgDb } from "../store/db.js";
import { AdmissionService } from "./admission.js";
import { ConnectorRouter, InMemorySwitchboard, type Connector } from "./connectors.js";
import { CredentialService, type SecretResolver } from "./credentials.js";
import { EnrollmentService, type EnrollmentLimits } from "./enrollment.js";
import { ExecutionService } from "./execute.js";
import { RateLimiter } from "./ratelimit.js";
import { ReportIngestor, DEFAULT_REPORT_LIMITS } from "./report.js";
import { LiveRunService } from "./runs.js";
import {
  MemoryCredentialStore,
  MemoryEnrollmentStore,
  MemoryExternalRunStore,
  MemoryNonceStore,
  MemoryParkedActionStore,
  MemoryRateLimitStore,
  MemorySpendStore,
  MemoryUsedApprovalLedger,
} from "./store.memory.js";
import {
  PgCredentialStore,
  PgEnrollmentStore,
  PgExternalRunStore,
  PgNonceStore,
  PgParkedActionStore,
  PgRateLimitStore,
  PgSpendStore,
  PgUsedApprovalLedger,
} from "./store.pg.js";
import type {
  CredentialStore,
  EnrollmentStore,
  ExternalRunStore,
  NonceStore,
  ParkedActionStore,
  RateLimitStore,
  SpendStore,
  UsedApprovalLedger,
} from "./port.js";

/**
 * Composition for the external-agent plane.
 *
 * MVW's teams and vendors are already running agents this platform did not
 * build and cannot orchestrate — inside a CRM, inside a cloud agent service,
 * inside products that were bought rather than written. Each is an
 * unsupervised actor touching owner data. This plane is how such an agent is
 * admitted, identified, limited, watched, stopped, and accounted for.
 *
 * Two rules govern what is assembled here.
 *
 * **One record.** Every service below writes to the same operating record,
 * the same audit chain and the same approval queue that native work uses.
 * Nothing here creates a second table of runs, a second queue of approvals, or
 * a second cost report. The only difference an external agent makes to the
 * record is that its principal is marked external — which is what lets a
 * supervisor see all the work in one place, and a finance report count all the
 * spend in one figure.
 *
 * **Nothing is optional.** The plane is composed whole or not at all. There is
 * no configuration that assembles the inbound API without the admission chain,
 * or the execution path without containment, because a plane missing one of
 * those pieces is not a smaller version of this — it is an ungoverned inbound
 * surface that looks governed.
 */

export interface ExternalStores {
  readonly agents: EnrollmentStore;
  readonly spend: SpendStore;
  readonly credentials: CredentialStore;
  readonly nonces: NonceStore;
  readonly usedApprovals: UsedApprovalLedger;
  readonly parked: ParkedActionStore;
  readonly runs: ExternalRunStore;
  readonly rateLimits: RateLimitStore;
}

export interface ExternalPlane {
  readonly enabled: boolean;
  readonly stores: ExternalStores;
  readonly enrollment: EnrollmentService;
  readonly credentials: CredentialService;
  readonly admission: AdmissionService;
  readonly rateLimiter: RateLimiter;
  readonly execution: ExecutionService;
  readonly liveRuns: LiveRunService;
  readonly reports: ReportIngestor;
  readonly connectors: ConnectorRouter;
  readonly switchboard: InMemorySwitchboard;
}

export interface BuildExternalPlaneInput {
  readonly config: Config;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly audit: AuditLog;
  readonly record: RunStore;
  readonly approvals: ApprovalService;
  readonly authorizer: Authorizer;
  readonly containment: ContainmentController;
  /** Postgres handle when the durable store is in use. */
  readonly db?: Db | undefined;
  /** The in-memory database, when it is. */
  readonly memoryDb?: MemoryDb | undefined;
  /** Governed operations an agent may be granted. Empty is a valid deployment. */
  readonly connectors?: readonly Connector[];
  /**
   * How HMAC secrets are resolved, by name, at verify time.
   *
   * The platform stores the *reference* and never the value, so a deployment
   * that has no secret manager wired gets a resolver that refuses — which
   * denies HMAC authentication rather than falling back to something weaker.
   */
  readonly secrets?: SecretResolver;
  /**
   * The mode recorded on external work and on operator actions about it.
   *
   * `supervised` by default, which is the honest description: the agent acts
   * on its own host, and this platform governs, records and can stop it. It is
   * not `bounded_autonomy`, because that would claim the platform set the
   * bounds of everything the agent does rather than of everything it asks us
   * for.
   */
  readonly operatingMode?: OperatingMode;
}

/**
 * A resolver that has nothing to resolve.
 *
 * The default when a deployment has not wired a secret manager. It returns
 * null rather than throwing because null is what `CredentialService` turns
 * into a denial; throwing would be reported as an infrastructure failure and
 * would not count toward the agent's misbehaviour, which is the wrong story
 * for a credential nobody ever provisioned.
 */
const NO_SECRETS: SecretResolver = {
  async resolve(): Promise<string | null> {
    return null;
  },
};

export function buildExternalPlane(input: BuildExternalPlaneInput): ExternalPlane {
  const { config, clock, ids, audit, record, approvals, authorizer, containment } = input;

  const stores = buildExternalStores(input);

  const limits: EnrollmentLimits = {
    seatCap: config.externalAgentSeatCap,
    maxEnrollmentDays: config.externalAgentMaxEnrollmentDays,
    maxSpendCeilingUsd: config.externalAgentMaxSpendCeilingUsd,
    maxWallClockCeilingMs: config.runWallClockCeilingMs,
    maxToolGrants: 64,
    maxDataScopes: 32,
  };

  const mode: OperatingMode = input.operatingMode ?? "supervised";

  const enrollment = new EnrollmentService(
    stores.agents,
    authorizer,
    audit,
    clock,
    ids,
    limits,
    mode,
  );

  const credentials = new CredentialService(
    stores.credentials,
    stores.nonces,
    input.secrets ?? NO_SECRETS,
    clock,
    ids,
    audit,
    { refuseBearerWhenStrongCredentialExists: config.externalRefuseBearerWhenStrong },
  );

  const rateLimiter = new RateLimiter(stores.rateLimits, stores.agents, audit, clock, {
    perOperationPerMinute: config.externalRequestsPerMinute,
    denialsBeforeContainment: config.externalDenialsBeforeContainment,
    denialWindowMs: config.externalDenialWindowSeconds * 1000,
  });

  const admission = new AdmissionService(
    stores.agents,
    stores.spend,
    rateLimiter,
    approvals,
    audit,
    clock,
    { approvalThreshold: config.externalApprovalThreshold },
    containment,
  );

  const switchboard = new InMemorySwitchboard();
  const connectors = new ConnectorRouter(input.connectors ?? [], switchboard);

  const execution = new ExecutionService(
    admission,
    stores.parked,
    stores.usedApprovals,
    approvals,
    stores.agents,
    connectors,
    containment,
    record,
    rateLimiter,
    audit,
    clock,
    ids,
  );

  const liveRuns = new LiveRunService(
    stores.runs,
    stores.agents,
    stores.spend,
    record,
    audit,
    clock,
    ids,
    {
      reclaimAfterSeconds: config.externalRunReclaimAfterSeconds,
      operatingMode: mode,
      maxRunCostUsd: DEFAULT_REPORT_LIMITS.maxCostUsd,
    },
    containment,
  );

  const reports = new ReportIngestor(
    stores.runs,
    stores.agents,
    stores.spend,
    record,
    audit,
    clock,
    ids,
    { limits: DEFAULT_REPORT_LIMITS, operatingMode: mode },
  );

  return {
    enabled: config.externalAgentsEnabled,
    stores,
    enrollment,
    credentials,
    admission,
    rateLimiter,
    execution,
    liveRuns,
    reports,
    connectors,
    switchboard,
  };
}

/**
 * Choose the adapters.
 *
 * The same decision the rest of the composition root makes, made once here so
 * that no service below picks its own. Note that the durable adapters are not
 * merely preferred: the replay-protection nonces and the used-approval ledger
 * are only real protections when they are shared between workers, and
 * `loadConfig` already refuses the in-memory store outside development.
 */
function buildExternalStores(input: BuildExternalPlaneInput): ExternalStores {
  const { db, memoryDb } = input;

  if (db instanceof PgDb) {
    return {
      agents: new PgEnrollmentStore(db),
      spend: new PgSpendStore(db),
      credentials: new PgCredentialStore(db),
      nonces: new PgNonceStore(db),
      usedApprovals: new PgUsedApprovalLedger(db),
      parked: new PgParkedActionStore(db),
      runs: new PgExternalRunStore(db),
      rateLimits: new PgRateLimitStore(db),
    };
  }

  if (!memoryDb) {
    // Unreachable through `buildPlatform`, which always has one or the other.
    // Kept because a plane assembled without a store would fail at the first
    // inbound request rather than at startup, and startup is where an
    // operator is looking.
    throw new Error(
      "The external-agent plane needs either a Postgres handle or an in-memory database.",
    );
  }

  return {
    agents: new MemoryEnrollmentStore(memoryDb),
    spend: new MemorySpendStore(memoryDb),
    credentials: new MemoryCredentialStore(memoryDb),
    nonces: new MemoryNonceStore(memoryDb),
    usedApprovals: new MemoryUsedApprovalLedger(memoryDb),
    parked: new MemoryParkedActionStore(memoryDb),
    runs: new MemoryExternalRunStore(memoryDb),
    rateLimits: new MemoryRateLimitStore(memoryDb),
  };
}
