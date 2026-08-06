import { describe, it, expect } from "vitest";
import { DeniedError } from "../kernel/errors.js";
import {
  AnthropicProvider,
  approximateTokens,
  FakeProvider,
  isDegradable,
  ProviderError,
  ProviderRegistry,
  type ModelRequest,
} from "./provider.js";

const REQUEST: ModelRequest = {
  task: "test.extract",
  modelId: "primary-model",
  modelVersion: "v1",
  system: "You extract facts.",
  user: "<packet>Signed 3 March.</packet>",
  maxOutputTokens: 512,
  timeoutMs: 5_000,
};

/** A stub response body in the shape the Messages API returns. */
function messagesBody(text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    model: "primary-model",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 11, output_tokens: 7 },
    ...extra,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fake provider", () => {
  it("produces the same answer for the same seed and request", async () => {
    const first = await new FakeProvider("seed-a").invoke(REQUEST);
    const second = await new FakeProvider("seed-a").invoke(REQUEST);
    expect(first.text).toBe(second.text);
  });

  it("produces a different answer for a different seed", async () => {
    const first = await new FakeProvider("seed-a").invoke(REQUEST);
    const second = await new FakeProvider("seed-b").invoke(REQUEST);
    expect(first.text).not.toBe(second.text);
  });

  it("does not depend on call order, so a retry cannot change a settled answer", async () => {
    const provider = new FakeProvider("seed-a");
    const first = await provider.invoke(REQUEST);
    await provider.invoke({ ...REQUEST, user: "something else" });
    const repeat = await provider.invoke(REQUEST);
    expect(repeat.text).toBe(first.text);
  });

  it("answers differently for a different prompt", async () => {
    const provider = new FakeProvider("seed-a");
    const first = await provider.invoke(REQUEST);
    const second = await provider.invoke({ ...REQUEST, user: "a different packet" });
    expect(first.text).not.toBe(second.text);
  });

  it("fails the scripted number of times and then behaves normally", async () => {
    const provider = new FakeProvider("seed-a").script({
      modelId: "primary-model",
      failures: 2,
      failureKind: "rate_limited",
    });

    await expect(provider.invoke(REQUEST)).rejects.toThrow(ProviderError);
    await expect(provider.invoke(REQUEST)).rejects.toThrow(ProviderError);
    await expect(provider.invoke(REQUEST)).resolves.toMatchObject({ modelId: "primary-model" });
    expect(provider.calls).toHaveLength(3);
  });

  it("scripts by model so a chain can be made to fail at one link", async () => {
    const provider = new FakeProvider("seed-a").script({
      modelId: "primary-model",
      failures: 99,
    });
    await expect(provider.invoke(REQUEST)).rejects.toThrow(ProviderError);
    await expect(
      provider.invoke({ ...REQUEST, modelId: "second-model" }),
    ).resolves.toBeDefined();
  });

  it("charges scripted latency to an injected clock rather than waiting", async () => {
    let advanced = 0;
    const provider = new FakeProvider("seed-a", {
      advance: (milliseconds) => {
        advanced += milliseconds;
      },
    }).script({ latencyMs: 1_500 });

    await provider.invoke(REQUEST);
    expect(advanced).toBe(1_500);
  });
});

describe("provider registry", () => {
  it("refuses a provider this deployment has not configured", () => {
    const registry = new ProviderRegistry([new FakeProvider("seed")]);
    try {
      registry.require("anthropic");
      expect.unreachable("an unconfigured provider must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(DeniedError);
      // Not an outage to degrade past: a misconfiguration must surface.
      expect((error as DeniedError).reason).toBe("config.missing");
    }
  });
});

describe("failure classification", () => {
  it("treats availability failures as worth degrading for", () => {
    expect(isDegradable("timeout")).toBe(true);
    expect(isDegradable("rate_limited")).toBe(true);
    expect(isDegradable("unavailable")).toBe(true);
  });

  it("does not degrade for a refusal or a malformed request", () => {
    // Another model would decline the same content, or reject the same
    // request, for the same reason.
    expect(isDegradable("refused")).toBe(false);
    expect(isDegradable("invalid_request")).toBe(false);
  });
});

describe("http provider", () => {
  const API_KEY = "test-key-do-not-log-4f3a91";

  function provider(fetchImpl: typeof fetch): AnthropicProvider {
    return new AnthropicProvider({
      apiKey: API_KEY,
      baseUrl: "https://provider.invalid/",
      fetchImpl,
    });
  }

  it("refuses to be constructed without a key rather than failing at the first call", () => {
    expect(
      () =>
        new AnthropicProvider({ apiKey: "", baseUrl: "https://provider.invalid", fetchImpl: fetch }),
    ).toThrow(DeniedError);
  });

  it("sends the request and returns the provider's reported usage", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};

    const result = await provider(async (url, init) => {
      seenUrl = String(url);
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(messagesBody("extracted"));
    }).invoke({ ...REQUEST, idempotencyKey: "run_1:step" });

    expect(seenUrl).toBe("https://provider.invalid/v1/messages");
    expect(seenHeaders["x-api-key"]).toBe(API_KEY);
    expect(seenHeaders["anthropic-version"]).toBe("2023-06-01");
    expect(seenHeaders["idempotency-key"]).toBe("run_1:step");
    expect(seenBody["model"]).toBe("primary-model");
    expect(seenBody["system"]).toBe(REQUEST.system);
    expect(result).toMatchObject({ text: "extracted", inputTokens: 11, outputTokens: 7 });
  });

  it("classifies a rate limit as degradable", async () => {
    const failure = await provider(async () => jsonResponse({ error: "slow down" }, 429))
      .invoke(REQUEST)
      .catch((error: unknown) => error as ProviderError);
    expect(failure.kind).toBe("rate_limited");
    expect(failure.retryable).toBe(true);
  });

  it("classifies a server error as an outage", async () => {
    const failure = await provider(async () => jsonResponse({ error: "boom" }, 503))
      .invoke(REQUEST)
      .catch((error: unknown) => error as ProviderError);
    expect(failure.kind).toBe("unavailable");
    expect(failure.retryable).toBe(true);
  });

  it("does not degrade past a rejected credential, and never quotes it", async () => {
    const failure = await provider(async () => jsonResponse({ error: "bad key" }, 401))
      .invoke(REQUEST)
      .catch((error: unknown) => error as ProviderError);
    // Every fallback would present the same credential and fail identically.
    expect(failure.kind).toBe("invalid_request");
    expect(failure.retryable).toBe(false);
    expect(failure.message).not.toContain(API_KEY);
  });

  it("keeps the key out of the error on a rejected request", async () => {
    const failure = await provider(async () => jsonResponse({ error: "bad body" }, 400))
      .invoke(REQUEST)
      .catch((error: unknown) => error as ProviderError);
    expect(failure.kind).toBe("invalid_request");
    expect(failure.message).not.toContain(API_KEY);
  });

  it("treats a content refusal as a decision, not an outage", async () => {
    const failure = await provider(async () =>
      jsonResponse(messagesBody("", { stop_reason: "refusal" })),
    )
      .invoke(REQUEST)
      .catch((error: unknown) => error as ProviderError);
    expect(failure.kind).toBe("refused");
    expect(failure.retryable).toBe(false);
  });

  it("aborts an attempt that outlives its timeout", async () => {
    const failure = await provider(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const aborted = new Error("aborted");
            aborted.name = "AbortError";
            reject(aborted);
          });
        }),
    )
      .invoke({ ...REQUEST, timeoutMs: 5 })
      .catch((error: unknown) => error as ProviderError);
    expect(failure.kind).toBe("timeout");
    expect(failure.retryable).toBe(true);
  });

  it("treats a transport failure as an outage rather than crashing", async () => {
    const failure = await provider(async () => {
      throw new Error("ECONNRESET");
    })
      .invoke(REQUEST)
      .catch((error: unknown) => error as ProviderError);
    expect(failure.kind).toBe("unavailable");
  });

  it("refuses a response it cannot parse instead of guessing at it", async () => {
    const failure = await provider(async () => jsonResponse({ content: "not an array" }))
      .invoke(REQUEST)
      .catch((error: unknown) => error as ProviderError);
    expect(failure.kind).toBe("invalid_request");
    expect(failure.retryable).toBe(false);
  });

  it("falls back to an estimate when the provider reports no usage", async () => {
    const result = await provider(async () =>
      jsonResponse({ content: [{ type: "text", text: "answer" }] }),
    ).invoke(REQUEST);
    // Never zero: a call that reported no usage must not read as a free call
    // to the spend ceiling.
    expect(result.inputTokens).toBe(approximateTokens(REQUEST.user));
    expect(result.outputTokens).toBeGreaterThan(0);
  });
});
