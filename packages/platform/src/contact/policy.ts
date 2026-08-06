import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { isKnownTimeZone } from "../timeline/calendar.js";
import { ALL_PURPOSES, CONTACT_CHANNELS } from "./types.js";
import type {
  ContactChannel,
  ContactPolicy,
  ContactPurpose,
  FrequencyCap,
  QuietHoursPolicy,
} from "./types.js";

/**
 * Contact policy: the values, and how they resolve.
 *
 * **Every number in this file is an engineering placeholder.** They are shaped
 * like the real obligations and cited to the rule they approximate, and not one
 * of them has been confirmed by counsel — which is why every entry carries
 * `verified: false` and why `validateContactPolicy` reports the unverified ones
 * rather than letting them pass silently.
 *
 * The values belong to MVW compliance. What belongs to engineering is the
 * shape: policy is a declarative artifact in version control, versioned as a
 * whole, reviewed through the same diff path as any other change, and named in
 * the evidence of every gate decision. It is deliberately not editable in a
 * database. A quiet-hours window that could be changed with an UPDATE is a
 * legal control with no review, no history, and no way to answer "what did the
 * policy say on the day we sent that".
 *
 * Two resolution rules matter more than the values themselves.
 *
 * *Jurisdiction falls back to the federal baseline, never to nothing.* A state
 * with no entry is governed by the `US` entry. A policy with no `US` entry
 * cannot answer the question at all, and the gate refuses rather than sending.
 *
 * *A missing rule is not permission.* If no quiet-hours window and no declared
 * exemption covers a channel, or no frequency cap covers it, the question "is
 * this permitted" has no answer and the send is refused. Absence of a rule
 * means compliance has not decided yet, and the safe reading of "not decided"
 * is "not yet".
 */

/** The federal baseline. Every jurisdiction falls back to this entry. */
export const FEDERAL_JURISDICTION = "US";

/** `HH:MM`, 24-hour. */
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The shipped policy artifact.
 *
 * Read this as a worked example of the shape MVW's real policy takes, not as a
 * statement of the law.
 */
export const CONTACT_POLICY: ContactPolicy = Object.freeze({
  version: "contact-policy-v1-unverified",
  owner: "mvw_compliance",

  quietHours: Object.freeze([
    {
      // 47 C.F.R. § 64.1200(c)(1) restricts telephone solicitation to between
      // 8 a.m. and 9 p.m. at the *called party's* location. That phrase is the
      // whole reason `gate.ts` computes local time from the recipient's IANA
      // zone rather than the server's: a company in Florida calling an owner in
      // Hawaii is governed by the clock in Hawaii.
      jurisdiction: FEDERAL_JURISDICTION,
      channels: Object.freeze(["voice", "sms"] as const),
      localStart: "21:00",
      localEnd: "08:00",
      citation: "47 C.F.R. § 64.1200(c)(1) — federal baseline, unconfirmed",
      verified: false,
    },
    {
      // Several states are narrower than the federal window. Florida's
      // Telephone Solicitation Act is carried here as the worked example
      // because MVW's largest owner concentration is in Florida; the other
      // states MVW operates in need the same treatment before launch.
      jurisdiction: "FL",
      channels: Object.freeze(["voice", "sms"] as const),
      localStart: "20:00",
      localEnd: "08:00",
      citation: "Fla. Stat. § 501.059 — narrower than federal, unconfirmed",
      verified: false,
    },
  ] as const),

  frequencyCaps: Object.freeze([
    {
      jurisdiction: FEDERAL_JURISDICTION,
      channel: "voice",
      purpose: ALL_PURPOSES,
      maxMessages: 3,
      windowHours: 24,
      citation: "Engineering placeholder; volume limits are a compliance decision",
      verified: false,
    },
    {
      jurisdiction: FEDERAL_JURISDICTION,
      channel: "sms",
      purpose: ALL_PURPOSES,
      maxMessages: 5,
      windowHours: 24,
      citation: "Engineering placeholder; volume limits are a compliance decision",
      verified: false,
    },
    {
      // A tighter ceiling stacked on top of the aggregate one. Both apply; the
      // gate requires every applicable cap to hold, so the effective limit is
      // the strictest, not the last one matched.
      jurisdiction: FEDERAL_JURISDICTION,
      channel: "sms",
      purpose: "marketing",
      maxMessages: 1,
      windowHours: 168,
      citation: "Engineering placeholder; marketing cadence is a brand and legal decision",
      verified: false,
    },
    {
      jurisdiction: FEDERAL_JURISDICTION,
      channel: "email",
      purpose: ALL_PURPOSES,
      maxMessages: 10,
      windowHours: 24,
      citation: "Engineering placeholder; volume limits are a compliance decision",
      verified: false,
    },
    {
      jurisdiction: FEDERAL_JURISDICTION,
      channel: "postal",
      purpose: ALL_PURPOSES,
      maxMessages: 4,
      windowHours: 720,
      citation: "Engineering placeholder; volume limits are a compliance decision",
      verified: false,
    },
  ] as const),

  // Declared, not inferred. Postal mail has no delivery time the sender
  // controls, and no federal rule sets email delivery hours. Writing the
  // exemption down means an empty quiet-hours table for a channel is a policy
  // gap the gate refuses on, rather than an exemption nobody agreed to.
  quietHoursExemptChannels: Object.freeze(["postal", "email"] as const),

  // Collections is here because of the FDCPA, marketing because an unwanted
  // marketing message is the one an owner complains about. Both take the
  // two-approver path.
  elevatedPurposes: Object.freeze(["collections", "marketing"] as const),
  // A live call cannot be recalled, reviewed, or corrected after the fact.
  elevatedChannels: Object.freeze(["voice"] as const),

  // 15 U.S.C. § 1692c(b) prohibits communicating about a debt with third
  // parties. Ships false and should stay false; if MVW's counsel identifies a
  // statutory exception they want to rely on, it belongs here with its citation
  // and its own approval path, not as a special case in the gate.
  collectionsThirdPartyPermitted: false,
} satisfies ContactPolicy);

/** Minutes since local midnight for an `HH:MM` value. */
export function localMinutes(value: string): number {
  const match = LOCAL_TIME_PATTERN.exec(value);
  if (!match) {
    throw new InvalidInputError(
      `"${value}" is not a 24-hour local time in HH:MM form, e.g. "21:00".`,
      "localTime",
    );
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

/**
 * Is a local wall-clock minute inside the quiet window?
 *
 * Half-open: the start minute is quiet, the end minute is not. A window that
 * wraps past midnight — which every realistic one does — is the common case
 * rather than the exception, so it is handled first and explicitly. Getting
 * this backwards would make 21:00 sendable and 08:00 not, which is exactly
 * wrong and would look fine in a test that only sampled midday.
 */
export function isWithinQuietWindow(minuteOfDay: number, window: QuietHoursPolicy): boolean {
  const start = localMinutes(window.localStart);
  const end = localMinutes(window.localEnd);
  if (start === end) {
    // Rejected by validateContactPolicy; treated as "always quiet" here so that
    // a policy that slipped through refuses every send rather than allowing
    // every send.
    return true;
  }
  if (start > end) return minuteOfDay >= start || minuteOfDay < end;
  return minuteOfDay >= start && minuteOfDay < end;
}

/**
 * The quiet-hours window governing a channel in a jurisdiction, or `null` when
 * the channel is declared exempt.
 *
 * @throws {DeniedError} `contact.evidence_unavailable` when neither a window
 *   nor a declared exemption covers the channel. The question was asked and the
 *   policy does not answer it, which is not the same as answering "yes".
 */
export function resolveQuietHours(
  policy: ContactPolicy,
  jurisdiction: string,
  channel: ContactChannel,
): QuietHoursPolicy | null {
  if (policy.quietHoursExemptChannels.includes(channel)) return null;

  const forChannel = policy.quietHours.filter((entry) => entry.channels.includes(channel));
  const local = forChannel.find((entry) => entry.jurisdiction === jurisdiction);
  if (local) return local;
  const federal = forChannel.find((entry) => entry.jurisdiction === FEDERAL_JURISDICTION);
  if (federal) return federal;

  throw new DeniedError(
    "contact.evidence_unavailable",
    `Contact policy ${policy.version} declares neither a quiet-hours window nor an exemption for ${channel} in ${jurisdiction}, so whether this hour is permitted cannot be answered. Refusing rather than assuming it is.`,
    { policyVersion: policy.version, jurisdiction, channel },
  );
}

/**
 * Every frequency cap that applies, strictest first.
 *
 * Caps stack: an aggregate ceiling for the channel and a tighter one for the
 * purpose both bind, and the gate requires all of them to hold. Returning the
 * list rather than "the" cap is what makes that true — a `find` here would
 * silently apply whichever entry happened to be first in the array.
 *
 * @throws {DeniedError} `contact.evidence_unavailable` when no cap covers the
 *   channel at all.
 */
export function resolveFrequencyCaps(
  policy: ContactPolicy,
  jurisdiction: string,
  channel: ContactChannel,
  purpose: ContactPurpose,
): readonly FrequencyCap[] {
  const applicable = policy.frequencyCaps.filter(
    (cap) =>
      cap.channel === channel &&
      (cap.purpose === ALL_PURPOSES || cap.purpose === purpose) &&
      (cap.jurisdiction === jurisdiction || cap.jurisdiction === FEDERAL_JURISDICTION),
  );

  // A state entry overrides the federal entry for the same channel and purpose,
  // rather than adding to it — otherwise a state that *relaxed* a limit would
  // still be bound by the federal number and the override would do nothing.
  const chosen = new Map<string, FrequencyCap>();
  for (const cap of applicable) {
    const key = `${cap.channel}:${cap.purpose}`;
    const existing = chosen.get(key);
    if (!existing || (existing.jurisdiction === FEDERAL_JURISDICTION && cap.jurisdiction === jurisdiction)) {
      chosen.set(key, cap);
    }
  }

  const caps = [...chosen.values()].sort((left, right) => {
    const leftRate = left.maxMessages / left.windowHours;
    const rightRate = right.maxMessages / right.windowHours;
    if (leftRate !== rightRate) return leftRate - rightRate;
    return left.purpose < right.purpose ? -1 : left.purpose > right.purpose ? 1 : 0;
  });

  if (caps.length === 0) {
    throw new DeniedError(
      "contact.evidence_unavailable",
      `Contact policy ${policy.version} declares no frequency cap for ${channel}/${purpose} in ${jurisdiction}, so how often this owner has already been contacted cannot be judged. A channel with no declared ceiling is a policy gap, not an unlimited allowance.`,
      { policyVersion: policy.version, jurisdiction, channel, purpose },
    );
  }
  return caps;
}

/** Whether a send attracts the elevated approval path. */
export function isElevated(
  policy: ContactPolicy,
  input: {
    readonly channel: ContactChannel;
    readonly purpose: ContactPurpose;
    readonly modelGenerated: boolean;
    readonly toThirdParty: boolean;
  },
): boolean {
  if (policy.elevatedPurposes.includes(input.purpose)) return true;
  if (policy.elevatedChannels.includes(input.channel)) return true;
  // Anything a model wrote that an owner will read gets the stricter path,
  // whatever it is about. The risk is not the topic, it is that no person has
  // yet read the words that will land in front of a consumer.
  if (input.modelGenerated) return true;
  if (input.toThirdParty) return true;
  return false;
}

export interface PolicyProblem {
  readonly severity: "error" | "warning";
  readonly where: string;
  readonly message: string;
}

/**
 * Check a policy artifact before it is trusted.
 *
 * Run in the test suite against the shipped artifact and available to a
 * deployment that supplies its own. Unverified entries are warnings rather than
 * errors so the platform can be exercised before counsel has signed off — but
 * they are reported every time, so "unverified" cannot quietly become the
 * permanent state.
 */
export function validateContactPolicy(policy: ContactPolicy): readonly PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const error = (where: string, message: string): void => {
    problems.push({ severity: "error", where, message });
  };
  const warn = (where: string, message: string): void => {
    problems.push({ severity: "warning", where, message });
  };

  if (policy.version.trim().length === 0) {
    error("version", "A policy artifact must be versioned so gate evidence can name it.");
  }
  if (policy.owner.trim().length === 0) {
    error("owner", "A policy nobody owns is a policy nobody reviews.");
  }

  policy.quietHours.forEach((entry, index) => {
    const where = `quietHours[${index}] (${entry.jurisdiction})`;
    if (entry.channels.length === 0) {
      error(where, "A quiet-hours window that covers no channel has no effect.");
    }
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = localMinutes(entry.localStart);
      end = localMinutes(entry.localEnd);
    } catch (problem) {
      error(where, problem instanceof Error ? problem.message : String(problem));
    }
    if (start !== null && end !== null && start === end) {
      error(
        where,
        "A window whose start equals its end is either the whole day or none of it. State which.",
      );
    }
    if (entry.citation.trim().length === 0) {
      error(where, "A quiet-hours window needs the rule it comes from.");
    }
    if (!entry.verified) {
      warn(where, `Unverified: ${entry.citation}. MVW compliance must confirm before launch.`);
    }
  });

  policy.frequencyCaps.forEach((cap, index) => {
    const where = `frequencyCaps[${index}] (${cap.channel}/${String(cap.purpose)})`;
    if (!Number.isInteger(cap.maxMessages) || cap.maxMessages < 1) {
      error(where, `maxMessages must be a whole number of at least 1; received ${cap.maxMessages}.`);
    }
    if (!Number.isFinite(cap.windowHours) || cap.windowHours <= 0) {
      error(where, `windowHours must be positive; received ${cap.windowHours}.`);
    }
    if (!cap.verified) {
      warn(where, `Unverified: ${cap.citation}. MVW compliance must confirm before launch.`);
    }
  });

  // Every channel must be answerable: covered by a window, or exempt by
  // declaration, and carrying at least one cap. This is the check that turns
  // "we forgot to write a rule" into a build-time finding rather than a runtime
  // refusal in front of an operator.
  for (const channel of CONTACT_CHANNELS) {
    const exempt = policy.quietHoursExemptChannels.includes(channel);
    const covered = policy.quietHours.some(
      (entry) => entry.channels.includes(channel) && entry.jurisdiction === FEDERAL_JURISDICTION,
    );
    if (!exempt && !covered) {
      error(
        `channel ${channel}`,
        "No federal quiet-hours window and no declared exemption. Every send on this channel will be refused.",
      );
    }
    if (exempt && covered) {
      error(
        `channel ${channel}`,
        "Declared exempt from quiet hours and also covered by a window. One of the two is wrong.",
      );
    }
    const capped = policy.frequencyCaps.some(
      (cap) => cap.channel === channel && cap.jurisdiction === FEDERAL_JURISDICTION,
    );
    if (!capped) {
      error(
        `channel ${channel}`,
        "No federal frequency cap. Every send on this channel will be refused.",
      );
    }
  }

  return problems;
}

/**
 * Refuse a timezone the runtime cannot resolve.
 *
 * Separate from the gate so a caller assembling a recipient record can fail at
 * the point the bad value entered rather than at the point a message was about
 * to go out.
 *
 * @throws {DeniedError} `contact.evidence_unavailable`.
 */
export function assertRecipientTimeZone(timeZone: string): void {
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) {
    throw new DeniedError(
      "contact.evidence_unavailable",
      "The recipient's timezone is required before any message may be sent. Quiet hours are measured at the recipient's location, so without it the question cannot be answered — and defaulting to the server's zone would answer it wrongly for most owners.",
      {},
    );
  }
  if (!isKnownTimeZone(timeZone)) {
    throw new DeniedError(
      "contact.evidence_unavailable",
      `"${timeZone}" is not an IANA timezone this runtime recognises, so the recipient's local time cannot be computed. A fixed offset is not acceptable: it is wrong twice a year.`,
      { timeZone },
    );
  }
}
