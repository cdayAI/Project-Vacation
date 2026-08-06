import { describe, it, expect } from "vitest";
import { ConfigError, DeniedError, isDenied } from "../kernel/errors.js";
import { DEFAULT_MODEL_ENTRIES, defaultInventory, ModelInventory } from "./inventory.js";
import type { ModelBinding, ModelEntry } from "./types.js";

const BINDING: ModelBinding = {
  provider: "fake",
  modelId: "primary-model",
  modelVersion: "v1",
  costPerInputTokenUsd: 0.000002,
  costPerOutputTokenUsd: 0.00001,
  maxOutputTokens: 512,
  timeoutMs: 5_000,
};

const FALLBACK: ModelBinding = { ...BINDING, modelId: "second-model" };

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    ...BINDING,
    task: "test.extract",
    purpose: "Extract facts for a test.",
    fallbacks: [FALLBACK],
    maySeeOwnerData: true,
    dataRetention: "zero_retention_confirmed",
    promptTemplateId: "test.extract",
    ...overrides,
  };
}

describe("model inventory", () => {
  it("resolves a logical task to a concrete model", () => {
    const inventory = new ModelInventory([entry()]);
    const resolved = inventory.resolve("test.extract");
    expect(resolved.modelId).toBe("primary-model");
    expect(resolved.provider).toBe("fake");
  });

  it("refuses a task nobody declared rather than defaulting to a model", () => {
    const inventory = new ModelInventory([entry()]);
    try {
      inventory.resolve("test.not_declared");
      expect.unreachable("an unknown task must be refused");
    } catch (error) {
      expect(isDenied(error)).toBe(true);
      expect((error as DeniedError).reason).toBe("model.not_in_inventory");
      expect((error as DeniedError).detail["task"]).toBe("test.not_declared");
    }
  });

  it("orders the chain with the primary first and fallbacks after", () => {
    const inventory = new ModelInventory([
      entry({ fallbacks: [FALLBACK, { ...BINDING, modelId: "third-model" }] }),
    ]);
    expect(inventory.chain("test.extract").map((binding) => binding.modelId)).toEqual([
      "primary-model",
      "second-model",
      "third-model",
    ]);
  });

  it("refuses to build an inventory where one task has two answers", () => {
    expect(() => new ModelInventory([entry(), entry({ modelId: "other-model" })])).toThrow(
      ConfigError,
    );
  });

  it("refuses a binding whose cost is missing or negative", () => {
    // A free-looking model makes the spend ceiling a decoration.
    expect(() => new ModelInventory([entry({ costPerOutputTokenUsd: -1 })])).toThrow(ConfigError);
    expect(
      () =>
        new ModelInventory([
          entry({ costPerInputTokenUsd: Number.NaN as unknown as number }),
        ]),
    ).toThrow(ConfigError);
  });

  it("refuses a binding with no timeout, because a hung provider would hold the run open", () => {
    expect(() => new ModelInventory([entry({ timeoutMs: 0 })])).toThrow(ConfigError);
  });

  it("refuses a binding that permits no output", () => {
    expect(() => new ModelInventory([entry({ maxOutputTokens: 0 })])).toThrow(ConfigError);
  });

  it("validates fallbacks as strictly as the primary", () => {
    expect(
      () => new ModelInventory([entry({ fallbacks: [{ ...FALLBACK, timeoutMs: -1 }] })]),
    ).toThrow(ConfigError);
  });

  it("warns rather than silently accepting unconfirmed provider terms", () => {
    const inventory = new ModelInventory([entry({ dataRetention: "unconfirmed" })]);
    expect(inventory.warnings.some((warning) => /UNCONFIRMED/.test(warning))).toBe(true);
  });

  it("warns when a task has no fallback, because it cannot degrade", () => {
    const inventory = new ModelInventory([entry({ fallbacks: [] })]);
    expect(inventory.warnings.some((warning) => /no fallback/.test(warning))).toBe(true);
  });

  it("lists every entry for the console and the assurance artifact", () => {
    const inventory = new ModelInventory([entry(), entry({ task: "test.other" })]);
    expect(inventory.list().map((item) => item.task)).toEqual(["test.extract", "test.other"]);
  });

  it("reports which tasks may see owner data, for the data inventory", () => {
    const inventory = new ModelInventory([
      entry(),
      entry({ task: "test.internal", maySeeOwnerData: false }),
    ]);
    expect(inventory.tasksSeeingOwnerData()).toEqual(["test.extract"]);
  });
});

describe("shipped inventory", () => {
  it("declares a prompt template and a purpose for every task", () => {
    for (const shipped of DEFAULT_MODEL_ENTRIES) {
      expect(shipped.promptTemplateId.length).toBeGreaterThan(0);
      expect(shipped.purpose.length).toBeGreaterThan(0);
    }
  });

  it("ships with provider terms unconfirmed, loudly", () => {
    const inventory = defaultInventory("anthropic");
    // Every shipped entry must raise the warning. Nothing here may quietly
    // assume zero retention on the customer's behalf.
    for (const shipped of inventory.list()) {
      expect(shipped.dataRetention).toBe("unconfirmed");
      expect(
        inventory.warnings.some(
          (warning) => warning.includes(shipped.task) && /UNCONFIRMED/.test(warning),
        ),
      ).toBe(true);
    }
  });

  it("names the fake explicitly when the deployment is configured for it", () => {
    const inventory = defaultInventory("fake");
    for (const shipped of inventory.list()) {
      expect(shipped.provider).toBe("fake");
      // The audit record must never claim a production model answered when a
      // test double did.
      expect(shipped.modelId.startsWith("fake/")).toBe(true);
      for (const fallback of shipped.fallbacks) {
        expect(fallback.provider).toBe("fake");
        expect(fallback.modelId.startsWith("fake/")).toBe(true);
      }
    }
  });

  it("keeps costs when standing in the fake, so the demo still shows a bill", () => {
    const real = defaultInventory("anthropic").resolve("rescission.extract_contract_facts");
    const fake = defaultInventory("fake").resolve("rescission.extract_contract_facts");
    expect(fake.costPerInputTokenUsd).toBe(real.costPerInputTokenUsd);
    expect(fake.costPerOutputTokenUsd).toBe(real.costPerOutputTokenUsd);
  });
});
