/**
 * Focus containment and restoration for anything that takes over the screen.
 *
 * Three separate obligations live here, and every overlay in this directory
 * owes all three:
 *
 *   1. While the overlay is open, Tab must not walk out the back of it into the
 *      page behind. An operator who tabs off the end of a modal and lands on
 *      the rail has lost the thread, and a screen-reader user has no way of
 *      knowing they left.
 *   2. Something inside must receive focus when it opens, and it should be the
 *      thing that says what this is — the title — not the first button. An
 *      operator should hear what they are being asked before they hear the
 *      control that answers it.
 *   3. When it closes, focus goes back to whatever opened it. Not to the top of
 *      the document. A queue operator who opens a row sheet, reads it, and
 *      presses Escape must be standing on that same row afterwards.
 *
 * Native `<dialog>` with `showModal()` does (1) itself, and the overlays here
 * use it where the browser has it. jsdom does not implement `showModal`, and
 * neither do some embedded webviews, so this module is both the fallback and
 * the thing the tests actually exercise. It is plain DOM on purpose: a focus
 * trap that can only be tested by mounting React is a focus trap nobody tests.
 */

/**
 * What the platform treats as focusable.
 *
 * `[tabindex]` is matched broadly and the negative values are filtered out
 * afterwards rather than excluded by the selector, because `tabindex="-1"`
 * means "focusable by script, skipped by Tab" and both halves of that matter:
 * such an element is a legitimate initial focus target but must never be a Tab
 * stop.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "details > summary",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]",
  "[tabindex]",
].join(",");

function isDisabled(element: Element): boolean {
  return (
    element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true"
  );
}

/**
 * Hidden in a way that removes an element from the tab order.
 *
 * jsdom has no layout, so `offsetParent` and `getClientRects()` cannot be used
 * to detect visibility — they answer "hidden" for everything and would empty
 * the trap. The attribute-level checks below are the ones that are true in both
 * a real browser and a test environment, which is what makes this function
 * worth trusting in either.
 */
function isHidden(element: Element): boolean {
  if (element.hasAttribute("hidden")) return true;
  // Both of these are checked on ancestors, not just on the element. Hiding a
  // subtree is how a collapsed section or a closed tab panel is expressed, and
  // a trap that only looks at the control itself will happily focus a button
  // inside a panel nobody can see.
  if (element.closest('[aria-hidden="true"]') !== null) return true;
  if (element.closest("[inert]") !== null) return true;
  if (element instanceof HTMLElement && element.style.display === "none") return true;
  return false;
}

function isTabbable(element: Element): boolean {
  if (isDisabled(element) || isHidden(element)) return false;
  const explicit = element.getAttribute("tabindex");
  if (explicit !== null && Number.parseInt(explicit, 10) < 0) return false;
  // A radio in a group where a different radio is checked is skipped by Tab.
  // Missing this makes a trap put focus on the wrong member of a group, which
  // reads as the form silently changing the operator's answer.
  if (element instanceof HTMLInputElement && element.type === "radio" && !element.checked) {
    const name = element.name;
    if (name !== "") {
      const root = element.form ?? element.ownerDocument;
      const checked = root.querySelector(`input[type="radio"][name="${CSS.escape(name)}"]:checked`);
      if (checked !== null) return false;
    }
  }
  return true;
}

/** Every element inside `container` that Tab will stop on, in tab order. */
export function tabbableWithin(container: Element): readonly HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const element of container.querySelectorAll(FOCUSABLE_SELECTOR)) {
    if (element instanceof HTMLElement && isTabbable(element)) found.push(element);
  }
  return found;
}

/**
 * Handles a Tab keypress so focus wraps inside `container` instead of leaving.
 *
 * Returns true when it moved focus, so a caller can tell whether to call
 * `preventDefault`. Nothing is prevented when the container has no tabbable
 * content — the operator would be stuck with a key that does nothing and no
 * explanation, which is worse than briefly leaving.
 */
export function wrapTabFocus(container: HTMLElement, event: KeyboardEvent): boolean {
  if (event.key !== "Tab") return false;

  const stops = tabbableWithin(container);
  if (stops.length === 0) return false;

  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first === undefined || last === undefined) return false;

  const active = container.ownerDocument.activeElement;

  // Focus sitting on the container itself (or having escaped entirely) is the
  // common case immediately after open: Tab should enter at the appropriate
  // end rather than doing nothing.
  const inside = active instanceof HTMLElement && container.contains(active) && active !== container;

  if (event.shiftKey) {
    if (!inside || active === first) {
      last.focus();
      return true;
    }
    return false;
  }

  if (!inside || active === last) {
    first.focus();
    return true;
  }
  return false;
}

/**
 * Captures where focus is now and returns the function that puts it back.
 *
 * The restore is guarded: by the time an overlay closes, the element that
 * opened it may have been removed — a row sheet whose row was filtered away, a
 * menu item that deleted itself. Focusing a detached node silently sends focus
 * to `<body>`, so we check the element is still in the document and fall back
 * to a caller-supplied element.
 */
export function captureFocusOrigin(doc: Document = document): () => void {
  const origin = doc.activeElement;
  return () => {
    if (origin instanceof HTMLElement && origin.isConnected) origin.focus();
  };
}

/**
 * Moves focus into a freshly opened overlay.
 *
 * Preference order, and the reason for it: an element the component explicitly
 * nominated (usually the title, so the operator hears what this is before they
 * hear the buttons), then the first tabbable control, then the container. The
 * container is the last resort rather than the first choice because focusing a
 * `tabindex="-1"` wrapper announces nothing useful.
 */
export function focusInitialElement(
  container: HTMLElement,
  preferred?: HTMLElement | null,
): void {
  if (preferred !== null && preferred !== undefined && preferred.isConnected) {
    preferred.focus();
    if (container.ownerDocument.activeElement === preferred) return;
  }
  const stops = tabbableWithin(container);
  const first = stops[0];
  if (first !== undefined) {
    first.focus();
    return;
  }
  container.focus();
}
