import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type {
  ConsentEvent,
  ContactChannel,
  DoNotCallEntry,
  MessageCountQuery,
  OutboundMessage,
  OutboundStatus,
} from "./types.js";

/**
 * Persistence port for outbound contact.
 *
 * Three requirements here cannot be met by a read followed by a write in the
 * caller, so they are expressed as single operations and implemented as such in
 * both adapters.
 *
 *   - `appendConsentEvent` is append-only. There is no update and no delete on
 *     the ledger, in this interface or in either adapter, and the Postgres
 *     schema enforces it with a trigger. A consent record that can be edited is
 *     not evidence of anything.
 *
 *   - `recordOutboundMessage` is the idempotency point. One idempotency key
 *     yields one message, whichever concurrent caller arrives first; the loser
 *     is told it lost rather than writing a second row. Without that, a retry
 *     after a crash sends the owner the same letter twice, and every duplicate
 *     is separately actionable under the TCPA.
 *
 *   - `countMessagesSince` counts *cleared* messages only. A blocked attempt is
 *     not a contact, and counting it would make the frequency cap tighten
 *     itself every time it fired.
 *
 * A read that cannot be served must raise, never return empty. "No consent
 * event exists" and "the consent ledger is unreachable" lead to opposite
 * actions: the first is a refusal, the second is a refusal *and* an incident.
 * What neither may become is a send.
 */

export interface ConsentEventFilter {
  readonly subjectRef: string;
  /**
   * Restrict to this channel.
   *
   * Implementations must still return events scoped to `all_channels`, because
   * a blanket revocation covers the specific channel being asked about. An
   * adapter that filtered them out would hide exactly the event that matters.
   */
  readonly channel?: ContactChannel | undefined;
  /** As `channel`, and `all_purposes` events are likewise always returned. */
  readonly purpose?: string | undefined;
  /** Only events recorded at or before this instant. */
  readonly recordedBefore?: IsoTimestamp | undefined;
  readonly limit?: number | undefined;
}

export interface DoNotCallQuery {
  readonly subjectRef: string;
  readonly destinationDigest: string;
  readonly channel: ContactChannel;
  /** Entries that had lapsed by this instant are not returned. */
  readonly asOf: IsoTimestamp;
}

export interface OutboundMessageFilter {
  readonly subjectRef?: string | undefined;
  readonly runId?: Id<"run"> | undefined;
  readonly channel?: ContactChannel | undefined;
  readonly status?: OutboundStatus | undefined;
  readonly limit?: number | undefined;
}

/** Whether the write created a row or found one already there. */
export interface RecordMessageResult {
  readonly message: OutboundMessage;
  readonly created: boolean;
}

export interface ContactStore {
  /**
   * Append one consent or revocation event.
   *
   * Idempotent on `id`: re-appending the identical event returns it rather than
   * raising, so a retried write does not turn into a duplicate ledger entry.
   * An event id reused with *different* content is refused — that is a
   * collision, not a retry.
   */
  appendConsentEvent(event: ConsentEvent): Promise<ConsentEvent>;

  /**
   * Every in-scope event, oldest first by `(effectiveAt, recordedAt, id)`.
   *
   * Ordering is part of the contract because the derived state depends on it
   * and the two adapters must derive the same answer from the same ledger.
   */
  listConsentEvents(filter: ConsentEventFilter): Promise<readonly ConsentEvent[]>;

  getConsentEvent(id: Id<"consent">): Promise<ConsentEvent | null>;

  /**
   * Attach the audit receipt to a ledger entry, once.
   *
   * The only field of a consent event that is ever written after the insert,
   * and it is written exactly once — the Postgres trigger permits this single
   * transition and refuses every other update. An event that already carries a
   * receipt is returned unchanged rather than re-pointed, so two callers racing
   * the same append cannot end up with the entry naming an audit entry that
   * describes a different attempt.
   */
  attachConsentReceipt(
    id: Id<"consent">,
    receiptId: Id<"auditEntry">,
  ): Promise<ConsentEvent>;

  /** Add or replace a suppression entry. Keyed by list, subject, destination. */
  putDoNotCallEntry(entry: DoNotCallEntry): Promise<DoNotCallEntry>;

  /** Every unexpired suppression matching the subject or the destination. */
  findDoNotCall(query: DoNotCallQuery): Promise<readonly DoNotCallEntry[]>;

  listDoNotCall(subjectRef: string): Promise<readonly DoNotCallEntry[]>;

  /** Atomically store a send attempt, or return the one already under this key. */
  recordOutboundMessage(message: OutboundMessage): Promise<RecordMessageResult>;

  /** Attach the audit receipt to a stored message. Written once. */
  attachMessageReceipt(
    id: Id<"message">,
    receiptId: Id<"auditEntry">,
  ): Promise<OutboundMessage>;

  getOutboundMessage(id: Id<"message">): Promise<OutboundMessage | null>;

  findOutboundMessageByKey(idempotencyKey: string): Promise<OutboundMessage | null>;

  listOutboundMessages(filter?: OutboundMessageFilter): Promise<readonly OutboundMessage[]>;

  /** Cleared messages in the rolling window. Blocked attempts are not counted. */
  countMessagesSince(query: MessageCountQuery): Promise<number>;
}
