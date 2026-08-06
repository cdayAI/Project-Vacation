import { DeniedError, InvalidInputError, InvariantError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc } from "../record/migrations.js";
import { storeUnavailable, type Db } from "../store/db.js";
import { assertSuppressionNotWeakened } from "./consent.js";
import type {
  ConsentEventFilter,
  ContactStore,
  DoNotCallQuery,
  OutboundMessageFilter,
  RecordMessageResult,
} from "./port.js";
import {
  assertConsentEventWritable,
  assertMessageWritable,
  assertSuppressionWritable,
  sameConsentContent,
} from "./store.memory.js";
import { ALL_CHANNELS, ALL_PURPOSES } from "./types.js";
import type {
  ConsentChannelScope,
  ConsentEvent,
  ConsentProvenance,
  ConsentPurposeScope,
  ContactChannel,
  ContactEvidence,
  ContactPurpose,
  ContactRiskBand,
  DoNotCallEntry,
  DoNotCallList,
  MessageCountQuery,
  OutboundMessage,
  OutboundStatus,
  RecipientRelationship,
} from "./types.js";

/**
 * Postgres outbound contact.
 *
 * Three operations carry the concurrency requirements the port describes, and
 * each is implemented with the database doing the work rather than the
 * application checking first:
 *
 *   - `recordOutboundMessage` inserts a cleared message with `ON CONFLICT
 *     DO NOTHING` against the partial unique index on `idempotency_key`. Two
 *     processes clearing the same send produce one row and one loser, which is
 *     told it lost. A read-then-insert would leave a window in which both read
 *     "nothing here" and both wrote — and the resulting duplicate is a second
 *     letter to an owner, separately actionable under the TCPA.
 *
 *   - `putDoNotCallEntry` takes a row lock on the existing entry before
 *     comparing, because "suppression only widens" is a rule about two writers
 *     as much as about one. Whichever arrives second must see the first.
 *
 *   - `attachConsentReceipt` is a conditional UPDATE that only fires when
 *     `receipt_id IS NULL`. The append-only trigger permits exactly that
 *     transition and refuses every other write to the ledger, so this is the
 *     one statement in the module that can modify a consent row at all.
 *
 * `listConsentEvents` deliberately returns wildcard-scoped events alongside the
 * specific ones. A blanket revocation is the event most likely to be filtered
 * away by a well-meaning `WHERE channel = $2`, and it is the one event that
 * must never be missed.
 */

type ConsentRow = {
  id: string;
  subject_ref: string;
  channel: string;
  purpose: string;
  kind: string;
  effective_at: string;
  recorded_at: string;
  provenance: ConsentProvenance;
  receipt_id: string | null;
};

type DoNotCallRow = {
  list: string;
  subject_ref: string;
  destination_digest: string;
  channels: string[];
  jurisdiction: string;
  registered_at: string;
  expires_at: string | null;
  source: string;
  recorded_at: string;
};

type MessageRow = {
  id: string;
  run_id: string | null;
  correlation_id: string | null;
  subject_ref: string;
  channel: string;
  purpose: string;
  relationship: string;
  destination_digest: string;
  content_digest: string;
  jurisdiction: string;
  recipient_time_zone: string;
  template_id: string | null;
  template_version: number | null;
  model_id: string | null;
  risk_band: string;
  status: string;
  evidence: ContactEvidence;
  evidence_digest: string;
  requested_by: string;
  requested_at: string;
  idempotency_key: string;
  approval_id: string | null;
  denial_reason: string | null;
  receipt_id: string | null;
};

const CONSENT_COLUMNS = `id, subject_ref, channel, purpose, kind, effective_at, recorded_at,
  provenance, receipt_id`;

const DNC_COLUMNS = `list, subject_ref, destination_digest, channels, jurisdiction,
  registered_at, expires_at, source, recorded_at`;

const MESSAGE_COLUMNS = `id, run_id, correlation_id, subject_ref, channel, purpose, relationship,
  destination_digest, content_digest, jurisdiction, recipient_time_zone, template_id,
  template_version, model_id, risk_band, status, evidence, evidence_digest, requested_by,
  requested_at, idempotency_key, approval_id, denial_reason, receipt_id`;

export class PgContactStore implements ContactStore {
  constructor(private readonly db: Db) {}

  async appendConsentEvent(event: ConsentEvent): Promise<ConsentEvent> {
    assertConsentEventWritable(event);

    return this.guard("appendConsentEvent", async () => {
      const inserted = (
        await this.db.query<ConsentRow>(
          `INSERT INTO contact_consent_event (${CONSENT_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)
           ON CONFLICT (id) DO NOTHING
           RETURNING ${CONSENT_COLUMNS}`,
          [
            event.id,
            event.subjectRef,
            event.channel,
            event.purpose,
            event.kind,
            event.effectiveAt,
            event.recordedAt,
            event.provenance,
          ],
        )
      )[0];
      if (inserted) return toConsentEvent(inserted);

      // The id was taken. A retry of the identical append is a retry; the same
      // id carrying different content is a collision, and letting it through
      // would rewrite history under an id someone has already cited.
      const existing = (
        await this.db.query<ConsentRow>(
          `SELECT ${CONSENT_COLUMNS} FROM contact_consent_event WHERE id = $1`,
          [event.id],
        )
      )[0];
      if (!existing) {
        throw new InvariantError(
          `Consent event ${event.id} neither inserted nor found; the ledger is in an impossible state.`,
        );
      }
      const found = toConsentEvent(existing);
      if (sameConsentContent(found, event)) return found;
      throw new InvalidInputError(
        `Consent event ${event.id} already exists with different content. The ledger is append-only; a correction is a new superseding event.`,
        "id",
      );
    });
  }

  async listConsentEvents(filter: ConsentEventFilter): Promise<readonly ConsentEvent[]> {
    const values: unknown[] = [filter.subjectRef];
    const clauses = ["subject_ref = $1"];

    if (filter.channel !== undefined) {
      values.push(filter.channel, ALL_CHANNELS);
      clauses.push(`(channel = $${values.length - 1} OR channel = $${values.length})`);
    }
    if (filter.purpose !== undefined) {
      values.push(filter.purpose, ALL_PURPOSES);
      clauses.push(`(purpose = $${values.length - 1} OR purpose = $${values.length})`);
    }
    if (filter.recordedBefore !== undefined) {
      values.push(filter.recordedBefore);
      clauses.push(`recorded_at <= $${values.length}`);
    }

    let sql = `SELECT ${CONSENT_COLUMNS} FROM contact_consent_event
       WHERE ${clauses.join(" AND ")}
       ORDER BY effective_at ASC, recorded_at ASC, id ASC`;
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      sql += ` LIMIT $${values.length}`;
    }

    const rows = await this.guard("listConsentEvents", () =>
      this.db.query<ConsentRow>(sql, values),
    );
    return rows.map(toConsentEvent);
  }

  async getConsentEvent(id: Id<"consent">): Promise<ConsentEvent | null> {
    const rows = await this.guard("getConsentEvent", () =>
      this.db.query<ConsentRow>(
        `SELECT ${CONSENT_COLUMNS} FROM contact_consent_event WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toConsentEvent(row) : null;
  }

  async attachConsentReceipt(
    id: Id<"consent">,
    receiptId: Id<"auditEntry">,
  ): Promise<ConsentEvent> {
    if (typeof receiptId !== "string" || receiptId.length === 0) {
      throw new InvalidInputError(
        "Attaching a receipt needs the id of the audit entry that recorded the event.",
        "receiptId",
      );
    }
    return this.guard("attachConsentReceipt", async () => {
      // Conditional so the attachment happens once. This is the only statement
      // in the module the append-only trigger lets through.
      const updated = (
        await this.db.query<ConsentRow>(
          `UPDATE contact_consent_event SET receipt_id = $2
           WHERE id = $1 AND receipt_id IS NULL
           RETURNING ${CONSENT_COLUMNS}`,
          [id, receiptId],
        )
      )[0];
      if (updated) return toConsentEvent(updated);

      const current = (
        await this.db.query<ConsentRow>(
          `SELECT ${CONSENT_COLUMNS} FROM contact_consent_event WHERE id = $1`,
          [id],
        )
      )[0];
      if (!current) {
        throw new DeniedError("record.unavailable", `Consent event ${id} is not in the ledger.`, {
          consentId: id,
        });
      }
      // Already receipted: the entry that won stands.
      return toConsentEvent(current);
    });
  }

  async putDoNotCallEntry(entry: DoNotCallEntry): Promise<DoNotCallEntry> {
    assertSuppressionWritable(entry);

    return this.guard("putDoNotCallEntry", () =>
      this.db.transaction(async (tx) => {
        const existing = (
          await tx.query<DoNotCallRow>(
            `SELECT ${DNC_COLUMNS} FROM contact_do_not_call
             WHERE list = $1 AND subject_ref = $2 AND destination_digest = $3
             FOR UPDATE`,
            [entry.list, entry.subjectRef, entry.destinationDigest],
          )
        )[0];

        // "Widens, never narrows" is a rule about two writers as much as one,
        // so the comparison happens under the row lock.
        assertSuppressionNotWeakened(existing ? toDoNotCall(existing) : undefined, entry);

        const written = (
          await tx.query<DoNotCallRow>(
            `INSERT INTO contact_do_not_call (${DNC_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (list, subject_ref, destination_digest) DO UPDATE SET
               channels = EXCLUDED.channels,
               jurisdiction = EXCLUDED.jurisdiction,
               registered_at = EXCLUDED.registered_at,
               expires_at = EXCLUDED.expires_at,
               source = EXCLUDED.source,
               recorded_at = EXCLUDED.recorded_at
             RETURNING ${DNC_COLUMNS}`,
            [
              entry.list,
              entry.subjectRef,
              entry.destinationDigest,
              JSON.stringify([...entry.channels]),
              entry.jurisdiction,
              entry.registeredAt,
              entry.expiresAt,
              entry.source,
              entry.recordedAt,
            ],
          )
        )[0];
        if (!written) throw new InvariantError("Do-not-call entry was not written.");
        return toDoNotCall(written);
      }),
    );
  }

  async findDoNotCall(query: DoNotCallQuery): Promise<readonly DoNotCallEntry[]> {
    assertIsoUtc("asOf", query.asOf);
    const rows = await this.guard("findDoNotCall", () =>
      this.db.query<DoNotCallRow>(
        `SELECT ${DNC_COLUMNS} FROM contact_do_not_call
         WHERE ((subject_ref <> '' AND subject_ref = $1)
             OR (destination_digest <> '' AND destination_digest = $2))
           AND registered_at <= $3
           AND (expires_at IS NULL OR expires_at > $3)
           -- An empty channel list means every channel: someone who says stop
           -- has not enumerated the ways they meant.
           AND (jsonb_array_length(channels) = 0 OR channels ? $4)
         ORDER BY CASE list WHEN 'internal' THEN 0 WHEN 'state' THEN 1 ELSE 2 END,
                  registered_at ASC`,
        [query.subjectRef, query.destinationDigest, query.asOf, query.channel],
      ),
    );
    return rows.map(toDoNotCall);
  }

  async listDoNotCall(subjectRef: string): Promise<readonly DoNotCallEntry[]> {
    const rows = await this.guard("listDoNotCall", () =>
      this.db.query<DoNotCallRow>(
        `SELECT ${DNC_COLUMNS} FROM contact_do_not_call WHERE subject_ref = $1
         ORDER BY list ASC, registered_at ASC`,
        [subjectRef],
      ),
    );
    return rows.map(toDoNotCall);
  }

  async recordOutboundMessage(message: OutboundMessage): Promise<RecordMessageResult> {
    assertMessageWritable(message);

    return this.guard("recordOutboundMessage", async () => {
      const params = [
        message.id,
        message.runId ?? null,
        message.correlationId ?? null,
        message.subjectRef,
        message.channel,
        message.purpose,
        message.relationship,
        message.destinationDigest,
        message.contentDigest,
        message.jurisdiction,
        message.recipientTimeZone,
        message.templateId ?? null,
        message.templateVersion ?? null,
        message.modelId ?? null,
        message.riskBand,
        message.status,
        message.evidence,
        message.evidenceDigest,
        message.requestedBy,
        message.requestedAt,
        message.idempotencyKey,
        message.approvalId ?? null,
        message.denialReason ?? null,
        message.receiptId ?? null,
      ];

      // The partial unique index covers cleared rows only, so a blocked attempt
      // never conflicts: several refusals under one key are legitimate and each
      // is evidence that the gate fired.
      const inserted = (
        await this.db.query<MessageRow>(
          `INSERT INTO contact_outbound_message (${MESSAGE_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
           ON CONFLICT (idempotency_key) WHERE status = 'cleared' DO NOTHING
           RETURNING ${MESSAGE_COLUMNS}`,
          params,
        )
      )[0];
      if (inserted) return { message: toMessage(inserted), created: true };

      const existing = (
        await this.db.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM contact_outbound_message
           WHERE idempotency_key = $1 AND status = 'cleared'`,
          [message.idempotencyKey],
        )
      )[0];
      if (!existing) {
        throw new InvariantError(
          `Message ${message.id} was neither inserted nor found under idempotency key ${message.idempotencyKey}.`,
        );
      }
      // Another process cleared this send first. Theirs is the message; one
      // owner, one letter.
      return { message: toMessage(existing), created: false };
    });
  }

  async attachMessageReceipt(
    id: Id<"message">,
    receiptId: Id<"auditEntry">,
  ): Promise<OutboundMessage> {
    return this.guard("attachMessageReceipt", async () => {
      const updated = (
        await this.db.query<MessageRow>(
          `UPDATE contact_outbound_message SET receipt_id = $2
           WHERE id = $1 AND receipt_id IS NULL
           RETURNING ${MESSAGE_COLUMNS}`,
          [id, receiptId],
        )
      )[0];
      if (updated) return toMessage(updated);

      const current = (
        await this.db.query<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM contact_outbound_message WHERE id = $1`,
          [id],
        )
      )[0];
      if (!current) {
        throw new DeniedError("record.unavailable", `Message ${id} is not in the outbound record.`, {
          messageId: id,
        });
      }
      return toMessage(current);
    });
  }

  async getOutboundMessage(id: Id<"message">): Promise<OutboundMessage | null> {
    const rows = await this.guard("getOutboundMessage", () =>
      this.db.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM contact_outbound_message WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toMessage(row) : null;
  }

  async findOutboundMessageByKey(idempotencyKey: string): Promise<OutboundMessage | null> {
    const rows = await this.guard("findOutboundMessageByKey", () =>
      this.db.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM contact_outbound_message
         WHERE idempotency_key = $1 AND status = 'cleared'`,
        [idempotencyKey],
      ),
    );
    const row = rows[0];
    return row ? toMessage(row) : null;
  }

  async listOutboundMessages(
    filter: OutboundMessageFilter = {},
  ): Promise<readonly OutboundMessage[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    const add = (clause: (placeholder: string) => string, value: unknown): void => {
      values.push(value);
      clauses.push(clause(`$${values.length}`));
    };
    if (filter.subjectRef !== undefined) add((p) => `subject_ref = ${p}`, filter.subjectRef);
    if (filter.runId !== undefined) add((p) => `run_id = ${p}`, filter.runId);
    if (filter.channel !== undefined) add((p) => `channel = ${p}`, filter.channel);
    if (filter.status !== undefined) add((p) => `status = ${p}`, filter.status);

    let sql = `SELECT ${MESSAGE_COLUMNS} FROM contact_outbound_message
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY ordinal ASC`;
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      sql += ` LIMIT $${values.length}`;
    }

    const rows = await this.guard("listOutboundMessages", () =>
      this.db.query<MessageRow>(sql, values),
    );
    return rows.map(toMessage);
  }

  async countMessagesSince(query: MessageCountQuery): Promise<number> {
    assertIsoUtc("since", query.since);
    const rows = await this.guard("countMessagesSince", () =>
      this.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM contact_outbound_message
         WHERE subject_ref = $1
           AND channel = $2
           -- Cleared only. Counting a refusal would make the cap tighten itself
           -- every time it fired.
           AND status = 'cleared'
           AND ($3::text IS NULL OR purpose = $3::text)
           AND requested_at >= $4`,
        [
          query.subjectRef,
          query.channel,
          query.purpose === ALL_PURPOSES ? null : query.purpose,
          query.since,
        ],
      ),
    );
    const row = rows[0];
    return row ? Number(row.count) : 0;
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof DeniedError ||
        error instanceof InvalidInputError ||
        error instanceof InvariantError
      ) {
        throw error;
      }
      throw storeUnavailable(operation, error);
    }
  }
}

function toConsentEvent(row: ConsentRow): ConsentEvent {
  return {
    id: row.id as Id<"consent">,
    subjectRef: row.subject_ref,
    channel: row.channel as ConsentChannelScope,
    purpose: row.purpose as ConsentPurposeScope,
    kind: row.kind === "revoked" ? "revoked" : "granted",
    effectiveAt: row.effective_at,
    recordedAt: row.recorded_at,
    provenance: row.provenance,
    receiptId: row.receipt_id === null ? undefined : (row.receipt_id as Id<"auditEntry">),
  };
}

function toDoNotCall(row: DoNotCallRow): DoNotCallEntry {
  return {
    list: row.list as DoNotCallList,
    subjectRef: row.subject_ref,
    destinationDigest: row.destination_digest,
    channels: Object.freeze([...row.channels] as ContactChannel[]),
    jurisdiction: row.jurisdiction,
    registeredAt: row.registered_at,
    // NULL means "does not expire" and stays null throughout: an absent field
    // would read as "no expiry recorded", which is a different claim.
    expiresAt: row.expires_at,
    source: row.source,
    recordedAt: row.recorded_at,
  };
}

function toMessage(row: MessageRow): OutboundMessage {
  return {
    id: row.id as Id<"message">,
    runId: row.run_id === null ? undefined : (row.run_id as Id<"run">),
    correlationId: row.correlation_id ?? undefined,
    subjectRef: row.subject_ref,
    channel: row.channel as ContactChannel,
    purpose: row.purpose as ContactPurpose,
    relationship: row.relationship as RecipientRelationship,
    destinationDigest: row.destination_digest,
    contentDigest: row.content_digest as Digest,
    jurisdiction: row.jurisdiction,
    recipientTimeZone: row.recipient_time_zone,
    templateId: row.template_id === null ? undefined : (row.template_id as Id<"template">),
    templateVersion: row.template_version === null ? undefined : Number(row.template_version),
    modelId: row.model_id ?? undefined,
    riskBand: row.risk_band as ContactRiskBand,
    status: row.status as OutboundStatus,
    evidence: row.evidence,
    evidenceDigest: row.evidence_digest as Digest,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    idempotencyKey: row.idempotency_key,
    approvalId: row.approval_id === null ? undefined : (row.approval_id as Id<"approval">),
    denialReason: row.denial_reason ?? undefined,
    receiptId: row.receipt_id === null ? undefined : (row.receipt_id as Id<"auditEntry">),
  };
}
