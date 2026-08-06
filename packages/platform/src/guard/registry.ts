import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { ActionDescriptor, HumanInvolvement, RiskTier } from "./types.js";

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
