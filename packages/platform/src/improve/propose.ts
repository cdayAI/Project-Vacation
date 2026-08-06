import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { Authorizer } from "../guard/authorize.js";
import { canonicalJson } from "../kernel/canonical.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import type { PromptTemplateRegistry } from "../models/templates.js";
import type { ActorRef, OperatingMode } from "../record/types.js";
import { assertGoldenSet, assertGoldenSetNotWeakened } from "../roles/evaluation.js";
import type { EvaluationStore, RoleStore } from "../roles/port.js";
import type { GoldenCase, GoldenSet } from "../roles/types.js";
import { PROPOSE_ACTION } from "./actions.js";
import {
  artifactDigest,
  artifactState,
  assertArtifactContent,
  assertMutableArtifact,
  type GovernedArtifacts,
} from "./artifacts.js";
import type { ObservationStore, ProposalStore } from "./port.js";
import type {
  ArtifactContent,
  ArtifactState,
  ArtifactTarget,
  Proposal,
} from "./types.js";

/**
 * Stage three: propose.
 *
 * A candidate change: a prompt revision, a new evaluation case, a rule
 * adjustment, a routing change, or a knowledge-corpus gap to fill.
 *
 * **A proposal is inert data.** What this module returns has no `apply`, no
 * `execute`, and no handle to anything that has one. It is frozen before it is
 * returned, so a caller cannot bolt a method onto it and pass it on as though
 * the platform provided one. Applying a proposal requires `apply.ts`, an
 * approval id, and a trip through the authorization chokepoint — a separate
 * code path with a person's decision in the middle of it.
 *
 * The refusals here are the "no self-modifying code" boundary, applied at the
 * earliest possible moment:
 *
 *   a kind that is not a declarative artifact        refused
 *   an identifier shaped like a file path            refused
 *   content carrying prompt text                     refused
 *   a prompt binding naming an uncommitted prompt    refused
 *   a golden-set change that weakens existing ground truth   refused
 *   a proposal citing evidence that is not in the record     refused
 *
 * The last one is not a formality. A proposal is a request for a person's
 * attention, and the currency of that request is evidence. One citing
 * observations nobody can open is an assertion, and this platform does not act
 * on assertions.
 */

const MAX_RATIONALE_LENGTH = 1000;
const MAX_OBSERVATIONS_CITED = 200;

export interface DraftProposalInput {
  readonly target: ArtifactTarget;
  /** The role whose measured quality this change will be judged by. */
  readonly roleId: Id<"role">;
  readonly roleVersion: number;
  /** The cluster this came from, so a reviewer can see the pattern. */
  readonly clusterKey: string;
  /** The observations that justify it. At least one, and each must exist. */
  readonly observationIds: readonly Id<"observation">[];
  readonly rationale: string;
  /** The proposed new body of the artifact. */
  readonly content: ArtifactContent;
  /**
   * Cases to ADD to the golden set, for an `evaluation_case` proposal.
   *
   * Additions only. The guard in `roles/evaluation.ts` refuses anything that
   * deletes, relabels, weakens, or renames an existing case, and it runs here
   * and again at apply time.
   */
  readonly addedCases?: readonly GoldenCase[] | undefined;
  readonly createdBy: ActorRef;
  readonly mode: OperatingMode;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export interface ProposalDrafterDependencies {
  readonly proposals: ProposalStore;
  readonly observations: ObservationStore;
  readonly artifacts: GovernedArtifacts;
  readonly roles: RoleStore;
  readonly evaluations: EvaluationStore;
  readonly templates: PromptTemplateRegistry;
  readonly authorizer: Authorizer;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class ProposalDrafter {
  constructor(private readonly deps: ProposalDrafterDependencies) {}

  /**
   * Draft a candidate change.
   *
   * @throws {DeniedError} `improvement.autonomous_application` when the target
   *   is not a declarative artifact, `improvement.protected_case_weakened` when
   *   a golden-set change would weaken existing ground truth, and
   *   `record.unavailable` when the role, the artifact, or the cited evidence
   *   is not in the record.
   * @throws {InvalidInputError} on a malformed rationale, content, or a
   *   proposal that changes nothing.
   */
  async draft(input: DraftProposalInput): Promise<Proposal> {
    // The boundary first, before anything is read or written. A proposal
    // targeting the platform's source is refused before it has cost anybody a
    // database round trip.
    assertMutableArtifact(input.target);
    assertArtifactContent(input.target.kind, input.content);
    assertRationale(input.rationale);

    const role = await this.deps.roles.requireRole(input.roleId);
    await this.deps.roles.requireVersion(input.roleId, input.roleVersion);
    await this.requireEvidence(input.observationIds);

    const { before, after } = await this.resolveStates(input);

    // Compared on content rather than on the digests: the digests always differ
    // because the version number is part of them, so comparing those would let
    // a version bump with an identical body through as a "change".
    if (canonicalJson(before.content) === canonicalJson(after.content)) {
      throw new InvalidInputError(
        `This proposal leaves artifact "${input.target.id}" exactly as it is. A change that changes nothing still costs a reviewer their attention.`,
        "content",
      );
    }

    await this.deps.authorizer.authorize({
      action: PROPOSE_ACTION,
      actor: input.createdBy,
      mode: input.mode,
      runId: input.runId,
      correlationId: input.correlationId,
      subject: {
        roleId: role.id,
        roleName: role.name,
        artifactKind: input.target.kind,
        artifactId: input.target.id,
      },
      secondsSinceAuthentication: input.secondsSinceAuthentication,
    });

    const id = this.deps.ids.next("proposal");
    const proposal: Proposal = {
      id,
      status: "drafted",
      target: { kind: input.target.kind, id: input.target.id },
      roleId: role.id,
      roleVersion: input.roleVersion,
      clusterKey: input.clusterKey,
      observationIds: [...input.observationIds],
      rationale: input.rationale,
      before,
      after,
      addedCases: input.addedCases ? input.addedCases.map((entry) => ({ ...entry })) : undefined,
      digest: changeDigest({
        proposalId: id,
        target: input.target,
        roleId: role.id,
        roleVersion: input.roleVersion,
        beforeDigest: before.digest,
        afterDigest: after.digest,
        addedCases: input.addedCases,
      }),
      createdAt: this.deps.clock.nowIso(),
      createdBy: input.createdBy,
    };

    const created = await this.deps.proposals.createProposal(proposal);

    await this.deps.audit.record(
      auditDecision({
        eventType: "improvement.proposal_created",
        actorId: input.createdBy.actorId,
        actorKind: input.createdBy.kind,
        actorRoles: input.createdBy.roles,
        runId: input.runId,
        correlationId: input.correlationId,
        subject: {
          proposalId: created.id,
          roleId: role.id,
          roleName: role.name,
          artifactKind: input.target.kind,
          artifactId: input.target.id,
          clusterKey: input.clusterKey,
        },
        inputDigests: {
          before: before.digest,
          after: after.digest,
          proposal: created.digest,
        },
        decision: {
          status: created.status,
          fromVersion: before.version,
          toVersion: after.version,
          observationsCited: created.observationIds.length,
          addedCases: created.addedCases?.length ?? 0,
          // Stated in the chain so that "the loop only ever proposed" is
          // provable from the record rather than from reading the code.
          applied: false,
        },
      }),
    );

    return freezeProposal(created);
  }

  /**
   * Resolve the state that exists now and the state being proposed.
   *
   * `evaluation_case` is the odd one and deliberately so. Golden sets are owned
   * by `roles/` — they are the ground truth of record, immutable per version,
   * with their own protected publication path. This module does not keep a
   * second copy: it reads the current set from the roles store, builds the
   * proposed one, and runs the protection guard on it here so that a weakening
   * proposal never becomes a queue item at all.
   */
  private async resolveStates(
    input: DraftProposalInput,
  ): Promise<{ readonly before: ArtifactState; readonly after: ArtifactState }> {
    if (input.target.kind === "evaluation_case") {
      const current = await this.deps.evaluations.requireGoldenSet(input.target.id);
      const proposed = buildProposedGoldenSet(current, input.addedCases);

      // Structure first, then the protection guard. Running them the other way
      // round would report "you weakened case X" for a set that is simply
      // malformed.
      assertGoldenSet(proposed);
      assertGoldenSetNotWeakened(current, proposed);

      return {
        before: artifactState({
          kind: "evaluation_case",
          id: input.target.id,
          version: current.version,
          content: {
            goldenSetId: current.id,
            fromVersion: current.version,
            toVersion: current.version,
            addedCaseCount: 0,
          },
        }),
        after: artifactState({
          kind: "evaluation_case",
          id: input.target.id,
          version: proposed.version,
          content: {
            goldenSetId: proposed.id,
            fromVersion: current.version,
            toVersion: proposed.version,
            addedCaseCount: proposed.cases.length - current.cases.length,
          },
        }),
      };
    }

    if (input.target.kind === "prompt_binding") {
      // The one check that makes "prompts live in version control" true rather
      // than merely stated: the binding may only name a template that is
      // already committed. A proposal cannot introduce a prompt.
      const templateId = input.content["promptTemplateId"];
      const templateVersion = input.content["promptTemplateVersion"];
      try {
        this.deps.templates.require(String(templateId), Number(templateVersion));
      } catch (error) {
        throw new DeniedError(
          "improvement.autonomous_application",
          `Prompt ${String(templateId)} v${String(templateVersion)} is not in version control, so this proposal would introduce prompt text that no reviewer has read. Commit the prompt first; the loop may then propose binding to it. (${error instanceof Error ? error.message : String(error)})`,
          {
            artifactId: input.target.id,
            promptTemplateId: String(templateId),
            shape: "prompt_not_in_version_control",
          },
        );
      }
    }

    const head = await this.deps.artifacts.require(input.target.kind, input.target.id);
    return {
      before: artifactState({
        kind: head.kind,
        id: head.id,
        version: head.version,
        content: head.content,
      }),
      after: artifactState({
        kind: input.target.kind,
        id: input.target.id,
        version: head.version + 1,
        content: input.content,
      }),
    };
  }

  /** @throws {DeniedError} `record.unavailable` when an observation is missing. */
  private async requireEvidence(observationIds: readonly Id<"observation">[]): Promise<void> {
    if (observationIds.length === 0) {
      throw new InvalidInputError(
        "A proposal has to cite the observations that justify it. A proposal with no evidence is an opinion, and this platform does not act on opinions.",
        "observationIds",
      );
    }
    if (observationIds.length > MAX_OBSERVATIONS_CITED) {
      throw new InvalidInputError(
        `A proposal cites ${observationIds.length} observations, past the limit of ${MAX_OBSERVATIONS_CITED}. Citing everything is citing nothing.`,
        "observationIds",
      );
    }

    for (const observationId of observationIds) {
      const found = await this.deps.observations.getObservation(observationId);
      if (!found) {
        throw new DeniedError(
          "record.unavailable",
          `This proposal cites observation ${observationId}, which is not in the record. Evidence a reviewer cannot open is not evidence.`,
          { observationId },
        );
      }
    }
  }
}

/**
 * Build the proposed golden set: the current one, plus cases.
 *
 * Additions and nothing else. Every other field is carried across untouched,
 * which is what makes the guard's job in `roles/evaluation.ts` a real check
 * rather than a comparison of two things this function invented — if this
 * copied a threshold across "helpfully", the guard would be comparing a set
 * against itself.
 *
 * Used at drafting time and again at apply time, against the set as it exists
 * at each moment.
 *
 * @throws {InvalidInputError} when the proposal adds nothing, or when a case
 *   names no curator.
 */
export function buildProposedGoldenSet(
  current: GoldenSet,
  addedCases: readonly GoldenCase[] | undefined,
): GoldenSet {
  if (!addedCases || addedCases.length === 0) {
    throw new InvalidInputError(
      `An evaluation-case proposal has to add at least one case. A proposal that adds none is a version bump, and a golden set that is renumbered without being extended proves nothing new.`,
      "addedCases",
    );
  }

  for (const entry of addedCases) {
    if (typeof entry.curatedBy !== "string" || entry.curatedBy.trim().length === 0) {
      // The expected outcome of a case is a judgement about what is correct.
      // The loop may draft the case; a person's name goes on the answer.
      throw new InvalidInputError(
        `Proposed case "${String(entry.id)}" names no curator. An expected outcome is a human judgement about what is correct, so the record says whose judgement it is.`,
        "addedCases",
      );
    }
  }

  return {
    ...current,
    version: current.version + 1,
    cases: [...current.cases, ...addedCases.map((entry) => ({ ...entry }))],
  };
}

/**
 * Fingerprint of the change.
 *
 * Recomputed from the stored proposal every time it is used, so a row edited in
 * the database no longer matches the fingerprint it carries. Covers the added
 * cases in full: two proposals differing only in what they would add to the
 * ground truth are different proposals, and an approval for one must not
 * authorise the other.
 */
export function changeDigest(input: {
  readonly proposalId: Id<"proposal">;
  readonly target: ArtifactTarget;
  readonly roleId: Id<"role">;
  readonly roleVersion: number;
  readonly beforeDigest: Digest;
  readonly afterDigest: Digest;
  readonly addedCases?: readonly GoldenCase[] | undefined;
}): Digest {
  return digestValue({
    kind: "improvement.change",
    proposalId: input.proposalId,
    target: { kind: input.target.kind, id: input.target.id },
    roleId: input.roleId,
    roleVersion: input.roleVersion,
    beforeDigest: input.beforeDigest,
    afterDigest: input.afterDigest,
    addedCases: (input.addedCases ?? []).map((entry) => ({
      id: entry.id,
      input: entry.input,
      expected: entry.expected,
      tags: [...entry.tags].sort(),
      curatedBy: entry.curatedBy,
    })),
  });
}

/** Recompute a stored proposal's fingerprint. */
export function proposalChangeDigest(proposal: Proposal): Digest {
  return changeDigest({
    proposalId: proposal.id,
    target: proposal.target,
    roleId: proposal.roleId,
    roleVersion: proposal.roleVersion,
    beforeDigest: proposal.before.digest,
    afterDigest: proposal.after.digest,
    addedCases: proposal.addedCases,
  });
}

/**
 * Refuse a proposal whose stored content no longer matches its fingerprint.
 *
 * Called on every path that reads a proposal back. The approval digest already
 * binds a decision to a proposal, but this catches the case one step earlier
 * and with a more useful message: the row was edited after it was written.
 *
 * @throws {DeniedError} `approval.digest_mismatch`
 */
export function assertProposalIntact(proposal: Proposal): void {
  // The embedded states first. The change fingerprint covers the two artifact
  // *digests*, so a row whose stored content was edited while its digest was
  // left alone would pass the outer check — and the edited content is what
  // would be installed.
  for (const [label, state] of [
    ["before", proposal.before],
    ["after", proposal.after],
  ] as const) {
    if (artifactDigest(state) !== state.digest) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Proposal ${proposal.id}'s ${label} state does not match its own fingerprint. The stored record has been altered since it was created, so what it describes is not what anybody reviewed.`,
        { proposalId: proposal.id, state: label },
      );
    }
  }

  const recomputed = proposalChangeDigest(proposal);
  if (recomputed !== proposal.digest) {
    throw new DeniedError(
      "approval.digest_mismatch",
      `Proposal ${proposal.id} does not match the fingerprint it was written with. The stored record has been altered since it was created, so what it describes is not what anybody reviewed.`,
      { proposalId: proposal.id },
    );
  }
}

/**
 * Freeze a proposal on the way out.
 *
 * Inertness is a property of the value, not only of the interface. A frozen
 * object cannot have an `apply` attached to it downstream and be passed on as
 * though the platform had provided one.
 */
export function freezeProposal(proposal: Proposal): Proposal {
  return deepFreeze(proposal);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}

function assertRationale(rationale: string): void {
  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    throw new InvalidInputError(
      "A proposal needs a rationale. It is the sentence the approver reads before deciding.",
      "rationale",
    );
  }
  if (rationale.length > MAX_RATIONALE_LENGTH) {
    throw new InvalidInputError(
      `Rationale is ${rationale.length} characters, past the ${MAX_RATIONALE_LENGTH}-character limit. An approver who has to read an essay is an approver who stops reading.`,
      "rationale",
    );
  }
}
