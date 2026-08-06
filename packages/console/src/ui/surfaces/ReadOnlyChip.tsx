import { Chip } from "../primitives/Chip";
import { IconLock } from "../primitives/icons";

/**
 * The "Read-only" marker every surface in this directory shows when it is in
 * its read-only state.
 *
 * Read-only is a designed state, not a greyed-out accident: auditors live in
 * it, and an auditor who cannot tell whether a field is empty or merely
 * uneditable has to ask an engineer. So the surface keeps its layout, drops the
 * affordances — input borders, hover targets, action buttons — and says so
 * once, here, in words.
 *
 * In words *and* with a padlock, never with colour alone. The chip is neutral;
 * neutral is also what "inert" and "not applicable" look like, and the audit
 * pack this screen ends up inside is printed in black and white.
 *
 * It composes the primitive Chip rather than drawing its own. A second chip in
 * the product is a second chip that drifts, and this one appears on eight
 * surfaces — it is precisely the case a shared primitive exists for. What it
 * adds is the decision: which tone, which mark, which word, every time.
 */
export function ReadOnlyChip({ label = "Read-only" }: { readonly label?: string }) {
  return (
    <Chip tone="neutral" size="sm" icon={<IconLock size="sm" />}>
      {label}
    </Chip>
  );
}
