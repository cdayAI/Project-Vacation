import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef } from "../record/types.js";
import { assertIsoDate, isInForceOn } from "./migrations.js";
import type { KnowledgeStore } from "./port.js";
import { compareChunks, matchesJurisdiction } from "./store.memory.js";
import type { Chunk, Corpus, RetrievalQuery, RetrievalResult, RetrievedChunk } from "./types.js";

/**
 * Point-in-time lexical retrieval.
 *
 * Two things make this module what it is: the effective-dating, and the
 * deliberate absence of an embedding service.
 *
 * **Effective-dating.** Every query carries an `asOf` civil date and only sees
 * passages whose document version was in force on that date. This is what lets
 * the platform answer "what did the rule say on the date of *that* contract"
 * rather than only "what does it say today" — and answering the second question
 * while a reviewer asked the first is not a slightly worse answer, it is a
 * wrong one that looks right. The window predicate lives in `migrations.ts` and
 * is applied twice: once by the store, where an index can serve it, and again
 * here against the provenance carried on each passage. The second check is not
 * redundant defence for its own sake — provenance is denormalised, so if a
 * store's filter and a chunk's provenance ever disagreed, one of them would be
 * leaking a rule version into a date it did not govern. When they disagree the
 * passage is dropped and counted, never trusted.
 *
 * **Lexical scoring, by decision rather than by omission** (see
 * docs/adr/0015-lexical-retrieval-first.md). BM25 over the effective-dated
 * slice. The material is statutory and procedural text where the question and
 * the source share vocabulary — "Florida rescission period" appears near those
 * words in the statute — which is the case where lexical retrieval is strongest.
 * It is also explainable: when a compliance reviewer asks why a passage was
 * retrieved, "these terms matched, and they are rare in this corpus" is an
 * answer, and a cosine distance is not. And it is deterministic, which the
 * seeded demo requires.
 *
 * Its honest limits. Recall suffers where the question and the authority use
 * different words — "cooling-off period" against a statute that says "right of
 * cancellation". The failure direction is the safe one, because a miss produces
 * a refusal and a referral to a human rather than a confident wrong answer, but
 * it does cost operator time and it should be measured by the evaluation
 * harness rather than assumed away.
 *
 * **Where a vector index goes.** Not here. `KnowledgeStore.searchChunks` is the
 * seam: it takes a scope and a date and returns candidates. A hybrid
 * implementation would return the union of a lexical prefilter and an
 * approximate-nearest-neighbour lookup from that same method, and `scoreChunks`
 * below would combine the two rankings. Nothing above this file changes: the
 * answer contract, the citations, the effective-date guard, and the refusal
 * behaviour are all independent of how candidates were found. That is the point
 * of putting retrieval behind a port rather than inlining a search library.
 */

/** Standard BM25 saturation and length-normalisation parameters. */
const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;
const DEFAULT_LIMIT = 8;

/**
 * Words carried by almost every passage, which therefore separate nothing.
 *
 * Kept short on purpose. An aggressive stoplist strips terms that are ordinary
 * in English and decisive in a statute — "not", "before", "after", "may",
 * "must" all change what a rule means — so anything load-bearing in legal text
 * stays in, and BM25's own inverse document frequency handles the rest.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "was",
  "were",
  "what",
  "which",
  "with",
]);

/**
 * Split text into comparable terms.
 *
 * Accents are folded, case is dropped, and a dotted numeric run stays whole so
 * that a statutory citation such as `721.10` survives as one term instead of
 * becoming the two extremely common tokens `721` and `10`.
 *
 * The plural fold is conservative on purpose. A real stemmer would improve
 * recall and would also merge terms that matter — "leasing" and "lease" are the
 * same concept, "principal" and "principle" are not — and every merge it makes
 * is one a reviewer cannot see in the explanation. So: possessives, a trailing
 * `s`, and the `-es` form after a sibilant. Nothing else.
 */
export function tokenise(text: string): readonly string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const folded = text
    .normalize("NFKD")
    // Combining marks, so an accented term and its unaccented spelling meet.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]s\b/g, "");

  const out: string[] = [];
  for (const match of folded.matchAll(/[a-z]+|[0-9]+(?:\.[0-9]+)*/g)) {
    const raw = match[0];
    if (raw.length < 2) continue;
    const term = foldPlural(raw);
    if (STOPWORDS.has(term)) continue;
    out.push(term);
  }
  return out;
}

function foldPlural(term: string): string {
  if (term.length >= 5 && /(?:s|x|z|ch|sh)es$/.test(term)) return term.slice(0, -2);
  if (term.length >= 4 && term.endsWith("s") && !/(?:ss|us|is)$/.test(term)) {
    return term.slice(0, -1);
  }
  return term;
}

export interface RetrieverOptions {
  readonly k1?: number;
  readonly b?: number;
  readonly defaultLimit?: number;
}

export class Retriever {
  private readonly k1: number;
  private readonly b: number;
  private readonly defaultLimit: number;

  constructor(
    private readonly store: KnowledgeStore,
    options: RetrieverOptions = {},
  ) {
    this.k1 = options.k1 ?? DEFAULT_K1;
    this.b = options.b ?? DEFAULT_B;
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
  }

  /**
   * Corpora this actor is entitled to read.
   *
   * Entitlement is expressed the same way the authorization chokepoint
   * expresses it: roles prefixed `scope:`. Resolving it here, once, means no
   * adapter has to know anything about who is asking — the store is handed a
   * list of corpus ids and answers about those.
   */
  async readableCorpora(actor: ActorRef): Promise<readonly Corpus[]> {
    const held = heldScopes(actor);
    const all = await this.store.listCorpora();
    return all.filter((corpus) => corpus.accessScope.every((scope) => held.has(scope)));
  }

  /**
   * Retrieve passages in force on `asOf`, ranked.
   *
   * @throws {DeniedError} `authorization.data_scope_violation` when the actor
   *   asks for a corpus they are not entitled to read, or holds no entitlement
   *   for any corpus at all.
   */
  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    assertIsoDate("asOf", query.asOf);
    if (typeof query.text !== "string") {
      throw new InvalidInputError("A retrieval query needs text.", "text");
    }
    const limit = query.limit ?? this.defaultLimit;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new InvalidInputError(
        `Retrieval limit must be a positive whole number, received: ${String(query.limit)}`,
        "limit",
      );
    }

    const allCorpora = await this.store.listCorpora();
    const readable = await this.resolveScope(query, allCorpora);
    const terms = tokenise(query.text);

    // No usable terms — a query of only stopwords, or of punctuation — retrieves
    // nothing. It is not an error here; it becomes a refusal one layer up,
    // where refusals are recorded and routed.
    if (terms.length === 0 || readable.length === 0) {
      return {
        asOf: query.asOf,
        terms,
        corpusIds: readable.map((corpus) => corpus.id),
        candidatesConsidered: 0,
        excludedOutOfWindow: 0,
        results: [],
      };
    }

    const corpusIds = readable.map((corpus) => corpus.id);
    const candidates = await this.store.searchChunks({
      corpusIds,
      asOf: query.asOf,
      jurisdictions: query.jurisdictions,
    });

    const permitted = new Set<string>(corpusIds);
    const inWindow: Chunk[] = [];
    let excludedOutOfWindow = 0;
    for (const chunk of candidates) {
      if (isServiceable(chunk, query, permitted)) inWindow.push(chunk);
      else excludedOutOfWindow += 1;
    }

    const scored = scoreChunks(inWindow, terms, { k1: this.k1, b: this.b });

    return {
      asOf: query.asOf,
      terms,
      corpusIds,
      candidatesConsidered: inWindow.length,
      excludedOutOfWindow,
      results: scored.slice(0, limit),
    };
  }

  private async resolveScope(
    query: RetrievalQuery,
    allCorpora: readonly Corpus[],
  ): Promise<readonly Corpus[]> {
    const held = heldScopes(query.actor);
    const readable = allCorpora.filter((corpus) =>
      corpus.accessScope.every((scope) => held.has(scope)),
    );

    if (query.corpusIds && query.corpusIds.length > 0) {
      const wanted = new Set<string>(query.corpusIds);
      const byId = new Map(readable.map((corpus) => [String(corpus.id), corpus]));
      const chosen: Corpus[] = [];
      const refused: string[] = [];
      for (const id of wanted) {
        const corpus = byId.get(id);
        if (corpus) chosen.push(corpus);
        else refused.push(id);
      }
      if (refused.length > 0) {
        // Named a corpus and was refused. This is deliberately louder than
        // silently searching a smaller set: a caller that believes it searched
        // the HOA covenants and did not would report "nothing found" about
        // material it never looked at.
        throw new DeniedError(
          "authorization.data_scope_violation",
          `${query.actor.actorId} may not read corpus/corpora: ${refused.join(", ")}.`,
          { actorId: query.actor.actorId, refused: refused.join(",") },
        );
      }
      return chosen;
    }

    if (readable.length === 0 && allCorpora.length > 0) {
      throw new DeniedError(
        "authorization.data_scope_violation",
        `${query.actor.actorId} holds no data scope for any corpus, so there is nothing to retrieve from.`,
        { actorId: query.actor.actorId },
      );
    }
    return readable;
  }
}

/** Data scopes an actor holds, from the `scope:` role convention. */
function heldScopes(actor: ActorRef): ReadonlySet<string> {
  const roles = Array.isArray(actor?.roles) ? actor.roles : [];
  return new Set(
    roles.filter((role) => role.startsWith("scope:")).map((role) => role.slice("scope:".length)),
  );
}

/**
 * Would this passage be serviceable for this query, judged from the passage
 * itself?
 *
 * The store has already filtered. This re-derives the same decision from the
 * provenance frozen onto the chunk, so a disagreement between the two — a bad
 * join, a filter that lost a clause during a refactor, a row written by
 * something that bypassed this module — results in the passage being dropped
 * rather than in a rule version leaking into a date it did not govern.
 */
function isServiceable(
  chunk: Chunk,
  query: RetrievalQuery,
  permittedCorpora: ReadonlySet<string>,
): boolean {
  const provenance = chunk.provenance;
  if (!provenance) return false;
  if (provenance.documentId !== chunk.documentId) return false;
  if (provenance.corpusId !== chunk.corpusId) return false;
  if (!permittedCorpora.has(chunk.corpusId)) return false;
  if (!isInForceOn(provenance.effectiveFrom, provenance.effectiveTo, query.asOf)) return false;
  if (!matchesJurisdiction(provenance.jurisdiction, query.jurisdictions)) return false;
  return true;
}

export interface ScoringOptions {
  readonly k1?: number;
  readonly b?: number;
}

/**
 * Rank passages against query terms with BM25.
 *
 * Collection statistics — how many passages there are, and how many contain a
 * given term — are taken from the candidate set, which is the effective-dated
 * slice the query is actually allowed to see. That is the correct collection
 * for the question being asked: a term that is rare in the rules in force in
 * 2019 should be treated as rare when answering about 2019, whatever the 2026
 * corpus looks like.
 *
 * The raw score is divided by the score an ideal passage could reach for this
 * query, giving a number in 0..1. Raw BM25 is not comparable across queries —
 * it scales with the number and rarity of the terms — so a fixed "relevance
 * floor" expressed in raw score would be strict for a one-word question and
 * meaningless for a ten-word one. Normalising is what makes the floor in
 * `answer.ts` mean the same thing every time.
 *
 * `coverage` is reported separately and is not folded into the score. A long
 * passage that repeats one rare query term can out-score a passage that
 * contains every term once, and for a regulated answer that is the wrong
 * ranking to act on unchallenged — so the caller can require both a score and a
 * share of the question's terms.
 */
export function scoreChunks(
  chunks: readonly Chunk[],
  queryTerms: readonly string[],
  options: ScoringOptions = {},
): readonly RetrievedChunk[] {
  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;

  const distinctQueryTerms = [...new Set(queryTerms)];
  if (chunks.length === 0 || distinctQueryTerms.length === 0) return [];

  const frequencies: { chunk: Chunk; counts: Map<string, number>; length: number }[] = [];
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = tokenise(chunk.text);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const term of distinctQueryTerms) {
      if (counts.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    totalLength += tokens.length;
    frequencies.push({ chunk, counts, length: tokens.length });
  }

  const n = chunks.length;
  const averageLength = totalLength / n;

  // The BM25+ form of inverse document frequency, which stays positive even for
  // a term present in more than half the collection. The classic form goes
  // negative there, and a negative contribution means a passage can be punished
  // for containing a query term — indefensible when the term is the subject of
  // the question.
  const idf = new Map<string, number>();
  for (const term of distinctQueryTerms) {
    const df = documentFrequency.get(term) ?? 0;
    idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  const maxPossible = distinctQueryTerms.reduce(
    (total, term) => total + (idf.get(term) ?? 0) * (k1 + 1),
    0,
  );

  const scored: RetrievedChunk[] = [];
  for (const entry of frequencies) {
    let raw = 0;
    const matchedTerms: string[] = [];
    for (const term of distinctQueryTerms) {
      const tf = entry.counts.get(term) ?? 0;
      if (tf === 0) continue;
      matchedTerms.push(term);
      const weight = idf.get(term) ?? 0;
      const denominator =
        tf + k1 * (1 - b + (b * entry.length) / (averageLength > 0 ? averageLength : 1));
      raw += (weight * (tf * (k1 + 1))) / denominator;
    }
    if (matchedTerms.length === 0) continue;

    scored.push({
      chunk: entry.chunk,
      score: maxPossible > 0 ? raw / maxPossible : 0,
      rawScore: raw,
      coverage: matchedTerms.length / distinctQueryTerms.length,
      matchedTerms,
    });
  }

  // Ties are broken by a total order over the passages themselves, so two runs
  // of the seeded demo cite the same source for the same question.
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return compareChunks(left.chunk, right.chunk);
  });
  return scored;
}

/** Corpus ids referenced by a set of results, deduplicated, in first-seen order. */
export function citedCorpora(results: readonly RetrievedChunk[]): readonly Id<"corpus">[] {
  const seen: Id<"corpus">[] = [];
  for (const result of results) {
    if (!seen.includes(result.chunk.corpusId)) seen.push(result.chunk.corpusId);
  }
  return seen;
}
