/**
 * Outbound contact: the consent ledger and the single compliance gate.
 *
 * The highest-liability surface in the product, built before any channel
 * existed so that the first channel had to be written against a gate that
 * already worked.
 *
 * Three rules hold across the module:
 *
 *   - **One chokepoint.** Every message, call, and text passes `ContactGate.clear()`.
 *     A channel adapter delivers a clearance this gate issued, or nothing.
 *   - **Consent is an event history with a derived state.** Nothing overwrites
 *     anything, revocation always wins, and a grant that cannot be evidenced is
 *     not usable consent.
 *   - **A check that cannot be answered refuses.** An unreachable ledger, an
 *     unresolvable recipient timezone, a jurisdiction the policy does not
 *     cover: each produces `contact.evidence_unavailable` and no message.
 *
 * The policy values are MVW compliance's, not engineering's. They live in
 * `policy.ts` as a versioned declarative artifact and every value shipped today
 * is an unverified placeholder that says so.
 */

export type {
  ConsentChannelScope,
  ConsentEvent,
  ConsentEventKind,
  ConsentProvenance,
  ConsentPurposeScope,
  ConsentSource,
  ConsentState,
  ConsentStatus,
  ContactChannel,
  ContactCheck,
  ContactCheckName,
  ContactCheckOutcome,
  ContactClearance,
  ContactEvidence,
  ContactPolicy,
  ContactPurpose,
  ContactRiskBand,
  DoNotCallEntry,
  DoNotCallList,
  FrequencyCap,
  MessageCountQuery,
  OutboundMessage,
  OutboundRequest,
  OutboundStatus,
  QuietHoursPolicy,
  RecipientRelationship,
  Revocation,
} from "./types.js";

export {
  ALL_CHANNELS,
  ALL_PURPOSES,
  CONSENT_SOURCES,
  CONTACT_CHANNELS,
  CONTACT_CHECKS,
  CONTACT_PURPOSES,
  DO_NOT_CALL_LISTS,
  RECIPIENT_RELATIONSHIPS,
} from "./types.js";

export type {
  ConsentEventFilter,
  ContactStore,
  DoNotCallQuery,
  OutboundMessageFilter,
  RecordMessageResult,
} from "./port.js";

export {
  CONTACT_ACTIONS,
  RECORD_CONSENT_ACTION,
  RECORD_DO_NOT_CALL_ACTION,
  SEND_HIGH_RISK_MESSAGE_ACTION,
  SEND_MESSAGE_ACTION,
} from "./actions.js";

export {
  CONTACT_POLICY,
  FEDERAL_JURISDICTION,
  assertRecipientTimeZone,
  isElevated,
  isWithinQuietWindow,
  localMinutes,
  resolveFrequencyCaps,
  resolveQuietHours,
  validateContactPolicy,
} from "./policy.js";
export type { PolicyProblem } from "./policy.js";

export {
  ConsentLedger,
  assertSuppressionNotWeakened,
  compareConsentEvents,
  coversConsentQuery,
  deriveConsentState,
  suppressionApplies,
} from "./consent.js";
export type {
  ConsentQuery,
  RecordConsentRequest,
  RecordSuppressionRequest,
} from "./consent.js";

export {
  ContactGate,
  assertOutboundRequest,
  destinationFingerprint,
  proposalDigestFor,
} from "./gate.js";
export type { ContactGateOptions } from "./gate.js";

export {
  MemoryContactStore,
  createMemoryContactStore,
  sameConsentContent,
} from "./store.memory.js";
export { PgContactStore } from "./store.pg.js";

export { MIGRATIONS as CONTACT_MIGRATIONS } from "./migrations.js";
