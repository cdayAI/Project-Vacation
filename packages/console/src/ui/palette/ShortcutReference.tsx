import { useCommandRegistry, useCommandRevision } from "../../keyboard/KeyboardProvider";
import {
  SHORTCUT_LIST,
  SHORTCUT_SECTIONS,
  displaySequence,
  type ShortcutDefinition,
} from "../../keyboard/shortcuts";
import { Modal } from "../surfaces/Modal";
import "./ShortcutReference.css";

/**
 * The `?` reference.
 *
 * Generated from the same table the dispatcher matches against, which is the
 * whole reason the table exists as data. A hand-maintained shortcut list is
 * wrong within a month — a key gets rebound, a verb is added, and the help
 * screen becomes a document that actively misleads the person who trusted it
 * enough to open it.
 *
 * It also states, per row, whether the verb does anything *right now*. The
 * registry knows: a shortcut with no command bound to it on this screen is
 * inert, and saying so turns "I pressed A and nothing happened" from a bug
 * report into an answer.
 */

export interface ShortcutReferenceProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function ShortcutReference({ open, onClose }: ShortcutReferenceProps) {
  const registry = useCommandRegistry();
  const revision = useCommandRevision();

  // `revision` is what makes this recompute; the registry rebuilds its list on
  // every read, so its identity says nothing.
  void revision;
  const availableIds = new Set(registry.availableShortcuts().map((definition) => definition.id));

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Keyboard shortcuts"
      description="The same verbs everywhere. A shortcut that does nothing on this screen says so."
    >
      <div className="pv-shortcuts">
        {SHORTCUT_SECTIONS.map((section) => {
          const rows = SHORTCUT_LIST.filter((definition) => definition.section === section);
          if (rows.length === 0) return null;
          return (
            <section className="pv-shortcuts-section" key={section}>
              <h3 className="pv-shortcuts-heading">{section}</h3>
              <dl className="pv-shortcuts-list">
                {rows.map((definition) => (
                  <ShortcutRow
                    key={definition.id}
                    definition={definition}
                    available={availableIds.has(definition.id)}
                  />
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}

/** Where a verb applies, in words an operator would use. */
const SCOPE_WORDS: Readonly<Record<ShortcutDefinition["scope"], string>> = {
  global: "Anywhere",
  list: "In a list",
  approval: "On an approval",
  form: "In a form",
};

function ShortcutRow({
  definition,
  available,
}: {
  readonly definition: ShortcutDefinition;
  readonly available: boolean;
}) {
  return (
    <div className="pv-shortcuts-row" data-available={available ? "true" : undefined}>
      <dt className="pv-shortcuts-term">
        <kbd className="pv-shortcuts-keys">{displaySequence(definition)}</kbd>
      </dt>
      <dd className="pv-shortcuts-detail">
        <span className="pv-shortcuts-label">{definition.label}</span>
        <span className="pv-shortcuts-description">{definition.description}</span>
        <span className="pv-shortcuts-scope">
          {SCOPE_WORDS[definition.scope]}
          {available ? null : <span className="pv-shortcuts-inert"> · not on this screen</span>}
        </span>
      </dd>
    </div>
  );
}
