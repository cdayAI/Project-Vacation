import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import {
  MAX_APPROVAL_EFFECTS,
  type ActionDescriptor,
  type ApprovalGuidance,
  type HumanInvolvement,
  type RiskTier,
} from "./types.js";

/**
 * The action registry.
 *
 * Every effect the platform can produce is declared here, with its risk tier
 * stated explicitly. The authorization chokepoint resolves actions through
 * this registry and refuses anything it does not find, so adding a new
 * capability requires a deliberate, reviewable entry in source control rather
 * than a new call site that quietly works.
 *
 * The default human-involvement policy by tier is:
 *
 *   routine           automatic
 *   sensitive         automatic, but never in shadow mode
 *   high_consequence  proposed_then_approved, with step-up re-authentication
 *   prohibited        refused unconditionally
 *
 * An entry may be stricter than its tier's default. It may not be laxer, and
 * `defineAction` enforces that.
 */

const DEFAULT_INVOLVEMENT: Record<RiskTier, HumanInvolvement> = {
  routine: "automatic",
  sensitive: "automatic",
  high_consequence: "proposed_then_approved",
  prohibited: "human_only",
};

const INVOLVEMENT_STRICTNESS: Record<HumanInvolvement, number> = {
  automatic: 0,
  proposed_then_approved: 1,
  human_only: 2,
};

export interface ActionDefinition {
  readonly name: string;
  readonly risk: RiskTier;
  readonly description: string;
  readonly reversible: boolean;
  readonly allowedRoles: readonly string[];
  readonly allowedModes?: readonly ActionDescriptor["allowedModes"][number][];
  readonly humanInvolvement?: HumanInvolvement;
  readonly requiresStepUp?: boolean;
  readonly approvalsRequired?: number;
  readonly integration?: string;
  readonly changesPlatformBehaviour?: boolean;
  readonly approvalGuidance?: ApprovalGuidance;
}

export function defineAction(definition: ActionDefinition): ActionDescriptor {
  const {
    name,
    risk,
    description,
    reversible,
    allowedRoles,
    allowedModes,
    humanInvolvement,
    requiresStepUp,
    approvalsRequired,
    integration,
    changesPlatformBehaviour,
    approvalGuidance,
  } = definition;

  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(name)) {
    throw new InvalidInputError(
      `Action name "${name}" must be dotted lower_snake_case, e.g. "contact.send_letter".`,
      "name",
    );
  }

  const involvement = humanInvolvement ?? DEFAULT_INVOLVEMENT[risk];
  if (INVOLVEMENT_STRICTNESS[involvement] < INVOLVEMENT_STRICTNESS[DEFAULT_INVOLVEMENT[risk]]) {
    throw new InvalidInputError(
      `Action "${name}" is ${risk} but declares humanInvolvement "${involvement}", which is weaker than the "${DEFAULT_INVOLVEMENT[risk]}" its tier requires. An action may be stricter than its tier, never laxer.`,
      "humanInvolvement",
    );
  }

  // An irreversible action always needs a human before the effect lands. It is
  // the one rule that cannot be relaxed by declaring a lower tier, because
  // "we cannot undo it" is a property of the world, not of the classification.
  if (!reversible && involvement === "automatic") {
    throw new InvalidInputError(
      `Action "${name}" is irreversible but declares humanInvolvement "automatic". Irreversible actions require an approval gate.`,
      "humanInvolvement",
    );
  }

  const resolvedApprovals = approvalsRequired ?? (involvement === "proposed_then_approved" ? 1 : 0);
  if (involvement === "proposed_then_approved" && resolvedApprovals < 1) {
    throw new InvalidInputError(
      `Action "${name}" requires approval but declares approvalsRequired ${resolvedApprovals}.`,
      "approvalsRequired",
    );
  }

  // Shadow mode means "the agent proposes, humans work as usual, nothing
  // lands". Any action with an external effect is therefore excluded from
  // shadow by default and must opt in explicitly if it genuinely has none.
  const resolvedModes =
    allowedModes ??
    (risk === "routine"
      ? (["shadow", "assisted", "supervised", "bounded_autonomy"] as const)
      : risk === "prohibited"
        ? ([] as const)
        : (["assisted", "supervised", "bounded_autonomy"] as const));

  // Guidance is validated when it is present but not demanded here, and the
  // distinction is deliberate. `defineAction` is called by tests and by
  // adapters with ad-hoc descriptors that never reach an approval screen, so a
  // hard requirement at this level would refuse a great deal of code that is
  // not wrong. The obligation belongs to the *shipped catalogue* instead:
  // `api/hero-screens.test.ts` asserts that every registered action which
  // parks for approval declares guidance, which is the population an approver
  // can actually meet.
  if (approvalGuidance) assertGuidance(name, approvalGuidance);

  return Object.freeze({
    name,
    risk,
    humanInvolvement: involvement,
    description,
    reversible,
    allowedRoles: Object.freeze([...allowedRoles]),
    allowedModes: Object.freeze([...resolvedModes]),
    requiresStepUp: requiresStepUp ?? risk === "high_consequence",
    approvalsRequired: resolvedApprovals,
    integration,
    changesPlatformBehaviour: changesPlatformBehaviour ?? false,
    approvalGuidance: approvalGuidance ? freezeGuidance(approvalGuidance) : undefined,
  });
}

function assertGuidance(name: string, guidance: ApprovalGuidance): void {
  for (const [field, value] of [
    ["ask", guidance.ask],
    ["ifRejected", guidance.ifRejected],
    ["reversal", guidance.reversal],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new InvalidInputError(
        `Action "${name}" declares approvalGuidance with an empty "${field}". A blank line on an approval screen reads as "nothing happens", which is never true of an action that needed approving.`,
        `approvalGuidance.${field}`,
      );
    }
  }
  if (guidance.effects.length === 0) {
    throw new InvalidInputError(
      `Action "${name}" declares no effects. An approver seeing an empty "If you approve" callout has been told the action is harmless.`,
      "approvalGuidance.effects",
    );
  }
  if (guidance.effects.length > MAX_APPROVAL_EFFECTS) {
    // Not a style rule. Past four bullets the callout is skimmed, and a
    // consequence nobody reads is the same as a consequence nobody was told.
    throw new InvalidInputError(
      `Action "${name}" declares ${guidance.effects.length} effects, past the ${MAX_APPROVAL_EFFECTS} an approver reads. Fold the detail into the artifact preview rather than lengthening the list.`,
      "approvalGuidance.effects",
    );
  }
  if (guidance.effects.some((effect) => effect.trim().length === 0)) {
    throw new InvalidInputError(
      `Action "${name}" declares a blank effect.`,
      "approvalGuidance.effects",
    );
  }
}

function freezeGuidance(guidance: ApprovalGuidance): ApprovalGuidance {
  return Object.freeze({
    ask: guidance.ask,
    effects: Object.freeze([...guidance.effects]),
    ifRejected: guidance.ifRejected,
    reversal: guidance.reversal,
  });
}

export class ActionRegistry {
  private readonly actions = new Map<string, ActionDescriptor>();

  constructor(definitions: readonly ActionDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ActionDefinition): ActionDescriptor {
    const descriptor = defineAction(definition);
    if (this.actions.has(descriptor.name)) {
      throw new InvalidInputError(
        `Action "${descriptor.name}" is already registered. Duplicate registration usually means two modules disagree about the same effect's risk tier.`,
        "name",
      );
    }
    this.actions.set(descriptor.name, descriptor);
    return descriptor;
  }

  /**
   * Look up an action.
   *
   * @throws {DeniedError} `authorization.risk_unclassified` if it is not
   *   registered. This is the "classified explicitly rather than defaulting"
   *   rule: an unknown action is refused, never assumed harmless.
   */
  require(name: string): ActionDescriptor {
    const descriptor = this.actions.get(name);
    if (!descriptor) {
      throw new DeniedError(
        "authorization.risk_unclassified",
        `Action "${name}" is not in the action registry. Every action must declare its risk tier before it can be performed.`,
        { action: name },
      );
    }
    return descriptor;
  }

  get(name: string): ActionDescriptor | undefined {
    return this.actions.get(name);
  }

  has(name: string): boolean {
    return this.actions.has(name);
  }

  list(): readonly ActionDescriptor[] {
    return [...this.actions.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
