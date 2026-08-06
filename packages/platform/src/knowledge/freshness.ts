import type { Authorizer } from "../guard/authorize.js";
import { DAY, type Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc } from "../record/migrations.js";
import type { ActorRef, IsoTimestamp, OperatingMode } from "../record/types.js";
import { RECORD_CORPUS_REVIEW_ACTION } from "./actions.js";
import type { KnowledgeStore } from "./port.js";
import type { Corpus, CorpusFreshness } from "./types.js";

/**
 * Corpus review cadence.
 *
 * Authority decays. A state amends its rescission statute, an HOA amends its
 * covenants, a disclosure template is superseded — and the platform's copy goes
 * on answering confidently from the old text, because nothing about a stale
 * document looks different from a current one. The corpus that has not been
 * reviewed in eighteen months is the one that produces a wrong answer nobody
 * questions.
 *
 * So staleness is a first-class fact rather than a hope. Every corpus declares
 * how often it must be reviewed and when it last was; this module turns those
 * two fields into a status the console can show and the answer path can refuse
 * on. Stale authority is flagged, and for a regulated question it is refused —
 * never silently trusted.
 *
 * "Reviewed" is an attestation by a named steward, not a timestamp the platform
 * updates for itself. Nothing here touches `lastReviewedAt` except
 * {@link FreshnessMonitor.recordReview}, which goes through the authorization
 * chokepoint like any other governed act, because resetting the clock on a
 * corpus is exactly what someone in a hurry would reach for when the platform
 * is refusing to answer.
 */

/**
 * Review status for one corpus at one moment.
 *
 * Pure and clock-free: the caller passes the instant. Two callers judging the
 * same corpus a millisecond apart must not disagree about whether it is stale,
 * and the seeded demo must produce the same listing every run.
 */
export function corpusFreshness(corpus: Corpus, nowIso: IsoTimestamp): CorpusFreshness {
  assertIsoUtc("nowIso", nowIso);
  assertIsoUtc("lastReviewedAt", corpus.lastReviewedAt);
  if (!Number.isInteger(corpus.reviewCadenceDays) || corpus.reviewCadenceDays < 1) {
    throw new InvalidInputError(
      `Corpus ${corpus.id} declares a review cadence of ${String(corpus.reviewCadenceDays)} days. A cadence below one day would leave the corpus permanently overdue and permanently refusing.`,
      "reviewCadenceDays",
    );
  }

  // Parsing two given ISO strings, never reading the wall clock. The instant
  // arrives from the injected clock at the call site so tests and the demo stay
  // deterministic.
  const reviewedAt = Date.parse(corpus.lastReviewedAt);
  const now = Date.parse(nowIso);
  const dueMs = reviewedAt + corpus.reviewCadenceDays * DAY;
  const dueAt = new Date(dueMs).toISOString();

  // Due today counts as due. Erring the other way would give every corpus a
  // free day past its cadence, which is a policy change disguised as a rounding
  // choice.
  const stale = now >= dueMs;
  const daysOverdue = stale ? Math.floor((now - dueMs) / DAY) : 0;

  return {
    corpusId: corpus.id,
    name: corpus.name,
    owner: corpus.owner,
    classification: corpus.classification,
    reviewCadenceDays: corpus.reviewCadenceDays,
    lastReviewedAt: corpus.lastReviewedAt,
    dueAt,
    daysOverdue,
    stale,
  };
}

/** True when the corpus is at or past its next review date. */
export function isStale(corpus: Corpus, nowIso: IsoTimestamp): boolean {
  return corpusFreshness(corpus, nowIso).stale;
}

export interface RecordReviewRequest {
  readonly corpusId: Id<"corpus">;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
  /** Defaults to now. Never earlier than the previous review. */
  readonly reviewedAt?: IsoTimestamp | undefined;
}

export class FreshnessMonitor {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly clock: Clock,
    private readonly authorizer: Authorizer,
  ) {}

  /** Every corpus with its review status, worst overdue first. */
  async list(): Promise<readonly CorpusFreshness[]> {
    const now = this.clock.nowIso();
    return (await this.store.listCorpora())
      .map((corpus) => corpusFreshness(corpus, now))
      .sort((left, right) => {
        if (right.daysOverdue !== left.daysOverdue) return right.daysOverdue - left.daysOverdue;
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
      });
  }

  /** The subset the console shows as needing attention. */
  async listStale(): Promise<readonly CorpusFreshness[]> {
    return (await this.list()).filter((entry) => entry.stale);
  }

  async freshnessOf(corpusId: Id<"corpus">): Promise<CorpusFreshness> {
    const corpus = await this.store.requireCorpus(corpusId);
    return corpusFreshness(corpus, this.clock.nowIso());
  }

  /**
   * Refuse if this corpus is past its review cadence.
   *
   * @throws {DeniedError} `knowledge.stale_authority`.
   */
  async assertFresh(corpusId: Id<"corpus">): Promise<void> {
    const freshness = await this.freshnessOf(corpusId);
    if (freshness.stale) {
      throw new DeniedError(
        "knowledge.stale_authority",
        `Corpus "${freshness.name}" was last reviewed ${freshness.lastReviewedAt} and was due ${freshness.dueAt}, ${freshness.daysOverdue} day(s) ago. Answering a regulated question from unreviewed authority is refused; ${freshness.owner} owns the review.`,
        {
          corpusId: String(freshness.corpusId),
          daysOverdue: freshness.daysOverdue,
          owner: freshness.owner,
        },
      );
    }
  }

  /**
   * Record that a steward has reviewed a corpus.
   *
   * Goes through the authorization chokepoint, which is also where this act
   * gets its audit trail: the granted authorization names the actor, the
   * corpus, and the moment. There is no separate "corpus reviewed" event type,
   * and inventing one here would mean this module writing an event the audit
   * schema does not know about.
   */
  async recordReview(request: RecordReviewRequest): Promise<Corpus> {
    const corpus = await this.store.requireCorpus(request.corpusId);

    await this.authorizer.authorize({
      action: RECORD_CORPUS_REVIEW_ACTION,
      actor: request.actor,
      mode: request.mode,
      runId: request.runId,
      correlationId: request.correlationId,
      subject: { corpusId: corpus.id, corpus: corpus.name },
      requiredScopes: corpus.accessScope,
      secondsSinceAuthentication: request.secondsSinceAuthentication,
    });

    const reviewedAt = request.reviewedAt ?? this.clock.nowIso();
    assertIsoUtc("reviewedAt", reviewedAt);
    return this.store.touchCorpusReview(corpus.id, reviewedAt);
  }
}
