import { describe, it, expect } from "vitest";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { MemoryDb } from "../store/db.js";
import { MemoryModelInvocationStore } from "./store.memory.js";
import type { ModelInvocation } from "./types.js";

const AT = "2026-08-06T12:00:00.000Z";

function invocation(overrides: Partial<ModelInvocation> = {}): ModelInvocation {
  return {
    stepId: "stp_one" as Id<"step">,
    runId: "run_one" as Id<"run">,
    task: "test.extract",
    provider: "fake",
    modelId: "primary-model",
    modelVersion: "v1",
    promptTemplateId: "test.extract",
    promptTemplateVersion: 1,
    promptDigest: digestValue({ prompt: "a" }),
    responseDigest: digestValue({ response: "b" }),
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.0012,
    latencyMs: 350,
    attempt: 1,
    degraded: false,
    outcome: "succeeded",
    invokedAt: AT,
    ...overrides,
  };
}

function store(): MemoryModelInvocationStore {
  return new MemoryModelInvocationStore(new MemoryDb());
}

describe("model invocation store", () => {
  it("round-trips an invocation", async () => {
    const invocations = store();
    await invocations.recordInvocation(invocation());

    const found = await invocations.getInvocation("stp_one" as Id<"step">);
    expect(found).toMatchObject({ task: "test.extract", costUsd: 0.0012, outcome: "succeeded" });
  });

  it("returns null for a step that made no model call", async () => {
    // Distinct from raising: "this step called no model" is a real answer.
    expect(await store().getInvocation("stp_absent" as Id<"step">)).toBeNull();
  });

  it("treats a repeated identical write as the crash-recovery path it is", async () => {
    const invocations = store();
    await invocations.recordInvocation(invocation());
    await invocations.recordInvocation(invocation());

    // Recording it twice must not double the spend the ceiling reads.
    expect(await invocations.countInvocations()).toBe(1);
  });

  it("refuses a second, different invocation under one step id", async () => {
    const invocations = store();
    await invocations.recordInvocation(invocation());

    await expect(invocations.recordInvocation(invocation({ costUsd: 9.99 }))).rejects.toThrow(
      DeniedError,
    );
    expect((await invocations.getInvocation("stp_one" as Id<"step">))?.costUsd).toBe(0.0012);
  });

  it("stays consistent when two writers race on the same step", async () => {
    const invocations = store();

    await Promise.all([
      invocations.recordInvocation(invocation()),
      invocations.recordInvocation(invocation()),
      invocations.recordInvocation(invocation()),
    ]);

    expect(await invocations.countInvocations()).toBe(1);
  });

  it("refuses a prompt written where a digest belongs", async () => {
    // The mistake that would quietly turn this table into a payload store.
    await expect(
      store().recordInvocation(invocation({ promptDigest: "Dear owner, your contract..." })),
    ).rejects.toThrow(InvalidInputError);
  });

  it("refuses a response written where a digest belongs", async () => {
    await expect(
      store().recordInvocation(invocation({ responseDigest: "The answer is 42." })),
    ).rejects.toThrow(InvalidInputError);
  });

  it("refuses a negative cost", async () => {
    // A refund nobody received would buy back ceiling headroom.
    await expect(store().recordInvocation(invocation({ costUsd: -1 }))).rejects.toThrow(
      InvalidInputError,
    );
  });

  it("refuses a timestamp that is not the platform's wire form", async () => {
    await expect(
      store().recordInvocation(invocation({ invokedAt: "2026-08-06T12:00:00+02:00" })),
    ).rejects.toThrow(InvalidInputError);
  });

  it("hands out clones, so a caller cannot rewrite what was recorded", async () => {
    const invocations = store();
    await invocations.recordInvocation(invocation());

    const first = await invocations.getInvocation("stp_one" as Id<"step">);
    (first as { costUsd: number }).costUsd = 999;

    expect((await invocations.getInvocation("stp_one" as Id<"step">))?.costUsd).toBe(0.0012);
  });

  it("filters by run, task, outcome, and degradation", async () => {
    const invocations = store();
    await invocations.recordInvocation(invocation());
    await invocations.recordInvocation(
      invocation({
        stepId: "stp_two" as Id<"step">,
        task: "test.other",
        degraded: true,
        outcome: "failed",
        responseDigest: undefined,
      }),
    );

    expect(await invocations.countInvocations({ runId: "run_one" as Id<"run"> })).toBe(2);
    expect(await invocations.countInvocations({ task: "test.other" })).toBe(1);
    expect(await invocations.countInvocations({ outcome: "failed" })).toBe(1);
    expect(await invocations.countInvocations({ degradedOnly: true })).toBe(1);
    expect(await invocations.countInvocations({ runId: "run_other" as Id<"run"> })).toBe(0);
  });

  it("treats the time window as strictly after and strictly before", async () => {
    const invocations = store();
    await invocations.recordInvocation(invocation());

    expect(await invocations.countInvocations({ invokedAfter: AT })).toBe(0);
    expect(await invocations.countInvocations({ invokedBefore: AT })).toBe(0);
    expect(await invocations.countInvocations({ invokedAfter: "2026-08-06T11:59:59.999Z" })).toBe(1);
  });

  it("counts every match regardless of the page size", async () => {
    const invocations = store();
    await invocations.recordInvocation(invocation());
    await invocations.recordInvocation(invocation({ stepId: "stp_two" as Id<"step"> }));

    expect(await invocations.listInvocations({ limit: 1 })).toHaveLength(1);
    // A count that respected the page size could never say how many pages there are.
    expect(await invocations.countInvocations({ limit: 1 })).toBe(2);
  });

  it("sums spend and tokens by task and model for the cost report", async () => {
    const invocations = store();
    await invocations.recordInvocation(invocation());
    await invocations.recordInvocation(
      invocation({ stepId: "stp_two" as Id<"step">, costUsd: 0.0008, outputTokens: 5 }),
    );
    await invocations.recordInvocation(
      invocation({ stepId: "stp_three" as Id<"step">, task: "test.other", costUsd: 0.02 }),
    );

    const usage = await invocations.usageByTask();
    expect(usage).toEqual([
      {
        task: "test.extract",
        modelId: "primary-model",
        calls: 2,
        inputTokens: 200,
        outputTokens: 25,
        costUsd: 0.002,
      },
      {
        task: "test.other",
        modelId: "primary-model",
        calls: 1,
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.02,
      },
    ]);
  });

  it("bounds the usage roll-up by a window", async () => {
    const invocations = store();
    await invocations.recordInvocation(invocation());
    await invocations.recordInvocation(
      invocation({ stepId: "stp_two" as Id<"step">, invokedAt: "2026-08-07T12:00:00.000Z" }),
    );

    const usage = await invocations.usageByTask("2026-08-07T00:00:00.000Z");
    expect(usage[0]?.calls).toBe(1);
  });

  it("refuses a window that is not the platform's wire form", async () => {
    await expect(store().usageByTask("yesterday")).rejects.toThrow(InvalidInputError);
  });
});
