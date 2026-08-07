import { describe, it, expect } from "vitest";
import { canonicalJson, CanonicalisationError } from "./canonical.js";
import { digestValue, digestBytes, isDigest, digestsEqual } from "./hash.js";
import { FixedClock, SystemClock, DAY } from "./clock.js";
import { SeededIdGenerator, RandomIdGenerator, isId, assertId } from "./ids.js";
import {
  redactText,
  redactValue,
  containsSecret,
  looksLikeCardNumber,
  passesLuhn,
  REDACTED,
} from "./redact.js";
import { loadConfig, describeConfig } from "./config.js";
import { ConfigError, DeniedError, isDenied } from "./errors.js";
import { RecordingLogger } from "./logger.js";

describe("canonicalJson", () => {
  it("orders object keys so equal values serialise identically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it("orders keys at every depth, not only the top level", () => {
    const left = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const right = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it("omits undefined properties so they do not change the digest", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1, b: undefined }));
  });

  it("preserves array order because order is meaningful", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("normalises negative zero so it cannot produce a second digest", () => {
    expect(canonicalJson({ a: -0 })).toBe(canonicalJson({ a: 0 }));
  });

  it("rejects non-finite numbers rather than emitting null", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalisationError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(CanonicalisationError);
  });

  it("rejects Date so timezone handling stays at the call site", () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(CanonicalisationError);
  });

  it("rejects BigInt, Map and Set", () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(CanonicalisationError);
    expect(() => canonicalJson({ a: new Map() })).toThrow(CanonicalisationError);
    expect(() => canonicalJson({ a: new Set() })).toThrow(CanonicalisationError);
  });

  it("names the failing path so a large payload is debuggable", () => {
    expect(() => canonicalJson({ outer: { inner: [1, Number.NaN] } })).toThrow(
      /outer\.inner\[1\]/,
    );
  });

  it("escapes strings so a crafted value cannot forge structure", () => {
    const forged = canonicalJson({ a: '","b":"injected' });
    expect(JSON.parse(forged)).toEqual({ a: '","b":"injected' });
  });
});

describe("digests", () => {
  it("is stable across key order", () => {
    expect(digestValue({ x: 1, y: 2 })).toBe(digestValue({ y: 2, x: 1 }));
  });

  it("changes when any value changes", () => {
    expect(digestValue({ amount: 100 })).not.toBe(digestValue({ amount: 101 }));
  });

  it("produces a recognisable prefixed form", () => {
    const digest = digestBytes("hello");
    expect(digest.startsWith("sha256:")).toBe(true);
    expect(isDigest(digest)).toBe(true);
  });

  it("rejects malformed digests", () => {
    expect(isDigest("sha256:nothex")).toBe(false);
    expect(isDigest("md5:abc")).toBe(false);
    expect(isDigest("")).toBe(false);
  });

  it("compares digests without leaking length-independent timing", () => {
    const a = digestValue({ a: 1 });
    expect(digestsEqual(a, a)).toBe(true);
    expect(digestsEqual(a, digestValue({ a: 2 }))).toBe(false);
    expect(digestsEqual(a, "short")).toBe(false);
  });
});

describe("clock", () => {
  it("does not move on its own", () => {
    const clock = new FixedClock("2026-08-06T12:00:00.000Z");
    const first = clock.now();
    const second = clock.now();
    expect(first).toBe(second);
    expect(clock.nowIso()).toBe("2026-08-06T12:00:00.000Z");
  });

  it("advances by an explicit amount", () => {
    const clock = new FixedClock("2026-08-06T00:00:00.000Z");
    clock.advance(DAY);
    expect(clock.nowIso()).toBe("2026-08-07T00:00:00.000Z");
  });

  it("refuses to run backwards via advance", () => {
    const clock = new FixedClock(0);
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });

  it("rejects an unparseable start", () => {
    expect(() => new FixedClock("not a date")).toThrow(TypeError);
  });

  it("system clock returns a plausible instant", () => {
    const clock = new SystemClock();
    expect(clock.now()).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
    expect(clock.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("identifiers", () => {
  it("is deterministic for a given seed and call order", () => {
    const a = new SeededIdGenerator("seed-1");
    const b = new SeededIdGenerator("seed-1");
    expect(a.next("run")).toBe(b.next("run"));
    expect(a.next("run")).toBe(b.next("run"));
  });

  it("differs between seeds", () => {
    expect(new SeededIdGenerator("a").next("run")).not.toBe(
      new SeededIdGenerator("b").next("run"),
    );
  });

  it("counts per kind so interleaving does not shift a sequence", () => {
    const gen = new SeededIdGenerator("seed");
    const firstRun = gen.next("run");
    gen.next("step");
    const secondRun = gen.next("run");

    const reference = new SeededIdGenerator("seed");
    expect(reference.next("run")).toBe(firstRun);
    reference.next("step");
    expect(reference.next("run")).toBe(secondRun);
  });

  it("resets back to the start of the sequence", () => {
    const gen = new SeededIdGenerator("seed");
    const first = gen.next("run");
    gen.next("run");
    gen.reset();
    expect(gen.next("run")).toBe(first);
  });

  it("prefixes by entity kind", () => {
    const gen = new RandomIdGenerator();
    const runId = gen.next("run");
    expect(isId(runId, "run")).toBe(true);
    expect(isId(runId, "approval")).toBe(false);
    expect(() => assertId(runId, "approval")).toThrow(TypeError);
  });

  it("random ids do not collide across a reasonable sample", () => {
    const gen = new RandomIdGenerator();
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(gen.next("run"));
    expect(seen.size).toBe(2000);
  });
});

describe("redaction", () => {
  it("removes private key blocks including the body", () => {
    const text = `key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nsecretbody\n-----END RSA PRIVATE KEY-----\ndone`;
    const result = redactText(text);
    expect(result.text).not.toContain("secretbody");
    expect(result.text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(result.matched).toContain("private_key");
  });

  it("removes JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(redactText(`token ${jwt}`).text).not.toContain("eyJhbGciOi");
  });

  it("removes AWS access key ids", () => {
    expect(redactText("AKIAIOSFODNN7EXAMPLE").text).toBe(REDACTED);
  });

  it("removes credentials embedded in a URL but keeps the scheme", () => {
    const result = redactText("postgres://admin:hunter2@db.internal:5432/vacation");
    expect(result.text).not.toContain("hunter2");
    expect(result.text).toContain("postgres://");
  });

  it("removes values assigned to secret-shaped names", () => {
    const result = redactText("client_secret=abc123XYZ987 and api_key: zzzTOPzzz");
    expect(result.text).not.toContain("abc123XYZ987");
    expect(result.text).not.toContain("zzzTOPzzz");
  });

  it("removes primary account numbers so card data cannot enter the record", () => {
    // A well-known Visa test number; passes Luhn.
    const result = redactText("card 4111111111111111 on file");
    expect(result.text).not.toContain("4111111111111111");
    expect(result.matched).toContain("pan");
  });

  it("leaves long numbers that are not card numbers alone", () => {
    // Fails Luhn, so it is not treated as a PAN.
    expect(passesLuhn("4111111111111112")).toBe(false);
    expect(redactText("reference 4111111111111112").text).toContain("4111111111111112");
  });

  it("removes US social security numbers", () => {
    expect(redactText("ssn 123-45-6789").text).not.toContain("123-45-6789");
  });

  it("never throws, whatever it is given", () => {
    expect(() => redactText("")).not.toThrow();
    expect(() => redactText("a".repeat(50_000))).not.toThrow();
    expect(() => redactText(undefined as unknown as string)).not.toThrow();
  });

  it("is safe to call repeatedly without regex state leaking between calls", () => {
    const input = "AKIAIOSFODNN7EXAMPLE";
    const first = redactText(input).text;
    const second = redactText(input).text;
    const third = redactText(input).text;
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("drops values under sensitive keys regardless of content", () => {
    const out = redactValue({ password: "ordinary-looking", nested: { token: "plain" } }) as {
      password: string;
      nested: { token: string };
    };
    expect(out.password).toBe(REDACTED);
    expect(out.nested.token).toBe(REDACTED);
  });

  it("scans values under innocuous keys for secret-shaped content", () => {
    const out = redactValue({ note: "use AKIAIOSFODNN7EXAMPLE" }) as { note: string };
    expect(out.note).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("bounds recursion depth so a cyclic-shaped payload cannot hang the logger", () => {
    let deep: Record<string, unknown> = { value: "AKIAIOSFODNN7EXAMPLE" };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(() => redactValue(deep)).not.toThrow();
  });

  it("reports whether text contains anything secret-shaped", () => {
    expect(containsSecret("nothing interesting here")).toBe(false);
    expect(containsSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  /**
   * The numeric card-number check, and the bound it turns on.
   *
   * The digit floor is the whole decision here, and it is a measurement rather
   * than a preference: Luhn accepts one integer in ten, so a thirteen-digit
   * floor would refuse about ten per cent of raw epoch-millisecond values —
   * which this platform writes into decisions and log lines. These cases pin
   * the floor so it cannot be "tightened" back to thirteen by someone reasoning
   * from the text pattern alone.
   */
  describe("card numbers written as numbers", () => {
    it("catches the fourteen-to-nineteen digit Luhn-valid case", () => {
      expect(looksLikeCardNumber(4111111111111111)).toBe(true); // 16, Visa
      expect(looksLikeCardNumber(378282246310005)).toBe(true); // 15, Amex
      expect(looksLikeCardNumber(6011111111111117)).toBe(true); // 16, Discover
      expect(redactValue({ accountRef: 4111111111111111 })).toEqual({ accountRef: REDACTED });
      expect(redactValue([378282246310005])).toEqual([REDACTED]);
    });

    it("leaves epoch milliseconds alone, including the Luhn-valid ones", () => {
      // 2026-03-31T23:33:20.006Z passes Luhn and is a perfectly ordinary
      // reading; at a thirteen-digit floor it would be refused, and a refused
      // audit write refuses the action it was recording. One consecutive
      // millisecond in ten looks like this.
      expect(passesLuhn("1775000000006")).toBe(true);
      expect(looksLikeCardNumber(1775000000006)).toBe(false);
      expect(looksLikeCardNumber(Date.parse("2026-03-31T23:33:20.006Z"))).toBe(false);
      expect(looksLikeCardNumber(1775000000000)).toBe(false);
    });

    it("leaves the ordinary numeric values the platform writes alone", () => {
      for (const benign of [0, 3, 4111, 1_234_567, 12.5, 0.42, -7, 20260807090000]) {
        expect(looksLikeCardNumber(benign), String(benign)).toBe(false);
      }
      // Cents, byte counts and sequence numbers are nowhere near the floor.
      expect(redactValue({ costCents: 42_00, bytes: 1_048_576, seq: 91 })).toEqual({
        costCents: 4200,
        bytes: 1_048_576,
        seq: 91,
      });
    });

    it("ignores anything past the safe-integer boundary", () => {
      // Beyond MAX_SAFE_INTEGER the decimal digits are an artefact of floating
      // point rather than what the caller wrote, so testing them tests nothing.
      expect(looksLikeCardNumber(1e21)).toBe(false);
      expect(looksLikeCardNumber(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
      expect(looksLikeCardNumber(Number.NaN)).toBe(false);
      expect(looksLikeCardNumber(Number.POSITIVE_INFINITY)).toBe(false);
    });

    it("covers bigint, which the logger would otherwise stringify intact", () => {
      expect(looksLikeCardNumber(4111111111111111n)).toBe(true);
      expect(redactValue({ pan: 4111111111111111n })).toEqual({ pan: REDACTED });
      expect(redactValue({ ns: 123456789n })).toEqual({ ns: "123456789n" });
    });
  });
});

describe("configuration", () => {
  const productionBase = {
    PV_ENV: "production",
    PV_STORE: "postgres",
    PV_DATABASE_URL: "postgres://user:pass@db/vacation",
    PV_OIDC_ISSUER: "https://idp.example.com",
    PV_OIDC_CLIENT_ID: "client",
    PV_OIDC_CLIENT_SECRET: "secret",
    PV_OIDC_REDIRECT_URI: "https://console.example.com/auth/callback",
    PV_SESSION_SECRET: "x".repeat(32),
    PV_MODEL_PROVIDER: "anthropic",
    PV_ANTHROPIC_API_KEY: "key",
  };

  it("defaults every containment setting to the safe value", () => {
    const config = loadConfig({});
    expect(config.sandboxMode).toBe("disabled");
    expect(config.discoveryEnabled).toBe(false);
    expect(config.egressAllowlist).toEqual([]);
    expect(config.store).toBe("memory");
  });

  it("refuses postgres without a connection string", () => {
    expect(() => loadConfig({ PV_STORE: "postgres" })).toThrow(ConfigError);
  });

  it("refuses the in-memory store in production", () => {
    expect(() =>
      loadConfig({ ...productionBase, PV_STORE: "memory", PV_DATABASE_URL: undefined }),
    ).toThrow(/must be "postgres" in production/);
  });

  it("refuses to start in production without single sign-on", () => {
    const { PV_OIDC_ISSUER: _omitted, ...withoutIssuer } = productionBase;
    expect(() => loadConfig(withoutIssuer)).toThrow(/Single sign-on is required/);
  });

  it("refuses a short session secret in production", () => {
    expect(() => loadConfig({ ...productionBase, PV_SESSION_SECRET: "short" })).toThrow(
      /at least 32 characters/,
    );
  });

  it("refuses the fake model provider in production", () => {
    expect(() =>
      loadConfig({ ...productionBase, PV_MODEL_PROVIDER: "fake", PV_ANTHROPIC_API_KEY: undefined }),
    ).toThrow(/test double/);
  });

  it("refuses the anthropic provider without a key", () => {
    expect(() =>
      loadConfig({ PV_MODEL_PROVIDER: "anthropic", PV_ANTHROPIC_API_KEY: "" }),
    ).toThrow(/requires PV_ANTHROPIC_API_KEY/);
  });

  it("accepts a complete production configuration", () => {
    const config = loadConfig(productionBase);
    expect(config.environment).toBe("production");
    expect(config.store).toBe("postgres");
  });

  it("warns loudly when the sandbox is not a real boundary", () => {
    const config = loadConfig({ PV_SANDBOX_MODE: "subprocess" });
    expect(config.warnings.join(" ")).toMatch(/NOT a security boundary/);
  });

  it("warns loudly when employee work discovery is enabled", () => {
    const config = loadConfig({ PV_DISCOVERY_ENABLED: "true" });
    expect(config.warnings.join(" ")).toMatch(/DISCOVERY: employee work-discovery/);
  });

  it("rejects an unparseable boolean rather than guessing", () => {
    expect(() => loadConfig({ PV_DISCOVERY_ENABLED: "maybe" })).toThrow(ConfigError);
  });

  it("rejects a negative ceiling", () => {
    expect(() => loadConfig({ PV_MODEL_CALLS_PER_MINUTE: "-1" })).toThrow(ConfigError);
  });

  it("names the offending environment variable in the error", () => {
    expect(() => loadConfig({ PV_HTTP_PORT: "not-a-port" })).toThrow(/PV_HTTP_PORT/);
  });

  it("parses a comma-separated egress allowlist", () => {
    const config = loadConfig({ PV_EGRESS_ALLOWLIST: "a.example.com, b.example.com" });
    expect(config.egressAllowlist).toEqual(["a.example.com", "b.example.com"]);
  });

  it("describes containment settings without printing any secret", () => {
    const described = describeConfig(loadConfig(productionBase));
    expect(described).toContain("sandbox");
    expect(described).not.toContain("secret");
    expect(described).not.toContain("pass@db");
  });
});

describe("errors", () => {
  it("carries a machine-readable reason", () => {
    const error = new DeniedError("approval.required", "needs approval", { runId: "run_1" });
    expect(error.reason).toBe("approval.required");
    expect(error.detail.runId).toBe("run_1");
    expect(isDenied(error)).toBe(true);
    expect(isDenied(new Error("plain"))).toBe(false);
  });

  it("treats a configuration failure as a denial", () => {
    expect(isDenied(new ConfigError("missing"))).toBe(true);
  });
});

describe("logger", () => {
  it("redacts secrets before they reach a sink", () => {
    const logger = new RecordingLogger();
    logger.info("calling provider", { apiKey: "sk-abcdefghijklmnopqrstuvwxyz" });
    expect(JSON.stringify(logger.lines)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("stamps child context onto every line", () => {
    const logger = new RecordingLogger();
    logger.child({ correlationId: "corr-1" }).info("step started");
    expect(logger.lines[0]?.context.correlationId).toBe("corr-1");
  });
});
