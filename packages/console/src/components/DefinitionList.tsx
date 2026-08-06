import type { ReactNode } from "react";

export interface DefinitionItem {
  readonly term: string;
  readonly description: ReactNode;
}

export interface DefinitionListProps {
  readonly items: readonly DefinitionItem[];
  /** Stacks term above description. Use where descriptions are long. */
  readonly stacked?: boolean;
}

/**
 * A real `<dl>`, with each pair wrapped in a `<div>` so the grid can lay it out
 * without breaking the term/description association. Screen readers announce
 * "definition list, N items" and pair each term with its description, which a
 * two-column grid of divs does not.
 */
export function DefinitionList({ items, stacked = false }: DefinitionListProps) {
  return (
    <dl className={stacked ? "pv-dl pv-dl-stacked" : "pv-dl"}>
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.description}</dd>
        </div>
      ))}
    </dl>
  );
}
