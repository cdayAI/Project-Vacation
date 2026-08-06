import { describe, expect, it, vi } from "vitest";
import { ApiError, createConsoleClient, isDenial } from "./client";

interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

function respond(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
  };
}

function clientWith(fetchImpl: (...args: never[]) => unknown) {
  return createConsoleClient({
    baseUrl: "/api",
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });
}

describe("console API client", () => {
  it("resolves a denial rather than throwing, even on a 4xx", async () => {
    const denial = {
      denied: true,
      reason: "approval.self_approval",
      message: "You raised this proposal, so you may not approve it.",
      detail: { approvalId: "apr_01k3n3z9w7" },
    };
    const fetchImpl = vi.fn(() => Promise.resolve(respond(403, denial)));
    const client = clientWith(fetchImpl);

    const outcome = await client.approval("apr_01k3n3z9w7");

    expect(isDenial(outcome)).toBe(true);
    if (!isDenial(outcome)) throw new Error("unreachable");
    expect(outcome.reason).toBe("approval.self_approval");
    expect(outcome.message).toContain("may not approve");
  });

  it("throws for a non-2xx that is not a denial", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(500, { error: "boom" })));
    const client = clientWith(fetchImpl);

    await expect(client.workQueue()).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws for a transport failure and reports it as a fault, not a refusal", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("network down")));
    const client = clientWith(fetchImpl);

    const failure = await client.health().catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(0);
    expect((failure as ApiError).detail).toContain("network down");
  });

  it("never retries a write", async () => {
    // The whole reason writes carry an idempotency key is that a duplicate
    // action is worse than a visible failure. A client that quietly re-sent a
    // POST would be gambling that the key made it through.
    const fetchImpl = vi.fn(() => Promise.reject(new Error("connection reset")));
    const client = clientWith(fetchImpl);

    await expect(
      client.decideApproval("apr_1", { decision: "granted", idempotencyKey: "key-1" }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never retries a read either", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(503, { error: "unavailable" })));
    const client = clientWith(fetchImpl);

    await expect(client.run("run_1")).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends the caller's idempotency key with a decision", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(200, { approvalId: "apr_1" })));
    const client = clientWith(fetchImpl);

    await client.decideApproval("apr_1", {
      decision: "granted",
      note: "Checked against the loaded rule.",
      idempotencyKey: "d0c8a1f2-4b6e-4c3a-9f11-5a2b7c9e0d34",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/approvals/apr_1/decisions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "d0c8a1f2-4b6e-4c3a-9f11-5a2b7c9e0d34",
    );
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({
      decision: "granted",
      note: "Checked against the loaded rule.",
    });
  });

  it("builds list queries with repeated parameters for array filters", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(200, { items: [], total: 0, limit: 50, offset: 0 })));
    const client = clientWith(fetchImpl);

    await client.workQueue({ status: ["awaiting_approval", "failed"], mode: ["supervised"], limit: 25 });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/runs?status=awaiting_approval&status=failed&mode=supervised&limit=25");
  });

  it("throws when a 2xx body cannot be read as JSON", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<html>nope</html>") }),
    );
    const client = clientWith(fetchImpl);

    await expect(client.session()).rejects.toBeInstanceOf(ApiError);
  });

  it("escapes identifiers into the path", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(200, { runId: "x" })));
    const client = clientWith(fetchImpl);

    await client.run("run/../secret");

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/runs/run%2F..%2Fsecret");
  });
});
