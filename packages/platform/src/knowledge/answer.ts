import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import { screen, type ScreenResult } from "../guard/screen.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvariantError, type DenialReason } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";
import type { IsoDate } from "../timeline/types.js";
import { corpusFreshness } from "./freshness.js";
import { assertIsoDate } from "./migrations.js";
import type { KnowledgeStore } from "./port.js";
import { citedCorpora, type Retriever } from "./retrieve.js";
import type { Citation, Claim, CorpusFreshness, GroundedAnswer, RetrievedChunk } from "./types.js";

/**
 * No grounding, no answer.
 *
 * This is the rule the whole module exists to enforce. When the corpus does not
 * contain an adequate basis for an answer, the platform says so and hands the
 * question to a person. It does not produce a plausible paragraph. The failure
 * mode being closed off is specific and it is the expensive one in this
 * industry: a confident, fluent, wrong statement about a consumer's
 * cancellation rights, delivered with the authority of the company, which is
 * indistinguishable from a correct one until somebody litigates it.
 *
 * Three gates stand between a question and an answer.
 *
 *   1. **The boundary screen.** The question is untrusted text — it may have
 *      arrived from an owner message or a web form — and a question is a
 *      perfectly good place to hide an instruction. Refused questions are
 *      recorded and routed, not silently dropped.
 *
 *   2. **The relevance floor.** Retrieval always returns *something* ranked
 *      first; that is what ranking does. A floor is what turns "the best of a
 *      bad set" into a refusal. Two conditions must both hold: a normalised
 *      score, and a share of the question's own terms. Score alone is not
 *      enough — a long passage repeating one rare term can out-score a passage
 *      that actually addresses the question — and a reviewer asked to rely on
 *      one matched word out of eight would be right to object.
 *
 *   3. **Staleness.** Authority past its review cadence is refused for
 *      regulated questions. `regulated` defaults to **true**: for a platform
 *      serving vacation-ownership compliance, treating a question as regulated
 *      unless someone explicitly says otherwise is the only default that fails
 *      closed.
 *
 * What comes back on success is an evidence set, not prose. Each claim is a
 * passage, carrying citations with source document, version, effective date,
 * jurisdiction, and chunk id, so a compliance reviewer can click through to the
 * exact text. This module never writes a sentence of its own; a caller that
 * composes a narrative does so under its own governance and may cite only what
 * is in {@link GroundedAnswer.citations}.
 *
 * One thing this file deliberately does not do: call the authorization
 * chokepoint. Answering is a step, and `knowledge.retrieve` is registered in
 * the platform action catalogue for the caller to authorize — the workflow
 * engine does it before the retrieval step, which is also what gives an
 * operator's containment switch reach over answering. Authorizing here as well
 * would double-record every answer and would put this module in the business of
 * deciding what a caller's operating mode is. Entitlement to the corpora
 * themselves is a different question and is enforced here, in `retrieve.ts`,
 * because it depends on which corpus a passage came from.
 */

/** Normalised score a passage must reach before it may be cited. */
export const DEFAULT_RELEVANCE_FLOOR = 0.15;
/** Share of the question's distinct terms a passage must contain. */
export const DEFAULT_COVERAGE_FLOOR = 0.5;
export const DEFAULT_MAX_CITATIONS = 5;

export interface AnswerRequest {
  readonly question: string;
  /** The date the answer must be true as of. Required; there is no default. */
  readonly asOf: IsoDate;
  readonly actor: ActorRef;
  readonly corpusIds?: readonly Id<"corpus">[] | undefined;
  readonly jurisdictions?: readonly string[] | undefined;
  /**
   * Whether this question carries regulatory consequence. Defaults to true.
   *
   * Set it false only for internal, non-consumer-facing questions where a
   * stale-but-relevant passage is better than a refusal — and expect the answer
   * to come back with `staleAuthority` set.
   */
  readonly regulated?: boolean | undefined;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly maxCitations?: number | undefined;
}

/**
 * What a human is handed when the platform refuses.
 *
 * A refusal that goes nowhere is a dropped question. The audit entry proves the
 * platform refused; this is what makes someone responsible for answering.
 */
export interface AnswerReferral {
  /** The screened, redacted question. Never the raw input. */
  readonly question: string;
  readonly asOf: IsoDate;
  readonly reason: DenialReason;
  readonly actor: ActorRef;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  /** Best normalised score seen, so a reviewer knows how close it came. */
  readonly bestScore: number;
  readonly candidatesConsidered: number;
  readonly staleCorpora: readonly Id<"corpus">[];
  readonly explanation: string;
}

export interface GroundedAnswerOptions {
  readonly relevanceFloor?: number;
  readonly coverageFloor?: number;
  readonly maxCitations?: number;
  /**
   * Where refused questions go.
   *
   * Wired by the workflow engine to a human task. Optional here because this
   * module must not depend on the engine, and because a deployment that has not
   * wired it yet should still refuse rather than answer.
   */
  readonly onRefusal?: ((referral: AnswerReferral) => Promise<void> | void) | undefined;
}

export class GroundedAnswerService {
  private readonly relevanceFloor: number;
  private readonly coverageFloor: number;
  private readonly maxCitations: number;
  private readonly onRefusal: GroundedAnswerOptions["onRefusal"];

  constructor(
    private readonly retriever: Retriever,
    private readonly store: KnowledgeStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    options: GroundedAnswerOptions = {},
  ) {
    this.relevanceFloor = options.relevanceFloor ?? DEFAULT_RELEVANCE_FLOOR;
    this.coverageFloor = options.coverageFloor ?? DEFAULT_COVERAGE_FLOOR;
    this.maxCitations = options.maxCitations ?? DEFAULT_MAX_CITATIONS;
    this.onRefusal = options.onRefusal;
  }

  /**
   * Answer a question from cited authority, or refuse.
   *
   * @throws {DeniedError} `knowledge.no_grounding` when nothing clears the
   *   relevance floor, `knowledge.stale_authority` when the authority that
   *   would have been cited is past its review cadence, and whatever the screen
   *   or the retriever refuse with. Every one of them means no answer was
   *   produced and the question has been routed to a human.
   */
  async groundedAnswer(request: AnswerRequest): Promise<GroundedAnswer> {
    assertIsoDate("asOf", request.asOf);
    const regulated = request.regulated ?? true;
    const maxCitations = request.maxCitations ?? this.maxCitations;

    let screened: ScreenResult;
    try {
      screened = screen(request.question);
    } catch (error) {
      const denied =
        error instanceof DeniedError
          ? error
          : new DeniedError(
              "screen.unavailable",
              `The boundary screen failed on this question, so it was refused: ${error instanceof Error ? error.message : String(error)}`,
              {},
            );
      await this.refuse(request, regulated, denied, {
        question: redactedFallback(request.question),
        questionDigest: digestValue({ text: String(request.question ?? "") }),
        bestScore: 0,
        candidatesConsidered: 0,
        staleCorpora: [],
        explanation:
          "The question was refused at the boundary screen and was not put to the corpus.",
      });
      // Unreachable: refuse always throws. Present so the compiler knows.
      throw denied;
    }

    const question = screened.text;

    const retrieval = await this.retriever.retrieve({
      text: question,
      asOf: request.asOf,
      actor: request.actor,
      corpusIds: request.corpusIds,
      jurisdictions: request.jurisdictions,
      // Retrieve wider than we will cite, so the floor is applied to a real
      // ranking rather than to whatever happened to fit in the citation budget.
      limit: Math.max(maxCitations * 2, maxCitations),
    });

    const best = retrieval.results[0];
    const qualifying = retrieval.results
      .filter(
        (result) => result.score >= this.relevanceFloor && result.coverage >= this.coverageFloor,
      )
      .slice(0, maxCitations);

    if (qualifying.length === 0) {
      await this.refuse(
        request,
        regulated,
        new DeniedError(
          "knowledge.no_grounding",
          `Nothing in the corpora in force on ${request.asOf} answers this question well enough to cite (best normalised score ${(best?.score ?? 0).toFixed(3)} against a floor of ${this.relevanceFloor}). The question has been routed to a human rather than answered.`,
          {
            asOf: request.asOf,
            bestScore: Number((best?.score ?? 0).toFixed(4)),
            floor: this.relevanceFloor,
            route: "human_review",
          },
        ),
        {
          question,
          questionDigest: screened.inputDigest,
          bestScore: best?.score ?? 0,
          candidatesConsidered: retrieval.candidatesConsidered,
          staleCorpora: [],
          explanation:
            retrieval.candidatesConsidered === 0
              ? `No authority was in force on ${request.asOf} in the corpora this actor may read.`
              : `${retrieval.candidatesConsidered} passages were in force on ${request.asOf}; none reached the relevance floor.`,
        },
      );
    }

    // Staleness is judged on the corpora that would actually be cited, not on
    // every corpus searched. A stale corpus that contributed nothing to the
    // answer is a console warning, not a reason to refuse this question.
    const now = this.clock.nowIso();
    const staleness = await this.freshnessOfCited(qualifying, now);
    const staleCorpora = staleness.filter((entry) => entry.stale);

    if (staleCorpora.length > 0 && regulated) {
      const worst = staleCorpora.reduce((left, right) =>
        right.daysOverdue > left.daysOverdue ? right : left,
      );
      await this.refuse(
        request,
        regulated,
        new DeniedError(
          "knowledge.stale_authority",
          `The authority this answer would cite is past its review cadence: corpus "${worst.name}" was due for review ${worst.dueAt} and is ${worst.daysOverdue} day(s) overdue. A regulated question is not answered from unreviewed authority; ${worst.owner} owns the review. The question has been routed to a human.`,
          {
            asOf: request.asOf,
            corpusId: String(worst.corpusId),
            daysOverdue: worst.daysOverdue,
            owner: worst.owner,
            route: "human_review",
          },
        ),
        {
          question,
          questionDigest: screened.inputDigest,
          bestScore: best?.score ?? 0,
          candidatesConsidered: retrieval.candidatesConsidered,
          staleCorpora: staleCorpora.map((entry) => entry.corpusId),
          explanation: `Grounding was found, but ${staleCorpora.length} cited corpus/corpora are overdue for review.`,
        },
      );
    }

    const citations = qualifying.map((result) => toCitation(result));
    // One claim per passage. This module retrieves and cites; it does not
    // compose. A caller that wants prose builds it from these and may cite
    // nothing else — which is checkable, because every citation carries the id
    // of the passage it came from.
    const claims: readonly Claim[] = citations.map((citation) => ({
      text: citation.excerpt,
      citations: [citation],
    }));

    const answerDigest = digestAnswer(question, request.asOf, citations);
    const answer: GroundedAnswer = {
      question,
      asOf: request.asOf,
      answeredAt: now,
      claims,
      citations,
      confidence: citations[0]?.score ?? 0,
      staleAuthority: staleCorpora.length > 0,
      staleCorpora: staleCorpora.map((entry) => entry.corpusId),
      candidatesConsidered: retrieval.candidatesConsidered,
      relevanceFloor: this.relevanceFloor,
      answerDigest,
    };

    assertGrounded(answer);

    await this.audit.record(
      auditDecision({
        eventType: "knowledge.answer_grounded",
        actorId: request.actor.actorId,
        actorKind: request.actor.kind,
        actorRoles: request.actor.roles,
        runId: request.runId,
        correlationId: request.correlationId,
        subject: {
          asOf: request.asOf,
          corpora: citedCorpora(qualifying).join(","),
        },
        // Fingerprints only. The passages themselves stay in the corpus, where
        // they are already retained under their own rules, rather than being
        // copied into seven years of audit history.
        inputDigests: { question: screened.inputDigest, answer: answerDigest },
        decision: {
          regulated,
          citations: citations.length,
          topScore: Number(answer.confidence.toFixed(4)),
          relevanceFloor: this.relevanceFloor,
          coverageFloor: this.coverageFloor,
          candidatesConsidered: retrieval.candidatesConsidered,
          excludedOutOfWindow: retrieval.excludedOutOfWindow,
          staleAuthority: answer.staleAuthority,
        },
      }),
    );

    return answer;
  }

  private async freshnessOfCited(
    results: readonly RetrievedChunk[],
    nowIso: IsoTimestamp,
  ): Promise<readonly CorpusFreshness[]> {
    const out: CorpusFreshness[] = [];
    for (const corpusId of citedCorpora(results)) {
      // `requireCorpus` refuses rather than returning null, so a corpus we
      // cannot read is a refusal to answer rather than an answer that quietly
      // skipped its staleness check.
      const corpus = await this.store.requireCorpus(corpusId);
      out.push(corpusFreshness(corpus, nowIso));
    }
    return out;
  }

  /**
   * Record the refusal, route the question, and raise.
   *
   * Never returns. Declared `Promise<never>` so that a call site which forgets
   * to `throw` afterwards still cannot fall through into producing an answer.
   */
  private async refuse(
    request: AnswerRequest,
    regulated: boolean,
    denied: DeniedError,
    context: {
      question: string;
      questionDigest: Digest;
      bestScore: number;
      candidatesConsidered: number;
      staleCorpora: readonly Id<"corpus">[];
      explanation: string;
    },
  ): Promise<never> {
    await this.audit.record(
      auditDecision({
        eventType: "knowledge.answer_refused",
        actorId: request.actor.actorId,
        actorKind: request.actor.kind,
        actorRoles: request.actor.roles,
        runId: request.runId,
        correlationId: request.correlationId,
        subject: {
          asOf: request.asOf,
          corpora: context.staleCorpora.join(","),
        },
        inputDigests: { question: context.questionDigest },
        decision: {
          reason: denied.reason,
          regulated,
          bestScore: Number(context.bestScore.toFixed(4)),
          relevanceFloor: this.relevanceFloor,
          coverageFloor: this.coverageFloor,
          candidatesConsidered: context.candidatesConsidered,
          routedToHuman: this.onRefusal !== undefined,
        },
      }),
    );

    if (this.onRefusal) {
      try {
        await this.onRefusal({
          question: context.question,
          asOf: request.asOf,
          reason: denied.reason,
          actor: request.actor,
          runId: request.runId,
          correlationId: request.correlationId,
          bestScore: context.bestScore,
          candidatesConsidered: context.candidatesConsidered,
          staleCorpora: context.staleCorpora,
          explanation: context.explanation,
        });
      } catch {
        // Swallowed deliberately, and only here. The refusal below is the
        // outcome that matters and must not be replaced by a routing error —
        // turning a refusal into a different exception is how a caller ends up
        // handling the wrong failure. The audit entry above is already durable
        // evidence that a human referral is owed.
      }
    }

    throw denied;
  }
}

function toCitation(result: RetrievedChunk): Citation {
  const { chunk, score } = result;
  const provenance = chunk.provenance;
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    corpusId: chunk.corpusId,
    documentTitle: provenance.documentTitle,
    version: provenance.version,
    effectiveFrom: provenance.effectiveFrom,
    effectiveTo: provenance.effectiveTo,
    jurisdiction: provenance.jurisdiction,
    sourceUri: provenance.sourceUri,
    ingestedBy: provenance.ingestedBy,
    ingestedAt: provenance.ingestedAt,
    contentDigest: provenance.contentDigest,
    chunkDigest: chunk.digest,
    excerpt: chunk.text,
    score,
  };
}

/**
 * Fingerprint of an answer.
 *
 * Covers what was asked, as of when, and exactly which passages were cited —
 * enough for a reviewer to confirm that a stored answer is the one the audit
 * entry refers to, without the audit log holding the text.
 */
export function digestAnswer(
  question: string,
  asOf: IsoDate,
  citations: readonly Citation[],
): Digest {
  return digestValue({
    question,
    asOf,
    citations: citations.map((citation) => ({
      chunkId: String(citation.chunkId),
      chunkDigest: citation.chunkDigest,
      documentId: String(citation.documentId),
      version: citation.version,
      effectiveFrom: citation.effectiveFrom,
      effectiveTo: citation.effectiveTo,
      jurisdiction: citation.jurisdiction,
    })),
  });
}

/**
 * The invariant the answer contract rests on.
 *
 * Every claim cites something, and every citation is complete enough to act on.
 * A citation missing its version or its effective date is worse than no
 * citation: it looks like provenance and it cannot be checked. This is an
 * `InvariantError` rather than a denial because reaching it means this module
 * built a malformed answer — a bug here, not a refusal.
 */
export function assertGrounded(answer: GroundedAnswer): void {
  if (answer.claims.length === 0 || answer.citations.length === 0) {
    throw new InvariantError(
      "A grounded answer was produced with no claims or no citations. Nothing may leave this module ungrounded.",
    );
  }
  for (const claim of answer.claims) {
    if (claim.citations.length === 0) {
      throw new InvariantError(
        `Claim "${claim.text.slice(0, 60)}..." carries no citation. A claim without a citation is an improvisation.`,
      );
    }
  }
  for (const citation of answer.citations) {
    const missing: string[] = [];
    if (!citation.chunkId) missing.push("chunkId");
    if (!citation.documentId) missing.push("documentId");
    if (!citation.version) missing.push("version");
    if (!citation.effectiveFrom) missing.push("effectiveFrom");
    if (!citation.jurisdiction) missing.push("jurisdiction");
    if (!citation.sourceUri) missing.push("sourceUri");
    if (!citation.ingestedBy) missing.push("ingestedBy");
    if (!citation.ingestedAt) missing.push("ingestedAt");
    if (missing.length > 0) {
      throw new InvariantError(
        `Citation for chunk ${String(citation.chunkId)} is missing: ${missing.join(", ")}. A reviewer could not act on it.`,
      );
    }
  }
}

/**
 * A last-resort stand-in when the screen refused before it could redact.
 *
 * The refused text is never echoed into a referral: it is the text that just
 * failed a security check, and copying it into a human's queue is how a
 * planted instruction reaches a person instead of a model.
 */
function redactedFallback(_question: unknown): string {
  return "[refused at the boundary screen]";
}
