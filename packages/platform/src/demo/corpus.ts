/**
 * Seed corpus for the demonstration.
 *
 * ============================================================================
 * EVERY DOCUMENT BELOW IS SYNTHETIC. NONE IS A REAL STATUTE, A REAL MVW
 * GOVERNING DOCUMENT, OR A REAL POLICY.
 * ============================================================================
 *
 * They exist so the demonstration can show the knowledge layer doing its
 * actual job — provenance, effective dating, citations a reviewer can click
 * through to, and refusing when nothing adequate is found — without shipping
 * text that would be wrong to rely on.
 *
 * Two reasons the content is invented rather than copied. First, a real
 * statute pasted here would be quoted by someone eventually, and a stale copy
 * of a legal text is worse than no copy. Second, the demonstration must be
 * byte-for-byte reproducible, which means its inputs have to be fixed in
 * source control rather than fetched.
 *
 * The `TITLE_PREFIX` marker appears on every document so that a corpus
 * containing demonstration material is obvious in the console, and so a test
 * can assert that no demonstration document has leaked into a corpus intended
 * for real authority.
 */

export const SYNTHETIC_MARKER = "[SYNTHETIC — DEMONSTRATION ONLY]";

export interface SeedDocument {
  readonly corpusKey: string;
  readonly title: string;
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly jurisdiction?: string;
  readonly sourceUri: string;
  readonly body: string;
}

export interface SeedCorpus {
  readonly key: string;
  /** Stable machine name, as the knowledge layer requires. */
  readonly name: string;
  /** Human-readable label, for the demonstration output only. */
  readonly label: string;
  readonly owner: string;
  readonly reviewCadenceDays: number;
  readonly classification: "public" | "internal" | "confidential";
  /** Data scopes a reader must hold, matching the `scope:` role convention. */
  readonly accessScope: readonly string[];
  readonly purpose: string;
}

export const SEED_CORPORA: readonly SeedCorpus[] = [
  {
    key: "state-rescission",
    name: "state_rescission_rules",
    label: "State rescission rules",
    owner: "compliance",
    // Statutes change, and a stale rescission rule is a contract-voiding
    // defect rather than a stale FAQ. Ninety days is deliberately short.
    reviewCadenceDays: 90,
    classification: "public",
    accessScope: [],
    purpose:
      "Cancellation-window authority by state. Stale authority here is a correctness risk, not an inconvenience.",
  },
  {
    key: "association-governing",
    name: "association_governing_documents",
    label: "Association governing documents",
    owner: "association_management",
    reviewCadenceDays: 365,
    classification: "internal",
    accessScope: ["association"],
    purpose:
      "Declarations, bylaws, budget policy, and reserve-study methodology for managed associations.",
  },
  {
    key: "contact-policy",
    name: "owner_contact_policy",
    label: "Owner contact and consent policy",
    owner: "compliance",
    reviewCadenceDays: 180,
    classification: "internal",
    accessScope: ["compliance"],
    purpose:
      "Consent capture, revocation handling, quiet hours, and frequency caps for owner contact.",
  },
  {
    key: "owner-services-sop",
    name: "owner_services_procedures",
    label: "Owner services procedures",
    owner: "owner_services",
    reviewCadenceDays: 180,
    classification: "internal",
    accessScope: ["owner_services"],
    purpose: "Standard operating procedures for the owner-services contact surface.",
  },
];

/**
 * A superseded and a current version of the same Florida rule.
 *
 * This pair is the point of the whole seed set. It lets the demonstration
 * prove effective dating: a contract executed in 2024 must be evaluated
 * against the rule that was in force in 2024, not the rule in force today. A
 * system that cannot do that cannot answer "was this contract compliant when
 * it was signed", which is the only question that matters after the fact.
 */
export const SEED_DOCUMENTS: readonly SeedDocument[] = [
  {
    corpusKey: "state-rescission",
    title: `${SYNTHETIC_MARKER} Florida cancellation window — superseded version`,
    version: "2019.1",
    effectiveFrom: "2019-01-01",
    effectiveTo: "2025-06-30",
    jurisdiction: "US-FL",
    sourceUri: "synthetic://demonstration/state-rescission/us-fl/2019.1",
    body: [
      "SYNTHETIC DEMONSTRATION TEXT. This is not law and must not be relied on.",
      "",
      "Florida cancellation window (superseded 30 June 2025).",
      "",
      "A purchaser of a timeshare interest may cancel the contract until midnight",
      "of the tenth calendar day following the later of (a) the date the purchaser",
      "signed the contract, or (b) the date on which the purchaser received the",
      "last of the required disclosure documents.",
      "",
      "The window is counted in calendar days. The day of the triggering event is",
      "not counted. Where the final day falls on a Saturday, Sunday, or legal",
      "holiday observed in the state, the window extends to the end of the next",
      "day that is not a Saturday, Sunday, or such a holiday.",
      "",
      "Notice of cancellation is effective when deposited with the postal service,",
      "properly addressed and postage prepaid, or when delivered by any other",
      "method for which the purchaser can demonstrate the date of delivery.",
      "",
      "The seller must refund all payments within a period specified by rule,",
      "measured from receipt of the notice of cancellation.",
    ].join("\n"),
  },
  {
    corpusKey: "state-rescission",
    title: `${SYNTHETIC_MARKER} Florida cancellation window — current version`,
    version: "2025.1",
    effectiveFrom: "2025-07-01",
    jurisdiction: "US-FL",
    sourceUri: "synthetic://demonstration/state-rescission/us-fl/2025.1",
    body: [
      "SYNTHETIC DEMONSTRATION TEXT. This is not law and must not be relied on.",
      "",
      "Florida cancellation window (effective 1 July 2025).",
      "",
      "A purchaser of a timeshare interest may cancel the contract until midnight",
      "of the tenth calendar day following the later of (a) the date the purchaser",
      "signed the contract, or (b) the date on which the purchaser received the",
      "last of the required disclosure documents, including any public offering",
      "statement required to be delivered.",
      "",
      "The window is counted in calendar days and the day of the triggering event",
      "is not counted. Where the final day falls on a Saturday, Sunday, or legal",
      "holiday observed in the state, the window extends to the end of the next",
      "day that is not a Saturday, Sunday, or such a holiday.",
      "",
      "Where the purchaser demonstrates that a required disclosure document was",
      "not delivered, the cancellation window is tolled and does not begin until",
      "delivery is complete.",
      "",
      "The contract must state the cancellation right conspicuously, and the",
      "seller bears the burden of proving the date on which the disclosure",
      "documents were delivered.",
    ].join("\n"),
  },
  {
    corpusKey: "state-rescission",
    title: `${SYNTHETIC_MARKER} South Carolina cancellation window`,
    version: "2023.1",
    effectiveFrom: "2023-01-01",
    jurisdiction: "US-SC",
    sourceUri: "synthetic://demonstration/state-rescission/us-sc/2023.1",
    body: [
      "SYNTHETIC DEMONSTRATION TEXT. This is not law and must not be relied on.",
      "",
      "South Carolina cancellation window.",
      "",
      "A purchaser may cancel a timeshare contract until midnight of the fifth",
      "business day following the date the purchaser signed the contract.",
      "",
      "The window is counted in business days. Saturdays, Sundays, and legal",
      "holidays observed in the state are excluded from the count rather than",
      "extending the final day.",
      "",
      "Delivery of the disclosure documents does not restart the window, but a",
      "failure to deliver them is a separate violation.",
    ].join("\n"),
  },
  {
    corpusKey: "state-rescission",
    title: `${SYNTHETIC_MARKER} Nevada cancellation window`,
    version: "2022.1",
    effectiveFrom: "2022-01-01",
    jurisdiction: "US-NV",
    sourceUri: "synthetic://demonstration/state-rescission/us-nv/2022.1",
    body: [
      "SYNTHETIC DEMONSTRATION TEXT. This is not law and must not be relied on.",
      "",
      "Nevada cancellation window.",
      "",
      "A purchaser may cancel a timeshare contract until midnight of the fifth",
      "calendar day following the date the purchaser signed the contract, counted",
      "in the Pacific time zone.",
      "",
      "Where the final day falls on a weekend or a legal holiday observed in the",
      "state, the window extends to the end of the next day that is neither.",
    ].join("\n"),
  },
  {
    corpusKey: "association-governing",
    title: `${SYNTHETIC_MARKER} Association budget and reserve policy`,
    version: "2026.1",
    effectiveFrom: "2026-01-01",
    sourceUri: "synthetic://demonstration/association-governing/budget-policy/2026.1",
    body: [
      "SYNTHETIC DEMONSTRATION TEXT. This is not a real governing document.",
      "",
      "Association budget and reserve policy.",
      "",
      "The board shall adopt an annual operating budget before the start of each",
      "fiscal year. The budget shall separately identify operating expenditure,",
      "reserve contributions, and any assessment for extraordinary items.",
      "",
      "A reserve study shall be commissioned at intervals not exceeding three",
      "years and updated annually without a site visit in the intervening years.",
      "The study shall state the current funding percentage and the contribution",
      "required to reach the funding objective adopted by the board.",
      "",
      "Maintenance fees are billed annually. Where an owner's account is more than",
      "ninety days past due, the association may pursue the remedies described in",
      "the declaration, subject to any notice requirement imposed by the state in",
      "which the association is organised.",
      "",
      "The board pack for each meeting shall include the operating statement",
      "against budget, the reserve balance and funding percentage, delinquency by",
      "ageing band, and a narrative explaining any variance in excess of the",
      "threshold adopted by the board.",
    ].join("\n"),
  },
  {
    corpusKey: "contact-policy",
    title: `${SYNTHETIC_MARKER} Owner contact and consent policy`,
    version: "2026.2",
    effectiveFrom: "2026-04-01",
    sourceUri: "synthetic://demonstration/contact-policy/2026.2",
    body: [
      "SYNTHETIC DEMONSTRATION TEXT. This is not a real policy.",
      "",
      "Owner contact and consent policy.",
      "",
      "Consent is recorded per channel and per purpose. Consent to service",
      "communication does not imply consent to marketing communication, and",
      "consent captured for one channel does not extend to another.",
      "",
      "Every consent record carries its provenance: how it was obtained, by whom,",
      "on what date, and a reference to the evidence.",
      "",
      "A revocation takes effect immediately on receipt and applies to every",
      "channel and purpose it names. Where a revocation and a later consent record",
      "conflict, the revocation governs until a new consent is captured with its",
      "own provenance.",
      "",
      "Contact is not permitted outside the quiet-hour window applicable in the",
      "owner's own time zone, which is determined from the owner's address of",
      "record rather than from the time zone of the system initiating contact.",
      "",
      "Frequency caps apply over a rolling window and are counted per owner across",
      "all channels rather than per channel.",
      "",
      "Evidence of each check is retained with the message record so that the",
      "basis for contacting an owner can be reconstructed after the fact.",
    ].join("\n"),
  },
  {
    corpusKey: "owner-services-sop",
    title: `${SYNTHETIC_MARKER} Rescission enquiry handling procedure`,
    version: "2026.1",
    effectiveFrom: "2026-02-01",
    sourceUri: "synthetic://demonstration/owner-services-sop/rescission-enquiry/2026.1",
    body: [
      "SYNTHETIC DEMONSTRATION TEXT. This is not a real procedure.",
      "",
      "Rescission enquiry handling procedure.",
      "",
      "When an owner asks about cancelling a recently executed contract, confirm",
      "the contract reference and the state in which the contract was executed",
      "before discussing any deadline.",
      "",
      "Do not state a cancellation deadline from memory or from a general table.",
      "Obtain the computed deadline for that specific contract, which accounts for",
      "the rule in force on the date of execution, the delivery date of the",
      "disclosure documents, business-day counting where it applies, and any",
      "weekend or holiday extension.",
      "",
      "Where the computed deadline cannot be established — the state is not",
      "covered, a required date is missing, or the authority is out of date —",
      "escalate to compliance. Do not estimate.",
      "",
      "Record the enquiry, the deadline communicated, and the basis on which it",
      "was computed.",
    ].join("\n"),
  },
];

/**
 * Contracts the demonstration reasons about.
 *
 * Chosen to exercise a specific behaviour each, rather than to look like a
 * plausible sample. The interesting cases are the last three.
 */
export interface SeedContract {
  readonly contractId: string;
  readonly state: string;
  /** Instant the purchaser signed. */
  readonly executedAt: string;
  /** Instant the last required disclosure document was delivered, if it was. */
  readonly disclosureDeliveredAt?: string;
  readonly financed: boolean;
  readonly documentSetComplete: boolean;
  /** What this case is here to demonstrate. Shown in the demo narrative. */
  readonly demonstrates: string;
}

export const SEED_CONTRACTS: readonly SeedContract[] = [
  {
    contractId: "ctr_fl_0001",
    state: "FL",
    executedAt: "2026-07-28T18:30:00.000Z",
    disclosureDeliveredAt: "2026-07-28T18:30:00.000Z",
    financed: true,
    documentSetComplete: true,
    demonstrates: "The ordinary case: a clean contract with a computable deadline.",
  },
  {
    contractId: "ctr_sc_0002",
    state: "SC",
    executedAt: "2026-07-30T15:00:00.000Z",
    disclosureDeliveredAt: "2026-07-30T15:00:00.000Z",
    financed: true,
    documentSetComplete: true,
    demonstrates:
      "Business-day counting rather than calendar days, so the window spans a weekend.",
  },
  {
    contractId: "ctr_fl_0003",
    state: "FL",
    executedAt: "2026-07-31T22:45:00.000Z",
    disclosureDeliveredAt: "2026-08-03T14:00:00.000Z",
    financed: false,
    documentSetComplete: true,
    demonstrates:
      "The clock starts on the later of execution and disclosure delivery, not on execution.",
  },
  {
    contractId: "ctr_fl_0004",
    state: "FL",
    executedAt: "2024-03-15T17:00:00.000Z",
    disclosureDeliveredAt: "2024-03-15T17:00:00.000Z",
    financed: true,
    documentSetComplete: true,
    demonstrates:
      "Effective dating: a 2024 contract is evaluated against the rule in force in 2024, not today's rule.",
  },
  {
    contractId: "ctr_fl_0005",
    state: "FL",
    executedAt: "2026-08-04T16:00:00.000Z",
    financed: true,
    documentSetComplete: false,
    demonstrates:
      "A missing disclosure-delivery date. The platform refuses to compute a deadline and routes to a human rather than guessing.",
  },
  {
    contractId: "ctr_xx_0006",
    state: "XX",
    executedAt: "2026-08-04T16:00:00.000Z",
    disclosureDeliveredAt: "2026-08-04T16:00:00.000Z",
    financed: true,
    documentSetComplete: true,
    demonstrates:
      "An unrecognised state. There is no default window; the platform refuses rather than inventing one.",
  },
];
