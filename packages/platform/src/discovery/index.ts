/**
 * Work discovery. **This module ships DISABLED and must stay disabled.**
 *
 * It observes employees. That is the whole of what it does, and it is the most
 * legally sensitive component in this product. It is built rather than deferred
 * because retrofitting privacy into an observation system does not work — the
 * structural exclusions have to be in the type system and the tests from the
 * first commit, and deciding them later under delivery pressure produces a
 * worse answer. It is disabled because the questions below are unanswered.
 *
 * **It must not be enabled until each of these is answered in writing, by
 * people accountable for the answer:**
 *
 *   1. **Employee notice and consent.** What are employees told, in what words,
 *      before any observation happens — and is participation opt-in per person,
 *      or is it imposed? This code assumes opt-in per person and enforces it
 *      (only the observed person can enroll themselves, and only they can
 *      pause, stop, revoke, or erase). That assumption is engineering's
 *      placeholder, not a legal position, and if the answer is different the
 *      code changes rather than the code being read as the decision.
 *
 *   2. **State electronic-monitoring notice law.** Several US states require
 *      advance written notice of electronic monitoring, with different content
 *      requirements, different timing, and different penalties. Which states'
 *      staff would be observed, and what does each of those states require?
 *
 *   3. **European and other non-US staff.** Works-council consultation and GDPR
 *      obligations attach. In several jurisdictions monitoring without
 *      consultation is unlawful *regardless of individual consent*, so the
 *      opt-in design above does not resolve it. Employee monitoring is also a
 *      strong EU AI Act Annex III high-risk candidate — see
 *      `docs/assurance/eu-ai-act-assessment.md`.
 *
 *   4. **Union and collective-agreement constraints.** Which populations are
 *      covered by a collective agreement, and what does it say about
 *      monitoring, about the data's use in performance management, and about
 *      consultation before introduction?
 *
 *   5. **Contact-centre staff already recorded for QA.** Are they treated
 *      differently from corporate staff, and if so how? "They are already
 *      recorded" is an argument that gets made and it is not obviously right:
 *      call recording for quality assurance is a different purpose, a different
 *      notice, and usually a different legal basis from continuous observation
 *      of application use.
 *
 * None of these are engineering decisions and none of them are answered by this
 * code. A privacy incident here would cost far more than the prioritisation it
 * buys. See `docs/adr/0012-work-discovery-default-off.md`.
 *
 * ---
 *
 * What is enforced in code, so that enabling it later is a configuration change
 * and not a rebuild:
 *
 *   - **Structural exclusions.** Screen contents and pixels, window titles,
 *     keystrokes, clipboard, URLs and query strings, document contents, form
 *     values, message and email bodies, and customer records cannot be
 *     represented in `Observation`, have no column in the schema, and are
 *     refused at runtime by `assertObservationInput`. These are not settings.
 *   - **Three independent gates**, each refused separately: the feature enabled
 *     in configuration (default false), a named person and device enrolled with
 *     a positive application allowlist (an empty allowlist observes nothing),
 *     and a collector started deliberately.
 *   - **An immutable blocklist floor** over communication tools and systems of
 *     record. It always beats the allowlist, is checked at enrollment and again
 *     at every observation, and cannot be weakened by enrollment policy.
 *   - **Short retention**, days not months, with a thirty-day ceiling fixed in
 *     code, in the enrollment path, and in a database constraint. Candidates
 *     are computed on demand and never accumulated into a second store.
 *   - **No egress.** Observations stay inside the deployment's data boundary.
 *     This module does not import `models/`, and both `architecture.test.ts`
 *     and this module's own tests assert that it cannot.
 *   - **The observed person is in control.** Pause, stop, revoke, and erase are
 *     available to them at any time with no administrator involved, and there
 *     is no administrator path to anybody else's enrollment. Erasure is
 *     immediate and complete.
 *   - **Proposals are inert.** Discovery may produce a draft workflow and a
 *     draft role. It may never execute, save, schedule, or activate either.
 *     They are returned as frozen plain data marked `draft`, and no method
 *     exists that promotes them.
 */

export type {
  ApplicationKey,
  CandidateOpportunity,
  CollectorSession,
  DiscoveryGate,
  DraftEvidence,
  DraftRole,
  DraftWorkflow,
  DraftWorkflowStep,
  Enrollment,
  EnrollmentState,
  ErasureResult,
  NewObservation,
  Observation,
  ObservationInput,
  PromotionNote,
  SessionEndReason,
} from "./types.js";

export {
  DISCOVERY_GATES,
  ENROLLMENT_STATES,
  OBSERVATION_INPUT_KEYS,
  OBSERVATION_KEYS,
  SESSION_END_REASONS,
} from "./types.js";

export type { BlockedApplicationFamily } from "./exclusions.js";
export {
  APPLICATION_KEY_PATTERN,
  BLOCKED_APPLICATION_FAMILIES,
  FORBIDDEN_OBSERVATION_FIELDS,
  MAX_DWELL_MS,
  REFERENCE_PATTERN,
  assertApplicationKey,
  assertNotBlocked,
  assertObservationInput,
  assertObservationShape,
  assertReference,
  blockedFamilyFor,
  isBlockedApplication,
} from "./exclusions.js";

export type { AppendObservationResult, DiscoveryStore, ObservationFilter } from "./port.js";

export type { DiscoverySettings } from "./retention.js";
export {
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  assertRetentionWithinCeiling,
  discoverySettings,
  effectiveRetentionDays,
  retentionCutoff,
} from "./retention.js";

export type { EnrollRequest, SubjectSummary } from "./enrollment.js";
export { EnrollmentService } from "./enrollment.js";

export { DiscoveryCollector, MAX_CLOCK_SKEW_MS } from "./collect.js";

export type { MineOptions } from "./mine.js";
export { compareObservations, draftRole, draftWorkflow, mineCandidates } from "./mine.js";

export {
  MemoryDiscoveryStore,
  createMemoryDiscoveryStore,
  observationNaturalKey,
} from "./store.memory.js";
export { PgDiscoveryStore } from "./store.pg.js";

export { MIGRATIONS as DISCOVERY_MIGRATIONS } from "./migrations.js";
