import type { ActionRegistry } from "../guard/registry.js";
import type { ActionDescriptor, HumanInvolvement, RiskTier } from "../guard/types.js";
import { InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import { RISK_RANK, type RoleDefinition } from "./types.js";

/**
 * Drafting a role from a plain-language brief.
 *
 * The promise is that MVW can add capability without an engineering cycle: an
 * administrator describes the job, and the platform assembles a candidate role
 * definition for a person to review.
 *
 * **A draft is a proposal. It is never a live role.**
 *
 * That is a structural property here, not a policy someone remembers. This
 * module imports the action registry and nothing else. It has no store, no
 * authorizer, no promotion service, and no clock — so there is no code path
 * from a brief to something that can act, and a test in this module reads this
 * file's own source to keep it that way. Everything a draft can become still
 * has to pass through `RoleRegistry.createRole` (which produces a `draft`) and
 * then `RolePromotionService.promote` (which demands evidence and a human
 * approval through the chokepoint).
 *
 * Two rules bound what the matcher may do.
 *
 * *It selects, it does not invent.* Candidate actions come from the action
 * registry — the platform's declared capability surface. A brief describing
 * something the platform cannot do produces a refusal, not a role with an
 * imaginary action on it.
 *
 * *It never reaches above `sensitive` from prose.* The matcher scores word
 * overlap; it does not understand negation, conditionals, or sarcasm, so "do
 * not contact owners" and "contact owners" look much the same to it. Rather
 * than pretending otherwise, anything `high_consequence` must be named
 * explicitly by the administrator in `mustInclude`, where the intent is
 * unambiguous. The limitation is stated here rather than papered over, because
 * a matcher that inferred consumer-facing authority from a sentence would be
 * the single worst component in this platform.
 *
 * Drafts also start in `shadow` mode only. A proposal that arrived ready to
 * act would make the review a formality.
 */

/** Words that carry no signal about which capability is wanted. */
const STOPWORDS = new Set([
  "a", "about", "after", "all", "also", "an", "and", "any", "anything", "are", "as", "at",
  "be", "been", "before", "but", "by", "can", "do", "does", "each", "every", "for", "from",
  "get", "has", "have", "if", "in", "into", "is", "it", "its", "just", "make", "may", "must",
  "need", "needs", "no", "not", "of", "on", "only", "or", "our", "out", "over", "should",
  "so", "some", "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "those", "to", "up", "use", "using", "want", "was", "we", "were", "what", "when",
  "where", "which", "while", "who", "will", "with", "would", "you", "your",
]);

/** Weight given to a match on the action's name versus its description. */
const NAME_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;
/** Below this an overlap is coincidence rather than intent. */
const MIN_SCORE = 3;
/** Roles are few and purposeful; a draft that reached for everything is not one. */
const MAX_DRAFTED_ACTIONS = 6;

const MIN_DESCRIPTION_LENGTH = 20;
const MAX_DESCRIPTION_LENGTH = 4_000;

const INVOLVEMENT_STRICTNESS: Readonly<Record<HumanInvolvement, number>> = {
  automatic: 0,
  proposed_then_approved: 1,
  human_only: 2,
};

export interface RoleBrief {
  /** The machine name the role will carry. Not inferred from prose. */
  readonly name: string;
  /** What the administrator typed, in their own words. */
  readonly description: string;
  /**
   * Data scopes being granted.
   *
   * Never inferred. Entitlement to data is a decision a person makes
   * explicitly; a matcher that granted `scope:legal` because the brief said
   * "legal" would be guessing about access control.
   */
  readonly dataScopes: readonly string[];
  /** Logical task from the model inventory. Never a model identifier. */
  readonly modelTask: string;
  readonly promptTemplateId: string;
  readonly promptTemplateVersion: number;
  /** The golden set this role will be measured against before it can act. */
  readonly evaluationSetId: string;
  /**
   * Actions the administrator names explicitly.
   *
   * The only route to a `high_consequence` action in a draft. Still refused if
   * the action is prohibited or above `maxRisk`.
   */
  readonly mustInclude?: readonly string[] | undefined;
  /** Actions the administrator rules out, whatever the brief seems to say. */
  readonly exclude?: readonly string[] | undefined;
  /** The highest tier the administrator is willing to grant. Default `sensitive`. */
  readonly maxRisk?: RiskTier | undefined;
}

/** One action the matcher considered, and why. */
export interface ActionMatch {
  readonly action: string;
  readonly risk: RiskTier;
  readonly score: number;
  /** Brief terms that put this action on the list. Shown to the reviewer. */
  readonly matchedTerms: readonly string[];
  readonly selected: boolean;
  /** Why it was left out, when it was. */
  readonly excludedBecause?: string | undefined;
}

/**
 * The output of drafting.
 *
 * Deliberately not a `RoleVersion`. It has no identifier, no status, and no
 * place in the store — someone has to take it, read it, and register it, and
 * registering it produces a `draft` that still cannot act.
 */
export interface RoleDraft {
  /** There is no value of this field that means "live". */
  readonly kind: "proposal";
  readonly definition: RoleDefinition;
  /** Things the reviewer must decide, in the order they should read them. */
  readonly warnings: readonly string[];
  /** Every action considered, selected or not, with the reason. */
  readonly considered: readonly ActionMatch[];
  /** Fingerprint of the brief this was drafted from. */
  readonly briefDigest: Digest;
}

/**
 * Draft a role definition from a brief.
 *
 * Pure: no clock, no identifiers, no persistence. The same brief and the same
 * action registry always produce the same draft, which is what lets the seeded
 * demo include role authoring and still reproduce byte for byte.
 *
 * @throws {InvalidInputError} when the brief is unusably short or long, names
 *   an action the platform has not declared, names a prohibited action, or
 *   matches nothing at all. A brief that matches nothing produces a refusal
 *   rather than an empty role: the platform cannot do what was asked, and
 *   saying so is more useful than drafting a role that does nothing.
 */
export function draftRole(brief: RoleBrief, actions: ActionRegistry): RoleDraft {
  const description = typeof brief.description === "string" ? brief.description.trim() : "";
  if (description.length < MIN_DESCRIPTION_LENGTH || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new InvalidInputError(
      `Describe the job in ${MIN_DESCRIPTION_LENGTH} to ${MAX_DESCRIPTION_LENGTH} characters. A one-word brief cannot be matched to a capability, and a document-length one is not a role.`,
      "description",
    );
  }

  const maxRisk: RiskTier = brief.maxRisk ?? "sensitive";
  if (maxRisk === "prohibited") {
    throw new InvalidInputError(
      "A brief cannot raise its ceiling to \"prohibited\". Prohibited actions are refused to every caller, and no configuration enables them.",
      "maxRisk",
    );
  }
  const maxRank = RISK_RANK[maxRisk];
  const excluded = new Set(brief.exclude ?? []);
  const briefTerms = terms(description);

  const considered: ActionMatch[] = [];
  const selected: ActionDescriptor[] = [];

  // Explicit inclusions first. These are the administrator's own words about
  // intent rather than the matcher's reading of a sentence, so they are the
  // only route to anything high-consequence.
  for (const name of brief.mustInclude ?? []) {
    const descriptor = actions.require(name);
    if (descriptor.risk === "prohibited") {
      throw new InvalidInputError(
        `Action "${name}" is prohibited by this platform. It cannot be granted to a role by naming it.`,
        "mustInclude",
      );
    }
    if (RISK_RANK[descriptor.risk] > maxRank) {
      throw new InvalidInputError(
        `Action "${name}" is ${descriptor.risk}, above the ceiling of ${maxRisk} this brief is willing to grant. Raise the ceiling deliberately or leave the action out.`,
        "mustInclude",
      );
    }
    if (excluded.has(name)) {
      throw new InvalidInputError(
        `Action "${name}" is in both mustInclude and exclude.`,
        "mustInclude",
      );
    }
    if (selected.some((entry) => entry.name === name)) continue;
    selected.push(descriptor);
    considered.push({
      action: name,
      risk: descriptor.risk,
      score: Number.POSITIVE_INFINITY,
      matchedTerms: [],
      selected: true,
    });
  }

  // Then the matcher, over everything the platform has declared it can do.
  const scored: { descriptor: ActionDescriptor; score: number; matched: string[] }[] = [];
  for (const descriptor of actions.list()) {
    if (selected.some((entry) => entry.name === descriptor.name)) continue;

    const { score, matched } = scoreAction(descriptor, briefTerms);
    if (score < MIN_SCORE) continue;

    if (descriptor.risk === "prohibited") {
      considered.push({
        action: descriptor.name,
        risk: descriptor.risk,
        score,
        matchedTerms: matched,
        selected: false,
        excludedBecause: "prohibited by this platform",
      });
      continue;
    }
    if (excluded.has(descriptor.name)) {
      considered.push({
        action: descriptor.name,
        risk: descriptor.risk,
        score,
        matchedTerms: matched,
        selected: false,
        excludedBecause: "ruled out by the brief",
      });
      continue;
    }
    if (RISK_RANK[descriptor.risk] > RISK_RANK["sensitive"]) {
      // The matcher does not understand negation. Anything consumer-facing or
      // irreversible has to be named by a person, where the intent is not a
      // reading of a sentence.
      considered.push({
        action: descriptor.name,
        risk: descriptor.risk,
        score,
        matchedTerms: matched,
        selected: false,
        excludedBecause:
          "high-consequence actions are never inferred from prose; name it explicitly if it is intended",
      });
      continue;
    }
    if (RISK_RANK[descriptor.risk] > maxRank) {
      considered.push({
        action: descriptor.name,
        risk: descriptor.risk,
        score,
        matchedTerms: matched,
        selected: false,
        excludedBecause: `above the ${maxRisk} ceiling this brief grants`,
      });
      continue;
    }
    scored.push({ descriptor, score, matched });
  }

  // Highest score first, action name as the tiebreak so the draft is stable.
  scored.sort((left, right) =>
    left.score !== right.score
      ? right.score - left.score
      : left.descriptor.name < right.descriptor.name
        ? -1
        : 1,
  );

  for (const candidate of scored) {
    const room = MAX_DRAFTED_ACTIONS - selected.length;
    if (room <= 0) {
      considered.push({
        action: candidate.descriptor.name,
        risk: candidate.descriptor.risk,
        score: candidate.score,
        matchedTerms: candidate.matched,
        selected: false,
        excludedBecause: `the draft already holds ${MAX_DRAFTED_ACTIONS} actions`,
      });
      continue;
    }
    selected.push(candidate.descriptor);
    considered.push({
      action: candidate.descriptor.name,
      risk: candidate.descriptor.risk,
      score: candidate.score,
      matchedTerms: candidate.matched,
      selected: true,
    });
  }

  if (selected.length === 0) {
    throw new InvalidInputError(
      `Nothing in the action registry matches this brief, so no role was drafted. The platform can only compose capabilities it has already declared — if the job needs something new, that is an engineering change with its own review, not a role.`,
      "description",
    );
  }

  // The draft claims the lowest ceiling that covers what it selected, not the
  // highest the brief was willing to grant. Granting headroom nobody asked for
  // is how a role ends up able to do something nobody intended.
  let ceiling: RiskTier = "routine";
  let humanTier: HumanInvolvement = "automatic";
  for (const descriptor of selected) {
    if (RISK_RANK[descriptor.risk] > RISK_RANK[ceiling]) ceiling = descriptor.risk;
    if (
      INVOLVEMENT_STRICTNESS[descriptor.humanInvolvement] > INVOLVEMENT_STRICTNESS[humanTier]
    ) {
      humanTier = descriptor.humanInvolvement;
    }
  }

  const definition: RoleDefinition = {
    name: brief.name,
    purpose: description,
    actions: selected.map((descriptor) => descriptor.name).sort(),
    riskCeiling: ceiling,
    dataScopes: [...brief.dataScopes].sort(),
    modelTask: brief.modelTask,
    promptTemplateId: brief.promptTemplateId,
    promptTemplateVersion: brief.promptTemplateVersion,
    evaluationSetId: brief.evaluationSetId,
    humanTier,
    // Shadow only. A proposal that arrived ready to act would make its review a
    // formality; widening this is a deliberate edit a person makes.
    operatingModes: ["shadow"],
  };

  const warnings: string[] = [
    "This is a proposal. It cannot act until it has been evaluated against its golden set and a person with authority has approved its promotion.",
    "Drafted in shadow mode only. Widen the operating modes deliberately once the evaluation results have been read.",
  ];

  const weakest = scored.length > 0 ? scored[scored.length - 1] : undefined;
  if (weakest && weakest.score < MIN_SCORE * 2 && weakest.matched.length <= 1) {
    warnings.push(
      `"${weakest.descriptor.name}" matched on a single term (${weakest.matched.join(", ")}). Confirm it belongs in this role.`,
    );
  }
  const inferredHighConsequence = considered.filter(
    (entry) => !entry.selected && entry.risk === "high_consequence",
  );
  if (inferredHighConsequence.length > 0) {
    warnings.push(
      `The brief reads as though it may involve ${inferredHighConsequence.map((entry) => `"${entry.action}"`).join(", ")}, which this platform never infers from prose. Name those actions explicitly if they are intended.`,
    );
  }
  if (ceiling === "high_consequence") {
    warnings.push(
      "This role reaches the high-consequence tier, so every one of those actions parks for a human approval before it lands. Confirm the approver roles are staffed before promoting it.",
    );
  }
  if (definition.dataScopes.length === 0) {
    warnings.push(
      "No data scopes were granted. If this role needs to read scoped data, add the scopes deliberately — they are never inferred from the description.",
    );
  }

  return {
    kind: "proposal",
    definition,
    warnings,
    considered: considered.sort((left, right) =>
      left.action < right.action ? -1 : left.action > right.action ? 1 : 0,
    ),
    briefDigest: digestValue({
      name: brief.name,
      description,
      dataScopes: [...brief.dataScopes].sort(),
      modelTask: brief.modelTask,
      promptTemplateId: brief.promptTemplateId,
      promptTemplateVersion: brief.promptTemplateVersion,
      evaluationSetId: brief.evaluationSetId,
      mustInclude: [...(brief.mustInclude ?? [])].sort(),
      exclude: [...(brief.exclude ?? [])].sort(),
      maxRisk,
    }),
  };
}

function scoreAction(
  descriptor: ActionDescriptor,
  briefTerms: ReadonlySet<string>,
): { score: number; matched: string[] } {
  const nameTerms = terms(descriptor.name.replace(/[._]/g, " "));
  const descriptionTerms = terms(descriptor.description);

  let score = 0;
  const matched = new Set<string>();
  for (const term of nameTerms) {
    if (briefTerms.has(term)) {
      score += NAME_WEIGHT;
      matched.add(term);
    }
  }
  for (const term of descriptionTerms) {
    if (nameTerms.has(term)) continue;
    if (briefTerms.has(term)) {
      score += DESCRIPTION_WEIGHT;
      matched.add(term);
    }
  }
  return { score, matched: [...matched].sort() };
}

/** Lower-case, split, drop stopwords, and stem crudely. */
function terms(text: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    found.add(stem(raw));
  }
  return found;
}

/**
 * Crude suffix stripping so "reviewer" matches "review" and "owners" matches
 * "owner". Deliberately simple: a real stemmer would be a dependency and a
 * source of surprise, and this only has to bring two English words close
 * enough to score. Both the brief and the action text go through it, so any
 * inaccuracy is at least symmetric.
 */
function stem(word: string): string {
  for (const suffix of ["ers", "ing", "ies", "ed", "er", "es", "s"]) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}
