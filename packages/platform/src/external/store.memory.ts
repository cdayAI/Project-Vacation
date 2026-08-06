import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import type { MemoryDb } from "../store/db.js";
import {
  BUDGET_PERIODS,
  DEFAULT_NONCE_CAP_PER_AGENT,
  assertDigestForm,
  assertOptionalDigestForm,
  assertPeriodKey,
  assertSecretRef,
  assertSpendAmount,
  assertTokenHash,
  isExpirableParkedStatus,
} from "./migrations.js";
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
import {
  isStrongCredentialKind,
  type AgentCredential,
  type DenialClass,
  type EnrolledAgent,
  type EnrollmentUpdate,
  type ExternalAgentId,
  type ExternalRun,
  type ExternalRunStatus,
  type ParkedAction,
  type ParkedActionStatus,
  type SpendMeter,
} from "./types.js";

/**
 * In-memory external-agent plane.
 *
 * Held to the same contract as the Postgres adapter — `store.contract.test.ts`
 * in this directory runs every assertion, including the concurrency ones,
 * against both. A fake that is more forgiving than the real store makes the
 * whole suite lie about code that will fail in production, and in this module
 * the things that would fail are a seat cap, a replay guard, and a one-shot
 * approval.
 *
 * So every operation the port specifies as atomic takes `MemoryDb.withLock`,
 * mirroring the row lock or single statement the Postgres adapter uses. As in
 * `record/store.memory.ts`, stated honestly: several of these bodies contain no
 * await and on a single-threaded runtime could not interleave without the lock.
 * The lock is taken anyway, because the atomicity is a property of the contract
 * rather than of the runtime, and the first await added to one of these bodies
 * later would silently reopen a window nobody would think to look for.
 *
 * Everything is cloned on the way in and on the way out, so a caller that keeps
 * a reference to what it stored — or mutates what it was handed — cannot
 * rewrite the registry after the fact.
 */

const AGENTS = "external_agent";
const SEATS = "external_seat";
const METERS = "external_spend_meter";
const CREDENTIALS = "external_credential";
const NONCES = "external_nonce";
const USED_APPROVALS = "external_used_approval";
const APPROVAL_FLOOR = "external_approval_floor";
const PARKED = "external_parked_action";
const RUNS = "external_run";
const REPORT_CLAIMS = "external_report_claim";
const RATE_REQUESTS = "external_rate_request";
const RATE_DENIALS = "external_rate_denial";

const SEAT_ROW = "seats";
const FLOOR_ROW = "floor";

interface NonceRow {
  readonly agentId: string;
  readonly nonce: string;
  readonly expiresAt: string;
}

interface UsedApprovalRow {
  readonly approvalId: string;
  readonly consumedAt: string;
}

interface FloorRow {
  readonly floorApprovalId: string;
  readonly evictedBefore: string;
}

interface ReportClaimRow {
  readonly agentId: string;
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly claimedAt: string;
}

interface RateRow {
  readonly agentId: string;
  readonly operation: string;
  readonly denialClass?: DenialClass;
  readonly at: string;
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export class MemoryEnrollmentStore implements EnrollmentStore {
  constructor(private readonly db: MemoryDb) {}

  async createAgent(agent: EnrolledAgent): Promise<EnrolledAgent> {
    assertAgent(agent);

    // A registry-wide lock rather than a per-id one, because the uniqueness
    // being defended is on `name`: two concurrent enrolments of the same name
    // hold different ids and would not contend on a per-id lock.
    return this.db.withLock("external:agent:registry", async () => {
      const table = this.db.table<EnrolledAgent>(AGENTS);
      if (table.has(agent.id)) {
        throw new InvalidInputError(
          `External agent ${agent.id} already exists. Agent identifiers are assigned once; reusing one would silently re-point every credential, meter and run that already refers to it.`,
          "id",
        );
      }
      for (const existing of table.values()) {
        if (existing.name === agent.name) {
          throw new InvalidInputError(
            `An external agent named "${agent.name}" is already enrolled. Names are how operators identify an agent in the roster and in an incident, so two agents cannot share one.`,
            "name",
          );
        }
      }
      table.set(agent.id, structuredClone(agent));
      return structuredClone(agent);
    });
  }

  async getAgent(id: ExternalAgentId): Promise<EnrolledAgent | null> {
    const found = this.db.table<EnrolledAgent>(AGENTS).get(id);
    return found ? structuredClone(found) : null;
  }

  async getAgentByName(name: string): Promise<EnrolledAgent | null> {
    // Exact match, never case-insensitive. "CRM-Bot" and "crm-bot" are two
    // enrolments with two owners and two ceilings, and treating them as one
    // would admit a caller under someone else's grant.
    for (const agent of this.db.rows<EnrolledAgent>(AGENTS)) {
      if (agent.name === name) return structuredClone(agent);
    }
    return null;
  }

  async listAgents(
    filter: {
      readonly status?: readonly EnrolledAgent["status"][];
      readonly department?: string;
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): Promise<readonly EnrolledAgent[]> {
    const matched = this.db.rows<EnrolledAgent>(AGENTS).filter((agent) => {
      if (filter.status && !filter.status.includes(agent.status)) return false;
      if (filter.department !== undefined && agent.department !== filter.department) return false;
      return true;
    });

    // By name, not by time. A roster is browsed rather than followed, and under
    // a fixed clock every agent shares an enrolledAt — so a time ordering would
    // be whatever the sort happened to do.
    matched.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return page(matched, filter.limit, filter.offset).map((agent) => structuredClone(agent));
  }

  async countAgents(): Promise<number> {
    return this.db.table<EnrolledAgent>(AGENTS).size;
  }

  async updateAgent(
    id: ExternalAgentId,
    update: EnrollmentUpdate,
    at: string,
  ): Promise<EnrolledAgent> {
    assertIsoUtc("at", at);
    assertOptionalIsoUtc("expiresAt", update.expiresAt);
    if (update.riskCeiling !== undefined) assertRiskCeiling(update.riskCeiling);
    if (update.budgetPeriod !== undefined) assertBudgetPeriod(update.budgetPeriod);
    if (update.spendCeilingUsd !== undefined) assertSpendAmount(update.spendCeilingUsd);

    return this.db.withLock(`external:agent:${id}`, async () => {
      const table = this.db.table<EnrolledAgent>(AGENTS);
      const current = table.get(id);
      if (!current) throw unknownAgent(id);

      // Field by field, from a declared list. A caller that passes a whole
      // agent where an update was expected cannot reach `status` or
      // `enrolledAt` through this door — and that matters more here than
      // elsewhere, because re-enrolment would then be the documented way to
      // lift a containment.
      const next: EnrolledAgent = {
        ...current,
        ...(update.owner !== undefined ? { owner: update.owner } : {}),
        ...(update.department !== undefined ? { department: update.department } : {}),
        ...(update.hostPlatform !== undefined ? { hostPlatform: update.hostPlatform } : {}),
        ...(update.purpose !== undefined ? { purpose: update.purpose } : {}),
        ...(update.allowedTools !== undefined ? { allowedTools: update.allowedTools } : {}),
        ...(update.riskCeiling !== undefined ? { riskCeiling: update.riskCeiling } : {}),
        ...(update.spendCeilingUsd !== undefined
          ? { spendCeilingUsd: update.spendCeilingUsd }
          : {}),
        ...(update.budgetPeriod !== undefined ? { budgetPeriod: update.budgetPeriod } : {}),
        ...(update.wallClockCeilingMs !== undefined
          ? { wallClockCeilingMs: update.wallClockCeilingMs }
          : {}),
        ...(update.dataScopes !== undefined ? { dataScopes: update.dataScopes } : {}),
        ...(update.expiresAt !== undefined ? { expiresAt: update.expiresAt } : {}),
        updatedAt: at,
      };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async setAgentStatus(input: {
    readonly id: ExternalAgentId;
    readonly expectedStatus: EnrolledAgent["status"];
    readonly status: EnrolledAgent["status"];
    readonly reason: string;
    readonly by: string;
    readonly at: string;
  }): Promise<EnrolledAgent | null> {
    assertIsoUtc("at", input.at);

    return this.db.withLock(`external:agent:${input.id}`, async () => {
      const table = this.db.table<EnrolledAgent>(AGENTS);
      const current = table.get(input.id);
      // Compare and set. A containment decided from a stale read returns null
      // rather than clobbering a revocation another process already applied —
      // the caller re-reads and discovers the agent is already stopped, which
      // is the outcome it wanted anyway.
      if (!current || current.status !== input.expectedStatus) return null;

      const next: EnrolledAgent = {
        ...current,
        status: input.status,
        statusReason: input.reason,
        statusChangedAt: input.at,
        statusChangedBy: input.by,
        updatedAt: input.at,
      };
      table.set(input.id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async touchLastSeen(id: ExternalAgentId, at: string): Promise<void> {
    assertIsoUtc("at", at);
    await this.db.withLock(`external:agent:${id}`, async () => {
      const table = this.db.table<EnrolledAgent>(AGENTS);
      const current = table.get(id);
      // Silent when the agent is gone. This is telemetry on the admission path
      // and must never be the thing that refuses a request.
      if (!current) return;
      table.set(id, structuredClone({ ...current, lastSeenAt: at }));
    });
  }

  async claimSeat(cap: number): Promise<boolean> {
    assertCap(cap);
    return this.db.withLock("external:seat", async () => {
      const table = this.db.table<number>(SEATS);
      const claimed = table.get(SEAT_ROW) ?? 0;
      // Read and increment inside the lock. Counting and then inserting is the
      // race the port exists to close: two enrolments both see `claimed < cap`
      // and the licence term stops being enforceable.
      if (claimed >= cap) return false;
      table.set(SEAT_ROW, claimed + 1);
      return true;
    });
  }

  async releaseSeat(): Promise<void> {
    await this.db.withLock("external:seat", async () => {
      const table = this.db.table<number>(SEATS);
      // Floored at zero. A release without a matching claim is an operator
      // error, and letting the counter go negative would hand out free seats.
      table.set(SEAT_ROW, Math.max((table.get(SEAT_ROW) ?? 0) - 1, 0));
    });
  }
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

export class MemorySpendStore implements SpendStore {
  constructor(private readonly db: MemoryDb) {}

  async addSpend(
    agentId: ExternalAgentId,
    periodKey: string,
    amountUsd: number,
    at: string,
  ): Promise<number> {
    assertPeriodKey(periodKey);
    assertSpendAmount(amountUsd);
    assertIsoUtc("at", at);

    return this.db.withLock(`external:spend:${meterKey(agentId, periodKey)}`, async () => {
      const table = this.db.table<SpendMeter>(METERS);
      const key = meterKey(agentId, periodKey);
      const current = table.get(key);
      // Read, add, write, all inside the lock. A read-modify-write across the
      // lock loses concurrent reports, and every lost report is spend that
      // happened and does not count against the ceiling.
      const spentUsd = (current?.spentUsd ?? 0) + amountUsd;
      const next: SpendMeter = { agentId, periodKey, spentUsd, updatedAt: at };
      table.set(key, structuredClone(next));
      return spentUsd;
    });
  }

  async getMeter(agentId: ExternalAgentId, periodKey: string): Promise<SpendMeter | null> {
    assertPeriodKey(periodKey);
    const found = this.db.table<SpendMeter>(METERS).get(meterKey(agentId, periodKey));
    return found ? structuredClone(found) : null;
  }

  async listMeters(agentId: ExternalAgentId): Promise<readonly SpendMeter[]> {
    return this.db
      .rows<SpendMeter>(METERS)
      .filter((meter) => meter.agentId === agentId)
      .sort((left, right) => (left.periodKey < right.periodKey ? -1 : 1))
      .map((meter) => structuredClone(meter));
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export class MemoryCredentialStore implements CredentialStore {
  constructor(private readonly db: MemoryDb) {}

  async createCredential(credential: AgentCredential): Promise<AgentCredential> {
    assertCredential(credential);

    return this.db.withLock("external:credential:registry", async () => {
      // The Postgres adapter has a foreign key here. The check is repeated
      // rather than skipped because a credential whose agent was never
      // enrolled would authenticate a principal the registry has never heard
      // of, and admission is built entirely on the registry.
      if (!this.db.table<EnrolledAgent>(AGENTS).has(credential.agentId)) {
        throw new InvalidInputError(
          `Cannot mint a credential for ${credential.agentId}: no such external agent is enrolled. A credential without an enrolment authenticates a principal nothing governs.`,
          "agentId",
        );
      }

      const table = this.db.table<AgentCredential>(CREDENTIALS);
      if (table.has(credential.id)) {
        throw new InvalidInputError(`Credential ${credential.id} already exists.`, "id");
      }
      if (credential.tokenHash !== undefined) {
        for (const existing of table.values()) {
          // Two agents sharing a token hash would mean one token
          // authenticating as either of them, and the lookup would have to
          // pick one.
          if (existing.tokenHash === credential.tokenHash) {
            throw new InvalidInputError(
              `That bearer token is already registered to credential ${existing.id}. One token cannot authenticate as two principals.`,
              "tokenHash",
            );
          }
        }
      }
      table.set(credential.id, structuredClone(credential));
      return structuredClone(credential);
    });
  }

  async getCredential(id: Id<"credential">): Promise<AgentCredential | null> {
    const found = this.db.table<AgentCredential>(CREDENTIALS).get(id);
    return found ? structuredClone(found) : null;
  }

  async listCredentials(agentId: ExternalAgentId): Promise<readonly AgentCredential[]> {
    return this.db
      .rows<AgentCredential>(CREDENTIALS)
      .filter((credential) => credential.agentId === agentId)
      .map((credential) => structuredClone(credential));
  }

  async findByTokenHash(tokenHash: string): Promise<AgentCredential | null> {
    assertTokenHash(tokenHash);
    // Revoked and expired credentials are returned rather than hidden. The
    // verifier has to be able to say "that credential was revoked" instead of
    // "no such credential": the first is an answer, the second invites a
    // caller to conclude it presented the wrong token and keep trying.
    for (const credential of this.db.rows<AgentCredential>(CREDENTIALS)) {
      if (credential.tokenHash === tokenHash) return structuredClone(credential);
    }
    return null;
  }

  async revokeCredential(
    id: Id<"credential">,
    at: string,
    by: string,
    reason: string,
  ): Promise<AgentCredential | null> {
    assertIsoUtc("at", at);

    return this.db.withLock(`external:credential:${id}`, async () => {
      const table = this.db.table<AgentCredential>(CREDENTIALS);
      const current = table.get(id);
      // Conditional on being unrevoked. The first revocation wins, so a second
      // one cannot rewrite who stopped this credential or why — which is
      // exactly the field an incident review reads.
      if (!current || current.revokedAt !== undefined) return null;

      const next: AgentCredential = {
        ...current,
        revokedAt: at,
        revokedBy: by,
        revokedReason: reason,
      };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async touchCredentialUsed(id: Id<"credential">, at: string): Promise<void> {
    assertIsoUtc("at", at);
    await this.db.withLock(`external:credential:${id}`, async () => {
      const table = this.db.table<AgentCredential>(CREDENTIALS);
      const current = table.get(id);
      if (!current) return;
      table.set(id, structuredClone({ ...current, lastUsedAt: at }));
    });
  }

  async hasStrongCredential(agentId: ExternalAgentId, now: string): Promise<boolean> {
    assertIsoUtc("now", now);
    return this.db.rows<AgentCredential>(CREDENTIALS).some(
      (credential) =>
        credential.agentId === agentId &&
        isStrongCredentialKind(credential.kind) &&
        credential.revokedAt === undefined &&
        // Strictly after: a credential is still usable at the instant it
        // expires, matching every other expiry comparison in the platform.
        (credential.expiresAt === undefined || credential.expiresAt > now),
    );
  }
}

// ---------------------------------------------------------------------------
// Nonces
// ---------------------------------------------------------------------------

export class MemoryNonceStore implements NonceStore {
  constructor(
    private readonly db: MemoryDb,
    private readonly capPerAgent: number = DEFAULT_NONCE_CAP_PER_AGENT,
  ) {
    assertCap(capPerAgent);
  }

  async claimNonce(
    agentId: ExternalAgentId,
    nonce: string,
    expiresAt: string,
  ): Promise<boolean> {
    assertNonce(nonce);
    assertIsoUtc("expiresAt", expiresAt);

    // Per agent, so two agents' claims never contend and never evict each
    // other. A global lock here would be a global bound in disguise.
    return this.db.withLock(`external:nonce:${agentId}`, async () => {
      const table = this.db.table<NonceRow>(NONCES);
      const key = nonceKey(agentId, nonce);
      if (table.has(key)) return false;
      table.set(key, { agentId, nonce, expiresAt });

      // Trim this agent's own oldest claims, and nobody else's. Map iteration
      // is insertion order and a claim is never re-inserted, so the order here
      // is claim order — the same thing the Postgres adapter's ordinal
      // measures.
      //
      // The residual risk is stated plainly: an agent that burns through its
      // own bound can replay its own oldest nonces. That is a self-inflicted
      // window confined to one tenant, which is the whole reason the bound is
      // per agent rather than global.
      const own: string[] = [];
      for (const [rowKey, row] of table) {
        if (row.agentId === agentId) own.push(rowKey);
      }
      for (let index = 0; index < own.length - this.capPerAgent; index += 1) {
        const evicted = own[index];
        if (evicted !== undefined) table.delete(evicted);
      }
      return true;
    });
  }

  async purgeExpiredNonces(now: string): Promise<number> {
    assertIsoUtc("now", now);
    return this.db.withLock("external:nonce:purge", async () => {
      const table = this.db.table<NonceRow>(NONCES);
      let purged = 0;
      for (const [key, row] of [...table]) {
        // Strictly past expiry: a claim is still held at the instant it
        // expires. Holding a nonce a moment longer refuses a replay; dropping
        // it a moment early permits one.
        if (!(row.expiresAt < now)) continue;
        table.delete(key);
        purged += 1;
      }
      return purged;
    });
  }

  async countNonces(agentId: ExternalAgentId): Promise<number> {
    return this.db.rows<NonceRow>(NONCES).filter((row) => row.agentId === agentId).length;
  }
}

// ---------------------------------------------------------------------------
// Used-approval ledger
// ---------------------------------------------------------------------------

/**
 * One lock name for the ledger and its floor.
 *
 * `evictBefore` deletes entries and raises the floor, and `claimApproval`
 * reads both. Splitting them would open a window in which an approval has been
 * dropped from the table but the floor that covers it is not yet visible —
 * which is the exact instant a spent approval becomes reusable.
 */
const LEDGER_LOCK = "external:approval-ledger";

export class MemoryUsedApprovalLedger implements UsedApprovalLedger {
  constructor(private readonly db: MemoryDb) {}

  async claimApproval(approvalId: Id<"approval">, at: string): Promise<boolean> {
    assertIsoUtc("at", at);

    return this.db.withLock(LEDGER_LOCK, async () => {
      if (this.belowFloor(approvalId)) return false;
      const table = this.db.table<UsedApprovalRow>(USED_APPROVALS);
      if (table.has(approvalId)) return false;
      table.set(approvalId, { approvalId, consumedAt: at });
      return true;
    });
  }

  async isConsumed(approvalId: Id<"approval">): Promise<boolean> {
    return (
      this.db.table<UsedApprovalRow>(USED_APPROVALS).has(approvalId) || this.belowFloor(approvalId)
    );
  }

  async evictBefore(cutoff: string): Promise<string | null> {
    assertIsoUtc("cutoff", cutoff);

    return this.db.withLock(LEDGER_LOCK, async () => {
      const table = this.db.table<UsedApprovalRow>(USED_APPROVALS);
      const floors = this.db.table<FloorRow>(APPROVAL_FLOOR);
      let highest = floors.get(FLOOR_ROW)?.floorApprovalId ?? null;

      for (const [key, row] of [...table]) {
        if (!(row.consumedAt < cutoff)) continue;
        table.delete(key);
        // Byte comparison, matching the `COLLATE "C"` the Postgres adapter's
        // columns are declared with. If the two adapters disagreed about which
        // id is higher they would disagree about which approvals are refused.
        if (highest === null || row.approvalId > highest) highest = row.approvalId;
      }

      // The floor only ever rises. A cutoff that evicts nothing leaves the
      // existing floor in place rather than lowering it, because the ids it
      // covers are gone for good.
      if (highest === null) return null;
      floors.set(FLOOR_ROW, { floorApprovalId: highest, evictedBefore: cutoff });
      return highest;
    });
  }

  /**
   * True when this id is at or below the highest id ever evicted.
   *
   * Deliberately over-refusing. Identifiers are not ordered by time, so this
   * also refuses ids below the floor that were never consumed. Refusing an
   * approval that was never used costs a re-request; permitting one that was
   * already spent replays a human decision.
   */
  private belowFloor(approvalId: string): boolean {
    const floor = this.db.table<FloorRow>(APPROVAL_FLOOR).get(FLOOR_ROW);
    return floor !== undefined && approvalId <= floor.floorApprovalId;
  }
}

// ---------------------------------------------------------------------------
// Parked actions
// ---------------------------------------------------------------------------

/**
 * One lock name for every parked-action write.
 *
 * The expiry sweep and a commit can reach the same row, so a per-id lock would
 * not exclude them. The fake is not optimising for throughput; it is
 * reproducing a guarantee.
 */
const PARKED_LOCK = "external:parked";

export class MemoryParkedActionStore implements ParkedActionStore {
  constructor(private readonly db: MemoryDb) {}

  async createParkedAction(action: ParkedAction): Promise<ParkedAction> {
    assertParkedAction(action);

    return this.db.withLock(PARKED_LOCK, async () => {
      const table = this.db.table<ParkedAction>(PARKED);
      if (table.has(action.id)) {
        throw new InvalidInputError(
          `Parked action ${action.id} already exists. Reusing the id would let a spent approval be presented against a different request.`,
          "id",
        );
      }
      table.set(action.id, structuredClone(action));
      return structuredClone(action);
    });
  }

  async getParkedAction(id: Id<"parkedAction">): Promise<ParkedAction | null> {
    const found = this.db.table<ParkedAction>(PARKED).get(id);
    return found ? structuredClone(found) : null;
  }

  async listParkedActions(
    filter: {
      readonly agentId?: ExternalAgentId;
      readonly status?: readonly ParkedActionStatus[];
      readonly limit?: number;
    } = {},
  ): Promise<readonly ParkedAction[]> {
    const rows = this.db.rows<ParkedAction>(PARKED);
    const ordinals = new Map(rows.map((action, index) => [action.id, index]));
    const matched = rows.filter((action) => {
      if (filter.agentId !== undefined && action.agentId !== filter.agentId) return false;
      if (filter.status && !filter.status.includes(action.status)) return false;
      return true;
    });

    // Oldest first. This is a human work queue and a newest-first listing with
    // a limit would starve whatever has been waiting longest.
    matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
      return (ordinals.get(left.id) ?? 0) - (ordinals.get(right.id) ?? 0);
    });

    const limited = filter.limit === undefined ? matched : matched.slice(0, filter.limit);
    return limited.map((action) => structuredClone(action));
  }

  async transitionParkedAction(input: {
    readonly id: Id<"parkedAction">;
    readonly expectedStatus: ParkedActionStatus;
    readonly status: ParkedActionStatus;
    readonly at: string;
    readonly resultDigest?: string;
    readonly resultSummary?: string;
    readonly voidReason?: string;
  }): Promise<ParkedAction | null> {
    assertIsoUtc("at", input.at);
    assertOptionalDigestForm("resultDigest", input.resultDigest);

    return this.db.withLock(PARKED_LOCK, async () => {
      const table = this.db.table<ParkedAction>(PARKED);
      const current = table.get(input.id);
      // Compare and set. The null is how a duplicate commit is detected: the
      // second caller finds the action no longer in the status it decided
      // from, and reads back the first caller's result instead of overwriting
      // it with its own.
      if (!current || current.status !== input.expectedStatus) return null;

      const next: ParkedAction = {
        ...current,
        status: input.status,
        // Only a commit carries a completion time. Setting it on a rejection
        // would make the console read as though the action had landed.
        ...(input.status === "committed" ? { committedAt: input.at } : {}),
        ...(input.resultDigest !== undefined ? { resultDigest: input.resultDigest } : {}),
        ...(input.resultSummary !== undefined ? { resultSummary: input.resultSummary } : {}),
        ...(input.voidReason !== undefined ? { voidReason: input.voidReason } : {}),
      };
      table.set(input.id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async expireParkedActions(now: string): Promise<readonly ParkedAction[]> {
    assertIsoUtc("now", now);

    return this.db.withLock(PARKED_LOCK, async () => {
      const table = this.db.table<ParkedAction>(PARKED);
      const expired: ParkedAction[] = [];
      for (const [id, action] of table) {
        // Terminal statuses are history and are never touched. `approved` is
        // swept alongside `pending` because an approver agreed to an action
        // now, not whenever the agent next gets round to it.
        if (!isExpirableParkedStatus(action.status)) continue;
        // Strictly past expiry, matching every other expiry check here.
        if (!(action.expiresAt < now)) continue;
        const next: ParkedAction = { ...action, status: "expired" };
        table.set(id, structuredClone(next));
        expired.push(structuredClone(next));
      }
      expired.sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id < right.id
            ? -1
            : 1
          : left.createdAt < right.createdAt
            ? -1
            : 1,
      );
      return expired;
    });
  }
}

// ---------------------------------------------------------------------------
// Live runs and report ingestion
// ---------------------------------------------------------------------------

export class MemoryExternalRunStore implements ExternalRunStore {
  constructor(private readonly db: MemoryDb) {}

  async createExternalRun(run: ExternalRun): Promise<ExternalRun> {
    assertExternalRun(run);

    return this.db.withLock("external:run:registry", async () => {
      const table = this.db.table<ExternalRun>(RUNS);
      if (table.has(run.id)) {
        throw new InvalidInputError(`External run ${run.id} already exists.`, "id");
      }
      for (const existing of table.values()) {
        // One external run per operating-record run, so cost and step queries
        // cannot silently aggregate two episodes of work into one.
        if (existing.runId === run.runId) {
          throw new InvalidInputError(
            `Run ${run.runId} already accounts for external run ${existing.id}. One operating-record run holds one episode of external work.`,
            "runId",
          );
        }
      }
      table.set(run.id, structuredClone(run));
      return structuredClone(run);
    });
  }

  async getExternalRun(id: Id<"externalRun">): Promise<ExternalRun | null> {
    const found = this.db.table<ExternalRun>(RUNS).get(id);
    return found ? structuredClone(found) : null;
  }

  async listExternalRuns(
    filter: {
      readonly agentId?: ExternalAgentId;
      readonly status?: readonly ExternalRunStatus[];
      readonly limit?: number;
    } = {},
  ): Promise<readonly ExternalRun[]> {
    const rows = this.db.rows<ExternalRun>(RUNS);
    const ordinals = new Map(rows.map((run, index) => [run.id, index]));
    const matched = rows.filter((run) => {
      if (filter.agentId !== undefined && run.agentId !== filter.agentId) return false;
      if (filter.status && !filter.status.includes(run.status)) return false;
      return true;
    });

    // Newest first: this is a live view of what is running right now.
    matched.sort((left, right) => {
      if (left.startedAt !== right.startedAt) return left.startedAt < right.startedAt ? 1 : -1;
      return (ordinals.get(right.id) ?? 0) - (ordinals.get(left.id) ?? 0);
    });

    const limited = filter.limit === undefined ? matched : matched.slice(0, filter.limit);
    return limited.map((run) => structuredClone(run));
  }

  async heartbeat(id: Id<"externalRun">, at: string): Promise<ExternalRun | null> {
    assertIsoUtc("at", at);

    return this.db.withLock(`external:run:${id}`, async () => {
      const table = this.db.table<ExternalRun>(RUNS);
      const current = table.get(id);
      // Conditional on still running. A heartbeat must not resurrect a run
      // that containment stopped or that the sweep reclaimed: the null is what
      // makes the caller reply "stop", which is the only kill switch there is
      // for an agent that runs somewhere else.
      if (!current || current.status !== "running") return null;

      const next: ExternalRun = { ...current, lastHeartbeatAt: at };
      table.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async finishExternalRun(input: {
    readonly id: Id<"externalRun">;
    readonly status: ExternalRunStatus;
    readonly at: string;
    readonly outcome?: string;
    readonly costUsd?: number;
  }): Promise<ExternalRun | null> {
    assertIsoUtc("at", input.at);
    if (input.costUsd !== undefined) assertSpendAmount(input.costUsd);

    return this.db.withLock(`external:run:${input.id}`, async () => {
      const table = this.db.table<ExternalRun>(RUNS);
      const current = table.get(input.id);
      // Only a running run can end, and it ends once. How a run finished is
      // the answer to "what did this agent do"; a second writer moving it to
      // another outcome would rewrite that rather than report it.
      if (!current || current.status !== "running") return null;

      const next: ExternalRun = {
        ...current,
        status: input.status,
        endedAt: input.at,
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      };
      table.set(input.id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async findStaleRuns(cutoff: string, limit: number): Promise<readonly ExternalRun[]> {
    assertIsoUtc("cutoff", cutoff);
    return this.db
      .rows<ExternalRun>(RUNS)
      .filter((run) => run.status === "running" && run.lastHeartbeatAt < cutoff)
      // Oldest silence first, so the sweep reclaims the runs that have been
      // gone longest rather than an arbitrary slice of them.
      .sort((left, right) => (left.lastHeartbeatAt < right.lastHeartbeatAt ? -1 : 1))
      .slice(0, limit)
      .map((run) => structuredClone(run));
  }

  async claimReport(
    agentId: ExternalAgentId,
    idempotencyKey: string,
    runId: Id<"run">,
    at: string,
  ): Promise<{ readonly claimed: boolean; readonly existingRunId: Id<"run"> }> {
    assertIdempotencyKey(idempotencyKey);
    assertIsoUtc("at", at);

    return this.db.withLock(`external:report:${agentId}`, async () => {
      const table = this.db.table<ReportClaimRow>(REPORT_CLAIMS);
      const key = reportKey(agentId, idempotencyKey);
      const existing = table.get(key);
      // The claim is the whole of exactly-once ingestion. A retried report —
      // and agents retry, that is what a report endpoint is for — gets the
      // original run id back instead of a second run and a second charge
      // against the ceiling.
      if (existing) return { claimed: false, existingRunId: existing.runId };
      table.set(key, { agentId, idempotencyKey, runId, claimedAt: at });
      return { claimed: true, existingRunId: runId };
    });
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export class MemoryRateLimitStore implements RateLimitStore {
  constructor(private readonly db: MemoryDb) {}

  async recordRequest(
    agentId: ExternalAgentId,
    operation: string,
    at: string,
    windowMs: number,
  ): Promise<number> {
    assertIsoUtc("at", at);
    assertWindow(windowMs);
    const from = windowStart(at, windowMs);

    return this.db.withLock(`external:rate:request:${agentId}:${operation}`, async () => {
      const table = this.db.table<RateRow>(RATE_REQUESTS);
      table.set(counterKey(this.db, RATE_REQUESTS, `${agentId}|${operation}`), {
        agentId,
        operation,
        at,
      });

      // Prune this key's fallen-out rows in the same critical section, so the
      // table stays bounded by the window rather than by uptime. Rows for
      // other agents and other operations are left alone: this is a per-key
      // counter and one busy agent must not shorten anyone else's window.
      let count = 0;
      for (const [key, row] of [...table]) {
        if (row.agentId !== agentId || row.operation !== operation) continue;
        if (row.at > from) count += 1;
        else table.delete(key);
      }
      return count;
    });
  }

  async recordDenial(
    agentId: ExternalAgentId,
    at: string,
    windowMs: number,
    denialClass: DenialClass,
  ): Promise<number> {
    assertIsoUtc("at", at);
    assertWindow(windowMs);
    const from = windowStart(at, windowMs);

    return this.db.withLock(`external:rate:denial:${agentId}`, async () => {
      const table = this.db.table<RateRow>(RATE_DENIALS);
      // Infrastructure denials are recorded so an operator can see them, and
      // counted by nobody. Containing an agent because our own store blinked
      // punishes a well-behaved team for our outage and teaches them the
      // platform is unreliable rather than strict.
      table.set(counterKey(this.db, RATE_DENIALS, agentId), {
        agentId,
        operation: "",
        denialClass,
        at,
      });

      let count = 0;
      for (const [key, row] of [...table]) {
        if (row.agentId !== agentId) continue;
        if (!(row.at > from)) {
          table.delete(key);
          continue;
        }
        if (row.denialClass === "misbehaviour") count += 1;
      }
      return count;
    });
  }

  async clearDenials(agentId: ExternalAgentId): Promise<void> {
    await this.db.withLock(`external:rate:denial:${agentId}`, async () => {
      const table = this.db.table<RateRow>(RATE_DENIALS);
      for (const [key, row] of [...table]) {
        if (row.agentId === agentId) table.delete(key);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Composite keys are length-prefixed on their first part.
 *
 * A plain `a:b` join is ambiguous when either part may contain the separator,
 * and a nonce is a string the *agent* chooses. An agent that could forge a key
 * belonging to another agent could make that agent's next request look like a
 * replay.
 */
function compositeKey(first: string, second: string): string {
  return `${first.length}:${first}:${second}`;
}

function meterKey(agentId: string, periodKey: string): string {
  return compositeKey(agentId, periodKey);
}

function nonceKey(agentId: string, nonce: string): string {
  return compositeKey(agentId, nonce);
}

function reportKey(agentId: string, idempotencyKey: string): string {
  return compositeKey(agentId, idempotencyKey);
}

/** The start of a sliding window, exclusive. Never a wall-clock reading. */
function windowStart(at: string, windowMs: number): string {
  return new Date(Date.parse(at) - windowMs).toISOString();
}

function unknownAgent(id: string): DeniedError {
  return new DeniedError(
    "record.unavailable",
    `External agent ${id} is not enrolled. An unenrolled caller is refused: there is no anonymous access to this plane and no default-allow.`,
    { agentId: id },
  );
}

function assertCap(cap: number): void {
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0) {
    throw new InvalidInputError(
      `A cap must be a non-negative integer, received: ${String(cap)}`,
      "cap",
    );
  }
}

function assertWindow(windowMs: number): void {
  if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new InvalidInputError(
      `A rate-limit window must be a positive number of milliseconds, received: ${String(windowMs)}. A window of zero counts nothing, which reads to the caller as an agent making no requests at all.`,
      "windowMs",
    );
  }
}

function assertNonce(nonce: string): void {
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new InvalidInputError(
      "A nonce must be a non-empty string. A blank nonce collides with every other blank one, so the first blank claim would lock out every later request from that agent.",
      "nonce",
    );
  }
}

function assertIdempotencyKey(key: string): void {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new InvalidInputError(
      "A report needs a non-empty idempotency key. A blank key matches every other blank key, so the second unrelated report would be discarded as a duplicate of the first and the work would vanish from the record.",
      "idempotencyKey",
    );
  }
}

function assertRiskCeiling(tier: EnrolledAgent["riskCeiling"]): void {
  if (tier === "prohibited") {
    throw new InvalidInputError(
      'An external agent cannot be enrolled with a risk ceiling of "prohibited". That tier means never permitted by this platform whatever the configuration says, so an agent holding it as a ceiling would be admitted to do exactly what the tier forbids.',
      "riskCeiling",
    );
  }
  if (!["routine", "sensitive", "high_consequence"].includes(tier)) {
    throw new InvalidInputError(`Unknown risk tier: ${String(tier)}`, "riskCeiling");
  }
}

function assertBudgetPeriod(period: EnrolledAgent["budgetPeriod"]): void {
  if (!BUDGET_PERIODS.includes(period)) {
    throw new InvalidInputError(`Unknown budget period: ${String(period)}`, "budgetPeriod");
  }
}

function assertAgent(agent: EnrolledAgent): void {
  assertIsoUtc("enrolledAt", agent.enrolledAt);
  assertIsoUtc("updatedAt", agent.updatedAt);
  assertIsoUtc("expiresAt", agent.expiresAt);
  assertOptionalIsoUtc("statusChangedAt", agent.statusChangedAt);
  assertOptionalIsoUtc("lastSeenAt", agent.lastSeenAt);
  assertRiskCeiling(agent.riskCeiling);
  assertBudgetPeriod(agent.budgetPeriod);
  assertSpendAmount(agent.spendCeilingUsd);

  if (agent.name.trim().length === 0) {
    throw new InvalidInputError("An external agent needs a name.", "name");
  }
  if (agent.owner.trim().length === 0) {
    throw new InvalidInputError(
      "An external agent needs a named owner. Accountability is the point of enrolment, and a blank owner is an agent nobody answers for.",
      "owner",
    );
  }
  if (!Number.isFinite(agent.wallClockCeilingMs) || agent.wallClockCeilingMs <= 0) {
    throw new InvalidInputError(
      `A wall-clock ceiling must be a positive number of milliseconds, received: ${String(agent.wallClockCeilingMs)}`,
      "wallClockCeilingMs",
    );
  }
}

function assertCredential(credential: AgentCredential): void {
  assertIsoUtc("createdAt", credential.createdAt);
  assertOptionalIsoUtc("expiresAt", credential.expiresAt);
  assertOptionalIsoUtc("revokedAt", credential.revokedAt);
  assertOptionalIsoUtc("lastUsedAt", credential.lastUsedAt);

  if (credential.label.trim().length === 0) {
    throw new InvalidInputError("A credential needs an operator label.", "label");
  }

  // The same per-kind shape the Postgres CHECK enforces. Each kind carries its
  // own material and nothing else: a bearer row that also held a secret
  // reference would give a verifier a second, unexamined way in.
  switch (credential.kind) {
    case "bearer":
      if (credential.tokenHash === undefined) {
        throw new InvalidInputError("A bearer credential stores a token hash.", "tokenHash");
      }
      assertTokenHash(credential.tokenHash);
      refuseExtras(credential, ["secretRef", "publicKey", "jwksPath", "issuer", "audience"]);
      break;
    case "jwt":
      if (
        credential.issuer === undefined ||
        credential.audience === undefined ||
        credential.jwksPath === undefined
      ) {
        throw new InvalidInputError(
          "A JWT credential needs an expected issuer, an audience, and a local JWKS path. Without all three the token is checked against nothing in particular.",
          "issuer",
        );
      }
      refuseExtras(credential, ["tokenHash", "secretRef", "publicKey"]);
      break;
    case "hmac":
      if (credential.secretRef === undefined) {
        throw new InvalidInputError(
          "An HMAC credential stores the name to resolve from the secret manager.",
          "secretRef",
        );
      }
      assertSecretRef(credential.secretRef);
      refuseExtras(credential, ["tokenHash", "publicKey", "jwksPath"]);
      break;
    case "envelope":
      if (credential.publicKey === undefined) {
        throw new InvalidInputError(
          "An envelope credential pins the public key it verifies against.",
          "publicKey",
        );
      }
      refuseExtras(credential, ["tokenHash", "secretRef", "jwksPath"]);
      break;
    default:
      throw new InvalidInputError(
        `Unknown credential kind: ${String(credential.kind)}`,
        "kind",
      );
  }
}

function refuseExtras(credential: AgentCredential, fields: readonly (keyof AgentCredential)[]): void {
  for (const field of fields) {
    if (credential[field] !== undefined) {
      throw new InvalidInputError(
        `A ${credential.kind} credential must not carry ${String(field)}. Material belonging to another kind is a verification path nobody reviewed.`,
        String(field),
      );
    }
  }
}

function assertParkedAction(action: ParkedAction): void {
  assertIsoUtc("createdAt", action.createdAt);
  assertIsoUtc("expiresAt", action.expiresAt);
  assertOptionalIsoUtc("committedAt", action.committedAt);
  assertDigestForm("requestDigest", action.requestDigest);
  assertOptionalDigestForm("resultDigest", action.resultDigest);
}

function assertExternalRun(run: ExternalRun): void {
  assertIsoUtc("startedAt", run.startedAt);
  assertIsoUtc("lastHeartbeatAt", run.lastHeartbeatAt);
  assertOptionalIsoUtc("endedAt", run.endedAt);
  assertSpendAmount(run.costUsd);
}

function page<T>(rows: readonly T[], limit?: number, offset?: number): readonly T[] {
  const from = offset ?? 0;
  // No implicit page size. A silently truncated roster is indistinguishable
  // from a short one, and "the console showed every enrolled agent" is a claim
  // this module has to be able to make.
  const to = limit === undefined ? rows.length : from + limit;
  return rows.slice(from, to);
}
