import { canonicalJson } from "../kernel/canonical.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import { containsSecret } from "../kernel/redact.js";
import type { ActorRef } from "../record/types.js";
import type { ArtifactStore } from "./port.js";
import {
  ARTIFACT_KINDS,
  type ArtifactContent,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactState,
  type ArtifactTarget,
} from "./types.js";

/**
 * The "no self-modifying code" boundary, enforced.
 *
 * The improvement loop proposes changes to *declarative artifacts* — prompts
 * by reference, routing, guardrail rules, corpus gaps, evaluation cases. It
 * never proposes a change to the platform's source, and this file is where that
 * stops being a promise and starts being a check.
 *
 * The allowlist is closed. A target whose kind is not on it is refused, and so
 * is a target whose identifier has the shape of a file — a slash, a `..`, an
 * extension, a `src.` prefix. Both refusals carry
 * `improvement.autonomous_application`, and that reason is deliberate: a loop
 * that rewrites its own source is self-modification by definition, and no human
 * approval can be a valid gate for it, because such a change would bypass code
 * review, branch protection, and the deploy pipeline entirely. The refusal is
 * not "you need approval for this"; it is "this is not a thing this loop does".
 *
 * Artifact content is flat and primitive, bounded in every direction, and
 * rejects anything that looks like prompt text or a credential. The reason is
 * the platform's rule that prompts are artifacts in version control, never rows
 * in a database: a `prompt_binding` may name a committed template and its
 * version, and that is all it may hold. There is no field for text, so there is
 * nowhere to put a prompt that no reviewer read.
 *
 * The bounds are stated in three places at once — key count, per-value length,
 * and total canonical size. Any one alone is evadable by padding whichever
 * dimension it does not measure.
 */

/** The kinds a proposal may target. Anything else is refused. */
export const MUTABLE_ARTIFACT_KINDS: readonly ArtifactKind[] = ARTIFACT_KINDS;

/** Identifiers are dotted lower_snake_case names, never locations. */
const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9][a-z0-9_]*)*$/;

const MAX_ID_LENGTH = 128;
const MAX_CONTENT_KEYS = 24;
const MAX_VALUE_LENGTH = 512;
const MAX_CONTENT_BYTES = 4096;

/** Shapes that mean "this names a file", checked before the identifier rule. */
const SOURCE_SHAPES: readonly { readonly test: RegExp; readonly why: string }[] = [
  { test: /[/\\]/, why: "it contains a path separator" },
  { test: /\.\./, why: "it contains a parent-directory segment" },
  {
    test: /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|sql|md|sh|env|lock|toml)$/i,
    why: "it ends in a source or configuration file extension",
  },
  { test: /^(src|packages|node_modules|dist|scripts|tools)\b/i, why: "it names a source directory" },
  { test: /^\.|^~/, why: "it looks like a relative or home-directory path" },
];

export function isMutableArtifactKind(kind: string): kind is ArtifactKind {
  return (MUTABLE_ARTIFACT_KINDS as readonly string[]).includes(kind);
}

/**
 * Refuse a target that is not a declarative artifact.
 *
 * @throws {DeniedError} `improvement.autonomous_application`
 */
export function assertMutableArtifact(target: ArtifactTarget): void {
  if (!isMutableArtifactKind(target.kind)) {
    throw new DeniedError(
      "improvement.autonomous_application",
      `"${String(target.kind)}" is not a declarative artifact this loop may change. The permitted kinds are: ${MUTABLE_ARTIFACT_KINDS.join(", ")}. The platform's own source is not among them and cannot be added by configuration.`,
      { kind: String(target.kind), shape: "kind_not_allowlisted" },
    );
  }

  if (typeof target.id !== "string" || target.id.length === 0) {
    throw new InvalidInputError("An artifact target needs an identifier.", "id");
  }
  if (target.id.length > MAX_ID_LENGTH) {
    throw new InvalidInputError(
      `Artifact identifier is ${target.id.length} characters, past the ${MAX_ID_LENGTH}-character limit.`,
      "id",
    );
  }

  for (const shape of SOURCE_SHAPES) {
    if (shape.test.test(target.id)) {
      throw new DeniedError(
        "improvement.autonomous_application",
        `"${target.id}" is not a declarative artifact: ${shape.why}. The improvement loop names artifacts, it does not locate files, and it never proposes a change to the platform's source.`,
        { kind: target.kind, artifactId: target.id.slice(0, 128), shape: "source_artifact" },
      );
    }
  }

  if (!ARTIFACT_ID_PATTERN.test(target.id)) {
    throw new InvalidInputError(
      `Artifact identifier "${target.id}" must be dotted lower_snake_case, e.g. "rescission_intake.prompt".`,
      "id",
    );
  }
}

/**
 * Refuse artifact content that is not a bounded, primitive, text-free body.
 *
 * @throws {InvalidInputError} on a bound or a shape
 * @throws {DeniedError} `improvement.autonomous_application` when the content
 *   carries prompt text, which belongs in version control rather than here.
 */
export function assertArtifactContent(kind: ArtifactKind, content: ArtifactContent): void {
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new InvalidInputError(
      `Artifact content must be a flat object of primitive values.`,
      "content",
    );
  }

  const keys = Object.keys(content);
  if (keys.length > MAX_CONTENT_KEYS) {
    throw new InvalidInputError(
      `Artifact content has ${keys.length} keys, past the limit of ${MAX_CONTENT_KEYS}. A declarative artifact is a rule, not a dataset.`,
      "content",
    );
  }

  for (const key of keys) {
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(key)) {
      throw new InvalidInputError(
        `Artifact content key "${key}" must be lowerCamelCase or lower_snake_case.`,
        "content",
      );
    }
    const value = content[key];
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new InvalidInputError(
        `Artifact content "${key}" must be a string, number, or boolean. Nesting would make this a place to hide a payload.`,
        "content",
      );
    }
    if (type === "number" && !Number.isFinite(value as number)) {
      throw new InvalidInputError(`Artifact content "${key}" is not a finite number.`, "content");
    }
    if (type === "string") {
      const text = value as string;
      if (text.length > MAX_VALUE_LENGTH) {
        throw new InvalidInputError(
          `Artifact content "${key}" is ${text.length} characters, past the ${MAX_VALUE_LENGTH}-character limit. A value this long is prose, and prose that steers a model is a prompt.`,
          "content",
        );
      }
      if (/[\r\n]/.test(text)) {
        throw new InvalidInputError(
          `Artifact content "${key}" contains a line break. A declarative rule is one line; multi-line text is a prompt in a database by another name.`,
          "content",
        );
      }
      if (text.includes("{{") || text.includes("}}")) {
        throw new DeniedError(
          "improvement.autonomous_application",
          `Artifact content "${key}" contains a template placeholder, which makes it prompt text. Prompts are artifacts in version control: a proposal names the committed template and version it wants, and never carries the words.`,
          { kind, shape: "prompt_text" },
        );
      }
      if (containsSecret(text)) {
        throw new DeniedError(
          "improvement.autonomous_application",
          `Artifact content "${key}" contains something that looks like a credential or a card number and was refused.`,
          { kind, shape: "secret" },
        );
      }
    }
  }

  const size = canonicalJson(content).length;
  if (size > MAX_CONTENT_BYTES) {
    // Bounding the key count and each value separately is not enough: both can
    // sit under their limits while the total carries the payload.
    throw new InvalidInputError(
      `Artifact content is ${size} bytes, past the ${MAX_CONTENT_BYTES}-byte limit.`,
      "content",
    );
  }

  assertKindShape(kind, content, keys);
}

/**
 * Per-kind shape rules.
 *
 * `prompt_binding` is the strict one. Its content is exactly a template
 * identifier and a version — a reference to something already committed and
 * reviewed. There is no third key, so there is no room for the loop to smuggle
 * an instruction into the system's behaviour.
 */
function assertKindShape(
  kind: ArtifactKind,
  content: ArtifactContent,
  keys: readonly string[],
): void {
  switch (kind) {
    case "prompt_binding": {
      const expected = ["promptTemplateId", "promptTemplateVersion"];
      const actual = [...keys].sort();
      if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw new InvalidInputError(
          `A prompt binding holds exactly ${expected.join(" and ")}. It names a prompt artifact that is already in version control; it never carries prompt text. Received: [${actual.join(", ")}].`,
          "content",
        );
      }
      const templateId = content["promptTemplateId"];
      if (typeof templateId !== "string" || !ARTIFACT_ID_PATTERN.test(templateId)) {
        throw new InvalidInputError(
          `A prompt binding's promptTemplateId must be a dotted lower_snake_case identifier.`,
          "content",
        );
      }
      const version = content["promptTemplateVersion"];
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        throw new InvalidInputError(
          `A prompt binding's promptTemplateVersion must be a positive integer, so the evidence names the exact prompt it measured.`,
          "content",
        );
      }
      return;
    }
    case "evaluation_case": {
      const required = ["addedCaseCount", "fromVersion", "goldenSetId", "toVersion"];
      const actual = [...keys].sort();
      if (canonicalJson(actual) !== canonicalJson(required)) {
        throw new InvalidInputError(
          `An evaluation-case change records exactly ${required.join(", ")}. The cases themselves are curated data and travel on the proposal, where the protection guard can see them.`,
          "content",
        );
      }
      const added = content["addedCaseCount"];
      if (typeof added !== "number" || !Number.isInteger(added) || added < 0) {
        throw new InvalidInputError(
          `An evaluation-case change records how many cases it adds, as a non-negative integer. (The prior state records zero; "adds nothing" is refused where the proposal is drafted, not here.)`,
          "content",
        );
      }
      return;
    }
    case "routing_rule":
    case "guardrail_rule":
    case "knowledge_gap":
      if (keys.length === 0) {
        throw new InvalidInputError(
          `A ${kind} with no content states nothing.`,
          "content",
        );
      }
      return;
    default: {
      const unreachable: never = kind;
      throw new InvalidInputError(`Unknown artifact kind: ${String(unreachable)}`, "kind");
    }
  }
}

/**
 * Fingerprint of an artifact version.
 *
 * Covers the identity and the body, and deliberately not the provenance: the
 * same content installed by two different approvals is the same state, and a
 * revert that restores it must be able to prove so.
 */
export function artifactDigest(input: {
  readonly kind: ArtifactKind;
  readonly id: string;
  readonly version: number;
  readonly content: ArtifactContent;
}): Digest {
  return digestValue({
    kind: input.kind,
    id: input.id,
    version: input.version,
    content: input.content,
  });
}

/** Build a state with its digest attached. */
export function artifactState(input: {
  readonly kind: ArtifactKind;
  readonly id: string;
  readonly version: number;
  readonly content: ArtifactContent;
}): ArtifactState {
  return {
    kind: input.kind,
    id: input.id,
    version: input.version,
    content: { ...input.content },
    digest: artifactDigest(input),
  };
}

/**
 * The state of an artifact that does not exist.
 *
 * Version 0, empty body, and a real digest — so "there was nothing here" is a
 * state a snapshot can name rather than an absence a revert has to guess at.
 */
export function absentArtifact(kind: ArtifactKind, id: string): ArtifactState {
  return artifactState({ kind, id, version: 0, content: {} });
}

/**
 * The governed declarative artifacts the deployment reads.
 *
 * Registration is how an artifact comes into existence, and it happens from
 * deployment configuration — the same place `DEFAULT_PROMPT_TEMPLATES` and the
 * action catalogue come from. **The improvement loop cannot create an
 * artifact.** It revises one that a deployment already declared, which means
 * every change it proposes has a prior state to snapshot and therefore a revert
 * that restores something a person once chose.
 *
 * `register` is idempotent and never overwrites. A deployment that re-registers
 * an artifact whose content has since been changed through the loop gets the
 * current head back unchanged, because the alternative — configuration silently
 * winning over an approved change on the next restart — is an ungoverned
 * behaviour change that nobody would see happen.
 *
 * **Wiring obligation, stated rather than assumed.** The head of an artifact is
 * the value the deployment is supposed to read at runtime. Nothing in this
 * module can force that: `improve` sits above the modules that would consume
 * these values, so the readers have to reach down to the store themselves. That
 * is one wiring obligation on this module's callers, and it is written here
 * rather than implied.
 */
export class GovernedArtifacts {
  constructor(
    private readonly store: ArtifactStore,
    private readonly clock: Clock,
  ) {}

  async register(input: {
    readonly kind: ArtifactKind;
    readonly id: string;
    readonly content: ArtifactContent;
    readonly by: ActorRef;
  }): Promise<ArtifactRecord> {
    assertMutableArtifact({ kind: input.kind, id: input.id });
    assertArtifactContent(input.kind, input.content);

    const existing = await this.store.head(input.kind, input.id);
    if (existing) return existing;

    const state = artifactState({
      kind: input.kind,
      id: input.id,
      version: 1,
      content: input.content,
    });
    const installed = await this.store.installArtifact({
      artifact: {
        ...state,
        recordedAt: this.clock.nowIso(),
        recordedBy: input.by,
      },
      expectedHeadVersion: undefined,
    });
    if (installed) return installed;

    // Another caller registered it first. Its version is the one that exists,
    // and returning it is correct: registration never overwrites.
    return this.require(input.kind, input.id);
  }

  head(kind: ArtifactKind, id: string): Promise<ArtifactRecord | null> {
    return this.store.head(kind, id);
  }

  /** @throws {DeniedError} `record.unavailable` when there is no such artifact. */
  async require(kind: ArtifactKind, id: string): Promise<ArtifactRecord> {
    const found = await this.store.head(kind, id);
    if (!found) {
      throw new DeniedError(
        "record.unavailable",
        `Artifact "${id}" (${kind}) has no current version in the governed record, so there is nothing to revise and nothing to snapshot for a revert. Declarative artifacts are created by deployment configuration, not by the improvement loop.`,
        { kind, artifactId: id },
      );
    }
    return found;
  }

  history(kind: ArtifactKind, id: string): Promise<readonly ArtifactRecord[]> {
    return this.store.listArtifactVersions(kind, id);
  }

  list(kind?: ArtifactKind): Promise<readonly ArtifactRecord[]> {
    return this.store.listHeads(kind);
  }
}
