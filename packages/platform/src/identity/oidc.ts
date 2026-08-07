import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Clock } from "../kernel/clock.js";
import { ConfigError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import type { Logger } from "../kernel/logger.js";
import { identityRefusal } from "./denials.js";
import type { IdentityStore } from "./port.js";
import { pkceChallenge, randomToken, secretsEqual, type SecretGenerator } from "./secrets.js";
import type { AuthorizationRequest, VerifiedIdentity } from "./types.js";

/**
 * Single sign-on against MVW's identity provider, over OIDC.
 *
 * **Confirm the provider with MVW.** This is written against the OIDC
 * authorization-code flow with PKCE as Okta and Microsoft Entra ID both
 * implement it, using discovery so that neither provider's endpoint URLs are
 * hard-coded. It has not been tested against MVW's tenant. The two things
 * likeliest to differ are the claim that carries directory groups (see
 * `roles.ts`) and whether the deployment is registered as a confidential
 * client with a secret or a public client relying on PKCE alone. Both are
 * configuration; neither is an assumption baked into the code.
 *
 * There is no local password store. There is no "break-glass" local account.
 * If the identity provider is unreachable, nobody signs in — which is a real
 * operational consequence, and the right one: an authentication path that
 * survives the directory being down is an authentication path that survives
 * the directory revoking someone.
 *
 * Every check below refuses rather than warns. In order:
 *
 *   discovery       The document's own `issuer` must equal the configured
 *                   issuer, and every endpoint must be HTTPS on the issuer's
 *                   host. A discovery document that can point the token
 *                   endpoint somewhere else can collect our client secret.
 *   state           Single-use, consumed atomically. Defends the callback
 *                   against cross-site request forgery and against replay.
 *   PKCE            The code verifier never leaves this process, so an
 *                   authorization code observed in transit or in a log cannot
 *                   be exchanged by whoever observed it.
 *   iss parameter   When the provider returns one (RFC 9207) it must match, so
 *                   a callback from a second, hostile issuer is refused.
 *   signature       Verified against the issuer's JWKS with an explicit
 *                   algorithm allowlist. `alg: none` and any HMAC algorithm are
 *                   refused: an HS256 token verified against a public key that
 *                   an attacker also has is a forged token that validates.
 *   issuer/audience Exact match on both. A token minted for another client is
 *                   not a token for us.
 *   expiry          `exp`, `iat`, and `nbf`, with a bounded skew tolerance.
 *   nonce           Compared constant-time against the value stored with the
 *                   authorization request, binding this token to this sign-in.
 *   groups          The group claim must be present. An absent claim is a
 *                   provider misconfiguration, not an assertion that the
 *                   person is in no groups, and treating it as the latter
 *                   would silently deprovision an entire directory.
 */

/**
 * Every refusal below names its failed check in `detail.check`; see
 * `denials.ts` for why identity adds no denial reasons of its own.
 * Configuration problems are the exception and raise `ConfigError`, because
 * they are startup failures rather than someone being turned away.
 */
const refuse = identityRefusal;

export interface OidcSettings {
  /** The issuer identifier, exactly as the provider publishes it. */
  readonly issuer: string;
  readonly clientId: string;
  /** Sent as HTTP Basic credentials, never in a URL, a body, or a log. */
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  /**
   * Tolerance for clock drift between us and the provider.
   *
   * Small on purpose. A generous tolerance extends the life of every token
   * that has just expired, which is the opposite of what expiry is for.
   */
  readonly clockToleranceSeconds?: number;
  /** How long a started sign-in may sit unfinished. */
  readonly authorizationRequestTtlMs?: number;
  readonly discoveryCacheTtlMs?: number;
  readonly httpTimeoutMs?: number;
  /** The ID-token claim carrying directory groups. Must match the role mapping. */
  readonly groupClaim?: string;
}

const DEFAULTS = {
  scopes: ["openid", "profile", "groups"] as readonly string[],
  clockToleranceSeconds: 60,
  authorizationRequestTtlMs: 10 * 60 * 1000,
  discoveryCacheTtlMs: 60 * 60 * 1000,
  httpTimeoutMs: 10_000,
  groupClaim: "groups",
} as const;

/** Signature algorithms accepted on an ID token. Asymmetric only. */
const ACCEPTED_ALGORITHMS: readonly string[] = ["RS256", "RS384", "RS512", "PS256", "ES256", "ES384"];

export interface DiscoveryDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly end_session_endpoint?: string;
  readonly code_challenge_methods_supported?: readonly string[];
  readonly response_types_supported?: readonly string[];
}

/**
 * The narrow HTTP surface OIDC needs.
 *
 * Injected so the whole flow is testable with no network and no local IdP, and
 * so that the one place the client secret is transmitted is visible in a
 * fifteen-line interface rather than buried in a `fetch` call.
 */
export interface OidcTransport {
  getJson(url: string, timeoutMs: number): Promise<unknown>;
  postForm(
    url: string,
    form: Readonly<Record<string, string>>,
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<unknown>;
}

export class FetchOidcTransport implements OidcTransport {
  async getJson(url: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
        // No automatic redirect following, for the same reason
        // `integrations/egress.ts` refuses it: a redirect sends this request to
        // a host nothing here vetted, and the body that comes back is parsed as
        // the discovery document or the key set. A redirect is surfaced as a
        // non-ok status below rather than followed.
        redirect: "manual",
      });
      if (!response.ok) {
        throw new Error(`${url} returned HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async postForm(
    url: string,
    form: Readonly<Record<string, string>>,
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
        // This body carries the client secret. A 307 or 308 is re-sent verbatim
        // to the redirect target, so following one would hand the secret to
        // whatever host the provider's response named.
        redirect: "manual",
      });
      if (!response.ok) {
        // The provider's error body can contain the code and the client id.
        // Only the status is surfaced; the body never reaches a log.
        throw new Error(`${url} returned HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface BeginSignInResult {
  /** Where to send the browser. */
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt: string;
}

export interface CompleteSignInInput {
  readonly state: string;
  readonly code: string;
  /** The `iss` callback parameter, when the provider sends one (RFC 9207). */
  readonly issuer?: string | undefined;
  /** The `error` callback parameter. Its presence alone refuses the sign-in. */
  readonly error?: string | undefined;
}

export interface CompletedSignIn {
  readonly identity: VerifiedIdentity;
  readonly returnTo?: string | undefined;
}

export interface OidcAuthenticatorOptions {
  /**
   * Key resolver override.
   *
   * Production leaves this unset and the JWKS is fetched from the discovery
   * document's `jwks_uri` with jose's own caching and rotation handling. Tests
   * pass a local key set.
   */
  readonly keyResolver?: JWTVerifyGetKey;
  readonly logger?: Logger;
}

export class OidcAuthenticator {
  private readonly settings: Required<
    Pick<
      OidcSettings,
      | "issuer"
      | "clientId"
      | "clientSecret"
      | "redirectUri"
      | "scopes"
      | "clockToleranceSeconds"
      | "authorizationRequestTtlMs"
      | "discoveryCacheTtlMs"
      | "httpTimeoutMs"
      | "groupClaim"
    >
  >;
  private discovery: { document: DiscoveryDocument; readAt: number } | null = null;
  private keys: JWTVerifyGetKey | null;

  constructor(
    settings: OidcSettings,
    private readonly store: IdentityStore,
    private readonly clock: Clock,
    private readonly secrets: SecretGenerator,
    private readonly transport: OidcTransport,
    options: OidcAuthenticatorOptions = {},
  ) {
    for (const [field, value] of Object.entries({
      issuer: settings.issuer,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      redirectUri: settings.redirectUri,
    })) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new ConfigError(
          `Single sign-on requires ${field}. There is no local password store to fall back to.`,
          { field },
        );
      }
    }
    assertHttpsUrl("issuer", settings.issuer);
    // The redirect URI is registered with the provider and is where an
    // authorization code lands. A plaintext one puts codes on the wire.
    assertHttpsUrl("redirectUri", settings.redirectUri);

    this.settings = {
      issuer: stripTrailingSlash(settings.issuer),
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      redirectUri: settings.redirectUri,
      scopes: settings.scopes ?? DEFAULTS.scopes,
      clockToleranceSeconds: settings.clockToleranceSeconds ?? DEFAULTS.clockToleranceSeconds,
      authorizationRequestTtlMs:
        settings.authorizationRequestTtlMs ?? DEFAULTS.authorizationRequestTtlMs,
      discoveryCacheTtlMs: settings.discoveryCacheTtlMs ?? DEFAULTS.discoveryCacheTtlMs,
      httpTimeoutMs: settings.httpTimeoutMs ?? DEFAULTS.httpTimeoutMs,
      groupClaim: settings.groupClaim ?? DEFAULTS.groupClaim,
    };
    this.keys = options.keyResolver ?? null;
  }

  /** The claim this authenticator reads groups from. Must match the role mapping. */
  get groupClaim(): string {
    return this.settings.groupClaim;
  }

  get issuer(): string {
    return this.settings.issuer;
  }

  /**
   * Fetch and validate the provider's discovery document.
   *
   * Cached for `discoveryCacheTtlMs`, because it changes rarely and a fetch on
   * every sign-in makes the provider's availability a per-request dependency.
   */
  async discover(): Promise<DiscoveryDocument> {
    const now = this.clock.now();
    const cached = this.discovery;
    if (cached && now - cached.readAt < this.settings.discoveryCacheTtlMs) return cached.document;

    const url = `${this.settings.issuer}/.well-known/openid-configuration`;
    let raw: unknown;
    try {
      raw = await this.transport.getJson(url, this.settings.httpTimeoutMs);
    } catch (error) {
      throw refuse(
        "discovery_unavailable",
        `The identity provider's discovery document could not be read, so nobody can sign in: ${error instanceof Error ? error.message : String(error)}`,
        { issuer: this.settings.issuer },
      );
    }

    const document = this.validateDiscovery(raw);
    this.discovery = { document, readAt: now };
    return document;
  }

  private validateDiscovery(raw: unknown): DiscoveryDocument {
    if (typeof raw !== "object" || raw === null) {
      throw refuse("discovery_malformed", "The discovery document was not a JSON object.", {});
    }
    const record = raw as Record<string, unknown>;
    const read = (field: string): string => {
      const value = record[field];
      if (typeof value !== "string" || value.length === 0) {
        throw refuse("discovery_malformed", `The discovery document has no ${field}.`, { field });
      }
      return value;
    };

    const issuer = read("issuer");
    // The mix-up defence. A document served from our issuer's well-known path
    // that names a different issuer is either a misconfiguration or an attack,
    // and in both cases continuing means trusting tokens from somewhere else.
    if (stripTrailingSlash(issuer) !== this.settings.issuer) {
      throw refuse(
        "discovery_issuer_mismatch",
        `The discovery document claims issuer "${issuer}" but was fetched from "${this.settings.issuer}".`,
        { declared: issuer, configured: this.settings.issuer },
      );
    }

    const authorizationEndpoint = read("authorization_endpoint");
    const tokenEndpoint = read("token_endpoint");
    const jwksUri = read("jwks_uri");

    // Every endpoint must live on the issuer's host over HTTPS. Without this,
    // a compromised or spoofed discovery document redirects the token exchange
    // — which carries the client secret and the authorization code — to an
    // attacker, and the flow would otherwise complete successfully.
    const issuerHost = new URL(this.settings.issuer).host;
    for (const [field, value] of [
      ["authorization_endpoint", authorizationEndpoint],
      ["token_endpoint", tokenEndpoint],
      ["jwks_uri", jwksUri],
    ] as const) {
      assertHttpsUrl(field, value);
      if (new URL(value).host !== issuerHost) {
        throw refuse(
          "discovery_endpoint_off_issuer",
          `The discovery document points ${field} at "${new URL(value).host}", which is not the issuer's host "${issuerHost}".`,
          { field, host: new URL(value).host },
        );
      }
    }

    const challengeMethods = record["code_challenge_methods_supported"];
    if (Array.isArray(challengeMethods) && !challengeMethods.includes("S256")) {
      // Refusing rather than downgrading. `plain` PKCE protects nothing
      // against an attacker who can read the authorization request.
      throw refuse(
        "pkce_unsupported",
        "The identity provider does not advertise PKCE S256. This platform will not fall back to a weaker method.",
        { issuer: this.settings.issuer },
      );
    }

    return {
      issuer,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      jwks_uri: jwksUri,
      ...(typeof record["end_session_endpoint"] === "string"
        ? { end_session_endpoint: record["end_session_endpoint"] }
        : {}),
    };
  }

  /**
   * Start a sign-in.
   *
   * Generates `state`, `nonce`, and a PKCE verifier, stores them server-side,
   * and returns the URL to send the browser to. The verifier is never sent to
   * the provider at this stage — only its S256 challenge — which is what makes
   * an intercepted authorization code unusable.
   */
  async beginSignIn(input: { readonly returnTo?: string } = {}): Promise<BeginSignInResult> {
    const document = await this.discover();

    const state = randomToken(this.secrets, 32);
    const nonce = randomToken(this.secrets, 32);
    const codeVerifier = randomToken(this.secrets, 32);
    const now = this.clock.now();

    const request: AuthorizationRequest = {
      state,
      nonce,
      codeVerifier,
      redirectUri: this.settings.redirectUri,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.settings.authorizationRequestTtlMs).toISOString(),
      returnTo: safeReturnTo(input.returnTo),
    };

    // Stored before the browser is sent anywhere. If this write fails the
    // sign-in never starts, rather than starting one we cannot later verify.
    await this.store.putAuthorizationRequest(request);

    const url = new URL(document.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.settings.clientId);
    url.searchParams.set("redirect_uri", this.settings.redirectUri);
    url.searchParams.set("scope", this.settings.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");

    return { authorizationUrl: url.toString(), state, expiresAt: request.expiresAt };
  }

  /**
   * Finish a sign-in.
   *
   * @throws {DeniedError} on any failed check. There is no partial success:
   *   a token that fails one check is not a weaker identity, it is not an
   *   identity.
   */
  async completeSignIn(input: CompleteSignInInput): Promise<CompletedSignIn> {
    if (input.error) {
      throw refuse("provider_error", `The identity provider refused the sign-in.`, {
        // The provider's error code is a fixed vocabulary, safe to surface.
        providerError: input.error.slice(0, 64),
      });
    }
    if (typeof input.state !== "string" || input.state.length === 0) {
      throw refuse("state_missing", "The callback carried no state parameter.", {});
    }
    if (typeof input.code !== "string" || input.code.length === 0) {
      throw refuse("code_missing", "The callback carried no authorization code.", {});
    }
    if (input.issuer !== undefined && stripTrailingSlash(input.issuer) !== this.settings.issuer) {
      throw refuse(
        "issuer_parameter_mismatch",
        `The callback names issuer "${input.issuer}", which is not the configured issuer.`,
        {},
      );
    }

    // Single-use, atomically. A replayed callback finds nothing and is refused.
    const pending = await this.store.consumeAuthorizationRequest(input.state);
    if (!pending) {
      throw refuse(
        "state_unknown",
        "This sign-in was not started here, has already been completed, or has expired.",
        {},
      );
    }
    if (this.clock.nowIso() > pending.expiresAt) {
      throw refuse("state_expired", `The sign-in started at ${pending.createdAt} has expired.`, {});
    }

    const document = await this.discover();

    let tokens: unknown;
    try {
      tokens = await this.transport.postForm(
        document.token_endpoint,
        {
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: pending.redirectUri,
          client_id: this.settings.clientId,
          code_verifier: pending.codeVerifier,
        },
        // client_secret_basic. The secret goes in a header rather than the
        // body so it cannot be captured by anything that logs form fields.
        { authorization: basicAuthorization(this.settings.clientId, this.settings.clientSecret) },
        this.settings.httpTimeoutMs,
      );
    } catch (error) {
      throw refuse(
        "token_exchange_failed",
        `The authorization code could not be exchanged: ${error instanceof Error ? error.message : String(error)}`,
        {},
      );
    }

    const idToken = readIdToken(tokens);
    const identity = await this.verifyIdToken(idToken, pending.nonce, document);

    return { identity, returnTo: pending.returnTo };
  }

  /**
   * Verify an ID token completely, or refuse it.
   *
   * Exposed separately from the code flow so a back-channel logout token or a
   * test can be held to exactly the same checks. There is no "lenient" mode.
   */
  async verifyIdToken(
    idToken: string,
    expectedNonce: string | null,
    document?: DiscoveryDocument,
  ): Promise<VerifiedIdentity> {
    const keys = await this.resolveKeys(document);

    let payload: JWTPayload;
    let algorithm: string;
    try {
      const verified = await jwtVerify(idToken, keys, {
        issuer: this.settings.issuer,
        audience: this.settings.clientId,
        // Asymmetric only. Accepting an HMAC algorithm here is the classic
        // confusion attack: the "key" is the provider's public key, which the
        // attacker also has, so they can mint a token that verifies.
        algorithms: [...ACCEPTED_ALGORITHMS],
        clockTolerance: this.settings.clockToleranceSeconds,
        // Injected time, so expiry is testable and the demo is reproducible.
        currentDate: new Date(this.clock.now()),
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
      });
      payload = verified.payload;
      algorithm = verified.protectedHeader.alg;
    } catch (error) {
      throw refuse(
        "token_invalid",
        `The ID token failed verification: ${error instanceof Error ? error.message : String(error)}`,
        {},
      );
    }

    // Belt and braces over jose's own `algorithms` filter. The cost is one
    // comparison; the failure mode it covers is total.
    if (!ACCEPTED_ALGORITHMS.includes(algorithm)) {
      throw refuse("token_algorithm_refused", `ID token signed with ${algorithm}.`, { algorithm });
    }

    const subject = typeof payload.sub === "string" ? payload.sub : "";
    if (subject.length === 0) {
      throw refuse("subject_missing", "The ID token carries no subject.", {});
    }

    // `azp` names which client the token was actually issued to. When a token
    // has several audiences, `aud` alone does not answer that question.
    const azp = payload["azp"];
    if (typeof azp === "string" && azp !== this.settings.clientId) {
      throw refuse("azp_mismatch", "The ID token was issued to a different client.", {});
    }

    if (expectedNonce !== null) {
      const nonce = payload["nonce"];
      if (typeof nonce !== "string" || !secretsEqual(nonce, expectedNonce)) {
        throw refuse(
          "nonce_mismatch",
          "The ID token is not bound to this sign-in. It may be a token replayed from another session.",
          {},
        );
      }
    }

    const groups = this.readGroups(payload);

    return {
      issuer: this.settings.issuer,
      subject,
      groups,
      authenticationMethods: readStringArray(payload["amr"]),
      authenticatedAt:
        typeof payload["auth_time"] === "number"
          ? new Date(payload["auth_time"] * 1000).toISOString()
          : undefined,
      idpSessionId: typeof payload["sid"] === "string" ? payload["sid"] : undefined,
      // A fingerprint of everything asserted, so an audit entry can prove which
      // claim set a decision was made from without retaining the claims.
      claimsDigest: digestValue(payload as Record<string, unknown>),
    };
  }

  private async resolveKeys(document?: DiscoveryDocument): Promise<JWTVerifyGetKey> {
    if (this.keys) return this.keys;
    const resolved = document ?? (await this.discover());
    const remote = createRemoteJWKSet(new URL(resolved.jwks_uri), {
      timeoutDuration: this.settings.httpTimeoutMs,
    });
    this.keys = remote;
    return remote;
  }

  /**
   * Read the group claim, refusing an absent one.
   *
   * The distinction this makes is the whole reason the method exists. An empty
   * array means "the directory says this person is in none of the groups we
   * map", which deprovisions one person. A *missing* claim means the provider
   * was never configured to send groups — or, on Entra, that the user is in
   * enough groups to trigger the overage response, which replaces the claim
   * with `_claim_names`/`_claim_sources` pointers to the Graph API. Reading
   * that as "no groups" would deprovision the entire directory, and would do it
   * silently, on a Tuesday, for the users with the most access.
   */
  private readGroups(payload: JWTPayload): readonly string[] {
    const claim = payload[this.settings.groupClaim];
    if (claim === undefined || claim === null) {
      const overage = payload["_claim_names"];
      const isOverage =
        typeof overage === "object" &&
        overage !== null &&
        this.settings.groupClaim in (overage as Record<string, unknown>);
      throw refuse(
        isOverage ? "group_claim_overage" : "group_claim_absent",
        isOverage
          ? `The ID token points the "${this.settings.groupClaim}" claim at an external source because the subject is in too many groups for the token to carry. Configure a group filter for this application, or resolve the claim source. Access is refused rather than assumed.`
          : `The ID token carries no "${this.settings.groupClaim}" claim. Access is provisioned from directory groups, and an absent claim is a provider misconfiguration rather than an assertion that the subject is in no groups.`,
        { claim: this.settings.groupClaim },
      );
    }
    if (!Array.isArray(claim)) {
      throw refuse(
        "group_claim_malformed",
        `The "${this.settings.groupClaim}" claim is not an array.`,
        { claim: this.settings.groupClaim },
      );
    }
    return readStringArray(claim);
  }
}

function readIdToken(tokens: unknown): string {
  if (typeof tokens !== "object" || tokens === null) {
    throw refuse("token_response_malformed", "The token endpoint did not return a JSON object.", {});
  }
  const record = tokens as Record<string, unknown>;
  const tokenType = record["token_type"];
  if (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer") {
    throw refuse("token_type_unexpected", `The token endpoint returned token_type "${tokenType}".`, {});
  }
  const idToken = record["id_token"];
  if (typeof idToken !== "string" || idToken.length === 0) {
    // An access token alone proves nothing about who is signing in. Only the
    // ID token is an authentication statement, and this platform will not
    // synthesise one from a userinfo lookup.
    throw refuse(
      "id_token_missing",
      "The token endpoint returned no id_token. An access token is authorisation, not authentication.",
      {},
    );
  }
  return idToken;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  // RFC 6749 §2.3.1: both halves are form-urlencoded before base64 encoding.
  const encoded = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
    "utf8",
  ).toString("base64");
  return `Basic ${encoded}`;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function assertHttpsUrl(field: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${field} is not a URL: ${value}`, { field });
  }
  if (url.protocol !== "https:") {
    throw new ConfigError(
      `${field} must be HTTPS. Identity traffic carries authorization codes and tokens and will not be sent in the clear.`,
      { field, protocol: url.protocol },
    );
  }
}

/**
 * Sanitise the post-sign-in destination.
 *
 * Only a local, absolute path survives. An open redirect on the sign-in path
 * is a phishing primitive: the link is genuinely ours, the provider genuinely
 * authenticates, and the person lands wherever the attacker chose.
 */
export function safeReturnTo(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // Reject scheme-relative ("//evil.example") and anything with a scheme.
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  // Backslashes and control characters: some browsers normalise the first
  // into a path separator, and the second can break a redirect header.
  //
  // Matching control characters is the entire purpose here. The lint rule
  // guards against including them by accident; this range is deliberate, and
  // it is what makes header splitting and path-traversal-by-normalisation
  // impossible on this value.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
  return value.slice(0, 512);
}
