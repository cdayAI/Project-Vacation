import { decision } from "../audit/log.js";
import type { AuditLog } from "../audit/log.js";
import type { Authorizer } from "../guard/authorize.js";
import type { ActionDefinition } from "../guard/registry.js";
import { screen } from "../guard/screen.js";
import type { RiskTier } from "../guard/types.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import type { ActorRef, IsoTimestamp, OperatingMode } from "../record/types.js";
import type { EnrollmentStore } from "./port.js";
import type {
  BudgetPeriod,
  EnrolledAgent,
  EnrollmentUpdate,
  ExternalAgentId,
  ToolGrant,
} from "./types.js";

/**
 * The enrollment lifecycle for agents MVW runs elsewhere.
 *
 * Enrollment is the whole basis of admission. An unenrolled caller is refused,
 * there is no anonymous access, and there is no default-allow — so every
 * property this plane claims (a named accountable owner, a spend ceiling, a
 * risk ceiling, an expiry, a kill switch) is a property of the registry entry
 * created here.
 *
 * Three rules shape this file, and each closes a specific way an enrollment
 * system stops meaning anything.
 *
 * **Re-enrollment is narrow.** It updates ceilings and metadata. It never
 * resets a spend meter and never lifts a containment or a revocation. If it did
 * either, "re-enroll" would be the documented way around a limit, and the
 * limits would be advisory. `applyUpdate` builds the patch field by field from
 * a whitelist and *refuses* — rather than ignores — a caller that sends a
 * status or a meter field, because silently dropping it would leave the
 * operator believing something happened that did not.
 *
 * **Expiry is data, not a job.** No sweeper marks an agent expired. Admission
 * compares `expiresAt` against the clock at the moment of the request, so an
 * expired agent is refused even if every background process in the deployment
 * is down. A control that depends on a cron job running is a control that is
 * off whenever the cron job is off.
 *
 * **Containment is fast; revocation is deliberate.** Containing is a `sensitive`
 * action an operator can take alone in seconds, because a supervisor watching
 * an external agent misbehave must not wait for a second signature. Revoking is
 * `high_consequence` and needs an approval, because it is terminal: a revoked
 * agent never acts again and the record says who decided that. The fast control
 * and the permanent one are deliberately different actions with different gates.
 */

// ---------------------------------------------------------------------------
// Registered actions
// ---------------------------------------------------------------------------

/** Roles as the action registry spells them. */
const SUPERVISOR = "supervisor";
const COMPLIANCE = "compliance_reviewer";
const ADMIN = "platform_admin";

export const ENROLL_ACTION = "external_agent.enroll";
export const RE_ENROLL_ACTION = "external_agent.re_enroll";
export const CONTAIN_ACTION = "external_agent.contain";
export const RELEASE_ACTION = "external_agent.release";
export const REVOKE_ACTION = "external_agent.revoke";

/**
 * The governed actions of the external-agent lifecycle.
 *
 * Exported as data so the composition root registers them alongside every
 * other action the platform can perform, in one reviewable list. Nothing here
 * registers itself: an action that is not in the registry is refused by the
 * chokepoint, and that has to stay true of these too.
 */
export const EXTERNAL_AGENT_ACTIONS: readonly ActionDefinition[] = [
  {
    name: ENROLL_ACTION,
    risk: "high_consequence",
    description:
      "Admit an external agent to the platform, with a spend ceiling, a risk ceiling, a tool grant, and an expiry. Nothing an unenrolled agent asks for is served.",
    reversible: true,
    allowedRoles: [ADMIN, SUPERVISOR],
    approvalsRequired: 1,
    changesPlatformBehaviour: true,
    approvalGuidance: {
      ask: "Admit an external agent to the platform",
      effects: [
        "The agent takes a seat against the deployment's cap and may present credentials from that moment.",
        "It may call only the tools in the grant on this proposal, within the risk ceiling, the data scopes, and the spend ceiling named here.",
        "Everything it does lands on this platform's operating record and audit chain, marked as external work.",
      ],
      ifRejected:
        "The agent stays unenrolled and every request it makes is refused. Its seat is not taken.",
      reversal:
        "Contain it to stop it at the next admission check, or revoke the enrolment to end it permanently and return the seat.",
    },
  },
  {
    name: RE_ENROLL_ACTION,
    risk: "sensitive",
    description:
      "Adjust an enrolled agent's ceilings, tool grant, scopes, or expiry. Never resets a spend meter and never changes status.",
    reversible: true,
    allowedRoles: [ADMIN, SUPERVISOR],
  },
  {
    name: CONTAIN_ACTION,
    risk: "sensitive",
    description:
      "Stop an external agent at its next heartbeat or admission check. Deliberately not gated on an approval: a stop button that needs a second signature is not a stop button.",
    reversible: true,
    allowedRoles: [ADMIN, SUPERVISOR, COMPLIANCE],
  },
  {
    name: RELEASE_ACTION,
    risk: "sensitive",
    description: "Let a contained external agent act again.",
    reversible: true,
    allowedRoles: [ADMIN, SUPERVISOR, COMPLIANCE],
  },
  {
    name: REVOKE_ACTION,
    risk: "high_consequence",
    description:
      "End an external agent's enrollment permanently. Terminal: the agent never acts again and its seat returns to the cap.",
    reversible: false,
    allowedRoles: [ADMIN, SUPERVISOR],
    approvalsRequired: 1,
    changesPlatformBehaviour: true,
    approvalGuidance: {
      ask: "End an external agent's enrolment for good",
      effects: [
        "The agent stops working immediately, including any runs in flight, which are reclaimed rather than left open.",
        "Its credentials stop verifying at the next admission check and cannot be reinstated.",
        "Its seat returns to the deployment's cap.",
      ],
      ifRejected:
        "The agent keeps its enrolment and continues to act within its grant. Contain it instead if the intent was to stop it while the question is settled.",
      reversal:
        "Revocation is terminal. A new enrolment can be created for the same vendor, but it is a new agent with new credentials and a new record.",
    },
  },
];

// ---------------------------------------------------------------------------
// Input guards for the external plane
// ---------------------------------------------------------------------------
//
// These live beside the enrollment service because enrollment is the base of
// this plane — every other service here already depends on the agent registry,
// so putting the shared guards here adds no edge to the dependency graph.

/** Longest any single free-text field may be before it is refused. */
export const MAX_FIELD_LENGTH = 4_000;

/**
 * Refuse a string that is absent, blank, oversized, or carries control
 * characters.
 *
 * Control characters are refused rather than stripped: a name containing a
 * newline renders as two lines in a console and as one value in a database, and
 * the difference between those two readings is where a spoofed roster entry
 * lives.
 */
export function boundedText(
  field: string,
  value: unknown,
  max: number,
  options: { readonly multiline?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new InvalidInputError(`${field} must be a string, received ${typeof value}.`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidInputError(`${field} must not be blank.`, field);
  }
  if (trimmed.length > max) {
    throw new InvalidInputError(
      `${field} is ${trimmed.length} characters, past the ${max}-character limit. Oversized input is refused rather than truncated: a truncated field is screened only in part, and the part that was cut is the part an attacker chose.`,
      field,
    );
  }
  // Written as escapes rather than literal characters on purpose: as literals
  // they would be invisible in a diff, and a reviewer could not tell whether
  // the set had been widened or narrowed. Prose keeps tab and newline;
  // everything else — a name, a tool, a scope — takes neither.
  //
  // The lint rule below exists to catch control characters that arrived in a
  // pattern by accident. Here they are the entire subject of the pattern.
  /* eslint-disable no-control-regex */
  const controls = options.multiline
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
    : /[\u0000-\u001F\u007F]/;
  /* eslint-enable no-control-regex */
  if (controls.test(trimmed)) {
    throw new InvalidInputError(
      `${field} contains control characters, which are refused. They render one way in a console, another in a log, and a third in a database, and the gap between those readings is where a spoofed record hides.`,
      field,
    );
  }
  return trimmed;
}

/**
 * Bound a field, then pass it through the boundary screen.
 *
 * The order is the point and it is never the other way round. Screening first
 * would mean the screen decides how much text to look at, and an attacker who
 * can make the payload longer than the scan window can push the interesting
 * part past it. Bounding first means the screen always sees the whole field.
 *
 * @throws {DeniedError} `screen.injection_detected` or `screen.unavailable`.
 *   A screen that could not answer has not answered "clean".
 */
export function screenedText(field: string, value: unknown, max: number): string {
  const bounded = boundedText(field, value, max, { multiline: true });
  return screen(bounded, { maxLength: max }).text;
}

const TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse a caller-supplied timestamp into the canonical UTC form.
 *
 * An ISO-8601 string with no timezone designator is interpreted in the *local*
 * zone by every JavaScript runtime, so `2026-08-06T12:00:00` means a different
 * instant on a laptop in Munich and a container in Virginia. An external agent
 * supplies these, we do not control what it sends, and a statutory deadline
 * computed from a silently shifted instant is the kind of error that is only
 * discovered in a deposition. So a designator is required rather than assumed.
 */
export function normaliseTimestamp(field: string, value: unknown): IsoTimestamp {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidInputError(`${field} must be an ISO-8601 timestamp.`, field);
  }
  const text = value.trim();
  if (!TIMEZONE_SUFFIX.test(text)) {
    throw new InvalidInputError(
      `${field} has no timezone designator. "${text}" would be read in whichever zone the reading machine happens to sit in, which is a different instant on every host.`,
      field,
    );
  }
  const parsed = new Date(text);
  const millis = parsed.getTime();
  if (!Number.isFinite(millis)) {
    throw new InvalidInputError(`${field} is not a parseable timestamp: "${text}".`, field);
  }
  return parsed.toISOString();
}

/** Refuse an amount that is not a finite, non-negative number within its cap. */
export function boundedMoney(field: string, value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidInputError(`${field} must be a finite number.`, field);
  }
  if (value < 0) {
    throw new InvalidInputError(
      `${field} must not be negative. A negative amount buys back headroom under a ceiling that was never released.`,
      field,
    );
  }
  if (value > max) {
    throw new InvalidInputError(`${field} is ${value}, past the configured maximum of ${max}.`, field);
  }
  return value;
}

/**
 * Bound a subject map — the opaque references saying what a piece of work was
 * about.
 *
 * Both the key count and each value's length are bounded, because bounding only
 * the values leaves the count carrying the payload instead: ten thousand keys
 * of a hundred characters is a megabyte assembled entirely from legal fields.
 */
export function boundedSubject(
  field: string,
  value: unknown,
  maxKeys: number,
  maxLength: number,
): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidInputError(`${field} must be an object of string references.`, field);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxKeys) {
    throw new InvalidInputError(
      `${field} has ${entries.length} keys, past the limit of ${maxKeys}.`,
      field,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    const name = boundedText(`${field} key`, key, 64);
    out[name] = boundedText(`${field}.${name}`, entry, maxLength);
  }
  return out;
}

/** Refuse a count that is not a positive integer within its cap. */
export function boundedCount(field: string, value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InvalidInputError(`${field} must be a positive integer.`, field);
  }
  if (value > max) {
    throw new InvalidInputError(`${field} is ${value}, past the configured maximum of ${max}.`, field);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Admissibility
// ---------------------------------------------------------------------------

/**
 * Why this agent must not act right now, or null if it may.
 *
 * One function, consulted by admission, by the heartbeat kill switch, and by
 * report ingestion, so the three can never disagree about what "may act" means.
 * Expiry is evaluated here, against the clock, rather than by a background job.
 */
export function stopReasonFor(agent: EnrolledAgent, nowIso: IsoTimestamp): string | null {
  if (agent.status === "revoked") {
    return `enrollment revoked${agent.statusReason ? `: ${agent.statusReason}` : ""}`;
  }
  if (agent.status === "contained") {
    return `agent contained${agent.statusReason ? `: ${agent.statusReason}` : ""}`;
  }
  // String comparison is correct here because both sides are canonical UTC
  // ISO-8601, which sorts lexicographically in time order. Parsing to compare
  // would introduce a second interpretation of a value we already normalised.
  if (agent.expiresAt <= nowIso) {
    return `enrollment expired at ${agent.expiresAt}`;
  }
  return null;
}

/**
 * Refuse unless the agent may act.
 *
 * @throws {DeniedError} `authorization.action_not_permitted`.
 */
export function assertAdmissible(agent: EnrolledAgent, nowIso: IsoTimestamp): void {
  const reason = stopReasonFor(agent, nowIso);
  if (reason) {
    throw new DeniedError(
      "authorization.action_not_permitted",
      `External agent ${agent.id} ("${agent.name}") may not act: ${reason}.`,
      { agentId: agent.id, status: agent.status, reason },
    );
  }
}

/**
 * The meter key for an agent's current budget period.
 *
 * `lifetime` for a lifetime budget, `YYYY-MM` for a monthly one. Derived from
 * the timestamp rather than stored, so a month boundary needs no job to cross.
 */
export function budgetPeriodKey(period: BudgetPeriod, nowIso: IsoTimestamp): string {
  return period === "lifetime" ? "lifetime" : nowIso.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

/**
 * Ceilings on the ceilings.
 *
 * Every one of these is a hard maximum an operator cannot exceed through the
 * enrollment form, so the worst enrollment anybody can create by mistake is
 * still bounded. Missing or nonsensical configuration is a startup failure:
 * a seat cap of zero would refuse everything and a cap of `undefined` would
 * refuse nothing, and only one of those is a safe way to be wrong.
 */
export interface EnrollmentLimits {
  /** Seats available to external agents. Enforced atomically at claim time. */
  readonly seatCap: number;
  readonly maxEnrollmentDays: number;
  readonly maxSpendCeilingUsd: number;
  readonly maxWallClockCeilingMs: number;
  readonly maxToolGrants: number;
  readonly maxDataScopes: number;
}

/** Who is acting, and what they hold. Threaded to the chokepoint unchanged. */
export interface OperatorContext {
  readonly actor: ActorRef;
  /** For step-up on high-consequence actions. */
  readonly secondsSinceAuthentication?: number | undefined;
  /** The approval raised against this proposal's digest. */
  readonly approvalId?: Id<"approval"> | undefined;
  readonly correlationId?: string | undefined;
}

export interface EnrollRequest {
  readonly name: string;
  readonly owner: string;
  readonly department: string;
  readonly hostPlatform: string;
  readonly purpose: string;
  readonly allowedTools: readonly ToolGrant[];
  readonly riskCeiling: RiskTier;
  readonly spendCeilingUsd: number;
  readonly budgetPeriod: BudgetPeriod;
  readonly wallClockCeilingMs: number;
  readonly dataScopes: readonly string[];
  readonly expiresAt: IsoTimestamp;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
const SCOPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * Local parts that name a queue rather than a person.
 *
 * The registry entry says the owner is "the person accountable for this agent.
 * Never a shared mailbox." A shared mailbox is not accountable: when the agent
 * does something regulated at 2am, "who owns this?" has to resolve to somebody
 * who can be woken up, and `support@` cannot be woken up.
 */
const SHARED_MAILBOXES = new Set([
  "admin",
  "alerts",
  "billing",
  "contact",
  "devnull",
  "help",
  "helpdesk",
  "hello",
  "info",
  "it",
  "mail",
  "noreply",
  "no-reply",
  "notifications",
  "ops",
  "sales",
  "security",
  "support",
  "team",
]);

/** Fields a re-enrollment may set. Anything else is refused, not ignored. */
const UPDATABLE_FIELDS: readonly (keyof EnrollmentUpdate)[] = [
  "owner",
  "department",
  "hostPlatform",
  "purpose",
  "allowedTools",
  "riskCeiling",
  "spendCeilingUsd",
  "budgetPeriod",
  "wallClockCeilingMs",
  "dataScopes",
  "expiresAt",
];

/**
 * Fields a caller might send hoping re-enrollment applies them.
 *
 * Named explicitly so the refusal is specific. These are the two routes around
 * the plane's limits — clear the meter, or clear the containment — and both are
 * refused with a message that says so rather than with "unknown field".
 */
const FORBIDDEN_UPDATE_FIELDS = new Set([
  "id",
  "name",
  "status",
  "statusReason",
  "statusChangedAt",
  "statusChangedBy",
  "spentUsd",
  "spendUsd",
  "spend",
  "meter",
  "periodKey",
  "enrolledAt",
  "enrolledBy",
  "updatedAt",
  "lastSeenAt",
]);

export class EnrollmentService {
  private readonly limits: EnrollmentLimits;

  constructor(
    private readonly agents: EnrollmentStore,
    private readonly authorizer: Authorizer,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    limits: EnrollmentLimits,
    /** The deployment's operating mode, passed to the chokepoint unchanged. */
    private readonly mode: OperatingMode,
  ) {
    this.limits = assertLimits(limits);
  }

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  /**
   * Fetch an agent, refusing rather than returning null.
   *
   * @throws {DeniedError} `authorization.action_not_permitted` when the agent
   *   is not enrolled. An unenrolled caller is refused; there is no path in
   *   which "we could not find you" becomes "carry on".
   */
  async require(id: ExternalAgentId): Promise<EnrolledAgent> {
    const agent = await this.agents.getAgent(id);
    if (!agent) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `No external agent is enrolled under ${id}. Enrollment is the basis of admission, so an unknown caller is refused rather than treated as a new one.`,
        { agentId: id },
      );
    }
    return agent;
  }

  /** Fetch an agent and refuse unless it may act right now. */
  async requireAdmissible(id: ExternalAgentId): Promise<EnrolledAgent> {
    const agent = await this.require(id);
    assertAdmissible(agent, this.clock.nowIso());
    return agent;
  }

  list(filter?: Parameters<EnrollmentStore["listAgents"]>[0]): Promise<readonly EnrolledAgent[]> {
    return this.agents.listAgents(filter);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Admit a new external agent.
   *
   * The order of operations is deliberate. Validation refuses for free.
   * The seat is claimed next, atomically, because two concurrent enrollments
   * that each counted rows and then inserted would both see room under the cap
   * and both succeed — which makes the commercial term unenforceable at exactly
   * the moment it matters. Only then is the action authorised, because
   * authorising consumes a human's approval and approvals are single-use: a
   * seat can be given back, a burned approval cannot.
   *
   * @throws {DeniedError} when the cap is reached, when the name is taken, or
   *   on any refusal from the chokepoint.
   */
  async enroll(context: OperatorContext, request: EnrollRequest): Promise<EnrolledAgent> {
    const proposal = this.normaliseEnrollment(request);

    // Cheap refusal first. The store's uniqueness constraint is the real
    // guarantee against a concurrent duplicate; this check exists so the
    // ordinary case gets a message naming the clash instead of a store error.
    const clash = await this.agents.getAgentByName(proposal.name);
    if (clash) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `An external agent named "${proposal.name}" is already enrolled (${clash.id}). Names are the handle operators use in the roster, in an incident, and in the audit chain, so two agents may not share one.`,
        { name: proposal.name, agentId: clash.id },
      );
    }

    const claimed = await this.agents.claimSeat(this.limits.seatCap);
    if (!claimed) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `All ${this.limits.seatCap} external-agent seats are in use. Revoke an agent that is no longer needed, or raise the configured cap deliberately.`,
        { seatCap: this.limits.seatCap },
      );
    }

    try {
      await this.authorizer.authorize({
        action: ENROLL_ACTION,
        actor: context.actor,
        mode: this.mode,
        correlationId: context.correlationId,
        subject: { externalAgentName: proposal.name, department: proposal.department },
        proposalDigest: enrollmentProposalDigest(request),
        approvalId: context.approvalId,
        secondsSinceAuthentication: context.secondsSinceAuthentication,
      });

      const now = this.clock.nowIso();
      const agent: EnrolledAgent = {
        id: this.ids.next("externalAgent"),
        ...proposal,
        status: "active",
        enrolledBy: context.actor.actorId,
        enrolledAt: now,
        updatedAt: now,
      };
      return await this.agents.createAgent(agent);
    } catch (error) {
      // Give the seat back. It was claimed to win a race we then aborted, and
      // a seat held by an enrollment that never existed shrinks the cap by one
      // permanently — silently, and only under failure, which is the hardest
      // kind of counting error to notice.
      await this.releaseSeatQuietly();
      throw error;
    }
  }

  /**
   * Update ceilings and metadata on an enrolled agent.
   *
   * Never touches the spend meter and never touches status. Those two
   * exclusions are the reason this method is narrow rather than a general
   * update: if re-enrolling could clear a meter or lift a containment, then
   * every limit in this plane would have a documented bypass with an audit
   * entry that reads like routine maintenance.
   */
  async reEnroll(
    context: OperatorContext,
    id: ExternalAgentId,
    update: EnrollmentUpdate,
  ): Promise<EnrolledAgent> {
    const current = await this.require(id);

    if (current.status === "revoked") {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `External agent ${id} is revoked. Revocation is terminal: re-enrolling a revoked agent would make revocation a pause, and a pause is what containment is for. Enroll a new agent instead.`,
        { agentId: id, status: current.status },
      );
    }

    const patch = this.normaliseUpdate(update, current);

    await this.authorizer.authorize({
      action: RE_ENROLL_ACTION,
      actor: context.actor,
      mode: this.mode,
      correlationId: context.correlationId,
      subject: { externalAgentId: id, externalAgentName: current.name },
      secondsSinceAuthentication: context.secondsSinceAuthentication,
    });

    const updated = await this.agents.updateAgent(id, patch, this.clock.nowIso());

    // Belt and braces on the store's side of the same promise. A store that
    // moved status here would defeat the whole rule quietly; catching it as an
    // invariant violation at the one call site is cheap.
    if (updated.status !== current.status) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `Re-enrollment changed external agent ${id} from ${current.status} to ${updated.status}. Re-enrollment adjusts ceilings; it does not change status, and a store that does is not usable here.`,
        { agentId: id, from: current.status, to: updated.status },
      );
    }

    return updated;
  }

  /**
   * Stop an agent at its next heartbeat or admission check.
   *
   * Conditional on the status the caller last saw, so a containment decided
   * from a stale read cannot clobber a revocation another operator already
   * applied. A second containment of an already-contained agent is not an
   * error: an operator pressing stop twice must never see a message that
   * suggests the first press did not take.
   */
  async contain(
    context: OperatorContext,
    id: ExternalAgentId,
    reason: string,
  ): Promise<EnrolledAgent> {
    const current = await this.require(id);
    const because = boundedText("reason", reason, MAX_FIELD_LENGTH);

    if (current.status === "revoked") {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `External agent ${id} is already revoked, which stops it more completely than containment does.`,
        { agentId: id, status: current.status },
      );
    }
    if (current.status === "contained") return current;

    await this.authorizer.authorize({
      action: CONTAIN_ACTION,
      actor: context.actor,
      mode: this.mode,
      correlationId: context.correlationId,
      subject: { externalAgentId: id, externalAgentName: current.name },
      secondsSinceAuthentication: context.secondsSinceAuthentication,
    });

    const contained = await this.agents.setAgentStatus({
      id,
      expectedStatus: "active",
      status: "contained",
      reason: because,
      by: context.actor.actorId,
      at: this.clock.nowIso(),
    });

    if (!contained) {
      // Somebody else moved it between our read and our write. Re-read rather
      // than retry: if they revoked it, containment is already satisfied, and
      // forcing our transition on top would downgrade a terminal state.
      return this.reconcileLostTransition(id, "contain");
    }

    await this.audit.record(
      decision({
        eventType: "containment.engaged",
        actorId: context.actor.actorId,
        actorKind: context.actor.kind,
        actorRoles: context.actor.roles,
        correlationId: context.correlationId,
        subject: { externalAgentId: id, principal: "external" },
        decision: {
          scope: "external_agent",
          status: "contained",
          previousStatus: current.status,
          automatic: false,
          reason: because,
        },
      }),
    );

    return contained;
  }

  /** Let a contained agent act again. Refused for a revoked one. */
  async release(
    context: OperatorContext,
    id: ExternalAgentId,
    reason: string,
  ): Promise<EnrolledAgent> {
    const current = await this.require(id);
    const because = boundedText("reason", reason, MAX_FIELD_LENGTH);

    if (current.status === "revoked") {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `External agent ${id} is revoked. Revocation is terminal and there is no release from it — bringing the agent back is a fresh enrollment, which is another deliberate, approved decision rather than a status flip.`,
        { agentId: id, status: current.status },
      );
    }
    if (current.status === "active") return current;

    await this.authorizer.authorize({
      action: RELEASE_ACTION,
      actor: context.actor,
      mode: this.mode,
      correlationId: context.correlationId,
      subject: { externalAgentId: id, externalAgentName: current.name },
      secondsSinceAuthentication: context.secondsSinceAuthentication,
    });

    const released = await this.agents.setAgentStatus({
      id,
      expectedStatus: "contained",
      status: "active",
      reason: because,
      by: context.actor.actorId,
      at: this.clock.nowIso(),
    });

    if (!released) return this.reconcileLostTransition(id, "release");

    await this.audit.record(
      decision({
        eventType: "containment.released",
        actorId: context.actor.actorId,
        actorKind: context.actor.kind,
        actorRoles: context.actor.roles,
        correlationId: context.correlationId,
        subject: { externalAgentId: id, principal: "external" },
        decision: {
          scope: "external_agent",
          status: "active",
          previousStatus: current.status,
          reason: because,
        },
      }),
    );

    return released;
  }

  /**
   * End an enrollment permanently.
   *
   * Terminal, and reachable from `active` or `contained` — an operator should
   * not have to release an agent in order to revoke it. The seat returns to the
   * cap on the transition that actually happened, never on a repeat call, so a
   * revocation retried after a timeout cannot inflate the seat count.
   */
  async revoke(
    context: OperatorContext,
    id: ExternalAgentId,
    reason: string,
  ): Promise<EnrolledAgent> {
    const current = await this.require(id);
    const because = boundedText("reason", reason, MAX_FIELD_LENGTH);

    // Idempotent before authorising: re-revoking is a no-op, and burning a
    // second human approval to achieve nothing is a good way to teach operators
    // that approvals are noise.
    if (current.status === "revoked") return current;

    await this.authorizer.authorize({
      action: REVOKE_ACTION,
      actor: context.actor,
      mode: this.mode,
      correlationId: context.correlationId,
      subject: { externalAgentId: id, externalAgentName: current.name },
      proposalDigest: revocationProposalDigest(id, because),
      approvalId: context.approvalId,
      secondsSinceAuthentication: context.secondsSinceAuthentication,
    });

    const revoked = await this.agents.setAgentStatus({
      id,
      expectedStatus: current.status,
      status: "revoked",
      reason: because,
      by: context.actor.actorId,
      at: this.clock.nowIso(),
    });

    if (!revoked) {
      // The status moved under us — an operator contained it, or the rate
      // limiter did. Re-read and try once against what is there now. Revocation
      // is the strongest state, so it never loses to what it finds.
      const latest = await this.require(id);
      if (latest.status === "revoked") return latest;
      const second = await this.agents.setAgentStatus({
        id,
        expectedStatus: latest.status,
        status: "revoked",
        reason: because,
        by: context.actor.actorId,
        at: this.clock.nowIso(),
      });
      if (!second) {
        throw new DeniedError(
          "authorization.action_not_permitted",
          `External agent ${id} changed status twice while it was being revoked. Nothing was written; read the roster and try again rather than assuming the revocation landed.`,
          { agentId: id },
        );
      }
      await this.recordRevocation(context, second, latest.status, because);
      await this.releaseSeatQuietly();
      return second;
    }

    await this.recordRevocation(context, revoked, current.status, because);
    await this.releaseSeatQuietly();
    return revoked;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async recordRevocation(
    context: OperatorContext,
    agent: EnrolledAgent,
    previousStatus: EnrolledAgent["status"],
    reason: string,
  ): Promise<void> {
    await this.audit.record(
      decision({
        eventType: "containment.engaged",
        actorId: context.actor.actorId,
        actorKind: context.actor.kind,
        actorRoles: context.actor.roles,
        correlationId: context.correlationId,
        subject: { externalAgentId: agent.id, principal: "external" },
        decision: {
          scope: "external_agent",
          status: "revoked",
          previousStatus,
          terminal: true,
          reason,
        },
      }),
    );
  }

  /**
   * Work out what to report when a conditional transition found a different
   * status than the caller last read.
   */
  private async reconcileLostTransition(
    id: ExternalAgentId,
    attempted: "contain" | "release",
  ): Promise<EnrolledAgent> {
    const latest = await this.require(id);
    if (attempted === "contain" && latest.status !== "active") return latest;
    if (attempted === "release" && latest.status === "active") return latest;
    throw new DeniedError(
      "authorization.action_not_permitted",
      `External agent ${id} changed status while it was being ${attempted === "contain" ? "contained" : "released"}; it is now ${latest.status}. Nothing was written.`,
      { agentId: id, status: latest.status },
    );
  }

  private async releaseSeatQuietly(): Promise<void> {
    try {
      await this.agents.releaseSeat();
    } catch {
      // allow-swallow: whatever brought us here — a denial from the chokepoint,
      // a failed insert — is the outcome the caller has to see. A seat we could
      // not hand back is a counting error an operator can correct from the
      // roster; replacing the real cause with it would hide why the enrollment
      // or revocation actually failed.
    }
  }

  /** Validate and canonicalise a whole enrollment. */
  private normaliseEnrollment(
    request: EnrollRequest,
  ): Omit<EnrolledAgent, "id" | "status" | "enrolledBy" | "enrolledAt" | "updatedAt"> {
    if (!request || typeof request !== "object") {
      throw new InvalidInputError("An enrollment request is required.", "request");
    }

    const name = boundedText("name", request.name, 64).toLowerCase();
    if (!NAME_PATTERN.test(name)) {
      throw new InvalidInputError(
        `Agent name "${name}" must be 3-64 characters of lowercase letters, digits, dot, underscore, or hyphen, starting and ending alphanumeric. Names are compared case-insensitively so two agents cannot differ only in capitalisation on a roster somebody reads under pressure.`,
        "name",
      );
    }

    const owner = assertAccountableOwner(request.owner);
    const department = boundedText("department", request.department, 128);
    const hostPlatform = boundedText("hostPlatform", request.hostPlatform, 128);
    // The purpose is free text an operator writes and an approver reads on the
    // way to saying yes. It is bounded and screened like any other text that
    // reaches a human decision surface.
    const purpose = screenedText("purpose", request.purpose, 2_000);

    const riskCeiling = assertRiskCeiling(request.riskCeiling);
    const allowedTools = this.normaliseTools(request.allowedTools);
    const dataScopes = this.normaliseScopes(request.dataScopes);

    const spendCeilingUsd = boundedMoney(
      "spendCeilingUsd",
      request.spendCeilingUsd,
      this.limits.maxSpendCeilingUsd,
    );
    const wallClockCeilingMs = boundedCount(
      "wallClockCeilingMs",
      request.wallClockCeilingMs,
      this.limits.maxWallClockCeilingMs,
    );
    const budgetPeriod = assertBudgetPeriod(request.budgetPeriod);
    const expiresAt = this.assertExpiry(request.expiresAt);

    return {
      name,
      owner,
      department,
      hostPlatform,
      purpose,
      allowedTools,
      riskCeiling,
      spendCeilingUsd,
      budgetPeriod,
      wallClockCeilingMs,
      dataScopes,
      expiresAt,
    };
  }

  /**
   * Build a re-enrollment patch from a whitelist.
   *
   * Field by field rather than a spread. A spread would carry whatever the
   * caller sent — including `status` or a meter field from a JSON body nobody
   * typed — straight into the store, which is precisely the bypass this method
   * exists to prevent.
   */
  private normaliseUpdate(update: EnrollmentUpdate, current: EnrolledAgent): EnrollmentUpdate {
    if (!update || typeof update !== "object") {
      throw new InvalidInputError("A re-enrollment update is required.", "update");
    }

    const allowed = new Set<string>(UPDATABLE_FIELDS as readonly string[]);
    for (const key of Object.keys(update)) {
      if (FORBIDDEN_UPDATE_FIELDS.has(key)) {
        throw new DeniedError(
          "authorization.action_not_permitted",
          `Re-enrollment cannot set "${key}". Re-enrolling adjusts ceilings and metadata; it never resets a spend meter and never changes status. Use contain, release, or revoke for status, and note that there is no operation anywhere that clears a meter.`,
          { agentId: current.id, field: key },
        );
      }
      if (!allowed.has(key)) {
        throw new InvalidInputError(
          `Re-enrollment does not understand the field "${key}".`,
          key,
        );
      }
    }

    const patch: Record<string, unknown> = {};
    if (update.owner !== undefined) patch["owner"] = assertAccountableOwner(update.owner);
    if (update.department !== undefined) {
      patch["department"] = boundedText("department", update.department, 128);
    }
    if (update.hostPlatform !== undefined) {
      patch["hostPlatform"] = boundedText("hostPlatform", update.hostPlatform, 128);
    }
    if (update.purpose !== undefined) {
      patch["purpose"] = screenedText("purpose", update.purpose, 2_000);
    }
    if (update.allowedTools !== undefined) {
      patch["allowedTools"] = this.normaliseTools(update.allowedTools);
    }
    if (update.riskCeiling !== undefined) {
      patch["riskCeiling"] = assertRiskCeiling(update.riskCeiling);
    }
    if (update.spendCeilingUsd !== undefined) {
      patch["spendCeilingUsd"] = boundedMoney(
        "spendCeilingUsd",
        update.spendCeilingUsd,
        this.limits.maxSpendCeilingUsd,
      );
    }
    if (update.budgetPeriod !== undefined) {
      patch["budgetPeriod"] = assertBudgetPeriod(update.budgetPeriod);
    }
    if (update.wallClockCeilingMs !== undefined) {
      patch["wallClockCeilingMs"] = boundedCount(
        "wallClockCeilingMs",
        update.wallClockCeilingMs,
        this.limits.maxWallClockCeilingMs,
      );
    }
    if (update.dataScopes !== undefined) {
      patch["dataScopes"] = this.normaliseScopes(update.dataScopes);
    }
    if (update.expiresAt !== undefined) {
      // Renewal, deliberately. Extending an expiry is what re-enrollment is
      // for, and it is not the same as lifting a containment: an expired agent
      // was never stopped for cause, it simply ran out of term.
      patch["expiresAt"] = this.assertExpiry(update.expiresAt);
    }

    if (Object.keys(patch).length === 0) {
      throw new InvalidInputError(
        "A re-enrollment must change something. An empty update would write a new `updatedAt` and nothing else, which reads in the roster like a review that happened.",
        "update",
      );
    }

    return patch as EnrollmentUpdate;
  }

  private normaliseTools(tools: readonly ToolGrant[] | undefined): readonly ToolGrant[] {
    if (!Array.isArray(tools)) {
      throw new InvalidInputError(
        "allowedTools must be an array. It may be empty, which grants no tools.",
        "allowedTools",
      );
    }
    if (tools.length > this.limits.maxToolGrants) {
      throw new InvalidInputError(
        `allowedTools has ${tools.length} entries, past the limit of ${this.limits.maxToolGrants}.`,
        "allowedTools",
      );
    }

    const seen = new Set<string>();
    const grants: ToolGrant[] = [];
    for (const [index, grant] of tools.entries()) {
      if (!grant || typeof grant !== "object") {
        throw new InvalidInputError(`allowedTools[${index}] must be an object.`, "allowedTools");
      }
      const tool = boundedText(`allowedTools[${index}].tool`, grant.tool, 128);
      if (!TOOL_PATTERN.test(tool)) {
        throw new InvalidInputError(
          `allowedTools[${index}].tool "${tool}" is not a usable tool name.`,
          "allowedTools",
        );
      }
      if (seen.has(tool)) {
        throw new InvalidInputError(
          `allowedTools names "${tool}" twice. Two grants for one tool means two operator risk ratings for it, and nothing here should have to guess which one wins.`,
          "allowedTools",
        );
      }
      seen.add(tool);
      grants.push({
        tool,
        operatorRisk: grant.operatorRisk === undefined ? undefined : assertTier(grant.operatorRisk),
        note: grant.note === undefined ? undefined : boundedText("note", grant.note, 512),
      });
    }
    // Sorted so two enrollments listing the same tools in different orders
    // produce the same record and the same proposal digest — an approval binds
    // to that digest, and key order must not be able to void one.
    grants.sort((left, right) => left.tool.localeCompare(right.tool));
    return Object.freeze(grants);
  }

  private normaliseScopes(scopes: readonly string[] | undefined): readonly string[] {
    if (!Array.isArray(scopes)) {
      throw new InvalidInputError(
        "dataScopes must be an array. It may be empty, which entitles the agent to nothing.",
        "dataScopes",
      );
    }
    if (scopes.length > this.limits.maxDataScopes) {
      throw new InvalidInputError(
        `dataScopes has ${scopes.length} entries, past the limit of ${this.limits.maxDataScopes}.`,
        "dataScopes",
      );
    }
    const unique = new Set<string>();
    for (const [index, scope] of scopes.entries()) {
      const value = boundedText(`dataScopes[${index}]`, scope, 64);
      if (!SCOPE_PATTERN.test(value)) {
        throw new InvalidInputError(
          `dataScopes[${index}] "${value}" is not a scope name. Scopes are bare names; the chokepoint adds the "scope:" prefix when it matches them against what an actor holds.`,
          "dataScopes",
        );
      }
      unique.add(value);
    }
    return Object.freeze([...unique].sort());
  }

  private assertExpiry(value: unknown): IsoTimestamp {
    const expiresAt = normaliseTimestamp("expiresAt", value);
    const nowIso = this.clock.nowIso();
    if (expiresAt <= nowIso) {
      throw new InvalidInputError(
        `expiresAt ${expiresAt} is not in the future. An enrollment that is already expired admits nothing, which is a confusing way to say "denied".`,
        "expiresAt",
      );
    }
    const ceiling = new Date(this.clock.now() + this.limits.maxEnrollmentDays * 86_400_000)
      .toISOString();
    if (expiresAt > ceiling) {
      throw new InvalidInputError(
        `expiresAt ${expiresAt} is further out than the ${this.limits.maxEnrollmentDays}-day maximum. A term long enough that nobody reviews it is the same as no term at all.`,
        "expiresAt",
      );
    }
    return expiresAt;
  }
}

// ---------------------------------------------------------------------------
// Proposal digests
// ---------------------------------------------------------------------------

/**
 * The digest an enrollment approval binds to.
 *
 * Exported so the console can raise the approval against exactly the proposal
 * it is showing the approver. Computed from the *raw* request the caller will
 * later submit, so approving and enrolling agree byte for byte or the
 * chokepoint refuses.
 */
export function enrollmentProposalDigest(request: EnrollRequest): Digest {
  return digestValue({
    action: ENROLL_ACTION,
    name: typeof request.name === "string" ? request.name.trim().toLowerCase() : request.name,
    owner: request.owner,
    department: request.department,
    hostPlatform: request.hostPlatform,
    purpose: request.purpose,
    allowedTools: request.allowedTools,
    riskCeiling: request.riskCeiling,
    spendCeilingUsd: request.spendCeilingUsd,
    budgetPeriod: request.budgetPeriod,
    wallClockCeilingMs: request.wallClockCeilingMs,
    dataScopes: request.dataScopes,
    expiresAt: request.expiresAt,
  });
}

/** The digest a revocation approval binds to. */
export function revocationProposalDigest(id: ExternalAgentId, reason: string): Digest {
  return digestValue({ action: REVOKE_ACTION, agentId: id, reason: reason.trim() });
}

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

function assertLimits(limits: EnrollmentLimits): EnrollmentLimits {
  if (!limits || typeof limits !== "object") {
    throw new DeniedError(
      "config.invalid",
      "The external-agent plane needs enrollment limits. Absent limits would mean an unbounded seat cap, an unbounded spend ceiling, and an enrollment that never expires — three defaults nobody chose.",
      {},
    );
  }
  const fields: readonly (keyof EnrollmentLimits)[] = [
    "seatCap",
    "maxEnrollmentDays",
    "maxSpendCeilingUsd",
    "maxWallClockCeilingMs",
    "maxToolGrants",
    "maxDataScopes",
  ];
  for (const field of fields) {
    const value = limits[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new DeniedError(
        "config.invalid",
        `External-agent limit "${field}" must be a positive number, received: ${String(value)}.`,
        { field },
      );
    }
  }
  return limits;
}

function assertTier(value: unknown): RiskTier {
  if (
    value !== "routine" &&
    value !== "sensitive" &&
    value !== "high_consequence" &&
    value !== "prohibited"
  ) {
    throw new InvalidInputError(`"${String(value)}" is not a risk tier.`, "riskCeiling");
  }
  return value;
}

function assertRiskCeiling(value: unknown): RiskTier {
  const tier = assertTier(value);
  if (tier === "prohibited") {
    throw new InvalidInputError(
      'A risk ceiling of "prohibited" would admit an agent to a tier the platform refuses unconditionally. Set the ceiling to the highest tier the agent may actually reach.',
      "riskCeiling",
    );
  }
  return tier;
}

function assertBudgetPeriod(value: unknown): BudgetPeriod {
  if (value !== "monthly" && value !== "lifetime") {
    throw new InvalidInputError(
      `"${String(value)}" is not a budget period; use "monthly" or "lifetime".`,
      "budgetPeriod",
    );
  }
  return value;
}

/**
 * Refuse an owner that is a queue, a list, or a placeholder.
 *
 * @see SHARED_MAILBOXES for why.
 */
function assertAccountableOwner(value: unknown): string {
  const owner = boundedText("owner", value, 254);
  if (/[,;]/.test(owner)) {
    throw new InvalidInputError(
      `owner "${owner}" names more than one party. Accountability that is shared between two names in a text field is accountability nobody holds.`,
      "owner",
    );
  }
  const at = owner.lastIndexOf("@");
  if (at > 0) {
    const local = owner.slice(0, at).toLowerCase();
    if (SHARED_MAILBOXES.has(local)) {
      throw new InvalidInputError(
        `owner "${owner}" is a shared mailbox. The owner of an external agent is the person who will be asked what it did, and a shared mailbox cannot answer that question at two in the morning.`,
        "owner",
      );
    }
  }
  return owner;
}
