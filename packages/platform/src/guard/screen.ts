import { DeniedError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import { redactText } from "../kernel/redact.js";

/**
 * The boundary screen.
 *
 * Everything that originates outside the platform — owner messages, uploaded
 * documents, third-party data, integration responses — passes through here
 * before it reaches a model or any other instruction surface.
 *
 * The screen does two things, in this order:
 *
 *   1. Redacts secrets, so a credential pasted into an owner message is not
 *      forwarded to a model provider.
 *   2. Screens for prompt injection, so text that is trying to issue
 *      instructions is refused rather than interpreted.
 *
 * The rule that matters most is at the bottom of this file: **a screen that
 * errors denies**. A screen that cannot answer has not answered "clean". This
 * is stated in the brief and it is the single most likely place for a
 * well-meaning `try/catch` to turn a control into a decoration, so the catch
 * block is written once, here, and it re-raises as a denial.
 *
 * Honest limits. This is a heuristic detector, not a solved problem. It
 * catches the well-known shapes of injection and it will miss novel phrasing
 * and adversarial obfuscation. It is one layer: the others are that untrusted
 * text is never concatenated into a system prompt, that models are never given
 * tool authority the calling role does not itself hold, and that every
 * consequential action passes the authorization chokepoint regardless of what
 * any model asked for. The screen reduces the rate; the architecture bounds
 * the blast radius. Both are recorded in the threat model.
 */

export type ScreenVerdict = "clean" | "suspicious" | "blocked";

export interface ScreenSignal {
  readonly name: string;
  readonly weight: number;
  /** A short, non-quoting description. The matched text is not echoed. */
  readonly detail: string;
}

export interface ScreenResult {
  readonly verdict: ScreenVerdict;
  /** The text after redaction, safe to pass onward when verdict is not blocked. */
  readonly text: string;
  readonly score: number;
  readonly signals: readonly ScreenSignal[];
  /** Names of the secret patterns that were redacted. */
  readonly redacted: readonly string[];
  /** Digest of the original input, for the audit record. */
  readonly inputDigest: Digest;
}

interface InjectionPattern {
  readonly name: string;
  readonly regex: RegExp;
  readonly weight: number;
  readonly detail: string;
}

const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  {
    name: "instruction_override",
    regex:
      /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.!?\n]{0,40}\b(?:previous|prior|earlier|above|all|any|your|the)\b[^.!?\n]{0,30}\b(?:instruction|prompt|rule|direction|guideline|constraint|polic\w+|context)/i,
    weight: 5,
    detail: "Text attempts to override prior instructions.",
  },
  {
    name: "role_reassignment",
    regex:
      /\b(?:you are now|from now on,? you|act as (?:if|though|a)|pretend (?:to be|you)|new (?:persona|role|identity)|switch (?:to )?(?:role|persona)|roleplay as)\b/i,
    weight: 4,
    detail: "Text attempts to reassign the model's role.",
  },
  {
    name: "system_prompt_forgery",
    regex:
      /(?:^|\n)\s*(?:system|assistant|developer)\s*[:>]|<\|?(?:im_start|im_end|system|endoftext)\|?>|\[\/?INST\]|<<SYS>>/i,
    weight: 5,
    detail: "Text contains conversation-role or control markers.",
  },
  {
    name: "instruction_exfiltration",
    regex:
      /\b(?:reveal|show|print|repeat|output|disclose|dump|tell me)\b[^.!?\n]{0,40}\b(?:system prompt|initial instruction|your instruction|your prompt|the prompt|your rules|configuration|api[_ ]?key|credential|secret)/i,
    weight: 5,
    detail: "Text attempts to extract instructions, configuration, or credentials.",
  },
  {
    name: "tool_invocation",
    regex:
      /<(?:tool_use|function_call|invoke|antml:invoke)\b|\bcall (?:the )?(?:tool|function|api)\b[^.!?\n]{0,30}\bwith\b|"tool_name"\s*:/i,
    weight: 4,
    detail: "Text attempts to invoke a tool directly.",
  },
  {
    name: "authority_claim",
    regex:
      /\b(?:as (?:an? )?(?:administrator|admin|developer|superuser|operator)|i am (?:the )?(?:admin|administrator|developer|owner|compliance officer)|this is (?:an )?(?:authorised|authorized|approved) (?:override|request|instruction))\b/i,
    weight: 3,
    detail: "Text asserts an authority it cannot hold.",
  },
  {
    name: "guardrail_solicitation",
    regex:
      /\b(?:without (?:asking|approval|human|review|checking)|do not (?:log|record|audit|report|tell|notify)|skip (?:the )?(?:approval|review|audit|check)|no need (?:to|for) (?:approval|review|logging))\b/i,
    weight: 5,
    detail: "Text asks for a governance control to be skipped.",
  },
  {
    name: "urgency_pressure",
    regex:
      /\b(?:urgent|immediately|right now|emergency)\b[^.!?\n]{0,50}\b(?:override|bypass|skip|without|approve)\b/i,
    weight: 2,
    detail: "Text combines urgency with a request to bypass a control.",
  },
  {
    name: "encoded_payload",
    // A long unbroken base64-ish run is a common way to smuggle instructions
    // past a naive filter. Long enough that ordinary identifiers do not match.
    regex: /\b[A-Za-z0-9+/]{120,}={0,2}\b/,
    weight: 2,
    detail: "Text contains a long encoded run that may conceal instructions.",
  },
  {
    name: "hidden_directive_markup",
    regex: /<!--[\s\S]{0,400}?(?:ignore|instruction|system|prompt)[\s\S]{0,400}?-->/i,
    weight: 4,
    detail: "Text hides directive-like content inside markup comments.",
  },
  {
    name: "zero_width_obfuscation",
    regex: /[​-‏‪-‮⁠-⁤﻿]{3,}/,
    weight: 3,
    detail: "Text contains runs of invisible or bidirectional control characters.",
  },
];

export interface ScreenOptions {
  /** Score at or above which the text is refused. Default 5. */
  readonly blockThreshold?: number;
  /** Score at or above which the text is flagged but allowed. Default 2. */
  readonly suspicionThreshold?: number;
  /** Longest input accepted. Longer input is refused, not truncated. */
  readonly maxLength?: number;
}

const DEFAULTS = {
  blockThreshold: 5,
  suspicionThreshold: 2,
  maxLength: 500_000,
} as const;

/**
 * Screen untrusted text.
 *
 * @returns a result whose `text` is redacted and safe to pass onward when
 *   `verdict` is not `blocked`.
 * @throws {DeniedError} `screen.injection_detected` when the text is refused,
 *   and `screen.unavailable` when screening itself failed. Both are denials:
 *   the caller must not proceed with the text either way.
 */
export function screen(input: string, options: ScreenOptions = {}): ScreenResult {
  const blockThreshold = options.blockThreshold ?? DEFAULTS.blockThreshold;
  const suspicionThreshold = options.suspicionThreshold ?? DEFAULTS.suspicionThreshold;
  const maxLength = options.maxLength ?? DEFAULTS.maxLength;

  let inputDigest: Digest;
  try {
    if (typeof input !== "string") {
      throw new TypeError(`Screen expects a string, received ${typeof input}`);
    }
    inputDigest = digestValue({ text: input });
  } catch (error) {
    // We could not even fingerprint the input. Deny.
    throw new DeniedError(
      "screen.unavailable",
      `The boundary screen could not process this input, so it was refused: ${error instanceof Error ? error.message : String(error)}`,
      {},
    );
  }

  try {
    if (input.length > maxLength) {
      throw new DeniedError(
        "screen.injection_detected",
        `Input is ${input.length} characters, past the ${maxLength} screening limit. Oversized input is refused rather than truncated, because truncation would screen only part of what the model would see.`,
        { length: input.length, maxLength },
      );
    }

    const redaction = redactText(input);
    const signals: ScreenSignal[] = [];
    let score = 0;

    for (const pattern of INJECTION_PATTERNS) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags.replace("g", ""));
      if (regex.test(input)) {
        signals.push({ name: pattern.name, weight: pattern.weight, detail: pattern.detail });
        score += pattern.weight;
      }
    }

    const verdict: ScreenVerdict =
      score >= blockThreshold ? "blocked" : score >= suspicionThreshold ? "suspicious" : "clean";

    if (verdict === "blocked") {
      throw new DeniedError(
        "screen.injection_detected",
        `Untrusted text was refused by the boundary screen (score ${score}): ${signals.map((s) => s.name).join(", ")}.`,
        { score, signals: signals.map((s) => s.name).join(","), inputDigest },
      );
    }

    return {
      verdict,
      text: redaction.text,
      score,
      signals,
      redacted: redaction.matched,
      inputDigest,
    };
  } catch (error) {
    if (error instanceof DeniedError) throw error;
    // Anything unexpected — a regex engine failure, an out-of-memory string
    // operation — becomes a denial. A screen that cannot answer is not an
    // answer of "clean".
    throw new DeniedError(
      "screen.unavailable",
      `The boundary screen failed, so the input was refused: ${error instanceof Error ? error.message : String(error)}`,
      { inputDigest },
    );
  }
}

/**
 * Screen without throwing, for callers that need to record a verdict rather
 * than abort — the audit view, and the console's evidence panel.
 *
 * A failure still produces `blocked`; it never produces `clean`.
 */
export function screenSafely(input: string, options: ScreenOptions = {}): ScreenResult {
  try {
    return screen(input, options);
  } catch (error) {
    // allow-swallow: this function exists to return a verdict rather than
    // raise, for callers that must record an outcome — the audit view and the
    // console's evidence panel. It converts every failure into `blocked` and
    // can never produce `clean`, so the fail-closed property holds: a screen
    // that could not answer is still not an answer of "clean".
    const denied = error instanceof DeniedError ? error : null;
    return {
      verdict: "blocked",
      text: "",
      score: Number.POSITIVE_INFINITY,
      signals: [
        {
          name: denied?.reason ?? "screen.unavailable",
          weight: Number.POSITIVE_INFINITY,
          detail: denied?.message ?? "Screening failed.",
        },
      ],
      redacted: [],
      inputDigest: typeof input === "string" ? digestValue({ text: input }) : digestValue({ text: "" }),
    };
  }
}
