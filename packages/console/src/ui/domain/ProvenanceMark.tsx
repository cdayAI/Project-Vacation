import { MarkAsserted, MarkComputed, MarkRetrieved } from "./marks";
import "./ProvenanceMark.css";

/**
 * Where a statement came from: retrieved, asserted, or computed.
 *
 * This is the distinction the whole platform is judged on and the one an
 * approver checks fastest, so it is one component used in every place a claim
 * appears — an evidence item, a model step on a run timeline, a citation inside
 * a copilot answer. Three components would be three vocabularies, and an
 * operator who has to learn what "derived" means on one screen and "calculated"
 * on the next stops reading the label at all.
 *
 * Three channels carry it, and none of them is colour:
 *
 *   - the **word**, always present and never abbreviated;
 *   - the **mark**, three shapes that stay distinct at 12px and in greyscale;
 *   - the **leading rule**, solid for retrieved, dashed for asserted, dotted
 *     for computed — the channel that still works when a scanned copy of the
 *     audit pack has lost the marks to compression.
 *
 * It deliberately takes no status tone. Provenance is not a status: an asserted
 * value is not a warning and a computed one is not a success, and borrowing the
 * status palette here would teach operators that the tint means something it
 * does not.
 */

export const PROVENANCE_KINDS = ["retrieved", "asserted", "computed"] as const;

export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/** The word. One vocabulary for the whole product. */
export const PROVENANCE_WORDS: Readonly<Record<ProvenanceKind, string>> = {
  retrieved: "Retrieved",
  asserted: "Asserted",
  computed: "Computed",
};

/**
 * What the word means, in one sentence an operator can read once and keep.
 * Rendered on request, because repeating it beside twelve evidence items is
 * noise — but the first time an operator meets the distinction it has to be on
 * the screen rather than in a manual.
 */
export const PROVENANCE_MEANINGS: Readonly<Record<ProvenanceKind, string>> = {
  retrieved: "Quoted from a source document.",
  asserted: "Stated by a person or a system. Nothing derived it.",
  computed: "Derived by this platform, and the working can be shown.",
};

const MARKS: Readonly<Record<ProvenanceKind, typeof MarkRetrieved>> = {
  retrieved: MarkRetrieved,
  asserted: MarkAsserted,
  computed: MarkComputed,
};

export interface ProvenanceMarkProps {
  readonly kind: ProvenanceKind;
  /** `sm` for a dense list of citations, `md` beside a heading. */
  readonly size?: "sm" | "md";
  /** Renders the one-sentence meaning after the word. */
  readonly describe?: boolean;
  readonly className?: string;
}

export function ProvenanceMark({
  kind,
  size = "sm",
  describe = false,
  className,
}: ProvenanceMarkProps) {
  const Glyph = MARKS[kind];
  return (
    <span
      className={className === undefined ? "pv-provenance" : `pv-provenance ${className}`}
      data-kind={kind}
      data-size={size}
    >
      <Glyph size="sm" />
      <span className="pv-provenance-word">{PROVENANCE_WORDS[kind]}</span>
      {describe ? (
        <span className="pv-provenance-meaning">{PROVENANCE_MEANINGS[kind]}</span>
      ) : null}
    </span>
  );
}
