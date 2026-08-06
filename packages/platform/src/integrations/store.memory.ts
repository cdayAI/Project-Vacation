import { InvalidInputError } from "../kernel/errors.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import type { MemoryDb } from "../store/db.js";
import type { CredentialRevocationStore, IntegrationQueueStore } from "./port.js";
import type { CredentialRevocation, ParkedItem, QueuedCall } from "./types.js";

/**
 * In-memory degradation queue and revocation list.
 *
 * `claimDue` takes the lock, because the property it provides is a property
 * about racing callers: two schedulers must not both pick up the same queued
 * call, or work queued once is performed twice. The Postgres adapter uses
 * `FOR UPDATE SKIP LOCKED` for the same reason, and the contract tests run
 * concurrent claimers against both.
 *
 * Everything is cloned on the way in and on the way out, so a caller holding a
 * reference to a queued call cannot rewrite its attempt count.
 */

const QUEUE = "integration_queued_call";
const PARKED = "integration_parked_item";
const REVOCATIONS = "integration_credential_revocation";

export class MemoryIntegrationQueueStore implements IntegrationQueueStore {
  constructor(private readonly db: MemoryDb) {}

  async enqueue(item: QueuedCall): Promise<QueuedCall> {
    assertQueuedCall(item);
    return this.db.withLock(`integration:queue:${item.idempotencyKey}`, async () => {
      // Upsert on the natural key. One logical call is one entry, however many
      // times it has failed; a second row would be a second effect.
      this.db.table<QueuedCall>(QUEUE).set(item.idempotencyKey, structuredClone(item));
      return structuredClone(item);
    });
  }

  async getQueued(idempotencyKey: string): Promise<QueuedCall | null> {
    const found = this.db.table<QueuedCall>(QUEUE).get(idempotencyKey);
    return found ? structuredClone(found) : null;
  }

  async claimDue(now: string, limit: number): Promise<readonly QueuedCall[]> {
    assertIsoUtc("now", now);
    return this.db.withLock("integration:queue:claim", async () => {
      const table = this.db.table<QueuedCall>(QUEUE);
      const due = [...table.values()]
        .filter((item) => item.status === "queued" && item.nextAttemptAt <= now)
        // Oldest first: this is a work queue, and newest-first with a limit
        // starves whatever has been waiting longest.
        .sort((left, right) =>
          left.nextAttemptAt === right.nextAttemptAt
            ? left.idempotencyKey < right.idempotencyKey
              ? -1
              : 1
            : left.nextAttemptAt < right.nextAttemptAt
              ? -1
              : 1,
        )
        .slice(0, Math.max(0, limit));

      const claimed: QueuedCall[] = [];
      for (const item of due) {
        const next: QueuedCall = { ...item, status: "claimed", claimedAt: now };
        table.set(item.idempotencyKey, structuredClone(next));
        claimed.push(structuredClone(next));
      }
      return claimed;
    });
  }

  async completeQueued(idempotencyKey: string, at: string): Promise<QueuedCall | null> {
    assertIsoUtc("at", at);
    return this.db.withLock(`integration:queue:${idempotencyKey}`, async () => {
      const table = this.db.table<QueuedCall>(QUEUE);
      const current = table.get(idempotencyKey);
      if (!current || current.status === "completed") return null;
      const next: QueuedCall = { ...current, status: "completed", completedAt: at };
      table.set(idempotencyKey, structuredClone(next));
      return structuredClone(next);
    });
  }

  async releaseQueued(
    idempotencyKey: string,
    at: string,
    error: string,
    nextAttemptAt: string | null,
  ): Promise<QueuedCall | null> {
    assertIsoUtc("at", at);
    assertOptionalIsoUtc("nextAttemptAt", nextAttemptAt);
    return this.db.withLock(`integration:queue:${idempotencyKey}`, async () => {
      const table = this.db.table<QueuedCall>(QUEUE);
      const current = table.get(idempotencyKey);
      if (!current) return null;
      const next: QueuedCall = {
        ...current,
        // A null next attempt abandons it. Abandoned entries stay in the
        // table: work that stopped being attempted with nobody told is the
        // same failure as a silent wrong answer, with fewer traces.
        status: nextAttemptAt === null ? "abandoned" : "queued",
        lastAttemptAt: at,
        nextAttemptAt: nextAttemptAt ?? current.nextAttemptAt,
        lastError: error,
        claimedAt: undefined,
      };
      table.set(idempotencyKey, structuredClone(next));
      return structuredClone(next);
    });
  }

  async listQueued(
    filter: {
      readonly integration?: string;
      readonly status?: readonly QueuedCall["status"][];
      readonly limit?: number;
    } = {},
  ): Promise<readonly QueuedCall[]> {
    const matched = this.db
      .rows<QueuedCall>(QUEUE)
      .filter((item) => {
        if (filter.integration !== undefined && item.integration !== filter.integration) return false;
        if (filter.status && !filter.status.includes(item.status)) return false;
        return true;
      })
      .sort((left, right) =>
        left.firstFailedAt === right.firstFailedAt
          ? left.idempotencyKey < right.idempotencyKey
            ? -1
            : 1
          : left.firstFailedAt < right.firstFailedAt
            ? -1
            : 1,
      );
    const limited = filter.limit === undefined ? matched : matched.slice(0, filter.limit);
    return limited.map((item) => structuredClone(item));
  }

  async park(item: ParkedItem): Promise<ParkedItem> {
    assertIsoUtc("parkedAt", item.parkedAt);
    assertOptionalIsoUtc("resolvedAt", item.resolvedAt);
    if (item.reference.length === 0) {
      throw new InvalidInputError("A parked item needs a reference.", "reference");
    }
    return this.db.withLock(`integration:parked:${item.reference}`, async () => {
      const table = this.db.table<ParkedItem>(PARKED);
      const existing = table.get(item.reference);
      // Parking the same work again refreshes the reason but keeps the
      // original parked time, so the age of the oldest open item stays true.
      const next: ParkedItem = existing
        ? { ...item, parkedAt: existing.parkedAt, resolvedAt: existing.resolvedAt, resolvedBy: existing.resolvedBy, resolution: existing.resolution }
        : item;
      table.set(item.reference, structuredClone(next));
      return structuredClone(next);
    });
  }

  async getParked(reference: string): Promise<ParkedItem | null> {
    const found = this.db.table<ParkedItem>(PARKED).get(reference);
    return found ? structuredClone(found) : null;
  }

  async listParked(
    filter: {
      readonly integration?: string;
      readonly includeResolved?: boolean;
      readonly limit?: number;
    } = {},
  ): Promise<readonly ParkedItem[]> {
    const matched = this.db
      .rows<ParkedItem>(PARKED)
      .filter((item) => {
        if (filter.integration !== undefined && item.integration !== filter.integration) return false;
        if (filter.includeResolved !== true && item.resolvedAt) return false;
        return true;
      })
      .sort((left, right) =>
        left.parkedAt === right.parkedAt
          ? left.reference < right.reference
            ? -1
            : 1
          : left.parkedAt < right.parkedAt
            ? -1
            : 1,
      );
    const limited = filter.limit === undefined ? matched : matched.slice(0, filter.limit);
    return limited.map((item) => structuredClone(item));
  }

  async resolveParked(
    reference: string,
    at: string,
    by: string,
    resolution: string,
  ): Promise<ParkedItem | null> {
    assertIsoUtc("at", at);
    return this.db.withLock(`integration:parked:${reference}`, async () => {
      const table = this.db.table<ParkedItem>(PARKED);
      const current = table.get(reference);
      // Compare and set: two people working the same queue must not both
      // believe they closed it.
      if (!current || current.resolvedAt) return null;
      const next: ParkedItem = { ...current, resolvedAt: at, resolvedBy: by, resolution };
      table.set(reference, structuredClone(next));
      return structuredClone(next);
    });
  }
}

export class MemoryCredentialRevocationStore implements CredentialRevocationStore {
  constructor(private readonly db: MemoryDb) {}

  async revoke(revocation: CredentialRevocation): Promise<CredentialRevocation> {
    assertIsoUtc("revokedAt", revocation.revokedAt);
    return this.db.withLock(`integration:revocation:${revocation.reference}`, async () => {
      const table = this.db.table<CredentialRevocation>(REVOCATIONS);
      // First revocation wins. A second call must not move the time a
      // credential stopped being valid — that timestamp is evidence.
      const existing = table.get(revocation.reference);
      if (existing) return structuredClone(existing);
      table.set(revocation.reference, structuredClone(revocation));
      return structuredClone(revocation);
    });
  }

  async isRevoked(reference: string): Promise<boolean> {
    return this.db.table<CredentialRevocation>(REVOCATIONS).has(reference);
  }

  async listRevocations(): Promise<readonly CredentialRevocation[]> {
    return this.db
      .rows<CredentialRevocation>(REVOCATIONS)
      .slice()
      .sort((left, right) => (left.reference < right.reference ? -1 : 1))
      .map((entry) => structuredClone(entry));
  }
}

function assertQueuedCall(item: QueuedCall): void {
  if (item.idempotencyKey.length === 0) {
    throw new InvalidInputError(
      "A queued call needs an idempotency key. A blank key matches every other blank one, and the scheduler reads a match as 'this is the same call'.",
      "idempotencyKey",
    );
  }
  if (!Number.isInteger(item.attempts) || item.attempts < 1) {
    throw new InvalidInputError("A queued call has been attempted at least once.", "attempts");
  }
  assertIsoUtc("firstFailedAt", item.firstFailedAt);
  assertIsoUtc("lastAttemptAt", item.lastAttemptAt);
  assertIsoUtc("nextAttemptAt", item.nextAttemptAt);
  assertOptionalIsoUtc("claimedAt", item.claimedAt);
  assertOptionalIsoUtc("completedAt", item.completedAt);
}
