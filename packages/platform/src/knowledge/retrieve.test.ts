import { describe, it, expect } from "vitest";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import { SeededIdGenerator } from "../kernel/ids.js";
import type { ActorRef } from "../record/types.js";
import { MemoryDb } from "../store/db.js";
import type { ChunkSearch, KnowledgeStore } from "./port.js";
import { Retriever, citedCorpora, scoreChunks, tokenise } from "./retrieve.js";
import { MemoryKnowledgeStore } from "./store.memory.js";
import { GLOBAL_JURISDICTION, type Chunk, type Corpus, type SourceDocument } from "./types.js";

/**
 * Retrieval: the effective-date guard, entitlement, and the scorer.
 *
 * These tests build chunks directly rather than going through ingestion,
 * because the properties under test are about what retrieval will and will not
 * return — including cases a correct ingestion cannot produce, which is exactly
 * where a leak would hide.
 */

const READER: ActorRef = {
  actorId: "act_reader",
  kind: "human",
  roles: ["support_agent", "scope:legal"],
};

const OUTSIDER: ActorRef = { actorId: "act_outsider", kind: "human", roles: ["support_agent"] };

const ids = new SeededIdGenerator("retrieve-test");

function corpus(overrides: Partial<Corpus> = {}): Corpus {
  return {
    id: ids.next("corpus"),
    name: "rescission_statutes",
    owner: "legal_operations",
    reviewCadenceDays: 180,
    lastReviewedAt: "2026-07-01T00:00:00.000Z",
    accessScope: ["legal"],
    classification: "internal",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface DocumentSpec {
  readonly corpusId: Corpus["id"];
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly jurisdiction?: string;
  readonly passages: readonly string[];
}

function documentWithChunks(spec: DocumentSpec): {
  document: SourceDocument;
  chunks: readonly Chunk[];
} {
  const documentId = ids.next("document");
  const text = spec.passages.join("\n\n");
  const document: SourceDocument = {
    id: documentId,
    corpusId: spec.corpusId,
    title: `Statute ${spec.version}`,
    version: spec.version,
    effectiveFrom: spec.effectiveFrom,
    effectiveTo: spec.effectiveTo,
    jurisdiction: spec.jurisdiction ?? "FL",
    ingestedBy: "act_steward",
    ingestedAt: "2026-08-06T12:00:00.000Z",
    sourceUri: `https://example.invalid/${spec.version}`,
    contentDigest: digestValue({ text }),
    status: "pending",
    screenVerdict: "clean",
    chunkCount: spec.passages.length,
  };
  const chunks = spec.passages.map((passage, ordinal) => ({
    id: ids.next("chunk"),
    documentId,
    corpusId: spec.corpusId,
    ordinal,
    text: passage,
    digest: digestValue({ text: passage }),
    provenance: {
      corpusId: document.corpusId,
      documentId: document.id,
      documentTitle: document.title,
      version: document.version,
      effectiveFrom: document.effectiveFrom,
      effectiveTo: document.effectiveTo,
      jurisdiction: document.jurisdiction,
      ingestedBy: document.ingestedBy,
      ingestedAt: document.ingestedAt,
      sourceUri: document.sourceUri,
      contentDigest: document.contentDigest,
    },
  }));
  return { document, chunks };
}

async function seeded(specs: readonly Omit<DocumentSpec, "corpusId">[], corpusOverrides = {}) {
  const db = new MemoryDb();
  const store = new MemoryKnowledgeStore(db);
  const created = await store.createCorpus(corpus(corpusOverrides));
  const documents: SourceDocument[] = [];
  for (const spec of specs) {
    const built = documentWithChunks({ ...spec, corpusId: created.id });
    const put = await store.putDocument(built.document, built.chunks);
    const active = await store.activateDocument(put.document.id, ids.next("auditEntry"));
    documents.push(active);
  }
  return { store, corpus: created, documents, retriever: new Retriever(store) };
}

const OLD_RULE =
  "A purchaser of a timeshare interest in Florida may cancel the contract until midnight of the tenth calendar day following execution.";
const NEW_RULE =
  "A purchaser of a timeshare interest in Florida may cancel the contract until midnight of the fifteenth calendar day following execution.";

describe("effective-dated retrieval", () => {
  const specs = [
    {
      version: "FL@1",
      effectiveFrom: "2015-01-01",
      effectiveTo: "2019-12-31",
      passages: [OLD_RULE],
    },
    { version: "FL@2", effectiveFrom: "2020-01-01", effectiveTo: null, passages: [NEW_RULE] },
  ] as const;

  it("returns the version in force on the asked-for date", async () => {
    const { retriever } = await seeded(specs);

    const past = await retriever.retrieve({
      text: "Florida timeshare cancel contract",
      asOf: "2018-06-01",
      actor: READER,
    });
    expect(past.results).toHaveLength(1);
    expect(past.results[0]?.chunk.provenance.version).toBe("FL@1");

    const present = await retriever.retrieve({
      text: "Florida timeshare cancel contract",
      asOf: "2026-06-01",
      actor: READER,
    });
    expect(present.results).toHaveLength(1);
    expect(present.results[0]?.chunk.provenance.version).toBe("FL@2");
  });

  it("never leaks a future version into a past query", async () => {
    const { retriever } = await seeded(specs);
    const past = await retriever.retrieve({
      text: "Florida timeshare cancel contract midnight calendar day",
      asOf: "2018-06-01",
      actor: READER,
    });
    for (const result of past.results) {
      expect(result.chunk.text).not.toContain("fifteenth");
      expect(result.chunk.provenance.effectiveFrom <= "2018-06-01").toBe(true);
    }
  });

  it("treats both ends of the effective window as inclusive", async () => {
    const { retriever } = await seeded(specs);

    const firstDay = await retriever.retrieve({
      text: "Florida cancel",
      asOf: "2015-01-01",
      actor: READER,
    });
    expect(firstDay.results[0]?.chunk.provenance.version).toBe("FL@1");

    const lastDay = await retriever.retrieve({
      text: "Florida cancel",
      asOf: "2019-12-31",
      actor: READER,
    });
    expect(lastDay.results[0]?.chunk.provenance.version).toBe("FL@1");

    const dayAfter = await retriever.retrieve({
      text: "Florida cancel",
      asOf: "2020-01-01",
      actor: READER,
    });
    expect(dayAfter.results[0]?.chunk.provenance.version).toBe("FL@2");

    const dayBefore = await retriever.retrieve({
      text: "Florida cancel",
      asOf: "2014-12-31",
      actor: READER,
    });
    expect(dayBefore.results).toHaveLength(0);
  });

  it("drops a passage the store returned outside the window rather than trusting it", async () => {
    // A store whose date filter is broken. The retriever re-derives the window
    // from the provenance on each passage, so the leak is contained here rather
    // than becoming a citation to a rule that was not yet law.
    const { store, corpus: created } = await seeded(specs);
    const leaky: Pick<KnowledgeStore, "listCorpora" | "searchChunks"> = {
      listCorpora: () => store.listCorpora(),
      searchChunks: async (query: ChunkSearch) => {
        // Ignores asOf entirely and hands back every passage in scope.
        const documents = await store.listDocuments({ corpusId: query.corpusIds[0] });
        const out: Chunk[] = [];
        for (const document of documents) out.push(...(await store.listChunks(document.id)));
        return out;
      },
    };

    const retriever = new Retriever(leaky as KnowledgeStore);
    const past = await retriever.retrieve({
      text: "Florida timeshare cancel contract",
      asOf: "2018-06-01",
      actor: READER,
      corpusIds: [created.id],
    });

    expect(past.excludedOutOfWindow).toBe(1);
    expect(past.results).toHaveLength(1);
    expect(past.results[0]?.chunk.provenance.version).toBe("FL@1");
  });

  it("does not retrieve a document whose ingestion receipt never landed", async () => {
    const db = new MemoryDb();
    const store = new MemoryKnowledgeStore(db);
    const created = await store.createCorpus(corpus());
    const built = documentWithChunks({
      corpusId: created.id,
      version: "FL@1",
      effectiveFrom: "2015-01-01",
      effectiveTo: null,
      passages: [OLD_RULE],
    });
    await store.putDocument(built.document, built.chunks);

    const retriever = new Retriever(store);
    const result = await retriever.retrieve({
      text: "Florida timeshare cancel",
      asOf: "2018-06-01",
      actor: READER,
    });
    expect(result.results).toHaveLength(0);
    expect(result.candidatesConsidered).toBe(0);
  });

  it("refuses a malformed asOf rather than guessing at it", async () => {
    const { retriever } = await seeded(specs);
    await expect(
      retriever.retrieve({ text: "cancel", asOf: "06/01/2018", actor: READER }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      retriever.retrieve({ text: "cancel", asOf: "2018-06-01T00:00:00.000Z", actor: READER }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("jurisdiction scoping", () => {
  it("includes global material in a state-scoped query and excludes other states", async () => {
    const { retriever } = await seeded([
      {
        version: "FL@1",
        effectiveFrom: "2015-01-01",
        effectiveTo: null,
        jurisdiction: "FL",
        passages: [OLD_RULE],
      },
      {
        version: "NV@1",
        effectiveFrom: "2015-01-01",
        effectiveTo: null,
        jurisdiction: "NV",
        passages: [
          "A purchaser of a timeshare interest in Nevada may cancel the contract within five calendar days.",
        ],
      },
      {
        version: "SOP@1",
        effectiveFrom: "2015-01-01",
        effectiveTo: null,
        jurisdiction: GLOBAL_JURISDICTION,
        passages: [
          "Company procedure: every cancel request from a purchaser is acknowledged in writing within one business day.",
        ],
      },
    ]);

    const result = await retriever.retrieve({
      text: "purchaser cancel timeshare",
      asOf: "2026-01-01",
      actor: READER,
      jurisdictions: ["FL"],
    });

    const jurisdictions = result.results.map((entry) => entry.chunk.provenance.jurisdiction);
    expect(jurisdictions).toContain("FL");
    expect(jurisdictions).toContain(GLOBAL_JURISDICTION);
    expect(jurisdictions).not.toContain("NV");
  });
});

describe("entitlement", () => {
  it("refuses a named corpus the actor may not read, rather than silently searching less", async () => {
    const { retriever, corpus: created } = await seeded([
      { version: "FL@1", effectiveFrom: "2015-01-01", effectiveTo: null, passages: [OLD_RULE] },
    ]);

    await expect(
      retriever.retrieve({
        text: "cancel",
        asOf: "2026-01-01",
        actor: OUTSIDER,
        corpusIds: [created.id],
      }),
    ).rejects.toMatchObject({ reason: "authorization.data_scope_violation" });
  });

  it("refuses an actor entitled to nothing at all", async () => {
    const { retriever } = await seeded([
      { version: "FL@1", effectiveFrom: "2015-01-01", effectiveTo: null, passages: [OLD_RULE] },
    ]);

    await expect(
      retriever.retrieve({ text: "cancel", asOf: "2026-01-01", actor: OUTSIDER }),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("searches every corpus an unrestricted actor may read", async () => {
    const { retriever } = await seeded(
      [{ version: "FL@1", effectiveFrom: "2015-01-01", effectiveTo: null, passages: [OLD_RULE] }],
      { accessScope: [] },
    );

    const result = await retriever.retrieve({
      text: "purchaser cancel timeshare",
      asOf: "2026-01-01",
      actor: OUTSIDER,
    });
    expect(result.results.length).toBeGreaterThan(0);
  });
});

describe("tokenise", () => {
  it("drops case, punctuation, and stopwords", () => {
    expect(tokenise("The purchaser may CANCEL the contract.")).toEqual([
      "purchaser",
      "may",
      "cancel",
      "contract",
    ]);
  });

  it("keeps a statutory citation whole", () => {
    expect(tokenise("See section 721.10 of the code")).toContain("721.10");
  });

  it("folds plurals conservatively", () => {
    expect(tokenise("days notices statutes")).toEqual(["day", "notice", "statute"]);
    // Words that merely end in s are left alone.
    expect(tokenise("business process status")).toEqual(["business", "process", "status"]);
  });

  it("returns nothing for a query of pure stopwords", () => {
    expect(tokenise("what is the")).toEqual([]);
  });
});

describe("scoreChunks", () => {
  const chunkOf = (text: string, ordinal: number): Chunk => ({
    id: `chk_${ordinal}` as Chunk["id"],
    documentId: "doc_1" as Chunk["documentId"],
    corpusId: "cor_1" as Chunk["corpusId"],
    ordinal,
    text,
    digest: digestValue({ text }),
    provenance: {
      corpusId: "cor_1" as Chunk["corpusId"],
      documentId: "doc_1" as Chunk["documentId"],
      documentTitle: "t",
      version: "v1",
      effectiveFrom: "2015-01-01",
      effectiveTo: null,
      jurisdiction: "FL",
      ingestedBy: "act_steward",
      ingestedAt: "2026-08-06T12:00:00.000Z",
      sourceUri: "https://example.invalid/t",
      contentDigest: digestValue({ text: "t" }),
    },
  });

  const chunks = [
    chunkOf("The Florida rescission period for a timeshare contract is ten calendar days.", 0),
    chunkOf("Maintenance fees are billed annually to every owner of a vacation interest.", 1),
    chunkOf("The Florida developer must refund all payments within twenty days.", 2),
  ];

  it("ranks the passage that answers the question first", () => {
    const scored = scoreChunks(chunks, tokenise("Florida rescission period timeshare"));
    expect(scored[0]?.chunk.ordinal).toBe(0);
  });

  it("reports coverage separately from score", () => {
    const scored = scoreChunks(chunks, tokenise("Florida rescission period timeshare"));
    expect(scored[0]?.coverage).toBe(1);
    const partial = scored.find((entry) => entry.chunk.ordinal === 2);
    expect(partial?.coverage).toBeLessThan(1);
  });

  it("keeps normalised scores inside 0..1", () => {
    const scored = scoreChunks(chunks, tokenise("Florida rescission period timeshare"));
    for (const entry of scored) {
      expect(entry.score).toBeGreaterThan(0);
      expect(entry.score).toBeLessThanOrEqual(1);
    }
  });

  it("omits a passage that matches no query term at all", () => {
    const scored = scoreChunks(chunks, tokenise("Hawaii delinquency threshold"));
    expect(scored).toHaveLength(0);
  });

  it("breaks ties deterministically so two runs cite the same source", () => {
    const identical = [chunkOf("rescission period", 5), chunkOf("rescission period", 4)];
    const first = scoreChunks(identical, tokenise("rescission period"));
    const second = scoreChunks([...identical].reverse(), tokenise("rescission period"));
    expect(first.map((entry) => entry.chunk.id)).toEqual(second.map((entry) => entry.chunk.id));
  });

  it("returns nothing when the query has no usable terms", () => {
    expect(scoreChunks(chunks, tokenise("what is the"))).toHaveLength(0);
  });
});

describe("citedCorpora", () => {
  it("deduplicates in first-seen order", () => {
    const make = (corpusId: string) =>
      ({
        chunk: { corpusId } as Chunk,
        score: 1,
        rawScore: 1,
        coverage: 1,
        matchedTerms: [],
      }) as const;
    expect(citedCorpora([make("cor_b"), make("cor_a"), make("cor_b")])).toEqual([
      "cor_b",
      "cor_a",
    ]);
  });
});
