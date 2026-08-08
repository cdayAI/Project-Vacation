import { createHash } from "node:crypto";
import { FakeProvider, type ModelProvider } from "../models/provider.js";
import type { ContextValue, StepHandler } from "../engine/types.js";
import { RECORD_OUTCOME_HANDLER, SCREEN_PACKET_HANDLER } from "./rescission-intake.js";

/**
 * The step handlers the rescission-intake definition names.
 *
 * A definition names a handler; it never contains one. These are the code the
 * deployment wires up for the two effecting steps in that flow, and they hold to
 * the same rules the rest of the platform does:
 *
 * **Deterministic.** The screen handler drives the deterministic fake provider,
 * which is a pure function of its seed and its request, so a retry of an
 * identical step produces an identical result and the seeded demonstration
 * reproduces byte for byte. Neither handler reads a clock or a random source.
 *
 * **No invented effects.** The engine is what authorizes each step against the
 * chokepoint and records it in the operating record under its action name, so
 * "record the outcome" is that governed path — an authorized
 * `contract.flag_for_review` step written to the record — not a bespoke write of
 * this module's own. The handler's job is to produce the scalar findings later
 * steps read and a sentence the console renders, and nothing else.
 *
 * **References, never payloads.** Everything returned in `output` is a scalar a
 * later step or a supervisor can read; no owner material is carried on the
 * instance, which outlives the case.
 */

/** The fake provider is a development-only test double; the config loader refuses it elsewhere. */
const DEFAULT_SEED = "rescission-intake-v1";

export interface RescissionIntakeHandlerDeps {
  /**
   * The model provider the screen step drives.
   *
   * Defaults to a seeded {@link FakeProvider}, which is what the shipped flow
   * runs on: deterministic, offline, and refused outside development by the
   * configuration loader. A deployment that has wired a real gateway can pass
   * its provider here instead.
   */
  readonly provider?: ModelProvider;
  readonly seed?: string;
}

function asText(value: ContextValue | undefined, fallback: string): string {
  return value === undefined ? fallback : String(value);
}

/**
 * Build the handler map for the rescission-intake flow.
 *
 * Returned as a plain map so the composition root can register each entry into
 * the one {@link import("../engine/runner.js").StepHandlerRegistry} the engine
 * reads, the same way it publishes the definition into the one catalogue.
 */
export function buildRescissionIntakeHandlers(
  deps: RescissionIntakeHandlerDeps = {},
): Readonly<Record<string, StepHandler>> {
  const provider = deps.provider ?? new FakeProvider(deps.seed ?? DEFAULT_SEED);

  const screen: StepHandler = async (context) => {
    const contractId = asText(context.input["contractId"], "unknown-contract");
    const stateCode = asText(context.input["stateCode"], "unknown-state");

    // Screen and extract through the (fake) provider. The user body carries only
    // opaque references — a contract id and a state code — never owner material,
    // so there is nothing to redact and nothing to retain.
    const response = await provider.invoke({
      task: "rescission.intake.screen",
      modelId: "fake-intake-screen",
      modelVersion: "1",
      system:
        "Screen a timeshare rescission packet for completeness and extract its key fields. Reply with a short finding.",
      user: `contract=${contractId} state=${stateCode}`,
      maxOutputTokens: 256,
      timeoutMs: 30_000,
      // Stable across a restart, so a retried screen is the same call.
      idempotencyKey: context.idempotencyKey,
    });

    const extractDigest = createHash("sha256").update(response.text).digest("hex").slice(0, 16);
    const tokens = response.inputTokens + response.outputTokens;

    return {
      output: { packetScreened: true },
      // A model call costs money and changes nothing. The engine records this
      // against the run and consumes it from the ceiling.
      costUsd: 0.0011,
      units: tokens,
      modelId: response.modelId,
      summary: `Screened the rescission packet for ${contractId} (${stateCode}); extract ${extractDigest}, nothing withheld.`,
    };
  };

  const record: StepHandler = async (context) => {
    const contractId = asText(context.input["contractId"], "unknown-contract");
    const deadline = context.input["rescissionDeadline"];

    return {
      output: { outcomeRecorded: true },
      summary:
        deadline === undefined
          ? `Recorded the intake outcome and flagged ${contractId} for review.`
          : `Recorded the intake outcome and flagged ${contractId} for review; statutory rescission deadline ${String(deadline)}.`,
    };
  };

  return {
    [SCREEN_PACKET_HANDLER]: screen,
    [RECORD_OUTCOME_HANDLER]: record,
  };
}
