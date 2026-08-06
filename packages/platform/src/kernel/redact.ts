/**
 * Secret and sensitive-value redaction.
 *
 * Applied on two paths that must never carry a secret onward:
 *   - the boundary screen (guard/screen.ts), before untrusted text reaches a
 *     model or any instruction surface;
 *   - the logger, before anything is written to a log sink.
 *
 * Two properties matter more than cleverness here. First, redaction runs on
 * every logged payload, so it must be cheap and must never throw — a redactor
 * that throws takes down the thing it was protecting. Second, a miss is
 * unrecoverable once the text has left the process, so the patterns bias
 * toward over-redaction. Losing a log line's readability is a smaller cost
 * than leaking a credential.
 *
 * Primary account numbers are included deliberately. The platform is designed
 * to stay out of PCI scope and never to accept card data (see
 * docs/adr/0009-no-card-data.md); redacting PANs means an operator who pastes
 * one into a free-text field does not silently drag the deployment into scope.
 */

export const REDACTED = "[redacted]";

interface Pattern {
  readonly name: string;
  readonly regex: RegExp;
  /** Optional extra test; the match is only redacted when this returns true. */
  readonly confirm?: (match: string) => boolean;
}

/** Luhn check, used to avoid redacting every 16-digit number in sight. */
export function passesLuhn(digits: string): boolean {
  const clean = digits.replace(/[^\d]/g, "");
  if (clean.length < 13 || clean.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    const charCode = clean.charCodeAt(i) - 48;
    let value = charCode;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

const PATTERNS: readonly Pattern[] = [
  // PEM private key blocks, including the body, matched first so the body is
  // not left behind by a narrower pattern.
  {
    name: "private_key",
    regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  },
  // JSON Web Tokens.
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // AWS access key ids and their common secret-key companion.
  { name: "aws_access_key_id", regex: /\b(?:AKIA|ASIA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g },
  // Vendor-prefixed API keys (OpenAI, Anthropic, Stripe, GitHub, Slack, Google).
  {
    name: "vendor_api_key",
    regex:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{8,}|pk_live_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/g,
  },
  // Credentials embedded in a URL: scheme://user:password@host
  { name: "url_credentials", regex: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi },
  // Authorization headers and bearer tokens.
  {
    name: "authorization_header",
    regex: /\b(authorization|proxy-authorization)\s*[:=]\s*("?)(?:bearer|basic|token)\s+[^\s"',;]+/gi,
  },
  { name: "bearer_token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  // Assignment of anything named like a secret. Deliberately broad.
  {
    name: "named_secret_assignment",
    regex:
      /\b([A-Za-z0-9_.-]*(?:passwd|password|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|session[_-]?key)[A-Za-z0-9_.-]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
  },
  // Postgres / MySQL / Mongo connection strings carrying a password.
  {
    name: "connection_string",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s]*:[^\s@]*@[^\s]+/gi,
  },
  // US Social Security numbers.
  { name: "ssn", regex: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  // Primary account numbers, Luhn-confirmed so ordinary long numbers survive.
  {
    name: "pan",
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    confirm: (match) => passesLuhn(match),
  },
];

export interface RedactionResult {
  /** The text with every match replaced. */
  readonly text: string;
  /** Names of the patterns that fired, deduplicated and sorted. */
  readonly matched: readonly string[];
}

/**
 * Redact secrets from a string.
 *
 * Never throws. On any internal failure it returns a fully redacted string
 * rather than the original — failing closed, consistent with the rest of the
 * platform.
 */
export function redactText(input: string): RedactionResult {
  if (typeof input !== "string" || input.length === 0) {
    return { text: typeof input === "string" ? input : "", matched: [] };
  }

  const matched = new Set<string>();
  let text = input;

  try {
    for (const pattern of PATTERNS) {
      // Fresh RegExp per call: the module-level literals carry /g and therefore
      // mutable lastIndex, which is not safe to share across concurrent calls.
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      text = text.replace(regex, (match, ...groups) => {
        if (pattern.confirm && !pattern.confirm(match)) return match;
        matched.add(pattern.name);

        // Keep the non-secret part of the match so the line stays readable.
        if (pattern.name === "url_credentials") {
          const scheme = typeof groups[0] === "string" ? groups[0] : "";
          return `${scheme}${REDACTED}@`;
        }
        if (pattern.name === "named_secret_assignment") {
          const key = typeof groups[0] === "string" ? groups[0] : "value";
          return `${key}=${REDACTED}`;
        }
        if (pattern.name === "authorization_header") {
          const header = typeof groups[0] === "string" ? groups[0] : "authorization";
          return `${header}: ${REDACTED}`;
        }
        return REDACTED;
      });
    }
  } catch {
    // A malformed input that breaks a regex engine must not leak the original.
    return { text: REDACTED, matched: ["redaction_failed"] };
  }

  return { text, matched: [...matched].sort() };
}

/** Property names whose values are replaced wholesale, regardless of content. */
const SENSITIVE_KEYS =
  /^(?:password|passwd|secret|token|api_?key|access_?key|private_?key|client_?secret|authorization|cookie|set-cookie|session|credential|pan|card_?number|cvv|cvc|ssn|tax_?id)$/i;

/**
 * Deep-redact a structured value for logging.
 *
 * Both the key name and the string content are considered: a value under
 * `password` is dropped whatever it looks like, and a value under an innocuous
 * key is still scanned for secret-shaped content.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[truncated]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactText(value).text;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "function" || typeof value === "symbol") return "[unloggable]";

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => redactValue(item, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message).text,
      ...(value.stack ? { stack: redactText(value.stack).text } : {}),
    };
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map || value instanceof Set) return `[${value.constructor.name}]`;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.test(key) ? REDACTED : redactValue(entry, depth + 1);
  }
  return out;
}

/** True if the text contains anything that looks like a secret. */
export function containsSecret(input: string): boolean {
  return redactText(input).matched.length > 0;
}
