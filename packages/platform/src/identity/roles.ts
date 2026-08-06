import { ConfigError, InvalidInputError } from "../kernel/errors.js";
import {
  isRoleName,
  SCOPE_PATTERN,
  type Capability,
  type RoleName,
  type Scope,
} from "./types.js";
import { capabilitiesFor } from "./types.js";

/**
 * Directory groups in, platform roles out.
 *
 * Access is provisioned by group membership in MVW's directory and nowhere
 * else. Nobody grants a role inside this platform — there is no screen for it
 * and no API for it — because the moment a role can be granted here, access
 * stops following the HR lifecycle. Someone who leaves the company is removed
 * from their directory groups by a process that already exists and is already
 * audited; that removal has to be sufficient. If we also kept our own grants,
 * offboarding would silently miss them.
 *
 * The consequences, stated plainly so nobody is surprised by them:
 *
 *   - A person whose groups map to nothing gets no roles, cannot do anything,
 *     and is recorded as deprovisioned. That is the correct outcome for a
 *     leaver and an annoying one for a new starter whose group has not been
 *     created yet. The fix is in the directory, not here.
 *   - Group changes take effect at the next sign-in for role *grants*, and
 *     immediately for role *removals*, because `SessionService` re-reads the
 *     actor on every request and a deprovisioned actor's sessions stop working
 *     at once. Grants are allowed to lag; removals are not. That asymmetry is
 *     deliberate.
 *
 * **Confirm with MVW before deployment.** Two things in this file are informed
 * guesses about someone else's directory and must not be treated as settled:
 *
 *   1. *Which claim carries groups.* Okta can emit a `groups` claim containing
 *      group names. Microsoft Entra ID emits `groups` containing group **object
 *      ids** by default, and emits names only when group claims are configured
 *      for that application — and it omits the claim entirely, substituting
 *      `_claim_names`/`_claim_sources`, once a user is in more than roughly 150
 *      groups. A deployment that silently receives no groups would deprovision
 *      every user, so `mapDirectoryGroups` reports an absent claim distinctly
 *      from an empty one and the caller refuses rather than treating it as "no
 *      groups".
 *   2. *The group naming convention.* The names below are placeholders in an
 *      obvious house style. MVW's real group names, and the identifier they use
 *      for an association, have to come from MVW.
 */

/**
 * One directory group, and what holding it grants.
 *
 * Matching is on the normalised form — trimmed and lower-cased — because
 * directory tooling is inconsistent about case and a mapping that fails on
 * `MVW-Supervisors` versus `mvw-supervisors` produces a support ticket that
 * looks like a permissions bug.
 */
export interface GroupRoleRule {
  readonly group: string;
  readonly roles: readonly RoleName[];
  /** Fixed scopes granted alongside the roles, e.g. a business line. */
  readonly scopes?: readonly Scope[];
  /** Why this mapping exists. Read by whoever reviews access next year. */
  readonly note: string;
}

/**
 * A family of groups that each carry their own data scope.
 *
 * An association manager is not entitled to "associations"; they are entitled
 * to the associations they manage. Rather than enumerating hundreds of rules,
 * one rule matches a prefix and derives the scope from what follows it.
 */
export interface GroupScopeRule {
  /** Normalised group prefix, e.g. `mvw-assoc-`. */
  readonly prefix: string;
  /** Scope kind the suffix is bound to, e.g. `association`. */
  readonly scopeKind: string;
  /** Roles implied by membership of any group in this family. */
  readonly roles: readonly RoleName[];
  readonly note: string;
}

export interface RoleMapping {
  /**
   * The ID-token claim that carries group membership.
   *
   * Configurable because Okta and Entra disagree, and because a deployment may
   * be told to read a purpose-built claim rather than the directory's default.
   */
  readonly groupClaim: string;
  readonly rules: readonly GroupRoleRule[];
  readonly scopeRules: readonly GroupScopeRule[];
}

export interface MappedEntitlements {
  readonly roles: readonly RoleName[];
  readonly scopes: readonly Scope[];
  readonly capabilities: readonly Capability[];
  /** Groups that matched a rule. Recorded so a grant can be explained. */
  readonly matchedGroups: readonly string[];
  /**
   * Groups that matched nothing.
   *
   * Surfaced rather than dropped: a group that nobody mapped is usually a new
   * team whose access request is sitting in a queue, and an administrator
   * needs to see it to act on it.
   */
  readonly unmappedGroups: readonly string[];
  /**
   * Groups that matched a scope family but whose suffix was refused.
   *
   * This is a control, not a diagnostic. A directory group named
   * `mvw-assoc-*` or `mvw-assoc-../../admin` would otherwise derive a scope
   * string that means something other than one association, and whoever can
   * name a group would be able to widen their own entitlement. Refused
   * suffixes grant nothing and are reported so the malformed group is noticed.
   */
  readonly rejectedGroups: readonly string[];
}

/**
 * The suffix of a scope-family group, after the prefix.
 *
 * Deliberately narrow. Everything outside this set — wildcards, separators,
 * whitespace, path traversal — is refused rather than escaped, because the
 * derived string is compared for equality against an entitlement and there is
 * no legitimate association identifier that needs a colon or an asterisk in it.
 */
const SCOPE_SUFFIX_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const GROUP_MAX_LENGTH = 256;

/**
 * The shipped mapping.
 *
 * A declarative artifact in version control, exactly like `actions.ts`: a
 * reviewer can read the complete set of ways a person can acquire access to
 * this platform in one place, and changing it is a pull request rather than a
 * database edit. A deployment overrides it with its own file; nothing reads
 * role assignments from a table.
 */
export const DEFAULT_ROLE_MAPPING: RoleMapping = Object.freeze({
  groupClaim: "groups",
  rules: Object.freeze([
    {
      group: "mvw-owner-services-agents",
      roles: ["owner_services_agent"],
      note: "Front-line owner services. Prepares work; sends nothing without a supervisor.",
    },
    {
      group: "mvw-owner-services-supervisors",
      roles: ["supervisor"],
      note: "Approves front-line work and operates the containment switches.",
    },
    {
      group: "mvw-compliance-reviewers",
      roles: ["compliance_reviewer"],
      note: "Reviews consumer-facing and legally significant work before it lands.",
    },
    {
      group: "mvw-finance",
      roles: ["finance"],
      note: "Reads cost and spend. No operational authority.",
    },
    {
      group: "mvw-platform-admins",
      roles: ["platform_admin"],
      note: "Operates the platform: configuration, credentials, containment.",
    },
    {
      group: "mvw-internal-audit",
      roles: ["auditor"],
      note: "Sees everything, changes nothing. Holds no mutating capability at all.",
    },
  ] as readonly GroupRoleRule[]),
  scopeRules: Object.freeze([
    {
      prefix: "mvw-assoc-",
      scopeKind: "association",
      roles: ["association_manager"],
      note: "One group per homeowners' association. Membership scopes the manager to that association only.",
    },
  ] as readonly GroupScopeRule[]),
});

function normaliseGroup(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Validate a mapping before anything depends on it.
 *
 * Called at construction rather than at first sign-in, so a malformed mapping
 * is a startup failure in every environment including a laptop — not a
 * permissions mystery discovered by the first person who tries to sign in.
 *
 * @throws {ConfigError} on any problem. A mapping that cannot be trusted must
 *   not be used to decide who gets in.
 */
export function assertMappingIsSound(mapping: RoleMapping): void {
  if (typeof mapping.groupClaim !== "string" || mapping.groupClaim.trim().length === 0) {
    throw new ConfigError(
      "The role mapping must name the ID-token claim that carries directory groups.",
      { field: "groupClaim" },
    );
  }

  const seen = new Set<string>();
  for (const rule of mapping.rules) {
    const group = normaliseGroup(rule.group);
    if (group.length === 0) {
      throw new ConfigError("A role-mapping rule has an empty group name.", { field: "group" });
    }
    if (seen.has(group)) {
      throw new ConfigError(
        `Directory group "${group}" is mapped twice. Two rules for one group means the grant depends on evaluation order, which is not something an access review can read.`,
        { group },
      );
    }
    seen.add(group);
    if (rule.roles.length === 0 && (rule.scopes ?? []).length === 0) {
      throw new ConfigError(
        `Directory group "${group}" is mapped to nothing. Remove the rule rather than leaving a mapping that grants no access.`,
        { group },
      );
    }
    for (const role of rule.roles) {
      if (!isRoleName(role)) {
        throw new ConfigError(
          `Directory group "${group}" maps to unknown role "${role}". A misspelled role grants nothing and looks like a permissions bug.`,
          { group, role },
        );
      }
    }
    for (const scope of rule.scopes ?? []) {
      if (!SCOPE_PATTERN.test(scope)) {
        throw new ConfigError(
          `Directory group "${group}" maps to malformed scope "${scope}". Scopes are "kind:value".`,
          { group, scope },
        );
      }
    }
  }

  const prefixes = new Set<string>();
  for (const rule of mapping.scopeRules) {
    const prefix = normaliseGroup(rule.prefix);
    if (prefix.length === 0) {
      throw new ConfigError("A scope rule has an empty group prefix, so it would match every group.", {
        field: "prefix",
      });
    }
    if (prefixes.has(prefix)) {
      throw new ConfigError(`Group prefix "${prefix}" is declared twice.`, { prefix });
    }
    prefixes.add(prefix);
    if (!/^[a-z][a-z0-9_]*$/.test(rule.scopeKind)) {
      throw new ConfigError(
        `Scope kind "${rule.scopeKind}" is malformed; it becomes the left half of a "kind:value" entitlement.`,
        { scopeKind: rule.scopeKind },
      );
    }
    for (const role of rule.roles) {
      if (!isRoleName(role)) {
        throw new ConfigError(
          `Group prefix "${prefix}" maps to unknown role "${role}".`,
          { prefix, role },
        );
      }
    }
  }
}

/**
 * Map the groups a provider asserted onto platform entitlements.
 *
 * Pure and total: it makes no decisions about sign-in, only about what the
 * asserted groups mean. The caller decides what to do when the result is
 * empty, because "this person has no access" is a policy question and this is
 * a translation.
 *
 * @throws {InvalidInputError} if `groups` is not an array of strings. A caller
 *   handing over a claim it has not validated is a bug worth stopping at.
 */
export function mapDirectoryGroups(
  groups: readonly string[],
  mapping: RoleMapping = DEFAULT_ROLE_MAPPING,
): MappedEntitlements {
  if (!Array.isArray(groups)) {
    throw new InvalidInputError(
      "Directory groups must be an array of strings; the group claim was not in the expected shape.",
      "groups",
    );
  }

  const byGroup = new Map<string, GroupRoleRule>();
  for (const rule of mapping.rules) byGroup.set(normaliseGroup(rule.group), rule);

  const roles = new Set<RoleName>();
  const scopes = new Set<Scope>();
  const matched: string[] = [];
  const unmapped: string[] = [];
  const rejected: string[] = [];

  for (const raw of groups) {
    if (typeof raw !== "string") {
      throw new InvalidInputError(
        `Directory group claim contained a ${typeof raw} rather than a string.`,
        "groups",
      );
    }
    // An absurdly long group name is either a mistake or an attempt to push
    // something through a downstream field. It grants nothing either way.
    if (raw.length > GROUP_MAX_LENGTH) {
      rejected.push(raw.slice(0, 64));
      continue;
    }

    const group = normaliseGroup(raw);
    if (group.length === 0) continue;

    const rule = byGroup.get(group);
    if (rule) {
      for (const role of rule.roles) roles.add(role);
      for (const scope of rule.scopes ?? []) scopes.add(scope);
      matched.push(group);
      continue;
    }

    const scopeRule = mapping.scopeRules.find((candidate) =>
      group.startsWith(normaliseGroup(candidate.prefix)),
    );
    if (!scopeRule) {
      unmapped.push(group);
      continue;
    }

    const suffix = group.slice(normaliseGroup(scopeRule.prefix).length);
    if (!SCOPE_SUFFIX_PATTERN.test(suffix)) {
      // The refusal that stops a group name from widening its own entitlement.
      rejected.push(group);
      continue;
    }

    const scope = `${scopeRule.scopeKind}:${suffix}`;
    if (!SCOPE_PATTERN.test(scope)) {
      rejected.push(group);
      continue;
    }
    for (const role of scopeRule.roles) roles.add(role);
    scopes.add(scope);
    matched.push(group);
  }

  const roleList = [...roles].sort();
  return {
    roles: roleList,
    scopes: [...scopes].sort(),
    capabilities: capabilitiesFor(roleList),
    matchedGroups: matched.sort(),
    unmappedGroups: unmapped.sort(),
    rejectedGroups: rejected.sort(),
  };
}

/**
 * True when the mapping produced nothing at all.
 *
 * The sign-in path treats this as "deprovisioned", which is the right reading
 * for a leaver and the honest reading for anyone else: the directory is not
 * asserting that this person belongs here.
 */
export function grantsNothing(entitlements: MappedEntitlements): boolean {
  return entitlements.roles.length === 0 && entitlements.scopes.length === 0;
}
