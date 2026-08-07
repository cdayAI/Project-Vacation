import { describe, it, expect, afterEach } from "vitest";
import { FetchOidcTransport } from "../identity/oidc.js";
import { RandomIdGenerator } from "../kernel/ids.js";

/**
 * Pass 3 — egress and identifier strength.
 *
 * Two questions from the security pass that are answered by the code rather
 * than by a document:
 *
 *   *Can any component reach a host outside the allowlist — including through
 *   a redirect?* `integrations/egress.ts` answers no, and says why it sets
 *   `redirect: "manual"`: "A 302 to an unallowlisted host would walk straight
 *   past the allowlist this client exists to enforce." That reasoning is not
 *   specific to that file.
 *
 *   *Is an identifier that gates access unguessable?* Parked-action ids,
 *   approval ids, and session ids are all produced by one generator, and two
 *   of the three are presented by a caller to reach a record.
 */

const realFetch = globalThis.fetch;

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function captureFetch(captured: Captured[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

describe("the OIDC transport's outbound calls", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses to follow a redirect when fetching the discovery document", async () => {
    // `fetch` follows redirects by default. A provider — or anything that can
    // answer for its hostname — that replies 302 sends this request to a host
    // no allowlist ever saw, and the body that comes back is parsed as the
    // discovery document.
    const captured: Captured[] = [];
    captureFetch(captured);

    await new FetchOidcTransport().getJson("https://idp.example.com/.well-known/x", 1_000);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.init.redirect).toBe("manual");
  });

  it("refuses to follow a redirect when posting to the token endpoint", async () => {
    // The sharper half. This request body carries `client_secret`. A 307 or 308
    // is re-sent verbatim to the redirect target, so following one hands the
    // client secret to whatever host the redirect names.
    const captured: Captured[] = [];
    captureFetch(captured);

    await new FetchOidcTransport().postForm(
      "https://idp.example.com/token",
      { grant_type: "authorization_code", client_secret: "not-a-real-secret" },
      {},
      1_000,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.init.redirect).toBe("manual");
  });
});

describe("production identifiers", () => {
  it("does not repeat its own opening characters at the end", () => {
    // `encodeSuffix` (kernel/ids.ts:59) indexes `bytes[i % bytes.length]`, and
    // `RandomIdGenerator` hands it the sixteen bytes of a UUID while asking for
    // twenty-two characters. Characters 17-22 are therefore a literal copy of
    // characters 1-6 of every identifier the platform mints in production.
    const ids = new RandomIdGenerator();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const value = ids.next("parkedAction").slice("pac_".length);
      expect(value).toHaveLength(22);
      expect(
        value.slice(16, 22),
        `identifier "${value}" repeats its first six characters at the end`,
      ).not.toBe(value.slice(0, 6));
    }
  });

  it("carries distinct entropy in every character position", () => {
    // The consequence, stated as a measurement rather than as a shape. Twenty-
    // two characters from a thirty-two-symbol alphabet look like 110 bits; the
    // repetition means only sixteen positions are independent, so the real
    // figure is 80. Nothing here is brute-forceable at 80 bits — this is a
    // strength claim that is quietly wrong, not a break — but an identifier
    // that gates access to another party's record should be worth what it
    // appears to be worth.
    const ids = new RandomIdGenerator();
    const samples = Array.from({ length: 200 }, () =>
      ids.next("session").slice("ses_".length),
    );
    for (let position = 0; position < 22; position += 1) {
      const distinct = new Set(samples.map((value) => value[position])).size;
      expect(
        distinct,
        `character ${position} of the identifier takes only ${distinct} distinct values across 200 samples`,
      ).toBeGreaterThan(8);
    }
    // Every position independent means no position is a function of another.
    const collisions = samples.filter((value) => value.slice(0, 6) === value.slice(16, 22));
    expect(collisions).toHaveLength(0);
  });
});
