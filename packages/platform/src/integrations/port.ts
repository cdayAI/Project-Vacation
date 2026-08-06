import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type {
  AssociationBudgetSummary,
  AssociationRef,
  ContractRecord,
  CredentialRevocation,
  IntegrationCredential,
  IntegrationDescriptor,
  IntegrationHealth,
  ParkedItem,
  QueuedCall,
} from "./types.js";

/**
 * The integration ports.
 *
 * Every system of record sits behind one of these. Nothing in the platform
 * imports an adapter; workflows take a port, which is what makes the fakes
 * usable in the seeded demo and the whole test suite, and what makes swapping
 * a real adapter in a change of one line in the composition root.
 *
 * **Versioning is explicit and additive.** Each port declares a literal
 * `version`. When a field has to change shape in a way that breaks callers, a
 * `...PortV2` interface appears beside this one and both are served until every
 * caller has moved; the old interface is never quietly redefined. That is the
 * only way a "versioned interface" means anything — a version number that
 * changes meaning with the code it labels is decoration.
 *
 * **Every adapter must pass the contract suite** in `contract-tests.ts`,
 * including the fakes. A fake that is more forgiving than the real system
 * turns a green test suite into misinformation, which is worse than no fake.
 */

export interface Integration {
  readonly name: string;
  readonly version: number;
  describe(): IntegrationDescriptor;
  /**
   * Is the system reachable right now?
   *
   * Reports rather than throws: an operator needs to see "unavailable" on a
   * dashboard, and a caller that needs to act on unavailability uses the
   * degradation policy rather than a health check, because the state can change
   * between the check and the call.
   */
  health(): Promise<IntegrationHealth>;
}

/**
 * Contract metadata for rescission checking.
 *
 * **The real shape must be confirmed with MVW.** See the comment on
 * `ContractRecord`: nobody on this project has seen their contract system, and
 * every field here is an informed guess about what the statutory calculation
 * needs rather than a description of anything that exists.
 */
export interface ContractRecordsPort extends Integration {
  readonly version: 1;
  /**
   * One contract, or null when the system of record does not have it.
   *
   * Null means "no such contract". A system that cannot answer must throw, so
   * that "this contract does not exist" and "we could not look" stay
   * distinguishable — the first ends a workflow, the second must not.
   */
  getContract(contractId: Id<"contract">): Promise<ContractRecord | null>;
  /**
   * Contracts executed in a window, oldest first.
   *
   * The sweep that finds contracts still inside their rescission period. The
   * bound is half-open — `[from, to)` — so consecutive windows neither skip a
   * contract nor process one twice.
   */
  listContractsExecutedBetween(
    from: IsoTimestamp,
    to: IsoTimestamp,
    limit?: number,
  ): Promise<readonly ContractRecord[]>;
}

/**
 * Association budget and reserve data for board packs.
 *
 * **The real shape must be confirmed with MVW.** Association accounting is
 * where the guesswork is thickest: reserve study cadence, how a recommended
 * balance is expressed, and whether delinquency is even available per
 * association are all unknown to us.
 */
export interface AssociationRecordsPort extends Integration {
  readonly version: 1;
  listAssociations(): Promise<readonly AssociationRef[]>;
  /** Null when there is no budget on file for that year. */
  getBudgetSummary(
    associationId: string,
    fiscalYear: number,
  ): Promise<AssociationBudgetSummary | null>;
}

/**
 * Where outbound credentials come from.
 *
 * A narrow interface so the deployment can back it with an environment
 * variable, a secret manager, or a short-lived token service without anything
 * else in the platform knowing which. The egress client asks for a credential
 * by reference on every call — it never holds one — which is what makes
 * revocation take effect immediately rather than at the next restart.
 */
export interface SecretProvider {
  /**
   * Resolve a credential, or null when there is none.
   *
   * Implementations must return null for a revoked reference rather than
   * throwing, so the caller's refusal carries the right reason.
   */
  get(reference: string): Promise<IntegrationCredential | null>;
}

/**
 * Persistence for explicit degradation.
 *
 * `claimDue` is the operation with a concurrency requirement: two schedulers
 * running against one database must not both pick up the same queued call, or
 * the retry that was queued once happens twice. It is implemented as an atomic
 * claim in both adapters, and the contract tests run concurrent claimers
 * against both.
 */
export interface IntegrationQueueStore {
  /**
   * Queue a failed call, keyed on its idempotency key.
   *
   * Enqueuing the same key again updates the existing entry — attempts,
   * timings, last error — rather than adding a second one. One logical call,
   * one queue entry, however many times it fails.
   */
  enqueue(item: QueuedCall): Promise<QueuedCall>;
  getQueued(idempotencyKey: string): Promise<QueuedCall | null>;
  /** Atomically claim up to `limit` entries whose next attempt is due. */
  claimDue(now: IsoTimestamp, limit: number): Promise<readonly QueuedCall[]>;
  /** Mark a claimed entry done. */
  completeQueued(idempotencyKey: string, at: IsoTimestamp): Promise<QueuedCall | null>;
  /**
   * Release a claimed entry after another failure.
   *
   * `nextAttemptAt` of null abandons it: the queue has given up and a human
   * has to decide. An entry that silently disappears from the queue is an
   * effect nobody knows did not happen.
   */
  releaseQueued(
    idempotencyKey: string,
    at: IsoTimestamp,
    error: string,
    nextAttemptAt: IsoTimestamp | null,
  ): Promise<QueuedCall | null>;
  listQueued(filter?: {
    readonly integration?: string;
    readonly status?: readonly QueuedCall["status"][];
    readonly limit?: number;
  }): Promise<readonly QueuedCall[]>;

  /** Park work for a person. Keyed on `reference`, so parking is idempotent. */
  park(item: ParkedItem): Promise<ParkedItem>;
  getParked(reference: string): Promise<ParkedItem | null>;
  listParked(filter?: {
    readonly integration?: string;
    readonly includeResolved?: boolean;
    readonly limit?: number;
  }): Promise<readonly ParkedItem[]>;
  /** Returns null if it was already resolved, so two people cannot both close it. */
  resolveParked(
    reference: string,
    at: IsoTimestamp,
    by: string,
    resolution: string,
  ): Promise<ParkedItem | null>;
}

/**
 * Persistence for credential revocation.
 *
 * Separate from the secret provider on purpose. The secret material may live
 * in a vault this platform cannot write to; the *decision* that a credential is
 * out of service belongs to the platform's own record, is audited, and takes
 * effect without waiting for anyone else's rotation.
 */
export interface CredentialRevocationStore {
  revoke(revocation: CredentialRevocation): Promise<CredentialRevocation>;
  isRevoked(reference: string): Promise<boolean>;
  listRevocations(): Promise<readonly CredentialRevocation[]>;
}
