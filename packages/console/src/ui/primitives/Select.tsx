import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Field } from "./Field";
import { IconChevronDown } from "./icons";
import type { ControlSize } from "./Input";
import {
  firstEnabledIndex,
  indexOfValue,
  isTypeAheadKey,
  lastEnabledIndex,
  stepIndex,
  typeAheadIndex,
  useScrollActiveIntoView,
  useTypeAhead,
  type ListOption,
} from "./listbox";
import { OptionList } from "./OptionList";
import { Spinner } from "./Spinner";
import "./control.css";
import "./popup.css";
import "./Select.css";

/**
 * Select — one value from a known, short list.
 *
 * Built rather than borrowed from `<select>` because the specification requires
 * `aria-expanded` and `aria-activedescendant` to be correct, and a native
 * select exposes neither: the browser draws its popup outside the document, so
 * there is nothing to describe and nothing to style. The cost of building it is
 * that every keyboard behaviour a native select has must be re-implemented, and
 * this is the list:
 *
 *   Down / Up          open, or move by one, wrapping at the ends
 *   Alt+Down / Alt+Up  open without moving / close, keeping the value
 *   Home / End         first / last option an operator can actually pick
 *   Enter              commit the active option and close
 *   Space              open when closed, commit when open
 *   Escape             close, keep the committed value, keep the focus
 *   Tab                commit the active option and leave, like a native select
 *   any printable key  type-ahead; `p` repeatedly cycles the options from "p"
 *
 * Focus never leaves the trigger. The options are not focusable and the popup
 * is not a focus trap: `aria-activedescendant` tells assistive technology where
 * the operator is, which is what keeps Escape and Tab behaving the way they do
 * everywhere else in the console.
 *
 * Type-ahead moves the active option, it does not commit. On a native select a
 * stray keystroke silently changes the value; here nothing changes until the
 * operator says so, because this control sits on screens where the value is a
 * decision.
 */

export interface SelectProps {
  readonly label: string;
  readonly labelHidden?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly options: readonly ListOption[];
  /** Controlled. `null` is "nothing chosen yet", not an empty string. */
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly size?: ControlSize;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  /** Shown inside the popup when there is nothing to choose from. */
  readonly emptyMessage?: string;
  readonly id?: string;
  readonly className?: string;
}

export function Select({
  label,
  labelHidden,
  hint,
  error,
  options,
  value,
  onChange,
  placeholder = "Select an option",
  size = "md",
  required = false,
  disabled = false,
  readOnly = false,
  loading = false,
  loadingLabel = "Loading options",
  emptyMessage = "No options available.",
  id,
  className,
}: SelectProps) {
  const generatedId = useId();
  const listId = `${id ?? generatedId}-listbox`;
  const optionId = (index: number) => `${listId}-option-${index}`;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLUListElement | null>(null);
  const typeAhead = useTypeAhead();

  useScrollActiveIntoView(listRef, activeIndex, open);

  const selectedIndex = indexOfValue(options, value);
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex]?.label : undefined;

  /**
   * A select with nothing to choose from does not open. The alternative is a
   * popup containing a sentence, which forces `aria-expanded="true"` on a
   * combobox whose `aria-controls` points at something that is not a listbox —
   * a state assistive technology has no way to describe. The empty message
   * becomes the field's own value instead, so it is read as part of the field.
   */
  const empty = options.length === 0;
  const inert = disabled || loading || empty;

  function openList(next: number) {
    if (inert) return;
    setOpen(true);
    setActiveIndex(next);
  }

  function closeList() {
    setOpen(false);
    setActiveIndex(-1);
    typeAhead.clear();
  }

  function commit(index: number) {
    const option = options[index];
    if (option === undefined || option.disabled === true) return;
    onChange(option.value);
    closeList();
  }

  /** Where the list should open: on the current value, or on the first choice. */
  function entryIndex(fromEnd = false): number {
    if (selectedIndex >= 0 && options[selectedIndex]?.disabled !== true) return selectedIndex;
    return fromEnd ? lastEnabledIndex(options) : firstEnabledIndex(options);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (inert) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) openList(entryIndex());
        else setActiveIndex(stepIndex(options, activeIndex, 1, true));
        return;
      case "ArrowUp":
        event.preventDefault();
        if (event.altKey) {
          closeList();
          return;
        }
        if (!open) openList(entryIndex(true));
        else setActiveIndex(stepIndex(options, activeIndex, -1, true));
        return;
      case "Home":
        if (!open) return;
        event.preventDefault();
        setActiveIndex(firstEnabledIndex(options));
        return;
      case "End":
        if (!open) return;
        event.preventDefault();
        setActiveIndex(lastEnabledIndex(options));
        return;
      case "Enter":
        if (!open) return;
        // Without preventDefault the browser also fires a click on the button,
        // which would reopen the list the instant this closes it.
        event.preventDefault();
        commit(activeIndex);
        return;
      case " ":
        if (!open) return;
        event.preventDefault();
        commit(activeIndex);
        return;
      case "Escape":
        if (!open) return;
        event.preventDefault();
        // Focus stays on the trigger: it never left, which is why this control
        // does not have to restore anything.
        closeList();
        return;
      case "Tab":
        // No preventDefault — leaving is the operator's intent and blocking Tab
        // is how a control becomes a trap. Committing first is what a native
        // select does.
        if (open) commit(activeIndex);
        return;
      default:
        break;
    }

    if (isTypeAheadKey(event)) {
      const buffer = typeAhead.push(event.key);
      const match = typeAheadIndex(options, buffer, open ? activeIndex : selectedIndex);
      if (match >= 0) {
        event.preventDefault();
        openList(match);
      }
    }
  }

  return (
    <Field
      label={label}
      labelHidden={labelHidden}
      hint={hint}
      error={error}
      required={required}
      readOnly={readOnly}
      id={id}
      className={className}
    >
      {(control) =>
        control.readOnly ? (
          // Read-only renders the value as a read-only text field rather than a
          // dead trigger: same box, same alignment, no affordance, and the value
          // can still be selected and copied — which is what an auditor is
          // actually doing on this screen.
          <div className="pv-ui-control" data-size={size} data-readonly="true">
            <input
              id={control.id}
              className="pv-ui-control-field"
              readOnly
              value={selectedLabel ?? "Not set"}
              aria-describedby={control.describedBy}
            />
          </div>
        ) : (
          <div className="pv-ui-popup">
            <div
              className="pv-ui-control"
              data-size={size}
              data-open={open ? "true" : undefined}
              data-invalid={control.invalid ? "true" : undefined}
              data-disabled={disabled || empty ? "true" : undefined}
            >
              <button
                type="button"
                id={control.id}
                className="pv-ui-control-field pv-ui-select-trigger"
                role="combobox"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-haspopup="listbox"
                aria-activedescendant={
                  open && activeIndex >= 0 ? optionId(activeIndex) : undefined
                }
                aria-describedby={control.describedBy}
                aria-invalid={control.invalid ? true : undefined}
                aria-required={required ? true : undefined}
                aria-busy={loading ? true : undefined}
                // Native `disabled` only when the caller says so. Loading and
                // empty stay focusable and announced, because a control that
                // vanishes from the tab order while data arrives loses the
                // operator's place in the form.
                disabled={disabled}
                aria-disabled={loading || empty ? true : undefined}
                onKeyDown={onKeyDown}
                onClick={() => {
                  if (inert) return;
                  if (open) closeList();
                  else openList(entryIndex());
                }}
                onBlur={() => {
                  // Focus leaving means the operator has moved on. The
                  // committed value is untouched: an accidental blur must never
                  // decide anything.
                  if (open) closeList();
                }}
              >
                <span
                  className="pv-ui-select-value"
                  data-placeholder={selectedLabel === undefined ? "true" : undefined}
                >
                  {/* Empty and loading are different facts: saying "no options
                      available" while they are still being fetched is a wrong
                      answer that the operator has no way to know is wrong. */}
                  {selectedLabel ?? (empty && !loading ? emptyMessage : placeholder)}
                </span>
              </button>
              {loading ? (
                <span className="pv-ui-control-addon">
                  <Spinner size="sm" label={loadingLabel} />
                </span>
              ) : (
                <IconChevronDown className="pv-ui-select-chevron" />
              )}
            </div>
            {open && (
              <div className="pv-ui-popup-layer">
                <OptionList
                  id={listId}
                  options={options}
                  activeIndex={activeIndex}
                  selectedValue={value}
                  optionId={optionId}
                  onPick={(_option, index) => commit(index)}
                  onHoverIndex={setActiveIndex}
                  labelledBy={control.id}
                  listRef={listRef}
                />
              </div>
            )}
          </div>
        )
      }
    </Field>
  );
}
