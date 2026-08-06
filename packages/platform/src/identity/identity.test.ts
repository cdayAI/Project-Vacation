import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type JWK,
} from "jose";
import { FixedClock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import { SeededIdGenerator, type Id } from "../kernel/ids.js";
import { RecordingLogger } from "../kernel/logger.js";
import { AuditLog } from "../audit/log.js";
import { MemoryAuditStore } from "../audit/store.memory.js";
import { MemoryDb } from "../store/db.js";
import { DevelopmentIdentityProvider } from "./dev-provider.js";
import { MIGRATIONS } from "./migrations.js";
import { OidcAuthenticator, safeReturnTo, type OidcTransport } from "./oidc.js";
import {
  DEFAULT_ROLE_MAPPING,
  assertMappingIsSound,
  grantsNothing,
  mapDirectoryGroups,
  type RoleMapping,
} from "./roles.js";
import { base64Url, pkceChallenge, type SecretGenerator } from "./secrets.js";
import { ServiceAccountService, parseCredential } from "./service-accounts.js";
import { SessionService, signSessionCookie, verifySessionCookie } from "./session.js";
import { MemoryIdentityStore, MemoryServiceAccountStore } from "./store.memory.js";
import {
  CAPABILITIES,
  CAPABILITY_NAMES,
  READ_ONLY_CAPABILITIES,
  ROLE_CAPABILITIES,
  ROLE_NAMES,
  SCOPE_ROLE_PREFIX,
  capabilitiesFor,
  toActorRef,
  type Actor,
  type VerifiedIdentity,
} from "./types.js";

/**
 * Identity tests.
 *
 * Weighted deliberately toward the refusals. An authentication module that
 * lets the right person in is table stakes; the interesting assertions are the
 * ones that prove it keeps the wrong person out when a check is skipped, a
 * token is replayed, a group name is crafted, a credential is revoked
 * mid-flight, or the store cannot answer.
 */

const T0 = "2026-08-06T12:00:00.000Z";
const ISSUER = "https://mvw.example.okta.com";
const CLIENT_ID = "pv-console";
const CLIENT_SECRET = "client-secret-not-a-real-one";
const REDIRECT_URI = "https://platform.mvw.example.com/auth/callback";
const SESSION_SECRET = "a".repeat(48);

/** A secret generator that counts up, so every value in a test is predictable. */
class ScriptedSecrets implements SecretGenerator {
  private counter = 0;
  bytes(count: number): Uint8Array {
    this.counter += 1;
    const out = new Uint8Array(count);
    out.fill(this.counter);
    return out;
  }
}

function discoveryFor(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth2/v1/authorize`,
    token_endpoint: `${ISSUER}/oauth2/v1/token`,
    jwks_uri: `${ISSUER}/oauth2/v1/keys`,
    code_challenge_methods_supported: ["S256"],
    ...overrides,
  };
}

interface RecordedPost {
  readonly url: string;
  readonly form: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
}

class FakeTransport implements OidcTransport {
  readonly posts: RecordedPost[] = [];
  getCount = 0;

  constructor(
    private readonly discovery: unknown,
    private tokenResponse: unknown,
  ) {}

  setTokenResponse(response: unknown): void {
    this.tokenResponse = response;
  }

  async getJson(): Promise<unknown> {
    this.getCount += 1;
    if (this.discovery instanceof Error) throw this.discovery;
    return this.discovery;
  }

  async postForm(
    url: string,
    form: Readonly<Record<string, string>>,
    headers: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    this.posts.push({ url, form, headers });
    if (this.tokenResponse instanceof Error) throw this.tokenResponse;
    return this.tokenResponse;
  }
}

interface Keys {
  readonly resolver: JWTVerifyGetKey;
  sign(claims: Record<string, unknown>, header?: Record<string, string>): Promise<string>;
}

async function makeKeys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = (await exportJWK(publicKey)) as JWK;
  const withMeta: JWK = { ...jwk, kid: "test-key", alg: "RS256", use: "sig" };
  const resolver = createLocalJWKSet({ keys: [withMeta] });
  return {
    resolver,
    async sign(claims, header = {}) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-key", ...header })
        .sign(privateKey);
    },
  };
}

interface Harness {
  readonly db: MemoryDb;
  readonly clock: FixedClock;
  readonly ids: SeededIdGenerator;
  readonly logger: RecordingLogger;
  readonly audit: AuditLog;
  readonly identityStore: MemoryIdentityStore;
  readonly serviceStore: MemoryServiceAccountStore;
  readonly secrets: ScriptedSecrets;
}

function harness(): Harness {
  const db = new MemoryDb();
  const clock = new FixedClock(T0);
  const ids = new SeededIdGenerator("identity-test");
  const logger = new RecordingLogger();
  return {
    db,
    clock,
    ids,
    logger,
    audit: new AuditLog(new MemoryAuditStore(db), clock, ids),
    identityStore: new MemoryIdentityStore(db),
    serviceStore: new MemoryServiceAccountStore(db),
    secrets: new ScriptedSecrets(),
  };
}

function baseClaims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSeconds = Math.floor(Date.parse(T0) / 1000);
  return {
    iss: ISSUER,
    sub: "00u-agent-1",
    aud: CLIENT_ID,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    groups: ["mvw-owner-services-agents"],
    amr: ["pwd", "mfa"],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Roles and capabilities
// ---------------------------------------------------------------------------

describe("role capabilities", () => {
  it("gives the auditor every read capability", () => {
    const auditor = new Set(ROLE_CAPABILITIES.auditor);
    const missing = READ_ONLY_CAPABILITIES.filter((capability) => !auditor.has(capability));
    expect(missing, "an auditor who cannot see part of the platform is a finding").toEqual([]);
  });

  it("gives the auditor no capability that changes anything", () => {
    const mutating = ROLE_CAPABILITIES.auditor.filter((name) => CAPABILITIES[name].mutates);
    expect(mutating, "the auditor role must not be able to alter what it audits").toEqual([]);
  });

  it("holds every capability some role can exercise", () => {
    const granted = new Set(Object.values(ROLE_CAPABILITIES).flat());
    const orphaned = CAPABILITY_NAMES.filter((name) => !granted.has(name));
    expect(orphaned, "a capability no role holds is dead configuration").toEqual([]);
  });

  it("declares a capability set for every role", () => {
    for (const role of ROLE_NAMES) {
      expect(ROLE_CAPABILITIES[role].length).toBeGreaterThan(0);
    }
  });

  it("unions capabilities across roles without duplicating them", () => {
    const both = capabilitiesFor(["owner_services_agent", "supervisor"]);
    expect(both).toEqual([...new Set(both)].sort());
    expect(both).toContain("work.approve");
    expect(both).toContain("record.read");
  });

  it("gives an unmapped person nothing", () => {
    expect(capabilitiesFor([])).toEqual([]);
  });
});

describe("directory group mapping", () => {
  it("maps a known group to its role", () => {
    const mapped = mapDirectoryGroups(["mvw-owner-services-agents"]);
    expect(mapped.roles).toEqual(["owner_services_agent"]);
    expect(mapped.matchedGroups).toEqual(["mvw-owner-services-agents"]);
  });

  it("matches regardless of case and surrounding whitespace", () => {
    const mapped = mapDirectoryGroups(["  MVW-Compliance-Reviewers "]);
    expect(mapped.roles).toEqual(["compliance_reviewer"]);
  });

  it("derives a per-association scope from a scope-family group", () => {
    const mapped = mapDirectoryGroups(["mvw-assoc-1042"]);
    expect(mapped.roles).toEqual(["association_manager"]);
    expect(mapped.scopes).toEqual(["association:1042"]);
  });

  it("refuses a crafted group name that would widen its own scope", () => {
    // A directory group named to smuggle a wildcard or a second scope through.
    const mapped = mapDirectoryGroups([
      "mvw-assoc-*",
      "mvw-assoc-1042:association:9999",
      "mvw-assoc-",
      "mvw-assoc-../platform_admin",
    ]);
    expect(mapped.scopes).toEqual([]);
    expect(mapped.roles).toEqual([]);
    expect(mapped.rejectedGroups.length).toBe(4);
  });

  it("refuses an absurdly long group name", () => {
    const mapped = mapDirectoryGroups([`mvw-assoc-${"9".repeat(400)}`]);
    expect(mapped.scopes).toEqual([]);
    expect(mapped.rejectedGroups.length).toBe(1);
  });

  it("grants nothing to someone whose groups were removed", () => {
    const mapped = mapDirectoryGroups([]);
    expect(grantsNothing(mapped)).toBe(true);
    expect(mapped.roles).toEqual([]);
  });

  it("reports groups nobody mapped rather than dropping them silently", () => {
    const mapped = mapDirectoryGroups(["mvw-some-new-team", "mvw-finance"]);
    expect(mapped.roles).toEqual(["finance"]);
    expect(mapped.unmappedGroups).toEqual(["mvw-some-new-team"]);
  });

  it("refuses a group claim that is not an array of strings", () => {
    expect(() => mapDirectoryGroups([42 as unknown as string])).toThrow(InvalidInputError);
    expect(() => mapDirectoryGroups("mvw-finance" as unknown as string[])).toThrow(
      InvalidInputError,
    );
  });

  it("produces scope entitlements in the form the authorizer reads", () => {
    const mapped = mapDirectoryGroups(["mvw-assoc-1042"]);
    const actorRef = toActorRef({
      id: "act_x" as Id<"actor">,
      kind: "human",
      roles: mapped.roles,
      scopes: mapped.scopes,
    });
    // Exactly the parsing guard/authorize.ts performs on ActorRef.roles.
    const held = new Set(
      actorRef.roles
        .filter((role) => role.startsWith(SCOPE_ROLE_PREFIX))
        .map((role) => role.slice(SCOPE_ROLE_PREFIX.length)),
    );
    expect(held.has("association:1042")).toBe(true);
    expect(actorRef.roles).toContain("association_manager");
  });
});

describe("role mapping validation", () => {
  it("accepts the shipped mapping", () => {
    expect(() => assertMappingIsSound(DEFAULT_ROLE_MAPPING)).not.toThrow();
  });

  it("refuses a mapping that names an unknown role", () => {
    const mapping: RoleMapping = {
      groupClaim: "groups",
      rules: [
        { group: "mvw-x", roles: ["complaince_reviewer" as never], note: "typo" },
      ],
      scopeRules: [],
    };
    expect(() => assertMappingIsSound(mapping)).toThrow(/unknown role/);
  });

  it("refuses a group mapped twice", () => {
    const mapping: RoleMapping = {
      groupClaim: "groups",
      rules: [
        { group: "mvw-x", roles: ["finance"], note: "one" },
        { group: "MVW-X", roles: ["platform_admin"], note: "two" },
      ],
      scopeRules: [],
    };
    expect(() => assertMappingIsSound(mapping)).toThrow(/mapped twice/);
  });

  it("refuses a scope rule with an empty prefix, which would match everything", () => {
    const mapping: RoleMapping = {
      groupClaim: "groups",
      rules: [],
      scopeRules: [{ prefix: "", scopeKind: "association", roles: [], note: "" }],
    };
    expect(() => assertMappingIsSound(mapping)).toThrow(/every group/);
  });

  it("refuses a mapping with no group claim named", () => {
    const mapping = { groupClaim: "", rules: [], scopeRules: [] } as RoleMapping;
    expect(() => assertMappingIsSound(mapping)).toThrow(DeniedError);
  });
});

// ---------------------------------------------------------------------------
// OIDC
// ---------------------------------------------------------------------------

function authenticator(
  h: Harness,
  transport: OidcTransport,
  keys?: JWTVerifyGetKey,
): OidcAuthenticator {
  return new OidcAuthenticator(
    {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    },
    h.identityStore,
    h.clock,
    h.secrets,
    transport,
    keys ? { keyResolver: keys } : {},
  );
}

describe("OIDC discovery", () => {
  it("refuses a document whose issuer is not the configured one", async () => {
    const h = harness();
    const transport = new FakeTransport(discoveryFor({ issuer: "https://evil.example" }), {});
    await expect(authenticator(h, transport).discover()).rejects.toMatchObject({
      detail: { check: "discovery_issuer_mismatch" },
    });
  });

  it("refuses a document that points the token endpoint at another host", async () => {
    const h = harness();
    const transport = new FakeTransport(
      discoveryFor({ token_endpoint: "https://evil.example/token" }),
      {},
    );
    await expect(authenticator(h, transport).discover()).rejects.toMatchObject({
      detail: { check: "discovery_endpoint_off_issuer" },
    });
  });

  it("refuses a plaintext endpoint", async () => {
    const h = harness();
    const transport = new FakeTransport(
      discoveryFor({ jwks_uri: `http://mvw.example.okta.com/keys` }),
      {},
    );
    await expect(authenticator(h, transport).discover()).rejects.toThrow(/HTTPS/);
  });

  it("refuses a provider that does not advertise PKCE S256 rather than downgrading", async () => {
    const h = harness();
    const transport = new FakeTransport(
      discoveryFor({ code_challenge_methods_supported: ["plain"] }),
      {},
    );
    await expect(authenticator(h, transport).discover()).rejects.toMatchObject({
      detail: { check: "pkce_unsupported" },
    });
  });

  it("refuses when the provider cannot be reached, rather than falling back", async () => {
    const h = harness();
    const transport = new FakeTransport(new Error("ECONNREFUSED"), {});
    await expect(authenticator(h, transport).discover()).rejects.toMatchObject({
      detail: { check: "discovery_unavailable" },
    });
  });

  it("caches the document instead of fetching it per sign-in", async () => {
    const h = harness();
    const transport = new FakeTransport(discoveryFor(), {});
    const auth = authenticator(h, transport);
    await auth.discover();
    await auth.discover();
    expect(transport.getCount).toBe(1);
  });

  it("refuses a configuration with a plaintext redirect URI", () => {
    const h = harness();
    expect(
      () =>
        new OidcAuthenticator(
          {
            issuer: ISSUER,
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            redirectUri: "http://localhost/auth/callback",
          },
          h.identityStore,
          h.clock,
          h.secrets,
          new FakeTransport(discoveryFor(), {}),
        ),
    ).toThrow(/HTTPS/);
  });

  it("refuses a configuration with no client secret", () => {
    const h = harness();
    expect(
      () =>
        new OidcAuthenticator(
          { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: "", redirectUri: REDIRECT_URI },
          h.identityStore,
          h.clock,
          h.secrets,
          new FakeTransport(discoveryFor(), {}),
        ),
    ).toThrow(/no local password store/);
  });
});

describe("OIDC authorization request", () => {
  it("sends PKCE S256 and keeps the verifier server-side", async () => {
    const h = harness();
    const transport = new FakeTransport(discoveryFor(), {});
    const started = await authenticator(h, transport).beginSignIn({ returnTo: "/runs" });

    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);

    const pending = await h.identityStore.consumeAuthorizationRequest(started.state);
    expect(pending).not.toBeNull();
    // The challenge on the wire is the hash; the verifier never left.
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(pending?.codeVerifier ?? ""));
    expect(started.authorizationUrl).not.toContain(pending?.codeVerifier ?? "no-verifier");
    expect(started.authorizationUrl).not.toContain(CLIENT_SECRET);
  });

  it("keeps only a local path as the post-sign-in destination", () => {
    expect(safeReturnTo("/runs/42")).toBe("/runs/42");
    expect(safeReturnTo("//evil.example/steal")).toBeUndefined();
    expect(safeReturnTo("https://evil.example")).toBeUndefined();
    expect(safeReturnTo("/runs\\..\\admin")).toBeUndefined();
    expect(safeReturnTo(undefined)).toBeUndefined();
  });
});

describe("OIDC callback", () => {
  async function completeWith(
    h: Harness,
    keys: Keys,
    claims: Record<string, unknown>,
    options: {
      readonly tamperState?: string;
      readonly callbackIssuer?: string;
      readonly signHeader?: Record<string, string>;
    } = {},
  ) {
    const transport = new FakeTransport(discoveryFor(), {});
    const auth = authenticator(h, transport, keys.resolver);
    const started = await auth.beginSignIn();
    const stored = await h.identityStore.consumeAuthorizationRequest(started.state);
    // Put it back: the flow consumes it itself.
    if (stored) await h.identityStore.putAuthorizationRequest(stored);

    const idToken = await keys.sign(
      { nonce: stored?.nonce, ...claims },
      options.signHeader ?? {},
    );
    transport.setTokenResponse({ token_type: "Bearer", id_token: idToken });

    return {
      transport,
      result: auth.completeSignIn({
        state: options.tamperState ?? started.state,
        code: "authorization-code",
        issuer: options.callbackIssuer,
      }),
    };
  }

  it("accepts a well-formed token and returns the asserted identity", async () => {
    const h = harness();
    const keys = await makeKeys();
    const { result } = await completeWith(h, keys, baseClaims());
    const completed = await result;
    expect(completed.identity.subject).toBe("00u-agent-1");
    expect(completed.identity.groups).toEqual(["mvw-owner-services-agents"]);
    expect(completed.identity.authenticationMethods).toEqual(["pwd", "mfa"]);
  });

  it("sends the client secret in a header, never in the form or the URL", async () => {
    const h = harness();
    const keys = await makeKeys();
    const { transport, result } = await completeWith(h, keys, baseClaims());
    await result;
    const post = transport.posts[0];
    expect(post).toBeDefined();
    expect(JSON.stringify(post?.form)).not.toContain(CLIENT_SECRET);
    expect(post?.url).not.toContain(CLIENT_SECRET);
    expect(post?.headers["authorization"]).toMatch(/^Basic /);
    expect(post?.form["code_verifier"]).toBeTruthy();
  });

  it("refuses a replayed callback, because state is single-use", async () => {
    const h = harness();
    const keys = await makeKeys();
    const transport = new FakeTransport(discoveryFor(), {});
    const auth = authenticator(h, transport, keys.resolver);
    const started = await auth.beginSignIn();
    const stored = await h.identityStore.consumeAuthorizationRequest(started.state);
    if (stored) await h.identityStore.putAuthorizationRequest(stored);
    const idToken = await keys.sign(baseClaims({ nonce: stored?.nonce }));
    transport.setTokenResponse({ token_type: "Bearer", id_token: idToken });

    await auth.completeSignIn({ state: started.state, code: "c1" });
    await expect(
      auth.completeSignIn({ state: started.state, code: "c1" }),
    ).rejects.toMatchObject({ detail: { check: "state_unknown" } });
  });

  it("refuses a callback whose state was never issued here", async () => {
    const h = harness();
    const keys = await makeKeys();
    const { result } = await completeWith(h, keys, baseClaims(), {
      tamperState: "state-i-made-up",
    });
    await expect(result).rejects.toMatchObject({ detail: { check: "state_unknown" } });
  });

  it("refuses an ID token bound to a different sign-in", async () => {
    const h = harness();
    const keys = await makeKeys();
    const { result } = await completeWith(h, keys, baseClaims({ nonce: "some-other-nonce" }));
    await expect(result).rejects.toMatchObject({ detail: { check: "nonce_mismatch" } });
  });

  it("refuses an expired token", async () => {
    const h = harness();
    const keys = await makeKeys();
    const past = Math.floor(Date.parse(T0) / 1000) - 3600;
    const { result } = await completeWith(h, keys, baseClaims({ iat: past, exp: past + 60 }));
    await expect(result).rejects.toMatchObject({ detail: { check: "token_invalid" } });
  });

  it("refuses a token minted for another client", async () => {
    const h = harness();
    const keys = await makeKeys();
    const { result } = await completeWith(h, keys, baseClaims({ aud: "some-other-app" }));
    await expect(result).rejects.toMatchObject({ detail: { check: "token_invalid" } });
  });

  it("refuses a token from another issuer", async () => {
    const h = harness();
    const keys = await makeKeys();
    const { result } = await completeWith(h, keys, baseClaims({ iss: "https://evil.example" }));
    await expect(result).rejects.toMatchObject({ detail: { check: "token_invalid" } });
  });

  it("refuses a multi-audience token issued to a different client", async () => {
    const h = harness();
    const keys = await makeKeys();
    const { result } = await completeWith(
      h,
      keys,
      baseClaims({ aud: [CLIENT_ID, "other"], azp: "other" }),
    );
    await expect(result).rejects.toMatchObject({ detail: { check: "azp_mismatch" } });
  });

  it("refuses an unsigned token", async () => {
    const h = harness();
    const keys = await makeKeys();
    const auth = authenticator(h, new FakeTransport(discoveryFor(), {}), keys.resolver);
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(baseClaims())).toString("base64url");
    await expect(auth.verifyIdToken(`${header}.${payload}.`, null)).rejects.toMatchObject({
      detail: { check: "token_invalid" },
    });
  });

  it("refuses an HMAC-signed token forged with the public key material", async () => {
    const h = harness();
    const keys = await makeKeys();
    const auth = authenticator(h, new FakeTransport(discoveryFor(), {}), keys.resolver);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", kid: "test-key" })).toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify(baseClaims())).toString("base64url");
    const signature = createHmac("sha256", "public-key-bytes")
      .update(`${header}.${payload}`)
      .digest("base64url");
    await expect(
      auth.verifyIdToken(`${header}.${payload}.${signature}`, null),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses a token with no subject", async () => {
    const h = harness();
    const keys = await makeKeys();
    const claims = baseClaims();
    delete claims["sub"];
    const { result } = await completeWith(h, keys, claims);
    // jose enforces the required claim first; either way it is a refusal.
    await expect(result).rejects.toBeInstanceOf(DeniedError);
  });

  it("refuses a callback naming a different issuer", async () => {
    const h = harness();
    const keys = await makeKeys();
    const { result } = await completeWith(h, keys, baseClaims(), {
      callbackIssuer: "https://evil.example",
    });
    await expect(result).rejects.toMatchObject({ detail: { check: "issuer_parameter_mismatch" } });
  });

  it("refuses a token response with no id_token", async () => {
    const h = harness();
    const keys = await makeKeys();
    const transport = new FakeTransport(discoveryFor(), { access_token: "at", token_type: "Bearer" });
    const auth = authenticator(h, transport, keys.resolver);
    const started = await auth.beginSignIn();
    await expect(
      auth.completeSignIn({ state: started.state, code: "c" }),
    ).rejects.toMatchObject({ detail: { check: "id_token_missing" } });
  });

  it("refuses when the provider returns an error on the callback", async () => {
    const h = harness();
    const auth = authenticator(h, new FakeTransport(discoveryFor(), {}));
    await expect(
      auth.completeSignIn({ state: "s", code: "c", error: "access_denied" }),
    ).rejects.toMatchObject({ detail: { check: "provider_error" } });
  });

  it("refuses a token with no group claim rather than reading it as no groups", async () => {
    const h = harness();
    const keys = await makeKeys();
    const claims = baseClaims();
    delete claims["groups"];
    const { result } = await completeWith(h, keys, claims);
    await expect(result).rejects.toMatchObject({ detail: { check: "group_claim_absent" } });
  });

  it("refuses an Entra group-overage token rather than deprovisioning everyone", async () => {
    const h = harness();
    const keys = await makeKeys();
    const claims = baseClaims();
    delete claims["groups"];
    claims["_claim_names"] = { groups: "src1" };
    claims["_claim_sources"] = { src1: { endpoint: "https://graph.microsoft.com/..." } };
    const { result } = await completeWith(h, keys, claims);
    await expect(result).rejects.toMatchObject({ detail: { check: "group_claim_overage" } });
  });

  it("refuses a group claim that is not an array", async () => {
    const h = harness();
    const keys = await makeKeys();
    const { result } = await completeWith(h, keys, baseClaims({ groups: "mvw-platform-admins" }));
    await expect(result).rejects.toMatchObject({ detail: { check: "group_claim_malformed" } });
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sessions(h: Harness, options: { readonly sessionTtlMs?: number } = {}): SessionService {
  return new SessionService(h.identityStore, h.clock, h.ids, h.audit, SESSION_SECRET, {
    ...options,
    secureCookie: true,
  });
}

function identity(subject = "00u-agent-1"): VerifiedIdentity {
  return {
    issuer: ISSUER,
    subject,
    groups: ["mvw-owner-services-agents"],
    authenticationMethods: ["pwd", "mfa"],
    claimsDigest: digestValue({ iss: ISSUER, sub: subject }),
  };
}

describe("session cookies", () => {
  it("round-trips a signed cookie", () => {
    const payload = { sid: "ses_1", aid: "act_1", iat: 1, exp: 2 };
    const cookie = signSessionCookie(payload, SESSION_SECRET);
    expect(verifySessionCookie(cookie, SESSION_SECRET)).toEqual(payload);
  });

  it("rejects a cookie whose payload was edited", () => {
    const cookie = signSessionCookie({ sid: "ses_1", aid: "act_1", iat: 1, exp: 2 }, SESSION_SECRET);
    const [version, body, tag] = cookie.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sid: "ses_someone_else", aid: "act_1", iat: 1, exp: 2 }),
      "utf8",
    ).toString("base64url");
    expect(verifySessionCookie(`${version}.${forged}.${tag}`, SESSION_SECRET)).toBeNull();
    expect(verifySessionCookie(`${version}.${body}.${tag}x`, SESSION_SECRET)).toBeNull();
  });

  it("rejects a cookie signed with another key", () => {
    const cookie = signSessionCookie({ sid: "s", aid: "a", iat: 1, exp: 2 }, "b".repeat(48));
    expect(verifySessionCookie(cookie, SESSION_SECRET)).toBeNull();
  });

  it("rejects malformed cookies without throwing", () => {
    expect(verifySessionCookie(undefined, SESSION_SECRET)).toBeNull();
    expect(verifySessionCookie("", SESSION_SECRET)).toBeNull();
    expect(verifySessionCookie("garbage", SESSION_SECRET)).toBeNull();
    expect(verifySessionCookie("v2.a.b", SESSION_SECRET)).toBeNull();
    expect(verifySessionCookie("x".repeat(9000), SESSION_SECRET)).toBeNull();
  });

  it("refuses to construct a service with a weak signing key", () => {
    const h = harness();
    expect(
      () => new SessionService(h.identityStore, h.clock, h.ids, h.audit, "short"),
    ).toThrow(/at least 32/);
  });
});

describe("sign-in", () => {
  it("opens a session, records the audit event, and marks the cookie httpOnly and Secure", async () => {
    const h = harness();
    const service = sessions(h);
    const issued = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(identity().groups),
    });

    expect(issued.session.roles).toEqual(["owner_services_agent"]);
    expect(issued.cookieAttributes).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });

    const entries = await h.audit.list({ eventType: ["identity.session_started"] });
    expect(entries.length).toBe(1);
    expect(entries[0]?.subject["sessionId"]).toBe(issued.session.id);
    // Fingerprints, not claims.
    expect(entries[0]?.inputDigests["claims"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("puts no entitlements in the cookie", async () => {
    const h = harness();
    const issued = await sessions(h).start({
      identity: identity(),
      entitlements: mapDirectoryGroups(["mvw-platform-admins"]),
    });
    const payload = verifySessionCookie(issued.cookie, SESSION_SECRET);
    expect(Object.keys(payload ?? {}).sort()).toEqual(["aid", "exp", "iat", "sid"]);
    expect(issued.cookie).not.toContain("platform_admin");
  });

  it("issues a fresh session id on every sign-in", async () => {
    const h = harness();
    const service = sessions(h);
    const first = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(identity().groups),
    });
    const second = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(identity().groups),
    });
    expect(second.session.id).not.toBe(first.session.id);
    // ...and the same actor, so a year of audit entries names one subject.
    expect(second.actor.id).toBe(first.actor.id);
  });

  it("refuses someone whose directory groups map to nothing, and kills their sessions", async () => {
    const h = harness();
    const service = sessions(h);
    const live = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(["mvw-owner-services-agents"]),
    });

    await expect(
      service.start({ identity: identity(), entitlements: mapDirectoryGroups([]) }),
    ).rejects.toMatchObject({ detail: { check: "no_entitlements" } });

    // The open tab stops working too, not only the next sign-in.
    await expect(service.resolve(live.cookie)).rejects.toMatchObject({
      detail: { check: "session_revoked" },
    });
  });

  it("refuses a session whose actor was deprovisioned out from under it", async () => {
    const h = harness();
    const service = sessions(h);
    const issued = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(identity().groups),
    });

    // Deprovisioned without touching the session, which is what a directory
    // sync would do. Entitlements are re-read on every request, so the live
    // session stops working regardless.
    await h.identityStore.setActorStatus(issued.actor.id, "deprovisioned", h.clock.nowIso());

    await expect(service.resolve(issued.cookie)).rejects.toMatchObject({
      detail: { check: "actor_deprovisioned" },
    });
  });

  it("replaces entitlements rather than merging them, so a removed group loses access", async () => {
    const h = harness();
    const service = sessions(h);
    await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(["mvw-platform-admins", "mvw-finance"]),
    });
    const second = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(["mvw-finance"]),
    });
    expect(second.actor.roles).toEqual(["finance"]);
  });
});

describe("session resolution", () => {
  it("resolves a live session to its actor", async () => {
    const h = harness();
    const service = sessions(h);
    const issued = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(identity().groups),
    });
    const resolved = await service.resolve(issued.cookie);
    expect(resolved.actor.id).toBe(issued.actor.id);
    expect(resolved.actorRef.roles).toContain("owner_services_agent");
    expect(resolved.secondsSinceAuthentication).toBe(0);
  });

  it("refuses when no cookie is presented", async () => {
    const h = harness();
    await expect(sessions(h).resolve(undefined)).rejects.toMatchObject({
      detail: { check: "cookie_invalid" },
    });
  });

  it("refuses a revoked session immediately", async () => {
    const h = harness();
    const service = sessions(h);
    const issued = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(identity().groups),
    });
    await service.revoke(issued.session.id, "incident");
    await expect(service.resolve(issued.cookie)).rejects.toMatchObject({
      detail: { check: "session_revoked" },
    });
  });

  it("refuses once the session has expired, even with a cookie that has not", async () => {
    const h = harness();
    const service = sessions(h, { sessionTtlMs: 60_000 });
    const issued = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(identity().groups),
    });
    // Forge a cookie with a far-future expiry over the real session id: the
    // store, not the cookie, decides whether a session is still live.
    const forged = signSessionCookie(
      { sid: issued.session.id, aid: issued.actor.id, iat: 0, exp: 4_102_444_800 },
      SESSION_SECRET,
    );
    h.clock.advance(120_000);
    await expect(service.resolve(forged)).rejects.toMatchObject({
      detail: { check: "session_expired" },
    });
  });

  it("refuses a cookie pointed at another actor's session", async () => {
    const h = harness();
    const service = sessions(h);
    const issued = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(identity().groups),
    });
    const swapped = signSessionCookie(
      { sid: issued.session.id, aid: "act_someone_else", iat: 0, exp: 4_102_444_800 },
      SESSION_SECRET,
    );
    await expect(service.resolve(swapped)).rejects.toMatchObject({
      detail: { check: "session_actor_mismatch" },
    });
  });

  it("fails closed when the session store cannot answer", async () => {
    const h = harness();
    const service = sessions(h);
    const issued = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(identity().groups),
    });

    // A store that cannot answer must not read as "no such session", which
    // would land on a sign-in prompt and look like an expiry.
    const unreachable = new Proxy(h.identityStore, {
      get(target, property, receiver) {
        if (property === "getSession") {
          return () => Promise.reject(new Error("connection reset"));
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const broken = new SessionService(unreachable, h.clock, h.ids, h.audit, SESSION_SECRET);
    await expect(broken.resolve(issued.cookie)).rejects.toThrow(/connection reset/);
  });
});

describe("step-up re-authentication", () => {
  it("stamps the time the chokepoint reads and records the event", async () => {
    const h = harness();
    const service = sessions(h);
    const issued = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(identity().groups),
    });

    h.clock.advance(20 * 60 * 1000);
    const stale = await service.resolve(issued.cookie);
    expect(stale.secondsSinceAuthentication).toBe(1200);

    const stepped = await service.stepUp({ sessionId: issued.session.id, identity: identity() });
    expect(stepped.secondsSinceAuthentication).toBe(0);

    const entries = await h.audit.list({ eventType: ["identity.step_up_completed"] });
    expect(entries.length).toBe(1);
    expect(entries[0]?.subject["sessionId"]).toBe(issued.session.id);
  });

  it("refuses a step-up performed by somebody else", async () => {
    const h = harness();
    const service = sessions(h);
    const issued = await service.start({
      identity: identity("00u-agent-1"),
      entitlements: mapDirectoryGroups(identity().groups),
    });
    await expect(
      service.stepUp({ sessionId: issued.session.id, identity: identity("00u-someone-else") }),
    ).rejects.toMatchObject({ detail: { check: "step_up_subject_mismatch" } });
  });

  it("refuses a step-up on a revoked session", async () => {
    const h = harness();
    const service = sessions(h);
    const issued = await service.start({
      identity: identity(),
      entitlements: mapDirectoryGroups(identity().groups),
    });
    await service.revoke(issued.session.id, "locked out");
    await expect(
      service.stepUp({ sessionId: issued.session.id, identity: identity() }),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("treats a future-dated authentication stamp as zero rather than as negative", async () => {
    const h = harness();
    const service = sessions(h);
    const issued = await service.start({
      identity: { ...identity(), authenticatedAt: "2027-01-01T00:00:00.000Z" },
      entitlements: mapDirectoryGroups(identity().groups),
    });
    const resolved = await service.resolve(issued.cookie);
    expect(resolved.secondsSinceAuthentication).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Development identity provider
// ---------------------------------------------------------------------------

describe("development identity provider", () => {
  it("refuses to exist outside development", () => {
    const h = harness();
    for (const environment of ["production", "staging", "test"] as const) {
      expect(
        () => new DevelopmentIdentityProvider(environment, h.clock, h.logger),
        `${environment} must not be able to construct a password-free identity provider`,
      ).toThrow(DeniedError);
    }
  });

  it("warns loudly when it is constructed in development", () => {
    const h = harness();
    new DevelopmentIdentityProvider("development", h.clock, h.logger);
    expect(h.logger.lines.some((line) => line.level === "warn")).toBe(true);
  });

  it("mints an identity that goes through the same mapping as a real one", () => {
    const h = harness();
    const provider = new DevelopmentIdentityProvider("development", h.clock, h.logger);
    const minted = provider.authenticate({
      subject: "dev:supervisor",
      groups: ["mvw-owner-services-supervisors"],
    });
    expect(mapDirectoryGroups(minted.groups).roles).toEqual(["supervisor"]);
    expect(minted.claimsDigest).toMatch(/^sha256:/);
  });

  it("warns on every issue, not only at startup", () => {
    const h = harness();
    const provider = new DevelopmentIdentityProvider("development", h.clock, h.logger);
    const before = h.logger.lines.length;
    provider.authenticate({ subject: "dev:agent", groups: [] });
    expect(h.logger.lines.length).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// Service accounts
// ---------------------------------------------------------------------------

function serviceAccounts(h: Harness): ServiceAccountService {
  return new ServiceAccountService(h.serviceStore, h.clock, h.ids, h.secrets, h.audit);
}

const ISSUE = {
  name: "rescission-batch",
  description: "Nightly rescission sweep.",
  roles: ["owner_services_agent"] as const,
  scopes: [] as const,
  issuedBy: "act_admin",
  lifetimeMs: 30 * 24 * 60 * 60 * 1000,
};

describe("service accounts", () => {
  it("issues a credential, stores only its digest, and authenticates it", async () => {
    const h = harness();
    const service = serviceAccounts(h);
    const issued = await service.issue({ ...ISSUE, roles: [...ISSUE.roles], scopes: [] });

    const stored = await h.serviceStore.getServiceAccount(issued.account.id);
    expect(stored?.credentialDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(issued.credential);

    const authenticated = await service.authenticate(issued.credential);
    expect(authenticated.actorRef.kind).toBe("service");
    expect(authenticated.actorRef.roles).toContain("owner_services_agent");
  });

  it("never writes the credential into the audit chain", async () => {
    const h = harness();
    const issued = await serviceAccounts(h).issue({
      ...ISSUE,
      roles: [...ISSUE.roles],
      scopes: [],
    });
    const chain = await h.audit.readChain();
    expect(chain.length).toBeGreaterThan(0);
    expect(JSON.stringify(chain)).not.toContain(issued.credential);
    // Not even the verifier: a digest in a seven-year record outlives the
    // credential it verifies.
    expect(JSON.stringify(chain)).not.toContain(issued.account.credentialDigest);
  });

  it("revokes immediately, with no window where the credential still works", async () => {
    const h = harness();
    const service = serviceAccounts(h);
    const issued = await service.issue({ ...ISSUE, roles: [...ISSUE.roles], scopes: [] });
    await service.authenticate(issued.credential);

    await service.revoke({ id: issued.account.id, revokedBy: "act_admin", reason: "leaked" });

    await expect(service.authenticate(issued.credential)).rejects.toMatchObject({
      detail: { check: "credential_revoked" },
    });
  });

  it("revokes one credential without touching another", async () => {
    const h = harness();
    const service = serviceAccounts(h);
    const first = await service.issue({ ...ISSUE, roles: [...ISSUE.roles], scopes: [] });
    const second = await service.issue({
      ...ISSUE,
      name: "association-packs",
      roles: ["association_manager"],
      scopes: ["association:1042"],
    });

    await service.revoke({ id: first.account.id, revokedBy: "act_admin", reason: "rotation" });

    await expect(service.authenticate(first.credential)).rejects.toBeInstanceOf(DeniedError);
    const still = await service.authenticate(second.credential);
    expect(still.actorRef.roles).toContain(`${SCOPE_ROLE_PREFIX}association:1042`);
  });

  it("treats a repeated revocation as success rather than as a failure", async () => {
    const h = harness();
    const service = serviceAccounts(h);
    const issued = await service.issue({ ...ISSUE, roles: [...ISSUE.roles], scopes: [] });
    await service.revoke({ id: issued.account.id, revokedBy: "act_admin", reason: "leaked" });
    const again = await service.revoke({
      id: issued.account.id,
      revokedBy: "act_admin",
      reason: "leaked",
    });
    expect(again.revokedAt).toBeTruthy();
  });

  it("refuses an expired credential", async () => {
    const h = harness();
    const service = serviceAccounts(h);
    const issued = await service.issue({
      ...ISSUE,
      roles: [...ISSUE.roles],
      scopes: [],
      lifetimeMs: 60_000,
    });
    h.clock.advance(120_000);
    await expect(service.authenticate(issued.credential)).rejects.toMatchObject({
      detail: { check: "credential_expired" },
    });
  });

  it("refuses a credential with the right prefix and the wrong secret", async () => {
    const h = harness();
    const service = serviceAccounts(h);
    const issued = await service.issue({ ...ISSUE, roles: [...ISSUE.roles], scopes: [] });
    const parsed = parseCredential(issued.credential);
    const forged = `pvsa_${parsed?.prefix}_${"z".repeat(43)}`;
    await expect(service.authenticate(forged)).rejects.toMatchObject({
      detail: { check: "credential_mismatch" },
    });
  });

  it("refuses malformed credentials without reaching the store", async () => {
    const h = harness();
    const service = serviceAccounts(h);
    for (const bad of ["", "pvsa_short_x", "not-a-credential", "pvsa_a_b_c", "x".repeat(400)]) {
      await expect(service.authenticate(bad)).rejects.toBeInstanceOf(DeniedError);
    }
  });

  it("refuses a credential that would outlive rotation", async () => {
    const h = harness();
    await expect(
      serviceAccounts(h).issue({
        ...ISSUE,
        roles: [...ISSUE.roles],
        scopes: [],
        lifetimeMs: 10 * 365 * 24 * 60 * 60 * 1000,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("refuses a credential that grants nothing", async () => {
    const h = harness();
    await expect(
      serviceAccounts(h).issue({ ...ISSUE, roles: [], scopes: [] }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("refuses a name that would be unreadable in an audit trail", async () => {
    const h = harness();
    await expect(
      serviceAccounts(h).issue({ ...ISSUE, name: "A B", roles: [...ISSUE.roles], scopes: [] }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("refuses to reuse a service account name", async () => {
    const h = harness();
    const service = serviceAccounts(h);
    await service.issue({ ...ISSUE, roles: [...ISSUE.roles], scopes: [] });
    await expect(
      service.issue({ ...ISSUE, roles: [...ISSUE.roles], scopes: [] }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// Store behaviour under concurrency, and the schema's own promises
// ---------------------------------------------------------------------------

describe("identity store", () => {
  it("hands a single-use authorization state to exactly one of many callers", async () => {
    const h = harness();
    await h.identityStore.putAuthorizationRequest({
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      redirectUri: REDIRECT_URI,
      createdAt: T0,
      expiresAt: "2026-08-06T12:10:00.000Z",
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => h.identityStore.consumeAuthorizationRequest("state-1")),
    );
    expect(results.filter((entry) => entry !== null).length).toBe(1);
  });

  it("converges on one actor when the same person signs in twice at once", async () => {
    const h = harness();
    const subjectDigest = digestValue({ issuer: ISSUER, subject: "00u-racer" });
    const base = {
      kind: "human" as const,
      subjectDigest,
      issuer: ISSUER,
      roles: ["finance" as const],
      scopes: [],
      directoryGroups: ["mvw-finance"],
      status: "active" as const,
      seenAt: T0,
    };
    const [left, right] = await Promise.all([
      h.identityStore.upsertActor({ ...base, id: "act_left" as Id<"actor"> }),
      h.identityStore.upsertActor({ ...base, id: "act_right" as Id<"actor"> }),
    ]);
    expect(left.id).toBe(right.id);
    expect((await h.identityStore.listActors()).length).toBe(1);
  });

  it("lets exactly one caller revoke a service account", async () => {
    const h = harness();
    const issued = await serviceAccounts(h).issue({
      ...ISSUE,
      roles: [...ISSUE.roles],
      scopes: [],
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.serviceStore.revokeServiceAccount(issued.account.id, T0, "act_admin", "race"),
      ),
    );
    expect(results.filter((entry) => entry !== null).length).toBe(1);
  });

  it("refuses a timestamp that is not in the platform's wire form", async () => {
    const h = harness();
    await expect(
      h.identityStore.putAuthorizationRequest({
        state: "s",
        nonce: "n",
        codeVerifier: "v",
        redirectUri: REDIRECT_URI,
        createdAt: "2026-08-06T12:00:00Z",
        expiresAt: T0,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("purges expired authorization requests", async () => {
    const h = harness();
    await h.identityStore.putAuthorizationRequest({
      state: "old",
      nonce: "n",
      codeVerifier: "v",
      redirectUri: REDIRECT_URI,
      createdAt: T0,
      expiresAt: "2026-08-06T12:05:00.000Z",
    });
    expect(await h.identityStore.purgeExpiredAuthorizationRequests("2026-08-06T12:06:00.000Z")).toBe(
      1,
    );
    expect(await h.identityStore.consumeAuthorizationRequest("old")).toBeNull();
  });

  it("cannot open a session for an actor that does not exist", async () => {
    const h = harness();
    await expect(
      h.identityStore.createSession({
        id: "ses_orphan" as Id<"session">,
        actorId: "act_nobody" as Id<"actor">,
        issuedAt: T0,
        expiresAt: T0,
        authenticatedAt: T0,
        authenticationMethods: [],
        roles: [],
        scopes: [],
      }),
    ).rejects.toBeInstanceOf(DeniedError);
  });

  it("hands out clones, so a caller cannot edit stored state through a reference", async () => {
    const h = harness();
    const actor = await h.identityStore.upsertActor({
      id: "act_clone" as Id<"actor">,
      kind: "human",
      subjectDigest: digestValue({ issuer: ISSUER, subject: "clone" }),
      issuer: ISSUER,
      roles: ["finance"],
      scopes: [],
      directoryGroups: [],
      status: "active",
      seenAt: T0,
    });
    (actor as { status: string }).status = "active-forever";
    const reread = await h.identityStore.getActor(actor.id);
    expect(reread?.status).toBe("active");
  });
});

describe("identity schema", () => {
  it("uses the assigned migration id", () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toEqual(["0008_identity"]);
  });

  it("has nowhere to store a password", () => {
    const sql = MIGRATIONS.map((migration) => migration.sql).join("\n").toLowerCase();
    for (const forbidden of ["password", "passwd", "password_hash", "reset_token", "totp_secret"]) {
      expect(sql, `identity schema must not contain a ${forbidden} column`).not.toContain(forbidden);
    }
  });

  it("constrains the credential column to a digest", () => {
    const sql = MIGRATIONS.map((migration) => migration.sql).join("\n");
    expect(sql).toContain("identity_service_account_digest_shape");
  });
});

describe("actor references", () => {
  it("renders scopes in the form the authorizer reads", () => {
    const actor: Pick<Actor, "id" | "kind" | "roles" | "scopes"> = {
      id: "act_1" as Id<"actor">,
      kind: "human",
      roles: ["association_manager"],
      scopes: ["association:1042", "association:2087"],
    };
    expect(toActorRef(actor).roles).toEqual([
      "association_manager",
      "scope:association:1042",
      "scope:association:2087",
    ]);
  });

  it("produces a base64url token of the requested width", () => {
    const secrets = new ScriptedSecrets();
    expect(base64Url(secrets.bytes(32)).length).toBe(43);
  });
});
