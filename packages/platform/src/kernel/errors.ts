/**
 * Error taxonomy.
 *
 * The platform's central design rule is "fail closed": missing config, an
 * unreadable store, a broken screen, or an unavailable receipt must refuse the
 * action rather than proceed unrecorded. That rule is only real if refusal is
 * a distinct, catchable thing rather than a generic Error that some caller
 * eventually swallows.
 *
 * `DeniedError` is therefore the base for every "we did not do it" outcome,
 * and every denial carries a machine-readable `reason` so the console and the
 * audit record can explain the refusal without parsing prose.
 */

/** Stable, machine-readable denial reasons. */
export type DenialReason =
  | "authorization.action_not_permitted"
  | "authorization.risk_unclassified"
  | "authorization.data_scope_violation"
  | "authorization.step_up_required"
  | "approval.required"
  | "approval.expired"
  | "approval.already_used"
  | "approval.digest_mismatch"
  | "approval.self_approval"
  | "approval.insufficient_approvers"
  | "ceiling.spend_exceeded"
  | "ceiling.rate_exceeded"
  | "ceiling.time_exceeded"
  | "containment.global_pause"
  | "containment.workflow_disabled"
  | "containment.role_disabled"
  | "containment.integration_revoked"
  | "screen.injection_detected"
  | "screen.unavailable"
  | "sandbox.execution_disabled"
  | "sandbox.policy_violation"
  | "knowledge.no_grounding"
  | "knowledge.stale_authority"
  | "contact.no_consent"
  | "contact.revoked"
  | "contact.do_not_call"
  | "contact.quiet_hours"
  | "contact.frequency_cap"
  | "contact.evidence_unavailable"
  | "role.not_promoted"
  | "role.ceiling_exceeded"
  | "model.not_in_inventory"
  | "model.provider_unavailable"
  | "integration.host_not_allowlisted"
  | "integration.credential_missing"
  | "improvement.evaluation_regression"
  | "improvement.protected_case_weakened"
  | "improvement.autonomous_application"
  | "discovery.not_enrolled"
  | "discovery.excluded_field"
  | "discovery.feature_disabled"
  | "record.unavailable"
  | "config.missing"
  | "config.invalid";

/**
 * The platform refused to act.
 *
 * Anything that catches this and continues is a bug: a denial means the effect
 * did not happen and must not be reported as though it did.
 */
export class DeniedError extends Error {
  readonly reason: DenialReason;
  /** Non-sensitive structured context, safe to log and to show an operator. */
  readonly detail: Record<string, string | number | boolean>;

  constructor(
    reason: DenialReason,
    message: string,
    detail: Record<string, string | number | boolean> = {},
  ) {
    super(message);
    this.name = "DeniedError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Configuration was missing or unusable. Always fatal at startup. */
export class ConfigError extends DeniedError {
  constructor(message: string, detail: Record<string, string | number | boolean> = {}) {
    super("config.missing", message, detail);
    this.name = "ConfigError";
  }
}

/**
 * A caller supplied something structurally invalid.
 *
 * Distinct from `DeniedError`: this is "your request does not make sense",
 * not "your request is not permitted". Keeping them apart matters because
 * denials are security-relevant events worth alerting on and validation
 * failures generally are not.
 */
export class InvalidInputError extends Error {
  readonly field: string;

  constructor(message: string, field = "") {
    super(message);
    this.name = "InvalidInputError";
    this.field = field;
  }
}

/**
 * An invariant the platform guarantees was violated.
 *
 * These indicate a bug in the platform rather than bad input or a policy
 * refusal, and should page rather than be handled.
 */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

/** Narrowing helper for call sites that must distinguish refusal from failure. */
export function isDenied(error: unknown): error is DeniedError {
  return error instanceof DeniedError;
}
