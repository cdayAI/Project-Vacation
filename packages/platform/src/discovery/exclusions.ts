import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { ISO_UTC_PATTERN } from "../record/migrations.js";
import { OBSERVATION_INPUT_KEYS, OBSERVATION_KEYS } from "./types.js";
import type { ApplicationKey, Observation, ObservationInput } from "./types.js";

/**
 * The structural exclusions, and the floor beneath the allowlist.
 *
 * Two controls live here, and neither is a setting.
 *
 * **The exclusions.** Screen contents and pixels, window titles, keystrokes,
 * clipboard, URLs and query strings, document contents, form values, message
 * and email bodies, and customer records are not things this component declines
 * to collect by policy. They are things it cannot represent: `Observation` has
 * no field for them, the database has no column for them, and
 * `assertObservationInput` refuses any object carrying a key that is not on the
 * derived allowlist. The named-field list below exists so that the refusal says
 * *why* rather than "unexpected key", and so that the test enumerating every
 * forbidden name has something to enumerate — but an unknown key is refused
 * whether or not anyone thought to name it, which is what makes the control
 * hold against fields nobody has invented yet.
 *
 * A second, quieter exclusion is the value shapes. Refusing unknown *keys* is
 * only half the job: the obvious way past it is to put the window title into a
 * field that is allowed. So application names must match a narrow pattern that
 * cannot contain a space, a slash, a colon, or a query string; references are
 * bounded and must look like references; durations are bounded integers; and no
 * value may be an object or an array, because a nested object is a payload
 * wearing a permitted key.
 *
 * **The blocklist floor.** Communication tools and systems of record are never
 * observed, whatever an enrollment says. Reconstructing that a person moved
 * between a ticketing tool and a spreadsheet is process data. Reconstructing
 * that they spent forty minutes in the HR system on Tuesday, or moved between
 * email and the owner system of record eleven times, is a picture of a
 * person — and the second sentence is the one an employment lawyer reads out
 * loud. The floor always beats the allowlist, it is checked at enrollment *and*
 * again at every observation, and it cannot be weakened by enrollment policy
 * because enrollment policy is never consulted about it.
 */

/**
 * Named fields this component must never carry.
 *
 * Refusing an unknown key already covers every one of these. They are named
 * anyway for three reasons: the denial message can say which promise was about
 * to be broken; the list is a readable statement of scope for a reviewer who is
 * not going to read the type; and a test enumerates it, so deleting an entry is
 * a visible act rather than a silent one.
 */
export const FORBIDDEN_OBSERVATION_FIELDS: readonly string[] = Object.freeze([
  "attachment",
  "attachments",
  "audio",
  "body",
  "clipboard",
  "clipboardContents",
  "content",
  "contents",
  "customerId",
  "customerRecord",
  "documentContents",
  "documentText",
  "domain",
  "emailBody",
  "fileName",
  "filePath",
  "formData",
  "formValues",
  "host",
  "html",
  "image",
  "input",
  "keylog",
  "keystrokes",
  "message",
  "messageBody",
  "mouse",
  "ownerName",
  "path",
  "payload",
  "pixels",
  "queryString",
  "query",
  "recording",
  "screenContents",
  "screenshot",
  "search",
  "selection",
  "snippet",
  "subjectLine",
  "text",
  "title",
  "transcript",
  "url",
  "video",
  "windowTitle",
]);

/**
 * The blocklist floor.
 *
 * Frozen at module load and never read from configuration, the database, or an
 * enrollment. An entry matches an application name exactly or as a namespace
 * prefix, so blocking `email` blocks `email.exchange` and `email.web` without
 * anyone having to enumerate the deployment's mail clients.
 *
 * Each entry says what it protects. These are not guesses about MVW's
 * application estate — they are categories, and the deployment maps its real
 * applications onto names that fall inside or outside them.
 */
export interface BlockedApplicationFamily {
  readonly family: string;
  readonly reason: string;
}

export const BLOCKED_APPLICATION_FAMILIES: readonly BlockedApplicationFamily[] = Object.freeze([
  Object.freeze({ family: "email", reason: "Message bodies, recipients, and attachments." }),
  Object.freeze({ family: "chat", reason: "Instant messaging and its participants." }),
  Object.freeze({ family: "meeting", reason: "Video conferencing and who attended." }),
  Object.freeze({ family: "telephony", reason: "Softphone and call handling." }),
  Object.freeze({ family: "sms", reason: "Text messaging." }),
  Object.freeze({ family: "social", reason: "Personal and public communication." }),
  Object.freeze({ family: "browser", reason: "A generic browser is where URLs live." }),
  Object.freeze({ family: "owner_record", reason: "System of record for owner accounts." }),
  Object.freeze({ family: "contract_record", reason: "System of record for contracts." }),
  Object.freeze({ family: "association_record", reason: "System of record for associations." }),
  Object.freeze({ family: "hr", reason: "Human resources information system." }),
  Object.freeze({ family: "payroll", reason: "Compensation and payroll." }),
  Object.freeze({ family: "benefits", reason: "Benefits and medical enrolment." }),
  Object.freeze({ family: "medical", reason: "Health information." }),
  Object.freeze({ family: "legal", reason: "Matter management and privileged material." }),
  Object.freeze({ family: "compliance", reason: "Investigations and whistleblowing." }),
  Object.freeze({ family: "ledger", reason: "General ledger and financial system of record." }),
  Object.freeze({ family: "banking", reason: "Banking and treasury." }),
  Object.freeze({ family: "payments", reason: "Payment handling. The platform is out of PCI scope." }),
  Object.freeze({ family: "identity", reason: "Directory and credential administration." }),
  Object.freeze({ family: "vault", reason: "Secret and credential storage." }),
  Object.freeze({ family: "union", reason: "Collective representation and union business." }),
  Object.freeze({ family: "personal", reason: "Anything the person marked as their own." }),
]);

/**
 * Application names, normalised and bounded.
 *
 * One to three dot-separated lowercase segments. No spaces, slashes, colons,
 * question marks, or capitals — a name matching this cannot be a URL, a file
 * path, or a window title, which is exactly the smuggling route that an
 * unknown-key check on its own would leave open.
 */
export const APPLICATION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z0-9_]{1,31}){0,2}$/;

/** Opaque references: bounded, and no punctuation that could carry a payload. */
export const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/**
 * Longest dwell a single transition may report: 24 hours.
 *
 * Bounded because an unbounded integer is a channel. A number is a poor way to
 * carry a document out, but it is not an impossible one, and a dwell longer
 * than a day is a broken collector rather than a person.
 */
export const MAX_DWELL_MS = 24 * 60 * 60 * 1000;

/** True if `application` is on the immutable floor, exactly or by namespace. */
export function isBlockedApplication(application: string): boolean {
  return blockedFamilyFor(application) !== null;
}

/** The blocklist entry that catches `application`, or null. */
export function blockedFamilyFor(application: string): BlockedApplicationFamily | null {
  if (typeof application !== "string") return null;
  for (const entry of BLOCKED_APPLICATION_FAMILIES) {
    if (application === entry.family || application.startsWith(`${entry.family}.`)) {
      return entry;
    }
  }
  return null;
}

/**
 * Refuse an application the floor forbids.
 *
 * Called from enrollment, so a blocked application cannot get onto an
 * allowlist, and again from the collector on every observation, so an
 * enrollment written before an entry was added to the floor does not keep
 * observing what the floor now forbids. The second check is the one that makes
 * this a floor rather than a suggestion.
 *
 * @throws {DeniedError} `discovery.excluded_field`
 */
export function assertNotBlocked(application: string): void {
  const blocked = blockedFamilyFor(application);
  if (blocked) {
    throw new DeniedError(
      "discovery.excluded_field",
      `Application "${application}" is on the work-discovery blocklist floor (${blocked.family}: ${blocked.reason}). The floor is a frozen constant in exclusions.ts; it always beats the enrollment allowlist and cannot be weakened by enrollment policy.`,
      { gate: "blocklist", application, family: blocked.family },
    );
  }
}

/**
 * Refuse an application name that is not a normalised name.
 *
 * @throws {DeniedError} `discovery.excluded_field` — deliberately a denial
 *   rather than an input error. A name carrying a space or a slash is not a
 *   typo; it is content arriving through a field that is allowed to exist, and
 *   the platform should refuse it in the same voice it refuses a screenshot.
 */
export function assertApplicationKey(field: string, value: unknown): asserts value is ApplicationKey {
  if (typeof value !== "string" || !APPLICATION_KEY_PATTERN.test(value)) {
    throw new DeniedError(
      "discovery.excluded_field",
      `${field} must be a normalised application name (lowercase, dot-separated, no spaces or punctuation), which is what stops a window title or a URL arriving in a permitted field. Received a value of ${describeShape(value)}.`,
      { field, shape: describeShape(value) },
    );
  }
}

/**
 * Describe a rejected value without echoing it.
 *
 * The point of refusing a value is that we do not want it. Putting it in an
 * error message puts it in a log, which is the thing that was being prevented.
 */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  const type = typeof value;
  if (type === "string") return `string(${(value as string).length} chars)`;
  if (type === "object") return `object(${Object.keys(value as object).length} keys)`;
  return type;
}

function assertNoExcludedKeys(
  candidate: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  shapeName: string,
): void {
  for (const key of Object.keys(candidate)) {
    if (allowed.includes(key)) continue;

    // Name the promise being broken when we can. Either way the answer is no.
    const named = FORBIDDEN_OBSERVATION_FIELDS.includes(key);
    throw new DeniedError(
      "discovery.excluded_field",
      named
        ? `Work discovery must never capture "${key}". Screen contents and pixels, window titles, keystrokes, clipboard, URLs and query strings, document contents, form values, message and email bodies, and customer records are structurally excluded — they are not settings, and there is nowhere in the ${shapeName} type or the schema to put them.`
        : `"${key}" is not a permitted ${shapeName} field. Work discovery observes normalised application transitions and their timing, and nothing else; an unrecognised field is refused rather than stored, because the field nobody has thought of yet is the one this check exists for.`,
      { field: key, shape: shapeName, named },
    );
  }
}

/**
 * Refuse anything that is not a bare, permitted value.
 *
 * A nested object or array under a permitted key is a payload wearing a badge,
 * so the only value types accepted anywhere in an observation are string and
 * number.
 */
function assertFlatValues(
  candidate: Readonly<Record<string, unknown>>,
  shapeName: string,
): void {
  for (const [key, value] of Object.entries(candidate)) {
    const type = typeof value;
    if (type === "string" || type === "number") continue;
    throw new DeniedError(
      "discovery.excluded_field",
      `${shapeName}.${key} must be a plain string or number. A nested value is a payload arriving under a permitted key, which is the shape the structural exclusions exist to refuse.`,
      { field: key, shape: describeShape(value) },
    );
  }
}

/**
 * Validate a submitted observation.
 *
 * Takes `unknown` on purpose. The collector's input arrives from a device agent
 * across a process boundary, and typing the parameter would let a caller assert
 * its way past the only check that matters. Everything downstream of this
 * function is trustworthy precisely because nothing reaches it another way.
 *
 * @throws {DeniedError} `discovery.excluded_field` for a forbidden or
 *   unrecognised field, a nested value, or a value shaped like content.
 * @throws {InvalidInputError} for a well-shaped field carrying a nonsensical
 *   value — a negative duration, a timestamp that is not the platform's form.
 */
export function assertObservationInput(value: unknown): asserts value is ObservationInput {
  const candidate = asPlainObject(value, "observation");
  assertNoExcludedKeys(candidate, OBSERVATION_INPUT_KEYS, "observation");
  assertFlatValues(candidate, "observation");

  for (const key of OBSERVATION_INPUT_KEYS) {
    if (!(key in candidate)) {
      throw new InvalidInputError(`An observation must carry ${key}.`, key);
    }
  }

  assertReference("subjectRef", candidate["subjectRef"]);
  assertReference("deviceRef", candidate["deviceRef"]);
  assertApplicationKey("fromApplication", candidate["fromApplication"]);
  assertApplicationKey("toApplication", candidate["toApplication"]);
  assertObservedAt(candidate["observedAt"]);
  assertDwell(candidate["dwellMs"]);
}

/**
 * Validate a stored observation.
 *
 * Applied by both store adapters on the way in. The collector has already
 * checked the submitted fields; this catches a caller that built an
 * `Observation` by hand and went straight to the store, which is the route a
 * future module would take without meaning any harm.
 */
export function assertObservationShape(value: unknown): asserts value is Observation {
  const candidate = asPlainObject(value, "observation");
  assertNoExcludedKeys(candidate, OBSERVATION_KEYS, "observation");
  assertFlatValues(candidate, "observation");

  for (const key of OBSERVATION_KEYS) {
    if (!(key in candidate)) {
      throw new InvalidInputError(`A stored observation must carry ${key}.`, key);
    }
  }

  assertReference("id", candidate["id"]);
  assertReference("subjectRef", candidate["subjectRef"]);
  assertReference("deviceRef", candidate["deviceRef"]);
  assertReference("sessionId", candidate["sessionId"]);
  assertApplicationKey("fromApplication", candidate["fromApplication"]);
  assertApplicationKey("toApplication", candidate["toApplication"]);
  assertObservedAt(candidate["observedAt"]);
  assertDwell(candidate["dwellMs"]);

  const sequence = candidate["sequence"];
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) {
    throw new InvalidInputError("sequence must be a positive integer.", "sequence");
  }
}

function asPlainObject(value: unknown, shapeName: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidInputError(
      `An ${shapeName} must be a plain object, received ${describeShape(value)}.`,
      shapeName,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

/** Bounded, punctuation-free opaque reference. Not a name and not a sentence. */
export function assertReference(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !REFERENCE_PATTERN.test(value)) {
    throw new DeniedError(
      "discovery.excluded_field",
      `${field} must be a short opaque reference. A long or free-form value here is content arriving through a permitted field, so it is refused rather than trimmed. Received ${describeShape(value)}.`,
      { field, shape: describeShape(value) },
    );
  }
}

function assertObservedAt(value: unknown): void {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) {
    throw new InvalidInputError(
      `observedAt must be an ISO-8601 UTC timestamp with milliseconds, e.g. 2026-08-06T13:05:00.000Z — received ${describeShape(value)}.`,
      "observedAt",
    );
  }
}

function assertDwell(value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidInputError(
      `dwellMs must be a non-negative whole number of milliseconds — received ${describeShape(value)}.`,
      "dwellMs",
    );
  }
  if (value > MAX_DWELL_MS) {
    throw new InvalidInputError(
      `dwellMs of ${value} exceeds the ${MAX_DWELL_MS} ms ceiling. A dwell longer than a day is a broken collector, and an unbounded number is a channel.`,
      "dwellMs",
    );
  }
}
