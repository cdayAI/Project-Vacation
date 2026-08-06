/**
 * Systems of record, behind narrow versioned interfaces.
 *
 * Four rules hold across the module.
 *
 *   *Every system of record sits behind a port.* Workflows take an interface,
 *   never an adapter, so the seeded demo and the whole test suite run against
 *   realistic fakes with no network, and a real adapter is one line in the
 *   composition root.
 *
 *   *One contract, every adapter.* `contract-tests.ts` exports the suite as
 *   data, so it runs under vitest against the fakes and can be run against a
 *   real adapter outside the test runner as a conformance check.
 *
 *   *Every outbound call passes the egress client.* Host allowlist, scoped
 *   credentials that are never logged, per-host rate limiting, timeouts,
 *   retries with idempotency keys, containment re-checked between attempts,
 *   and a step recorded before anything goes out.
 *
 *   *A failing integration degrades explicitly.* Queue, park for a human, or
 *   refuse — chosen by the caller, never a quietly worse answer. A refusal is
 *   never degraded: a governance decision must not become a retry loop.
 *
 * **The two port shapes are informed guesses and must be confirmed with MVW.**
 * Nobody on this project has seen their contract system or their association
 * accounting. `IntegrationDescriptor.shapeConfirmedWithMvw` is false on every
 * adapter shipped today and is surfaced in the console.
 */

export type {
  AssociationBudgetSummary,
  AssociationRef,
  ContractRecord,
  ContractStatus,
  CredentialRevocation,
  IntegrationCredential,
  IntegrationDescriptor,
  IntegrationHealth,
  ParkedItem,
  QueuedCall,
  QueuedCallStatus,
  RecordProvenance,
} from "./types.js";
export { CONTRACT_STATUSES } from "./types.js";

export type {
  AssociationRecordsPort,
  ContractRecordsPort,
  CredentialRevocationStore,
  Integration,
  IntegrationQueueStore,
  SecretProvider,
} from "./port.js";

export {
  CredentialRevocationService,
  RevocableSecretProvider,
  StaticSecretProvider,
  credentialPermitsHost,
  hostMatches,
  sealCredential,
} from "./credentials.js";

export {
  FakeAssociationRecords,
  FakeContractRecords,
  FakeIntegrationUnavailable,
  SEEDED_ASSOCIATION_IDS,
  SEEDED_CONTRACT_IDS,
} from "./fakes.js";

export type {
  AssociationRecordsContractOptions,
  ContractCase,
  ContractCaseResult,
  ContractRecordsContractOptions,
} from "./contract-tests.js";
export {
  assertContractSatisfied,
  associationRecordsContract,
  check,
  contractRecordsContract,
  formatContractResults,
  runContract,
} from "./contract-tests.js";

export type {
  EgressOptions,
  EgressOutcome,
  EgressRequest,
  HttpClient,
  HttpMethod,
  HttpRequest,
  HttpResponse,
} from "./egress.js";
export {
  EgressClient,
  FetchHttpClient,
  IntegrationCallError,
  isRetryableStatus,
  randomisedJitter,
} from "./egress.js";

export type {
  DegradationContext,
  DegradationOptions,
  DegradationOutcome,
  DegradationPolicy,
} from "./degrade.js";
export { DEGRADATION_POLICIES, DegradationHandler } from "./degrade.js";

export {
  MemoryCredentialRevocationStore,
  MemoryIntegrationQueueStore,
} from "./store.memory.js";
export { PgCredentialRevocationStore, PgIntegrationQueueStore } from "./store.pg.js";

export { MIGRATIONS as INTEGRATIONS_MIGRATIONS } from "./migrations.js";
