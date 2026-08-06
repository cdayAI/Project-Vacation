import { DeniedError } from "../kernel/errors.js";

/**
 * How identity expresses a refusal.
 *
 * `DenialReason` in `kernel/errors.ts` is a shared, closed taxonomy: the
 * console renders it, the audit view groups by it, and alerting rules match on
 * it. Widening it with a dozen identity-specific codes would make every one of
 * those places need to learn about sign-in internals to say anything useful.
 *
 * So every identity refusal is `authorization.action_not_permitted` — which is
 * exactly what happened — and names the specific failed check in
 * `detail.check`. An operator sees "sign-in refused: nonce_mismatch"; a
 * dashboard sees one reason code it already understands.
 *
 * What is deliberately *not* here is a variant that returns rather than
 * throws. Every caller of these paths is deciding whether someone is allowed
 * in, and a refusal that can be ignored by forgetting to check a return value
 * is not a refusal.
 */
export function identityRefusal(
  check: string,
  message: string,
  detail: Record<string, string | number | boolean> = {},
): DeniedError {
  return new DeniedError("authorization.action_not_permitted", message, { check, ...detail });
}
